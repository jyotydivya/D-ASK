# D-ASK Phase 4B-1R.4R.1 — Focused Independent Security Audit Report

**Date:** November 1, 2026  
**Audit Mode:** STRICTLY READ-ONLY (No source files modified)  
**Safety Invariant:** Zero real desktop actions, zero SendInput, zero mouse/keyboard injection. Execution is strictly simulated (`Task.Delay`). Phase 4B-2 remains unauthorized.

---

## Executive Summary

This independent security audit evaluates the Phase 4B-1R.4R.1 Emergency Stop Security Remediation across Rust (`hud-native`) and .NET (`DAsk.Daemon`, `DAsk.Protocol`).

### Audit Verdict: **CONDITIONAL PASS / ONE CONFIRMED DEFECT**
- **Critical Finding (Defect 1.1):** In `src/hud-native/src/state/emergency_stop.rs:233-237`, `try_resume` uses `if let Some(ref resp_session) = response.session_id`. If a daemon or adversary returns a `ResumeExecutionResponse` with `session_id: None` (or missing from JSON), the session validation is silently bypassed and the native latch is cleared! A missing expected session ID is **NOT rejected**.
- **Stop Delivery & Generation Integrity:** **PASS**. Latch coalescing, atomic generation advancing, and `BoundedStopCache` eviction cannot create stale generations or resurrect older epochs.
- **Pipe Write Correctness:** **PASS**. Sequential execution in `tokio::select!` guarantees ordinary and priority frames never interleave concurrently. The 500ms timeout drops the connection on stall, preventing partial frame corruption or byte overtaking.
- **Production-Path Test Gaps:** Five production-path integration scenarios (missing session ID, live-pipe blocked write, partial-frame reconnect, live priority saturation reconnect, and post-eviction engine replay) are verified by source inspection but lack end-to-end integration tests.

---

## 1. Resume Session Binding

