# D-ASK Stage 4 — Phase 4B-1R: Independent Final Safety Audit Report

**Date:** 2026-11-01  
**Project:** D-ASK (Desktop Autonomous Synthesis Kit)  
**Phase:** Stage 4 — Phase 4B-1R (Critical Safety Remediation)  
**Audit Type:** Strictly Read-Only, Adversarial Source-Code & Architecture Audit  
**Author:** Independent Safety Auditor  

---

## 1. Overall Verdict: FAIL

While the Phase 4B-1R remediation implemented substantial security enhancements—notably the authoritative granted approval registry (`_grantedApprovals`), unnamed memory-mapped section objects with duplicated read-only handles (`FILE_MAP_READ`), monotonic 64-bit stop epochs, and fail-closed hotkey startup state—**the implementation fails the independent audit due to four critical architectural defects and three unverified safety mechanisms**:

1. **The Bounded Execution Queue is Entirely Phantom / Non-Existent:** `_queuedActions.Enqueue` is never called anywhere in the codebase. Actions submitted via `ExecuteSimulatedActionAsync` execute immediately on the caller thread via direct `await Task.Delay(...)`. There is no queue worker, no serial dispatch, and no queue backpressure.
2. **Defective Drain Detection in `DrainActiveTasksAsync`:** On line 209 of `ActionExecutionEngine.cs`, `completedTask != Task.Delay(timeout)` invokes `Task.Delay` a second time to produce a new task reference. Because two separate `Task.Delay` calls never share object reference equality, `DrainActiveTasksAsync` **always evaluates to `true`**, defeating the timeout detection mechanism.
3. **No Live Windows OS Window / Process Re-query:** Neither `ActionExecutionEngine` nor `ActionPolicyEngine` queries the Windows kernel or User32 (`GetWindowThreadProcessId`, `Process.GetProcessById`, `GetProcessTimes`) prior to execution. The engine blindly validates the client-supplied parameters in `SimulatedActionRequest`. If a target HWND was closed and recycled or if a client lies, the daemon has zero independent kernel verification.
4. **Panic Hotkey Discard on Bounded Channel Saturation:** In `src/hud-native/src/main.rs` (line 884), when the user presses `Ctrl+Shift+F12`, the emergency stop request is dispatched via `outgoing_tx.try_send(env)` over a bounded 64-item channel. If the IPC channel is full, the stop request is **silently dropped and discarded** by the native host.
5. **No Cancellation of In-Flight Model Inference:** Model inference (`ModelRuntime.GenerateAsync`) does not link to the daemon's `_emergencyStopCts`. When emergency stop triggers, active inference runs to completion.
6. **Fire-and-Forget Safety Audit Logging:** Safety audit writes in `ActionExecutionEngine` and `ActionPolicyEngine` are unawaited fire-and-forget tasks (`_ = _evidenceRecorder.RecordSafetyAuditAsync(...)`). Database lock contention or I/O failure leaves the execution state and evidence trail desynchronized without failing closed.

---

## 2. Finding-by-Finding Status Against Phase 4B-1R Remediation Items

