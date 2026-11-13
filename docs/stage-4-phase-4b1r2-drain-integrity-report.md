# D-ASK Stage 4 — Phase 4B-1R.2 Execution Lifecycle and Drain Integrity Report

**Date:** November 1, 2026  
**Status:** IMPLEMENTED & VERIFIED  
**Scope:** Phase 4B-1R.2 Remediation of Execution Lifecycle and Drain Integrity  
**Authorization Boundary:** STRICTLY SIMULATED ACTIONS. Zero native input injection, zero `SendInput`, zero real desktop actions. Phase 4B-2 remains unauthorized.

---

## 1. Executive Summary

In response to the Phase 4B-1R.1 independent audit findings, the three confirmed defects regarding task completion signaling order, vacuous timeout testing, and session-disconnect cancellation ownership were remediated:

1. **Deterministic Completion Signaling Order (Task 1):**
   In `DispatchQueuedActionAsync` (`ActionExecutionEngine.cs`), all premature invocations of `CompletionTcs.TrySetResult` and `TrySetException` were removed from `try`, `catch (OperationCanceledException)`, and `catch (Exception ex)` blocks. The final outcome is stored locally, and the worker's `finally` block strictly executes the correct 4-step cleanup sequence:
   - Step 1: Remove action from `_activeActions`.
   - Step 2: Dispose action-owned cancellation resources (`actionCts.Dispose()`).
   - Step 3: Deliver final caller response (`item.CompletionSource.TrySetResult(finalResponse)`).
   - Step 4: Signal `CompletionTcs` LAST (`context.CompletionTcs.TrySetResult(...)` / `TrySetException(...)`).
   `CompletionTcs` now truthfully guarantees that the action has completely unwound, unregistered itself, disposed its resources, and delivered its caller response before any drain completes.

2. **Genuinely Stalled Drain Regression Test (Task 2):**
   `Test03_ResumeExecution_DrainTimesOut_RemainsStopped` was rewritten in `ExecutionEngineCorrectnessTests.cs`. It uses a controllable test synchronization primitive (`cleanupHoldGate = new TaskCompletionSource<bool>()`) hooked into `ActionLifecycleChanged` during cancellation unwinding (`Reason == "Simulation cancelled"`). With cleanup held open, `ResumeExecutionAsync` with a 50ms drain timeout fails unconditionally. All assertions (`Assert.False(resumeResult.Success)`, `Assert.True(engine.IsEmergencyStopped)`, `Assert.Equal(1, engine.ActiveActionCount)`) are unconditional and cannot pass vacuously. Once released, a subsequent resume cleanly succeeds.

3. **Session-Disconnect Cancellation Ownership (Task 3):**
   Refactored `CancelActionsForSession` in `ActionExecutionEngine.cs`. It now exclusively requests cancellation via `active.Cts.Cancel()` without removing active actions from `_activeActions` and without disposing worker-owned cancellation tokens. The worker's `DispatchQueuedActionAsync` cleanup path remains the sole authoritative owner of unregistration and disposal. Added `Test13` and `Test14` to prove active registration persists during unwinding, resume remains blocked during unwinding, and other sessions continue unaffected.

---

## 2. Remediation Details

### 2.1 Completion Signaling Order in `DispatchQueuedActionAsync`

#### Exact Source (`src/DAsk.Daemon/Automation/Execution/ActionExecutionEngine.cs`):
```csharp
        using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(stopToken, item.CancellationToken, actionCts.Token);
        SimulatedActionResponse? finalResponse = null;
        bool completionSuccess = false;
        Exception? completionException = null;

        try
        {
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
            // 1. Remove the action from _activeActions
            _activeActions.TryRemove(item.Request.ActionId, out _);

            // 2. Dispose action-owned cancellation resources, ensuring they are no longer used by other threads
            actionCts.Dispose();

            // 3. Deliver final caller response
            finalResponse ??= new SimulatedActionResponse
            {
                ActionId = item.Request.ActionId,
                Success = false,
                Status = ActionLifecycleState.Failed.ToString(),
                ErrorMessage = completionException?.Message ?? "Action terminated unexpectedly.",
                ExecutionDurationMs = sw.Elapsed.TotalMilliseconds,
                Timestamp = DateTimeOffset.UtcNow
            };
            item.CompletionSource.TrySetResult(finalResponse);

            // 4. Signal CompletionTcs LAST
            if (completionException != null)
            {
                context.CompletionTcs.TrySetException(completionException);
            }
            else
            {
                context.CompletionTcs.TrySetResult(completionSuccess);
            }
        }
```

