using System.Collections.Concurrent;
using System.IO.Pipes;
using DAsk.Daemon.Configuration;
using DAsk.Daemon.ResourceManagement;
using DAsk.Daemon.State;
using DAsk.Daemon.Telemetry;
using DAsk.Protocol.IPC;
using DAsk.Protocol.IPC.Messages;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace DAsk.Daemon.IPC;

/// <summary>
/// The pipe server cannot guarantee it exclusively owns the pipe name (squatting, ACL failure, or a
/// non-transient instance-creation error). The daemon terminates instead of serving a weaker pipe.
/// </summary>
public sealed class PipeServerFatalException : Exception
{
    public PipeServerFatalException(string message, Exception? inner = null) : base(message, inner) { }
}

public class NamedPipeServer : BackgroundService
{
    private const int ErrorPipeBusyHResult = unchecked((int)0x800700E7);

    private readonly IPipePeerVerifier _peerVerifier;
    private readonly ILogger<NamedPipeServer> _logger;
    private readonly ISystemMonitor _systemMonitor;
    private readonly IResourceManager _resourceManager;
    private readonly IStateManager _stateManager;
    private readonly ModelRuntime.IModelRuntime? _modelRuntime;
    private readonly Automation.Observation.IScreenObservationService? _observationService;
    private readonly Automation.Execution.ActionExecutionEngine? _executionEngine;
    private readonly Automation.Policy.ActionPolicyEngine? _policyEngine;
    private readonly AgentHost.AgentHostManager? _agentHost;
    private readonly DaemonOptions _options;
    private readonly ConcurrentDictionary<string, IpcClientSession> _activeSessions = new();

    public int ConnectedClientCount => _activeSessions.Count;

    public NamedPipeServer(
        ILogger<NamedPipeServer> logger,
        ISystemMonitor systemMonitor,
        IResourceManager resourceManager,
        IStateManager stateManager,
        IOptions<DaemonOptions> options,
        ModelRuntime.IModelRuntime? modelRuntime = null,
        Automation.Observation.IScreenObservationService? observationService = null,
        Automation.Execution.ActionExecutionEngine? executionEngine = null,
        Automation.Policy.ActionPolicyEngine? policyEngine = null,
        IPipePeerVerifier? peerVerifier = null,
        AgentHost.AgentHostManager? agentHost = null,
        HudLivenessMonitor? livenessMonitor = null)
    {
        _agentHost = agentHost;
        _logger = logger;
        // Fail closed by construction: without an explicitly injected verifier (tests only), the
        // production verifier is used, and with an empty allowlist it accepts nobody.
        _peerVerifier = peerVerifier ?? new WindowsPipePeerVerifier(
            options.Value.AllowedClientImagePaths, AppContext.BaseDirectory, logger);
        _systemMonitor = systemMonitor;
        _resourceManager = resourceManager;
        _stateManager = stateManager;
        _options = options.Value;
        _modelRuntime = modelRuntime;
        _observationService = observationService;
        _executionEngine = executionEngine;
        _policyEngine = policyEngine;

        _resourceManager.ResourceAlertTriggered += OnResourceAlertTriggered;
        _stateManager.StateChanged += OnStateChanged;

        if (_executionEngine != null)
        {
            _executionEngine.ActionLifecycleChanged += (s, notification) =>
            {
                var env = IpcEnvelope.Create(nameof(ActionLifecycleNotification), notification);
                foreach (var sess in _activeSessions.Values)
                {
                    if (!sess.IsAuthenticated) continue;
                    _ = sess.SendEnvelopeAsync(env);
                }
            };
        }

        if (_agentHost != null)
        {
            // Only to the session that owns the task.
            _agentHost.TaskProgress += (s, e) => SendToOwner(e.Task.OwnerSessionId, IpcEnvelope.Create(nameof(AgentTaskProgressNotification),
                new AgentTaskProgressNotification { TaskId = e.Task.TaskId, Seq = e.Seq, Data = e.Data.Clone() }));
            _agentHost.TaskFinished += (s, rec) => SendToOwner(rec.OwnerSessionId, IpcEnvelope.Create(nameof(AgentTaskResultNotification), rec.Result!));
        }

        // Phase 7B.1a: HUD liveness is always tracked. Without an injected monitor the server builds its own, so a
        // session can never be treated as live merely because the pipe is open.
        _ownsLiveness = livenessMonitor == null;
        _liveness = livenessMonitor ?? new HudLivenessMonitor(
            logger, executionEngine, policyEngine, evidence: null,
            leaseMs: _options.HeartbeatLeaseMs, maxSkewMs: _options.HeartbeatMaxSkewMs);
        _executionEngine?.SetSessionLivenessGate(_liveness.IsLive);
        _policyEngine?.SetSessionLivenessGate(_liveness.IsLive);

        if (_policyEngine != null)
        {
            // The exact operation goes to the owning HUD only, and so does every change of its state.
            _policyEngine.ApprovalRequested += (s, req) =>
                SendToOwner(req.SessionId, IpcEnvelope.Create(nameof(ActionApprovalRequest), req));
            _policyEngine.ApprovalStateChanged += (s, e) =>
                SendToOwner(e.SessionId, IpcEnvelope.Create(nameof(ApprovalStateNotification), e.Notification));
        }
    }