| Finding ID | Scope | Target Invariant | Remediation Status | Auditor Finding / Defect Summary |
| :--- | :--- | :--- | :---: | :--- |
| **REM-01** | `ActionPolicyEngine.cs` | Forged / unrecorded approval tokens must be rejected | **PASS** | `_grantedApprovals` registry enforces presence; invented tokens are rejected fail-closed. |
| **REM-02** | `ActionPolicyEngine.cs` | Parameter tampering & HWND/PID binding | **PARTIAL / FAIL** | Token binds SHA-256 parameter hash, HWND, PID, and creation time. **However**, the daemon trusts caller-supplied DTO fields and never re-queries live Win32 window identity. |
| **REM-03** | `hud-native/src/main.rs` | Panic hotkey fail-closed lifecycle & unregistration | **CONDITIONAL PASS** | Fail-closed startup latch is verified; `PostThreadMessageW(WM_QUIT)` unregisters cleanly. **However**, channel saturation (`try_send`) silently drops stop events. |
| **REM-04** | `ActionExecutionEngine.cs` | Stale approval replay across stop cycles | **PARTIAL / FAIL** | Monotonic 64-bit epoch exists; **however**, authorization and generation check are not atomic under `_stateLock`, permitting cross-epoch execution if Stop/Resume occurs between validation and execution lock. |
| **REM-05** | `ActionExecutionEngine.cs` | Resume waits for active task unwinding | **FAIL** | `DrainActiveTasksAsync` has a reference comparison bug (`completedTask != Task.Delay(timeout)`) causing it to always return `true`. |
| **REM-06** | `IpcClientSession.cs` | Centralized observation & inference policy latching | **CONDITIONAL PASS** | Computer-use inference and observation are blocked when stopped. **However**, in-flight inferences are not cancelled on stop. |
| **REM-07** | `WindowsUiAutomationService.cs` | UIA STA worker stall recovery | **CONDITIONAL PASS** | Stalled worker detection exists. **However**, unmanaged COM threads cannot be aborted under .NET 8; stalled threads are abandoned and leaked. Helper-process isolation is not implemented. |
| **REM-08** | `ObservationBufferManager.cs` | Shared-memory namespace hijacking | **PASS** | Mappings are unnamed (`mapName = null`); client receives duplicated `FILE_MAP_READ` handle; client PID is kernel-derived. |
| **REM-09** | `SqliteEvidenceRecorder.cs` | Complete safety audit trail & migration | **PARTIAL / FAIL** | Schema and migration are sound. **However**, audit calls are fire-and-forget; failure of SQLite logging does not fail-closed. |

---

## 3. Deep-Dive Audit Analyses & Code Citations

### Audit 1 — Approval Integrity (`ActionPolicyEngine.cs` & Callers)

#### Strengths Verified
- **Authoritative Granted Registry:** `_grantedApprovals` (`ConcurrentDictionary<string, GrantedApprovalRecord>`, line 49) stores approvals only when `SubmitApprovalDecision` receives `Approved == true` (lines 315-337).
- **Invented Token Rejection:** `ValidateConsumedApproval` (lines 408-412) rejects unrecorded tokens immediately with `"Security validation failed: Approval token '{approvalId}' was never granted or does not exist."`.
- **Atomic Single-Use Consumption:** Line 504 executes `_grantedApprovals.TryRemove(approvalId, out var removedRecord)`. In a race with 20 simultaneous threads, exactly one succeeds and 19 receive concurrency rejections.
- **Canonical Hash Verification:** `ComputeCanonicalHash` (lines 62-80) sorts parameter dictionary keys alphabetically and computes SHA-256. `ValidateConsumedApproval` recomputes and compares the digest (lines 461-467).
- **Cross-Session Rejection:** Lines 428-435 strictly enforce session ownership.

#### Confirmed Vulnerabilities & Deficiencies
1. **No Live Windows OS Re-Query (Bypass via Stale / Recycled HWND):**
   In `ActionExecutionEngine.cs` (lines 364-375):
   ```csharp
   var (isValid, approvalError) = _policyEngine.ValidateConsumedApproval(
       request.ApprovalId,
       request.ActionId,
       request.ActionType,
       request.Parameters,
       request.TargetProcessName,
       request.TargetHwnd,
       request.TargetProcessId,
       request.TargetProcessCreationTime,
       sessionId,
       _stopGeneration,
       _isEmergencyStopped);
   ```
   All validation inputs (`TargetHwnd`, `TargetProcessId`, `TargetProcessCreationTime`) originate from `request` (`SimulatedActionRequest`), which is an untrusted DTO received over Named Pipe IPC. Neither `ActionExecutionEngine` nor `ActionPolicyEngine` executes Win32 calls (`GetWindowThreadProcessId`, `GetProcessTimes`, `IsWindow`) to confirm the live desktop state immediately prior to authorization.
