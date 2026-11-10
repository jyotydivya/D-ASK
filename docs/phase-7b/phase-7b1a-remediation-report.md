# Phase 7B.1a: Safety Defect Remediation

**Date:** 2026-11-08. **Scope:** 7B.1a only. Nothing was staged or committed.
**No desktop input or actuation exists.** The execution engine still performs `Task.Delay` only; no `SendInput`, keyboard, mouse, window-manipulation or launch code was added, and no desktop permission was granted.
**Companion documents:** [safety contracts](phase-7b0-safety-contracts.md), [protocol design](phase-7b0-protocol-design.md), [threat model](phase-7b0-threat-model.md), [test specification](phase-7b0-test-specification.md).

This milestone corrects presentation, lifecycle, liveness, hashing and audit behaviour. **It does not complete the approval-to-execution flow:** `RequestApprovalAsync` still has no production caller, and no real action exists to approve.

---

## 1. Defects, root causes and fixes

### F1: panic-hotkey availability and HUD liveness

**Root cause.**
- **Availability:** a single global flag was set from `PanicHotkeyStatusNotification` and never cleared on disconnect.
- **Heartbeats:** the daemon answered them without recording anything.
- **What a ping proved:** it was sent from the HUD's IPC task, so it showed only that the pipe and that task were alive. It said nothing about the UI event loop or the panic-hotkey thread.

**Fix: a daemon-side liveness lease** ([HudLivenessMonitor.cs](../../src/DAsk.Daemon/IPC/HudLivenessMonitor.cs)).

| Rule | Value |
|---|---|
| States | `Unknown` → `Live` → `Expired`; `Ended` on disconnect (never revived) |
| Lease | 12 s from the last accepted heartbeat (`Daemon:HeartbeatLeaseMs`). The HUD pings every 5 s, so one missed ping is tolerated and two are not |
| Accepted only if | sequence strictly greater than any seen on the session; timestamp within 3 s of the daemon clock (`HeartbeatMaxSkewMs`); hotkey reported registered; **UI event-loop ack ≥ sequence − 1** and **hotkey-loop ack ≥ sequence − 1**; and the session's latest hotkey notification said "available" |
| Liveness proof | Before each ping the HUD posts probe `n` to the winit event loop (a user event) and to the hotkey thread (`WM_APP+0x51`); ping `n+1` carries what each loop acknowledged ([liveness.rs](../../src/hud-native/src/state/liveness.rs), [client.rs](../../src/hud-native/src/ipc/client.rs)). A hung loop stops acknowledging, so its pings stop renewing the lease |
| Immediate expiry | A fresh, in-order ping that fails a proof; a hotkey-unavailable notification |
| On loss | Panic-hotkey availability is recomputed (true only while some session is Live); the session's pending and granted approvals are invalidated; its actions are cancelled; an audit event is written |
| Recovery | Requires a new hotkey confirmation **and** a fresh valid heartbeat. The HUD re-sends the confirmation when a pong says the lease was not renewed |
| Delayed or replayed pings | Rejected (old timestamp, or a sequence not greater than the last); they cannot revive a lease |
| Reconnection | A new session starts at `Unknown`; nothing from the old session carries over |
| Emergency Stop | Not touched. Lease loss never sets or clears the latch; recovery never resumes |

**Gates.** The pipe server installs `IsLive` on the execution engine and the policy engine. No action is admitted, no approval is offered, and no decision is accepted for a session that is not live. This is checked at the fast path and again at the authoritative point under `_stateLock`. The daemon builds its own monitor if none is injected, so an open pipe is never treated as liveness.

**Backstop.** The lease is the backstop for a suspended or hung HUD. No low-level keyboard hook was added (it needs a separately reviewed design, D-4).

### F2: approval parameter hash

**Root cause.** Entries were joined as `key=value\n`, so `{a:"1", b:"2"}` and `{a:"1\nb=2"}` hashed identically. This is reproduced in the test `F2_ReportedCollision_ExistedBefore_AndIsGoneNow`. The hash the caller supplied was trusted at registration.

**Fix: DASK-CJ-1 canonical encoding** ([CanonicalJson.cs](../../src/DAsk.Daemon/Automation/Policy/CanonicalJson.cs)), with a full action digest.