### 1.1 Missing Expected Session ID in Resume Response
- **Audit Status:** **FAIL (CONFIRMED DEFECT)**
- **File & Lines:** [`src/hud-native/src/state/emergency_stop.rs:229-238`](file:///d:/D-ASK/D-ASK/src/hud-native/src/state/emergency_stop.rs#L229-L238)
- **Source Inspection:**
  ```rust
  // 1. Session verification
  if current_session.is_empty() || req.session_id != current_session {
      return Err("WrongSession: Resume was requested under a different or dead session.");
  }
  if let Some(ref resp_session) = response.session_id {
      if resp_session != current_session {
          return Err("WrongSession: Response session token does not match current active session.");
      }
  }
  ```
- **Vulnerability Analysis:**
  `req.session_id` is always non-empty (enforced at line 177). However, `response.session_id` is typed as `Option<String>`. If `response.session_id` is `None`, the `if let Some(...)` block evaluates to `false` and is skipped.
  The execution continues down to request ID matching, generation matching, and daemon success. If those match, `try_resume` clears the native stop latch.
  **A response with a missing session ID (`None`) is accepted, violating the mandatory session-binding requirement.**
- **Required Fix:**
  ```rust
  match response.session_id.as_deref() {
      Some(resp_session) if resp_session == current_session => {},
      Some(_) => return Err("WrongSession: Response session token does not match current active session."),
      None => return Err("MissingSession: Response lacks required session binding token."),
  }
  ```

### 1.2 Exact Matching of Request ID, Session ID, and Generation
- **Audit Status:** **PASS (for Request ID and Stop Generation; Partial for Session ID due to 1.1)**
- **File & Lines:**
  - Rust: [`src/hud-native/src/state/emergency_stop.rs:240-251`](file:///d:/D-ASK/D-ASK/src/hud-native/src/state/emergency_stop.rs#L240-L251)
  - C#: [`src/DAsk.Daemon/Automation/Execution/ActionExecutionEngine.cs:340-353`](file:///d:/D-ASK/D-ASK/src/DAsk.Daemon/Automation/Execution/ActionExecutionEngine.cs#L340-L353)
- **Source Inspection:**
  - Request ID: `if req.resume_id != response.resume_id { return Err("WrongRequestId..."); }`
  - Generation in Rust:
    ```rust
    let active_gen = self.generation.load(Ordering::SeqCst);
    if req.stop_generation != active_gen {
        return Err("StaleGeneration: Pending resume request generation is older than active stop generation.");
    }
    if response.stop_generation != active_gen {
        return Err("WrongGeneration: Daemon response stop generation does not match active stop generation.");
    }
    ```
  - Generation in C#:
    ```csharp
    if (expectedGeneration.HasValue && expectedGeneration.Value != _stopGeneration)
    {
        return new ResumeExecutionResponse
        {
            ResumeId = resumeId,
            Success = false,
            SessionId = sessionId ?? string.Empty,
            StopGeneration = _stopGeneration,
            ErrorMessage = $"Generation mismatch: expected {expectedGeneration.Value}, but active stop generation is {_stopGeneration}.",
            Timestamp = DateTimeOffset.UtcNow
        };
    }
    ```

### 1.3 Response Categories Validation Matrix
| Response Category | Implementation Behavior | Test Name / Command | Result |
|---|---|---|---|
| Unsolicited response | Rejects (`pending == None`) | Rust: `test_unsolicited_resume_rejected` | **PASS** |
| Replayed response | Rejects (pending cleared after 1st delivery) | Rust: `test_replayed_resume_response_rejected` | **PASS** |
| Delayed response | Rejects (generation mismatch or pending cleared) | Rust: `test_delayed_resume_after_newer_stop_rejected` | **PASS** |
| Wrong-session response | Rejects (`resp_session != current_session`) | Rust: `test_wrong_session_and_wrong_id_rejected` | **PASS** |
| Missing-session response | **Accepts** (`if let Some(...)` skips `None`) | Missing from tests | **FAIL** |
| Wrong-generation response | Rejects (`response.stop_generation != active_gen`) | C#: `Test27_Resume_RejectsGenerationMismatch`<br>Rust: `test_delayed_resume_after_newer_stop_rejected` | **PASS** |

### 1.4 Race Between Resume Validation and Concurrent Stop
- **Audit Status:** **PASS**
- **File & Lines:** [`src/hud-native/src/state/emergency_stop.rs:72-76, 223-266`](file:///d:/D-ASK/D-ASK/src/hud-native/src/state/emergency_stop.rs#L72-L76)
- **Mathematical / Concurrency Proof:**
  - `trigger_stop` locks `self.pending_resume` as Step 1 and sets `*pending = None`.
  - `try_resume` locks `self.pending_resume` at line 223 and holds the mutex guard `pending` until the end of the function scope at line 266.
  - Case 1: `trigger_stop` acquires the mutex first. It sets `*pending = None`. When `try_resume` acquires the lock, `pending` is `None`, immediately returning `Err("UnsolicitedResume")`. Latch remains locked.
  - Case 2: `try_resume` acquires the mutex first. It holds the lock through validation, clears `*pending = None`, sets `self.is_latched = false`, and resets `*last = None`. `trigger_stop` blocks until line 266. When `trigger_stop` runs, it sees `is_latched == false`, sets `is_latched = true`, increments generation, and sets a new stop.
  - In all possible thread schedulings, Stop unconditionally wins and state never desynchronizes.

### 1.5 Older Resume Response Cannot Clear Newer Stop Latch
- **Audit Status:** **PASS**
- **Proof:**
  When a newer Stop occurs, `self.generation` is incremented ($G_{new} > G_{old}$) and `pending_resume` is set to `None`.
  Any older resume response will carry `stop_generation: G_{old}`.
  In `try_resume`:
  1. `pending` is `None` $\implies$ rejected by Check 1 (`UnsolicitedResume`).
  2. Even if a new resume were recorded, `response.stop_generation` ($G_{old}$) $\neq$ `active_gen` ($G_{new}$) $\implies$ rejected by Check 3 (`WrongGeneration`).
  3. Latch cannot be cleared by any older response.

---

## 2. Stop Delivery and Cache Eviction

### 2.1 Trace of `trigger_stop`
- **Audit Status:** **PASS**
- **Call Path Traced:**
  1. **Native Hotkey/UI Trigger:** [`src/hud-native/src/main.rs:662, 916`](file:///d:/D-ASK/D-ASK/src/hud-native/src/main.rs#L662) calls `latch.trigger_stop(...)`.
  2. **Native Latch:** [`src/hud-native/src/state/emergency_stop.rs:66-116`](file:///d:/D-ASK/D-ASK/src/hud-native/src/state/emergency_stop.rs#L66-L116) sets `is_latched = true`, increments generation, sets `last_stop`.
  3. **Priority Dispatch:** `priority_tx.try_send(envelope)` sends non-blocking to bounded priority channel (capacity 16).
  4. **IPC Loop:** [`src/hud-native/src/ipc/client.rs:223-228`](file:///d:/D-ASK/D-ASK/src/hud-native/src/ipc/client.rs#L223-L228) selects `priority_rx` via `biased;` and calls `write_frame(&mut writer, &priority_env)`.
  5. **Daemon Handling:** [`src/DAsk.Daemon/Automation/Execution/ActionExecutionEngine.cs:140-262`](file:///d:/D-ASK/D-ASK/src/DAsk.Daemon/Automation/Execution/ActionExecutionEngine.cs#L140-L262) triggers `TriggerEmergencyStopAsync`, cancels active tasks, records in `BoundedStopCache`, drains queue, and returns `EmergencyStopResponse`.
  6. **HUD Ack:** [`src/hud-native/src/ipc/client.rs:331-344`](file:///d:/D-ASK/D-ASK/src/hud-native/src/ipc/client.rs#L331-L344) calls `latch.mark_acknowledged(resp.stop_generation)`.
  7. **Reconnect:** [`src/hud-native/src/ipc/client.rs:116-129, 174-178`](file:///d:/D-ASK/D-ASK/src/hud-native/src/ipc/client.rs#L116-L129) sends stop state in `HandshakeRequest` and explicitly re-delivers `EmergencyStopRequest` from `get_pending_stop()`.

### 2.2 Pending Stop Preservation Across Coalescing and Disconnects
- **Audit Status:** **PASS**
- **File & Lines:** [`src/hud-native/src/state/emergency_stop.rs:80-91, 153-165`](file:///d:/D-ASK/D-ASK/src/hud-native/src/state/emergency_stop.rs#L80-L91)
- Repeated hotkey presses while latched coalesce into the existing stop event without modifying `stop_id` or bumping generation.
- `get_pending_stop()` returns the original stop details until an authorized `try_resume` clears the latch.

### 2.3 `BoundedStopCache` Eviction and Old Stop Replay Analysis
- **Audit Status:** **PASS**
- **File & Lines:** [`src/DAsk.Daemon/Automation/Execution/ActionExecutionEngine.cs:153-167, 1005-1065`](file:///d:/D-ASK/D-ASK/src/DAsk.Daemon/Automation/Execution/ActionExecutionEngine.cs#L153-L167)
- **Replay Proof Post-Eviction:**
  Suppose `stop_001` was processed in generation 2 and subsequently evicted after 256 newer stop events. Current generation is $G_k \ge 2$.
  If an adversary replays `EmergencyStopRequest(StopId = "stop_001")`:
  1. `_processedStops.TryGet("stop_001", out ...)` returns `false` (cache miss).
  2. Inside `lock (_stateLock)`:
     - If the engine is currently running (`!wasStopped`): `_isEmergencyStopped` is set to `true`, and `_stopGeneration` is incremented to $G_{k+1} > G_k$. A new stop epoch begins.
     - If the engine is already stopped (`wasStopped == true`): `_stopGeneration` is NOT incremented; it remains at $G_k$.
  3. In neither case can `_stopGeneration` regress to generation 2.
  4. Any resume request from generation 2 will be rejected by the daemon (`expectedGeneration.Value != _stopGeneration`) and by the HUD (`response.stop_generation != active_gen`).
  **Eviction cannot cause stale generations or unauthorized resumption.**

---

## 3. Pipe Write Correctness

### 3.1 Non-Interleaving of Frames on the Stream
- **Audit Status:** **PASS**
- **File & Lines:** [`src/hud-native/src/ipc/client.rs:218-283`](file:///d:/D-ASK/D-ASK/src/hud-native/src/ipc/client.rs#L218-L283)
- `writer` is exclusively borrowed inside the single `loop` of `handle_connected_session`.
- All writes (`write_frame(&mut writer, ...)`) are invoked strictly inside mutually exclusive branches of `tokio::select!`.
- No two branches can write concurrently. Stream bytes never interleave.

### 3.2 500ms Timeout and Connection Discard on Stalled Ordinary Write
- **Audit Status:** **PASS (Source Inspection) / NOT VERIFIED (Runtime Integration Test)**
- **File & Lines:** [`src/hud-native/src/ipc/client.rs:237-247, 251-261`](file:///d:/D-ASK/D-ASK/src/hud-native/src/ipc/client.rs#L237-L247)
- If an ordinary write stalls (e.g. pipe buffer full):
  `tokio::time::timeout(ORDINARY_WRITE_TIMEOUT, write_frame(&mut writer, &outgoing))`
  fires after 500ms.
- The timeout branch logs an error and executes `break;`.
- Exiting the loop drops `pipe_stream` (both `reader` and `writer`), closing the OS pipe handle and discarding any partially written frame.
- The outer `run_client_loop` reconnects cleanly, establishing a brand-new pipe stream.
- Priority frames never overtake bytes on a dirty stream.

---

## 4. Production-Path Test Coverage Audit

### Analysis of the 6 Required Scenarios
1. **Missing session ID in a successful Resume response:**
   - **Status:** **FAIL**
   - **Reason:** Missing from test suite. Source code at line 233 does not check for `None` and erroneously accepts it.
2. **Stop racing with Resume validation and latch clearing:**
   - **Status:** **PASS (Source Analysis) / PARTIAL (Unit Coverage)**
   - **Reason:** `test_delayed_resume_after_newer_stop_rejected` covers sequential ordering; C# `Test18` covers concurrent async tasks; a multi-threaded OS-thread race directly targeting `NativeEmergencyStopLatch` is absent.
3. **Old Stop replay after deduplication-cache eviction:**
   - **Status:** **PASS (Source Analysis) / PARTIAL (Unit Coverage)**
   - **Reason:** `Test26` verifies LRU eviction mechanics in `BoundedStopCache`, but does not test calling `engine.TriggerEmergencyStopAsync` with an evicted ID to verify end-to-end generation dynamics.
4. **Stop delivery after priority-channel saturation and reconnect:**
   - **Status:** **PASS (Source Analysis) / PARTIAL (Unit Coverage)**
   - **Reason:** `test_bounded_priority_channel_saturation_and_latch_preservation` verifies channel rejection at capacity 16 and latch state preservation; reconnect re-delivery over a live pipe stream is not exercised in an automated test.
5. **Priority Stop arriving during a blocked ordinary frame write:**
   - **Status:** **PASS (Source Analysis) / NOT VERIFIED (Runtime Test)**
   - **Reason:** Timeout logic is implemented at lines 237-261, but no mock pipe server in the test suite artificially blocks stream writes to trigger the 500ms timeout branch.
6. **Partial-frame write failure followed by reconnect:**
   - **Status:** **PASS (Source Analysis) / NOT VERIFIED (Runtime Test)**
   - **Reason:** Stream teardown and reconnect are implemented, but no test deliberately injects a broken pipe mid-frame.

---

## 5. Verbatim Test Execution Evidence

All test suites were executed cleanly during this audit without modification to any source file:

### Rust HUD-Native Test Suite (`hud-native`)
Command:
```powershell
$env:LIB = "d:\D-ASK\D-ASK\.xwin-sdk\crt\lib\x86_64;d:\D-ASK\D-ASK\.xwin-sdk\sdk\lib\um\x86_64;d:\D-ASK\D-ASK\.xwin-sdk\sdk\lib\ucrt\x86_64"
$env:RUSTFLAGS = "-C linker=rust-lld"
cargo test --manifest-path "d:\D-ASK\D-ASK\src\hud-native\Cargo.toml" --bin hud-native -- --nocapture
```
Output:
```
running 10 tests
test state::emergency_stop::tests::test_delayed_resume_after_newer_stop_rejected ... ok
test state::emergency_stop::tests::test_replayed_resume_response_rejected ... ok
test state::emergency_stop::tests::test_unsolicited_resume_rejected ... ok
test state::emergency_stop::tests::test_wrong_session_and_wrong_id_rejected ... ok
test state::emergency_stop::tests::test_native_stop_latch_lifecycle ... ok
test state::emergency_stop::tests::test_reconcile_from_daemon ... ok
test state::emergency_stop::tests::test_repeated_stop_coalesces_and_does_not_inflate_generation ... ok
test tests::test_hotkey_thread_handle_shutdown_and_drop ... ok
test ipc::client::tests::test_bounded_priority_channel_saturation_and_latch_preservation ... ok
test ipc::client::tests::test_priority_channel_preempts_full_ordinary_channel ... ok

test result: ok. 10 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
```

### .NET Daemon Execution Engine Correctness Suite (`DAsk.Daemon.Tests`)
Command:
```powershell
dotnet test tests/DAsk.Daemon.Tests/DAsk.Daemon.Tests.csproj --no-restore --no-build --filter "FullyQualifiedName~ExecutionEngineCorrectnessTests"
```
Output:
```
Passed!  - Failed:     0, Passed:    29, Skipped:     0, Total:    29, Duration: 1 s - DAsk.Daemon.Tests.dll (net8.0)
```

### .NET Daemon Safety Infrastructure Suite (`DAsk.Daemon.Tests`)
Command:
```powershell
dotnet test tests/DAsk.Daemon.Tests/DAsk.Daemon.Tests.csproj --no-restore --no-build --filter "FullyQualifiedName~SafetyInfrastructureTests"
```
Output:
```
Passed!  - Failed:     0, Passed:    16, Skipped:     0, Total:    16, Duration: 867 ms - DAsk.Daemon.Tests.dll (net8.0)
```

### .NET Daemon Safety Remediation Suite (`DAsk.Daemon.Tests`)
Command:
```powershell
dotnet test tests/DAsk.Daemon.Tests/DAsk.Daemon.Tests.csproj --no-restore --no-build --filter "FullyQualifiedName~SafetyRemediationTests"
```
Output:
```
Passed!  - Failed:     0, Passed:    13, Skipped:     0, Total:    13, Duration: 408 ms - DAsk.Daemon.Tests.dll (net8.0)
```

---

## 6. Audit Recommendations for Next Phase

1. **Fix Defect 1.1 in `src/hud-native/src/state/emergency_stop.rs`:**
   Change lines 233-237 from `if let Some(...)` to:
   ```rust
   match response.session_id.as_deref() {
       Some(resp_session) if resp_session == current_session => {},
       Some(_) => return Err("WrongSession: Response session token does not match current active session."),
       None => return Err("MissingSession: Response lacks required session binding token."),
   }
   ```
2. **Add Missing Regression Tests in `src/hud-native/src/state/emergency_stop.rs`:**
   Add `test_missing_session_rejected`: verify that a response with `session_id: None` returns `Err("MissingSession")` and preserves the latch.
3. **Add End-to-End Engine Replay Test in `ExecutionEngineCorrectnessTests.cs`:**
   Add a test that calls `TriggerEmergencyStopAsync` with an evicted ID, confirming `_stopGeneration` advances to a new value and does not revert to the old epoch.
