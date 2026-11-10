using System.IO.Pipes;
using DAsk.Daemon.State;
using DAsk.Protocol.IPC;
using DAsk.Protocol.IPC.Messages;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Extensions.Logging;

namespace DAsk.Daemon.IPC;

public class IpcClientSession
{
    private readonly ILogger _logger;
    private readonly NamedPipeServerStream _pipeStream;
    private readonly IStateManager _stateManager;
    private readonly string _sessionId = Guid.NewGuid().ToString("N");
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private readonly ModelRuntime.IModelRuntime? _modelRuntime;
    private readonly Automation.Observation.IScreenObservationService? _observationService;
    private readonly Automation.Execution.ActionExecutionEngine? _executionEngine;
    private readonly Automation.Policy.ActionPolicyEngine? _policyEngine;
    private readonly AgentHost.AgentHostManager? _agentHost;
    private readonly HudLivenessMonitor? _liveness;
    private bool _isAuthenticated = false;
    private readonly IPipePeerVerifier _peerVerifier;
    private readonly TimeSpan _handshakeTimeout;
    private readonly long _acceptedAtFileTime = DateTime.UtcNow.ToFileTimeUtc();
    private VerifiedPeer? _verifiedPeer;
    private bool _closeRequested;

    public string SessionId => _sessionId;
    public bool IsAuthenticated => _isAuthenticated;

    public event EventHandler<string>? SessionDisconnected;
    public event EventHandler<IpcEnvelope>? EnvelopeReceived;

    /// <param name="peerVerifier">
    /// Required, with no default: a session can never be constructed without deciding who may talk to it.
    /// Production passes <see cref="WindowsPipePeerVerifier"/>; only the test assembly defines a permissive one.
    /// </param>
    public IpcClientSession(
        NamedPipeServerStream pipeStream,
        IStateManager stateManager,
        ILogger logger,
        IPipePeerVerifier peerVerifier,
        ModelRuntime.IModelRuntime? modelRuntime = null,
        Automation.Observation.IScreenObservationService? observationService = null,
        Automation.Execution.ActionExecutionEngine? executionEngine = null,
        Automation.Policy.ActionPolicyEngine? policyEngine = null,
        TimeSpan? handshakeTimeout = null,
        AgentHost.AgentHostManager? agentHost = null,
        HudLivenessMonitor? liveness = null)
    {
        _agentHost = agentHost;
        _liveness = liveness;
        _peerVerifier = peerVerifier ?? throw new ArgumentNullException(nameof(peerVerifier));
        _handshakeTimeout = handshakeTimeout is { } t && t > TimeSpan.Zero ? t : TimeSpan.FromSeconds(5);
        _pipeStream = pipeStream;
        _stateManager = stateManager;
        _logger = logger;
        _modelRuntime = modelRuntime;
        _observationService = observationService;
        _executionEngine = executionEngine;
        _policyEngine = policyEngine;
    }

