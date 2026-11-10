# Phase 7B.0: Protocol Design

**Status:** design only. Nothing in this document is implemented, and no protocol in the repository was changed to write it.
**Companion documents:** [safety contracts](phase-7b0-safety-contracts.md) (invariants `SI-n`, findings `F-n`), [threat model](phase-7b0-threat-model.md), [test specification](phase-7b0-test-specification.md).

This document specifies two things: the **agent-to-daemon call protocol** (how the TypeScript agent host asks the daemon to observe or act) and the **approval protocol** (how the daemon asks the user and gets a decision back). It also specifies the **observation** and **evidence** records both depend on.

---

## 1. Recommendation in one paragraph

Extend the existing agent-host **stdio protocol** to version 2, adding a host-originated `call` message and a daemon `reply`, negotiated in the existing `hello`. Do **not** add a separate pipe. The host is already the daemon's authenticated child process, in a Job Object, with a per-launch token, strict validation on both ends, a kill-on-violation rule and an Emergency Stop acknowledgement path. All desktop authority stays in the daemon: the host sends a *selector*, the daemon resolves the target, builds the canonical action, asks the user, executes and verifies. The host never holds an approval, a session, an action id or a window identity.

---

## 2. Transport decision: extend stdio, or add a pipe

| Property | Extend stdio (recommended) | Separate named pipe |
|---|---|---|
| Authenticity of the writer | **By construction.** The host is the daemon's child with redirected stdio ([AgentHostManager.cs:387-416](../../src/DAsk.Daemon/AgentHost/AgentHostManager.cs#L387-L416)); no other process can write the host's stdout | Must be earned: pipe ACL, `PipePeerVerification` (PID, creation time, image path, SID, session), a token, PID-reuse races. That machinery exists for the HUD pipe ([PipePeerVerification.cs:48-206](../../src/DAsk.Daemon/IPC/PipePeerVerification.cs#L48-L206)) but would be a second listener and a second allowlist |
| Fail-closed on a bad message | Existing: unknown or malformed input kills the host and fails its tasks ([AgentHostManager.cs:636-640](../../src/DAsk.Daemon/AgentHost/AgentHostManager.cs#L636-L640)) | Must be built |
| Emergency Stop ordering | The `emergency_stop` op, its acknowledgement and the kill-on-no-ack already travel this channel ([AgentHostManager.cs:542-558](../../src/DAsk.Daemon/AgentHost/AgentHostManager.cs#L542-L558)) | A second channel could disagree with the first about stop state |
| Lifetime coupling | Host death closes the channel; the Job Object kills stragglers ([ProcessJob.cs](../../src/DAsk.Daemon/AgentHost/ProcessJob.cs)) | A pipe can outlive the host and be opened by anything allowed |
| New attack surface | None (no new endpoint) | A new local endpoint |
| Cost | One more message kind each way; the daemon reader and the host parser both change | A listener, ACL, handshake, reconnect logic |
| Head-of-line blocking | One task at a time and one call in flight per task ([protocol.ts:16-17](../../agent/host/protocol.ts#L16-L17)), so contention is negligible | Not an issue |
| Size limits | Host input line cap 64 KiB ([protocol.ts:22](../../agent/host/protocol.ts#L22)); daemon reads host output up to 2 MiB ([AgentHostManager.cs:87](../../src/DAsk.Daemon/AgentHost/AgentHostManager.cs#L87)); new per-kind caps in §5 | Free to choose |

**Decision:** extend stdio. **Cost accepted:** the host's `parseRequest` rejects unknown fields and ops ([protocol.ts:95-108](../../agent/host/protocol.ts#L95-L108)) and the daemon rejects unknown message kinds ([AgentHostManager.cs:852-857](../../src/DAsk.Daemon/AgentHost/AgentHostManager.cs#L852-L857)), so both ends change together. They already ship together and are hash-pinned by the package verifier, so version skew implies a defect or tampering, and killing on skew is correct.

**This changes a frozen contract** (`docs/agent-host-protocol.md`). It needs the owner's explicit authorization before implementation (decision D-1).

No parallel agent runtime or tool registry is introduced: the tools are ordinary `ToolSpec`s in the existing `ToolRegistry`; their `execute` calls this channel.

---

## 3. Version negotiation

`hello` is today `{ token, emergencyStopped, stopGeneration }`, answered by `{ ready, … }` ([AgentHostManager.cs:449-454](../../src/DAsk.Daemon/AgentHost/AgentHostManager.cs#L449-L454), [host.ts:179](../../agent/host/host.ts#L179)). Extended:

Daemon to host (request params, added field):

```json
{ "token": "…", "emergencyStopped": false, "stopGeneration": 7,
  "desktop": { "proto": 2, "enabled": true, "tools": ["desktop.list_windows", "desktop.inspect_window"] } }
```

Host to daemon (result, added field):

```json
{ "ready": true,
  "desktop": { "proto": 2, "tools": ["desktop.list_windows", "desktop.inspect_window"] } }
```

Rules:

1. **Default off.** `AgentHost:Desktop:Enabled` defaults to `false`. When false, `desktop` is omitted, the host registers no `desktop.*` tool, and the daemon rejects any `call` (`desktop_disabled`).
2. **The enabled tool set is the intersection** of what the daemon allows and what the host reports. A host reporting a tool the daemon did not enable is a violation.
3. **Mismatch is fail-closed.** If the host does not echo `proto: 2`, desktop is disabled for that instance and the host runs as today (v1 behaviour). If it sends a `call` anyway, that is a violation and the host is killed.
4. **Per-tool kill switches** (`AgentHost:Desktop:DisabledTools`) are read by the daemon at every call, not only at hello.
5. Messages keep `"v": 1` for the existing ops and responses. New kinds carry `"v": 2`. A line with any other `v`, or `v: 2` before negotiation, is a violation.

---

## 4. Message envelope

All lines are one JSON object per line, UTF-8, `\n`-terminated, as today.

### 4.1 `call` (host to daemon)

```json
{
  "v": 2, "kind": "call",
  "callId": "c3-17",
  "taskId": "task_8f2a",
  "stepId": "s1",
  "tool": "desktop.focus_window",
  "idempotencyKey": "task_8f2a:s1:1",
  "args": { "window": { "process": "notepad.exe" } },
  "deadlineMs": 45000
}
```

| Field | Type | Rule |
|---|---|---|
| `callId` | string, `^c[0-9]{1,6}-[0-9]{1,9}$` | `c{epoch}-{n}`. `epoch` MUST equal the instance epoch the daemon assigned; `n` strictly increases within an instance. Equal `n` is a duplicate (§11); a smaller `n` is a violation |
| `taskId` | string, `^[A-Za-z0-9_-]{1,64}$` | MUST name a task that exists, is `running`, belongs to this instance's epoch, and is not cancelling ([AgentHostManager.cs:572](../../src/DAsk.Daemon/AgentHost/AgentHostManager.cs#L572)) |
| `stepId` | same pattern | Traceability only |
| `tool` | string | MUST be in the negotiated, enabled set |
| `idempotencyKey` | string, `^[A-Za-z0-9_:\-]{1,160}$` | `taskId:stepId:attempt` |
| `args` | object | Validated by the **daemon's** per-tool schema (§6). Unknown fields are rejected |
| `deadlineMs` | integer | Clamped by the daemon to the tool maximum (§8). Advisory |

There is deliberately **no** field for: a session, an owner, an approval id, an action id, a window handle, a process id, a permission or a grant. The daemon derives the session from the task record (`OwnerSessionId`, [AgentHostManager.cs:67-76](../../src/DAsk.Daemon/AgentHost/AgentHostManager.cs#L67-L76)), the epoch from the instance that wrote the line, and everything else from live state.

### 4.2 `call.cancel` (host to daemon)

```json
{ "v": 2, "kind": "call.cancel", "callId": "c3-17" }
```

Sent when the tool's abort signal fires. Idempotent. It can only reduce what is running. The daemon does **not** depend on it: it cancels the task's calls itself when the task is cancelled, times out, finishes, or the host exits (safety contracts, C1 and C7).

### 4.3 `reply` (daemon to host)

Written to the host's stdin like an existing request line, but `kind: "reply"` (the host's parser is extended to dispatch on `kind`).

```json
{
  "v": 2, "kind": "reply",
  "callId": "c3-17",
  "status": "ok",
  "result": { "…": "per tool, §6" },
  "verification": { "result": "verified", "method": "foreground_window_equals_target", "expected": "foreground = notepad.exe", "observed": "foreground = notepad.exe", "observationIds": ["obs_ab12"] },
  "error": null,
  "evidenceIds": ["ev_91c0", "ev_91c1"],
  "stopGeneration": 7,
  "replayed": false
}
```

A reply is sent exactly once per `callId` (replays excepted, §11). It is also sent unsolicited-in-time when the daemon cancels a call (`status: "cancelled"`).

---

## 5. Validation, bounds and rate limits

All enforced by the **daemon**, which treats the host as untrusted for authorization (SI-12). The host also validates its own output.

| Bound | Value |
|---|---|
| `call` line | ≤ 16 KiB |
| `reply` line | ≤ 48 KiB (under the host's 64 KiB input cap) |
| Any string in `args` | ≤ 2,048 chars; no control characters except where a tool states otherwise |
| `type_text.text` | ≤ 1,000 chars |
| Elements in an inspection result | ≤ 200; truncation is reported, never silent |
| In-flight calls per task | 1 |
| Calls per task | ≤ 40 |
| Calls per minute per host instance | ≤ 30; actuation ≤ 10 |
| Evidence ids per reply | ≤ 8 |

Parsing is strict: duplicate keys, unknown fields, wrong types, non-integer numbers where an integer is required, and over-long lines are rejected. A `call` that cannot be parsed to a `callId` is a violation (the host is killed, as for any malformed line today); one that parses but fails validation gets an `error` reply and the host continues.

Checks, in order, and the first failure wins (each one is an audit event):

1. protocol negotiated and `desktop` enabled;
2. Emergency Stop latched, or `stopGeneration` mismatch;
3. task exists, running, current epoch, owned by a live session whose heartbeat lease is valid;
4. tool known, enabled, and not on the kill-switch list;
5. rate limits and in-flight limit;
6. argument schema;
7. idempotency (§11).

---

## 6. Tool call contracts

All tools are `desktop.*`, matching the existing `namespace.snake_case` convention (`filesystem.find_text`, `workspace.list_dir`). Required grant: `read:desktop` (new) for observation, `desktop:actuate` for window and input tools, `process:spawn` for launch (deferred). The grant is configured **in the daemon**; the host's own `granted` set is a second layer, not the authority.

### 6.1 Shared types

```jsonc
// WindowSelector: the agent NAMES; the daemon IDENTIFIES. No handle, no pid.
{ "process": "notepad.exe",        // image file name, ≤ 64, optional
  "titleContains": "Untitled",     // ≤ 128, optional
  "className": "Notepad" }         // ≤ 64, optional
// at least one of process or titleContains is required

// ControlSelector
{ "automationId": "15",            // optional
  "name": "Text editor",           // optional
  "controlType": "Edit" }          // required, enum
// at least one of automationId or name is required

// WindowIdentity: daemon-produced, always complete (safety contracts §3.2)
{ "hwnd": 1049802, "pid": 8812, "processCreationFileTime": 133811234567890123,
  "imagePath": "C:\\Windows\\System32\\notepad.exe", "windowClass": "Notepad",
  "processSessionId": 1, "threadId": 9120, "titleSha256": "…", "integrityLevel": "medium" }
```

Raw coordinates are **not** accepted in v1. The planner cannot carry an observation across steps ([planner.ts:95-103](../../agent/runtime/planner.ts#L95-L103) rejects step references), so any coordinate would come from the model and be ungrounded. Coordinates exist only inside the daemon, derived from a fresh UIA element at execution time.

### 6.2 `desktop.list_windows` (read-only, no approval)

| | |
|---|---|
| `args` | `{ "process"?: string, "limit"?: integer ≤ 50 }` |
| Result | `{ "windows": [ { "ref": "w1", "process": "notepad.exe", "title": "…", "className": "…", "visible": true, "minimized": false, "foreground": false, "display": 0 } ], "truncated": false, "observationId": "obs_…" }` |
| Notes | `ref` is meaningful only within this reply and **cannot be passed back** (SI-3). Titles of denylisted applications are replaced by `"[hidden]"`. Requires a `complete` or `degraded` window-list status; `failed` is an error |

### 6.3 `desktop.inspect_window` (read-only, no approval)

| | |
|---|---|
| `args` | `{ "window": WindowSelector, "maxElements"?: integer ≤ 200 }` |
| Result | `{ "window": { …summary… }, "uia": { "status": "ok|partial|timeout|fallback_win32|unavailable", "elements": [ { "controlType": "Button", "name": "Save", "automationId": "", "enabled": true, "focusable": true, "offscreen": false, "isPassword": false } ], "truncated": false }, "observationId": "obs_…" }` |
| Notes | Element **values** are never returned for password controls or denylisted applications. Text read from the desktop is data (SI-11). Positional ids (`elem_0`) are not exposed; elements carry no handle |

### 6.4 `desktop.focus_window` (approval)

| | |
|---|---|
| `args` | `{ "window": WindowSelector }` |
| Canonical action | `Desktop.FocusWindow` with the full `WindowIdentity` |
| Execution | Daemon brings the exact revalidated window to the foreground (the API choice is an implementation detail, subject to foreground-lock rules) |
| Verification | Foreground window equals the approved identity (same HWND, PID, creation time), read from a fresh observation |

### 6.5 `desktop.set_window_state` (approval)

| | |
|---|---|
| `args` | `{ "window": WindowSelector, "state": "minimize" | "maximize" | "restore" }` |
| Verification | Minimized / maximized flags match the requested state on a fresh read. `restore` verifies "neither minimized nor maximized" |

### 6.6 `desktop.click` (approval)

| | |
|---|---|
| `args` | `{ "window": WindowSelector, "control": ControlSelector, "button": "left" }` |
| Canonical action | `Desktop.Click`: window identity, control identity (§3.3), button, and the control rectangle at resolution time |
| Execution | Daemon re-resolves the control, requires exactly one match, requires the window foreground and the target point inside the control and on a visible monitor, then performs one click |
| Verification | Only when the request states an expected outcome that the TypeScript check can express (for example "a window titled X appears"). Otherwise `unverifiable`, and the task cannot be `completed` |

### 6.7 `desktop.type_text` (approval)

| | |
|---|---|
| `args` | `{ "window": WindowSelector, "control": ControlSelector, "text": string ≤ 1000 }` |
| Refused | Password controls; controls whose password state cannot be read; denylisted applications; text containing control characters |
| Execution | One character per input batch, with a stop-and-lease check before each |
| Verification | The control's value (read via UIA) ends with the typed text, or equals the pre-value plus the text. If the value cannot be read, `unverifiable` |

### 6.8 `desktop.press_key` (approval)

| | |
|---|---|
| `args` | `{ "window": WindowSelector, "key": string, "modifiers"?: ["ctrl"|"shift"|"alt"] }` |
| Key policy | Allowlist (below); anything else is `invalid_args`. No Windows-key combinations, no `alt` with a function key, no `Alt+F4`, `Ctrl+W`, `Ctrl+Q` |
| Verification | Expected outcome supplied by the request check, else `unverifiable` |

Proposed v1 key allowlist (subject to review): `Tab`, `Enter`, `Escape`, `Space`, `Backspace`, `Up`, `Down`, `Left`, `Right`, `Home`, `End`, `PageUp`, `PageDown`, and `Ctrl+{A,C,Z,Y}`. `Delete` is Critical and excluded from v1.

### 6.9 Deferred

`desktop.scroll`, `desktop.launch_application` (allowlisted applications only; `process:spawn`) and `desktop.close_window` (Critical) are reserved names with no schema in 7B.0.

---

## 7. Replies, statuses and errors

### 7.1 `status`

| `status` | Meaning | Host mapping |
|---|---|---|
| `ok` | The operation ran (or, for observation, was read). Read `verification.result` for what was confirmed | Tool output; `satisfies` decides |
| `denied` | Not authorized, not approved, or refused by policy | Failed step; never retried by the host |
| `cancelled` | Cancelled before or during execution; `error.code` says why | Cancelled |
| `expired` | Approval or deadline lapsed before execution began | Failed; nothing happened |
| `indeterminate` | Input may have been injected but the outcome is unknown (deadline, target change, loss of lease mid-run) | **Never `completed`; never auto-retried**; the message says the action may have taken effect |
| `error` | Rejected or failed; `error.code` says why | Failed |

### 7.2 `verification.result`

`verified` (the daemon confirmed the expected state from a fresh observation), `not_verified` (the daemon looked and it did not hold), `unverifiable` (no method exists, or the state could not be read). The TypeScript check computes the expected outcome **from the request text** and accepts `verified` only if the reply's `expected` matches it, so neither the daemon's wording nor the model can substitute a weaker claim.

### 7.3 Error codes

```
invalid_request  unsupported_version  desktop_disabled  unknown_tool  invalid_args
emergency_stopped  stale_generation  task_not_running  rate_limited  busy
idempotency_conflict  not_authorized  hud_unavailable  hud_lost
target_not_found  ambiguous_target  identity_incomplete  target_changed  target_forbidden
sensitive_field  observation_stale  observation_failed  observation_degraded
approval_denied  approval_expired  approval_cancelled
cancelled  deadline_exceeded  execution_failed  journal_unavailable  internal_error
```

`error` is `{ "code": string, "message": string, "retryable": boolean, "candidates"?: [...] }`. `ambiguous_target` carries up to 5 candidate summaries (process, truncated title, display), never a handle. `retryable` is `true` only for `rate_limited`, `busy` and `observation_stale`; it is `false` for anything that could have affected the desktop.

---

## 8. Timeouts and cancellation

| Tool class | Daemon maximum for the whole call |
|---|---|
| Observation | 5 s |
| Window management | 45 s (30 s approval + 10 s execute + 5 s verify) |
| Input | 60 s (30 s approval + up to 20 s execute + 10 s verify) |

1. The daemon clamps `deadlineMs` down to these, and also to the task's remaining time. The approval TTL (30 s) is enforced by the policy engine and is part of the budget, not added to it.
2. TypeScript `ToolSpec.timeoutMs` for actuation tools MUST be at least the daemon maximum plus 5 s, because the registry's per-call timer starts after the approval gate ([toolRegistry.ts:127-134](../../agent/runtime/toolRegistry.ts#L127-L134)) but a daemon-approved call spends its approval time inside `execute`.
3. **A timeout never means "did not happen."** Observation timeouts give `error: deadline_exceeded`. An actuation call that passes the admission point and then times out gives `indeterminate`.
4. Cancellation sources, all converging on the same linked token in the daemon: `call.cancel`; task cancel; task timeout (`AgentHostManager.cs:520-526`); host exit; HUD session end; HUD lease lapse; Emergency Stop. Timing, ordering and the post-stop neutralisation rule are in the safety contracts §6.

---

## 9. Observation contract

One schema, used inside the daemon, in evidence, and (summarised) in tool results.

```jsonc
{
  "schema": "dask.observation.v2",
  "observationId": "obs_ab12…",                  // daemon-generated
  "capturedAtUtc": "2026-11-08T15:41:02.118Z",   // record only
  "monotonicStartMs": 98123401,                  // age arithmetic uses this, never wall clock
  "monotonicEndMs": 98123552,
  "maxAgeMs": 1000,                              // 5000 for read-only listing
  "status": "complete",                          // complete | degraded | failed
  "consistency": {
    "stable": true,                              // foreground and target rect unchanged across the reads
    "foregroundBefore": 1049802, "foregroundAfter": 1049802,
    "rectBefore": [100,100,900,700], "rectAfter": [100,100,900,700],
    "atomic": false                              // always false; the daemon cannot freeze the desktop
  },
  "target": { /* WindowIdentity, §6.1 */ },
  "display": {
    "index": 0, "deviceName": "\\\\.\\DISPLAY1",
    "boundsPhysical": [0,0,1920,1080],
    "dpiX": 144, "dpiY": 144, "scale": 1.5,
    "targetDisplayIndex": 0, "containsTarget": true
  },
  "dpiContext": { "processAwareness": "PerMonitorV2", "verified": true },
  "windowList": { "status": "ok", "startedMs": 98123401, "completedMs": 98123420, "count": 14 },
  "uia": {
    "status": "ok",                               // ok | partial | timeout | fallback_win32 | unavailable | denied_sensitive
    "startedMs": 98123420, "completedMs": 98123500,
    "elementCount": 37, "truncated": false, "treeSha256": "…"
  },
  "screenshot": {
    "status": "ok",                               // ok | failed | skipped
    "contentValidated": false,                    // 'ok' means the API call succeeded, not that the pixels are valid
    "bytes": 8294400, "format": "raw_bgra32", "sha256": null, "error": null
  },
  "failures": [ { "source": "screenshot", "code": "bitblt_failed", "message": "…" } ]
}
```

Rules (each defect it fixes is in the safety contracts):

1. **Failure is failure.** A requested source that fails sets its `status` and adds a `failures` entry. A failed screenshot must not yield `Success = true` as at `Win32ScreenObservationService.cs:388`/`:419-424`. Overall `status` is `complete` only when every *requested* source is `ok` and `consistency.stable` is true; `degraded` when some are `partial`/`timeout`/`fallback_win32` or the desktop moved during the reads; `failed` when a required source failed.
2. **No atomicity claim.** `atomic` is always `false`. Stability is *bracketed* by reading the foreground window and the target rectangle before and after, and is evidence of non-change, not a freeze.
3. **Right display.** The captured display is chosen after the target is known, using `MonitorFromWindow`; `containsTarget` says whether the capture covers the window.
4. **Age.** Input actions require `now_monotonic - monotonicEndMs ≤ 1000` at the moment execution is admitted, and `status = complete`. Otherwise `observation_stale` or `observation_degraded`. Because an observation taken for an action is taken *inside the same call*, in practice it is milliseconds old at admission; the rule exists to make stale reuse impossible.
5. **No reuse across approvals.** An approval is bound to the identity and digest, not to an observation. Execution takes a fresh observation and revalidates (SI-8).
6. **What leaves the daemon.** To the agent: UIA text only, bounded (§5). To the HUD: nothing new. Screenshots and UIA trees stay in the daemon as evidence handles (`observationId`, `treeSha256`); images are not persisted by default.
7. **Today's reality, not changed here:** one unnamed section per capture, 2-minute retention, not a ring, not mapped by the Rust HUD ([ObservationBufferManager.cs:14](../../src/DAsk.Daemon/Automation/Observation/ObservationBufferManager.cs#L14), `:92-110`).

---

## 10. Approval protocol

### 10.1 Sequence

```text
Agent host            Daemon                                   Rust HUD           Page (WebView2)        User
   │  call(focus)        │                                        │                    │                   │
   │────────────────────▶│ 1 validate call (§5)                   │                    │                   │
   │                     │ 2 resolve selector → identity (live)   │                    │                   │
   │                     │ 3 policy: Desktop.FocusWindow=Elevated │                    │                   │
   │                     │ 4 build canonical action + digest      │                    │                   │
   │                     │ 5 journal: TargetResolved,ApprovalRequested (durable)       │                   │
   │                     │ 6 ActionApprovalRequest (owner only) ─▶│ 7 forward ────────▶│ 8 show exact op ─▶│
   │                     │                                        │                    │◀── Approve/Deny ──│
   │                     │◀──────── ActionApprovalResponse ───────│◀───────────────────│                   │
   │                     │ 9 validate: session, epoch, expiry, digest, one pending
   │                     │ 10 consume exactly once (policy)
   │                     │ 11 revalidate target (OS) + lease + stop + epoch
   │                     │ 12 journal: ExecutionAdmitted (durable, awaited)  ← audit before act
   │                     │ 13 execute (per-batch gate)
   │                     │ 14 fresh observation + verify
   │◀────────────────────│ 15 reply(status, verification, evidence)
```

Any failure at 1–12 ends the call with a reply and **no input**. Steps 6–8 are the existing path from the policy engine onward; the daemon sender (step 6) and the exact-operation display (step 8) are new.

### 10.2 Messages

`ActionApprovalRequest` (daemon to HUD). Existing fields are kept ([ActionApprovalMessages.cs:5-55](../../src/DAsk.Protocol/IPC/Messages/ComputerUse/ActionApprovalMessages.cs#L5-L55)); new fields are additive. The Rust struct has no `deny_unknown_fields` ([protocol.rs:296-316](../../src/hud-native/src/ipc/protocol.rs#L296-L316)) so an old HUD ignores extras, but **it also drops them** before the page sees them (`main.rs:568-579` re-serialises the parsed struct), so the Rust struct must gain the display fields.

```jsonc
{
  "approvalId": "9f3c…(32 hex)",
  "actionId": "a71e…",
  "actionType": "Desktop.FocusWindow",
  "parametersSha256": "<actionDigest>",       // legacy field name; carries the full digest for Desktop.* (the page echoes it unchanged)
  "actionParameters": { "process": "notepad.exe" },
  "targetProcessName": "notepad.exe",
  "targetWindowTitle": "Untitled - Notepad",
  "targetHwnd": 1049802,
  "targetProcessId": 8812,
  "targetProcessCreationTime": "2026-11-08T14:02:11.0123456Z",
  "sessionId": "sess_…",                      // the task's owner session
  "stopGeneration": 7,
  "riskLevel": "Elevated",
  "createdAtUtc": "…", "expiresAtUtc": "…",   // ≤ 30 s apart, clamped by the policy engine
  "reason": "Bring Notepad to the foreground",

  // new
  "schemaVersion": 2,
  "taskId": "task_8f2a", "callId": "c3-17",
  "targetImagePath": "C:\\Windows\\System32\\notepad.exe",
  "targetWindowClass": "Notepad",
  "targetSessionId": 1,
  "display": {
    "verb": "Focus window",
    "target": "Notepad: “Untitled - Notepad”",
    "control": null,
    "parameters": [ { "label": "Window", "value": "Untitled - Notepad" } ],
    "scope": "single_action"
  }
}
```

`ActionApprovalResponse` (HUD to daemon) is unchanged ([protocol.rs:318-333](../../src/hud-native/src/ipc/protocol.rs#L318-L333)). Today the HUD sends `session_id: None` and `stop_generation: 0`; both are ignored by the daemon, which uses the owner recorded in the cached request ([ActionPolicyEngine.cs:290-297](../../src/DAsk.Daemon/Automation/Policy/ActionPolicyEngine.cs#L290-L297)). That behaviour is kept.

New `ActionApprovalCancelled` (daemon to HUD, owner only):

```json
{ "approvalId": "9f3c…", "actionId": "a71e…", "reason": "stop|disconnect|expired|task_cancelled|target_changed", "timestamp": "…" }
```

On receipt the page MUST dismiss the modal (closes F8). It carries no authority; ignoring it is safe because the daemon has already invalidated the approval.

### 10.3 Daemon-side rules

| Rule | Behaviour |
|---|---|
| Delivery | Owner session only, via the existing `SendToOwner` pattern ([NamedPipeServer.cs:97-100](../../src/DAsk.Daemon/IPC/NamedPipeServer.cs#L97-L100)); never broadcast (F11) |
| One pending approval per task | A second request while one is pending is `busy` |
| Digest | Over the injective canonical form (safety contracts §5.3); the response's echoed digest must equal it |
| Expiry | `expiresAtUtc - createdAtUtc ≤ 30 s`, enforced in `RequestApprovalAsync`, not by the caller (F5). No decision after expiry is honoured |
| Denial | `approved:false` completes the call with `denied` / `approval_denied`; nothing runs |
| Duplicate decision | The first finalises (`TryRemove` of the exact entry, `ActionPolicyEngine.cs:299-306`); later ones are ignored as "unknown or already finalized" |
| Stop | A decision arriving while stopped is rewritten to `EmergencyStopDenied` (`:323-334`) |
| Epoch | A decision whose request epoch differs from the current one is `StaleGenerationDenied` (`:336-352`) |
| HUD disconnect with a pending approval | Approvals of that session are invalidated (`IpcClientSession.cs:178-182`); the call ends `approval_cancelled` / `hud_lost` |
| HUD lease lapse with a pending approval | Expire immediately (`hud_lost`) |
| Consume | Atomic remove then record (`:602-610`); a second consume is a replay and is rejected |
| Execution | Only the daemon-held canonical action referenced by `actionId`. There is no second request that carries parameters |

### 10.4 State machine (approval)

```text
 Requested ──decision(approve, valid)──▶ Granted ──consume──▶ Consumed ──▶ (execution)
     │ │ │                                  │
     │ │ └─decision(deny)──▶ Denied         └─expire / stop / epoch / session end / call cancel──▶ Invalidated
     │ └──expire (30 s)──▶ Expired
     └──stop / epoch change / session end / call cancel / lease lapse──▶ Cancelled
```

Terminal states never transition. `Granted` entries are reaped at expiry (F6).

### 10.5 What the HUD must show

The exact operation (verb), the target application and window title, the control label, **every parameter** (typed text in full up to 200 characters), the scope "single action", the risk, and the remaining time. The SHA-256 may remain as a small technical detail; it is not a substitute for the parameters (F7). Showing more is a display change only; the interaction model (Ambient / Interactive / Hidden, the hotkeys, and the rule that the page can only lower interaction) is untouched. How the user is told an approval is waiting while the HUD is Ambient is decision D-5.

---

## 11. Idempotency, duplicates, disconnect and mismatch

| Situation | Behaviour |
|---|---|
| Same `callId`, same content, in flight | Attach; one reply |
| Same `(taskId, idempotencyKey)`, same args hash, after completion | Stored reply with `replayed: true`; **no new execution** |
| Same key, different args | `error: idempotency_conflict`; nothing runs |
| `callId` regress or reuse with different content | Violation: host killed (fail closed) |
| Host exits mid-call | Daemon cancels the task's calls, approvals and actions; task ends interrupted; nothing replayed ([AgentHostManager.cs:82-83](../../src/DAsk.Daemon/AgentHost/AgentHostManager.cs#L82-L83), `:630-665`) |
| Daemon restarts | The host dies with it (stdin closed, `stdio.ts:54`); ledger and approvals are memory-only and vanish; the journal persists |
| HUD reconnects with a new session | Old session's tasks, approvals and actions were cancelled at disconnect; nothing resumes under the new session |
| `v` mismatch, unknown `kind`, or `call` before negotiation | Violation: host killed; desktop stays disabled for the next start until the cause is fixed |
| Journal cannot be written | `journal_unavailable`; actuation refused, observation allowed (SI-9) |

Ledger sizes and retention: safety contracts §7.2.

---

## 12. Evidence records

A new **append-only journal**. Design only; the existing database is not touched. The present `safety_audit_trail` stays for its current events. Reasons for a new table: that table uses `INSERT OR REPLACE` ([SqliteEvidenceRecorder.cs:232](../../src/DAsk.Daemon/Research/SqliteEvidenceRecorder.cs#L232)), has no ordering guarantee beyond a timestamp, and its callers do not await the write.

```sql
-- design text, not executed
CREATE TABLE desktop_action_journal (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,   -- no gaps, no reuse
  ts_utc       TEXT    NOT NULL,
  event        TEXT    NOT NULL,                     -- see list below
  task_id      TEXT, call_id TEXT, action_id TEXT, approval_id TEXT, session_id TEXT,
  stop_generation INTEGER NOT NULL,
  action_digest TEXT,
  payload_json TEXT    NOT NULL,                     -- serializer-built, redacted (below)
  prev_hash    TEXT    NOT NULL,
  hash         TEXT    NOT NULL                      -- SHA-256(prev_hash || canonical row)
);
-- plus triggers that RAISE(ABORT) on UPDATE and DELETE
```

Events and the fields their `payload_json` carries:

| Event | Payload |
|---|---|
| `CallReceived` | tool, argument **digest**, idempotency key |
| `CallRejected` | error code, stage |
| `TargetResolved` | window identity (image name truncated, title **hash**), candidate count |
| `ObservationTaken` | observation id, status, tree digest, display, per-source statuses (the “before” reference) |
| `ApprovalRequested` / `Decided` / `Expired` / `Cancelled` / `Consumed` | approval id, risk, digest, decision source, reason code |
| `ExecutionAdmitted` | epoch, lease age, target revalidation result. **Committed before input (SI-9)** |
| `InputBatchSent` | batch index and count only, never the content |
| `ExecutionCancelled` / `Failed` | why, batches sent, whether neutralisation ran |
| `VerificationResult` | method, expected, observed, result, observation id (the “after” reference) |
| `CallReplied` | status, error code, whether replayed |

**Redaction.** Typed text and window titles appear only as length and SHA-256. Process names are stored by image file name. A local clear-text debug mode is off by default (D-6). **No string-built JSON:** every payload comes from a serializer (F12). **Honest limit:** the hash chain makes accidental or partial modification detectable; a process running as the same user can still rewrite the whole file. The design claims tamper-evidence, not tamper-proofing.

The existing `ExecutionEvidenceRecord` pre/post-observation model ([ExecutionEvidenceModel.cs:39-100](../../src/DAsk.Daemon/Research/ExecutionEvidenceModel.cs#L39-L100)) is not reused: its snapshot types are free-form dictionaries and it is keyed to the model benchmark.

---

## 13. Worked examples

### 13.1 Ambiguous target (no guessing)

```json
→ {"v":2,"kind":"call","callId":"c3-5","taskId":"task_1","stepId":"s1","tool":"desktop.focus_window","idempotencyKey":"task_1:s1:1","args":{"window":{"process":"notepad.exe"}},"deadlineMs":45000}
← {"v":2,"kind":"reply","callId":"c3-5","status":"error","result":null,"verification":null,
   "error":{"code":"ambiguous_target","message":"2 windows match. Name one by its title.","retryable":false,
            "candidates":[{"process":"notepad.exe","title":"Untitled - Notepad","display":0},{"process":"notepad.exe","title":"notes.txt - Notepad","display":1}]},
   "evidenceIds":["ev_1"],"stopGeneration":7,"replayed":false}
```

No approval was created. The TypeScript check turns this into a clarification question for the user (the `clarify` mechanism from Phase 7A).

### 13.2 Denied

```json
← {"v":2,"kind":"reply","callId":"c3-6","status":"denied","result":null,"verification":null,
   "error":{"code":"approval_denied","message":"The user declined.","retryable":false},
   "evidenceIds":["ev_4","ev_5"],"stopGeneration":7,"replayed":false}
```

### 13.3 Executed, not verifiable

```json
← {"v":2,"kind":"reply","callId":"c3-9","status":"ok","result":{"executed":"click","control":"Save"},
   "verification":{"result":"unverifiable","method":"none","expected":null,"observed":null,"observationIds":["obs_7"]},
   "error":null,"evidenceIds":["ev_20","ev_21","ev_22"],"stopGeneration":7,"replayed":false}
```

The TypeScript outcome cannot be `completed`; the response says a click was performed and its effect was not confirmed.

### 13.4 Stop during execution

```json
← {"v":2,"kind":"reply","callId":"c3-11","status":"cancelled","result":{"batchesSent":3,"neutralised":true},"verification":{"result":"unverifiable","method":"none","expected":null,"observed":null,"observationIds":[]},
   "error":{"code":"emergency_stopped","message":"Emergency Stop. 3 of 12 characters were typed and may be present.","retryable":false},
   "evidenceIds":["ev_31"],"stopGeneration":8,"replayed":false}
```

### 13.5 Duplicate after completion

```json
→ (same callId or same idempotencyKey as c3-9, same args)
← {"v":2,"kind":"reply","callId":"c3-9","status":"ok", "...": "the stored reply", "replayed":true}
```

No input is injected; a journal entry `CallReplied (replayed)` is appended.
