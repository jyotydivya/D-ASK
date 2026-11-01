# D-ASK Stage 4 — Phase 4B-1R.1 Execution Engine Correctness Report

**Date:** November 1, 2026  
**Status:** REMEDIATED & VERIFIED  
**Audit Scope:** Execution Engine Correctness (`ActionExecutionEngine.cs`)  
**Authorization Boundary:** STRICTLY SIMULATED ACTIONS. Zero native input injection, zero `SendInput`, zero real desktop actions. Phase 4B-2 remains unauthorized.

---

## 1. Executive Summary

During the Phase 4B-1R Independent Safety Audit, three critical operational defects were identified in the .NET action execution engine (`ActionExecutionEngine.cs`):
1. **Broken `DrainActiveTasksAsync` Timeout Detection:** A flawed task reference comparison (`completedTask != Task.Delay(timeout)`) always evaluated to `true`, causing timeouts to report as successful drains.
2. **Phantom Bounded Execution Queue:** `_queuedActions.Enqueue` was never invoked; actions executed immediately on caller threads, bypassing queue capacity limits, background scheduling, and stop-time queue draining.
3. **Non-Atomic Approval Validation and Stop-Generation Authorization:** Approval verification and epoch checking occurred outside the authoritative lock before dispatch, creating a race condition where an intervening emergency stop or epoch transition could allow stale or revoked approvals to execute.

Under **Phase 4B-1R.1**, all three defects were systematically remediated with zero regressions:
- **`DrainActiveTasksAsync`** now stores a single `delayTask = Task.Delay(timeout)`, correctly detects timeouts, prevents unobserved task exceptions, and stops execution resumption if draining fails.
- **The Execution Queue** is now genuinely bounded with explicit enqueue under capacity checks (`_queuedActions.Count >= _maxQueueCapacity`), background consumer loop (`ProcessQueueLoopAsync`), configurable sequential or controlled concurrency via `_concurrencySemaphore`, stop-time queue draining, and session-disconnect draining.
- **Atomic Authorization** is established at a single authoritative gate inside `DispatchQueuedActionAsync` under `lock (_stateLock)`, verifying emergency stop latch, panic hotkey health, stop-generation epoch matching, policy evaluation, atomic approval consumption, and active action registration in a single uninterruptible critical section.
- **Regression Testing:** A dedicated 12-test suite (`ExecutionEngineCorrectnessTests.cs`) was created and verified (12/12 PASSED). The full daemon test suite (81/81 PASSED, including all 30 safety tests and 15 screen observation tests) passed cleanly.

---

## 2. Remediation Details

### 2.1 Task 1: Fix `DrainActiveTasksAsync`

#### Before:
```csharp
// DEFECT: Task.Delay creates a new Task instance every invocation.
// completedTask is compared against a new, distinct task instance, always yielding true.
var completedTask = await Task.WhenAny(Task.WhenAll(tasks), Task.Delay(timeout));
if (completedTask != Task.Delay(timeout)) // ALWAYS TRUE!
{
    return true;
}
return false;
```
Because `Task.Delay(timeout)` instantiates a new `Task` object, `completedTask != Task.Delay(timeout)` was guaranteed to be `true` even when the timeout branch was chosen by `Task.WhenAny`. Consequently, a hung task was falsely reported as successfully drained, allowing `ResumeExecutionAsync` to clear the emergency-stop latch while previous-generation actions were still running.

#### After:
```csharp
public async Task<bool> DrainActiveTasksAsync(TimeSpan timeout)
{
    var tasks = _activeActions.Values.Select(a => a.CompletionTcs.Task).ToArray();
    if (tasks.Length == 0) return true;

    var delayTask = Task.Delay(timeout);
    var whenAllTask = Task.WhenAll(tasks);
    var completedTask = await Task.WhenAny(whenAllTask, delayTask);
    if (completedTask == delayTask)
    {
        return false; // Genuinely timed out
    }

    try
    {
        await whenAllTask; // Observe task results to prevent unobserved exceptions
    }
    catch
    {
        // Expected during task cancellation
    }

    return true;
}
```

#### Verification:
- **Zero active tasks:** Returns `true` immediately (`tasks.Length == 0`).
- **Tasks completing before timeout:** `completedTask == whenAllTask`, returns `true`.
- **Tasks exceeding timeout:** `completedTask == delayTask`, returns `false`.
- **Resume isolation:** `ResumeExecutionAsync` checks `if (!drained) return new ResumeExecutionResponse { Success = false }`, remaining in emergency stop if draining times out.

---

### 2.2 Task 2: Fix Phantom Execution Queue