| Aspect | Rule |
|---|---|
| Types | object, array, string, integer, true, false, null. Fractions, exponents and integers outside ±(2^53−1) are refused, so each number has exactly one spelling. `"1"`, `1` and `true` are different bytes |
| Objects | Members sorted by ordinal UTF-16 code units; duplicate names refused; a missing member is not the same as `null`; key order in the input does not matter |
| Strings | UTF-8. `"` and `\` escaped; `\b \f \n \r \t` short; other U+0000–U+001F as `\u00xx`; everything else literal; unpaired surrogates refused; **no Unicode normalisation** (NFC and NFD differ) |
| Bounds | Depth 16, 256 members, 8,192 characters per string, 64 KiB output |
| Hash | `SHA-256(UTF8(domain) ‖ 0x00 ‖ canonical)`, lowercase hex; domain `DASK-PARAMS-V1` for parameters, `DASK-ACTION-V1` for the action digest |
| Action digest | Covers the whole canonical action: schema, approval and action ids, type, parameters, parameter hash, target (process, title, HWND, PID, creation time), session, stop generation, risk, reason, creation and expiry times |
| Authority | At registration the daemon recomputes the parameter hash (a different supplied value is refused), discards any supplied digest or canonical text, and sets its own. An approval needs the HUD to echo **both** the parameter hash and the action digest. The daemon recomputes both from what it holds at decision time |

### F3: approval presentation

**Root cause.** The modal rendered the action type, process name, HWND, risk, reason and the SHA-256. `actionParameters` reached the page and was never shown.

**Fix.**
- **Daemon:** sends the canonical action text with every request (`canonicalAction`). It refuses to register an operation it cannot show exactly (`ValidateRepresentable`):
  - control characters other than line breaks and tabs;
  - bidirectional overrides;
  - unpaired surrogates;
  - parameter names that look like secrets (`password`, `token`, `api_key`, `pin`, …);
  - more than 32 parameters, or values over 2,000 characters;
  - undisplayable process names, titles or reasons.
- **The new panel** ([ApprovalSurface.tsx](../../components/ApprovalSurface.tsx), logic in [approvalLifecycle.ts](../../hooks/approvalLifecycle.ts)) renders **only from the canonical action bytes**:
  - the action;
  - the application, window, PID and HWND;
  - the requested operation;
  - every parameter in full;
  - the text to be entered, with its length;
  - the expiry countdown (from the daemon's expiry time);
  - the risk;
  - a "simulated: no real input" notice for `Simulated*` types.

  The digest is shown only as a small technical detail. If the canonical action is missing, unparseable, inconsistent with the outer fields, or contains anything undisplayable, the panel shows why and offers **no** decision; the approval then expires.

### F4: approval lifecycle

**Root cause.** The modal was cleared only by Emergency Stop events and its own local 30 s timer. Daemon-side expiry, invalidation and disconnect never reached the HUD, and a late click was silently ignored.

**Fix.**
- **Requests:** the daemon sends `ActionApprovalRequest` to the owning session only.
- **Every state change:** it sends `ApprovalStateNotification` (also owner-only) for each change:
  - Approved, Denied, Expired, Cancelled;
  - InvalidatedByEmergencyStop, Disconnected;
  - Rejected (integrity, representability, liveness).
- **Late or duplicate decisions:** answered with `decisionAccepted: false` and the approval's actual state, from a bounded cache of recent terminal states.
- **TTL:** clamped to 30 s inside the policy engine.

**Page states.**

| From | To | Rule |
|---|---|---|
| `pending` | `submitting` | Only when the panel is armed (1 s after it appears) and the approval has not expired; one decision only |
| `submitting` | `Approved` or `Denied` | Only on the daemon's notification. The panel never shows "approved" first |
| any | terminal state | Disables the buttons; the panel closes after 5 s |

A Stop, a disconnect, or local expiry also disables the panel at once. The daemon stays authoritative. The old modal, its local auto-deny timer and the page's own decision code were removed from `JarvisOrb.tsx`.

### D-5: approval in Ambient mode

**Root cause.** In Ambient mode the overlay re-applied `WS_EX_TRANSPARENT` every 16 ms over the whole window, and the page cannot raise the mode.

**Fix: one bounded approval surface** ([overlay.rs](../../src/hud-native/src/overlay.rs)).
- **When it exists:** only between the daemon's request and its terminal state. Stop, disconnect and expiry also end it.
- **What takes input:** one rectangle that the page reports for that approval id. It must be at most 640×600 CSS px and inside the window; anything else is refused.
- **Arming:** only after 800 ms in the host, so a click already in flight cannot land on it.
- **One click:** it is disarmed after a decision click, until the daemon answers.
- **No focus or keys:** the window keeps `WS_EX_NOACTIVATE`.
- **Race-free:** the decision is re-checked under the existing style lock, so ending an approval always restores click-through.
- **Unchanged:** the rest of the HUD, Interactive and Hidden modes, and the hotkeys. The page still cannot raise the mode.

### F5: audit serialization and evidence integrity

**Root cause.**
- `details_json` was built by string interpolation from caller-influenced text (action types, process names).
- Both tables used `INSERT OR REPLACE`.
- Writes were unbounded.

**Fix** ([AuditJson.cs](../../src/DAsk.Daemon/Research/AuditJson.cs), [SqliteEvidenceRecorder.cs](../../src/DAsk.Daemon/Research/SqliteEvidenceRecorder.cs)).

**Serialization:**
- Every `DetailsJson` is serializer-built.
- Strings are bounded with an explicit `…[truncated N chars]` marker.
- Details over 8 KiB are refused.

**Validation:** the recorder rejects malformed records (bad event type, non-object or invalid details JSON, oversized fields) and logs the rejection. Nothing is "fixed up".

**No overwrite:**
- Plain `INSERT` for both tables, so a duplicate id is an error.
- New triggers make `safety_audit_trail` append-only: `UPDATE` and `DELETE` abort. Existing rows are unchanged.

**Hash chain:** a new, additive table, `safety_audit_chain`, also append-only. Each event recorded from this version on is linked in the same transaction as its row:

| Element | Definition |
|---|---|
| `seq` | Contiguous from 1 |
| Canonical row | The DASK-CJ-1 form of the stored columns |
| `prev_hash` | The previous event's hash |
| Genesis | `Digest("DASK-AUDIT-CHAIN-V1", "genesis")` |
| `hash` | `Digest("DASK-AUDIT-CHAIN-V1", prev ‖ "\n" ‖ seq ‖ "\n" ‖ canonical)` |

`VerifyAuditChainAsync` checks, in order:
1. contiguous sequence numbers;
2. every link;
3. every recomputed hash;
4. that each chained row still exists and canonicalises to the chained text.

It reports the first failure and repairs nothing. Rows recorded before the chain existed are counted as "unchained", not treated as errors. **No historical row was migrated or rewritten.**

**Limit:** the chain makes accidental or partial modification detectable. A same-user process that rewrites the whole file can still forge it.

**Pre-existing defect fixed:** the `approval_id` index was created before the migration that adds that column. On an older database, initialisation, and with it every audit write, failed. The index is now created after the migration.

### F6: the dropped `TaskApproval` message

**Trace.**
1. **Page:** never sends `Approval`.
2. **Rust bridge:** still accepted it and sent `TaskApproval`.
3. **Daemon:** had no handler. The default branch raised `EnvelopeReceived`, which has no subscriber, so the message was dropped.
4. **Agent host:** not involved.

**Conclusion:** obsolete. There is exactly one approval path, `ActionApprovalResponse` to the policy engine.

**Fix.**
- **HUD:** refuses `Approval` locally with a structured `MessageRejectedNotification` (`obsolete_authorization_message`) and does not send it.
- **Daemon:** answers `TaskApproval` with the same code. It answers any other unhandled type (`UserCommand`, `TaskCancel`, …) with `unsupported_message`.
- **Nothing is dropped silently** and no second approval flow was created.

---

## 2. New safety invariants

These are in addition to SI-1…SI-17.

| ID | Invariant |
|---|---|
| SI-18 | An open, authenticated pipe is not liveness. Only a fresh heartbeat with event-loop and hotkey-loop proof makes a HUD live. |
| SI-19 | Panic-hotkey availability is derived from live HUDs and is withdrawn the moment the last one loses its lease or disconnects. |
| SI-20 | Approval hashes are computed by the daemon over an injective canonical form. Nothing a caller supplies is authoritative. |
| SI-21 | The HUD renders an approval only from the exact canonical action the daemon hashed. Anything it cannot show exactly is not offered. |
| SI-22 | Every approval state change, and every refused decision, is reported to the owning HUD. |
| SI-23 | In Ambient mode only the pending approval's bounded, armed panel may take mouse input, never focus or keys. |
| SI-24 | Audit records are serializer-built, validated, append-only, and hash-chained from this version on. |
| SI-25 | No message is dropped silently. Obsolete authorization messages are refused explicitly. |

---

## 3. Files changed and why

| File | Change |
|---|---|
| `src/DAsk.Protocol/IPC/Messages/Heartbeat.cs` | Liveness proof fields; pong verdict; `MessageRejectedNotification` |
| `src/DAsk.Protocol/IPC/Messages/ComputerUse/ActionApprovalMessages.cs` | `ActionDigest`, `CanonicalAction`; `ApprovalStates`; `ApprovalStateNotification`; digest echo in the response |
| `src/DAsk.Daemon/Automation/Policy/CanonicalJson.cs` (new) | DASK-CJ-1 encoder and digests |
| `src/DAsk.Daemon/Automation/Policy/ActionPolicyEngine.cs` | Injective hash; daemon-built canonical action and digest; representability check; TTL clamp; liveness gate; owner-only events; terminal and late-decision notifications; serializer-built audit |
| `src/DAsk.Daemon/Automation/Execution/ActionExecutionEngine.cs` | Liveness gate at both admission points; serializer-built audit; bounded fields. **Still no real input** |
| `src/DAsk.Daemon/IPC/HudLivenessMonitor.cs` (new) | Liveness lease |
| `src/DAsk.Daemon/IPC/IpcClientSession.cs` | Heartbeats evaluated; hotkey reports routed to the monitor; teardown withdraws liveness first; structured rejection of unhandled messages |
| `src/DAsk.Daemon/IPC/NamedPipeServer.cs` | Owns or receives the monitor; installs gates; owner-only approval request and state delivery |
| `src/DAsk.Daemon/Configuration/DaemonOptions.cs`, `Program.cs` | Lease options; monitor registered with the evidence recorder |
| `src/DAsk.Daemon/Research/AuditJson.cs`, `AuditChainVerification.cs` (new); `SqliteEvidenceRecorder.cs` | F5 |
| `src/hud-native/src/state/liveness.rs` (new); `ipc/client.rs`; `ipc/protocol.rs`; `main.rs` | Probes and acknowledgements; proof-carrying pings; re-confirmation; new messages; approval surface wiring; legacy `Approval` refused |
| `src/hud-native/src/overlay.rs` | Ambient approval surface |
| `src/hud-native/src/approval_fixture.rs` (new), `Cargo.toml` | **Test-only** fixture behind the `approval-fixture` feature (not in production builds) |
| `components/ApprovalSurface.tsx`, `hooks/approvalLifecycle.ts` (new); `components/JarvisOrb.tsx` | New panel and lifecycle; old modal removed |
| `scripts/hud/approval-surface-tests.ps1` (new) | Real-click fixture test |
| Tests | See section 4 |

**Existing tests that were adapted** (no assertion was weakened):

| Change | Tests |
|---|---|
| A correct HUD now echoes the action digest | 12 decision sites, plus the `ApprovalSessionBindingTests.Submit` helper |
| Owner sessions now heartbeat via `MakeLiveAsync` before owning approvals or actions | H39 wire tests, H38, lifecycle broadcast |
| Requests now carry parameters that match their claimed hash, because the old mismatch is now refused at registration (and that refusal has its own new test) | Scenario 04, Scenario 06 |

---

## 4. Tests executed (actual results)

| Command | Result |
|---|---|
| `dotnet test tests/DAsk.Daemon.Tests` (baseline, before changes) | 256 passed, 1 failed (`RepeatedScreenCapture_Benchmark…`, timing; passes alone) |
| `dotnet test … --filter "Phase7B1aTests\|P7B1a_"` (new) | **50 passed, 0 failed** |
| `dotnet test tests/DAsk.Daemon.Tests` (after, run 1) | 306 passed, 1 failed (`Test09_Stop_BetweenApprovalValidationAndDispatch`, which asserts a queue count after a fixed 30 ms delay; passed 5 of 5 alone) |
| `dotnet test tests/DAsk.Daemon.Tests` (after, run 2) | **307 passed, 0 failed** |
| `cargo test` (hud-native; baseline 44 passed, 1 ignored) | **53 passed, 0 failed, 1 ignored** |
| `npx tsx tests/hud-agent/approval-lifecycle.test.ts` (new) | **46 passed, 0 failed** |
| `npx tsx tests/hud-agent/native-agent.test.ts` | 92 passed, 0 failed |
| `npx tsx tests/agent-host/host-protocol.test.ts` / `experimental.test.ts` | 81 / 31 passed, 0 failed |
| `scripts/hud/approval-surface-tests.ps1` (fixture HUD release build, real mouse input on D-ASK's own fixture windows only) | **15 passed, 0 failed** (`results/phase7b1a/approval-surface/`) |

**What the new tests cover:**
- **Liveness:** disconnect; process end (on a named pipe this is the same as disconnect); suspension with the pipe open; delayed and replayed heartbeats; an unresponsive event loop and hotkey loop; hotkey registration failure and withdrawal; recovery; reconnection; Stop during lease expiry; no authorization after expiry.
- **Hashing:** the reported collision and its key variant; types; missing, null and empty; nesting; arrays; Unicode, escaping and NFC versus NFD; key order; duplicates; floats and big integers; surrogates; depth; added and substituted parameters; domain separation; the action digest binding every field.
- **Approvals:** every terminal state; late and duplicate decisions; missing or wrong digest; TTL clamp; representability refusals; owner-only delivery.
- **Audit:** hostile strings in engine and policy details; validation; duplicate-id refusal; triggers; chain verification; tampering, missing link and missing row detected; historical rows untouched (two old schemas).
- **Messages:** `TaskApproval` and other unhandled messages rejected explicitly.
- **Real-click fixture:**
  - Ambient click-through, with and without an approval;
  - the panel shows the exact operation;
  - only the panel takes input, still non-activating;
  - Deny and Approve, with no click reaching the application behind and focus not taken;
  - a click before arming passes through;
  - cancellation and expiry;
  - Interactive and Hidden unchanged.

**Not run, and why:**
- The Phase 6 overlay and walkthrough scripts run against the Release package, which was not rebuilt. The fixture test covers the overlay behaviour that changed.
- The historical Phase 6 and 7A offline tests were not rerun, as instructed.
- No stop-to-silence latency was measured, so none is claimed.

**Build notes:**
- `target/debug/hud-native.exe` was rebuilt by `cargo build`.
- The fixture was built into `target/fixture/` only.
- `target/release/hud-native.exe` (2026-11-07) and the package under `dist/` were not touched.
- The repository's `.next` page build was regenerated with `npm run build`; the package keeps its own copy.

---

## 5. Before and after

| Situation | Before | After |
|---|---|---|
| HUD disconnects | Hotkey still "available" | Withdrawn; approvals invalidated; actions cancelled |
| HUD suspended, pipe open | Undetected | Lease lapses within 12 s; same effects |
| HUD UI loop hung, IPC alive | Undetected | Next ping fails its proof; liveness ends at once |
| Old or replayed ping | Answered, meaningless | Rejected; cannot renew or revive |
| `{a:"1",b:"2"}` vs `{a:"1\nb=2"}` | Same hash | Different hashes |
| Caller-supplied hash or digest | Trusted at registration | Recomputed; a mismatch is refused; digest echo required |
| Approval with a 10-minute expiry | Accepted | Clamped to 30 s |
| Approval display | Digest and process name | Exact canonical action, every parameter, text, expiry, risk |
| Undisplayable or secret parameter | Shown as-is | Refused; never offered |
| Daemon expiry, cancel, invalidation | HUD not told; modal clickable | HUD told; panel disabled and closed |
| Late or duplicate click | Ignored silently | Answered "not accepted"; authorizes nothing |
| Ambient approval | Unclickable | Only the bounded, armed panel takes clicks; no focus |
| Hostile text in audit details | Could break or forge JSON | Serializer-built; validated |
| Duplicate audit id | Silently replaced | Refused; table append-only; chain verifiable |
| `TaskApproval` | Silently dropped | Explicitly rejected |

---

## 6. Remaining risks and limitations

1. **The approval-to-execution flow is not complete.**
   - Nothing in production creates approvals.
   - The agent-to-daemon channel (7B.1b) and any executor (7B.3) do not exist.
   - Liveness gates apply to the existing simulated actions only.
2. **The liveness lease is not a hotkey replacement.** It bounds how long a dead HUD goes unnoticed (≤ 12 s), but it cannot stop an action that is already running. The daemon-side low-level hook (D-4) remains a separate, unreviewed design.
3. **No latency measured.** Neither stop-to-silence nor lease-detection latency was measured on real hardware. The lease figures come from the configuration and the clock-driven tests.
4. **Clock coupling.** Heartbeat freshness compares HUD and daemon wall clocks, which share one machine clock. A large clock change during a session can cost one lease period (fail-closed).
5. **Hash chain limits.** It covers events recorded from now on. Older rows are unchained (reported, untouched), and a same-user attacker can rewrite the whole file.
6. **Audit writes are still fire-and-forget at most call sites.** Write-ahead for real actions remains a 7B.3 requirement.
7. **The page does not recompute the digest itself.** `crypto.subtle` is not assumed in the `dask://` origin. It renders the exact bytes and the daemon verifies the echo.
8. **Real-click coverage is fixture-only.** It exercised the overlay, the page and real input, but not the daemon round trip. That round trip is covered at wire level by the C# tests.
9. **Pre-existing flaky tests.** Two timing-sensitive daemon tests (`RepeatedScreenCapture_Benchmark…`, `Test09…`) can fail under full-suite load and pass alone.

**Phase 7B.1b has not been started.**