    private readonly HudLivenessMonitor _liveness;
    private readonly bool _ownsLiveness;

    public HudLivenessMonitor Liveness => _liveness;

    private void SendToOwner(string sessionId, IpcEnvelope envelope)
    {
        if (_activeSessions.TryGetValue(sessionId, out var sess) && sess.IsAuthenticated) _ = sess.SendEnvelopeAsync(envelope);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("Starting D-ASK Named Pipe Server on '{PipeName}'...", _options.PipeName);

        // BackgroundService.StartAsync runs ExecuteAsync synchronously up to its first await. An exception
        // thrown before that point escapes StartAsync, so Host.StartAsync/RunAsync throws and, with the
        // default Program.Main, the process dies with an unhandled exception (exit code 0xE0434352)
        // that overrides Environment.ExitCode. Yielding first moves the fatal path behind that boundary:
        // the fault is then handled by the host's BackgroundServiceExceptionBehavior.StopHost, which logs
        // it, stops the host gracefully (RunAsync returns) and leaves Environment.ExitCode = 1.
        // Failure is still fail-closed: nothing is served and there is no retry loop.
        await Task.Yield();

        NamedPipeServerStream? listening;
        PipeSecurity security;
        try
        {
            security = PipeSecurityFactory.CreateForCurrentUser();

            // FirstPipeInstance on THIS instance only: if the name already exists (squatter, stale daemon)
            // creation fails with UnauthorizedAccessException and we refuse to serve.
            listening = CreateInstance(security, firstInstance: true);
        }
        catch (Exception ex)
        {
            throw Fatal($"Cannot establish exclusive, access-controlled ownership of pipe '{_options.PipeName}'. " +
                        "Another process may already own the name, or the ACL could not be applied.", ex);
        }

        TimeSpan handshakeTimeout = TimeSpan.FromMilliseconds(_options.HandshakeTimeoutMs > 0 ? _options.HandshakeTimeoutMs : 5000);

        // Start periodic telemetry broadcast loop in background
        _ = Task.Run(() => TelemetryBroadcastLoopAsync(stoppingToken), stoppingToken);

        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                if (listening == null)
                {
                    // Only reached when all MaxConnectedClients instances were busy at the last attempt.
                    listening = TryCreateNextInstance(security);
                    if (listening == null)
                    {
                        await Task.Delay(250, stoppingToken);
                        continue;
                    }
                }

                NamedPipeServerStream connected = listening;
                listening = null;

                try
                {
                    await connected.WaitForConnectionAsync(stoppingToken);
                }
                catch (OperationCanceledException)
                {
                    try { connected.Dispose(); } catch { }
                    break;
                }
                catch (IOException ex)
                {
                    _logger.LogWarning(ex, "Pipe instance failed while waiting for a client; recreating.");
                    try { connected.Dispose(); } catch { }
                    continue;
                }

                _logger.LogInformation("Client connected on pipe '{PipeName}'.", _options.PipeName);

                var session = new IpcClientSession(
                    connected,
                    _stateManager,
                    _logger,
                    _peerVerifier,
                    _modelRuntime,
                    _observationService,
                    _executionEngine,
                    _policyEngine,
                    handshakeTimeout,
                    _agentHost,
                    _liveness);

                // Re-open a listening instance immediately, before doing any other work, so the window in
                // which no instance of the name is held by this process stays as small as possible.
                listening = TryCreateNextInstance(security);

                _activeSessions.TryAdd(session.SessionId, session);

                session.SessionDisconnected += (s, id) =>
                {
                    _activeSessions.TryRemove(id, out _);
                    _logger.LogInformation("Session {SessionId} removed. Active clients: {Count}", id, _activeSessions.Count);
                    try { connected.Dispose(); } catch { }
                };

                // Run session handler asynchronously (peer verification happens first, inside the session)
                _ = Task.Run(() => session.RunSessionAsync(stoppingToken), stoppingToken);
            }
        }
        catch (OperationCanceledException)
        {
            // normal shutdown
        }
        finally
        {
            try { listening?.Dispose(); } catch { }
        }

        _logger.LogInformation("D-ASK Named Pipe Server stopping.");
    }

    private NamedPipeServerStream CreateInstance(PipeSecurity security, bool firstInstance) =>
        HardenedPipeFactory.Create(_options.PipeName, _options.MaxConnectedClients, security, firstInstance);

    /// <returns>A new listening instance, or null when every instance is currently in use (expected throttling).</returns>
    /// <exception cref="PipeServerFatalException">Any other failure, e.g. access denied because the name is now owned by someone else.</exception>
    private NamedPipeServerStream? TryCreateNextInstance(PipeSecurity security)
    {
        try
        {
            return CreateInstance(security, firstInstance: false);
        }
        catch (IOException ex) when (ex.HResult == ErrorPipeBusyHResult)
        {
            _logger.LogDebug("All {Max} pipe instances are in use; will retry.", _options.MaxConnectedClients);
            return null;
        }
        catch (Exception ex)
        {
            throw Fatal($"Cannot create a further instance of pipe '{_options.PipeName}'; ownership can no longer be guaranteed.", ex);
        }
    }

    private PipeServerFatalException Fatal(string message, Exception inner)
    {
        _logger.LogCritical(inner, "{Message} Terminating the daemon instead of serving a weaker pipe.", message);
        Environment.ExitCode = 1;
        return new PipeServerFatalException(message, inner);
    }

    private async Task TelemetryBroadcastLoopAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(_options.TelemetryIntervalMs, cancellationToken);

                if (_activeSessions.IsEmpty) continue;

                // Evaluate current resource status
                var severity = await _resourceManager.EvaluateCurrentResourcesAsync(cancellationToken);
                var telemetry = await _systemMonitor.CaptureCompleteTelemetryAsync(severity.ToString(), cancellationToken);

                var envelope = IpcEnvelope.Create(nameof(TelemetryUpdate), telemetry);

                await BroadcastEnvelopeAsync(envelope, cancellationToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "Error during telemetry broadcast.");
            }
        }
    }

    private async void OnResourceAlertTriggered(object? sender, ResourceAlert alert)
    {
        if (alert.Severity == "Critical")
        {
            _stateManager.SetStatus(AssistantState.Critical, "Alert");
        }
        else if (alert.Severity == "Warning")
        {
            _stateManager.SetStatus(AssistantState.Warning, "Warning");
        }

        var envelope = IpcEnvelope.Create(nameof(ResourceAlert), alert);
        await BroadcastEnvelopeAsync(envelope, CancellationToken.None);
    }

    private async void OnStateChanged(object? sender, StateUpdate update)
    {
        var envelope = IpcEnvelope.Create(nameof(StateUpdate), update);
        await BroadcastEnvelopeAsync(envelope, CancellationToken.None);
    }

    public async Task BroadcastEnvelopeAsync(IpcEnvelope envelope, CancellationToken cancellationToken = default)
    {
        foreach (var session in _activeSessions.Values)
        {
            if (session.IsAuthenticated)
            {
                try
                {
                    await session.SendEnvelopeAsync(envelope, cancellationToken);
                }
                catch (Exception ex)
                {
                    _logger.LogDebug(ex, "Failed to send message to session {SessionId}", session.SessionId);
                }
            }
        }
    }

    public override void Dispose()
    {
        _resourceManager.ResourceAlertTriggered -= OnResourceAlertTriggered;
        _stateManager.StateChanged -= OnStateChanged;
        if (_ownsLiveness) _liveness.Dispose();
        base.Dispose();
    }
}