#### Before:
- `_queuedActions.Enqueue` was never called in `ExecuteSimulatedActionAsync`.
- In-flight actions were immediately executed on the caller thread via `Task.Run`.
- Queue capacity limits (`_maxQueueCapacity`) were never enforced.
- When an emergency stop occurred, `QueuedActionsCancelled` was always 0 because no actions resided in the queue.
- Session disconnect (`CancelActionsForSession`) could only cancel active actions, leaving queued requests unhandled.

#### After:
1. **Explicit Bounded Enqueue:**
   ```csharp
   lock (_queueLock)
   {
       if (_isEmergencyStopped) return BlockedResponse();
       if (!_panicHotkeyAvailable) return BlockedResponse();
       if (_queuedActions.Count >= _maxQueueCapacity)
       {
           _logger.LogError("[ExecutionEngine] Action queue saturated ({Count}/{Max}). Rejecting action {ActionId}.",
               _queuedActions.Count, _maxQueueCapacity, request.ActionId);
           return SaturatedBlockedResponse();
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
   ```
2. **Background Consumer Loop (`ProcessQueueLoopAsync`):**
   A dedicated worker loop waits asynchronously on `_queueSignal` and acquires a slot from `_concurrencySemaphore`. It pops the next `QueuedActionContext` from `_queuedActions` under `_queueLock` and dispatches it via `DispatchQueuedActionAsync`.
3. **Controlled Concurrency & Sequential Dispatch:**
   Configurable via `_concurrencySemaphore` (`maxConcurrency: 1` for strict sequential desktop automation, or `maxConcurrency: 2` for multi-session isolation).
4. **Stop-Time Queue Draining:**
   In `TriggerEmergencyStopAsync`, all queued items are extracted and drained under `_queueLock`:
   ```csharp
   List<QueuedActionContext> queuedToCancel;
   lock (_queueLock)
   {
       queuedToCancel = _queuedActions.ToList();
       _queuedActions.Clear();
   }
   foreach (var queued in queuedToCancel)
   {
       queuedCancelled++;
       queued.CompletionSource.TrySetResult(CancelledResponse());
   }
   ```
5. **Session Disconnect Draining:**
   `CancelActionsForSession(sessionId)` extracts and drains all items matching `sessionId` from `_queuedActions` under `_queueLock` before cancelling any active tasks for that session.

---

### 2.3 Task 3: Atomic Authorization and Stop Generation

#### Before:
Policy evaluation, approval checking, and state inspection occurred before task scheduling across multiple non-atomic steps. An approval could be validated, followed by an emergency stop on another thread, followed by the original thread proceeding to execute under the previous generation's approval.

#### After:
Inside `DispatchQueuedActionAsync`, immediately before execution begins, an authoritative critical section is entered under `lock (_stateLock)`:
```csharp
lock (_stateLock)
{
    // 1. Fail-closed emergency stop check
    if (_isEmergencyStopped)
    {
        item.CompletionSource.TrySetResult(BlockedResponse("Emergency Stop is active."));
        return;
    }

    // 2. Fail-closed panic hotkey availability check
    if (!_panicHotkeyAvailable)
    {
        item.CompletionSource.TrySetResult(BlockedResponse("Emergency panic hotkey is unavailable."));
        return;
    }

    // 3. Stop Generation epoch check
    if (item.StopGeneration != _stopGeneration)
    {
        item.CompletionSource.TrySetResult(BlockedResponse("Enqueued during previous execution epoch."));
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
            item.CompletionSource.TrySetResult(BlockedResponse("User approval required."));
            return;
        }

        // Validate and atomically consume approval token
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
            item.CompletionSource.TrySetResult(BlockedResponse(approvalError));
            return;
        }
    }

    // 5. Register in-flight active action under the same lock
    currentEpoch = _stopGeneration;
    stopToken = _emergencyStopCts.Token;
    actionCts = new CancellationTokenSource();
    context = new ActiveActionContext { ... };

    if (!_activeActions.TryAdd(item.Request.ActionId, context))
    {
        item.CompletionSource.TrySetResult(BlockedResponse("Action ID collision."));
        return;
    }
}

// 6. Execution OUTSIDE lock with linked cancellation tokens
// ... simulation execution ...
finally
{
    context.CompletionTcs.TrySetResult(false);
    _activeActions.TryRemove(item.Request.ActionId, out _);
    actionCts.Dispose();
}
// Clean completion handoff: caller completion source set AFTER active removal
item.CompletionSource.TrySetResult(finalResponse);
```

---

## 3. Test Verification Matrix

All 12 regression tests in `tests/DAsk.Daemon.Tests/ExecutionEngineCorrectnessTests.cs` were executed and verified against the implementation.

