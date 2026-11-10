# Phase 7B.2: Approval-Connected Desktop Actions (approval only; no execution)

**Date:** 2026-11-09. **Scope:** Phase 7B.2 only. No desktop action can be performed: there is no executor. Phase 7B.3 has not started.
**Builds on:** [7B.0 protocol design §6.4–6.5, §10](phase-7b0-protocol-design.md), [7B.1a](phase-7b1a-remediation-report.md), [7B.1b](phase-7b1b-report.md).

## 1. Executive summary

A natural-language request now travels the full production approval path:

```
"Minimize the window titled …"
  → agent → protocol v2 call
  → daemon: resolves the window from the OS, applies policy, builds the exact canonical action bound to the identity
  → approval delivered to the task owner's HUD only
  → explicit decision
  → daemon validates it: owner, liveness, expiry, Emergency Stop, epoch, digest
  → daemon consumes the grant exactly once and revalidates the target
  → reply
```

The agent is told the request was approved and **not performed**. The live run on the real daemon process, real agent host and local model passed. Two items are open:
- **Clicking the rendered HUD was not run.** Another application on this machine owns the HUD's `Ctrl+Alt+Space` toggle, so the HUD cannot become interactive (section 9).
- **The Wi-Fi-off run is the user's to do** (section 8).

| Definition of done | Status |
|---|---|
| 1. Agent approval requests reach the real daemon | **Done**: live, real daemon process |
| 2. Daemon validates requests and authoritative identity | **Done**: unit and live |
| 3. Real approval requests reach the native HUD | **Partly.** They reach the HUD session over the real pipe (live), and the page's own parser renders them. The real `hud-native.exe` window was blocked by the hotkey conflict. |
| 4. HUD displays complete parameters | **Done at page level**: the page parser on the live request shows every parameter. Not seen on screen, because of the same block. |
| 5. Explicit decisions reach the daemon | **Done**: live, over the pipe in the HUD's wire format |
| 6. Daemon independently validates decisions | **Done** |
| 7. Lifecycle states correct and session-bound | **Done** |
| 8. Expiration, cancellation, replay, disconnect | **Done**: unit; replay, late decisions and tampering also live |
| 9. Emergency Stop invalidates pending requests | **Done**: unit and live (12 ms) |
| 10. No unauthorized desktop action can occur | **Done**: no executor exists; static scan; the live fixture was unchanged |
| 11. Focused security tests pass | **Done**: 29/29 daemon, 113/113 TypeScript |
| 12. Regression | see section 7 |
| 13. Offline verification | online loopback check passed (0 non-loopback connections); Wi-Fi-off run pending |
| 14. Evidence and report | this file; `results/phase7b2/` |

## 2. Architecture and data flow (ownership unchanged)

| Component | Role in 7B.2 |
|---|---|
| **TypeScript agent** | Tools `desktop.focus_window` and `desktop.set_window_state`. Arguments are limited to what the user named: application, quoted title, state. They are enforced in the output grammar and again before execution. The agent never supplies identity, approval or a decision, and never decides approval itself; this runtime's own approval gate is not used. It needs the new grant `request:desktop_action`; it holds no `desktop:actuate`. |
| **Protocol v2** | Unchanged format. The two tools are offered only when `AgentHost:DesktopActionRequests` is true (the default). Calls are given the approval deadline, at most 35 s, instead of the 6 s read cap. A task can make **one** approval request; a second gets `action_limit`. |
| **Daemon** `DesktopActionRequestService` (new) | Validates args strictly. Refuses during Emergency Stop. Resolves the target with the 7B.1b resolver (OS identity; ambiguous, missing, sensitive or D-ASK targets refused). Requires complete identity. Applies policy (`Desktop.*` is Elevated, approval required). Builds the request with the owner session taken from the daemon's task record and the epoch from the engine. Calls the existing `ActionPolicyEngine.RequestApprovalAsync`. On approval: `ValidateConsumedApproval` (single use), then OS identity revalidation, then an audit record, then a reply with `executed:false`. **It holds no executor.** |
| **ActionPolicyEngine** (existing, reused) | Registration, owner-only delivery event, TTL clamp to 30 s, refusal of unrepresentable or secret-like requests, digest, liveness gate, decision validation, one-time consumption, invalidation on Stop, disconnect and lease loss. |
| **NamedPipeServer / IpcClientSession / HudLivenessMonitor** (existing) | Owner-only delivery; the decision comes from the authenticated session; invalidation on disconnect and on lease loss. |
| **HUD page** | Renders only from the daemon's canonical action (7B.1a). Adds labels for `Desktop.FocusWindow` and `Desktop.SetWindowState`, the process start time, and an "Approval only: D-ASK cannot act on windows in this version" notice. |