2. **Conditional HWND/PID Bypasses:**
   In `ActionPolicyEngine.cs` lines 470, 478, 486:
   ```csharp
   if (granted.TargetHwnd != 0 && targetHwnd != 0 && granted.TargetHwnd != targetHwnd) ...
   if (granted.TargetProcessId != 0 && targetProcessId != 0 && granted.TargetProcessId != targetProcessId) ...
   if (granted.TargetProcessCreationTime.HasValue && targetProcessCreationTime.HasValue && ...) ...
   ```
   If a client submits `targetHwnd = 0`, `targetProcessId = 0`, or `targetProcessCreationTime = null`, the identity match checks are completely bypassed.

---

### Audit 2 — Panic Hotkey Integrity (`src/hud-native` & IPC Path)

#### Strengths Verified
- **Fail-Closed Startup Latch:** `ActionExecutionEngine._panicHotkeyAvailable` defaults to `false` (line 39). All action execution is blocked until the native host registers the hotkey and transmits `PanicHotkeyStatusNotification(true)`.
- **Background Message Pump Isolation:** In `src/hud-native/src/main.rs` (lines 824-872), `RegisterHotKey` runs on a dedicated background thread listening on `GetMessageW` with `HWND(0)`.
- **Clean Worker Termination:** On `Event::LoopExiting` (lines 738-743), `HotkeyThreadHandle::shutdown` issues `PostThreadMessageW(thread_id, WM_QUIT, 0, 0)`, unregisters the hotkey via `UnregisterHotKey`, and joins the thread cleanly (lines 801-814, 893-895).

#### Confirmed Vulnerabilities & Deficiencies
1. **Silent Dropping of Stop Events on Channel Saturation:**
   In `src/hud-native/src/main.rs` lines 883-887:
   ```rust
   if let Ok(env) = protocol::IpcEnvelope::new("EmergencyStopRequest", &stop_req, None) {
       if let Err(e) = outgoing_tx.try_send(env) {
           error!("[PANIC HOTKEY] CRITICAL: Failed to enqueue EmergencyStopRequest to IPC: {:?}", e);
       }
   }
   ```
   `outgoing_tx` is created via `mpsc::channel(64)` (`src/hud-native/src/ipc/client.rs`, line 28). If the outgoing channel has 64 queued telemetry or state frames, `outgoing_tx.try_send(env)` **fails and drops the Emergency Stop request**. The native thread does not block, retry, or establish a dedicated out-of-band control channel.
2. **Missing Native Stop Latching:**
   When `WM_HOTKEY` fires, `main.rs` logs a warning and dispatches an event to WebView2, but **does not latch any native boolean or `HudState` flag in Rust**. If IPC is severed, the host has no native latch preventing action submission.
3. **Hardcoded Registration Error Codes:**
   In `src/hud-native/src/main.rs` line 863:
   ```rust
   error_code: if is_ok { 0 } else { -1 },
   ```
   When `RegisterHotKey` fails due to `ERROR_HOTKEY_ALREADY_REGISTERED` (1409) or `ERROR_ACCESS_DENIED` (5), the error code is discarded and hardcoded to `-1`. While the daemon still fails closed because `is_available == false`, diagnostic observability into the root cause is lost.

---

### Audit 3 — Stop Generations & Execution Races (`ActionExecutionEngine.cs`)

#### Strengths Verified
- **Monotonic 64-Bit Epochs:** `_stopGeneration` is a 64-bit unsigned integer that increments on each `TriggerEmergencyStopAsync` (lines 115-116).
- **Active Task Cancellation:** `_emergencyStopCts.Cancel()` cancels the linked tokens of all in-flight actions (line 120), and `active.Cts.Cancel()` cancels active action contexts directly (line 141).