| Test # | Test Name | Target Behavior | Inputs & Setup | Assertions | Result |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **01** | `Test01_DrainActiveTasks_AllTasksFinish_ReturnsTrue` | Fast tasks drain successfully | 2 simulated actions (20ms each), 2.0s drain timeout | `DrainActiveTasksAsync` returns `true`; empty drain returns `true` | **PASS** |
| **02** | `Test02_DrainActiveTasks_TaskExceedsTimeout_ReturnsFalse` | Genuine timeout detection | 1 simulated action (1000ms), 50ms drain timeout | `DrainActiveTasksAsync` returns `false` | **PASS** |
| **03** | `Test03_ResumeExecution_DrainTimesOut_RemainsStopped` | Resume rejected on drain failure | 1 simulated action (1000ms), 50ms resume drain timeout | `ResumeExecutionAsync.Success == false`, `IsEmergencyStopped == true` | **PASS** |
| **04** | `Test04_Queue_AcceptsWork_UpToCapacity` | Queue capacity acceptance | Capacity = 5, 1 active blocker (1000ms), 4 enqueued actions | `QueuedActionCount == 4`, no rejections | **PASS** |
| **05** | `Test05_Queue_RejectsWork_BeyondCapacity` | Queue saturation rejection | Capacity = 3, 1 active blocker (1000ms), 3 enqueued + 1 overflow | Overflow task returns `Blocked` ("Queue saturated"), count == 3 | **PASS** |
| **06** | `Test06_EmergencyStop_CancelsQueuedWork` | Stop drains queued work | 1 active blocker (3000ms), 2 enqueued actions, trigger stop | `QueuedActionsCancelled == 2`, `ActiveActionsCancelled == 1`, all return `Cancelled` | **PASS** |
| **07** | `Test07_EmergencyStop_CancelsActiveWork` | Stop cancels running action | 1 active action (3000ms), trigger emergency stop | Action returns `Cancelled`, `ActiveActionCount == 0` upon await | **PASS** |
| **08** | `Test08_Queue_DoesNotDispatch_WhileStopped` | Queue dispatch halted on stop | Emergency stop active, submit action | Returns `Blocked` ("Emergency Stop is active"), queue remains 0 | **PASS** |
| **09** | `Test09_Stop_BetweenApprovalValidationAndDispatch_PreventsExecution` | Atomic stop vs approval authorization | Elevated action queued with valid approval, stop fired while in queue | Action blocked/cancelled, no unauthorized execution occurs | **PASS** |
| **10** | `Test10_OldGenerationApproval_CannotExecuteInNewEpoch` | Monotonic epoch protection | Approval granted in epoch 1, stop triggered (epoch 2), resumed (epoch 3) | Submitting action with epoch 1 approval is rejected ("Stale execution epoch" / invalid token) | **PASS** |
| **11** | `Test11_ConcurrentStopAndDispatch_NeverCreatesUnauthorizedExecution` | Concurrent stop/dispatch race | 20 concurrent actions racing against an immediate `TriggerEmergencyStopAsync` | Invariant: Total = Completed + Cancelled/Blocked; engine stopped; zero unhandled exceptions | **PASS** |
| **12** | `Test12_SessionDisconnect_CancelsQueuedAndActiveWork` | Session isolation & cleanup | Session A: 1 active blocker + 2 queued; Session B: 1 queued. Disconnect session A | Session A has >= 3 cancelled; Session B action remains queued and executes | **PASS** |

### Test Suite Execution Summary
- **ExecutionEngineCorrectnessTests:** 12 / 12 Passed (564 ms)
- **SafetyInfrastructureTests:** 18 / 18 Passed
- **SafetyRemediationTests:** 12 / 12 Passed
- **ScreenObservationTests:** 15 / 15 Passed
- **Full Daemon Test Suite:** 81 / 81 Passed (36 s)

---

## 4. Security & Safety Compliance

1. **Simulated Execution Only:**
   - Search across `src/` for `SendInput` confirms **zero** native input injection calls exist. The only reference is an explicit safety comment enforcing simulation.
   - Zero mouse movement, zero mouse clicking, zero keyboard synthesis.
2. **Architecture Preservation:**
   - Rust host with Wry/WebView2 unchanged.
   - Holographic Three.js HUD frontend unchanged.
   - Named Pipe IPC contracts intact (`\\.\pipe\d-ask-ipc-v1`).
   - Shared memory observation and UIA COM subsystem intact.
3. **Authorization Boundary:**
   - Phase 4B-2 (Native Desktop Input Injection) remains strictly unauthorized and unbuilt.

---

## 5. Conclusion

Phase 4B-1R.1 has successfully resolved all three execution engine defects. The execution pipeline is now deterministically bounded, sequential/controlled in concurrency, fail-closed against task drain timeouts, and protected by single-point atomic authorization.