**Operation names** follow the 7B.0 design: `desktop.focus_window` maps to `Desktop.FocusWindow`, and `desktop.set_window_state` with state `minimize`, `maximize` or `restore` maps to `Desktop.SetWindowState`. Move and resize were not added. The design defers them, and they would take coordinates, which the design rules out for the model.

## 3. Approval protocol

- **Call:** `{"v":2,"kind":"call","callId":"cN","taskId":…,"tool":"desktop.set_window_state","args":{"process"?:…,"titleContains"?:…,"state":"minimize|maximize|restore"},"deadlineMs":≤35000}`. Any other argument key, including `hwnd`, `pid`, `sessionId`, `approvalId`, `approved` or a digest, is `invalid_args`.
- **The approval** is the existing `ActionApprovalRequest`:
  - target fields: HWND, PID, process creation time, process name, window title;
  - context: owner session, stop generation, risk `Elevated`, creation and expiry (≤ 30 s), reason (without the title; see section 4);
  - parameters, all shown and all bound into the digest: `operation`, `state`, `window`, `application`, `imagePath`, `windowClass`, `processStarted`, `logonSession`, `display`, `reversible`, `execution` ("Not performed …");
  - the daemon-computed `canonicalAction` (DASK-CJ-1) and `actionDigest` (SHA-256, domain-separated). The HUD must echo the digest.
- **Reply on approval:** `{"decision":"approved","consumed":true,"identityRevalidated":true,"executed":false,"executionAvailable":false,…}`.
- **Error codes:**

| Code | Meaning |
|---|---|
| `approval_denied` | The user declined |
| `approval_expired` | No decision before expiry |
| `emergency_stopped` | Stop was active, or the epoch changed |
| `hud_unavailable` | The HUD disconnected or lost its lease |
| `approval_refused` | Unrepresentable request, or a digest or hash mismatch |
| `approval_invalid` | Consumption failed |
| `target_changed` / `target_disappeared` | Identity failed after approval |
| `target_not_found` / `ambiguous_target` / `target_forbidden` / `identity_uncertain` | The target could not be resolved safely |
| `policy_denied` | The policy refused the action type |
| `action_limit` | A second approval request in the same task |
| `cancelled` | The call was cancelled |

- **Agent outcome:** every reply, approved included, is reported as *not done*. "You approved …, and D-ASK validated your approval, but did not perform it … Nothing on screen changed." The task is never `completed`, and a re-plan cannot ask the user again.

## 4. Security boundaries (each tested)

- **Authority stays in the daemon.**
  - The agent cannot supply identity, approval or decision fields (TS A6, daemon theory test).
  - The owner session comes from the task record (wire test).
  - Only the owner session can decide (`OnlyTheOwnerSessionCanDecide`).
- **Binding.**
  - The digest is deterministic and injective (`Digest_IsInjective…`).
  - A decision must echo the daemon's digest and hash; a mismatch is rejected (unit; live: `Rejected`).
- **Single use.** Consumption is atomic. Replay, duplicate and late decisions are rejected (unit; live: duplicate and late both `DecisionAccepted:false`).
- **Invalidation.**
  - Each of these invalidates a pending approval, and none comes back after reconnect: Emergency Stop before, during or at the decision (live: 12 ms to invalidated); epoch change; HUD disconnect; lease loss before or during; cancellation; expiry.
  - Daemon restart: approvals live only in memory and vanish (`DaemonRestart_…`).
- **Target.**
  - Ambiguous, missing, sensitive, D-ASK-owned and incomplete-identity targets never produce an approval.
  - A process replaced or an HWND reused between request and approval gives `target_changed`; a window that is gone gives `target_disappeared`. The grant is consumed either way and can never be used.
- **Display.** A title containing bidirectional overrides or control characters is never offered (`approval_refused`). Secret-like parameter names are refused by the existing rules.
- **Privacy (fixed in this phase).** The approval `Reason` is written to the audit trail by the policy engine. Window titles were first included there; they are now excluded, and the audit trail holds only bounded identity fields (`Audit_…` asserts that the title is absent).
- **No actuation:**
  - `DesktopActionRequestService`, `AgentHostDesktopCalls`, `desktop.ts` and `desktopBridge.ts` contain no input, focus, window-state, process or file-write API, and no reference to the execution engine (static scan).
  - The constructor test confirms there is no executor dependency.
  - The live fixture was never focused, minimized, maximized or moved.

## 5. Target identity validation

The identity is the 7B.1b model: HWND, PID, thread, process creation FILETIME, canonical image path, class, logon session, display and DPI.
- It is resolved by the daemon at request time.
- It is bound into the approval: HWND, PID and creation time in the target block; image, class, session and display as displayed parameters.
- It is re-read from the OS after consumption. Any difference in PID, creation time, image, class or thread fails.

