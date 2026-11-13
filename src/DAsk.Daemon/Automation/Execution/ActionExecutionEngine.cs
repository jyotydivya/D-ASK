using System.Collections.Concurrent;
using System.Diagnostics;
using DAsk.Daemon.Automation.Policy;
using DAsk.Daemon.Research;
using DAsk.Daemon.State;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Extensions.Logging;

namespace DAsk.Daemon.Automation.Execution;

public class ActiveActionContext
{
    public required string ActionId { get; init; }
    public required string SessionId { get; init; }
    public required string ActionType { get; init; }
    public required ulong StopGeneration { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
    public required CancellationTokenSource Cts { get; init; }
    public TaskCompletionSource<bool> CompletionTcs { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public ActionLifecycleState State { get; set; } = ActionLifecycleState.Created;
}

public class QueuedActionContext
{
    public required SimulatedActionRequest Request { get; init; }
    public required string SessionId { get; init; }
    public required ulong StopGeneration { get; init; }
    public required TaskCompletionSource<SimulatedActionResponse> CompletionSource { get; init; }
    public required CancellationToken CancellationToken { get; init; }
    public DateTimeOffset EnqueuedAt { get; init; } = DateTimeOffset.UtcNow;
}

public class ActionExecutionEngine : IDisposable
{
    private readonly ILogger<ActionExecutionEngine> _logger;
    private readonly IStateManager _stateManager;
    private readonly ActionPolicyEngine _policyEngine;
    private readonly IEvidenceRecorder? _evidenceRecorder;

    private volatile bool _isEmergencyStopped = false;
    private volatile bool _panicHotkeyAvailable = false;
    private string _panicHotkeyUnavailableReason = "Panic hotkey registration pending or not confirmed by HUD.";
    private ulong _stopGeneration = 1;
    private CancellationTokenSource _emergencyStopCts = new();
    private readonly object _stateLock = new();

    private readonly ConcurrentDictionary<string, ActiveActionContext> _activeActions = new();
    private readonly BoundedStopCache _processedStops = new(256);
    private readonly LinkedList<QueuedActionContext> _queuedActions = new();
    private readonly object _queueLock = new();
    private readonly SemaphoreSlim _queueSignal = new(0);
    private readonly SemaphoreSlim _concurrencySemaphore;
    private readonly CancellationTokenSource _workerCts = new();
    private readonly Task _queueWorkerTask;
    private readonly int _maxQueueCapacity;
    private readonly int _maxConcurrency;

    public const int MaxQueueCapacityDefault = 100;
    public const int MaxConcurrencyDefault = 2;

    public bool IsEmergencyStopped => _isEmergencyStopped;
    public bool IsPanicHotkeyAvailable => _panicHotkeyAvailable;
    public ulong CurrentStopGeneration => _stopGeneration;
    public int ActiveActionCount => _activeActions.Count;
    public IReadOnlyCollection<string> ActiveActionsSnapshot => _activeActions.Keys.ToArray();
    public int QueuedActionCount
    {
        get
        {
            lock (_queueLock)
            {
                return _queuedActions.Count;
            }
        }
    }
    public int MaxQueueCapacity => _maxQueueCapacity;
    public int MaxConcurrency => _maxConcurrency;
    public BoundedStopCache ProcessedStopsCache => _processedStops;

    public event EventHandler<ActionLifecycleNotification>? ActionLifecycleChanged;

    /// <summary>Raised on every Emergency Stop (with the active generation), so other subsystems can stop too. Handlers must not block.</summary>
    public event EventHandler<ulong>? EmergencyStopActivated;

    /// <summary>Raised after a validated resume, with the generation that was resumed. Handlers must not block.</summary>
    public event EventHandler<ulong>? ExecutionResumed;

    public ActionExecutionEngine(
        ILogger<ActionExecutionEngine> logger,
        IStateManager stateManager,
        ActionPolicyEngine policyEngine,
        IEvidenceRecorder? evidenceRecorder = null,
        int maxQueueCapacity = MaxQueueCapacityDefault,
        int maxConcurrency = MaxConcurrencyDefault)
    {
        _logger = logger;
        _stateManager = stateManager;
        _policyEngine = policyEngine;
        _evidenceRecorder = evidenceRecorder;
        _maxQueueCapacity = maxQueueCapacity > 0 ? maxQueueCapacity : MaxQueueCapacityDefault;
        _maxConcurrency = maxConcurrency > 0 ? maxConcurrency : MaxConcurrencyDefault;
        _concurrencySemaphore = new SemaphoreSlim(_maxConcurrency, _maxConcurrency);
        _queueWorkerTask = Task.Run(ProcessQueueLoopAsync);
    }

    private volatile Func<string, bool>? _isSessionLive;

    /// <summary>
    /// Installs the HUD liveness check (Phase 7B.1a). Once installed, no action is admitted for a session whose HUD
    /// liveness lease is not valid. The pipe server installs it in production; engine unit tests may leave it unset.
    /// </summary>
    public void SetSessionLivenessGate(Func<string, bool> isSessionLive) => _isSessionLive = isSessionLive;

    private bool IsSessionLive(string sessionId)
    {
        var gate = _isSessionLive;
        if (gate == null) return true;
        try { return gate(sessionId); }
        catch { return false; } // fail closed
    }

    public void SetPanicHotkeyStatus(bool isAvailable, string reason, int errorCode = 0)
    {
        lock (_stateLock)
        {
            _panicHotkeyAvailable = isAvailable;
            _panicHotkeyUnavailableReason = reason;
        }

        if (!isAvailable)
        {
            _logger.LogError("[SAFETY LATCH] Global Panic Hotkey UNAVAILABLE (Error={Code}): {Reason}. Fail-closed: Computer-use action admission DISABLED.",
                errorCode, reason);

            if (_evidenceRecorder != null)
            {
                _ = _evidenceRecorder.RecordSafetyAuditAsync(new SafetyAuditRecord
                {
                    EventType = "PanicHotkeyUnavailable",
                    Source = "ActionExecutionEngine",
                    StopGeneration = _stopGeneration,
                    Decision = "FailClosedBlocked",
                    Reason = reason,
                    DetailsJson = AuditJson.Details(new { errorCode })
                });
            }
        }
        else
        {
            _logger.LogInformation("[SAFETY LATCH] Global Panic Hotkey registered and active.");
        }
    }

    public async Task<EmergencyStopResponse> TriggerEmergencyStopAsync(
        string source,
        string reason,
        string? stopId = null,
        string? sessionId = null)
    {
        var sw = Stopwatch.StartNew();
        stopId ??= Guid.NewGuid().ToString("N");

        // Idempotency: Return existing response for duplicate stopId without advancing epoch
        if (_processedStops.TryGet(stopId, out var existing))
        {
            _logger.LogInformation("[EMERGENCY STOP] Duplicate stop request '{StopId}' from '{Source}' ignored (Idempotent). Returning existing response.",
                stopId, source);
            return existing;
        }

        int activeCancelled = 0;
        int queuedCancelled = 0;
        ulong stopGen;
        ActiveActionContext[] activeAtStop;

        lock (_stateLock)
        {
            if (_processedStops.TryGet(stopId, out var existingUnderLock))
            {
                return existingUnderLock;
            }

            bool wasStopped = _isEmergencyStopped;
            _isEmergencyStopped = true;
            if (!wasStopped)
            {
                _stopGeneration++;
            }
            stopGen = _stopGeneration;

            // Taken before the shared token is cancelled. Actions register and unregister under this lock,
            // but once the token fires an action can finish and unregister as soon as the lock is released,
            // so counting afterwards under-reports what this stop actually cancelled.
            activeAtStop = _activeActions.Values.Where(a => a.State == ActionLifecycleState.Executing).ToArray();

            try
            {
                _emergencyStopCts.Cancel();
            }
            catch { }
            _emergencyStopCts.Dispose();
            _emergencyStopCts = new CancellationTokenSource();
        }

        try { EmergencyStopActivated?.Invoke(this, stopGen); }
        catch (Exception ex) { _logger.LogError(ex, "[EMERGENCY STOP] A stop subscriber failed."); }

        _logger.LogWarning("[EMERGENCY STOP] Triggered from source '{Source}' (StopId: {StopId}, New Epoch={Gen}): {Reason}",
            source, stopId, stopGen, reason);

        // Invalidate all pending and granted approvals
        _policyEngine.InvalidateAllPendingAndGrantedApprovals($"Emergency stop triggered from {source}: {reason}");

        // Drain and cancel all queued actions atomically under _queueLock
        List<QueuedActionContext> queuedToCancel;
        lock (_queueLock)
        {
            queuedToCancel = _queuedActions.ToList();
            _queuedActions.Clear();
        }

        foreach (var queued in queuedToCancel)
        {
            queuedCancelled++;
            EmitLifecycleNotification(queued.Request.ActionId, queued.Request.ActionType, ActionLifecycleState.Created.ToString(), ActionLifecycleState.Cancelled.ToString(), "Emergency stop triggered", queued.SessionId, stopGen);
            queued.CompletionSource.TrySetResult(new SimulatedActionResponse
            {
                ActionId = queued.Request.ActionId,
                Success = false,
                Status = ActionLifecycleState.Cancelled.ToString(),
                ErrorMessage = $"Action cancelled: Emergency stop triggered from {source}.",
                ExecutionDurationMs = 0,
                Timestamp = DateTimeOffset.UtcNow
            });
        }

        // Cancel all active in-flight actions
        foreach (var active in activeAtStop)
        {
            activeCancelled++;
            try
            {
                // Throws ObjectDisposedException when the action already finished cancelling on the shared token.
                active.Cts.Cancel();
                active.State = ActionLifecycleState.Cancelled;
                EmitLifecycleNotification(active.ActionId, active.ActionType, ActionLifecycleState.Executing.ToString(), ActionLifecycleState.Cancelled.ToString(), "Emergency stop triggered", active.SessionId, stopGen);
            }
            catch { }
        }

        // Update daemon state
        _stateManager.SetStatus("Idle", "EmergencyStop");

        // Record safety audit
        if (_evidenceRecorder != null)
        {
            try
            {
                await _evidenceRecorder.RecordSafetyAuditAsync(new SafetyAuditRecord
                {
                    EventType = "EmergencyStop",
                    Source = source,
                    StopGeneration = stopGen,
                    Decision = "Stopped",
                    Reason = reason,
                    DetailsJson = AuditJson.Details(new { activeCancelled, queuedCancelled, durationMs = Math.Round(sw.Elapsed.TotalMilliseconds, 3) })
                });
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[SafetyAudit] Failed to log EmergencyStop audit record.");
            }
        }

        _logger.LogInformation("[EMERGENCY STOP] Completed in {ElapsedMs:F2} ms. Active cancelled: {Active}, Queued cancelled: {Queued}, Generation: {Gen}",
            sw.Elapsed.TotalMilliseconds, activeCancelled, queuedCancelled, stopGen);

        var response = new EmergencyStopResponse
        {
            StopId = stopId,
            Success = true,
            ActiveActionsCancelled = activeCancelled,
            QueuedActionsCancelled = queuedCancelled,
            StopGeneration = stopGen,
            SessionId = sessionId ?? string.Empty,
            Timestamp = DateTimeOffset.UtcNow
        };

        _processedStops.AddOrUpdate(stopId, response);
        return response;
    }

    public async Task<bool> DrainActiveTasksAsync(TimeSpan timeout)
    {
        Task[] tasks;
        lock (_stateLock)
        {
            tasks = _activeActions.Values.Select(a => a.CompletionTcs.Task).ToArray();
            if (tasks.Length == 0) return true;
        }

        using var delayCts = new CancellationTokenSource();
        var delayTask = Task.Delay(timeout, delayCts.Token);
        var whenAllTask = Task.WhenAll(tasks);
        var completedTask = await Task.WhenAny(whenAllTask, delayTask);
        if (completedTask == delayTask)
        {
            return false;
        }

        // Cancel the delay task to release timer resources promptly
        delayCts.Cancel();

        try
        {
            await whenAllTask;
        }
        catch
        {
            // Expected during task cancellation
        }

        return true;
    }

    /// <summary>
    /// The ONLY code path that clears the emergency-stop latch.
    ///
    /// Invariant (H3-8): a Resume must name the exact, currently active Stop generation.
    /// A generation of 0 (also what a missing wire field deserializes to), a stale generation and a
    /// future generation are all rejected, whether or not execution is currently stopped. There is no
    /// "unbound" overload: callers must pass a generation.
    /// </summary>
    /// <param name="stopGeneration">The Stop generation the caller was told about. 0 is never valid.</param>
    public async Task<ResumeExecutionResponse> ResumeExecutionAsync(
        string source,
        string reason,
        ulong stopGeneration,
        string? resumeId = null,
        string? sessionId = null,
        TimeSpan? drainTimeout = null)
    {
        resumeId ??= Guid.NewGuid().ToString("N");

        // 0. Fail fast, BEFORE the drain: an invalid request must neither wait for in-flight actions to
        //    unwind nor be answered with idempotent success. This pre-check is advisory (it can race with
        //    a new Stop); the authoritative check is repeated under _stateLock below.
        ulong activeGeneration;
        lock (_stateLock)
        {
            activeGeneration = _stopGeneration;
        }

        var invalid = ValidateResumeGeneration(stopGeneration, activeGeneration, resumeId, sessionId);
        if (invalid != null)
        {
            return invalid;
        }

        // 1. Drain active tasks to ensure previous-generation tasks have completely finished unwinding
        var timeout = drainTimeout ?? TimeSpan.FromSeconds(5);
        bool drained = await DrainActiveTasksAsync(timeout);
        if (!drained)
        {
            _logger.LogError("[RESUME REJECTED] Cannot resume: Previous-generation tasks did not finish unwinding within timeout.");
            return new ResumeExecutionResponse
            {
                ResumeId = resumeId,
                Success = false,
                SessionId = sessionId ?? string.Empty,
                StopGeneration = _stopGeneration,
                ErrorMessage = "Cannot resume: Previous-generation actions are still completing cancellation.",
                Timestamp = DateTimeOffset.UtcNow
            };
        }

        ulong resumeGen;
        lock (_stateLock)
        {
            // 2. Authoritative generation check, atomic with the latch transition below. A Stop that
            //    arrived during the drain has already advanced _stopGeneration under this same lock,
            //    so an older Resume can no longer match.
            var stale = ValidateResumeGeneration(stopGeneration, _stopGeneration, resumeId, sessionId);
            if (stale != null)
            {
                return stale;
            }

            // 3. Idempotent success: reachable only with the exact current generation.
            if (!_isEmergencyStopped)
            {
                _logger.LogInformation("[RESUME] Resume requested, but execution is not stopped. Idempotent success.");
                return new ResumeExecutionResponse
                {
                    ResumeId = resumeId,
                    Success = true,
                    SessionId = sessionId ?? string.Empty,
                    StopGeneration = _stopGeneration,
                    Timestamp = DateTimeOffset.UtcNow
                };
            }

            if (_activeActions.Count > 0)
            {
                return new ResumeExecutionResponse
                {
                    ResumeId = resumeId,
                    Success = false,
                    SessionId = sessionId ?? string.Empty,
                    StopGeneration = _stopGeneration,
                    ErrorMessage = "Cannot resume: In-flight actions remain active.",
                    Timestamp = DateTimeOffset.UtcNow
                };
            }

            _isEmergencyStopped = false;
            resumeGen = _stopGeneration;
        }

        try { ExecutionResumed?.Invoke(this, resumeGen); }
        catch (Exception ex) { _logger.LogError(ex, "[RESUME] A resume subscriber failed."); }

        _logger.LogInformation("[RESUME] Execution resumed by user explicit confirmation from source '{Source}': {Reason} (Epoch={Gen})",
            source, reason, resumeGen);

        _stateManager.SetStatus("Idle", "Normal");

        if (_evidenceRecorder != null)
        {
            try
            {
                await _evidenceRecorder.RecordSafetyAuditAsync(new SafetyAuditRecord
                {
                    EventType = "ExecutionResumed",
                    Source = source,
                    StopGeneration = resumeGen,
                    Decision = "Resumed",
                    Reason = reason
                });
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[SafetyAudit] Failed to log ExecutionResumed audit record.");
            }
        }

        return new ResumeExecutionResponse
        {
            ResumeId = resumeId,
            Success = true,
            SessionId = sessionId ?? string.Empty,
            StopGeneration = resumeGen,
            Timestamp = DateTimeOffset.UtcNow
        };
    }

    /// <summary>Returns a fail-closed rejection when <paramref name="requested"/> is not exactly <paramref name="active"/>; null when valid.</summary>
    private ResumeExecutionResponse? ValidateResumeGeneration(ulong requested, ulong active, string resumeId, string? sessionId)
    {
        string? error = null;
        if (requested == 0)
        {
            error = $"Missing or zero stop generation: a Resume must name the active stop generation ({active}).";
        }
        else if (requested != active)
        {
            error = $"Generation mismatch: expected {requested}, but active stop generation is {active}.";
        }

        if (error == null)
        {
            return null;
        }

        _logger.LogWarning("[RESUME REJECTED] {Error}", error);
        return new ResumeExecutionResponse
        {
            ResumeId = resumeId,
            Success = false,
            SessionId = sessionId ?? string.Empty,
            StopGeneration = active,
            ErrorMessage = error,
            Timestamp = DateTimeOffset.UtcNow
        };
    }

    public async Task<SimulatedActionResponse> ExecuteSimulatedActionAsync(
        SimulatedActionRequest request,
        string sessionId,
        CancellationToken cancellationToken = default)
    {
        var sw = Stopwatch.StartNew();

        // 1. Fast-path check: Is Emergency Stop active?
        if (_isEmergencyStopped)
        {
            _logger.LogWarning("[ExecutionEngine] Blocked action {ActionId} ({ActionType}): Emergency Stop is active.",
                request.ActionId, request.ActionType);

            EmitLifecycleNotification(request.ActionId, request.ActionType, ActionLifecycleState.Created.ToString(), ActionLifecycleState.Blocked.ToString(), "Emergency stop is active", sessionId, _stopGeneration);

            return new SimulatedActionResponse
            {
                ActionId = request.ActionId,
                Success = false,
                Status = ActionLifecycleState.Blocked.ToString(),
                ErrorMessage = "Action blocked: Emergency Stop is active.",
                ExecutionDurationMs = sw.Elapsed.TotalMilliseconds,
                Timestamp = DateTimeOffset.UtcNow
            };
        }

        // 2a. Phase 7B.1a: the requesting session must hold a valid HUD liveness lease.
        if (!IsSessionLive(sessionId))
        {
            _logger.LogError("[ExecutionEngine] Blocked action {ActionId}: the requesting HUD session has no valid liveness lease.", request.ActionId);
            EmitLifecycleNotification(request.ActionId, request.ActionType, ActionLifecycleState.Created.ToString(), ActionLifecycleState.Blocked.ToString(), "HUD liveness not established", sessionId, _stopGeneration);
            return new SimulatedActionResponse
            {
                ActionId = request.ActionId,
                Success = false,
                Status = ActionLifecycleState.Blocked.ToString(),
                ErrorMessage = "Action blocked: the HUD has no valid liveness lease (heartbeat and panic hotkey not confirmed).",
                ExecutionDurationMs = sw.Elapsed.TotalMilliseconds,
                Timestamp = DateTimeOffset.UtcNow
            };
        }

        // 2. Fast-path check: Is Panic Hotkey available?
        if (!_panicHotkeyAvailable)
        {
            _logger.LogError("[ExecutionEngine] Blocked action {ActionId}: Global panic hotkey is unavailable.", request.ActionId);
            EmitLifecycleNotification(request.ActionId, request.ActionType, ActionLifecycleState.Created.ToString(), ActionLifecycleState.Blocked.ToString(), "Panic hotkey unavailable", sessionId, _stopGeneration);
            return new SimulatedActionResponse
            {
                ActionId = request.ActionId,
                Success = false,
                Status = ActionLifecycleState.Blocked.ToString(),
                ErrorMessage = $"Action blocked: Emergency panic hotkey is unavailable ({_panicHotkeyUnavailableReason}).",
                ExecutionDurationMs = sw.Elapsed.TotalMilliseconds,
                Timestamp = DateTimeOffset.UtcNow
            };
        }

        // 3. Queue insertion under _queueLock
        var tcs = new TaskCompletionSource<SimulatedActionResponse>(TaskCreationOptions.RunContinuationsAsynchronously);

        lock (_queueLock)
        {
            if (_isEmergencyStopped)
            {
                return new SimulatedActionResponse
                {
                    ActionId = request.ActionId,
                    Success = false,
                    Status = ActionLifecycleState.Blocked.ToString(),
                    ErrorMessage = "Action blocked: Emergency Stop is active.",
                    ExecutionDurationMs = sw.Elapsed.TotalMilliseconds,
                    Timestamp = DateTimeOffset.UtcNow
                };
            }

            if (!_panicHotkeyAvailable)
            {
                return new SimulatedActionResponse
                {
                    ActionId = request.ActionId,
                    Success = false,
                    Status = ActionLifecycleState.Blocked.ToString(),
                    ErrorMessage = $"Action blocked: Emergency panic hotkey is unavailable ({_panicHotkeyUnavailableReason}).",
                    ExecutionDurationMs = sw.Elapsed.TotalMilliseconds,
                    Timestamp = DateTimeOffset.UtcNow
                };
            }

            if (_queuedActions.Count >= _maxQueueCapacity)
            {
                _logger.LogError("[ExecutionEngine] Action queue saturated ({Count}/{Max}). Rejecting action {ActionId}.",
                    _queuedActions.Count, _maxQueueCapacity, request.ActionId);

                return new SimulatedActionResponse
                {
                    ActionId = request.ActionId,
                    Success = false,
                    Status = ActionLifecycleState.Blocked.ToString(),
                    ErrorMessage = "Action queue saturated. Request rejected.",
                    ExecutionDurationMs = sw.Elapsed.TotalMilliseconds,
                    Timestamp = DateTimeOffset.UtcNow
                };
            }

            var queued = new QueuedActionContext
            {
                Request = request,
                SessionId = sessionId,
                StopGeneration = _stopGeneration,
                CompletionSource = tcs,
                CancellationToken = cancellationToken
            };

            _queuedActions.AddLast(queued);
        }

        _queueSignal.Release();

        // 4. Handle cancellation while waiting in queue or during execution
        using var reg = cancellationToken.Register(() =>
        {
            tcs.TrySetResult(new SimulatedActionResponse
            {
                ActionId = request.ActionId,
                Success = false,
                Status = ActionLifecycleState.Cancelled.ToString(),
                ErrorMessage = "Action was cancelled.",
                ExecutionDurationMs = sw.Elapsed.TotalMilliseconds,
                Timestamp = DateTimeOffset.UtcNow
            });
        });

        return await tcs.Task;
    }

    private async Task ProcessQueueLoopAsync()
    {
        while (!_workerCts.Token.IsCancellationRequested)
        {
            try
            {
                await _queueSignal.WaitAsync(_workerCts.Token);
            }
            catch (OperationCanceledException)
            {
                break;
            }

            try
            {
                await _concurrencySemaphore.WaitAsync(_workerCts.Token);
            }
            catch (OperationCanceledException)
            {
                break;
            }

            QueuedActionContext? item = null;
            lock (_queueLock)
            {
                if (_queuedActions.Count > 0)
                {
                    item = _queuedActions.First!.Value;
                    _queuedActions.RemoveFirst();
                }
            }

            if (item == null)
            {
                _concurrencySemaphore.Release();
                continue;
            }

            _ = ExecuteDispatchedActionAsync(item);
        }
    }

    private async Task ExecuteDispatchedActionAsync(QueuedActionContext item)
    {
        try
        {
            await DispatchQueuedActionAsync(item);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[ExecutionEngine] Unhandled exception in queue dispatcher for action {ActionId}", item.Request.ActionId);
            item.CompletionSource.TrySetResult(new SimulatedActionResponse
            {
                ActionId = item.Request.ActionId,
                Success = false,
                Status = ActionLifecycleState.Failed.ToString(),
                ErrorMessage = ex.Message,
                Timestamp = DateTimeOffset.UtcNow
            });
        }
        finally
        {
            _concurrencySemaphore.Release();
        }
    }

    private async Task DispatchQueuedActionAsync(QueuedActionContext item)
    {
        var sw = Stopwatch.StartNew();

        // Check if caller already cancelled while waiting in queue
        if (item.CancellationToken.IsCancellationRequested)
        {
            item.CompletionSource.TrySetResult(new SimulatedActionResponse
            {
                ActionId = item.Request.ActionId,
                Success = false,
                Status = ActionLifecycleState.Cancelled.ToString(),
                ErrorMessage = "Action was cancelled before execution.",
                ExecutionDurationMs = sw.Elapsed.TotalMilliseconds,
                Timestamp = DateTimeOffset.UtcNow
            });
            return;
        }

        CancellationToken stopToken;
        ulong currentEpoch;
        CancellationTokenSource actionCts;
        ActiveActionContext context;

        // Authoritative Atomic Final Authorization Point under _stateLock
        lock (_stateLock)
        {
            // 1. Fail-closed emergency stop check
            if (_isEmergencyStopped)
            {
                _logger.LogWarning("[ExecutionEngine] Blocked action {ActionId} ({ActionType}): Emergency Stop is active.",
                    item.Request.ActionId, item.Request.ActionType);
                EmitLifecycleNotification(item.Request.ActionId, item.Request.ActionType, ActionLifecycleState.Created.ToString(), ActionLifecycleState.Blocked.ToString(), "Emergency stop is active", item.SessionId, _stopGeneration);
                item.CompletionSource.TrySetResult(new SimulatedActionResponse
                {
                    ActionId = item.Request.ActionId,
                    Success = false,
                    Status = ActionLifecycleState.Blocked.ToString(),
                    ErrorMessage = "Action blocked: Emergency Stop is active.",
                    ExecutionDurationMs = sw.Elapsed.TotalMilliseconds,
                    Timestamp = DateTimeOffset.UtcNow
                });
                return;
            }

            // 2. Fail-closed panic hotkey availability check
            if (!_panicHotkeyAvailable)
            {
                _logger.LogError("[ExecutionEngine] Blocked action {ActionId}: Global panic hotkey is unavailable.", item.Request.ActionId);
                EmitLifecycleNotification(item.Request.ActionId, item.Request.ActionType, ActionLifecycleState.Created.ToString(), ActionLifecycleState.Blocked.ToString(), "Panic hotkey unavailable", item.SessionId, _stopGeneration);
                item.CompletionSource.TrySetResult(new SimulatedActionResponse
                {
                    ActionId = item.Request.ActionId,
                    Success = false,
                    Status = ActionLifecycleState.Blocked.ToString(),
                    ErrorMessage = $"Action blocked: Emergency panic hotkey is unavailable ({_panicHotkeyUnavailableReason}).",
                    ExecutionDurationMs = sw.Elapsed.TotalMilliseconds,
                    Timestamp = DateTimeOffset.UtcNow
                });
                return;
            }

            // 2a. Phase 7B.1a: the session's HUD liveness lease is re-checked at the authoritative point.
            if (!IsSessionLive(item.SessionId))
            {
                _logger.LogError("[ExecutionEngine] Blocked action {ActionId}: HUD liveness lease lost before execution.", item.Request.ActionId);
                EmitLifecycleNotification(item.Request.ActionId, item.Request.ActionType, ActionLifecycleState.Created.ToString(), ActionLifecycleState.Blocked.ToString(), "HUD liveness lost", item.SessionId, _stopGeneration);
                item.CompletionSource.TrySetResult(new SimulatedActionResponse
                {
                    ActionId = item.Request.ActionId,
                    Success = false,
                    Status = ActionLifecycleState.Blocked.ToString(),
                    ErrorMessage = "Action blocked: the HUD liveness lease was lost before execution.",
                    ExecutionDurationMs = sw.Elapsed.TotalMilliseconds,
                    Timestamp = DateTimeOffset.UtcNow
                });
                return;
            }

            // 3. Stop Generation epoch check: ensures action cannot execute across an epoch change
            if (item.StopGeneration != _stopGeneration)
            {
                _logger.LogError("[ExecutionEngine SECURITY] Blocked action {ActionId}: Enqueued at epoch {EnqueueEpoch}, current epoch is {CurrentEpoch}.",
                    item.Request.ActionId, item.StopGeneration, _stopGeneration);
                EmitLifecycleNotification(item.Request.ActionId, item.Request.ActionType, ActionLifecycleState.Created.ToString(), ActionLifecycleState.Blocked.ToString(), "Stale execution epoch", item.SessionId, _stopGeneration);
                item.CompletionSource.TrySetResult(new SimulatedActionResponse
                {
                    ActionId = item.Request.ActionId,
                    Success = false,
                    Status = ActionLifecycleState.Blocked.ToString(),
                    ErrorMessage = $"Action blocked: Enqueued during previous execution epoch ({item.StopGeneration} != {_stopGeneration}).",
                    ExecutionDurationMs = sw.Elapsed.TotalMilliseconds,
                    Timestamp = DateTimeOffset.UtcNow
                });
                return;
            }

            // 4. Policy evaluation
            var (isAllowed, riskLevel, reason) = _policyEngine.EvaluatePolicy(
                item.Request.ActionType,
                item.Request.Parameters,
                item.Request.TargetProcessName);

            if (!isAllowed)
            {
                if (string.IsNullOrEmpty(item.Request.ApprovalId))
                {
                    _logger.LogWarning("[ExecutionEngine] Blocked action {ActionId} ({ActionType}): Requires explicit user approval ({Reason}).",
                        item.Request.ActionId, item.Request.ActionType, reason);
                    EmitLifecycleNotification(item.Request.ActionId, item.Request.ActionType, ActionLifecycleState.Created.ToString(), ActionLifecycleState.Blocked.ToString(), reason ?? "Approval required", item.SessionId, _stopGeneration);
                    item.CompletionSource.TrySetResult(new SimulatedActionResponse
                    {
                        ActionId = item.Request.ActionId,
                        Success = false,
                        Status = ActionLifecycleState.Blocked.ToString(),
                        ErrorMessage = $"Action blocked: {reason ?? "User approval required."}",
                        ExecutionDurationMs = sw.Elapsed.TotalMilliseconds,
                        Timestamp = DateTimeOffset.UtcNow
                    });
                    return;
                }

                // Validate provided approval token against authoritative registry ATOMICALLY under _stateLock
                var (isValid, approvalError) = _policyEngine.ValidateConsumedApproval(
                    item.Request.ApprovalId,
                    item.Request.ActionId,
                    item.Request.ActionType,
                    item.Request.Parameters,
                    item.Request.TargetProcessName,
                    item.Request.TargetHwnd,
                    item.Request.TargetProcessId,
                    item.Request.TargetProcessCreationTime,
                    item.SessionId,
                    _stopGeneration,
                    _isEmergencyStopped);

                if (!isValid)
                {
                    _logger.LogError("[ExecutionEngine SECURITY] Blocked action {ActionId} due to invalid approval token: {Error}",
                        item.Request.ActionId, approvalError);
                    EmitLifecycleNotification(item.Request.ActionId, item.Request.ActionType, ActionLifecycleState.Created.ToString(), ActionLifecycleState.Blocked.ToString(), approvalError, item.SessionId, _stopGeneration);
                    item.CompletionSource.TrySetResult(new SimulatedActionResponse
                    {
                        ActionId = item.Request.ActionId,
                        Success = false,
                        Status = ActionLifecycleState.Blocked.ToString(),
                        ErrorMessage = $"Action blocked: {approvalError}",
                        ExecutionDurationMs = sw.Elapsed.TotalMilliseconds,
                        Timestamp = DateTimeOffset.UtcNow
                    });
                    return;
                }
            }

            // 5. Register in-flight action atomically under _stateLock
            currentEpoch = _stopGeneration;
            stopToken = _emergencyStopCts.Token;
            actionCts = new CancellationTokenSource();

            context = new ActiveActionContext
            {
                ActionId = item.Request.ActionId,
                SessionId = item.SessionId,
                ActionType = item.Request.ActionType,
                StopGeneration = currentEpoch,
                CreatedAt = DateTimeOffset.UtcNow,
                Cts = actionCts,
                State = ActionLifecycleState.Executing
            };

            if (!_activeActions.TryAdd(item.Request.ActionId, context))
            {
                actionCts.Dispose();
                item.CompletionSource.TrySetResult(new SimulatedActionResponse
                {
                    ActionId = item.Request.ActionId,
                    Success = false,
                    Status = ActionLifecycleState.Blocked.ToString(),
                    ErrorMessage = "Action ID collision.",
                    ExecutionDurationMs = sw.Elapsed.TotalMilliseconds,
                    Timestamp = DateTimeOffset.UtcNow
                });
                return;
            }

            EmitLifecycleNotification(item.Request.ActionId, item.Request.ActionType, ActionLifecycleState.Created.ToString(), ActionLifecycleState.Executing.ToString(), "Execution started", item.SessionId, currentEpoch);
        }

        // 6. Execution OUTSIDE _stateLock (Never hold a global state lock while awaiting execution)
        CancellationTokenSource? linkedCts = null;
        SimulatedActionResponse? finalResponse = null;
        bool completionSuccess = false;
        Exception? completionException = null;

        try
        {
            linkedCts = CancellationTokenSource.CreateLinkedTokenSource(stopToken, item.CancellationToken, actionCts.Token);

            // STRICT SAFETY: Simulated action execution ONLY. ZERO SendInput.
            int duration = Math.Clamp(item.Request.SimulatedDurationMs, 0, 30000);
            if (duration > 0)
            {
                await Task.Delay(duration, linkedCts.Token);
            }

            context.State = ActionLifecycleState.Completed;
            EmitLifecycleNotification(item.Request.ActionId, item.Request.ActionType, ActionLifecycleState.Executing.ToString(), ActionLifecycleState.Completed.ToString(), "Simulation completed successfully", item.SessionId, currentEpoch);

            finalResponse = new SimulatedActionResponse
            {
                ActionId = item.Request.ActionId,
                Success = true,
                Status = ActionLifecycleState.Completed.ToString(),
                ExecutionDurationMs = sw.Elapsed.TotalMilliseconds,
                Timestamp = DateTimeOffset.UtcNow
            };
            completionSuccess = true;
        }
        catch (OperationCanceledException)
        {
            context.State = ActionLifecycleState.Cancelled;
            EmitLifecycleNotification(item.Request.ActionId, item.Request.ActionType, ActionLifecycleState.Executing.ToString(), ActionLifecycleState.Cancelled.ToString(), "Simulation cancelled", item.SessionId, currentEpoch);

            finalResponse = new SimulatedActionResponse
            {
                ActionId = item.Request.ActionId,
                Success = false,
                Status = ActionLifecycleState.Cancelled.ToString(),
                ErrorMessage = "Action was cancelled.",
                ExecutionDurationMs = sw.Elapsed.TotalMilliseconds,
                Timestamp = DateTimeOffset.UtcNow
            };
            completionSuccess = false;
        }
        catch (Exception ex)
        {
            context.State = ActionLifecycleState.Failed;
            EmitLifecycleNotification(item.Request.ActionId, item.Request.ActionType, ActionLifecycleState.Executing.ToString(), ActionLifecycleState.Failed.ToString(), ex.Message, item.SessionId, currentEpoch);

            finalResponse = new SimulatedActionResponse
            {
                ActionId = item.Request.ActionId,
                Success = false,
                Status = ActionLifecycleState.Failed.ToString(),
                ErrorMessage = ex.Message,
                ExecutionDurationMs = sw.Elapsed.TotalMilliseconds,
                Timestamp = DateTimeOffset.UtcNow
            };
            completionSuccess = false;
            completionException = ex;
        }
        finally
        {
            // 1. Explicitly dispose cancellation resources in strict dependency order:
            // linkedCts first (to unregister callbacks on parent tokens stopToken, item.CancellationToken, actionCts.Token)
            try
            {
                linkedCts?.Dispose();
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[ExecutionEngine] Exception disposing linkedCts for {ActionId}", item.Request.ActionId);
            }

            // actionCts second
            try
            {
                actionCts.Dispose();
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[ExecutionEngine] Exception disposing actionCts for {ActionId}", item.Request.ActionId);
            }

            finalResponse ??= new SimulatedActionResponse
            {
                ActionId = item.Request.ActionId,
                Success = false,
                Status = ActionLifecycleState.Failed.ToString(),
                ErrorMessage = completionException?.Message ?? "Action terminated unexpectedly.",
                ExecutionDurationMs = sw.Elapsed.TotalMilliseconds,
                Timestamp = DateTimeOffset.UtcNow
            };

            // 2. Atomic Finalization Protocol:
            // Under the exact same lock that snapshots _activeActions for DrainActiveTasksAsync,
            // atomically remove the action and signal CompletionTcs.
            lock (_stateLock)
            {
                _activeActions.TryRemove(item.Request.ActionId, out _);

                if (completionException != null)
                {
                    context.CompletionTcs.TrySetException(completionException);
                }
                else
                {
                    context.CompletionTcs.TrySetResult(completionSuccess);
                }
            }

            // 3. Deliver final caller response after unregistration
            item.CompletionSource.TrySetResult(finalResponse);
        }
    }

    public int CancelActionsForSession(string sessionId)
    {
        int count = 0;

        // 1. Drain and cancel queued actions for this session
        List<QueuedActionContext> queuedToCancel = new();
        lock (_queueLock)
        {
            var node = _queuedActions.First;
            while (node != null)
            {
                var next = node.Next;
                if (node.Value.SessionId == sessionId)
                {
                    queuedToCancel.Add(node.Value);
                    _queuedActions.Remove(node);
                }
                node = next;
            }
        }

        foreach (var queued in queuedToCancel)
        {
            count++;
            EmitLifecycleNotification(queued.Request.ActionId, queued.Request.ActionType, ActionLifecycleState.Created.ToString(), ActionLifecycleState.Cancelled.ToString(), "Client disconnected (Fail-closed)", sessionId, queued.StopGeneration);
            queued.CompletionSource.TrySetResult(new SimulatedActionResponse
            {
                ActionId = queued.Request.ActionId,
                Success = false,
                Status = ActionLifecycleState.Cancelled.ToString(),
                ErrorMessage = "Action cancelled: Client session disconnected.",
                ExecutionDurationMs = 0,
                Timestamp = DateTimeOffset.UtcNow
            });
        }

        // 2. Request cancellation of active actions for this session without removing from _activeActions
        foreach (var kvp in _activeActions)
        {
            var active = kvp.Value;
            if (active.SessionId == sessionId)
            {
                count++;
                try
                {
                    active.Cts.Cancel();
                    active.State = ActionLifecycleState.Cancelled;
                    EmitLifecycleNotification(active.ActionId, active.ActionType, ActionLifecycleState.Executing.ToString(), ActionLifecycleState.Cancelled.ToString(), "Client disconnected (Fail-closed)", sessionId, active.StopGeneration);
                }
                catch { }
            }
        }

        if (count > 0)
        {
            _logger.LogWarning("[ExecutionEngine] Cancelled {Count} queued/in-flight actions for disconnected session {SessionId} (Fail-closed).",
                count, sessionId);
        }
        return count;
    }

    private void EmitLifecycleNotification(
        string actionId,
        string actionType,
        string previousState,
        string currentState,
        string? reason,
        string? sessionId = null,
        ulong stopGeneration = 0)
    {
        ActionLifecycleChanged?.Invoke(this, new ActionLifecycleNotification
        {
            ActionId = actionId,
            ActionType = actionType,
            PreviousState = previousState,
            CurrentState = currentState,
            Reason = reason,
            Timestamp = DateTimeOffset.UtcNow
        });

        if (_evidenceRecorder != null)
        {
            try
            {
                _ = _evidenceRecorder.RecordSafetyAuditAsync(new SafetyAuditRecord
                {
                    EventType = $"Action_{currentState}",
                    Source = "ActionExecutionEngine",
                    ActionId = AuditJson.Bound(actionId, 128),
                    SessionId = sessionId,
                    StopGeneration = stopGeneration > 0 ? stopGeneration : _stopGeneration,
                    Decision = currentState,
                    Reason = AuditJson.Bound(reason, 1024),
                    // Serializer-built (Phase 7B.1a, F5): a caller-supplied action type can no longer change the JSON.
                    DetailsJson = AuditJson.Details(new { actionType = AuditJson.Bound(actionType), previousState = AuditJson.Bound(previousState) })
                });
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "[SafetyAudit] Failed to log lifecycle notification event.");
            }
        }
    }

    public void Dispose()
    {
        try
        {
            _workerCts.Cancel();
            _queueSignal.Release();
            _concurrencySemaphore.Release();
        }
        catch { }

        try { _workerCts.Dispose(); } catch { }
        try { _queueSignal.Dispose(); } catch { }
        try { _concurrencySemaphore.Dispose(); } catch { }
        try { _emergencyStopCts.Dispose(); } catch { }
    }
}

/// <summary>
/// Thread-safe bounded LRU deduplication cache for emergency stop responses.
/// Prevents memory leaks under prolonged execution while maintaining idempotency within capacity.
/// </summary>
public sealed class BoundedStopCache
{
    private readonly int _capacity;
    private readonly Dictionary<string, EmergencyStopResponse> _cache;
    private readonly LinkedList<string> _lruList;
    private readonly object _lock = new();

