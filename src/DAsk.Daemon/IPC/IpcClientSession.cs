using System.IO.Pipes;
using System.Runtime.InteropServices;
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
    private bool _isAuthenticated = false;

    public string SessionId => _sessionId;
    public bool IsAuthenticated => _isAuthenticated;

    public event EventHandler<string>? SessionDisconnected;
    public event EventHandler<IpcEnvelope>? EnvelopeReceived;

    public IpcClientSession(
        NamedPipeServerStream pipeStream,
        IStateManager stateManager,
        ILogger logger,
        ModelRuntime.IModelRuntime? modelRuntime = null,
        Automation.Observation.IScreenObservationService? observationService = null,
        Automation.Execution.ActionExecutionEngine? executionEngine = null,
        Automation.Policy.ActionPolicyEngine? policyEngine = null)
    {
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
            _logger.LogInformation("[IPC Session {SessionId}] Started client read loop.", _sessionId);

            while (!cancellationToken.IsCancellationRequested && _pipeStream.IsConnected)
            {
                // Read 4-byte little-endian length prefix
                int headerRead = await ReadExactBytesAsync(headerBuffer, 0, IpcConstants.HeaderSizeBytes, cancellationToken);
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
                int payloadRead = await ReadExactBytesAsync(payloadBuffer, 0, (int)payloadLength, cancellationToken);
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
                    continue;
                }

                if (envelope == null)
                {
                    _logger.LogWarning("[IPC Session {SessionId}] Null envelope received.", _sessionId);
                    continue;
                }

                await HandleEnvelopeAsync(envelope, cancellationToken);
            }
        }
        catch (OperationCanceledException)
        {
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
                _policyEngine?.InvalidateApprovalsForSession(_sessionId, "Client disconnected");
            }
            catch { }
            SessionDisconnected?.Invoke(this, _sessionId);
        }
    }

    private async Task HandleEnvelopeAsync(IpcEnvelope envelope, CancellationToken cancellationToken)
    {
        _logger.LogDebug("[IPC Session {SessionId}] Received message: Type='{Type}', Id='{Id}'",
            _sessionId, envelope.Type, envelope.Id);

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
            return;
        }

        switch (envelope.Type)
        {
            case nameof(HandshakeRequest):
                var handshake = envelope.DeserializePayload<HandshakeRequest>();
                _logger.LogInformation("[IPC Session {SessionId}] Handshake received from '{ClientName}' (PID: {Pid}, NativeStopped: {IsStopped})",
                    _sessionId, handshake?.ClientName, handshake?.ClientProcessId, handshake?.IsEmergencyStopped);

                _isAuthenticated = true;

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
                break;

            case nameof(HeartbeatPing):
                var ping = envelope.DeserializePayload<HeartbeatPing>();
                var pong = IpcEnvelope.Create(nameof(HeartbeatPong), new HeartbeatPong
                {
                    Sequence = ping?.Sequence ?? 0,
                    PingTimestamp = ping?.Timestamp ?? DateTimeOffset.UtcNow,
                    PongTimestamp = DateTimeOffset.UtcNow
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
                    uint? clientPid = null;
                    try
                    {
                        if (GetNamedPipeClientProcessId(_pipeStream.SafePipeHandle, out uint realPid) && realPid > 0)
                        {
                            clientPid = realPid;
                        }
                    }
                    catch { }

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
                var resumeReq = envelope.DeserializePayload<ResumeExecutionRequest>() ?? new ResumeExecutionRequest();
                _logger.LogInformation("[IPC Session {SessionId}] Resume execution invoked from source '{Source}': {Reason} (ReqId={ReqId}, Gen={Gen})",
                    _sessionId, resumeReq.Source, resumeReq.Reason, resumeReq.ResumeId, resumeReq.StopGeneration);

                ResumeExecutionResponse resumeResp;
                if (_executionEngine != null)
                {
                    resumeResp = await _executionEngine.ResumeExecutionAsync(
                        resumeReq.Source,
                        resumeReq.Reason,
                        resumeReq.ResumeId,
                        _sessionId,
                        resumeReq.StopGeneration > 0 ? resumeReq.StopGeneration : null);
                }
                else
                {
                    _stateManager.SetStatus(AssistantState.Idle, "Normal");
                    resumeResp = new ResumeExecutionResponse
                    {
                        ResumeId = resumeReq.ResumeId,
                        Success = true,
                        SessionId = _sessionId,
                        StopGeneration = 1,
                        Timestamp = DateTimeOffset.UtcNow
                    };
                }

                var resumeRespEnvelope = IpcEnvelope.Create(nameof(ResumeExecutionResponse), resumeResp, envelope.Id);
                await SendEnvelopeAsync(resumeRespEnvelope, cancellationToken);
                break;

            case nameof(PanicHotkeyStatusNotification):
                var hotkeyNotif = envelope.DeserializePayload<PanicHotkeyStatusNotification>();
                if (hotkeyNotif != null && _executionEngine != null)
                {
                    _logger.LogInformation("[IPC Session {SessionId}] Received PanicHotkeyStatusNotification: Available={IsAvailable}, Reason={Reason}, ErrorCode={ErrorCode}",
                        _sessionId, hotkeyNotif.IsAvailable, hotkeyNotif.Reason, hotkeyNotif.ErrorCode);
                    _executionEngine.SetPanicHotkeyStatus(hotkeyNotif.IsAvailable, hotkeyNotif.Reason, hotkeyNotif.ErrorCode);
                }
                break;

            case nameof(ActionApprovalResponse):
                var approvalDecision = envelope.DeserializePayload<ActionApprovalResponse>();
                if (approvalDecision != null && _policyEngine != null)
                {
                    _logger.LogInformation("[IPC Session {SessionId}] Received user approval decision for {ApprovalId}: Approved={Approved}",
                        _sessionId, approvalDecision.ApprovalId, approvalDecision.Approved);
                    _policyEngine.SubmitApprovalDecision(
                        approvalDecision,
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
                EnvelopeReceived?.Invoke(this, envelope);
                break;
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

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetNamedPipeClientProcessId(
        Microsoft.Win32.SafeHandles.SafePipeHandle Pipe,
        out uint ClientProcessId);
}