#### Confirmed Vulnerabilities & Deficiencies
1. **Critical Defect in `DrainActiveTasksAsync`:**
   In `ActionExecutionEngine.cs` lines 203-210:
   ```csharp
   public async Task<bool> DrainActiveTasksAsync(TimeSpan timeout)
   {
       var tasks = _activeActions.Values.Select(a => a.CompletionTcs.Task).ToArray();
       if (tasks.Length == 0) return true;

       var completedTask = await Task.WhenAny(Task.WhenAll(tasks), Task.Delay(timeout));
       return completedTask != Task.Delay(timeout);
   }
   ```
   **Mechanism of Failure:**
   - On line 208, `Task.Delay(timeout)` creates a new task instance $T_1$.
   - On line 209, `Task.Delay(timeout)` is called a second time, creating another new task instance $T_2$.
   - If `Task.WhenAll(tasks)` hangs and times out, `completedTask` holds the reference to $T_1$.
   - The expression `completedTask != Task.Delay(timeout)` evaluates `T1 != T2`.
   - Because $T_1$ and $T_2$ are distinct heap objects, `T1 != T2` evaluates to **`true`**.
   - **`DrainActiveTasksAsync` always returns `true`, completely failing to detect when the drain timeout expires.**
2. **Non-Atomic Validation & Generation Lock Race:**
   In `ExecuteSimulatedActionAsync`:
   - Line 364: `_policyEngine.ValidateConsumedApproval(...)` is called **outside** `_stateLock`.
   - Line 416: `lock (_stateLock)` is acquired.
   - If `TriggerEmergencyStopAsync` and `ResumeExecutionAsync` execute between line 364 and line 416, the action enters `lock (_stateLock)` in a brand new epoch ($Gen = 2$).
   - Inside `lock (_stateLock)` (lines 416-445), the engine checks `_isEmergencyStopped` (now `false`) and `_panicHotkeyAvailable` (now `true`). **It does not check whether `request.StopGeneration == _stopGeneration`**.
   - The action executes in epoch 2 using an approval that was granted and validated for epoch 1.

---

### Audit 4 — Actual Bounded Execution Queue (`ActionExecutionEngine.cs`)

#### Confirmed Architectural Defect: Phantom Queue
The previous audit identified that the queue was nominal. The Phase 4B-1R remediation claimed to establish an actual bounded execution queue. Inspection of the source code reveals:

1. `private readonly ConcurrentQueue<QueuedActionContext> _queuedActions = new();` is allocated on line 46.
2. Line 397 checks `if (_queuedActions.Count >= MaxQueueCapacity)`.
3. Line 150 dequeues `while (_queuedActions.TryDequeue(out var queued))`.
4. **`_queuedActions.Enqueue` is NEVER called anywhere in the entire codebase.**
5. There is no queue consumer loop, no worker thread, and no background dispatcher.
6. Every action submitted via `ExecuteSimulatedActionAsync` executes synchronously on the caller's thread via:
   ```csharp
   int duration = Math.Clamp(request.SimulatedDurationMs, 0, 30000);
   if (duration > 0)
   {
       await Task.Delay(duration, linkedCts.Token);
   }
   ```
7. `Scenario02_Queued_Actions_Drained_And_Cancelled_On_Emergency_Stop` passed only because `_queuedActions.Count` was perpetually 0.
8. The bounded execution queue is entirely fictitious.

---

### Audit 5 — Observation & Inference Policy (`IpcClientSession.cs`)

#### Strengths Verified
- **Emergency Stop Latch on Screen Capture:** `CaptureObservationRequest` is blocked when `_executionEngine.IsEmergencyStopped` is true (lines 318-330).
- **Emergency Stop Latch on Computer-Use Inference:** `ModelInferenceIpcRequest` with `Purpose == "ComputerUse"` or `"ComputerUsePlanning"` is blocked when stopped (lines 223-235).
- **Separation of Conversational Inference:** Chat requests (`Purpose != "ComputerUse"`) proceed normally when stopped.

#### Confirmed Vulnerabilities & Deficiencies
1. **No In-Flight Inference Cancellation:**
   In `IpcClientSession.cs` line 268:
   ```csharp
   var (text, telem) = await _modelRuntime.GenerateAsync(req, cancellationToken);
   ```
   The `cancellationToken` passed is tied to the Named Pipe session, **not to `_emergencyStopCts.Token`**. If an inference query is actively generating tokens when the panic hotkey is pressed, the model runtime continues executing until completion.

---

### Audit 6 — UI Automation Recovery (`WindowsUiAutomationService.cs`)