Foreground identity is not part of these operations' preconditions in 7B.2. It belongs to the 7B.3 executor's checks.

## 6. HUD behaviour

- Ambient/Interactive/Hidden modes, hotkeys, Emergency Stop and the 1-second arm delay are unchanged.
- The panel renders from `canonicalAction` and shows:
  - operation, application and window, PID, HWND, process start time;
  - every parameter, including image path, class, session, display, reversibility and the "not performed" statement;
  - risk, the expiry countdown, and the digest as a technical detail;
  - a blue "Approval only" notice.
- The page's own parser, run on a live daemon request, produced a view containing every parameter (live test output).
- The page was rebuilt (`next build`). The Rust HUD was not changed in 7B.2.

## 7. Tests (actual results, 2026-11-09)

| Command | Result |
|---|---|
| `dotnet test … --filter FullyQualifiedName~Phase7B2Tests` | **29 / 29** |
| `dotnet test … --filter Category=Phase7B2Live` | **1 / 1**, run three times: once directly, twice under the network monitor |
| `dotnet test … --filter FullyQualifiedName~Phase7B1bTests` | 40 / 40 |
| `dotnet test tests/DAsk.Daemon.Tests` (full, final code) | **376 passed, 2 failed** of 378. Both are known timing tests that 7B.2 does not touch: the capture-latency benchmark (59 ms median vs a 30 ms budget, as in 7B.1b) and `ExecutionEngineCorrectnessTests.Test09`, which passed 3/3 alone and is the load-sensitive test noted in 7B.1a. |
| All live tests together (`Category=Phase5Live\|Phase7B1bLive\|Phase7B2Live`) | **4 / 4** |
| `cargo test` (src/hud-native; unchanged) | 53 passed, 1 ignored |
| `npx tsx tests/agent-runtime/desktop.test.ts` | **113 / 113** (7B.1b cases plus 22 new 7B.2 cases) |
| host-protocol, experimental, agent-runtime, grounding, filesystem, offline, local-inference | 81, 31, 165, 77, 184, 23, 95: all passing |
| approval-lifecycle (page), native-agent | 46 / 46, 92 / 92 |
| `scripts/hud/approval-live-7b2.ps1` (real HUD, clicked) | **Not executed: blocked.** Ctrl+Alt+Space is held by another application (section 9) |

Three 7B.1b TypeScript expectations were changed on purpose:
- "Focus the Excel window" and "please minimize the Chrome window" are now approval requests rather than refusals.
- The tool list now has four tools.

Close, type, click, scroll, resize and launch are still refused.

In the first full run, the 7B.1b live test failed its clean-start precondition: the previous live test's `llama-server` was still exiting. The 7B.1b and 7B.2 live tests now wait up to 15 s for a lingering model server to exit before asserting a clean start. They never kill it. After the change, all live tests passed together (4/4).

## 8. Performance (measured, live, real daemon/host/model)

| Measurement | Value |
|---|---|
| Submit → approval at the HUD session (model load included) | 7,433 ms |
| Submit → approval, model loaded | 2,348–4,208 ms (three requests) |
| Deny → daemon confirmation (state notification) | 92 ms; → task result 115 ms |
| Approve → daemon confirmation | 37 ms; → task result (consumed, revalidated) 64 ms |
| Emergency Stop → approval invalidated | 12 ms; → task ended 15 ms |
| Approval envelope size | 3,331–3,399 bytes |

Almost all of the submit-to-approval time is local model planning. In the daemon log, the policy engine registered the approval 20 ms after the call's audit record. No thresholds were changed.

## 9. Offline verification

- **Online loopback check (not an offline test):** `scripts/hud/offline-phase7b2.ps1 -OnlineLoopbackCheck` → `results/phase7b2/online-loopback-check/20261109T032255/`.
  - The wire live test passed under the monitor.
  - The monitor saw `DAsk.Daemon`, `llama-server` and the HUD process.
  - It recorded **0 non-loopback connections**.
- **Harness defect found and fixed.** An earlier check (`…/20261109T032054/`) recorded one `node` → 104.16.0.34:443 connection.
  - The test's own `npx tsx` call (the page-parser check) was the source: `tsx` is not installed locally, so npx contacted the registry.
  - The helper now runs with plain `node`, which strips TypeScript types itself, and the monitor records each connection's command line.
  - The rerun recorded 0. The D-ASK agent host was not the source.
