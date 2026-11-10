# Phase 7B.0: Safety Contracts

**Status:** design only. No source, binary, database or configuration was changed to produce this document.
**Date:** 2026-11-08. **Scope:** Phase 7B.0. Nothing here enables desktop actuation.
**Companion documents:** [protocol design](phase-7b0-protocol-design.md), [threat model](phase-7b0-threat-model.md), [test specification](phase-7b0-test-specification.md).

> **Status update, Phase 7B.1a (2026-11-08):** F1 and F2 (lease), F3 (hash), F5 (TTL clamp), F7 (display), F8 (dismissal), F9 (Ambient surface), F10 (legacy message), F11 (owner-only delivery for approvals) and F12 (audit) are remediated. The approval sender (F15) now delivers to the owner, but nothing in production creates approvals yet. F4 (zero-identity checks), F6 (reapers), F13, F14, F16–F18 remain open. See [phase-7b1a-remediation-report.md](phase-7b1a-remediation-report.md).

> **Status update, Phase 7B.1b (2026-11-09):** read-only desktop intelligence is implemented: protocol v2 (`call`, `call.cancel`, `reply`) over the existing stdio pipes, and `desktop.list_windows` and `desktop.inspect_window` under the new `read:desktop` permission. For the read-only path, F4 (zero or missing identity is rejected, and identity is revalidated from the OS) and the observation failure model F16 (capture and UI Automation failures are reported, never presented as success; freshness and expiry; `atomic:false`) are addressed. No actuation exists. See [phase-7b1b-report.md](phase-7b1b-report.md).

Key words MUST, MUST NOT and SHOULD are used as in RFC 2119. Every claim about existing code cites `file:line` and was checked by reading that file in this phase. "Verified" means *read*, not *executed*: no test was run for this document.

---

## 1. Verified current state

Status values: **IV** implemented and verified (a test exists and a historical pass is documented), **INV** implemented but not verified, **P** partially implemented, **M** missing.

### 1.1 What exists