    public async Task RunSessionAsync(CancellationToken cancellationToken)
    {
        byte[] headerBuffer = new byte[IpcConstants.HeaderSizeBytes];

        try
        {
            // Establish the peer's stable identity BEFORE reading a single byte from it.
            var verification = _peerVerifier.Verify(_pipeStream, _acceptedAtFileTime);
            if (!verification.Ok)
            {
                _logger.LogWarning("[IPC Session {SessionId}] Peer rejected before handshake: {Reason}",
                    _sessionId, verification.FailureReason);
                return;
            }
            _verifiedPeer = verification.Peer;
            _logger.LogInformation("[IPC Session {SessionId}] Verified peer PID {Pid} ({Image}).",
                _sessionId, _verifiedPeer!.Pid, _verifiedPeer.ImagePath);

            _logger.LogInformation("[IPC Session {SessionId}] Started client read loop.", _sessionId);

            // Until a valid handshake completes, every read is bounded by the handshake timeout.
            using var handshakeCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            handshakeCts.CancelAfter(_handshakeTimeout);

            while (!cancellationToken.IsCancellationRequested && _pipeStream.IsConnected && !_closeRequested)
            {
                var readToken = _isAuthenticated ? cancellationToken : handshakeCts.Token;

                // Read 4-byte little-endian length prefix
                int headerRead = await ReadExactBytesAsync(headerBuffer, 0, IpcConstants.HeaderSizeBytes, readToken);
                if (headerRead == 0)
                {
                    _logger.LogInformation("[IPC Session {SessionId}] Client disconnected normally (EOF).", _sessionId);
                    break;
                }

                uint payloadLength = BitConverter.ToUInt32(headerBuffer, 0);

                // Validation rule: Reject frames larger than max allowed
                if (payloadLength > IpcConstants.MaxMessageSizeBytes)
                {
                    _logger.LogError("[IPC Session {SessionId}] Frame length {Length} exceeds max allowed limit {MaxLimit}. Terminating session.",
                        _sessionId, payloadLength, IpcConstants.MaxMessageSizeBytes);
                    break;
                }

                // Read full payload
                byte[] payloadBuffer = new byte[payloadLength];
                int payloadRead = await ReadExactBytesAsync(payloadBuffer, 0, (int)payloadLength, readToken);
                if (payloadRead < payloadLength)
                {
                    _logger.LogWarning("[IPC Session {SessionId}] Incomplete payload read. Expected {Expected}, got {Actual}.",
                        _sessionId, payloadLength, payloadRead);
                    break;
                }

                // Deserialize envelope
                IpcEnvelope? envelope;
                try
                {
                    envelope = IpcEnvelope.FromJsonBytes(payloadBuffer);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "[IPC Session {SessionId}] Malformed JSON envelope rejected.", _sessionId);
                    if (!_isAuthenticated) break; // an unauthenticated peer gets no second chances
                    continue;
                }

                if (envelope == null)
                {
                    _logger.LogWarning("[IPC Session {SessionId}] Null envelope received.", _sessionId);
                    if (!_isAuthenticated) break;
                    continue;
                }

                await HandleEnvelopeAsync(envelope, cancellationToken);
            }
        }
        catch (OperationCanceledException)
        {
            if (!cancellationToken.IsCancellationRequested && !_isAuthenticated)
                _logger.LogWarning("[IPC Session {SessionId}] No valid handshake within {Timeout}; closing.", _sessionId, _handshakeTimeout);
            else
                _logger.LogDebug("[IPC Session {SessionId}] Session cancelled.", _sessionId);
        }
        catch (IOException ex)
        {
            _logger.LogDebug(ex, "[IPC Session {SessionId}] Pipe IO error (likely client exit).", _sessionId);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[IPC Session {SessionId}] Unexpected error in session loop.", _sessionId);
        }
        finally
        {
            // A session that never authenticated could not have created buffers, actions or approvals,
            // so its teardown must not touch shared state at all.
            if (_isAuthenticated)
            {
                // Phase 7B.1a: first, so panic-hotkey availability derived from this HUD is withdrawn before anything else.
                try
                {
                    _liveness?.OnSessionEnded(_sessionId);
                }
                catch { }
                try
                {
                    _observationService?.ReleaseSessionBuffers(_sessionId);
                }
                catch { }
                try
                {
                    _executionEngine?.CancelActionsForSession(_sessionId);
                }
                catch { }
                try
                {
                    _agentHost?.CancelTasksForSession(_sessionId);
                }
                catch { }
                try
                {
                    _policyEngine?.InvalidateApprovalsForSession(_sessionId, "Client disconnected");
                }
                catch { }
            }
            try { _verifiedPeer?.Dispose(); } catch { }
            SessionDisconnected?.Invoke(this, _sessionId);
        }
    }

    private async Task HandleEnvelopeAsync(IpcEnvelope envelope, CancellationToken cancellationToken)
    {
        _logger.LogDebug("[IPC Session {SessionId}] Received message: Type='{Type}', Id='{Id}'",
            _sessionId, envelope.Type, envelope.Id);

        // Authentication gate: until a valid handshake completes, NOTHING else is processed. No state is
        // read or changed, no handler runs, and the connection is closed.
        if (!_isAuthenticated && !string.Equals(envelope.Type, nameof(HandshakeRequest), StringComparison.Ordinal))
        {
            _logger.LogWarning("[IPC Session {SessionId}] Rejected '{Type}' received before handshake; closing connection.",
                _sessionId, envelope.Type);
            _closeRequested = true;
            return;
        }

        // Version validation
        if (envelope.Version != IpcConstants.CurrentProtocolVersion)
        {
            _logger.LogWarning("[IPC Session {SessionId}] Protocol version mismatch. Expected {Expected}, got {Actual}.",
                _sessionId, IpcConstants.CurrentProtocolVersion, envelope.Version);

            var reject = IpcEnvelope.Create(nameof(HandshakeResponse), new HandshakeResponse
            {
                Status = "Rejected",
                ProtocolVersion = IpcConstants.CurrentProtocolVersion,
                Message = $"Unsupported protocol version {envelope.Version}. Expected {IpcConstants.CurrentProtocolVersion}."
            }, envelope.Id);

            await SendEnvelopeAsync(reject, cancellationToken);
            if (!_isAuthenticated) _closeRequested = true;
            return;
        }

        switch (envelope.Type)
        {
            case nameof(HandshakeRequest):
                HandshakeRequest? handshake;
                try { handshake = envelope.DeserializePayload<HandshakeRequest>(); }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "[IPC Session {SessionId}] Malformed handshake payload.", _sessionId);
                    handshake = null;
                }
                _logger.LogInformation("[IPC Session {SessionId}] Handshake received from '{ClientName}' (claimed PID: {Pid}, NativeStopped: {IsStopped})",
                    _sessionId, handshake?.ClientName, handshake?.ClientProcessId, handshake?.IsEmergencyStopped);

                // The self-reported PID is untrusted; it must equal the PID of the verified pipe peer.
                // Rejected handshakes cause no state change (in particular no stop reconciliation).
                if (handshake == null || _verifiedPeer == null || handshake.ClientProcessId != (int)_verifiedPeer.Pid)
                {
                    _logger.LogWarning("[IPC Session {SessionId}] Handshake rejected: claimed PID {Claimed} does not match verified peer PID {Verified}.",
                        _sessionId, handshake?.ClientProcessId, _verifiedPeer?.Pid);
                    await SendEnvelopeAsync(IpcEnvelope.Create(nameof(HandshakeResponse), new HandshakeResponse
                    {
                        Status = "Rejected",
                        ProtocolVersion = IpcConstants.CurrentProtocolVersion,
                        Message = "Client process identity could not be confirmed."
                    }, envelope.Id), cancellationToken);
                    _closeRequested = true;
                    break;
                }

                // Reconciliation: If native client reports stopped, daemon reconciles to stopped immediately
                if (handshake?.IsEmergencyStopped == true)
                {
                    _logger.LogWarning("[IPC Session {SessionId}] Reconciling Emergency Stop from native client handshake (StopId: {StopId})",
                        _sessionId, handshake.StopId);

                    if (_executionEngine != null)
                    {
                        await _executionEngine.TriggerEmergencyStopAsync(
                            "NativeHostHandshake",
                            handshake.StopReason ?? "Reconciled from native stop latch during handshake",
                            handshake.StopId,
                            _sessionId);
                    }
                    else
                    {
                        _stateManager.SetStatus(AssistantState.Idle, "EmergencyStop");
                    }
                }

                bool daemonStopped = _executionEngine?.IsEmergencyStopped ?? (_stateManager.ActiveStatus == "Idle" && _stateManager.OrbMode == "EmergencyStop");
                ulong currentGen = _executionEngine?.CurrentStopGeneration ?? 1;

                var handshakeResp = IpcEnvelope.Create(nameof(HandshakeResponse), new HandshakeResponse
                {
                    Status = "Accepted",
                    ProtocolVersion = IpcConstants.CurrentProtocolVersion,
                    DaemonProcessId = Environment.ProcessId,
                    SessionToken = _sessionId,
                    Message = "Session initialized successfully.",
                    IsEmergencyStopped = daemonStopped,
                    StopGeneration = currentGen
                }, envelope.Id);

                await SendEnvelopeAsync(handshakeResp, cancellationToken);

                // Authenticated only after the response is on the wire, so no broadcast can overtake it.
                _isAuthenticated = true;
                // Liveness starts Unknown: an open, authenticated pipe is not proof that the HUD can still stop things.
                _liveness?.OnSessionAuthenticated(_sessionId);
                break;

            case nameof(HeartbeatPing):
                var ping = envelope.DeserializePayload<HeartbeatPing>();
                // Phase 7B.1a: the heartbeat is evaluated, not merely answered. Without a monitor nothing is ever live.
                var verdict = ping == null
                    ? new HeartbeatVerdict(false, "malformed heartbeat")
                    : _liveness?.OnHeartbeat(_sessionId, ping) ?? new HeartbeatVerdict(false, "no liveness monitor");
                if (!verdict.Accepted)
                    _logger.LogDebug("[IPC Session {SessionId}] Heartbeat did not renew the liveness lease: {Reason}", _sessionId, verdict.Reason);
                var pong = IpcEnvelope.Create(nameof(HeartbeatPong), new HeartbeatPong
                {
                    Sequence = ping?.Sequence ?? 0,
                    PingTimestamp = ping?.Timestamp ?? DateTimeOffset.UtcNow,
                    PongTimestamp = DateTimeOffset.UtcNow,
                    LeaseRenewed = verdict.Accepted,
                    Reason = verdict.Reason,
                }, envelope.Id);

                await SendEnvelopeAsync(pong, cancellationToken);
                break;

            case nameof(StateRestoreRequest):
                var restoreReq = envelope.DeserializePayload<StateRestoreRequest>() ?? new StateRestoreRequest();
                _stateManager.RestoreClientState(restoreReq, out var restoreResp);

                var responseEnvelope = IpcEnvelope.Create(nameof(StateRestoreResponse), restoreResp, envelope.Id);
                await SendEnvelopeAsync(responseEnvelope, cancellationToken);
                break;

            case nameof(ModelInferenceIpcRequest):
                var inferReq = envelope.DeserializePayload<ModelInferenceIpcRequest>();
                if (_modelRuntime == null)
                {
                    var errResp = IpcEnvelope.Create(nameof(ModelInferenceIpcResponse), new ModelInferenceIpcResponse
                    {
                        TaskId = inferReq?.TaskId ?? string.Empty,
                        IsSuccess = false,
                        ErrorMessage = "Model runtime is not available."
                    }, envelope.Id);
                    await SendEnvelopeAsync(errResp, cancellationToken);
                    break;
                }

                // One model owner: while the agent host holds the local model, a second copy is never loaded.
                if (_agentHost?.OwnsLocalModel == true)
                {
                    _logger.LogInformation("[IPC Session {SessionId}] Direct inference refused: the agent host owns the local model.", _sessionId);
                    await SendEnvelopeAsync(IpcEnvelope.Create(nameof(ModelInferenceIpcResponse), new ModelInferenceIpcResponse
                    {
                        TaskId = inferReq?.TaskId ?? string.Empty,
                        IsSuccess = false,
                        ErrorMessage = "The local model is in use by the agent; direct inference is unavailable until it unloads.",
                        RejectionCode = "AgentModelOwnerActive"
                    }, envelope.Id), cancellationToken);
                    break;
                }

                if (inferReq != null)
                {
                    // Latch check: If inference is for Computer-Use Planning, block if Emergency Stop is active
                    bool isComputerUse = string.Equals(inferReq.Purpose, "ComputerUsePlanning", StringComparison.OrdinalIgnoreCase) ||
                                         string.Equals(inferReq.Purpose, "ComputerUse", StringComparison.OrdinalIgnoreCase);

                    if (isComputerUse && _executionEngine != null && _executionEngine.IsEmergencyStopped)
                    {
                        _logger.LogWarning("[IPC Session {SessionId}] Blocked computer-use inference: Emergency Stop is active.", _sessionId);
                        var blockedResp = IpcEnvelope.Create(nameof(ModelInferenceIpcResponse), new ModelInferenceIpcResponse
                        {
                            TaskId = inferReq.TaskId,
                            IsSuccess = false,
                            ErrorMessage = "Computer-use planning inference blocked: Emergency Stop is currently active.",
                            RejectionCode = "EmergencyStopBlocked"
                        }, envelope.Id);
                        await SendEnvelopeAsync(blockedResp, cancellationToken);
                        break;
                    }

                    if (isComputerUse && _executionEngine != null && !_executionEngine.IsPanicHotkeyAvailable)
                    {
                        _logger.LogError("[IPC Session {SessionId}] Blocked computer-use inference: Panic hotkey is unavailable.", _sessionId);
                        var blockedResp = IpcEnvelope.Create(nameof(ModelInferenceIpcResponse), new ModelInferenceIpcResponse
                        {
                            TaskId = inferReq.TaskId,
                            IsSuccess = false,
                            ErrorMessage = "Computer-use planning inference blocked: Emergency panic hotkey is unavailable.",
                            RejectionCode = "PanicHotkeyUnavailableBlocked"
                        }, envelope.Id);
                        await SendEnvelopeAsync(blockedResp, cancellationToken);
                        break;
                    }

                    try
                    {
                        _stateManager.SetStatus(AssistantState.ModelGenerating, "Generating");

                        var req = new ModelRuntime.ModelInferenceRequest
                        {
                            TaskId = inferReq.TaskId,
                            ActionId = inferReq.ActionId,
                            Prompt = inferReq.Prompt,
                            SystemPrompt = inferReq.SystemPrompt,
                            MaxTokens = inferReq.MaxTokens,
                            Temperature = inferReq.Temperature,
                            TopP = inferReq.TopP,
                            EnforceJsonStructure = inferReq.EnforceJsonStructure,
                            StopSequences = inferReq.StopSequences
                        };

                        var (text, telem) = await _modelRuntime.GenerateAsync(req, cancellationToken);
                        var resp = IpcEnvelope.Create(nameof(ModelInferenceIpcResponse), new ModelInferenceIpcResponse
                        {
                            TaskId = inferReq.TaskId,
                            Text = text,
                            BackendUsed = telem.BackendUsed,
                            TimeToFirstTokenMs = telem.TimeToFirstTokenMs,
                            GenerationTokensPerSec = telem.GenerationTokensPerSec,
                            TotalTokensGenerated = telem.TotalTokensGenerated,
                            IsSuccess = true
                        }, envelope.Id);

                        await SendEnvelopeAsync(resp, cancellationToken);
                    }
                    catch (Exception ex)
                    {
                        var errResp = IpcEnvelope.Create(nameof(ModelInferenceIpcResponse), new ModelInferenceIpcResponse
                        {
                            TaskId = inferReq.TaskId,
                            IsSuccess = false,
                            ErrorMessage = ex.Message
                        }, envelope.Id);
                        await SendEnvelopeAsync(errResp, cancellationToken);
                    }
                    finally
                    {
                        _stateManager.SetStatus(AssistantState.Idle, "Normal");
                    }
                }
                break;

            case nameof(CaptureObservationRequest):
                var obsReq = envelope.DeserializePayload<CaptureObservationRequest>() ?? new CaptureObservationRequest();
                if (_observationService == null)
                {
                    var errResp = IpcEnvelope.Create(nameof(CaptureObservationResponse), new CaptureObservationResponse
                    {
                        RequestId = obsReq.RequestId,
                        Success = false,
                        ErrorMessage = "Screen observation service is not available on this daemon."
                    }, envelope.Id);
                    await SendEnvelopeAsync(errResp, cancellationToken);
                    break;
                }

                // Safety Latch Check: Block observation capture if Emergency Stop is active or Panic Hotkey is unavailable
                bool isComputerUseObs = string.IsNullOrEmpty(obsReq.Purpose) ||
                                        string.Equals(obsReq.Purpose, "ComputerUse", StringComparison.OrdinalIgnoreCase) ||
                                        string.Equals(obsReq.Purpose, "ComputerUsePlanning", StringComparison.OrdinalIgnoreCase);

                if (isComputerUseObs && _executionEngine != null && _executionEngine.IsEmergencyStopped)
                {
                    _logger.LogWarning("[IPC Session {SessionId}] Blocked observation capture: Emergency Stop is active.", _sessionId);
                    var stoppedResp = IpcEnvelope.Create(nameof(CaptureObservationResponse), new CaptureObservationResponse
                    {
                        RequestId = obsReq.RequestId,
                        Success = false,
                        ErrorMessage = "Observation capture is blocked while emergency stop is active.",
                        RejectionCode = "EmergencyStopBlocked"
                    }, envelope.Id);
                    await SendEnvelopeAsync(stoppedResp, cancellationToken);
                    break;
                }

                if (isComputerUseObs && _executionEngine != null && !_executionEngine.IsPanicHotkeyAvailable)
                {
                    _logger.LogError("[IPC Session {SessionId}] Blocked observation capture: Panic hotkey is unavailable.", _sessionId);
                    var hotkeyResp = IpcEnvelope.Create(nameof(CaptureObservationResponse), new CaptureObservationResponse
                    {
                        RequestId = obsReq.RequestId,
                        Success = false,
                        ErrorMessage = "Observation capture is blocked because the panic hotkey is unavailable.",
                        RejectionCode = "PanicHotkeyUnavailableBlocked"
                    }, envelope.Id);
                    await SendEnvelopeAsync(hotkeyResp, cancellationToken);
                    break;
                }

                try
                {
                    // The PID established and pinned (process handle held) at connection time; never re-queried.
                    uint? clientPid = _verifiedPeer?.Pid;

                    var obsResp = await _observationService.CaptureAsync(obsReq, clientPid, _sessionId, cancellationToken);
                    var respEnvelope = IpcEnvelope.Create(nameof(CaptureObservationResponse), obsResp, envelope.Id);
                    await SendEnvelopeAsync(respEnvelope, cancellationToken);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "[IPC Session {SessionId}] Failed to capture screen observation.", _sessionId);
                    var errResp = IpcEnvelope.Create(nameof(CaptureObservationResponse), new CaptureObservationResponse
                    {
                        RequestId = obsReq.RequestId,
                        Success = false,
                        ErrorMessage = ex.Message
                    }, envelope.Id);
                    await SendEnvelopeAsync(errResp, cancellationToken);
                }
                break;

            case nameof(AgentTaskSubmitRequest):
            case nameof(AgentTaskStatusRequest):
            case nameof(AgentTaskCancelRequest):
            case nameof(AgentHostHealthRequest):
                // Off the read loop: starting the host can take seconds, and nothing here may delay an
                // Emergency Stop arriving on this same connection.
                _ = Task.Run(() => HandleAgentRequestAsync(envelope, cancellationToken), CancellationToken.None);
                break;

            case nameof(EmergencyStopRequest):
                var stopReq = envelope.DeserializePayload<EmergencyStopRequest>() ?? new EmergencyStopRequest();
                _logger.LogWarning("[IPC Session {SessionId}] Emergency stop invoked from source '{Source}': {Reason}",
                    _sessionId, stopReq.Source, stopReq.Reason);

                EmergencyStopResponse stopResp;
                if (_executionEngine != null)
                {
                    stopResp = await _executionEngine.TriggerEmergencyStopAsync(stopReq.Source, stopReq.Reason, stopReq.StopId, _sessionId);
                }
                else
                {
                    _stateManager.SetStatus(AssistantState.Idle, "EmergencyStop");
                    stopResp = new EmergencyStopResponse
                    {
                        StopId = stopReq.StopId,
                        Success = true,
                        ActiveActionsCancelled = 0,
                        QueuedActionsCancelled = 0,
                        SessionId = _sessionId,
                        StopGeneration = 1,
                        Timestamp = DateTimeOffset.UtcNow
                    };
                }

                var stopRespEnvelope = IpcEnvelope.Create(nameof(EmergencyStopResponse), stopResp, envelope.Id);
                await SendEnvelopeAsync(stopRespEnvelope, cancellationToken);
                break;

            case nameof(ResumeExecutionRequest):
                // H3-8: the wire generation is passed through UNCHANGED. A missing field deserializes to 0, and 0 is
                // never a valid generation, so the engine rejects it (as it does stale and future generations)
                // before draining. Do not map 0 to "unchecked".
                var resumeReq = envelope.DeserializePayload<ResumeExecutionRequest>() ?? new ResumeExecutionRequest();
                _logger.LogInformation("[IPC Session {SessionId}] Resume execution invoked from source '{Source}': {Reason} (ReqId={ReqId}, Gen={Gen})",
                    _sessionId, resumeReq.Source, resumeReq.Reason, resumeReq.ResumeId, resumeReq.StopGeneration);

                ResumeExecutionResponse resumeResp;
                if (_executionEngine != null)
                {
                    resumeResp = await _executionEngine.ResumeExecutionAsync(
                        resumeReq.Source,
                        resumeReq.Reason,
                        resumeReq.StopGeneration,
                        resumeReq.ResumeId,
                        _sessionId);
                }
                else
                {
                    // H3-8 fail-closed: without an engine there is no authoritative stop generation to validate
                    // against, so a Resume can never be honoured. Do not touch state and do not report success.
                    // (Unreachable with the shipped Program.cs, which always registers the engine.)
                    _logger.LogError("[IPC Session {SessionId}] Resume rejected: execution engine unavailable; no generation can be validated.", _sessionId);
                    resumeResp = new ResumeExecutionResponse
                    {
                        ResumeId = resumeReq.ResumeId,
                        Success = false,
                        SessionId = _sessionId,
                        StopGeneration = 0,
                        ErrorMessage = "Cannot resume: execution engine is not available, so the stop generation cannot be validated.",
                        Timestamp = DateTimeOffset.UtcNow
                    };
                }

                var resumeRespEnvelope = IpcEnvelope.Create(nameof(ResumeExecutionResponse), resumeResp, envelope.Id);
                await SendEnvelopeAsync(resumeRespEnvelope, cancellationToken);
                break;

            case nameof(PanicHotkeyStatusNotification):
                var hotkeyNotif = envelope.DeserializePayload<PanicHotkeyStatusNotification>();
                if (hotkeyNotif != null)
                {
                    _logger.LogInformation("[IPC Session {SessionId}] Received PanicHotkeyStatusNotification: Available={IsAvailable}, Reason={Reason}, ErrorCode={ErrorCode}",
                        _sessionId, hotkeyNotif.IsAvailable, hotkeyNotif.Reason, hotkeyNotif.ErrorCode);
                    // Phase 7B.1a: a report is a claim about this session only. Availability is derived by the liveness
                    // monitor from live sessions; a report alone never makes the hotkey available.
                    if (_liveness != null)
                        _liveness.OnHotkeyStatus(_sessionId, hotkeyNotif.IsAvailable, hotkeyNotif.Reason);
                    else if (!hotkeyNotif.IsAvailable)
                        _executionEngine?.SetPanicHotkeyStatus(false, hotkeyNotif.Reason, hotkeyNotif.ErrorCode);
                }
                break;

            case nameof(ActionApprovalResponse):
                // H3-9: a decision is accepted only from the authenticated session that owns the approval. The
                // identity passed here is this connection's server-generated _sessionId. The decision payload's own
                // session field comes from the client and is deliberately never used; ActionPolicyEngine.SubmitApprovalDecision
                // performs the ownership check at the authoritative decision point.
                var approvalDecision = envelope.DeserializePayload<ActionApprovalResponse>();
                if (approvalDecision != null && _policyEngine != null)
                {
                    _logger.LogInformation("[IPC Session {SessionId}] Received user approval decision for {ApprovalId}: Approved={Approved}",
                        _sessionId, approvalDecision.ApprovalId, approvalDecision.Approved);
                    _policyEngine.SubmitApprovalDecision(
                        approvalDecision,
                        _sessionId,
                        () => _executionEngine?.IsEmergencyStopped ?? false,
                        () => _executionEngine?.CurrentStopGeneration ?? 1);
                }
                break;

            case nameof(SimulatedActionRequest):
                var simReq = envelope.DeserializePayload<SimulatedActionRequest>() ?? new SimulatedActionRequest();
                if (_executionEngine == null)
                {
                    var blockedResp = IpcEnvelope.Create(nameof(SimulatedActionResponse), new SimulatedActionResponse
                    {
                        ActionId = simReq.ActionId,
                        Success = false,
                        Status = "Blocked",
                        ErrorMessage = "Action execution engine is not available on this daemon."
                    }, envelope.Id);
                    await SendEnvelopeAsync(blockedResp, cancellationToken);
                    break;
                }

                var simResp = await _executionEngine.ExecuteSimulatedActionAsync(simReq, _sessionId, cancellationToken);
                var simRespEnvelope = IpcEnvelope.Create(nameof(SimulatedActionResponse), simResp, envelope.Id);
                await SendEnvelopeAsync(simRespEnvelope, cancellationToken);
                break;

            default:
                // Phase 7B.1a, F6: nothing is dropped silently. TaskApproval is the retired page approval path: it never
                // reached any policy, and there is exactly one approval path (ActionApprovalResponse to the policy engine).
                bool obsoleteAuthorization = string.Equals(envelope.Type, "TaskApproval", StringComparison.Ordinal);
                if (obsoleteAuthorization)
                    _logger.LogError("[IPC Session {SessionId}] Rejected obsolete authorization message 'TaskApproval'; it authorizes nothing.", _sessionId);
                else
                    _logger.LogWarning("[IPC Session {SessionId}] Rejected unsupported message type '{Type}'.", _sessionId,
                        envelope.Type.Length > 64 ? envelope.Type[..64] : envelope.Type);
                EnvelopeReceived?.Invoke(this, envelope);
                await SendEnvelopeAsync(IpcEnvelope.Create(nameof(MessageRejectedNotification), new MessageRejectedNotification
                {
                    RejectedType = envelope.Type.Length > 64 ? envelope.Type[..64] : envelope.Type,
                    Code = obsoleteAuthorization ? "obsolete_authorization_message" : "unsupported_message",
                    Message = obsoleteAuthorization
                        ? "TaskApproval is obsolete and authorizes nothing. Approvals are decided only through ActionApprovalResponse."
                        : "The daemon does not handle this message type; it was not acted on.",
                }, envelope.Id), cancellationToken);
                break;
        }
    }

    /// <summary>The session id comes from this connection, never from a payload, so ownership cannot be claimed.</summary>
    private async Task HandleAgentRequestAsync(IpcEnvelope envelope, CancellationToken cancellationToken)
    {
        try
        {
            IpcEnvelope reply;
            switch (envelope.Type)
            {
                case nameof(AgentTaskSubmitRequest):
                {
                    var req = envelope.DeserializePayload<AgentTaskSubmitRequest>();
                    AgentHost.AgentSubmitResult r = _agentHost == null
                        ? new(false, null, "agent_host_disabled", "The agent host is not available.")
                        : await _agentHost.SubmitAsync(req?.Objective ?? string.Empty, _sessionId, cancellationToken);
                    reply = IpcEnvelope.Create(nameof(AgentTaskSubmitResponse), new AgentTaskSubmitResponse
                    {
                        Accepted = r.Accepted,
                        TaskId = r.TaskId,
                        RejectionCode = r.RejectionCode,
                        ErrorMessage = r.ErrorMessage,
                    }, envelope.Id);
                    break;
                }
                case nameof(AgentTaskStatusRequest):
                {
                    var req = envelope.DeserializePayload<AgentTaskStatusRequest>();
                    var rec = _agentHost?.GetTask(req?.TaskId ?? string.Empty, _sessionId);
                    reply = IpcEnvelope.Create(nameof(AgentTaskStatusResponse), new AgentTaskStatusResponse
                    {
                        Found = rec != null,
                        TaskId = req?.TaskId ?? string.Empty,
                        State = rec?.State,
                        Result = rec?.Result,
                    }, envelope.Id);
                    break;
                }
                case nameof(AgentTaskCancelRequest):
                {
                    var req = envelope.DeserializePayload<AgentTaskCancelRequest>();
                    var r = _agentHost == null
                        ? new AgentTaskCancelResponse { TaskId = req?.TaskId ?? string.Empty, RejectionCode = "host_unavailable" }
                        : await _agentHost.CancelAsync(req?.TaskId ?? string.Empty, _sessionId);
                    reply = IpcEnvelope.Create(nameof(AgentTaskCancelResponse), r, envelope.Id);
                    break;
                }
                default:
                    reply = IpcEnvelope.Create(nameof(AgentHostHealthResponse), _agentHost?.Health() ?? new AgentHostHealthResponse(), envelope.Id);
                    break;
            }
            await SendEnvelopeAsync(reply, cancellationToken);
        }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            _logger.LogWarning("[IPC Session {SessionId}] Agent request {Type} failed: {Error}", _sessionId, envelope.Type, ex.Message);
        }
    }

    public async Task SendEnvelopeAsync(IpcEnvelope envelope, CancellationToken cancellationToken = default)
    {
        if (!_pipeStream.IsConnected) return;

        byte[] frame = envelope.ToLengthPrefixedBytes();

        await _writeLock.WaitAsync(cancellationToken);
        try
        {
            await _pipeStream.WriteAsync(frame, cancellationToken);
            await _pipeStream.FlushAsync(cancellationToken);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    private async Task<int> ReadExactBytesAsync(byte[] buffer, int offset, int count, CancellationToken ct)
    {
        int totalRead = 0;
        while (totalRead < count)
        {
            int read = await _pipeStream.ReadAsync(buffer.AsMemory(offset + totalRead, count - totalRead), ct);
            if (read == 0) return totalRead; // EOF reached
            totalRead += read;
        }
        return totalRead;
    }
}