#### Strengths Verified
- **STA Thread Isolation:** COM UI Automation calls run on a dedicated STA thread (`DAsk-UiaWorker-STA`, lines 121-127).
- **5-Second Stall Detection:** `InspectWindowAsync` monitors `_isWorkerBusy` and checks if elapsed time exceeds 5000 ms (lines 208-217).

#### Confirmed Vulnerabilities & Deficiencies
1. **Unmanaged COM Thread Abandonment & Resource Leaks:**
   In `RecycleWorkerThread_UnderLock()` (lines 170-189):
   - `.NET 8` does not support `Thread.Abort()` (throws `PlatformNotSupportedException`).
   - If unmanaged COM (`uia.FindAll` or an IPC call into a hung target window) blocks indefinitely, the worker thread cannot be terminated.
   - The engine calls `_workQueue.CompleteAdding()`, abandons the stalled thread, and starts a new thread.
   - The abandoned thread **never executes `CoUninitialize()`**, retains RCWs for `CUIAutomation` and elements, and remains permanently leaked as an unkillable background thread.
2. **Lack of Process Isolation:**
   COM operations run in-process within the daemon. If an external window provider causes an access violation or unhandled heap corruption in `ole32.dll` / `UIAutomationCore.dll`, the entire daemon crashes. True containment requires an out-of-process COM helper worker.

---

### Audit 7 — Shared-Memory Security (`ObservationBufferManager.cs`)

#### Strengths Verified
- **Unnamed Section Objects:** In `CreateSharedBuffer` (lines 90-110), when `clientProcessId` is present, `MemoryMappedFile.CreateNew(null, ...)` creates an unnamed kernel section object. The mapping has no name in the Windows object manager namespace (`BaseNamedObjects`).
- **Read-Only Handle Duplication:** `DuplicateReadOnlyHandle` (lines 194-236) invokes `DuplicateHandle` with `FILE_MAP_READ` (0x0004). The client process cannot map the section with write access.
- **Kernel-Derived Client PID:** In `IpcClientSession.cs` (lines 351-354), `clientPid` is obtained via `GetNamedPipeClientProcessId(_pipeStream.SafePipeHandle, out uint realPid)`. The client cannot spoof this PID.
- **Session Cleanup:** Disconnect triggers `ReleaseSessionBuffers` (lines 248-268), and a 30-second cleanup timer purges buffers older than 2 minutes (lines 270-284).

---

### Audit 8 — Evidence Integrity (`SqliteEvidenceRecorder.cs`)

#### Strengths Verified
- **Schema & Safe Migration:** The `safety_audit_trail` table schema includes `approval_id`, `session_id`, and `stop_generation` (lines 61-75). `InitializeAsync` runs safe `ALTER TABLE ADD COLUMN` queries (lines 86-99).
- **Concurrency Control:** SQLite read/write operations are synchronized via `SemaphoreSlim _dbLock` (lines 116, 225, 272).

#### Confirmed Vulnerabilities & Deficiencies
1. **Fire-and-Forget Safety Audit Logging:**
   In `ActionExecutionEngine.cs` (lines 84, 594) and `ActionPolicyEngine.cs` (lines 203, 345, 363):
   ```csharp
   _ = _evidenceRecorder.RecordSafetyAuditAsync(new SafetyAuditRecord { ... });
   ```
   Audit records are dispatched without `await`. If a SQLite exception occurs (database locked, disk full, I/O failure), the error is merely logged as a warning.
2. **Failure Does Not Fail-Closed:**
   The failure of an audit write **does not abort or halt action execution**. Execution proceeds normally while the audit trail is silently corrupted or dropped.

---

### Audit 9 — Adversarial Testing Evaluation

#### Test Classification
- **In-Memory Harness / Unit Tests (27 tests):** `SafetyInfrastructureTests` and `SafetyRemediationTests` primarily exercise in-memory mocks (`MockStateManager`) and artificial delays (`Task.Delay`).
- **Real Win32 Integration Tests (15 tests):** `ScreenObservationTests` create genuine native Win32 windows (`Win32TestWindowHarness`), test DPI scaling, capture desktop frames, and inspect real UI Automation elements.

