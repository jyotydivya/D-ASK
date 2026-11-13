# Phase 7B.3: Controlled Desktop Execution (P0: window management)

**Date:** 2026-11-09. **Scope:** Phase 7B.3 P0 only. **P1 (mouse) and P2 (keyboard and text) were not implemented**; see §9. Phase 7B.4 has not been started.
**Builds on:** [7B.0 safety contracts](phase-7b0-safety-contracts.md) (§7, §10), [7B.1b](phase-7b1b-report.md), [7B.2](phase-7b2-report.md). Phase 7B.2 evidence (`results/phase7b2/offline-live/20261109T050719`) is unchanged.

## 1. Summary

D-ASK now performs an approved window operation on a real Windows window and reports success only after an independent observation confirms it. The operations are focus, minimize, maximize and restore.

Every step of the chain is the existing production one; Phase 7B.3 adds the last four:

```
natural language → AgentRuntime plan → protocol v2 call → daemon resolves the window from the OS
→ policy (Elevated) → exact canonical action + digest → owner-only approval in the HUD → explicit decision
→ daemon validates it (owner, liveness, expiry, Emergency Stop, epoch, digest) → consumed exactly once
→ identity re-read from the OS
→ [7B.3] write-ahead audit record (awaited)
→ [7B.3] final gate: cancellation, Emergency Stop latch, epoch, owner HUD lease, OS identity
→ [7B.3] ONE Win32 call
→ [7B.3] fresh observation verifies the result → verified result to the agent
```

**Live, on this machine** (real daemon process, real agent host, local model, disposable fixture window):
- "Minimize the window titled …" was approved, executed once and verified. The test confirmed `minimized=True` independently from the OS, and the task outcome was `completed`.
- Restore was approved and completed, with the OS showing the original rectangle.
- Focus was approved and completed, with the OS showing the fixture in front.
- A denied maximize never reached the executor.
- An Emergency Stop while a maximize was pending invalidated the approval in 13 ms, and the executor was never called.

## 2. Architecture and ownership (unchanged)

| Component | 7B.3 change |
|---|---|
| AgentRuntime (TS) | The two window tools now report `ok` only when the daemon returns `executed:true` **and** `verified:true`. The request check counts such a result as satisfying the request only for the state that was asked for. A postcondition rejects anything unverified. The agent cannot authorize or execute; it holds `request:desktop_action` only. |
| Daemon | `DesktopActionRequestService` gains the execution path after consumption and revalidation. New `IWindowOperationExecutor` / `Win32WindowOperationExecutor` (one Win32 call) and `WindowOperationVerifier` (pure). Switch `AgentHost:DesktopActionExecution`: **off by default in code**, as safety contracts §10 require, and turned on in `appsettings.json`. |
| HUD page | The blue "Approval only" notice is shown only when the daemon's `execution` parameter says the action will not be performed. That parameter is bound into the digest, so the notice cannot disagree with the action. When execution is on, the parameter reads: "Performed once, right after your approval, on exactly this window (checked again first); the result is then verified. Nothing else is done." |
| Rust HUD | Unchanged. It still displays approvals, collects decisions and owns Emergency Stop and the panic hotkey. It is not an execution authority. |

No second approval, authorization or execution system was created. The executor is reachable only from `DesktopActionRequestService`, after the policy engine's single-use consumption.

## 3. Execution path in detail (`DesktopActionRequestService.ExecuteApprovedAsync`)

1. **Preconditions** (from 7B.2): the approval was decided by the owner session, validated and consumed once (`ValidateConsumedApproval`), and the target's identity was re-read and matched.
2. **Execution ready:** the switch is on, an executor exists, the audit journal exists and a liveness source exists. If any is missing, the request stays approval-only, and the approval text said so.
3. **Write-ahead:** `DesktopActionExecutionAdmitted` is written to the append-only, hash-chained audit trail and **awaited**. If the write fails, the result is `journal_unavailable` and nothing is done.
4. **Final gate**, immediately before the event:

   | Condition | Result |
   |---|---|
   | Cancellation requested | refused |
   | Emergency Stop latched | refused |
   | Stop epoch ≠ the approval's epoch | refused |
   | Owner HUD lease not live | refused |
   | Window re-read from the OS: gone, HWND reused, PID or creation time changed, image, class or thread changed | refused |

   Any failure records `DesktopActionExecutionRefused`, and nothing is done.
5. **One Win32 call:**
   - minimize, maximize, restore: `ShowWindowAsync` with `SW_MINIMIZE`, `SW_MAXIMIZE` or `SW_RESTORE`;
   - focus: `SetForegroundWindow`.

   Any other operation makes no call. The result is recorded as `DesktopActionExecuted`.
6. **Verification:** the same window is re-read from the OS every 50 ms for up to 2 s, and must be the **same identity** in the approved state:

   | Operation | Required state |
   |---|---|
   | minimize | minimized |
   | maximize | maximized and not minimized |
   | restore | neither minimized nor maximized |
   | focus | foreground |

   The outcome is recorded as `DesktopActionVerified` or `DesktopActionUnverified`.
7. **Result:**
   - `ok` with `executed:true`, `verified:true`, the observation and timings;
   - otherwise `execution_unverified`, `cancelled_after_execution` or `execution_failed`, each worded "it will not be retried".

   Nothing is retried, and `RunCallAsync` (7B.1b) also turns a late success after cancellation into `cancelled`.

## 4. Security invariants and where they are enforced

| Invariant | Enforcement | Test |
|---|---|---|
| Every action has a valid, unexpired, single-use approval for the exact canonical action | policy engine (7B.2); executor only after `ValidateConsumedApproval` | `ApprovalIsSingleUse_…`, `ExpiredApproval_…`, `Denied_…`, live replay rejected |
| Approval is bound to the target identity; the agent never supplies HWND/PID | 7B.2 resolver plus revalidation, and the final gate | `TargetReplacedOrReused_AtTheFinalGate_…` (process replaced, HWND reused, window gone) |
| Exactly the approved operation on the approved window | the executor receives the HWND and operation from the daemon-held request | `Approved_IsExecutedOnce_…` checks the single call |
| Emergency Stop takes priority | latch and epoch checked at the decision (7B.2) and again at the final gate | `EmergencyStop_EpochChange_LeaseLoss_AndCancellation_AtTheFinalGate_…`, `EmergencyStop_BeforeApproval_…`, live Stop-while-pending |
| Cancellation reaches the executor; never success after cancellation | final gate; verification observes the token; protocol layer | final-gate test, `CancellationDuringVerification_IsNeverSuccess`, TS X6 |
| No implicit approval; no blind retries | no code path retries; agent and daemon allow one approval request per task | `VerificationFailure_…_NotRetried`, `ExecutorFailure_…_NotRetried`, TS A7 and X3 |
| Audit before acting | write-ahead record awaited; refused without a journal | `NoJournal_MeansNoExecution` (missing journal, failing journal) |
| Success only when observed | `WindowOperationVerifier`; agent `satisfies` and postcondition | `Verifier_…`, `WindowReplacedDuringVerification_…`, TS X1–X4 |
| No keyboard or mouse input; no process, shell or file operations | the executor's only APIs are `ShowWindowAsync` and `SetForegroundWindow` | static scan (§7): no `SendInput` or similar anywhere in the daemon |

## 5. Files changed (Phase 7B.3)

- **New:**
  - `src/DAsk.Daemon/Automation/Desktop/WindowOperationExecutor.cs`: executor interface, Win32 executor, verifier.
  - `tests/DAsk.Daemon.Tests/Phase7B3Tests.cs`
  - `tests/DAsk.Daemon.Tests/Phase7B3LiveTests.cs`
  - `scripts/hud/approval-live-7b3.ps1`: the real-HUD click-through, built from the 7B.2 harness with its guards unchanged.
  - `scripts/hud/offline-phase7b3.ps1`
- **Changed:**
  - `src/DAsk.Daemon/Automation/Desktop/DesktopActionRequestService.cs`: execution path, final gate, write-ahead, verification, approval text.
  - `src/DAsk.Daemon/AgentHost/AgentHostManager.cs`: `DesktopActionExecution` option, default false.
  - `src/DAsk.Daemon/Program.cs`: executor and HUD liveness wiring.
  - `src/DAsk.Daemon/appsettings.json`: `"DesktopActionExecution": true`.
  - `agent/runtime/tools/desktop.ts`: verified-execution results, `satisfies`, postcondition, refusal wording.
  - `hooks/approvalLifecycle.ts`: the approval-only notice derived from the daemon's parameter. `.next` was rebuilt.
  - `tests/agent-runtime/desktop.test.ts`: the [X] section.
  - `tests/DAsk.Daemon.Tests/Phase7B2Tests.cs`: `Service_HasNoExecutor` now states the 7B.3 invariant (one window-operation executor, nothing else).
- **Blocker investigation (tests only):**
  - `tests/DAsk.Daemon.Tests/Phase7B1bLiveTests.cs`: client envelope trace and full daemon log written to `results/phase7b3/blocker-diag/`; the read loop keeps early task envelopes in a bounded backlog (the fix).
  - `tests/DAsk.Daemon.Tests/Phase7B1bClientOrderingTests.cs` (new): deterministic replay of the captured order.
- **Fix (a), duplicate window actions:**
  - `agent/runtime/planner.ts`: `removeExactDuplicateWindowActions`, called from `Planner.check`.
  - `agent/runtime/types.ts`: optional `Plan.removedDuplicateSteps`.
  - `tests/agent-runtime/desktop.test.ts`: the [D] section.
- **To keep the accepted 7B.2 tests testing approval-only mode:**
  - `tests/DAsk.Daemon.Tests/Phase7B2LiveTests.cs` and `scripts/hud/approval-live-7b2.ps1` set `DesktopActionExecution=false` explicitly.
  - `Phase7B2LiveTests.HudWire`, `Decision` and `DescribeForeground` were made `internal` for reuse.

## 6. Tests and results (actual, 2026-11-09)

