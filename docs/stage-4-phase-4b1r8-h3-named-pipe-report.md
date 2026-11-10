# Phase 4B-1R.8 — H3 Named Pipe Security: Implementation, Review Follow-up, Startup Fix

Status: implemented, **uncommitted** (no commit, tag or push authorized). HEAD `6ef576f`, tag `phase-4b-1-accepted` unchanged.
Not modified: R.3–R.7 code (`src/DAsk.Daemon/Automation` has 0 changes), `Program.cs`, Rust `main.rs`, protocol messages.

## 1. Findings that deviated from the plan

1. **A Deny-NETWORK ACE does not block loopback SMB.** Measured: opens via machine name, `localhost` and `127.0.0.1` are genuinely remote (`GetNamedPipeClientComputerName` succeeds) but the same-user loopback token has no NETWORK SID. Fix: the pipe is created with `CreateNamedPipeW` + `PIPE_REJECT_REMOTE_CLIENTS`, the verifier also rejects any remote client; the deny ACE remains as a redundant layer. Not tested: a genuine second machine, the inbound firewall.
2. **The test project references `DAsk.Daemon.dll` by hint path**, so `dotnet test` does not rebuild the daemon. Build the daemon explicitly first. (Earlier R.6/R.7 "fresh build" statements covered only the test project; still valid because no `.cs` changed in those phases.)
3. **The Rust host cannot be built the usual way here** (no Visual Studio C++ tools). Built with the repo's `.xwin-sdk` + `rust-lld` into `src/hud-native/target/h3-verify` (≈1.8 GB, gitignored, safe to delete).
4. **A fatal pipe error originally ended the daemon via an unhandled exception** (exit `-532462766`). Fixed in section 5.

## 2. What was implemented

**Daemon (`src/DAsk.Daemon`)**
- `IPC/NamedPipeServer.cs`: first-instance protection on the initial instance only; squat / ACL failure / creation failure throws `PipeServerFatalException` and stops the daemon (no retry loop). "All instances busy" is the only tolerated error. Next instance re-opened immediately after each accept. Lifecycle notifications go to authenticated sessions only.
- `IPC/IpcClientSession.cs`: peer verified before any read; only `HandshakeRequest` is processed before authentication (anything else closes the connection, no reply, no state change); handshake timeout enforced; handshake PID must equal the verified PID; authenticated only after the response is sent; verified PID replaces per-request PID re-query; verifier is a required constructor parameter.
- New: `IPC/HardenedPipeFactory.cs`, `IPC/PipePeerVerification.cs`, `IPC/PipeSecurityFactory.cs`.
- Config: `Configuration/DaemonOptions.cs`, `appsettings.json` gain `AllowedClientImagePaths` (empty = accept nobody) and `HandshakeTimeoutMs`.

**Rust host (`src/hud-native`)**
- `src/ipc/client.rs`: verifies the server on every connection after open and before handshake; explicit anonymous SQOS; handshake `daemon_process_id` must match the verified PID; the only unverified entry point is `#[cfg(test)]`; refusals logged loudly, rate-limited.
- New `src/ipc/peer.rs`; `src/ipc/mod.rs`; `Cargo.toml` (extra `windows` crate features).

**Tests (`tests/DAsk.Daemon.Tests`)**
- New: `PipeSecurityBehaviorTests.cs`, `PipePeerVerifierTests.cs`, `TestPeerVerifiers.cs` (permissive verifier exists only in the test assembly).
- Edited: `ExecutionEngineCorrectnessTests.cs` (2 call sites), `IpcIntegrationLiveTests.cs` (allowlists the test host through config), `DAsk.Daemon.Tests.csproj` (Hosting.Abstractions, then Hosting 8.0.0).

## 3. Review follow-up findings