#### Critical Test Gaps Identified
1. **Queue Tests Are Illusory:** Scenario 02 tests queue draining against a queue that never has items inserted into it.
2. **No Test for `DrainActiveTasksAsync` Timeout:** Scenario 26 tests the successful unwinding of an active task in 30 ms; it never tests the timeout branch (which contains the reference equality bug).
3. **No Live Windows Process Re-query Test:** Scenario 20 passes modified creation times in DTOs, never verifying that the daemon inspects live OS processes.
4. **No Full Channel / Disconnect Panic Test:** Rust IPC channel overflow is completely untested.
5. **No 5-Second UIA Hang Test:** UIA tests use 1 ms timeouts; worker thread recycling after a 5000 ms unmanaged stall is never exercised.
6. **No SQLite Failure Injection Test:** No test verifies system behavior when `.d-ask-memory.db` is read-only or corrupted.

---

## 4. Exact List of Mandatory Changes Required for Phase 4B-1R Pass

Before Phase 4B-1R can be certified as PASS:

1. **Implement Real Action Queue Serialization or Explicit Direct Dispatch:**
   - Either implement a genuine background worker that dequeues from `_queuedActions`, enforces capacity bounds, and dispatches actions sequentially; OR
   - Formally retire the queue abstraction, remove `_queuedActions`, and document that actions are dispatched concurrently under the active-task registry with strict concurrency limits.
2. **Fix `DrainActiveTasksAsync` Task Reference Bug:**
   In `ActionExecutionEngine.cs`, fix lines 208-209:
   ```csharp
   var delayTask = Task.Delay(timeout);
   var completedTask = await Task.WhenAny(Task.WhenAll(tasks), delayTask);
   return completedTask != delayTask;
   ```
3. **Implement Live OS Window Identity Verification:**
   Before authorizing any elevated action, the daemon must call Win32 User32 / Kernel32 APIs:
   - Query `GetWindowThreadProcessId((IntPtr)targetHwnd, out uint livePid)`.
   - Query process creation time via `GetProcessTimes(hProcess, out var creationTime, ...)`.
   - Verify that the live desktop window matches `granted.TargetHwnd`, `granted.TargetProcessId`, and `granted.TargetProcessCreationTime`.
   - Reject fail-closed if `targetHwnd == 0` or if the window no longer exists.
4. **Make Generation Check Atomic with Execution under `_stateLock`:**
   In `ActionExecutionEngine.ExecuteSimulatedActionAsync`, move `ValidateConsumedApproval` inside `lock (_stateLock)` or re-verify `request.StopGeneration == _stopGeneration` inside the lock before registering into `_activeActions`.
5. **Fix Panic Hotkey Bounded Channel Dropping in Rust:**
   In `src/hud-native/src/main.rs`, replace `outgoing_tx.try_send(env)` with a dedicated out-of-band priority sender or blocking `blocking_send(env)`, and immediately set a local native atomic stop flag `state.is_emergency_stopped = true` in Rust.
6. **Link Model Inference to Emergency Stop Token:**
   In `IpcClientSession.cs`, link `_modelRuntime.GenerateAsync` to `_executionEngine.EmergencyStopToken` so active computer-use planning inferences are aborted immediately upon stop.
7. **Ensure Audit Trail Durability:**
   Await safety audit writes (`await _evidenceRecorder.RecordSafetyAuditAsync(...)`) during critical state transitions (Stop, Resume, Approval Grant/Consumption), and fail-closed if the database cannot persist the safety record.

---

## 5. Absolute Authorization Boundary & Confirmation

> [!CAUTION]
> **PHASE 4B-2 (NATIVE DESKTOP INPUT INJECTION) REMAINS STRICTLY UNAUTHORIZED.**
>
> In accordance with project instructions:
> - **ZERO `SendInput` API calls were introduced or called.**
> - **ZERO mouse movements or keyboard clicks were injected into the native Windows OS.**
> - **ZERO autonomous computer-use actions were executed.**
> - **NO source files, tests, configuration, or database files were modified during this read-only audit.**
> - **The system remains completely safe and contained.**

Phase 4B-1R remains in status **FAIL** pending resolution of the architectural items detailed above.