| Command | Result |
|---|---|
| `dotnet test … --filter FullyQualifiedName~Phase7B3Tests` | **19 / 19**: integration, gates, verification, failure, single use, audit chain, plus the real executor on a fixture |
| `dotnet test … --filter Category=Phase7B3Live` | **1 / 1** (real daemon, host, model; real Win32 operations on the fixture) |
| `dotnet test tests/DAsk.Daemon.Tests` (full suite, first run) | 397 passed, 1 failed of 398. The failure was the 7B.2 test `Service_HasNoExecutor`, whose premise 7B.3 intentionally changed. It now asserts that the only executor dependency is `IWindowOperationExecutor` (a single `Apply` method) and that there is no execution-engine or input dependency. 7B.2 + 7B.3 unit tests rerun: 48 / 48. |
| **Final full-suite verification** (§6.1) | **398 total: 397 passed, 1 failed, 0 skipped. Exit code 1.** The failure is `Phase7B1bLiveTests.Live_NaturalLanguage_ListAndInspect…`, step 5 (see §6.1). The updated `Service_HasNoExecutor` passed. |
| `cargo test` (src/hud-native; unchanged) | 53 passed, 1 ignored |
| `npx tsx tests/agent-runtime/desktop.test.ts` | **119 / 119** (6 new: X1–X6) |
| host-protocol, experimental, agent-runtime, grounding, filesystem, offline, local-inference | 81, 31, 165, 77, 184, 23, 95: all passing |
| approval-lifecycle (page), native-agent | 46 / 46, 92 / 92 |
| Harness typing/read-back tests against `approval-live-7b3.ps1` and `-7b2.ps1` | 35 / 35 each |
| PowerShell 5.1 parse of `approval-live-7b3.ps1` and `offline-phase7b3.ps1` | 0 errors, ASCII-only |
| `npm run build` (page) | succeeded |

**Live run detail** (`Phase7B3LiveTests`; fixture window "DASK Exec Fixture 88638f"):

| Request | Decision | Outcome | Daemon record | OS check by the test |
|---|---|---|---|---|
| Minimize | Approve | `completed`: "Minimized … Verified by a fresh observation …" | `ShowWindowAsync(minimize) -> True; verified=True … in 1 ms` | minimized |
| Restore | Approve | `completed` | `ShowWindowAsync(restore) -> True; verified=True … in 0 ms` | normal |
| Maximize | Deny | `failed`: "You declined. Nothing was done." | no execution | not maximized |
| Bring to front | Approve | `completed` | `SetForegroundWindow -> True; verified=True … in 0 ms` | foreground |
| Maximize | Emergency Stop while pending | `failed`: "Emergency Stop cancelled the request." | no execution | not maximized |

The daemon logged exactly 3 executions; the denied and the stopped requests never reached the executor. A replayed decision after execution was answered `DecisionAccepted:false`.

### 6.1 Full daemon-suite verification and the 7B.1b blocker (2026-11-09)

**First final run (before the investigation).**
- Command: `dotnet test tests/DAsk.Daemon.Tests/DAsk.Daemon.Tests.csproj --no-build --logger "trx;LogFileName=results/phase7b3/full-suite/20261109T160333/full-suite.trx" --logger "console;verbosity=normal"`
- Result: 398 tests, **397 passed, 1 failed**, 0 skipped. **Exit code 1.** 6 min 6 s.
- Failure: `Phase7B1bLiveTests.Live_NaturalLanguage_ListAndInspect…`. The test's own 180 s read timeout (`OperationCanceledException`) expired while it waited for the result of an instantly refused request.
- Run alone with the same build: 1 / 1 passed.

#### Investigation

**Stage 1 (read-only).** Verified from the code:
- The test client's `ReadUntilAsync` **discarded every envelope it did not match**. `AskAsync` read in two phases: first the submit acknowledgement, then the task result.
- In the daemon, the acknowledgement is written by `IpcClientSession.HandleAgentRequestAsync`. It runs off the read loop (`Task.Run`, `IpcClientSession.cs:515`), after the host's response completes a `TaskCompletionSource` created with `RunContinuationsAsynchronously` (`AgentHostManager.cs:853`). That puts it on a thread-pool continuation.
- The progress and result notifications are raised **synchronously on the host reader thread** (`TaskProgress` / `TaskFinished`, `AgentHostManager.cs:614`, `:650`). They go through `SendToOwner` → `SendEnvelopeAsync`, serialized by `_writeLock` (`NamedPipeServer.cs:92-94`, `IpcClientSession.cs:725`).
- So for a task that finishes within about 1 ms, its notifications can reach the pipe **before** its acknowledgement.
- The production HUD page already allows for this: `hooks/nativeAgent.ts` `#onTaskMessage` buffers "early" task messages while a submit is pending. The ordering is a legitimate protocol property.
- The existing logs could not show which side lost the result, so diagnostics were added.

**Stage 2 (instrumentation, test-side only, no semantic change).** `Phase7B1bLiveTests` now:
- records every envelope the client receives: time, type, id, reply-to id, task id, bytes, and whether it was matched or skipped;
- records request write start and completion, acknowledgement, result and timeout;
- keeps the **complete** daemon log, where previously it kept only filtered lines.

Both go to a new folder, `results/phase7b3/blocker-diag/<stamp>/`, on every run. No user content or secrets are recorded; objectives are recorded by length only.

**Stage 3 (reproduction).**
- Alone (`blocker-diag/20261109T161548-7bce`): passed. The trace already showed a progress notification for a new task arriving **before** its acknowledgement and being skipped.
- Full suite, diagnostics run 1 (`full-suite/20261109T161602-diag`): 398 / 398 passed. In step 5, the result followed the acknowledgement by only 0.25 ms.
- Full suite, diagnostics run 2 (`full-suite/20261109T161938-diag2`, trace `blocker-diag/20261109T162413-d3c3`): **reproduced**, this time at step 4 ("Inspect this window", the other instant refusal):

| Time (UTC, 2026-11-09) | Where | Event |
|---|---|---|
| 10:51:13.96692 / .96709 | test client | request `e02dbc21…` write start / done |
| 16:21:13.967 local | daemon, session `5fb6f8e2…` | `Received message: Type='AgentTaskSubmitRequest', Id='e02dbc21…'` |
| (host clock) .953 / .954 | agent host | `task te2f9b4e… accepted`; `task te2f9b4e… finished: refused in 1 ms` |
| 10:51:13.96802, .96817 | test client | two `AgentTaskProgressNotification` for the new task: **SKIPPED** |
| **10:51:13.96853** | test client | **`AgentTaskResultNotification`, taskId `te2f9b4e…`, 428 bytes: received while waiting for the acknowledgement, SKIPPED** |
| 10:51:13.96865 | test client | `AgentTaskSubmitResponse`, replyTo `e02dbc21…`, taskId `te2f9b4e…` (the acknowledgement) |
| 10:54:13.97141 | test client | `TIMEOUT phase=result after 180000 ms` |

#### Root cause (proven)

The agent host produced the result. The daemon delivered it on the correct session, and the test client **received** it. The defect is in the **test client**: its read loop discarded the result because it arrived before that task's submit acknowledgement, then waited 180 s for a result it had already dropped.
- There is no daemon, host, IPC-routing or correlation defect. The early ordering is legitimate, and the real HUD page handles it.
- How often it happens depends on thread-pool scheduling, so it appears under full-suite load and not alone.
- Correction to the 7B.2 report: the 3 min 17 s failure seen there was very likely this same defect, not a model-server shutdown race.

#### Correction (test client only)

In `Phase7B1bLiveTests.ReadUntilAsync`, unmatched task envelopes (progress, result, submit acknowledgement) are kept in a bounded backlog (512) instead of being discarded, and every read checks the backlog first. This mirrors the HUD page's early-message buffer. Timeouts, assertions and test expectations are unchanged, and no daemon, agent-host, protocol, approval or execution code changed.

#### Verification (evidence `results/phase7b3/blocker-fix-verify/20261109T162657/`)

| Step | Command (all `dotnet test tests/DAsk.Daemon.Tests/DAsk.Daemon.Tests.csproj --no-build …`) | Result |
|---|---|---|
| 1. Failing test alone | `--filter "Category=Phase7B1bLive"` | 1 / 1 passed, exit 0 |
| 2. All 7B.1b tests | `--filter "FullyQualifiedName~Phase7B1b"` | 41 / 41 passed, exit 0 |
| 3. Full suite (before the replay tests) | full suite | **398 / 398 passed, exit 0**, 3 min 6 s. The race did not occur in this run (no backlog hit), so this run alone does not exercise the fix. |
| 4. Deterministic replay (new `Phase7B1bClientOrderingTests`) | `--filter "FullyQualifiedName~Phase7B1bClientOrderingTests"` | 4 / 4 passed (see below) |
| 5. **Final full suite** | full suite, `5-final-full-suite.trx` | **402 total: 401 passed, 1 failed, 0 skipped. Exit code 1.** 16:32:37 to 16:35:41 (+05:30). 7B.1b live passed. The 7B.2 approval-only assertion `Service_HasNoExecutor` passed. 7B.3 unit tests 19 / 19 and replay tests 4 / 4 passed. **`Phase7B3LiveTests` failed** (§6.2). |

**The replay tests** feed the exact captured frame order (progress, progress, result, acknowledgement) through the test client's own `ReadUntilAsync`. They prove:
- the fixed read recovers the early result from the backlog;
- the old read with no backlog **loses** it, reproducing the original defect deterministically;
- the usual order still works;
- the backlog never returns another task's result.

The first attempt at this test failed because my test data built a progress notification with an unserializable empty `data` element. I fixed the test data and deleted that attempt's TRX file, which was in the verification folder created minutes earlier, not in earlier evidence.

### 6.2 Second, separate issue: repeated window action → `partial` (OPEN)

`Phase7B3LiveTests` failed in **3 of the last 4** complete-suite runs, and never when run alone:

| Run | Request | Failure |
|---|---|---|
| `full-suite/20261109T161938-diag2` | minimize | `Expected "completed", Actual "partial"` |
| `blocker-fix-verify/20261109T162657/5-final-full-suite` | focus | the "not completed" branch expected "could not confirm" |
| `dedup-verify/20261109T164342/full-suite` (after fix (a)) | focus | same as above |

The agent's own output was the same each time:
- Step 1 was executed once and **verified**, for example "Brought … to the front … Verified by a fresh observation … foreground=True".
- Step 2 was correctly blocked: "Already asked for approval once in this task; not asking again."
- Result: `partial` ("1 of 2 steps succeeded"), although the request was carried out and verified.

**Safety held every time:** one approval, one Win32 call, no second prompt or execution, and no false "completed".

**Correction to my earlier diagnosis.** I had stated that "the plan contained the same window action twice". That was an **unverified inference** from the text "1 of 2 steps". The live test does not record step ids or plans, so the evidence never showed whether the two steps came from **one plan** or from **two planning rounds**.

#### Fix (a), as authorized: exact duplicate window-action steps are removed during plan validation

- **Change:** `agent/runtime/planner.ts`, function `removeExactDuplicateWindowActions`, called from `Planner.check` after all validation errors.
  - Only `desktop.focus_window` and `desktop.set_window_state` are affected.
  - Steps are compared as tool plus canonical JSON of the input (keys sorted).
  - The first occurrence is kept and the order is preserved; dependencies are re-linked to the previous retained step.
- **Diagnostic:** removed steps are recorded on the plan as `removedDuplicateSteps: [{ id, duplicateOf, tool }]`. Ids and tool names only; never inputs. (`agent/runtime/types.ts` gains this optional `Plan` field.)
- **Unchanged:** approvals, task limits, identity validation, Emergency Stop, cancellation, audit, execution and the daemon.
- **Tests:** 13 new tests in `tests/agent-runtime/desktop.test.ts`, section [D], all passing (132 / 132 in the file):

  | Case | Expected |
  |---|---|
  | Identical focus steps; identical state steps; identical input in a different key order | collapsed to one step |
  | Different targets, states, arguments or tools | all kept |
  | Exact duplicates of other tools | kept |
  | Step order and dependencies | preserved |
  | `Planner.check` | records the diagnostic |
  | End-to-end duplicate plan | one daemon request; ends **completed** with the verified text and no failed step |
  | Existing limits | unchanged: the agent-side guard is per tool; the daemon enforces one action request per task |

#### Result: fix (a) is correct but does NOT resolve the live failure

- With fix (a) built into the agent host, the 7B.3 unit and live tests passed **20 / 20** when run on their own.
- The **complete suite failed again** the same way, on focus (§6.3). So the second step is **not an exact duplicate inside one plan**.
- **Most likely cause (hypothesis, not proven):**
  - After the first round, the AgentRuntime asks the model to assess the result.
  - If the model says more steps are needed, the runtime plans a **second round**, and that new plan repeats the window action.
  - Plan validation checks each round separately, so fix (a) cannot remove that repeat. The tool's guard then blocks it, and the task ends `partial`.
- **Evidence needed to confirm it:** the failing task's step ids (second-round steps carry an `r2_` prefix) or its plan events. The live test currently logs neither.

**Options, not implemented** (each needs your decision; (ii) and (iii) change agent behaviour):
- (i) Add test-only instrumentation that logs step ids and plan rounds, to prove the cause.
- (ii) A runtime rule: a window action already executed and verified in this task satisfies an identical step in a later round, without asking again.
- (iii) Don't re-plan after a verified window action whose facet is already satisfied.

The test's expectations were not loosened.

### 6.3 Verification after fix (a)

Evidence: `results/phase7b3/dedup-verify/20261109T164342/`

| Step | Command | Result |
|---|---|---|
| New focused tests | `npx tsx tests/agent-runtime/desktop.test.ts` | 132 / 132, exit 0 ([D] 13 / 13) |
| Agent runtime / planner | `npx tsx tests/agent-runtime/agent-runtime.test.ts`, `…/grounding.test.ts` | 165 / 165 and 77 / 77, exit 0 |
| Other TypeScript suites | host-protocol, experimental, filesystem, offline, local-inference, approval-lifecycle, native-agent | 81, 31, 184, 23, 95, 46, 92: all exit 0 |
| Agent host rebuilt | `npm run build:agent-host`, `npm run build:agent-host-test` | succeeded; the built `planner.js` contains the fix |
| 7B.3 unit + live | `dotnet test tests/DAsk.Daemon.Tests/DAsk.Daemon.Tests.csproj --no-build --filter "FullyQualifiedName~Phase7B3"` | **20 / 20**, exit 0 |
| **Complete daemon suite** | `dotnet test tests/DAsk.Daemon.Tests/DAsk.Daemon.Tests.csproj --no-build --logger "trx;LogFileName=results/phase7b3/dedup-verify/20261109T164342/full-suite.trx" --logger "console;verbosity=normal"` | **402 total: 401 passed, 1 failed, 0 skipped. Exit code 1.** 16:45:44–16:48:46 (+05:30), 3 min 2 s. Failed: `Phase7B3LiveTests` (focus → `partial`; see §6.2). |

Within that complete suite:

| Test or group | Result |
|---|---|
| 7B.1b early-message replay tests (`Phase7B1bClientOrderingTests`) | 4 / 4 |
| 7B.1b live | passed |
| 7B.1b unit | 40 / 40 |
| 7B.2 approval-only assertion (`Service_HasNoExecutor`) | passed |
| 7B.2 tests | 29 / 29 |
| 7B.2 live | passed |
| 7B.3 unit | 19 / 19 |

### 6.4 Option (i): round diagnostics — root cause of the repeated action (PROVEN; not fixed)

**Instrumentation (diagnostic only; no change to planning, completion, approval or execution):**
- `agent/host/host.ts`: an opt-in `diag` object on progress events, enabled only when `DASK_AGENT_DIAGNOSTICS=1` (wired in `agent/host/stdioHost.ts`; off by default).
  - On plan events: step ids, tools and dependencies, plus `removedDuplicateSteps`. Each step also gets an input fingerprint: an HMAC-SHA256 of the tool plus canonical input, with a random per-process key, truncated to 16 hex.
  - On verification events: `needsMoreSteps`, `criteriaSatisfied`, method, step counts, `missingCount`, `unexplainedCount`, facet ids and grounding statuses.
- `agent/runtime/planner.ts`: `canonicalJson` is exported. There is no logic change.
- `tests/DAsk.Daemon.Tests/Phase7B3LiveTests.cs`: enables the flag for its own daemon and observes every envelope it already reads. Waits, predicates, timeouts and assertions are unchanged.
  - Free text is mapped to fixed labels or hashed.
  - It writes `events.jsonl`, `analysis.json` and `daemon-correlated.log` to `results/phase7b3/round-diag/<stamp>-<tag>/`.
- `tests/agent-runtime/desktop.test.ts` [G] G1–G5: diagnostics are off by default and the events are unchanged. The fingerprints correlate identical inputs across rounds, and no inputs, titles or model text appear.

**Reproduced with the 7B.3 tests run on their own** (the first time outside the complete suite). Evidence: `results/phase7b3/round-diag/20261109T170600-19130e/`. The failing task was "Minimize":

| Event | Observed |
|---|---|
| Round 1 plan | one step, `s1` `desktop.set_window_state`, fp `4c5f1b6abd46d1d9`; no duplicates removed |
| Approval | 1 request; approved; `s1` succeeded with verified-observation evidence |
| Round 1 verification | `independentlyVerified=true`, `criteriaSatisfied=true`, facet satisfied, `s1` grounded; **`needsMoreSteps=true`, `missingCount=10`** |
| Decision | **another round** (`replanning`) |
| Round 2 plan | `r2_s1` `desktop.set_window_state`, **same fp `4c5f1b6abd46d1d9`** |
| `r2_s1` | failed: agent-guard asked-once (no second approval, no second execution) |
| Round 2 verification | `needsMoreSteps=false`, `stepsSucceeded=1/2`, `independentlyVerified=false` → finish |
| Result | `partial` |

**Cause: B.** The identical action was repeated in a later planning round after the first action had been executed and verified.
- It is not A: the repeat came from a different round, and round 1 had one step with nothing removed.
- It is not C: the fingerprints are identical.
- The trigger is the model's `needsMoreSteps=true` assessment, which the runtime acts on even when deterministic verification is complete (`independentlyVerified=true`).

**Proposed minimal correction (NOT implemented; for review).** In `agent/runtime/runtime.ts`, do not start another round when round 1's report has `independentlyVerified === true`, i.e. `canContinue` also requires `!verification.independentlyVerified`. This is close to option (iii) and changes agent behaviour, so it needs your authorization.