- **Not executed: the Wi-Fi-off run.** It needs the user to turn Wi-Fi off. Run `powershell -ExecutionPolicy Bypass -File D:\D-ASK\D-ASK\scripts\hud\offline-phase7b2.ps1`. It refuses to run while online, runs the wire live test and then the HUD click-through, and writes `results/phase7b2/offline-live/<stamp>/`.
- **Blocker for the HUD click-through.** The HUD log reads "Could not register Ctrl+Alt+Space; another application may own it", and a direct `RegisterHotKey` probe confirmed the chord is taken. By design, the HUD becomes interactive only through that hotkey; the page can only lower interaction. Requests cannot be typed while it is ambient. Windows has no API to name the owner of a hotkey, and unrelated processes were not stopped. Closing the application that uses Ctrl+Alt+Space and running the offline script completes items 3 and 4 on screen.

## 10. Files changed in Phase 7B.2

- **Daemon:**
  - `src/DAsk.Daemon/Automation/Desktop/DesktopActionRequestService.cs` (new).
  - `src/DAsk.Daemon/Automation/Desktop/DesktopReadService.cs`: target resolution shared through `ResolveTarget`, `ValidateSelector` and `ReadNow`; no behaviour change.
  - `src/DAsk.Daemon/Automation/Policy/ActionPolicyEngine.cs`: `Desktop.*` policy entries and `DesktopActionTypes`.
  - `src/DAsk.Daemon/AgentHost/AgentHostDesktopCalls.cs`: action tools in negotiation, the approval deadline, owner context, the one-per-task limit.
  - `src/DAsk.Daemon/AgentHost/AgentHostManager.cs`: the `DesktopActionRequests` option, the constructor parameter, `ActionRequests`.
  - `src/DAsk.Daemon/Program.cs`: registrations.
- **Agent:**
  - `agent/runtime/tools/desktop.ts`: window-operation tools, request checks, clarification, refusal wording.
  - `agent/runtime/types.ts`: `request:desktop_action`.
  - `agent/host/stdioHost.ts`: the grant, only with the bridge.
  - `agent/host/desktopBridge.ts`: deadline up to 60 s; the daemon clamps it.
- **HUD page:** `hooks/approvalLifecycle.ts` (labels, `approvalOnly`, `processStarted`); `components/ApprovalSurface.tsx` (start time, notice). `.next` was rebuilt.
- **Tests:**
  - `Phase7B1bLiveTests.cs`: waits for a lingering model server before the clean-start check.
  - New: `tests/DAsk.Daemon.Tests/Phase7B2Tests.cs`, `Phase7B2LiveTests.cs`, `tests/hud-agent/fixtures/parse-approval.ts`.
  - `Phase7B1bTests.cs`: the fakes made `internal` for reuse.
  - `tests/agent-runtime/desktop.test.ts`: the [A] section, plus updated expectations.
- **Scripts:** `scripts/hud/approval-live-7b2.ps1`, `scripts/hud/offline-phase7b2.ps1` (new).
- **Evidence:** `results/phase7b2/online-loopback-check/` (new).

## 11. Known limitations and unresolved risks

- On-screen HUD verification is blocked by the hotkey conflict (section 9). The wire format, the page parser and the panel component are each tested, but they have not been exercised together in the real window during 7B.2.
- No Wi-Fi-off run yet.
- Approvals are memory-only, by design. A daemon restart drops them, and the task dies with the host.
- The action cannot be executed in this version. Approving consumes the grant, so the user has to approve again once 7B.3 exists. Each task asks at most once.
- The model chose the tool correctly in all four live requests, but tool choice by the 0.5B model is not guaranteed. Grounding and argument domains stop a wrong call from reaching the daemon (TS A5 and A5b).
- The audit trail records image paths and window classes (bounded) but no titles. Approval parameters, titles included, are held in memory only and shown only to the owner's HUD.
- Pre-existing, unchanged: the capture-latency benchmark fails its 30 ms budget on this machine (see the 7B.1b report).

## 12. Acceptance verdict

**Phase 7B.2 is accepted for the pathway the daemon owns.** That covers:
- agent request, daemon validation and identity, policy, owner-only delivery, decision validation, single use and revalidation;
- the lifecycle (expiry, cancellation, replay, disconnect, lease, epoch, Emergency Stop, restart);
- the audit trail, and the absence of any actuation.

Each was verified by tests and by a live run on the real daemon, host and model.

**Not yet accepted:**
- **Items 3 and 4 on screen.** The click-through in the real HUD window has not run, because another application holds Ctrl+Alt+Space.
- **The Wi-Fi-off run (item 13).** It has not been executed.

Both are one user action: free the hotkey, turn Wi-Fi off, run `scripts\hud\offline-phase7b2.ps1`. Until that run passes, the phase is not fully complete. Phase 7B.3 has not been started.