    public BoundedStopCache(int capacity = 256)
    {
        _capacity = Math.Max(16, capacity);
        _cache = new Dictionary<string, EmergencyStopResponse>(_capacity);
        _lruList = new LinkedList<string>();
    }

    public int Capacity => _capacity;

    public int Count
    {
        get { lock (_lock) return _cache.Count; }
    }

    public bool TryGet(string stopId, [System.Diagnostics.CodeAnalysis.NotNullWhen(true)] out EmergencyStopResponse? response)
    {
        lock (_lock)
        {
            if (_cache.TryGetValue(stopId, out response))
            {
                _lruList.Remove(stopId);
                _lruList.AddLast(stopId);
                return true;
            }
            return false;
        }
    }

    public void AddOrUpdate(string stopId, EmergencyStopResponse response)
    {
        lock (_lock)
        {
            if (_cache.ContainsKey(stopId))
            {
                _cache[stopId] = response;
                _lruList.Remove(stopId);
                _lruList.AddLast(stopId);
                return;
            }

            if (_cache.Count >= _capacity)
            {
                var oldest = _lruList.First;
                if (oldest != null)
                {
                    _cache.Remove(oldest.Value);
                    _lruList.RemoveFirst();
                }
            }

            _cache[stopId] = response;
            _lruList.AddLast(stopId);
        }
    }
}