**Known diagnostic defect:** facet ids embed the requested window title (for example `desktop:action:minimize:*:<fixture title>`). These are fixture titles only, but the diag (and, already, the existing task result's `facets`) should hash or omit them before any further run.

### 6.5 Option (i) follow-up: redaction fix and full-suite capture (2026-11-09, 17:10–17:20 +05:30)

Evidence: `results/phase7b3/round-diag-redact/20261109T171429/` (logs, TRX) and diagnostic captures `results/phase7b3/round-diag/20261109T171602-83d38d/` (alone) and `…/20261109T171921-296290/` (full suite).

**Diagnostic-only change (closes the §6.4 "known diagnostic defect"):**
- `agent/host/host.ts`: verification `diag.facets` now carry `fp` (the same keyed HMAC as input fingerprints) instead of the facet `id`, which can embed the requested window title.
- `tests/DAsk.Daemon.Tests/Phase7B3LiveTests.cs` `RoundDiag.Note`: each event line is redacted as a whole (fixture title → `<fixture>`), covering the protocol result's own `facets` ids.
- `tests/agent-runtime/desktop.test.ts` G4: the fake facet id now embeds the secret title; asserts a 16-hex `fp` and no `id`. G5 therefore also proves the title does not leak via facets.
- No change to planning, completion assessment, the approval guard, or daemon authorization/execution/verification.

| Step | Command | Result |
|---|---|---|
| Desktop TS tests | `npx tsx tests/agent-runtime/desktop.test.ts` | 137 / 137, exit 0 (G1–G5 pass) |
| Agent runtime | `npx tsx tests/agent-runtime/agent-runtime.test.ts` | 165 / 165, exit 0 |
| Host protocol | `npx tsx tests/agent-host/host-protocol.test.ts` | 81 / 81, exit 0 |
| Builds | `npm run build:agent-host`, `npm run build:agent-host-test`, `dotnet build tests/DAsk.Daemon.Tests/DAsk.Daemon.Tests.csproj` | all exit 0 |
| 7B.3 alone | `dotnet test … --no-build --filter "FullyQualifiedName~Phase7B3"` | 20 total, **19 passed, 1 failed**, exit 1 (live: minimize → `partial`) |
| **Complete daemon suite** | `dotnet test tests/DAsk.Daemon.Tests/DAsk.Daemon.Tests.csproj --no-build --logger trx… --logger "console;verbosity=normal"` | **402 total: 400 passed, 2 failed, exit 1**, 17:16:22–17:19:26, 3.03 min |
| Benchmark alone | `dotnet test … --no-build --filter "FullyQualifiedName~RepeatedScreenCapture_Benchmark"` | 1 / 1 **failed**, exit 1 (median 35.24 ms > 30 ms) |

Title leak check: `grep -c "DASK Exec Fixture"` on all three files of both captures = **0**.

**Full-suite capture (the failing task, "Minimize"):** identical to §6.4 and to the alone run.
- Round 1: one step `s1` `desktop.set_window_state`, nothing removed; 1 approval; daemon log shows exactly one `Desktop call c1`, one token consumption, one `ShowWindowAsync(minimize) -> True; verified=True`.
- Round 1 verification: `independentlyVerified=true`, `criteriaSatisfied=true`, `needsMoreSteps=true`, `missingCount=10` → `replanning`.
- Round 2: `r2_s1`, same tool, **same fingerprint** as `s1` → `agent-guard:asked-once`, no daemon call.
- Round 2 verification: `needsMoreSteps=false`, 1/2 steps, `independentlyVerified=false` → `partial`.
- Decision point: `agent/runtime/runtime.ts:202-205`. `canContinue` depends only on the model-assessed `needsMoreSteps` and the iteration/tool-call limits, not on `independentlyVerified`.

**Conclusion:** cause B (a later planning round repeats the identical, already verified action) is now captured both alone and under full-suite conditions. **Limitation:** the earlier full-suite failures on *focus* (§6.2) were not captured with diagnostics. The live test stops at its first failing assertion, and both new failures occurred at minimize. Their signature ("1 of 2", asked-once, verified step 1) matches, but that they share the cause is an inference, not proven.

**New, unrelated failure:** `ScreenObservationTests.RepeatedScreenCapture_Benchmark_And_ResourceStability_Test`. Median capture latency was 36.15 ms (full suite) and 35.24 ms (alone), against a 30 ms budget. It passed in every earlier recorded run. No screen-capture or daemon code changed in this step, so machine state is the likely factor; not investigated further.

**Verdict unchanged: Phase 7B.3 is NOT fully accepted.** The proposed correction in §6.4 still awaits authorization, and the benchmark regression must also be resolved or explained before the complete suite can pass.

### 6.6 Investigation A (read-only): the completion signals and the repeated round (2026-11-09; nothing implemented)

Evidence: `results/phase7b3/completion-investigation/` (`…172742` = first replay with an incomplete fake; `…172840-faithful` = 16 faithful replays + `facets-probe`). Method: the real `AgentRuntime`, registry, verifier and local model (default `qwen2.5-0.5b`, temperature 0), with a fake daemon that reports a verified action. Synthetic fixture requests only. Harness sources are filed with the evidence.

| Question | Established |
|---|---|
| What is `criteriaSatisfied`? | The local model's boolean in its assessment JSON (`verifier.ts:118-120`); `null` if no assessment ran. Not computed deterministically. It can only downgrade an outcome (`decideOutcome`); it never triggers or stops a round. |
| Why can it be true with `needsMoreSteps` true? | Both are separate fields of one model answer; nothing cross-checks them. Deterministic gaps can only force `needsMoreSteps` to true (`addDeterministicGaps`); there were none here (facet satisfied, step grounded). So the model produced the `true` alone. |
| What are the 10 missing items? | **Not requirements.** The model returned `["unmet criterion","needsMoreSteps","reason","{","{","{","{","{","{","{"]`: three words echoed from the prompt's JSON template, then `{` filler up to the schema's `maxItems: 10`. The same three-word junk (3–4 items) appears in **all 17** faithful assessments (16 runs, one with a second round), including the 16 where `needsMoreSteps=false`. `missing` carries no information with this model. The plan's `successCriteria` are likewise fragments (`"minimize the window titled "`, `""`). Round 2 planning is then fed these junk items as `STILL REQUIRED: …`. |
| What does `independentlyVerified` cover? | Deterministic and task-level (`grounding.ts:131`): every step succeeded, every succeeded step is grounded in the request, at least one facet was detected and **all detected facets** are satisfied by tool output, and no content words are unexplained. It is not per-operation. Its limit: it covers only what the request-check facet detectors recognise. |
| Is `criteriaSatisfied` safe as the completion condition on its own? | **No.** It was `true` in all 17 assessments, including a round where a step had failed and the model's own reason said "the evidence does not show a criterion is met". Used alone, it would end every task after round 1 and kill legitimate multi-step tasks. |
| Is `independentlyVerified` safe on its own? | **Not fully.** Known coverage gap: `requestedWindowAction` returns only the first operation, and every other action verb is in the explained vocabulary. "Minimize X **and then restore it**" is `independentlyVerified=true` after the minimize alone (`facets-probe.out`). Today that case is saved only because the extra model round tends to reach the one-action-per-task guard and ends `partial`. |

**Rate.** Faithful replays: 1 of 16 reproduced exactly the live signature (`independentlyVerified=true, criteriaSatisfied=true, needsMoreSteps=true, missingCount=10`, then `r2_s1` with the same fingerprint, `partial`). Live runs fail more often under the full suite, so the rate depends on load; the cause is a low-quality model answer, not scheduling.

**Proposed correction (NOT implemented; for review).**
1. `agent/runtime/runtime.ts`, `canContinue`: also require that the task is not already complete by the single outcome rule, i.e. `!(verification.independentlyVerified && verification.criteriaSatisfied === true)`. Equivalent to "never start another round when `decideOutcome` would already return `completed` for the steps so far". This requires the deterministic task-level signal **and** the model's agreement, as `decideOutcome` already does; `criteriaSatisfied === false` (model dissent) still continues; deterministic gaps still continue (they make `independentlyVerified` false).
2. **Companion guard, needed because of the gap above:** `desktop.ts` window-action `facets()` must yield one facet per distinct requested operation (or the request must be flagged unexplained). The second facet cannot be satisfied (one action per task), so the task stays unverified and ends `partial`, honestly, instead of `completed`. Without this, change 1 would turn "minimize then restore" from an honest `partial` into a false `completed` in the cases where the model asks for another round. (The same false `completed` is already possible today whenever the model says `needsMoreSteps=false`.)

**Required regression tests** (all with scripted models, no live model): single verified action that satisfies its request finishes `completed` in 1 round; a two-facet request where only one facet is covered continues; a successful action that does not satisfy the facet (wrong state, unverified) continues; contradictory signals (`independentlyVerified && criteriaSatisfied && needsMoreSteps`) finish `completed` while `criteriaSatisfied=false && needsMoreSteps` continues; "minimize X then restore it" never reports `completed`; the existing E3–E5 round/limit tests, A7 (one approval prompt per task), cancellation and approval tests unchanged.

### 6.7 Investigation B (read-only): the screen-capture benchmark (2026-11-09; nothing changed)

Evidence: `results/phase7b3/benchmark-investigation/20261109T174351/` (raw per-sample CSVs, logs, harness source). Test: `ScreenObservationTests.RepeatedScreenCapture_Benchmark_And_ResourceStability_Test`: N = 30, no warm-up, asserts median < 30 ms and P95 < 50 ms on the service's own `CaptureDurationMs`. Method: a scratchpad console app that runs the unmodified `Win32ScreenObservationService` and, interleaved, an independent raw `BitBlt` through its own P/Invoke.

**History (all runs, same 30 ms budget):** Phase 6: median 28.85. Phase 7B.3 full suites: 27.08, 27.74, 27.98, 27.22, 27.20, 29.18, all passing, then **36.15** (full suite) and **35.24** (alone) failing. Minimum in every run, passing or failing, is 20.3–24 ms; maximum 36–64 ms. The budget margin was only 0.8–2.9 ms.

**Findings**
1. **Not the code.** The timed region is display enumeration, `GetDC`, `CreateDIBSection` and the full-screen `BitBlt`. The uncommitted diff touches none of that for this request. An interleaved ABAB comparison of the current build and the committed `HEAD` build (3 rounds × 200 samples each; the current DLL was verified to contain the uncommitted change and `HEAD` not): median 32.92 / 33.00 / 32.40 ms vs 32.79 / 32.40 / 32.56 ms, indistinguishable.
2. **What is captured.** The test measures the **physical** 1920×1080 display (125% scaling, Intel Iris Xe, 60 Hz), matching a DPI-aware run of my harness (min 22–25, P95 49–50, max 53–56 vs the failing test's 22.45 / 49.13 / 55.44). A DPI-unaware process captures 1536×864 and is faster (median 32 vs 33–43 ms), so those numbers are not like-for-like.
3. **The distribution is multimodal and not stable run to run.** At 1920×1080 there are clusters near 24–32 ms and 44–48 ms; the mix changed between two consecutive runs of identical code 30 s apart (median **43.3** ms with 11% of samples under 30 ms, then **33.1** ms with 37% under 30 ms). Bimodality appears at 1536×864 as well (about 15 ms and about 33 ms, i.e. one and two 60 Hz frames), which suggests the capture waits on display composition. In 55 sliding 30-sample windows per run, the median passed the 30 ms budget in 0% and 24% of windows; P95 < 50 ms in 62% and 75%.
4. **Not CPU contention in any simple sense.** Median was the same (32 ms) at 21%, 9% and 8% system CPU. The independent raw `BitBlt` shows the same environment-level cost (27 ms at 1536×864; 42 ms at 1920×1080), outside D-ASK code.
5. **Method.** No warm-up: the first 3–6 calls in every run are 25–43 ms (warm-up lists in the logs), which sit inside a 30-sample window. N = 30 with a median at 30 ms leaves the result on the edge of a multimodal distribution.

**Conclusion:** measurement instability on a threshold that sits inside the machine's own distribution, not a code regression. This is established for code (finding 1) and for the measured distribution (2–4). **Not established:** *why* the mix shifted between ~17:00 and 17:19 on this machine. The candidates are GPU or power state ("Samsung Mode" plan), compositor load from a busy desktop (many Chrome and IDE windows, Bixby systray), or a Windows/driver background activity; none was controlled, and no user process was stopped. Not changed, as instructed: the screen-capture implementation and the 30 ms threshold.

**Verdict unchanged: Phase 7B.3 is NOT fully accepted.**

### 6.8 Workstream A (authorized 2026-11-09): completion loop and ordered window operations

Evidence: `results/phase7b3/workstream-a/20261109T181857/` (TypeScript logs, builds, focused 7B.3 TRX, full-suite TRX). No daemon authorization, approval or execution code changed.

**Changes**
- `agent/runtime/runtime.ts`: `canContinue` additionally requires `!(independentlyVerified === true && criteriaSatisfied === true)`. This is exactly the condition under which `decideOutcome` already returns `completed`, so it needs the deterministic task-level verification **and** the model's agreement. `criteriaSatisfied` alone never stops a round; `independentlyVerified` alone never does either. Deterministic gaps make `independentlyVerified` false, so they still continue. Iteration and tool-call limits are untouched.
- `agent/runtime/tools/desktop.ts`: new `requestedWindowActions()` returns **every** requested window operation in order (verbs inside quoted window titles are ignored); `requestedWindowAction()` is still the first one. Each operation becomes its own facet (`desktop:action:<i>of<n>:…`) with a `sequence`. The state argument domain allows exactly the requested states; `ground()` accepts only a requested state. A request that asks for several operations **and** names more than one window or application is answered with a question before planning (nothing runs). Single-operation facet ids and behaviour are unchanged.
- `agent/runtime/types.ts`, `agent/runtime/grounding.ts`: facets may carry `sequence {key, index, of}`. Such facets are satisfied only by **different executed steps, in order** (steps are executed sequentially, so array order is execution order), and only if all `of` facets were detected. A missing link makes every later one unsatisfied. Final window state alone cannot satisfy an earlier operation, and one executed step cannot satisfy two operations.

**Effect on multi-operation requests (unchanged guards).** The per-tool asked-once guard and the daemon's one-action-per-task limit are unchanged, so a second window operation of the same tool is still not executed. "Minimize X then restore X" therefore ends `partial` (honest) rather than `completed`; two operations of different tools are each requested once and are verified in order.

**Tests** (`tests/agent-runtime/desktop.test.ts`, new section [H], 46 assertions; file now **176 / 176**, was 137):

| Requirement | Covered by |
|---|---|
| Single minimize / maximize / restore / focus complete after verified execution, one round | H4 (4 cases) |
| "Minimize X then restore X" needs both operations, in order | H1b, H2a, H2c–H2k, H9a, H9b |
| Verified intermediate action does not end a multi-step request | H2d, H9a, H9e |
| Failed / unverified operation never completes | H2h, H2i, H2j, H7a, H7b |
| `criteriaSatisfied=true` cannot override failed deterministic verification | H7a, H7c |
| Malformed assessment cannot create completion | H8 (empty object, wrong types, null, string) |
| Observed contradiction (verified + `criteriaSatisfied` + `needsMoreSteps` + junk `missing`) starts no second round | H5; model dissent still continues: H6 |
| Ambiguous sequences handled conservatively | H3, H1c, H2n |
| Duplicate removal still works | H10 and the existing [D] tests |
| Asked-once guard, approvals, cancellation, Emergency Stop unchanged | existing A7, A10, X and containment tests, all unchanged and passing |

Mutation check: with the new `canContinue` guard disabled, H5 fails with exactly the live signature (`partial`, 2 iterations, 2 plans); restored, 176 / 176. No existing test was changed or weakened. (Only the existing [G] test G4 had been edited earlier for the facet-fingerprint redaction, §6.5.)

**Verification, in the authorized order**

| Step | Command | Result |
|---|---|---|
| Focused + all agent-runtime / host tests | `npx tsx` on desktop, agent-runtime, grounding, filesystem, host-protocol, experimental, offline, local-inference, approval-lifecycle, native-agent, phase4b-actuation-containment | 176, 165, 77, 184, 81, 31, 23, 95, 46, 92 passed; containment "ALL TESTS PASSED". All exit 0. |
| Types and builds | `npx tsc --noEmit -p .`, `npm run build:agent-host`, `npm run build:agent-host-test` | all exit 0; the built host contains the change |
| 7B.3 daemon and live | `dotnet test … --no-build --filter "FullyQualifiedName~Phase7B3"` | **20 / 20**, exit 0 (live test included). Caveat: this live run never produced the contradictory signal, so it does not itself exercise the fix; H5 and the mutation check do. |
| **Full daemon correctness suite** | `dotnet test tests/DAsk.Daemon.Tests/DAsk.Daemon.Tests.csproj --no-build --logger trx --logger "console;verbosity=normal"` | **402 total: 402 passed, 0 failed, 0 skipped, exit 0.** 18:40:15–18:43:28 (+05:30), 3.19 min. |

### 6.9 Workstream B (authorized 2026-11-09): benchmark policy

Evidence: `results/phase7b3/workstream-b/20261109T183857/` (builds, two complete benchmark runs with JSON, text report, CSV samples and histograms). The screen-capture implementation was not changed and the 30 ms target was not changed.

**Changes**
- `tests/DAsk.Daemon.Tests/ScreenObservationTests.cs`: the gating test `RepeatedScreenCapture_Benchmark_And_ResourceStability_Test` is **renamed `RepeatedScreenCapture_ResourceStability_Test`** and no longer asserts latency. It remains blocking and now asserts: every one of 30 captures succeeds with pixel data; every buffer is released (and cannot be released twice); managed memory growth below 32 MB; GDI and USER object growth ≤ 2. Measured in the full suite: memory delta −100,824 bytes, GDI +0, USER +0. All other capture, buffer, DPI and UIA tests are unchanged and blocking.
- **New, dedicated and explicit:** `tests/DAsk.Benchmarks.ScreenCapture` (console project, not run by `dotnet test`). Run it with `dotnet run --project tests/DAsk.Benchmarks.ScreenCapture -c Debug` after building the daemon. It measures the unmodified production service with the former test's metric (`CaptureDurationMs`, no UIA, no thumbnail) against the unchanged target (median < 30 ms **and** P95 < 50 ms), and reports separately:
  - **COLD:** the first 30 captures of each of 5 fresh processes, no warm-up (the former test's protocol), with the very first capture of each process;
  - **WARM:** 20 discarded warm-up captures, then 300 samples in one process, with min/median/mean/P95/max/stdev, share under 30 ms, wall-clock median and a 4 ms histogram;
  - **environment:** OS, runtime and build configuration, CPU, GPU, DPI awareness, refresh rate, power source and plan, process count, system CPU before / during / after;
  - **verdict:** "ACHIEVED" only if every measured condition meets the target; otherwise "NOT ACHIEVED" and **exit code 1**, so a failure cannot be mistaken for a pass.

**Result (run on this machine, Debug build; two complete runs, both NOT ACHIEVED)**

| | Run 1 (18:43) | Run 2 (18:44) |
|---|---|---|
| COLD: fresh processes meeting the target | 0 of 5 (medians 31.3–40.3 ms) | 0 of 5 (31.5–40.3 ms) |
| COLD: all 150 samples median / P95 / max | 38.51 / 46.80 / 58.00 ms | 38.29 / 46.54 / 50.57 ms |
| COLD: very first capture of a process | median 30.15, max 58.00 ms | up to 49.11 ms |
| WARM: n, min / median / P95 / max | 300; 20.22 / **39.50** / 45.65 / 48.57 ms | 300; 20.49 / **39.53** / 45.45 / 50.16 ms |
| WARM: samples under 30 ms | 29 % | 29 % |
| WARM verdict | NOT ACHIEVED (median) | NOT ACHIEVED (median) |
| Captured display | 1920×1080, DPI scale 1.25, PerMonitorV2, 60 Hz | same |
| System CPU during cold / warm | 14.5 % / 11.6 % | 13.4 % / 12.1 % |

Environment: Windows 11 10.0.26200, .NET 8.0.33, Intel Core i5-1335U (12 logical), Intel Iris Xe Graphics, AC power at 100 % battery, power plan "Samsung Mode", about 305 running processes.

**The 30 ms target was NOT achieved on this machine in this state.** The warm distribution is multimodal (clusters at about 24–32 ms and 40–48 ms, §6.7), and its mix today is worse than during the earlier 27–29 ms runs. This was not changed or hidden: the result is reported as measured, and the benchmark stays red until the target is met or the target is revisited by a deliberate decision.

### 6.10 Acceptance review after both workstreams

| Gate | State |
|---|---|
| Complete daemon correctness suite | **402 / 402, exit 0** |
| All TypeScript suites, `tsc`, host builds | passing |
| 7B.3 unit (19) + live (1) | 20 / 20 |
| Dedicated 30 ms screen-capture latency target | **NOT ACHIEVED** (reported separately, §6.9) |
| Real-HUD click-through 17 / 17 and Wi-Fi-off offline run (§8) | **recorded before the §6.8 changes and not re-run**; they use single-operation requests, whose behaviour is unchanged, but they were run against earlier agent code |

**Phase 7B.3 remains NOT FULLY ACCEPTED.** All correctness tests now pass, but the performance target is not achieved, and the real-HUD and Wi-Fi-off evidence has not been re-run against the final agent code (that run needs the real HUD and switches Wi-Fi off, so it needs your go-ahead). P1 (mouse) and P2 (keyboard/text) are not implemented; Phase 7B.4 is not started.

### 6.11 Final verification A: real-HUD + Wi-Fi-off rerun on the final build (2026-11-09 18:49–18:51) — FAIL, cause not established

Evidence: `results/phase7b3/offline-live/20261109T184956/` (the unmodified `scripts/hud/offline-phase7b3.ps1`). Wrapper evidence: `results/phase7b3/final-verification$(date +%Y%m%dT%H%M%S)/offline-wrapper/`; the folder name is literal because of a quoting mistake of mine, and the content is intact. The wrapper switched the Wi-Fi radio off (Windows radio API, no admin), waited for the project's own preflight to confirm offline (3 s), ran the script, then switched the radio back on, as it was before.

| Item | Result |
|---|---|
| Wi-Fi off before / after | **true / true** (script's own checks; probes unreachable) |
| Wire live test (`Category=Phase7B3Live`) | **1 / 1**, exit 0 |
| HUD click-through | **3 / 17**, exit 1, **aborted** at request 1: "the task ended without an approval" (`Minimize the window titled "DASK Approval Fixture …"`) |
| Non-loopback connections by D-ASK processes | **0** (4 processes observed) |
| OVERALL | **FAIL** |

**What is known.**
- The agent host accepted the task at 18:50:41.559 and finished it `failed` 2,936 ms later. No desktop call reached the daemon: no approval, no decision, no execution. The fixture ended unchanged (check 6 passed).
- The process monitor recorded the wire test's `llama-server` (pid 3328, started 18:50:05) and **no `llama-server` at all during the HUD run**. The daemon log shows 4.14 GB RAM available (73 % load).
- `failed` (not `refused`) in under 3 s with no model server is consistent with planning failing because the local model did not start. The new window-operation parser runs only before the model as a clarification check (that would give `refused`) or after a plan exists. The wire test passed the same request shape through the same build 30 s earlier.

**What is not known.** The agent's failure text is not written to any log (the HUD log records only that a result arrived), so why the model server did not start is **not established**. Candidates are the wire test's model server still shutting down, a memory check, or a start failure. None is proven.

**Safety held:** no false completion, no approval prompt, no execution, offline throughout, 0 non-loopback connections. The earlier accepted real-HUD evidence (`offline-live/20261109T154526/`, 17 / 17) is preserved but predates the §6.8 changes. **Phase 7B.3 remains NOT FULLY ACCEPTED.** Parts B (Release benchmark) and C (final review) were not run, pending a decision.

### 6.12 Workstream A: diagnosis of the failed real-HUD rerun — cause ESTABLISHED (memory admission); not fixed

Evidence: `results/phase7b3/hud-diagnostic/20261109T185648/` (online; **diagnostic only, not acceptance**). It reproduces the acceptance order (wire test, then the real-HUD click-through immediately after) with opt-in agent diagnostics and a 250 ms process and memory monitor (`process-lifecycle.csv`, `memory.csv`, `model-files.json`, `runner.log`, plus the HUD run's own `approval-live/` folder).

**Diagnostic instrumentation added (opt-in, `DASK_AGENT_DIAGNOSTICS=1` only; no behaviour change):**
- `agent/host/stdioHost.ts`: the supervisor's existing `onStatus` callback logs each model status change: state, pid, backend, restarts, `lastError`, and the memory-admission figures in MB. No key and no request text.
- `agent/host/host.ts`: the "finished" line gains `[diag lastPhase=… plans=… errorKind=…]`, where `errorKind` is only the error's leading category (never its body).
- Off by default, verified: host-protocol 81, desktop 176, experimental 31 and local-inference 95, all passing.

**Reproduced. Wire test 1 / 1 (exit 0); HUD 3 / 17 (exit 1), aborted at request 1 exactly as before.** The agent host's own record:

```
model status: {"state":"loading", … "estimateMB":973, "admission":null}
model status: {"state":"failed", … "lastError":"Insufficient physical memory: 2957 MB available, model needs ~973 MB (estimate),
               leaving 1984 MB < required headroom 2000 MB", "admission":{"ok":false,"availableMB":2957,"requiredMB":973,"minHeadroomMB":2000,"projectedHeadroomMB":1984}}
task … finished: failed in 3116 ms [diag lastPhase=planning plans=0 errorKind="Planning failed"]
```

| Question | Finding |
|---|---|
| 1. Exact failure | `SupervisorFatalError` from memory admission (`memory.ts admitModel`): projected headroom 1,984 MB < 2,000 MB. The supervisor goes to `failed`; the planner's model call throws, so the run ends `failed` with "Planning failed". |
| 2. Model-server lifecycle | **No `llama-server` was created** in the HUD run: admission runs before spawn (`supervisor.ts #launchOnce`, after verification, before `#killOrphan` and `spawn`). |
| 3. Model path / files | Present: all three pinned GGUF files and the pinned runtime executable exist (`model-files.json`). Runtime and model hash verification passed (the failure is the next check). |
| 4. Connection / readiness | Never reached; no port was allocated. |
| 5. Memory before loading | **2,957 MB available** at the admission instant (agent log). The monitor shows 2,831–2,959 MB while the HUD run was starting. Admission needs ≥ 2,973 MB (973 MB estimate + 2,000 MB headroom). |
| 6. Host ↔ model server | None: there was no server. The daemon ↔ host protocol worked (task accepted, result delivered). |
| 7. Failing stage | `planning`, first model call (`plans=0`); the 3.1 s are the hash verification before the admission check. |
| 8. Previous wire-test model server | **Not the cause:** the wire test's `llama-server` (pid 13336) exited at 13:28:42.109 UTC with its daemon, before the HUD run's daemon started (13:28:44.275). During the wire test (no HUD or WebView2) available memory was 3.5–4.5 GB, so admission passed. With `hud-native` and WebView2 running it fell to about 2.9 GB, and after the run it recovered to 4.5 GB. |

**Conclusion.** The real-HUD path fails on this machine because the HUD plus WebView2 consume enough memory that the remaining free memory (about 2.9 GB of 16 GB; the rest is used by other applications) falls 16 MB below the model-admission rule. The window-operation parser, completion loop, approvals and execution are not involved. The guard behaved as designed (fail-closed, nothing executed). The 18:49 offline failure (§6.11) has the same signature (failed in 2,936 ms, planning, no `llama-server`, 4.14 GB free at daemon start, before the HUD loaded). That it is the same cause is **highly likely but not proven**, because diagnostics were off in that run.

**Proposed corrections (NOT implemented; for review):**
1. *Environment (no code):* free memory before the acceptance run, e.g. by closing other applications, so that at least about 3.5 GB is available with the HUD running. Then rerun the Wi-Fi-off acceptance unchanged. This keeps the guard exactly as it is.
2. *Harness (test code only):* the acceptance scripts check available memory after the HUD has started and refuse with a clear "insufficient memory for the local model" message instead of failing at request 1. They change no product behaviour.
3. *Product, observation only:* a memory refusal is currently permanent for the host's lifetime (`failed` state), even after memory frees up. Making admission refusal re-check on the next request would be a behaviour change to the supervisor. I raise it for your consideration only; I don't recommend it as part of 7B.3.
4. **Not proposed:** lowering the 2,000 MB headroom or the model estimate.

### 6.13 Workstream B: Release-build benchmark — NOT ACHIEVED

Evidence: `results/phase7b3/benchmark-release/20261109T190036/` (Release daemon build log, benchmark builds, four complete runs with JSON, text, CSV and histograms). Daemon built with `dotnet build src/DAsk.Daemon/DAsk.Daemon.csproj -c Release` (a separate `bin/Release`; the Debug build is untouched). The benchmark project's daemon reference is now selectable (`DaskDaemonConfiguration`, default = its own configuration). The report states the measured DLL's actual build from its `DebuggableAttribute` and records available memory. Screen capture, metric and thresholds are unchanged.

Runs were interleaved Debug → Release → Debug → Release, 19:00–19:04, under the same conditions: 1920×1080 at DPI scale 1.25, PerMonitorV2, 60 Hz, AC power at 100 %, plan "Samsung Mode", 302–304 processes, 4.2–4.3 GB of 16 GB physical memory available, system CPU 13–15 % during measurement.

| Run | Measured DLL | Cold: processes meeting target | Cold (150 samples) median / P95 / max | Warm (n = 300) min / median / P95 / max | Warm < 30 ms | Verdict |
|---|---|---|---|---|---|---|
| 1 | Debug (JIT optimisation disabled) | 0 / 5 | 37.70 / 45.85 / 49.42 | 19.96 / **39.51** / 45.87 / 52.71 | 25 % | NOT ACHIEVED |
| 2 | **Release** (JIT-optimised) | 2 / 5 | 33.12 / 46.25 / 53.46 | 20.55 / **33.05** / 47.35 / 52.43 | 40 % | NOT ACHIEVED |
| 3 | Debug | 0 / 5 | 39.83 / 45.73 / 51.28 | 20.37 / **39.30** / 45.19 / 60.77 | 30 % | NOT ACHIEVED |
| 4 | **Release** | 1 / 5 | 38.78 / 46.84 / 53.54 | 19.95 / **31.58** / 45.18 / 53.04 | 44 % | NOT ACHIEVED |

Release warm histogram (run 2, 4 ms bins): 20–24: 29 · 24–28: 58 · 28–32: 57 · 32–36: 19 · 36–40: 34 · **40–44: 70** · 44–48: 26 · 48–52: 6 · 52–56: 1. Run 4 is similar, with its largest bin at 24–28 (76). Debug run 1 peaks at 40–44 (99). Both builds show the same two clusters (about 24–32 ms and 40–48 ms). Release moves more samples into the faster cluster.

**Comparison.** Release is about 6–8 ms faster at the warm median (32.3 vs 39.4 ms, averages of two runs each) and lets 1–2 of 5 cold processes meet the target (Debug: 0 of 10). The minimum (about 20 ms) and P95 (45–47 ms) are unchanged, so the floor and tail are set by the capture itself, not by JIT optimisation. **The 30 ms target was NOT ACHIEVED in Release either** (warm medians 33.05 and 31.58 ms; P95 < 50 ms was met in every run).

### 6.14 Workstream C: final Phase 7B.3 review (2026-11-09 19:08)

**Re-verified on the current build** (after the §6.12 diagnostics were added). Evidence: `results/phase7b3/final-review/20261109T190312/`.

| Check | Result |
|---|---|
| Complete daemon correctness suite | **402 / 402, exit 0** (19:04:47–19:08:00) |
| TypeScript suites | desktop 176, agent-runtime 165, grounding 77, filesystem 184, host-protocol 81, experimental 31, offline 23, local-inference 95, approval-lifecycle 46, native-agent 92, containment "ALL TESTS PASSED"; all exit 0 |
| `tsc --noEmit`, `build:agent-host`, `build:agent-host-test` | exit 0 |

**Behaviour verified (by tests in the passing suites; daemon source unchanged in all of this work).** The 10 modified daemon files are the pre-existing working-tree set; none was edited during §§6.5–6.14.
- Completion loop: no second round once `independentlyVerified && criteriaSatisfied` (H5; mutation check §6.8); model dissent still continues (H6); malformed assessments never complete (H8).
- Ordered window-operation facets: each operation needs its own verified step in order (H2c–H2l); intermediate-only, final-state-only, reversed and unverified sequences are never verified (H2d–H2j, H9a, H9d, H9e).
- No false completion for multi-operation requests: H9a and H9b end not-completed; ambiguous multi-window sequences get a question and nothing runs (H3).
- One-action-per-task and approval safeguards unchanged: the agent's per-tool asked-once guard (A7, H9b) and the daemon's per-task action limit and approval lifecycle (7B.2 and 7B.3 unit tests in the 402).
- Emergency Stop, cancellation, identity revalidation and the write-ahead audit: 7B.3 unit tests (19 / 19) and the 7B.3 live test, inside the 402; containment tests.

**Evidence, by category**

| Category | Evidence | State |
|---|---|---|
| **Previously accepted** (before the §6.8 agent changes) | Real-HUD click-through 17 / 17 and Wi-Fi-off run, `results/phase7b3/offline-live/20261109T154526/` (OVERALL PASS, 0 non-loopback connections) | Preserved; **predates the updated build** |
| **Updated build** | Full suite 402 / 402 (twice: §6.8 and §6.14); all TypeScript suites; 7B.3 focused 20 / 20; wire live test passed in each of 3 runs (focused, offline rerun, diagnostic) | Passing |
| **Updated build, dedicated benchmark** | Debug: warm median 39.3–39.5 ms; Release: 31.6–33.1 ms; P95 < 50 ms in all runs | **30 ms target NOT ACHIEVED** |
| **Current failures** | Updated-build Wi-Fi-off real-HUD rerun `offline-live/20261109T184956/` (HUD 3 / 17, OVERALL FAIL); diagnostic reproduction `hud-diagnostic/20261109T185648/` (HUD 3 / 17) | Cause established: model memory admission (§6.12); not fixed |

**Outstanding acceptance requirements**
1. A **17 / 17 Wi-Fi-off real-HUD run on the updated build** (0 non-loopback connections, offline before and after). It is blocked by memory admission on this machine; see the §6.12 proposals.
2. A decision on the **30 ms screen-capture target**, which is not achieved in Debug or Release.

**Verdict: Phase 7B.3 is NOT FULLY ACCEPTED.** Updated-build real-HUD/offline acceptance is **not claimed**. P1 (mouse) and P2 (keyboard/text) are **NOT IMPLEMENTED**; Phase 7B.4 has **not started**.

### 6.15 Acceptance preparation (authorized): memory preflight in the harness

Evidence: `results/phase7b3/acceptance-prep/20261109T191645/`. Nothing in the model supervisor, memory guard, model configuration, parser or execution logic changed.

- **`scripts/hud/approval-live-7b3.ps1`:** a memory preflight runs **after the real HUD has started and before the first task is sent**.
  - It evaluates the agent's **own** estimate and admission rule (built `dist/agent-host/…/inference/memory.js`: model estimate + the unchanged 2,000 MB headroom, with `os.freemem()` as the probe), so the harness cannot disagree with the guard.
  - It writes `memory-preflight.json` (available, estimate, headroom, required, decision).
  - If memory is insufficient, it aborts with the measured amount, e.g. "2957 MB available with the HUD running; the local model needs 2973 MB (estimate 973 MB + headroom 2000 MB). No task was sent." Every remaining check is then recorded as failed ("not run"), so **a refusal can never count as a pass**. It closes no application.
  - The 17 checks themselves are unchanged. The file stays ASCII with CRLF and parses under Windows PowerShell 5.1.
  - Function tests (`-LoadFunctionsOnly`): **7 / 7** pass. They cover the agent's own 973 + 2,000 = 2,973 MB rule, agreement with the guard on a real measurement, proceed when sufficient, refusal of the observed 2,957 MB with the amount reported, and fail-closed handling of inconsistent, missing and absent measurements.
- **`agent/host/stdioHost.ts`:** the model-supervisor status log can be enabled **alone** with `DASK_AGENT_MODEL_DIAGNOSTICS=1` (stderr only). The acceptance run uses this so that model startup and readiness are recorded while every protocol message to the HUD stays unchanged. `DASK_AGENT_DIAGNOSTICS=1` still enables it together with the progress diagnostics. `tsc` 0 errors; host-protocol 81 / 81; host rebuilt.
- **`scripts/hud/run-offline-acceptance-7b3.ps1`** (new, one command):
  - records available memory;
  - switches the Wi-Fi radio off (Windows radio API, no admin) and waits for the project's offline preflight;
  - runs the **unchanged** `offline-phase7b3.ps1`;
  - always restores the radio, also on failure or timeout.

  It corrects the two defects of my earlier ad-hoc wrapper (§6.11): the evidence folder name is built in PowerShell, and the exit code is now captured. Evidence goes to `results/phase7b3/acceptance-runs/<stamp>/`, and the acceptance evidence itself to `results/phase7b3/offline-live/<stamp>/`.

### 6.15a Wrapper failure at 19:22 and repair (acceptance NOT run)

Evidence of the failure: `results/phase7b3/acceptance-runs/20261109T192229/`. The wrapper logged 5,157 MB available, then failed on its first WinRT call (`Radio.RequestAccessAsync`, while reading the radio state): "Cannot convert … Task`1[RadioAccessStatus] … to type System.Type". `radioBefore` stayed null, so **the radio was never switched**, no acceptance ran and no `offline-live` folder was created.

**Root cause.** In `Await-WinRt($Op, [Type]$T)` the task was assigned to `$t`. PowerShell variable names are case-insensitive, so `$t` **is** the `[Type]`-constrained parameter `$T`, and PowerShell tried to convert the Task to `System.Type`. A minimal repro gives the identical error. The awaiter selection itself was correct: on Windows PowerShell 5.1.26100.9711 / CLR 4.0.30319.42000 the filter selects exactly one method, `AsTask[TResult](IAsyncOperation[TResult])`.

**Repair** (`scripts/hud/run-offline-acceptance-7b3.ps1`):
- `Await-WinRtOperation($Operation, [Type]$ResultType, …)` uses a distinct `$netTask`. The overload selection is asserted to be unique.
- The decision logic is now `Invoke-OfflineAcceptanceRun`, with every side effect injected:
  - it records the radio state before any change;
  - it marks the radio as "switched by us" **before** the switch call, so a call that fails half-way is still restored;
  - it **reads the radio back** and refuses to run acceptance unless it is Off **and** the project preflight confirms offline (120 s limit);
  - it records the radio state when acceptance finishes;
  - it restores the recorded state in `finally` (exceptions and timeouts included) and logs "Wi-Fi restore: SUCCEEDED / FAILED / not-needed / not-changed".
- Exit code 0 only if the radio was confirmed off, offline was confirmed, the script exited 0 without timeout, and the radio was still Off afterwards. Otherwise 1 or 3, or 4 when the acceptance passed but the restore failed.
- The memory preflight (2,973 MB with the HUD running, in `approval-live-7b3.ps1`), the 17 checks and the offline checks of `offline-phase7b3.ps1` are unchanged.

**Focused tests** (`scripts/hud/run-offline-acceptance-7b3.tests.ps1`; Windows PowerShell 5.1; evidence `results/phase7b3/acceptance-prep/wifi-helper-tests-20261109T192833/`): **21 / 21, exit 0.**
- **Real interop, read-only:**
  - the awaiter overload;
  - the `SetStateAsync` and `RequestAccessAsync` return types;
  - the 19:22 call now returning `Allowed`;
  - reading the Wi-Fi radio;
  - an AST check that no function reassigns a type-constrained parameter, plus a check that this detector catches the original pattern;
  - ASCII only.
- **Fakes:** happy path; failure during disable (before and after the switch); a radio that ignores the switch; offline never confirmed; acceptance exception, timeout and failure; radio back On during acceptance; restore failure; unreadable radio state; radio already Off. Every path restores, or deliberately does not, as specified.
- An earlier run of the same tests (`…wifi-helper-tests-20261109T192740/`, 19 / 20) failed only on a text-scan test that matched the explanatory comment; it was replaced by the AST check and is preserved. The radio was On after the tests.
- **Not yet exercised:** an actual `SetStateAsync` Off/On through the repaired code. It is verified by signature and by the shared awaiter, and is executed for real only in the next acceptance attempt.

### 6.16 Performance disposition (authorized): tracked separately from P0 functional acceptance

The 30 ms median and 50 ms P95 targets are **unchanged**, and the screen-capture implementation is unchanged.

| Area | Status | Evidence |
|---|---|---|
| Functional correctness of capture (captures succeed, pixel data, display/DPI, UIA, buffers) | **PASSING** (blocking) | `ScreenObservationTests` in the full suite, 402 / 402 (§6.8, §6.14) |
| Resource stability and cleanup (30 captures: buffers released once, managed memory, GDI and USER objects) | **PASSING** (blocking) | `RepeatedScreenCapture_ResourceStability_Test`: memory −100,824 bytes, GDI +0, USER +0 |
| Latency P95 < 50 ms | **ACHIEVED** | every dedicated run, Debug and Release (§6.9, §6.13): warm P95 45.2–47.4 ms |
| Latency median < 30 ms | **NOT ACHIEVED** | Debug warm median 39.3–39.5 ms; Release 31.6–33.1 ms; cold: 3 of 10 Release processes, 0 of 10 Debug |

**Disposition.** The median-latency shortfall is a **performance limitation, tracked separately from P0 functional acceptance**, in the dedicated benchmark (`tests/DAsk.Benchmarks.ScreenCapture`, exit code 1 while the target is missed). It is **not** claimed as achieved and is not hidden: it is reported here, in the benchmark's own output and in its exit code. Functional and resource-stability tests remain blocking in the correctness suite.

### 6.17 P0 re-acceptance alongside P1/P2 (2026-11-09 21:30–21:35, Wi-Fi off): PASS

The unchanged P0 acceptance ran again in the same offline window as the new guarded-input acceptance. Evidence: `results/phase7b3/offline-live/20261109T213055/`.
- Wire 1 / 1; real HUD **17 / 17**.
- Offline before and after; **0** non-loopback connections.

P0 window operations remain intact after the P1/P2 changes:
- P1/P2 gets its own per-task budget; the window-operation limit is unchanged at 1.
- The HUD grants foreground permission and pass-through only for the three input action types.

P1/P2 itself is documented in `docs/product-completion/CHECKPOINT.md` (batch 1c): real HUD 23 / 23 offline, `results/p1p2-hud/offline/20261109T213052/`. The complete daemon suite after all changes: 441 total, 440 passed, 1 skipped (opt-in live input test), 0 failed.

## 7. Performance (measured)

| Measurement | Value |
|---|---|
| Submit → approval at the HUD session | 5.6 s (model load included); 2.5–3.1 s warm |
| Approve → verified task result (minimize / restore) | 1,571 ms / 3,138 ms |
| Daemon: execute + verify | Win32 call < 1 ms; verification 0–1 ms (first observation already showed the state) |
| Emergency Stop → pending approval invalidated | 13 ms |

Almost all of the approve-to-result time is the AgentRuntime's own model-based assessment after the step, not the daemon. Emergency-Stop-to-silence during execution: each P0 operation is a single call, so there is no remaining trajectory to stop. A stop at the final gate refuses the call, as shown in unit tests; a live stop *during* the sub-millisecond call cannot be timed. CPU and memory overhead were not measured separately; the executor adds one Win32 call and up to 40 window reads per action.

## 8. Live HUD demonstration and offline evidence

- **Wire-level live test:** passed (§6). It used the real daemon, host and model, with the test playing the HUD's wire role exactly as in 7B.2.
- **Real HUD click-through: 17 / 17 passed** (`scripts/hud/approval-live-7b3.ps1`). The checks:
  - the request is typed into the real HUD and comes back as a new approval;
  - the approval shows every parameter and says the action will be performed;
  - guarded **APPROVE**: both logs show `approved=true`, the daemon executed once and verified, and the HUD shows "Minimized … Verified"; the OS shows the fixture minimized;
  - restore is approved and the OS shows the original rectangle;
  - guarded **DENY**: the executor is not called and the fixture is not maximized;
  - **STOP** while pending: the approval is invalidated, no decision is sent, the executor is not called and the fixture is not maximized; then **RESUME**;
  - a request naming no window is refused;
  - the final fixture state is checked independently.
- **Offline acceptance: PASS**, run with `offline-phase7b3.ps1`, evidence in `results/phase7b3/offline-live/20261109T154526/`:

  | Item | Result |
  |---|---|
  | Wi-Fi off | confirmed before and after |
  | Wire live test (`Category=Phase7B3Live`) | 1 / 1 |
  | HUD click-through | 17 / 17 (expected 17), not aborted, exit code 0 |
  | D-ASK processes observed | 5 |
  | Non-loopback connections by D-ASK processes | **0** |
  | OVERALL | **PASS** |

## 9. Not implemented (honest scope)

- **P1, guarded mouse execution: NOT IMPLEMENTED.** It needs coordinate approval and display, DPI conversion, per-event gates and the D-4 input hook decision (safety contracts §7). No mouse input exists in the daemon.
- **P2, guarded keyboard and text: NOT IMPLEMENTED.** It needs per-character gating, key-state neutralisation (contracts §7), and password, UAC and secure-desktop exclusion. No keyboard input exists in the daemon.
- **A dedicated append-only execution journal** (contracts §8) was not added. The existing append-only, hash-chained `safety_audit_trail` (7B.1a) is used, with a write-ahead record.

## 10. Known limitations and risks

- **Focus** is subject to Windows' foreground rules. It succeeded live here; if Windows refuses, the result is honestly `execution_unverified`.
- **Restore and maximize activate the window** (standard `SW_*` semantics), which can move the foreground away from the HUD.
- **Verification is observational:** it confirms the window *state*. An application that immediately reverses its own state would show up as unverified.
- **Daemon restart:** approvals live only in memory. A restart between approval and execution drops them, and nothing executes (7B.2 behaviour, tested).
- **Configuration:** `appsettings.json` enables execution. A deployment that should be approval-only must set `AgentHost:DesktopActionExecution=false`.

## 11. Acceptance verdict

**P0 is implemented and verified on the production path:**
- real agent request, real daemon authorization, real target identity and revalidation, a real Windows operation and independent verification;
- correct refusal on deny, Emergency Stop, epoch change, lease loss, cancellation, target change and missing journal;
- no false success; focused and regression tests as listed.

**Acceptance evidence that holds:**
- the real-HUD click-through passed 17 / 17;
- the Wi-Fi-off run passed with 0 non-loopback connections (`results/phase7b3/offline-live/20261109T154526/`, OVERALL PASS);
- the 7B.3 unit tests passed 19 / 19 and the 7B.3 live test 1 / 1, both inside the final full suite as well;
- the TypeScript suites, Rust and the page build pass.

**Final verdict: Phase 7B.3 is NOT fully accepted.** The completion criterion is a passing complete daemon suite, and it is not met. The latest run, after fix (a), was **402 total: 401 passed, 1 failed, exit code 1** (§6.3).

**Resolved: the Phase 7B.1b complete-suite timeout.**
- Root cause proven by a captured trace: the test client discarded the result of an instantly refused task because it arrived before the task's acknowledgement.
- Fixed in the test client, and proven by deterministic replay tests.
- The 7B.1b live test has passed in every complete-suite run since the fix (3 / 3).

**Implemented as authorized, but not sufficient:** fix (a), removal of exact duplicate window-action steps during plan validation (§6.2). It is correct and tested, but the live failure still occurs.

**Outstanding blocker** (§6.2): `Phase7B3LiveTests` intermittently ends `partial`, because the same window action is attempted a second time in one task, most likely by a second planning round.
- The action itself was executed once and verified, and safety held.
- The cause is not yet proven.

**Update (option (i), §6.4):** the cause is proven to be a second planning round that repeats the verified action (B). The 7B.3 live test also failed when run alone (19 / 20, `results/phase7b3/round-diag/20261109T170400-verify/`). Verdict unchanged: **NOT fully accepted.**

**Next step needed:** your decision on the proposed correction in §6.4, then another run of the complete daemon suite.

**P1 (mouse): NOT IMPLEMENTED. P2 (keyboard/text): NOT IMPLEMENTED.**

## 12. Post-closure addendum (2026-11-10)

The verdict in §11 is kept as written at the time. Later evidence, all recorded in `docs/product-completion/CHECKPOINT.md`:

- **P0 functional acceptance: PASS** (§6.17). Re-run on the updated build with Wi-Fi off: wire 1 / 1, real HUD 17 / 17, 0 non-loopback connections (`results/phase7b3/offline-live/20261109T193116/`). It passed again inside the full offline run `results/offline-full/20261110T133942` (P0 17 / 17).
- **P1 / P2: implemented after this report** (CHECKPOINT batches 1–1e). Guarded input 23 / 23 and multi-step 11 / 11, through the real HUD with Wi-Fi off.
- **Daemon suite:** 502 / 502 on 2026-11-10 (user-run, normal build, after note creation was added).
- **Note creation** (`notes.create`, action type `Files.CreateNote`, new after 7B.3; the same approval path as window operations):
  - real-HUD online 11 / 11 (`results/notes-hud/live-20261110T184729`);
  - real-HUD Wi-Fi off 11 / 11 (`results/offline-notes/20261110T185300`, wrapper `results/phase7b3/acceptance-runs/20261110T185250`);
  - **COMPLETED · INDEPENDENTLY VERIFIED** in the HUD; the artifact re-read byte for byte; duplicate and denial paths verified; 0 non-loopback TCP connections.
- **Still open from this report:** screen-capture median < 30 ms (§6.16, tracked separately).