| # | Component | Status | Evidence |
|---|---|---|---|
| E1 | Native Emergency Stop latch: coalescing, monotonic generation, resume invalidated by any stop, daemon reconcile | **IV** | [emergency_stop.rs:66-116](../../src/hud-native/src/state/emergency_stop.rs#L66-L116), `reconcile_from_daemon` `:120-139`, `try_resume` `:218-270`; 9 unit tests `:278-531` |
| E2 | Daemon Emergency Stop: latch, epoch increment, shared-token cancel, queue drain, approval invalidation, idempotent by stop id, audit | **IV** | [ActionExecutionEngine.cs:138-275](../../src/DAsk.Daemon/Automation/Execution/ActionExecutionEngine.cs#L138-L275); tests in `ExecutionEngineCorrectnessTests`, `ResumeGeneration*Tests`, `SafetyRemediationTests` |
| E3 | Final authorization point under `_stateLock`: stop, hotkey availability, epoch, policy, approval consumption | **IV** | [ActionExecutionEngine.cs:682-826](../../src/DAsk.Daemon/Automation/Execution/ActionExecutionEngine.cs#L682-L826) |
| E4 | Stop pushed to the agent host; an unacknowledged stop kills the host's process tree | **IV** | [AgentHostManager.cs:542-558](../../src/DAsk.Daemon/AgentHost/AgentHostManager.cs#L542-L558); `AgentHostManagerTests` |
| E5 | Session teardown cancels the session's actions, tasks and approvals | **IV** | [IpcClientSession.cs:157-186](../../src/DAsk.Daemon/IPC/IpcClientSession.cs#L157-L186) |
| E6 | Approval cache: owner session from the transport (never the payload), TTL timer, epoch check, parameter-hash check, exactly-once consume, replay set | **IV** | [ActionPolicyEngine.cs:269-436](../../src/DAsk.Daemon/Automation/Policy/ActionPolicyEngine.cs#L269-L436), `:476-615`; 27 approval tests |
| E7 | Pipe peer verification: PID, process creation time, canonical image path, SID, logon session, PID-reuse race checks | **IV** | [PipePeerVerification.cs:48-206](../../src/DAsk.Daemon/IPC/PipePeerVerification.cs#L48-L206); `PipePeerVerifierTests` (17) |
| E8 | Reusable process-identity primitives (`GetProcessTimes`, `QueryFullProcessImageNameW`, `ProcessIdToSessionId`, canonical path) | **IV** (as used for the pipe) | [PipePeerVerification.cs:208-295](../../src/DAsk.Daemon/IPC/PipePeerVerification.cs#L208-L295). `internal static` in the daemon assembly, so reusable without a visibility change |
| E9 | Agent-host stdio: per-launch token, strict unknown-field rejection, 64 KiB request cap, kill on protocol violation | **IV** | [protocol.ts:67-126](../../agent/host/protocol.ts#L67-L126), [AgentHostManager.cs:831-858](../../src/DAsk.Daemon/AgentHost/AgentHostManager.cs#L831-L858), `:636-640` |
| E10 | Task record carries owner session and host instance epoch | **IV** | [AgentHostManager.cs:67-76](../../src/DAsk.Daemon/AgentHost/AgentHostManager.cs#L67-L76), epoch check `:572` |
| E11 | Rust agent bridge: frontend can send only an objective or a task id; ids validated; stale requests fail rather than replay | **IV** | [agent_bridge.rs:1-142](../../src/hud-native/src/ipc/agent_bridge.rs#L1-L142), 10 tests `:144-247` |
| E12 | Panic hotkey: `RegisterHotKey` Ctrl+Shift+F12 on a dedicated message-loop thread; failed registration latches Stop; availability re-announced on every connect | **INV** for the press path | [main.rs:1025-1165](../../src/hud-native/src/main.rs#L1025-L1165), [client.rs:296-304](../../src/hud-native/src/ipc/client.rs#L296-L304). Only the thread shutdown has a unit test (`main.rs:1180`); the scripts `scripts/hud/walkthrough.ps1`, `overlay-tests.ps1` and `orb-clickthrough-tests.ps1` mention the hotkey (not re-run, not inspected in detail) |
| E13 | Priority control channel and write timeouts so a stop is never queued behind ordinary traffic | **IV** | [client.rs:343-411](../../src/hud-native/src/ipc/client.rs#L343-L411), tests `:534-760` |
| E14 | Frame transport: unnamed section, read-only handle duplicated into the verified client | **IV** | [ObservationBufferManager.cs:92-110](../../src/DAsk.Daemon/Automation/Observation/ObservationBufferManager.cs#L92-L110), `:207-215` |
| E15 | Evidence recorder with parameterised SQL | **IV** (2 tests) | [SqliteEvidenceRecorder.cs:110-264](../../src/DAsk.Daemon/Research/SqliteEvidenceRecorder.cs#L110-L264); `ResearchEvidenceTests` (2) |

### 1.2 What is missing or defective (new findings of this phase)

| ID | Finding | Status | Evidence |
|---|---|---|---|
| F1 | `_panicHotkeyAvailable` is one global flag set by the HUD. Nothing clears it when the HUD disconnects, so after HUD death the daemon still believes a panic hotkey exists | **Defect** | [ActionExecutionEngine.cs:41](../../src/DAsk.Daemon/Automation/Execution/ActionExecutionEngine.cs#L41), `:106-136`; only caller [IpcClientSession.cs:567-575](../../src/DAsk.Daemon/IPC/IpcClientSession.cs#L567-L575); disconnect path `:157-186` does not touch it |
| F2 | The daemon never enforces HUD liveness. It answers `HeartbeatPing` but records nothing; `HeartbeatIntervalMs` is declared and never read. A suspended (not crashed) HUD keeps its pipe open forever | **Missing** | [IpcClientSession.cs:291-301](../../src/DAsk.Daemon/IPC/IpcClientSession.cs#L291-L301), [DaemonOptions.cs:9](../../src/DAsk.Daemon/Configuration/DaemonOptions.cs#L9); HUD pings every 5 s [client.rs:317-373](../../src/hud-native/src/ipc/client.rs#L317-L373) |
| F3 | The canonical parameter hash is not injective: entries are joined as `key=value\n`, so `{a:"1", b:"2"}` and `{a:"1\nb=2"}` produce identical bytes | **Defect** | [ActionPolicyEngine.cs:62-80](../../src/DAsk.Daemon/Automation/Policy/ActionPolicyEngine.cs#L62-L80) |
| F4 | Target identity checks are skipped when either side is zero, null or empty (HWND, PID, creation time, process name). Both sides are client-supplied; nothing is re-read from the OS | **Defect (fail-open)** | [ActionPolicyEngine.cs:570-600](../../src/DAsk.Daemon/Automation/Policy/ActionPolicyEngine.cs#L570-L600) |
| F5 | The approval TTL is chosen by the caller (`ExpiresAtUtc`) with no maximum. A non-positive remaining TTL gets a fresh 30 s timer, though the decision-time check still rejects it | **Weak** | [ActionPolicyEngine.cs:199-202](../../src/DAsk.Daemon/Automation/Policy/ActionPolicyEngine.cs#L199-L202), `:311` |
| F6 | `_grantedApprovals` entries are removed only on consume or invalidation (never reaped on expiry); `_consumedApprovals` is never pruned | **Unbounded growth** | [ActionPolicyEngine.cs:49-50](../../src/DAsk.Daemon/Automation/Policy/ActionPolicyEngine.cs#L49-L50), `:394`, `:610` |
| F7 | The approval modal shows type, process name, HWND, risk, reason and the SHA-256, but **not the parameters** (`actionParameters` is in the payload and unused) or the window title | **Gap** | [JarvisOrb.tsx:1274-1283](../../components/JarvisOrb.tsx#L1274-L1283); payload struct [protocol.rs:298-316](../../src/hud-native/src/ipc/protocol.rs#L298-L316) |
| F8 | The modal is dismissed only by an Emergency Stop event and its own 30 s countdown. A daemon-side cancel, expiry or session loss leaves it clickable | **Gap** | [JarvisOrb.tsx:351-353](../../components/JarvisOrb.tsx#L351-L353), `:269-283` |
| F9 | In Ambient mode the HUD is click-through, and the page can only lower interaction, never raise it. An approval raised in Ambient cannot be clicked until the user presses Ctrl+Alt+Space. Entering Interactive takes the foreground and leaving restores the previous window, so foreground changes around every approval | **Design constraint** | [overlay.rs:11-15](../../src/hud-native/src/overlay.rs#L11-L15), `:64-66`, `:303-315`, `:336-347` |
| F10 | `TaskApproval`, `UserCommand` and `TaskCancel` are sent by the Rust bridge but the daemon has no handler (`EnvelopeReceived` has no subscriber): they are silently dropped | **Dead legacy path** | [main.rs:700-732](../../src/hud-native/src/main.rs#L700-L732), [IpcClientSession.cs:615-617](../../src/DAsk.Daemon/IPC/IpcClientSession.cs#L615-L617) |
| F11 | `ActionLifecycleNotification` is broadcast to every authenticated session. A per-owner sender (`SendToOwner`) already exists | **Pattern to reuse** | [NamedPipeServer.cs:77-85](../../src/DAsk.Daemon/IPC/NamedPipeServer.cs#L77-L85), `:97-100` |
| F12 | Audit writes are fire-and-forget (`_ = RecordSafetyAuditAsync`). The table uses `INSERT OR REPLACE`, has no chain, and `details_json` is built by string interpolation from caller-influenced text | **Weak** | [ActionExecutionEngine.cs:1030-1040](../../src/DAsk.Daemon/Automation/Execution/ActionExecutionEngine.cs#L1030-L1040), [ActionPolicyEngine.cs:189](../../src/DAsk.Daemon/Automation/Policy/ActionPolicyEngine.cs#L189), [SqliteEvidenceRecorder.cs:232](../../src/DAsk.Daemon/Research/SqliteEvidenceRecorder.cs#L232) |
| F13 | `ExecutionEvidenceRecord` (with pre/post observation and verification fields) is used only by the model benchmark. The database sits beside the binaries | **Unused schema** | [LlamaModelRuntime.cs:440](../../src/DAsk.Daemon/ModelRuntime/LlamaModelRuntime.cs#L440), [Program.cs:78-83](../../src/DAsk.Daemon/Program.cs#L78-L83) |
| F14 | No agent-to-daemon request channel. The daemon treats any unknown `kind` from the host as a violation and kills it | **Missing** | [AgentHostManager.cs:852-857](../../src/DAsk.Daemon/AgentHost/AgentHostManager.cs#L852-L857); host rejects unknown fields [protocol.ts:95-97](../../agent/host/protocol.ts#L95-L97) |
| F15 | No daemon sender of `ActionApprovalRequest`; `RequestApprovalAsync` is called only from tests | **Missing** | search of `src/DAsk.Daemon`: only the type reference at `ActionPolicyEngine.cs:20,129` |
| F16 | Observation: capture failure reported as success, non-atomic, may capture the wrong display, no age or expiry, no window enumeration, positional UIA ids | **Defects / missing** | [Win32ScreenObservationService.cs:321-436](../../src/DAsk.Daemon/Automation/Observation/Win32ScreenObservationService.cs#L321-L436): second `BitBlt` unchecked `:388`, `Success = true`; display chosen `:330-337` before the window is known `:417`; UIA children only, `elem_{i}` ids [WindowsUiAutomationService.cs:310](../../src/DAsk.Daemon/Automation/Observation/WindowsUiAutomationService.cs#L310), `:324`; no `EnumWindows` anywhere in `src` |
| F17 | The executor performs no real input: the "execution" is `Task.Delay` | **Missing (intended)** | [ActionExecutionEngine.cs:838-843](../../src/DAsk.Daemon/Automation/Execution/ActionExecutionEngine.cs#L838-L843) |
| F18 | The TypeScript host has no approval gate; the daemon and host approval systems are not connected | **Missing** | [stdioHost.ts:83](../../agent/host/stdioHost.ts#L83); [protocol.ts:11-13](../../agent/host/protocol.ts#L11-L13) |

### 1.3 Corrections to the readiness audit

None of the earlier audit conclusions were wrong. Three need sharpening: the fail-open identity checks (F4) are also unanchored to the live OS; the approval flow lacks a sender (F15), a display of parameters (F7) and a dismissal path (F8); and the "single point of failure" for the panic hotkey is wider than the hotkey (F1, F2).

---

## 2. Security invariants

Every future 7B change MUST preserve these. Each is testable and has a test ID in the [test specification](phase-7b0-test-specification.md).

| ID | Invariant |
|---|---|
| SI-1 | **Authorization is never inferred from content.** No text from a window, page, document, UIA tree, tool output or model can create, extend or satisfy an approval. |
| SI-2 | **One approval authorizes one exact operation on one exact target.** It never authorizes a sequence, a retry, a "similar" action or a later action. |
| SI-3 | **The daemon builds the operation.** The approval request, the canonical action and the action id are constructed by the daemon from its own live resolution. The agent host supplies a selector, never an identity, an action id or an approval id. |
| SI-4 | **The daemon executes only what was shown.** Execution uses the daemon-held canonical action referenced by the approval. Nothing the caller re-supplies at execution time is trusted. |
| SI-5 | **Fail closed.** Any missing, zero, empty, stale, mismatched, unparseable or unverifiable input to a decision denies the operation. |
| SI-6 | **No input after Stop.** Once Emergency Stop is latched, no input event begins. The only input permitted afterwards is the release of keys and buttons the executor itself holds down. |
| SI-7 | **Approvals are single-use and short-lived.** Consumed exactly once; maximum lifetime 30 s, enforced inside the policy engine, not by the caller. |
| SI-8 | **The target is re-read from the OS immediately before the first input and before every input batch.** Approval-time identity is a claim, not a fact. |
| SI-9 | **Audit before act.** The execution-admitted record is durably committed before the first input event. If it cannot be written, nothing runs. |
| SI-10 | **Completion is never self-certified.** "Executed" and "verified" are separate facts. The daemon verifies against live state; the model's opinion has no weight. |
| SI-11 | **Observations are data, not instructions.** Text read from the desktop is returned to the agent as untrusted data and never becomes a tool argument or a target without passing the request checks. |
| SI-12 | **The agent host is untrusted for authorization.** It holds no approval capability, cannot name a session, and cannot approve. Losing it cancels everything it requested. |
| SI-13 | **Local only.** No network path, no cloud dependency, no new listener. |
| SI-14 | **Liveness is a lease.** Actuation requires a fresh HUD heartbeat; losing it cancels. |
| SI-15 | **The daemon never targets itself.** Actions on D-ASK's own processes are refused. |
| SI-16 | **Sensitive controls are refused.** Password fields and any control whose sensitivity cannot be established are never typed into or read. |
| SI-17 | **Stop does not weaken.** Nothing in 7B alters the existing latch, epoch, hotkey or acknowledgement semantics. 7B adds checks; it removes none. |

---

## 3. Target identity contract

### 3.1 Principles

1. **The agent names, the daemon identifies.** The agent supplies a *selector* derived from the user's request. The daemon resolves it against live OS state into a *window identity*. An identity is never accepted from the agent or the model.
2. **No guessing.** Zero candidates give `target_not_found`. More than one gives `ambiguous_target` with a bounded candidate summary. The daemon never picks by z-order, recency, list order or first match. (This mirrors the Phase 7A file policy.)
3. **Pin the process.** Holding a process handle pins the PID, the technique already used for the pipe peer ([PipePeerVerification.cs:75-93](../../src/DAsk.Daemon/IPC/PipePeerVerification.cs#L75-L93)).

### 3.2 Window identity fields

| Field | Source | Required | Notes |
|---|---|---|---|
| `hwnd` | enumeration | **Mandatory, non-zero** | Window handle value |
| `pid` | `GetWindowThreadProcessId` | **Mandatory, non-zero** | |
| `processCreationFileTime` | `GetProcessTimes` on a handle the daemon holds | **Mandatory, non-zero** | Distinguishes a reused PID |
| `imagePath` | `QueryFullProcessImageNameW`, canonicalised | **Mandatory, non-empty** | Case-insensitive compare on the canonical form |
| `windowClass` | `GetClassName` | **Mandatory, non-empty** | |
| `processSessionId` | `ProcessIdToSessionId` | **Mandatory; must equal the daemon's session** | Cross-session targets refused |
| `threadId` | `GetWindowThreadProcessId` | Supplementary | Part of the digest; mismatch is `target_changed` |
| `titleSha256` | `GetWindowText` | Supplementary | See 3.4 |
| `ownerHwnd`, `style class bits` | `GetWindow(GW_OWNER)`, `GWL_STYLE` | Supplementary | Part of the digest |
| `integrityLevel` | process token | Mandatory for actuation | Must not exceed the daemon's |

### 3.3 Control identity (input tools)

| Field | Required | Notes |
|---|---|---|
| `uiaRuntimeId` (int[]) | Supplementary, preferred | Valid while the element exists |
| `automationId` | One of `automationId` or `name` is mandatory | |
| `controlType` | Mandatory | |
| `name` | One of `automationId` or `name` is mandatory | |
| `controlPathHash` | Mandatory | Hash of the ancestor chain (control type, name, automation id) up to the window |
| `isPassword` | Mandatory to read; `true` refuses typing | If it cannot be read, typing is refused (SI-16) |

Resolution MUST yield exactly one element. Zero gives `target_not_found`, several give `ambiguous_target`.

### 3.4 Rules

1. **Incomplete identity is rejected at construction** (`identity_incomplete`) and again at consume. A zero or empty mandatory field is never "skipped". This replaces the fail-open conditions in F4 for all `Desktop.*` action types.
2. **Revalidation (SI-8)** re-reads: `IsWindow`; PID; a held process handle with an unexited process; creation time; canonical image path; class; session; thread; owner; visible and not cloaked (`DWMWA_CLOAKED`); not hung (`IsHungAppWindow`); integrity level; and the title rule below. Any mismatch is `target_changed`.
3. **Title rule.** Window-state tools (focus, minimize, maximize, restore) do not require an unchanged title. Input tools (click, type, key) require an unchanged `titleSha256`, because the title is part of what the user approved. This is a decision (D-3, §10); an editor's "modified" marker will cause a safe abort, not a wrong action.
4. **HWND reuse.** A destroyed window's handle value can be reused, including by the same process. PID plus creation time cannot detect that. The mitigations are class, thread, owner, style and title, a 30 s maximum approval lifetime, revalidation immediately before the first input, and a foreground check before every batch. **Residual risk, stated plainly:** a same-process window that reuses the handle and matches class, thread, owner, style and title within the approval window is indistinguishable. This is accepted and bounded by the single-action, 30 s rules.
5. **Self and system protection.** The PIDs of the daemon, the verified HUD, the agent host and its child processes (including `llama-server`) are `target_forbidden`. Targets with a higher integrity level are `target_forbidden`. (UIPI would block injection into them anyway; the daemon refuses first, with a clear reason.)
6. **Sensitive applications.** A configurable image-name denylist (password managers and similar) is `target_forbidden` for input and for UIA value reads. Contents are a decision (D-7).
7. **Legacy compatibility.** The existing `Simulated*` action types and their tests (some use zero identity: `ApprovalSessionBindingTests.cs:88-89`) keep their current behaviour. The strict rule applies to the new `Desktop.*` types. Tightening `Simulated*` would break those tests for no gain, since they perform no input; they are to be retired when `Desktop.*` lands.

---

## 4. Observation freshness contract

The schema is in the [protocol design](phase-7b0-protocol-design.md#9-observation-contract). Rules:

1. **Every observation carries its own clock.** Wall-clock `capturedAtUtc` for the record, and a monotonic stopwatch reading for age arithmetic. Age is never computed from wall-clock subtraction.
2. **Per-source status.** Window list, UIA and screenshot each report `ok`, `partial`, `timeout`, `failed`, `skipped` or `unavailable`, with a structured reason.
3. **Failure is reported as failure.** A requested screenshot whose `BitBlt` fails (including the unchecked fallback at `Win32ScreenObservationService.cs:388`) gives `screenshot.status = failed` and overall `degraded` or `failed`. `ok` means the API call succeeded; the design never claims the content is valid (a protected window can capture black without an error).
4. **No atomicity claim.** The daemon cannot freeze the desktop. It *brackets*: foreground window and target rectangle are read before and after the capture and UIA read. If either changed, `consistency.stable = false` and the observation is `degraded` with `target_changed_during_capture`. This detects change; it does not prevent it.
5. **Correct display.** The captured display is the one containing the largest part of the target window (`MonitorFromWindow`), not the primary display by default. `display.containsTarget` states whether the capture covers the window.
6. **Age limits.** An observation used to authorize or execute an input action MUST be at most 1,000 ms old at the moment execution is admitted. Read-only listings may be up to 5,000 ms old. Otherwise `observation_stale`.
7. **Incomplete or degraded observations never authorize input.** Only `complete` and `stable` observations feed an input action. They MAY feed a read-only reply with the degradation visible.
8. **The model never sees pixels.** The 0.5B and 3B models are text-only. Screenshots stay in the daemon as evidence handles; the agent receives structured UIA text.
9. **The frame buffer is unchanged.** The current mechanism is one unnamed section per capture with a 2-minute retention, not a ring, and the Rust HUD never maps it (the `target_handle` field exists only in the protocol struct). 7B does not change it.

---

## 5. Authorization and approval semantics

### 5.1 Which operations need approval

| Class | Operations | Approval | Notes |
|---|---|---|---|
| Observation | `desktop.list_windows`, `desktop.inspect_window` | None | Requires the `read:desktop` grant. Password values and denylisted applications are never read. The HUD shows an "observing" indicator (no interaction change) |
| Window management | `focus_window`, `set_window_state` | **Per action** | Elevated |
| Input | `click`, `type_text`, `press_key` | **Per action** | Elevated; Critical for destructive keys |
| Deferred | `scroll`, `launch_application`, `close_window` | Per action, Critical for close | The existing auto-allow of `SimulatedScroll` ([ActionPolicyEngine.cs:102-105](../../src/DAsk.Daemon/Automation/Policy/ActionPolicyEngine.cs#L102-L105)) does **not** carry over to real input |
| Never allowed | Self-targeting; elevated or secure-desktop targets; password fields; the win key; Alt+F4; Ctrl+Alt+Del; anything outside the key allowlist | Not approvable | Hard denial |

There is **no auto-approve, no "approve for N minutes" and no "approve similar"**. Approval fatigue is handled by keeping operations few, not by widening a single approval.

### 5.2 The approval request (daemon to HUD)

Built only by the daemon, after target resolution and revalidation. Fields (the first block exists today; the second block is new):

| Field | Source | Rule |
|---|---|---|
| `approvalId` | daemon, 128-bit random, 32 hex | Never accepted from a client; the "at least 8 characters" check at `ActionPolicyEngine.cs:490` is replaced by an exact format |
| `actionId` | daemon | One per approval |
| `sessionId` | **the task's owner session** | From the task record, never a message |
| `actionType` | fixed table | `Desktop.*` |
| `stopGeneration` | daemon epoch at construction | |
| `createdAtUtc`, `expiresAtUtc` | daemon | `expiresAtUtc - createdAtUtc` MUST be at most 30 s and is clamped **inside** the policy engine (fixes F5) |
| `target*` fields | daemon-resolved identity (3.2) | All mandatory |
| `taskId`, `callId` | new | Traceability |
| `actionDigest` | new | See 5.3 |
| `display` | new | The exact human-readable operation, see below |

`display` MUST contain: the verb; the target application name and the window title (truncated to 80 characters, with a marker if truncated); the control label (if any); the **exact parameters** (typed text in full up to 200 characters, otherwise its length and a prefix; the key and modifiers; the button); a `scope` of `single_action`; and the risk. The Rust struct must carry these fields or they are dropped before they reach the page (the HUD re-serialises its parsed struct, `main.rs:568-579`). This closes F7.

### 5.3 The action digest

`actionDigest = SHA-256(canonical(action))`, where `canonical` is a length-prefixed or sorted-key canonical JSON encoding that is **injective** (fixes F3), and `action` includes: schema version, action type, all parameters, the complete target identity, session id, stop generation, creation time and expiry. The digest is what the HUD echoes back (in the existing `parametersSha256` field, so the Rust and page code are unchanged) and what the daemon compares. The daemon already ignores the client-supplied copy of everything except the digest echo and the decision (`ActionPolicyEngine.cs:355-369`).

### 5.4 Lifecycle

```text
          call accepted (validated, in task, epoch ok)
                    │
                Created ──────────────┐ identity/policy/sensitivity failure
                    │                 ▼
                    │              Blocked
        resolve + revalidate + build canonical action
                    │
             PendingApproval ───── expire (30 s) ──▶ Expired
                    │   │
                    │   └── deny / cancel / stop / HUD lost ──▶ Cancelled (or Blocked)
                 Approved
                    │ consume exactly once, revalidate target, audit-before-act
                Executing ── cancel / stop / lease lost / target changed ──▶ Cancelled
                    │                                    └── fault ──▶ Failed
                Completed  (inputs delivered; this is NOT verification)
                    │
              Verification (separate record): verified | not_verified | unverifiable
```

`ActionLifecycleState` values and the allowed transitions already exist ([ActionState.cs:3-63](../../src/DAsk.Daemon/Automation/Execution/ActionState.cs#L3-L63)) and are kept unchanged. Verification is a separate evidence record, not a new state, so existing consumers are unaffected.

### 5.5 Outcomes seen by the user

| Daemon fact | Reported to the task as | HUD wording rule |
|---|---|---|
| Executed and verified against live state | verified | "Done" only if the TypeScript `decideOutcome` also accepts it |
| Executed, verification unverifiable | executed, unverified | Never "Done"; says what was done and what was not confirmed |
| Executed, then target changed or timed out | indeterminate | "May have taken effect"; never retried automatically |
| Denied, expired, cancelled, blocked | not executed | States which, and that nothing happened |

---

## 6. Cancellation and Emergency Stop contract

### 6.1 Propagation

```text
HUD hotkey/button ─▶ Rust latch (sync) ─▶ priority channel ─▶ daemon engine (latch, epoch++, cancel token)
                                                                   ├─▶ policy: invalidate approvals
                                                                   ├─▶ executor: linked token trips
                                                                   └─▶ AgentHostManager: emergency_stop op ─▶ host (ack or kill)
```

This path exists and is kept ([ActionExecutionEngine.cs:138-275](../../src/DAsk.Daemon/Automation/Execution/ActionExecutionEngine.cs#L138-L275), [AgentHostManager.cs:125](../../src/DAsk.Daemon/AgentHost/AgentHostManager.cs#L125), `:542-558`). The daemon is the authority; acknowledgements inform others and never gate the stop.

### 6.2 Scenario table

| # | Moment | Required behaviour | Mechanism | Status |
|---|---|---|---|---|
| C1 | Before authorization (call received, not yet approved) | Call ends `cancelled`; no approval created; no input | Host relays the tool's abort as `call.cancel`; **the daemon also cancels the task's calls on its own** when the task is cancelled, times out, or the host dies, and does not depend on the host relaying | Daemon-side cancel of calls: **new** |
| C2 | During approval | Pending approval removed as `Cancelled`; **HUD modal dismissed** | `InvalidateApproval(approvalId)` (new, per-approval) plus a new `ActionApprovalCancelled` message | Both **new** (F8) |
| C3 | After approval, before execution | The grant is invalidated; the executor's first act re-checks stop, epoch, lease and target and refuses | Grant invalidation by action or approval id (**new**); epoch check exists (`ActionExecutionEngine.cs:719-735`) | Partly new |
| C4 | During execution | Stop within one input batch. Each batch is at most one input event (text is typed one character at a time). The executor checks the linked token, the stop latch, the epoch, the HUD lease and the foreground window **before every batch** | Linked token exists (`:836`); per-batch checks **new** | New |
| C5 | Disconnect (HUD) during execution | Cancel and release held keys | `CancelActionsForSession` (`:946-1005`) | Exists |
| C6 | Emergency Stop during execution | As C4, then release held keys and buttons | Engine cancels the shared token (`:182`) | Release step **new** |
| C7 | Host failure | Cancel the dead host's in-flight calls, approvals and actions; the task ends interrupted; nothing is replayed | `OnInstanceExit` / `FailInFlight` (`AgentHostManager.cs:630-665`) end the *task*; cancelling the *daemon-side calls* is **new** | Partly new |
| C8 | HUD heartbeat loss | Lease lapses: pending approvals expire, executing actions cancel, no new call is admitted | Lease tracker **new** (F2) | New |
| C9 | Stop epoch changes | Any state tagged with an older epoch is dead: approvals, queued calls, executing actions | Epoch checks exist (`:719`, `ActionPolicyEngine.cs:515-521`) | Exists; extended to calls |
| C10 | Acknowledgement missing | Host: kill its tree (exists). HUD: stop stays latched and is re-sent on reconnect (exists, `emergency_stop.rs:153-165`). Executor: not dependent on any acknowledgement | | Exists |

### 6.3 "No new action after Stop"

1. Admission checks `IsEmergencyStopped` and the epoch at S1 (call accepted), at approval construction, at approval consume, and before every input batch.
2. The check before each batch reads a `volatile` flag, so it cannot be delayed by `_stateLock`.
3. `SendInput` cannot be recalled once called. The bound is therefore one batch. **Target:** no input event is injected later than 100 ms after the daemon latches Stop. This is a requirement to be measured in 7B.3, not a measured fact. The segment from hotkey press to the daemon latch (HUD latch, priority channel, pipe) is separate and is not measured here.
4. **The only post-stop input is neutralisation:** key-up for every key and button the executor holds down, in a `finally`, bounded to 250 ms. It restores a neutral state and begins no operation. Without it a stop between key-down and key-up leaves a modifier stuck.

### 6.4 Single points of failure for the panic hotkey

The HUD hosts the hotkey, the latch, the priority channel and the only approval UI.

| Failure | Covered today | Gap | Backstop |
|---|---|---|---|
| HUD crash or kill | Pipe closes; session actions, tasks and approvals cancelled (`IpcClientSession.cs:157-186`); release build aborts on panic (`Cargo.toml`) | `_panicHotkeyAvailable` stays true (F1) | Clear it on disconnect (**P0**) |
| HUD **suspended or hung**, pipe still open | Nothing | Undetected (F2) | **Heartbeat lease (P0, mandatory).** Last ping time per session; actuation requires a ping within 12 s (two intervals plus jitter); a lapse cancels |
| Hotkey registration fails | HUD latches Stop; daemon blocks admission (`ActionExecutionEngine.cs:39,703`; `IpcClientSession.cs:454`) | none | none |
| Another program swallows the chord with its own low-level hook | Nothing | Undetectable | See below |
| Secure desktop or UAC prompt | Hotkeys do not fire there; injection from the daemon cannot reach it either (UIPI) | A sequence could run while the user is on the secure desktop | Abort when the foreground window cannot be read (**P1**) |

**Recommendation.** The lease (P0) is mandatory and is a 7B.3 prerequisite. As a second independent path, a daemon-owned low-level keyboard and mouse hook (**P1, a decision, D-4**) can (a) abort any sequence on physical user input, recognising it by the `LLKHF_INJECTED` flag so the executor's own events are ignored, and (b) latch Stop on a daemon-side chord even if the HUD is dead. It must be tiny (hooks are dropped if a callback is slow) and runs on its own message-loop thread. It is not required for single-event actions and is recommended before any multi-event action such as `type_text`.

---

## 7. Idempotency and evidence

### 7.1 Identifiers

| Id | Created by | Lifetime |
|---|---|---|
| `callId` | host: `c{epoch}-{n}`, `n` strictly increasing within an epoch | one call |
| `idempotencyKey` | host: `{taskId}:{stepId}:{attempt}` | one logical operation |
| `actionId` | **daemon** | one executor run at most |
| `approvalId` | **daemon** | one approval, one consume |
| `observationId` | **daemon** | evidence reference |

### 7.2 Rules

1. A `(taskId, idempotencyKey)` maps to **at most one** executor run, ever. The daemon keeps a bounded call ledger (the `BoundedStopCache` pattern at `ActionExecutionEngine.cs:1070-1131`).
2. A duplicate while in flight attaches to the same call and gets the same reply.
3. A duplicate after the call finished returns the stored reply with `replayed: true` and **never executes again**.
4. The same key with different arguments is `idempotency_conflict`.
5. Retention: terminal entries for 15 minutes and at most 1,024 entries; in-flight entries are never evicted. Granted approvals are reaped at expiry; consumed-approval records are pruned 5 minutes after expiry (a pruned token fails as "never granted", still a rejection). This closes F6.
6. A restarted host never inherits a ledger: its tasks start new, and the previous epoch's calls are interrupted, never replayed (consistent with `AgentHostManager.cs:82-83`).
7. A timeout of an actuation call yields `indeterminate`, never `ok` and never an automatic retry.

### 7.3 Evidence

1. **New append-only journal** rather than overloading `safety_audit_trail` (which uses `INSERT OR REPLACE` and is mutable). Design only; the database is not created or modified here.
2. Each record is hash-chained (`prev_hash`, `hash`). This is tamper-*evidence* against accidental or partial modification; it does not stop a same-user process that rewrites the whole file, and the document makes no stronger claim.
3. **Write-ahead.** `ExecutionAdmitted` is committed and flushed (awaited, 500 ms limit) before the first input. Failure means no input (SI-9).
4. **Privacy by default.** Typed text and window titles are stored as length and SHA-256, never in clear. A clear-text debug mode is off by default and requires explicit local opt-in. Process names are stored truncated.
5. **No string-built JSON.** Record payloads are produced by a serializer (fixes the injection in F12).
6. **Events** (full schema in the protocol design): `CallReceived`, `CallRejected`, `TargetResolved`, `ObservationTaken`, `ApprovalRequested`, `ApprovalDecided`, `ApprovalExpired`, `ApprovalCancelled`, `ApprovalConsumed`, `ExecutionAdmitted`, `InputBatchSent`, `ExecutionCancelled`, `ExecutionFailed`, `VerificationResult`, `CallReplied`.
7. **Location and ACL** of the database are an open decision (D-6): it currently sits beside the binaries (`Program.cs:78`).

---

## 8. Daemon-attested summaries

The host builds the task result (`task.finished`) and could misstate it. For desktop tasks the daemon MUST append its own **attested action summary** (what it actually executed, with the verification results and evidence ids) to the result it forwards, and the HUD SHOULD show that block distinctly. A compromised or buggy host can then misreport a model's story but not the daemon's record.

---

## 9. Exact files a future implementation would change

| Area | File | Change |
|---|---|---|
| Daemon | `src/DAsk.Daemon/Automation/Policy/ActionPolicyEngine.cs` | `Desktop.*` types; injective digest; strict identity; TTL clamp; reapers; per-approval invalidation; `ApprovalCancelled` |
| Daemon | `src/DAsk.Daemon/Automation/Execution/ActionExecutionEngine.cs` | Real executor (behind a disabled-by-default switch); per-batch gate; neutralisation; call ledger; clear hotkey flag on disconnect |
| Daemon | `src/DAsk.Daemon/IPC/IpcClientSession.cs` | Heartbeat lease; disconnect clears hotkey availability; approval sender |
| Daemon | `src/DAsk.Daemon/IPC/NamedPipeServer.cs` | Owner-targeted approval delivery |
| Daemon | `src/DAsk.Daemon/AgentHost/AgentHostManager.cs` | Protocol v2: `call`, `reply`, `call.cancel`; negotiation; daemon-side call cancel on task end or host exit |
| Daemon | `src/DAsk.Daemon/Automation/Observation/*` | Window enumeration; identity; freshness and failure model; correct display; bracketing |
| Daemon | `src/DAsk.Daemon/Automation/Desktop/*` (new) | Target resolver, revalidator, selector matching, sensitivity checks, executor, verifier |
| Daemon | `src/DAsk.Daemon/Research/*` | Append-only journal; serializer-built details |
| Protocol | `src/DAsk.Protocol/IPC/Messages/ComputerUse/*` | Additive approval fields; `ActionApprovalCancelled` |
| Rust | `src/hud-native/src/ipc/protocol.rs`, `main.rs` | Carry the new approval fields to the page; forward `ActionApprovalCancelled`. No change to interaction or the hotkey |
| Page | `components/JarvisOrb.tsx` | Render the exact operation; dismiss on cancel. Display only |
| Agent | `agent/host/protocol.ts`, `host.ts`, `stdioHost.ts` | v2 negotiation, call client, daemon-approval mode |
| Agent | `agent/runtime/types.ts`, `toolRegistry.ts`, `defaults.ts` | `read:desktop`; `approvalMode: "daemon"`; fail-closed without a channel |
| Agent | `agent/runtime/tools/desktop*.ts` (new) | Tool specs and request checks (selector extraction, clarification for ambiguity) |
| Docs | `docs/agent-host-protocol.md` | v2 |
| Tests | `tests/DAsk.Daemon.Tests/*`, `tests/agent-*/*`, `src/hud-native` tests | Per the test specification |

---

## 10. Implementation order and open decisions

### 10.1 Order

1. **7B.1a (no actuation):** fix the defects that stand alone: F1, F2 (lease only), F3, F5, F6, F12; correct the observation failure model (F16).
2. **7B.1b:** protocol v2 channel with read-only tools; window enumeration and identity.
3. **7B.2:** daemon approval sender, owner-targeted delivery, `ActionApprovalCancelled`, HUD display of exact operation; window management tools.
4. **7B.3:** executor behind a disabled-by-default switch; per-batch gate; neutralisation; call ledger; journal and write-ahead.
5. **7B.4 and 7B.5:** verification, recovery policy, daemon-attested summaries.

Each step ships only with its tests from the specification.

### 10.2 Open decisions (need the owner's answer before implementation)

| ID | Decision | Recommendation |
|---|---|---|
| D-1 | Extend the stdio protocol (v2) or add a pipe | **Extend stdio**; reasons in the protocol design |
| D-2 | Canonical encoding for the digest | Sorted-key canonical JSON with a strict charset, over a length-prefixed binary form |
| D-3 | Title must match for input tools | Yes (3.4) |
| D-4 | Daemon-owned low-level hook as a second Stop path | Yes before any multi-event action; lease is mandatory regardless |
| D-5 | How to approve when the HUD is Ambient (F9) | A visible, non-interactive "approval pending: press Ctrl+Alt+Space" state. The HUD must never raise itself to Interactive. This changes display behaviour only and needs separate authorization |
| D-6 | Journal location, ACL, retention, clear-text debug mode | `%LOCALAPPDATA%` for the user, 30-day retention, debug mode off |
| D-7 | Sensitive-application denylist: contents and owner | Start with password managers and the OS credential UI; user-extendable |
| D-8 | Where input-injection tests run (Windows 11 Home has no Windows Sandbox or Hyper-V) | A third-party VM, or the dev machine with the foreground guard and fixture-only targets |
| D-9 | Retire `Simulated*` action types | After `Desktop.*` lands |
| D-10 | Show screenshots in approvals | No; text only |
| D-11 | A product setting `Desktop:AllowedTargetImages` (an allowlist of applications the agent may act on; empty means the per-selector rules apply). The test plan relies on it to confine tests to fixtures | Yes: default empty in the product, fixture-only in tests |

---

## 11. Verdict

See the final report. The contracts above are complete enough to review. The implementation must not begin until D-1 (a frozen-contract change) and D-5 (a HUD behaviour question) are decided.