### 2.2 Refactored `CancelActionsForSession`

#### Exact Source (`src/DAsk.Daemon/Automation/Execution/ActionExecutionEngine.cs`):
```csharp
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
```

---

## 3. Test Verification Matrix

All 14 tests in `tests/DAsk.Daemon.Tests/ExecutionEngineCorrectnessTests.cs` passed cleanly with 100% reliability.

| Test # | Test Name | Key Verifications & Invariants | Outcome |
| :--- | :--- | :--- | :--- |
| **01** | `Test01_DrainActiveTasks_AllTasksFinish_ReturnsTrue` | Fast tasks drain within timeout; 0 active returns true immediately | **PASS** |
| **02** | `Test02_DrainActiveTasks_TaskExceedsTimeout_ReturnsFalse` | Stored `Task.Delay` detects genuine drain timeout; returns false | **PASS** |
| **03** | `Test03_ResumeExecution_DrainTimesOut_RemainsStopped` | **Rewritten:** `TaskCompletionSource` holds worker cleanup open; unconditional assertions confirm `Resume` rejected, stop state persists, active action remains registered. Subsequent resume succeeds after release. | **PASS** |
| **04** | `Test04_Queue_AcceptsWork_UpToCapacity` | Queue accepts requests up to capacity limit without blocking | **PASS** |
| **05** | `Test05_Queue_RejectsWork_BeyondCapacity` | Queue saturation returns `Blocked` ("Queue saturated. Request rejected.") | **PASS** |
| **06** | `Test06_EmergencyStop_CancelsQueuedWork` | Stop clears queue; all queued actions cancelled with `Cancelled` response | **PASS** |
| **07** | `Test07_EmergencyStop_CancelsActiveWork` | Stop cancels active action; `ActiveActionCount == 0` upon await | **PASS** |
| **08** | `Test08_Queue_DoesNotDispatch_WhileStopped` | Actions enqueued while stopped are rejected fail-closed (`Blocked`) | **PASS** |
| **09** | `Test09_Stop_BetweenApprovalValidationAndDispatch_PreventsExecution` | Atomic authorization under `_stateLock` blocks execution if stop occurs while queued | **PASS** |
| **10** | `Test10_OldGenerationApproval_CannotExecuteInNewEpoch` | Monotonic epoch protection rejects stale approval tokens across resume | **PASS** |
| **11** | `Test11_ConcurrentStopAndDispatch_NeverCreatesUnauthorizedExecution` | 20 concurrent threads racing stop vs dispatch maintain strict invariants | **PASS** |
| **12** | `Test12_SessionDisconnect_CancelsQueuedAndActiveWork` | Drains queued and active actions for disconnected session | **PASS** |
| **13** | `Test13_SessionDisconnect_ActiveActionRemainsRegisteredUntilWorkerFinishesCleanup` | **New:** Proves active action remains registered until worker completes `finally`; cancellation token not prematurely disposed; Resume cannot proceed while worker unwinds. | **PASS** |
| **14** | `Test14_SessionDisconnect_OtherSessionsContinueOperateCorrectly` | **New:** Proves session disconnect cleanly isolates cancelled session while other sessions' active and queued tasks complete normally. | **PASS** |

### Suite Test Run Summary
- **ExecutionEngineCorrectnessTests:** 14 / 14 Passed (846 ms)
- **SafetyInfrastructureTests:** 16 / 16 Passed (912 ms)
- **SafetyRemediationTests:** 13 / 13 Passed (285 ms)
- **ScreenObservationTests:** 15 / 15 Passed (6 s)

---

## 4. Safety & Boundary Compliance

- **Zero `SendInput`:** Confirmed. No native desktop input synthesis exists.
- **Strictly Simulated Actions:** All desktop actions remain simulated (`Task.Delay`).
- **No Electron / Architecture Preserved:** Rust host, Wry/WebView2, Three.js HUD, Named Pipe IPC, and UIA COM subsystem remain intact.
- **Phase 4B-2 Remains Unauthorized:** Native mouse/keyboard automation has not been enabled or implemented.

---

## 5. Conclusion

Phase 4B-1R.2 has fully resolved completion signaling order, vacuous timeout testing, and session-disconnect cancellation ownership. The execution engine now enforces strict deterministic ordering where `CompletionTcs` signals ONLY after unregistration, resource disposal, and caller notification are complete.