### 3.1 Production executable identity
- **There is no production launch path in the repo.** Neither Rust nor `main.js`/`package.json` starts the daemon or host; both are started by hand or by `scratch/*.ps1` / `tests/*.ps1` scripts. Only the dev layout exists, so the allowlists below are dev configuration, not production configuration.
- Daemon allowlist (`appsettings.json:16-17`): `../../../../hud-native/target/{debug,release}/hud-native.exe` resolved from `AppContext.BaseDirectory`.
- Host allowlist (`peer.rs:115-128`): the `hud-native` ancestor of `current_exe()` → `src\DAsk.Daemon\bin\{Debug,Release}\net8.0\DAsk.Daemon.exe`.
- They match only for the stock cargo layout. A host built elsewhere (e.g. `target\h3-verify`) is refused by the daemon unless `DASK_Daemon__AllowedClientImagePaths__0` is set. A daemon launched as `dotnet DAsk.Daemon.dll` (as `tests/test_stage3_reconnect.ps1:5,16` does) has image `dotnet.exe` and is refused by the host. A stale `bin\Debug\net8.0-windows\DAsk.Daemon.exe` is not allowlisted either.
- **All involved directories are user-writable** (`Authenticated Users: Modify`, inherited from the `D:\` root), so any local account can replace either executable. The allowlist is defense-in-depth only. A real deployment needs an install location writable only by Administrators.

### 3.2 Rust artifact
| | Path | Size | Written | SHA-256 |
|---|---|---|---|---|
| Stale | `src\hud-native\target\debug\hud-native.exe` | 6,346,752 | 31-10-2026 23:59:24 | `124E4F2BFDCD9B5D305A4E6EB8EC33BCE18173B4201F060534EF4A729578972A` |
| Modified | `src\hud-native\target\h3-verify\debug\hud-native.exe` | 6,730,240 | 02-11-2026 02:10:28 | `71CD5C6824B2640B2F140D84CE18C74944E2F082C1DE7813851F42180C56B893` |

Reproducible build (PowerShell, cargo/rustc 1.99.1):
```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
$env:LIB = "D:\D-ASK\D-ASK\.xwin-sdk\crt\lib\x86_64;D:\D-ASK\D-ASK\.xwin-sdk\sdk\lib\um\x86_64;D:\D-ASK\D-ASK\.xwin-sdk\sdk\lib\ucrt\x86_64"
$env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = "C:\Users\divya\.rustup\toolchains\stable-x86_64-pc-windows-msvc\lib\rustlib\x86_64-pc-windows-msvc\bin\rust-lld.exe"
$env:RUSTFLAGS = "-C linker-flavor=lld-link"
$env:CARGO_TARGET_DIR = "D:\D-ASK\D-ASK\src\hud-native\target\h3-verify"
cd D:\D-ASK\D-ASK\src\hud-native
cargo build --offline --bin hud-native
```
**Production integration is NOT verified.** Nothing launches `target\h3-verify\...`; the app still launches the stale `target\debug` binary. Earlier live Rust-vs-daemon runs used a `cargo test` binary. To run the real app against the modified host, build into the default target dir (overwrites `target\debug\hud-native.exe`, needs approval) or allowlist `h3-verify` (not authorized).

### 3.3 Fatal startup path (root cause)
`BackgroundService.StartAsync` runs `ExecuteAsync` synchronously up to its first `await`. The first-instance failure was thrown before any `await`, so `Host.StartAsync`/`RunAsync` threw ("Hosting failed to start"), `Main` died with an unhandled exception (exit `-532462766`, 0xE0434352) and that overrode `Environment.ExitCode = 1`. Measured in a scratch probe: sync throw → `-532462766`; throw after `Task.Yield()` → "BackgroundService failed", `StopHost`, `RunAsync` returns, exit code 1.

## 4. Test evidence

Commands run from `D:\D-ASK\D-ASK`, `$d = C:\Users\divya\.dotnet\dotnet.exe`. Command forms; earlier transcript strings were partly truncated.

| Step | Command | Result |
|---|---|---|
| Fresh daemon build | `$d build src\DAsk.Daemon\DAsk.Daemon.csproj -c Debug --no-incremental` | 0 errors |
| Test-project build | `$d build tests\DAsk.Daemon.Tests\DAsk.Daemon.Tests.csproj` | 0 errors |
| Focused / IPC (final, after the startup fix) | `$d test tests\DAsk.Daemon.Tests\DAsk.Daemon.Tests.csproj --no-build -f net8.0 --filter "FullyQualifiedName~PipeSecurityBehaviorTests\|...PipePeerVerifierTests\|...ExecutionEngineCorrectnessTests\|...IpcIntegrationLiveTests\|...IpcProtocolTests"` | **88 passed, 0 failed** |
| Rust | `cargo test --offline --bin hud-native` (env block above) | 26 passed, 1 ignored (live test) |
| Live harness vs real `DAsk.Daemon.exe` (scratchpad, not in repo) | `h3live` | 14/14 |
| Rust client vs real daemon (scratchpad) | `h3live rust` | 4/4 |
| Full .NET suite, original R.8 run | `$d test ... --no-build -f net8.0` | **150 passed, 1 failed** — `RepeatedScreenCapture_Benchmark` 38 ms vs 30 ms budget; passed 4/4 in isolation at ~27 ms; not relabelled as a pass |
| Full .NET suite, after the startup fix | same | **153 passed, 0 failed** (benchmark passed this run; it is timing-sensitive under parallel load) |

Failing-first: against the original daemon 17 of 19 behaviour tests failed for the intended reasons (2 were preservation guards).
Live harness coverage: squatting (maxInstances 4 and 1), duplicate daemon, real pipe DACL, Everyone-only restricted token, SMB denial on three hosts, 9 forged pre-handshake message types, exhaustion, PID mismatch, 5 reconnects, wrong identity, stop delivery from the Rust host.

## 5. Startup exception correction (final change)

- `src/DAsk.Daemon/IPC/NamedPipeServer.cs`: `await Task.Yield();` is the first statement of `ExecuteAsync` (line 97) with a comment explaining the asynchronous boundary. Fatal startup now goes through the host's `StopHost` path: critical log, graceful stop, `RunAsync` returns, exit code 1, nothing served, no retry loop.
- `tests/DAsk.Daemon.Tests/PipeSecurityBehaviorTests.cs`, two real-`IHost` tests:
  - `SquattedPipe_RealHost_RunAsyncReturnsThroughControlledShutdown_ExitCode1_NothingServed_NoRetry`: RunAsync returns (≤15 s) without throwing, exit code 1, "BackgroundService failed" present and "Hosting failed to start" absent, exactly one critical log and one startup log (still 1 after 1.5 s), verifier never called, no "Client connected".
  - `LegitimatePipe_RealHost_StartsServesAndShutsDownCleanly_ExitCodeStaysZero`: client connects and is verified, cancel → RunAsync returns, exit code 0, no critical logs.
- `tests/DAsk.Daemon.Tests/DAsk.Daemon.Tests.csproj`: added `Microsoft.Extensions.Hosting` 8.0.0.
- Failing-first confirmed: with the `Yield` removed the squat test fails; restored afterwards.

## 6. Residual risks and limitations

- **H3-8 (open at the time of R.8; RESOLVED in R.9a, see section 9):** `ResumeExecutionRequest` with `stopGeneration=0` skipped the generation check. Documented at the site in `IpcClientSession.cs`; needed a separate, narrowly scoped remediation (R.5 engine must not be modified in R.8). This bullet is kept as the historical R.8 finding.
- **H3-9 (open at the time of R.8; addressed in R.9b, see section 10):** approval decisions are not bound to the originating session. Documented at the site. The handshake gate now limits who can reach both. Kept as the historical R.8 finding.
- **Same-user malware is not stopped.** The exact-path allowlist does not protect against code injected into an allowed process or replacement of the executable; the dev allowlist points into user-writable `target/` directories, and `Authenticated Users` has Modify on them.
- **Host refuses a daemon started as `dotnet DAsk.Daemon.dll`** (image is `dotnet.exe`); start via the apphost. While refused, emergency-stop delivery to the real daemon is unavailable (loud log says so). `tests/test_stage3_reconnect.ps1` still uses the `dotnet` form.
- **PID-reuse residual:** a pipe handle duplicated into another process while the original exits can slip past the creation-time rule.
- **Behaviour change:** malformed JSON before authentication now closes the connection (it used to be skipped).
- **No live Authenticode/signature check** of peer executables.
- **Process-level squat check not re-run** after the `Yield` fix: verified through the real hosted service in a test host, not by launching `DAsk.Daemon.exe` against a squatted pipe.
- "Application started" is now logged just before the pipe exists.
- Minor leak in a rare fatal path: if next-instance creation fails right after an accept, the accepted stream/session is not disposed (process is exiting).
- Live harness and probes live in the session scratchpad, not the repo.

## 7. Open decisions / next steps (not authorized)

1. Build the modified host into `target\debug` (or otherwise make the real app launch it) to verify production integration.
2. Decide whether to update `tests/test_stage3_reconnect.ps1` to launch `DAsk.Daemon.exe` directly.
3. Define a production install layout and allowlist (Administrator-writable location).
4. Separate remediation for H3-8 and H3-9; H2, M1/M2 and Phase 4B-2 remain out of scope. (Update: H3-8 done in R.9a, section 9; H3-9 still open and not authorized.)
5. Housekeeping: `D:\dask_r7_live_tmp` (R.7 disposable copy) still needs manual removal; `target\h3-verify` can be deleted.

## 8. Files changed (all uncommitted)

Modified: `src/DAsk.Daemon/Configuration/DaemonOptions.cs`, `src/DAsk.Daemon/IPC/IpcClientSession.cs`, `src/DAsk.Daemon/IPC/NamedPipeServer.cs`, `src/DAsk.Daemon/appsettings.json`, `src/hud-native/Cargo.toml`, `src/hud-native/src/ipc/client.rs`, `src/hud-native/src/ipc/mod.rs`, `tests/DAsk.Daemon.Tests/DAsk.Daemon.Tests.csproj`, `tests/DAsk.Daemon.Tests/ExecutionEngineCorrectnessTests.cs`, `tests/DAsk.Daemon.Tests/IpcIntegrationLiveTests.cs`.
New: `src/DAsk.Daemon/IPC/HardenedPipeFactory.cs`, `src/DAsk.Daemon/IPC/PipePeerVerification.cs`, `src/DAsk.Daemon/IPC/PipeSecurityFactory.cs`, `src/hud-native/src/ipc/peer.rs`, `tests/DAsk.Daemon.Tests/PipePeerVerifierTests.cs`, `tests/DAsk.Daemon.Tests/PipeSecurityBehaviorTests.cs`, `tests/DAsk.Daemon.Tests/TestPeerVerifiers.cs`, and this report. (R.9a additions are listed in section 9.4.)

## 9. Phase 4B-1R.9a: H3-8 Resume generation validation (added later)

Sections 1-8 above are the historical R.8 record and are unchanged apart from the cross-references to this section. Everything below is the later R.9a work; its test counts are not comparable with the R.8 counts in section 4 (the suite grew).

### 9.1 What changed

- **Required stop generation.** `ActionExecutionEngine.ResumeExecutionAsync(source, reason, ulong stopGeneration, resumeId?, sessionId?, drainTimeout?)` takes a required, non-nullable generation. The nullable bypass (`ulong? expectedGeneration`) is gone.
- **Zero-to-null bypass removed.** `IpcClientSession` used to map a wire generation of 0 (also what a missing field deserializes to) to `null`, meaning "unchecked". The wire value is now passed through unchanged.
- **Rejected generations.** Missing/zero, stale and future generations are rejected whether or not execution is stopped. When stopped, only the exact current generation clears the latch. When not stopped, only the exact current generation returns idempotent success.
- **Pre-drain validation.** An advisory check runs before the active-action drain, so an invalid Resume neither waits for in-flight actions nor gets an idempotent success.
- **Authoritative under-lock validation.** The check is repeated under `_stateLock`, atomically with the latch transition. A Stop that arrives during the drain advances the generation, so an older Resume can no longer match and cannot clear the newer Stop.
- **Null engine fails closed.** The `_executionEngine == null` Resume branch in `IpcClientSession` used to set status Normal and return `Success = true` with a made-up generation 1, an unvalidated latch clear. It now logs an error and returns `Success = false` (`StopGeneration = 0`) without touching state. It is unreachable with the shipped `Program.cs` (the engine is a registered singleton, injected into the `readonly` field of `NamedPipeServer`, which is the only creator of sessions), but the engine parameter is optional, so the guarantee rested on the DI registration alone.
- Unchanged: cancellation/drain behaviour, emergency Stop, reconnect and the Rust host (it already sends a generation of at least 1). The null-engine Stop branch still reports generation 1 (failing toward "stopped" is the safe direction).

### 9.2 Tests added or changed

- `tests/DAsk.Daemon.Tests/ResumeGenerationWireTests.cs` (new; partial class `PipeSecurityBehaviorTests`, real pipe, real `NamedPipeServer`, real engine): explicit-zero and omitted generation, stale/future/exact while stopped and while not stopped, replay after a newer Stop, invalid Resume not waiting for the drain, second session unable to clear another session's Stop, a source guard (no nullable bypass, exactly one production caller), and `H38_NullEngine_Resume_FailsClosed_ForAnyGeneration_AndDoesNotMutateState` (server built with `executionEngine: null`; Stop, then Resume with 0, 1, 2 and omitted all fail, status stays `EmergencyStop`, state-manager mutation count unchanged).
- `tests/DAsk.Daemon.Tests/ResumeGenerationEngineTests.cs` (new): engine-level matrix, including the deterministic race (a valid Resume parked in the drain, a new Stop advances the generation, the older Resume is rejected and the new Stop survives) and 100 iterations of concurrent twin Resumes against a new Stop.
- `PipeSecurityBehaviorTests.cs` made `partial` to share the harness. `ExecutionEngineCorrectnessTests.cs`, `SafetyInfrastructureTests.cs` and `SafetyRemediationTests.cs` updated to the new signature (mostly `engine.CurrentStopGeneration`, i.e. the current value read at call time, not a hard-coded literal).
- All new tests are named `H38_*`; run alone with `--filter "FullyQualifiedName~H38_"`.

### 9.3 Evidence

Failing-first and mutation checks (latest R.9a work):

- Against the unchanged code, 6 of the 8 original wire/structural tests failed for the intended reasons (explicit zero while stopped, omitted generation while stopped, not-stopped zero/omitted/future, second-session zero, invalid Resume waiting for the drain (5 s), source guard). Stale/future-while-stopped passed as guards because the engine already rejected explicit mismatches.
- Mutation: zero accepted by the validator failed only the zero-message test (zero still fails the mismatch check; the real zero bypass was the IPC mapping, covered by the wire and source-guard tests). Authoritative under-lock check removed failed the new-Stop race test and the concurrent-twins test. Pre-drain rejection removed failed the wire drain test (5 s) and the engine drain test (10 s).
- Null engine: with the old fail-open success response put back temporarily, `H38_NullEngine_...` failed ("without an engine no Resume may succeed"); restored afterwards. This simulates the old success response; it did not reinstate the old `SetStatus` call.

Latest results (daemon rebuilt with `--no-incremental`, then the test project; `--no-build -f net8.0`):

| Run | Result |
|---|---|
| H3-8 (`FullyQualifiedName~H38_`) | **15 passed, 0 failed** |
| Focused (pipe security, peer verifier, engine correctness, IPC live, IPC protocol, safety infrastructure, safety remediation, resume-generation engine) | **132 passed, 0 failed** |
| Full .NET suite | **168 passed, 0 failed** |

History inside R.9a, not to be lost: an earlier full run of the R.9a changes (before the null-engine fix) was **165 passed, 2 failed of 167**: `RepeatedScreenCapture_Benchmark_And_ResourceStability_Test` (median about 39.5 ms vs 30 ms budget) and `Scenario16_Queue_Cancellation_Latency_Benchmark_N30` (`ActiveActionsCancelled` 0, expected 1). Neither is attributed to H3-8. The 168/168 run is the latest; it passed without any change to those two tests, so it does not show they are fixed.

### 9.4 Files changed in R.9a (all uncommitted)

Source: `src/DAsk.Daemon/Automation/Execution/ActionExecutionEngine.cs`, `src/DAsk.Daemon/IPC/IpcClientSession.cs`.
Tests: new `ResumeGenerationWireTests.cs`, new `ResumeGenerationEngineTests.cs`; modified `PipeSecurityBehaviorTests.cs`, `ExecutionEngineCorrectnessTests.cs`, `SafetyInfrastructureTests.cs`, `SafetyRemediationTests.cs`.
Docs: this report.

### 9.5 Limitations that remain

- **Timing-sensitive benchmark tests may fail intermittently** (the screen-capture benchmark and Scenario16 above). Thresholds were not changed.
- **Queue-cancellation race** (Scenario16: the worker unregisters before the Stop counts active actions): reproduced 3/3 on a clean checkout of R.7 (`6ef576f`) in a temporary worktree, also 3/3 with the H3-8 validation neutralised. It is pre-existing, unfixed and a separate unresolved issue. The suspected mechanism is not proven.
- **Live production integration of the normal Rust host remains pending.** The Rust host and live harness were not re-run for R.9a.
- **Production executable installation permissions and identity remain unresolved** (see the R.8 residuals in section 6).
- **H3-9 remains open and untouched** (approval decisions not bound to the originating session). Not authorized. (Historical R.9a statement; H3-9 was implemented afterwards in R.9b, section 10.)
- `scratch/Benchmark` uses approval APIs and was not updated.
- Making the engine a required constructor argument would remove the null-engine branches entirely; not done (wider refactor).

## 10. Phase 4B-1R.9b: H3-9 approval session binding (added later)

Sections 1-9 are the historical R.8 and R.9a record; their results are not rewritten. Everything below is the later R.9b work, and its test counts are not comparable with the earlier ones (the suite grew again). Objective: **an approval decision is accepted only from the authenticated IPC session that owns the corresponding approval request.**

### 10.1 What changed

`src/DAsk.Daemon/Automation/Policy/ActionPolicyEngine.cs`
- `SubmitApprovalDecision(response, string callerSessionId, isEmergencyStoppedFunc = null, getCurrentGenerationFunc = null)`: `callerSessionId` is required, second, with no default. Null, empty or whitespace is refused without touching any entry.
- Ownership is checked before the pending entry is touched: the pending approval is looked up, and the decision is refused if the stored owner is empty/whitespace or differs (ordinal) from the caller. A refused attempt returns `false`, leaves the owner's request pending and does not complete it, so a foreign session can neither approve nor cancel (deny) it.
- The entry is then removed with the exact-entry compare-and-remove `_pendingApprovals.TryRemove(new KeyValuePair<string, CachedApproval>(id, cached))`, so only the entry whose owner was checked is removed. If it was finalized or replaced meanwhile, nothing is removed and the decision is ignored. The previous key-only `TryRemove(id, out ...)` ahead of any validation is gone. The existing expiry, Stop, generation and parameter-hash checks run unchanged afterwards. A null/empty `ApprovalId` is now refused instead of throwing.
- `RequestApprovalAsync` refuses an empty/whitespace `SessionId` before registering anything (a denied response, `DecisionSource = IntegrityMismatch`, nothing pending).
- `ValidateConsumedApproval` step 6 fails closed: an empty/whitespace granted owner or caller session is refused instead of skipping the check. Replay protection, the single-consumption `TryRemove` and the other checks are unchanged.
- New private `AuditOwnershipViolation`: writes a `SafetyAuditRecord` with `EventType = "ApprovalOwnershipViolation"` (existing schema, no new fields). It records approval id, action id, risk level, generation, the offender's session id, and in `DetailsJson` the owner session, caller session and whether the attempt was an approve. It does not record action parameters. It runs after the refusal is already decided, inside try/catch, and observes a faulted task, so an audit failure cannot change the outcome.

`src/DAsk.Daemon/IPC/IpcClientSession.cs`: the `ActionApprovalResponse` case passes this connection's server-generated `_sessionId` as the caller. The payload's own `sessionId` is never used. The old RESIDUAL comment is replaced by an accurate description.

Not changed: IPC message definitions, the Rust host, pipe transport/security, Stop/generation implementation, desktop actuation, `scratch/Benchmark`.

### 10.2 Session identity and trust boundary

- The caller identity is `IpcClientSession._sessionId`: a `readonly` `Guid.NewGuid().ToString("N")` generated by the server for each connection. A client cannot supply or change it, and each reconnect is a new connection and therefore a new identity (the handshake returns it as `sessionToken`).
- The identity is only meaningful after peer verification and handshake (R.8); the dispatch is gated behind them.
- `ActionApprovalResponse.SessionId` exists on the wire but is attacker-controlled and ignored. The Rust host still sends `session_id: None` and `stop_generation: 0`, and still works because neither is used.
- **The approval owner must also be trusted.** `ActionApprovalRequest.SessionId` is set by whoever creates the request. Today `RequestApprovalAsync` has no production caller (only tests and `scratch/Benchmark`), and the daemon never sends `ActionApprovalRequest`, so no production path exists yet. The first real caller must set the owner from the server-side session object, never from a client-supplied value; the engine now refuses an empty owner but cannot know whether a non-empty one is trustworthy.

### 10.3 Atomic-removal API and equality verification (done before implementing)

- Target framework is `net8.0` (`DAsk.Daemon.csproj`, `LangVersion latest`).
- `ConcurrentDictionary<TKey,TValue>.TryRemove(KeyValuePair<TKey,TValue>)` exists on .NET 5 and later, so it is available. It removes the entry only if the key's current value equals the pair's value, atomically with respect to other operations on that key, and compares values with `EqualityComparer<TValue>.Default`.
- `CachedApproval` is a plain `class` (not a record or struct) with no `Equals`/`GetHashCode` override and no `IEquatable<>`, so the default comparer is reference identity. An equivalent replacement entry is therefore a different object and is not removed.
- Pinned by tests: `H39_CachedApproval_UsesReferenceEquality_NoValueEqualityOverride` and `H39_ConcurrentDictionary_TryRemoveKeyValuePair_RemovesOnlyTheExactInstance` (an entry replaced by an equivalent one after being checked is not removed by the checked instance). Because behaviour alone cannot tell the exact-entry call from a key-only remove, `H39_Source_DecisionPath_IsOwnershipChecked_ConditionalRemoval_AndSessionComesFromTransport` guards the source.
- Residual detail: the expiry timer and cancellation callbacks inside `RequestApprovalAsync`, and the `Invalidate*` methods, still use key-only `TryRemove`. They were not part of this change and were not examined for key-reuse races.

### 10.4 Tests

All new tests are named `H39_*` (run alone with `--filter "FullyQualifiedName~H39_"`), 35 in total (34 at the first implementation run, plus the two-owner real-pipe test added afterwards, see below).
- `tests/DAsk.Daemon.Tests/ApprovalSessionBindingTests.cs` (new, real `ActionPolicyEngine`): owner approves and rejects; a foreign session cannot approve or reject and the request stays pending and still decidable by the owner; knowing the id, the action id, the hash and even claiming the owner's session in the payload grants nothing; 100 iterations of concurrent owner-reject versus foreign-approve (the foreign decision never wins); empty/whitespace owner refused at registration; null/empty/whitespace caller refused at decision with the entry intact; same-session consumption and replay rejection; cross-session consumption rejected without burning the grant; empty granted-owner or caller refused at consumption (including a null caller; the empty-owner records are injected by reflection because registration can no longer create them); expiry, cancellation, disconnect (only that session's approvals), Stop (every session's approvals) and Stop-active decisions; reconnection inherits nothing; audit event recorded with identifiers only; audit failure (synchronous throw, faulted task) cannot turn a refusal into acceptance; equality and compare-and-remove pins; a structural check that `callerSessionId` is required with no default.
- `tests/DAsk.Daemon.Tests/ApprovalSessionBindingWireTests.cs` (new; partial class `PipeSecurityBehaviorTests`, real pipe, real `NamedPipeServer`, real engine and policy engine): two authenticated sessions, where B (claiming A's session in the payload) is ignored and A (claiming B's) is accepted; a reconnect gets a new identity and inherits nothing; a source guard (conditional removal, ownership check before removal, `_sessionId` passed from the session, the payload session never used, exactly one production caller of `SubmitApprovalDecision`).
- **Final verification test (added after review, test-only, no production change):** `H39_Wire_TwoOwners_EachCrossAttemptRefused_BothPendingStayIntact_ThenEachOwnerDecidesOwn` in the same wire test file. Two independently authenticated sessions A and B on the real pipe, with each approval owned by that connection's server-issued `sessionToken` (the two ids are asserted to differ). One pending approval is registered for each, and the test asserts pending = 2 and granted = 0. (1) A sends an approve for B's approval id with a payload claiming B's session: after 400 ms neither task is complete, pending is still 2, granted still 0. (2) B sends an approve for A's approval id with a payload claiming A's session: again neither task is complete, pending 2, granted 0. So **both directions of cross-session rejection are covered**, each with a payload that claims the owner's session, which therefore cannot influence the outcome. (3) A then decides its own approval (payload deliberately naming B): the task completes as approved within 4 s, B's task is still incomplete, pending = 1, granted = 1. (4) B decides its own approval (payload naming A): completes as approved, pending = 0, granted = 2. This resolves a coverage gap noted during review: previously only B-attempts-A's-approval was exercised at wire level, and A-attempts-B's was not tested at wire or engine level (the code path is symmetric, but that had not been demonstrated).
- Existing tests updated to pass explicit owners (no empty/default identities added): 13 existing `SubmitApprovalDecision` call sites, namely 8 in `SafetyRemediationTests.cs`, 3 in `SafetyInfrastructureTests.cs` and 2 in `ExecutionEngineCorrectnessTests.cs`, each using the owner of its own request. Four `SafetyInfrastructureTests` scenarios (4, 6, 8, 11) registered requests with no owner and now declare `session_1`.

### 10.5 Evidence

Failing-first (against the unchanged production code): the H39 tests reached the old engine through a temporary reflection adapter in the test helper so that they could compile, and production source was not altered. **17 of the 30 then-existing H39 tests failed** for the intended reasons (foreign approve and reject accepted, knowing the id sufficient, a foreign decision able to win the race, empty owner registered, empty/null caller accepted, empty/null identities skipping the consumption check, a reconnect identity able to decide, the caller parameter absent, and the wire test with the foreign session able to decide). The other 13 passed as preservation guards (owner decisions, expiry, cancellation, disconnect, Stop, same-session consumption, replay, cross-session consumption with both ids set, the API pins). The adapter was then replaced by a direct call. The source guard and the three audit tests were added after the implementation and were not run against the old code. The two-owner real-pipe test (section 10.4) was added later still; it was not run against the old code and was not mutation-tested (mutation M1 below should fail it, but that was not run).

Mutation checks (each applied to production, built, run against `H39_`, then restored; the restored files were verified byte-identical by hash):

| Mutation | Result |
|---|---|
| M1 ownership comparison removed | caught: 7 failures |
| M2 key-only removal instead of exact-entry removal | caught by 1 test only: the source guard (behaviour is identical without a concurrent replacement, which the engine API does not let a test produce) |
| M3 empty owner accepted at registration | caught: 2 failures |
| M4 empty caller accepted at decision | **survived** (0 failures). It is an equivalent mutant: with a non-empty owner the ownership comparison already refuses an empty or whitespace caller, and an empty owner is refused too. The explicit check stays as defense in depth with a clearer log line |
| M5 consumption skips the session check on empty identity | caught: 1 failure |
| M6 payload `SessionId` used as the caller instead of `_sessionId` | caught: 2 failures |

The mutation run preceded the three audit tests, and the audit try/catch was not mutation-tested.

### 10.6 Build and test results (`--no-build -f net8.0`)

Two runs are recorded, and they must not be conflated. The **final verification run** came after the two-owner test was added (test-only change, production code unchanged since the earlier run). The **earlier run** is the last full-suite run, made before that test existed.

Final verification run (after the two-owner test was added; test project rebuilt, 0 errors; the daemon was unchanged):

| Run | Result |
|---|---|
| H3-9 (`FullyQualifiedName~H39_`) | **35 passed, 0 failed** |
| New two-owner test alone | 1 passed, 0 failed (reported as 842 ms with the verbose logger) |
| Focused (approval binding, pipe security, peer verifier, engine correctness, IPC live, IPC protocol, safety infrastructure, safety remediation, resume-generation engine) | **167 passed, 0 failed** |
| Full .NET suite | **Not re-run after this final test-only addition.** |

Earlier run (before the two-owner test; daemon rebuilt with `--no-incremental`, then the tests):

| Run | Result |
|---|---|
| Daemon build / test-project build | 0 errors / 0 errors |
| H3-9 (`FullyQualifiedName~H39_`) | 34 passed, 0 failed (superseded by 35 above) |
| H3-8 (`FullyQualifiedName~H38_`), regression | **15 passed, 0 failed** (unchanged from R.9a; not re-run in the final verification run) |
| Focused, same filter | 166 passed, 0 failed (superseded by 167 above) |
| Full .NET suite | **202 passed, 0 failed**, the **earlier** full-suite result, retained as such. It does not include the two-owner test. |

The two timing-sensitive tests that failed in an earlier R.9a full run (`RepeatedScreenCapture_Benchmark_And_ResourceStability_Test`, `Scenario16_Queue_Cancellation_Latency_Benchmark_N30`) passed in the 202/202 full run. That is one passing run and does not show them fixed; thresholds were not changed.

### 10.7 Files changed in R.9b (all uncommitted)

Source: `src/DAsk.Daemon/Automation/Policy/ActionPolicyEngine.cs`, `src/DAsk.Daemon/IPC/IpcClientSession.cs`.
Tests: new `ApprovalSessionBindingTests.cs`, new `ApprovalSessionBindingWireTests.cs`; modified `SafetyRemediationTests.cs`, `SafetyInfrastructureTests.cs`, `ExecutionEngineCorrectnessTests.cs`.
Docs: this report (new section 10, plus one-line cross-references in sections 6 and 9.5).
No Rust, protocol, Stop/generation, desktop-actuation or scratch changes.

### 10.8 Remaining limitations and production integration gaps

- **No production caller of `RequestApprovalAsync` exists yet,** and the daemon does not send `ActionApprovalRequest`. The end-to-end flow (daemon requests, Rust host shows UI, user decides, daemon grants) is not exercised in production. The wire tests create the request by calling the policy engine directly. The trustworthiness of the owner id depends on that future caller (section 10.2).
- **The live Rust host was not re-run** against the new daemon for R.9b. It sends `session_id: None`, which is ignored.
- **Unauthenticated sessions** never reach the policy engine (R.8 gate); this was not re-tested beyond the existing R.8 tests.
- **Other key-only removals** in the timer/cancellation callbacks and the `Invalidate*` methods are unchanged and were not analyzed (section 10.3).
- **A pre-existing sibling path:** the audit calls for granted/denied decisions (`_ = _evidenceRecorder.RecordSafetyAuditAsync(...)` in `SubmitApprovalDecision`) are outside any try/catch, unlike the new one. Not changed.
- **`scratch/Benchmark`** still uses the old approval signatures and was not updated (it was already not building).
- **M4 is an equivalent mutant** and the audit try/catch is not mutation-tested (section 10.5).
- Timing-sensitive benchmark tests may fail intermittently, and the queue-cancellation race reproduced on clean R.7 remains a separate unresolved issue (section 9.5). Production executable installation permissions and identity remain unresolved (section 6). H2, M1/M2 and Phase 4B-2 are untouched.
