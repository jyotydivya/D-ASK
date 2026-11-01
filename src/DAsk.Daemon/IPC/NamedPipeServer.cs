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

public class NamedPipeServer : BackgroundService
{
    private readonly ILogger<NamedPipeServer> _logger;
    private readonly ISystemMonitor _systemMonitor;
    private readonly IResourceManager _resourceManager;
    private readonly IStateManager _stateManager;
    private readonly ModelRuntime.IModelRuntime? _modelRuntime;
    private readonly Automation.Observation.IScreenObservationService? _observationService;
    private readonly Automation.Execution.ActionExecutionEngine? _executionEngine;
    private readonly Automation.Policy.ActionPolicyEngine? _policyEngine;
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
        Automation.Policy.ActionPolicyEngine? policyEngine = null)
    {
        _logger = logger;
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
                    _ = sess.SendEnvelopeAsync(env);
                }
            };
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("Starting D-ASK Named Pipe Server on '{PipeName}'...", _options.PipeName);

        // Start periodic telemetry broadcast loop in background
        _ = Task.Run(() => TelemetryBroadcastLoopAsync(stoppingToken), stoppingToken);

        while (!stoppingToken.IsCancellationRequested)
        {
            NamedPipeServerStream? serverStream = null;
            try
            {
                serverStream = new NamedPipeServerStream(
                    _options.PipeName,
                    PipeDirection.InOut,
                    _options.MaxConnectedClients,
                    PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous | PipeOptions.WriteThrough);

                _logger.LogDebug("Waiting for incoming client pipe connection...");
                await serverStream.WaitForConnectionAsync(stoppingToken);

                _logger.LogInformation("Client connected on pipe '{PipeName}'.", _options.PipeName);

                var session = new IpcClientSession(
                    serverStream,
                    _stateManager,
                    _logger,
                    _modelRuntime,
                    _observationService,
                    _executionEngine,
                    _policyEngine);

                _activeSessions.TryAdd(session.SessionId, session);

                session.SessionDisconnected += (s, id) =>
                {
                    _activeSessions.TryRemove(id, out _);
                    _logger.LogInformation("Session {SessionId} removed. Active clients: {Count}", id, _activeSessions.Count);
                    try { serverStream.Dispose(); } catch { }
                };

                // Run session handler asynchronously
                _ = Task.Run(() => session.RunSessionAsync(stoppingToken), stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error accepting client pipe connection.");
                try { serverStream?.Dispose(); } catch { }
                await Task.Delay(500, stoppingToken);
            }
        }

        _logger.LogInformation("D-ASK Named Pipe Server stopping.");
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
        base.Dispose();
    }
}

