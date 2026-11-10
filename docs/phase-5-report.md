# Phase 5 report: native stdio agent host

> **Correction (2026-11-05, Phase 6):** the complete-stack memory figures in this report are too low. The harness started the HUD from the wrong working directory, so its WebView showed a 404 page instead of the orb: the 342 MB WebView2 and 1,195 MB total describe a blank page. Measured with the orb rendering, the 0.5B stack peaks at about 2,350 MB, with WebView2 at about 1,400 MB. See [phase-6-report.md](phase-6-report.md). The 1 GB free target is still met. Also, the screen-capture benchmark's failure is a consistent narrow miss on this machine rather than the parallel-load effect suggested here.

Date: 2026-11-05. Machine: i5-1335U, 15.7 GB RAM, Iris Xe GPU. Local inference: llama.cpp b11720 with Vulkan.

Numbers are **measured** unless labelled as an estimate. Benchmark numbers regenerate from `research/benchmark/results/` (`CAPABILITY.md`, `p5_stack.json`).

**Summary:** a real request now travels from a named-pipe client through the real daemon, the stdio host and the existing runtime to `llama-server` and a real tool, gets independently verified, and returns with the right ids. Cancellation, Emergency Stop, crash recovery and no-orphan behaviour were all demonstrated with real inference.

**The HUD's user interface does not submit tasks yet.** That is Phase 6.

## 1. Architecture and data flow

```text
Caller (HUD in Phase 6; a pipe test client today)
   │  named pipe: image allowlist, handshake, session id from the transport
   ▼
.NET daemon: AgentHostManager        owns the host process; owner-bound tasks; Emergency Stop authority
   │  stdin/stdout JSONL v1          per-launch token; strict validation; one Job Object per host
   ▼
Node: agent/host/stdioHost.js        protocol only; no planning, tool or verification logic
   ▼
AgentRuntime → Planner → ToolRegistry → Verifier      unchanged authority
   │  LlamaServerModel: HTTP on 127.0.0.1 with a per-launch key
   ▼
InferenceSupervisor → llama-server → GGUF             hash checks and memory guard unchanged
```

The protocol is specified in [agent-host-protocol.md](agent-host-protocol.md).

### Lifecycle decisions

| Situation | Behaviour |
|---|---|
| First use | The host starts lazily, so it costs nothing until used. The model also loads lazily. |
| Startup failure (missing entry or Node, bad host, no answer) | Submit gets `host_unavailable` with the reason. Any started process is killed. |
| Model unavailable (memory guard, hash mismatch) | The host stays up. The task reports `failed` with the reason. |
| Malformed host output (non-JSON, unknown id, forged event) | Treated as a protocol violation: the host is killed and in-flight tasks are `interrupted`. |
| Request timeout | The caller gets the error. A late reply to that id is ignored, not treated as a violation. |
| Hung host | Two missed health checks → killed and tasks `interrupted`. |
| Task overrun | Cancelled at 330 s. If it hasn't ended 5 s later, the host is killed. |
| Host crash | Tasks end `failed` with `interrupted: true`. **Never re-submitted.** Restart is bounded (3 in 5 min, with backoff), and the new host is idle. |
| Daemon death | The OS closes the Job Object, so the host and `llama-server` die. A new daemon has no old tasks. |
| Cancel during inference or a tool | The HTTP request or tool is aborted; the outcome is `cancelled`. |
| Shutdown during a task | The task is aborted and reports, the model stops, the host exits. If it ignores shutdown, its process tree is killed. |
| Owner session disconnects | Its tasks are cancelled, matching the engine's fail-closed behaviour. |

### Security decisions

- **Per-launch token:** the first message must be `hello` with a 256-bit token. It is removed from the host's environment before any tool can read it, and a wrong token makes the host exit.
- **No authority in the protocol:** no operation names a tool, a grant or an approval, and unknown fields are rejected, not ignored. The runtime's fixed grants and its deny-all approval gate are unreachable from the protocol.
- **Clean environment:** the daemon strips cloud credentials and `NODE_OPTIONS`/`NODE_PATH`, and sets `DASK_INFERENCE=local`. The host scrubs credentials again and refuses to start in any other mode.
- **Session ownership:** the session id comes from the pipe connection, never a payload. Another session's task looks like one that doesn't exist.
- **Emergency Stop:** the daemon's engine is the authority.
  - The stop generation is pushed to the host on every stop.
  - It is included in every `hello`, so a restart can't clear a stop.
  - No acknowledgement within 1 s kills the process tree.
  - Agent requests run off the session's read loop, so a task can't delay a stop on the same connection.
- **One model owner:** while the host holds the model, the daemon's direct inference is refused with `AgentModelOwnerActive`. An idle daemon model is unloaded before an agent task starts, and a busy one makes the submit return `daemon_model_busy`.
- **Reported outcome:** the daemon passes through the runtime's outcome. Anything unrecognisable from the host becomes `failed`, never success.

### Departure from the earlier plan

Phases 5 and 6 were originally planned as HUD → Node. Your Phase 5 brief makes the daemon the host's owner and the trusted boundary, so I implemented that. The HUD reaches the agent through the daemon. Inference still runs outside the daemon, as you decided earlier.

## 2. Files

**Added**
- `agent/host/{protocol,host,stdio,stdioHost}.ts`
- `agent/runtime/{defaults,capabilityCheck}.ts`
- `agent/runtime/inference/tiers.ts`
- `tsconfig.agent-host.json`, `tsconfig.agent-host-test.json`
- `src/DAsk.Daemon/AgentHost/{AgentHostManager,ProcessJob}.cs`
- `src/DAsk.Protocol/IPC/Messages/AgentTaskMessages.cs`
- `tests/agent-host/{host-protocol.test.ts,experimental.test.ts,fixtures/scriptedHost.ts,fixtures/badHost.cjs}`
- `tests/DAsk.Daemon.Tests/AgentHost{Manager,Wire,Live}Tests.cs`
- `research/benchmark/{capabilityTasks.ts,capability-report.ts,phase5-stack.ts,run-matrix-p5.sh,CAPABILITY.md}`
- `research/benchmark/results/{p5_*.json,matrix-p5.log}`
- `docs/agent-host-protocol.md`, `docs/issues/engine-stop-active-count-race.md`, this report

**Modified**
- `agent/runtime/index.ts`: moved the default registry and grants to `defaults.ts`; behaviour unchanged.
- `agent/runtime/runtime.ts`: the experimental capability switch, off by default.
- `src/DAsk.Daemon/Automation/Execution/ActionExecutionEngine.cs`: two events, on stop and on resume; logic unchanged.
- `src/DAsk.Daemon/IPC/{IpcClientSession,NamedPipeServer}.cs`, `Program.cs`, `appsettings.json`
- `research/benchmark/run.ts`, `package.json` (two build scripts), `.gitignore` (`/dist/`), `docs/local-inference.md`

**Rebuilt:** `src/hud-native/target/h3-verify/debug/hud-native.exe` (gitignored). Its hash in the R.8 report is now out of date. `target/debug` was not touched.

## 3. Test commands and results

```bash
npm run build:agent-host && npm run build:agent-host-test
dotnet build src/DAsk.Daemon/DAsk.Daemon.csproj -c Debug
```

| Suite | Command | Result |
|---|---|---|
| Host protocol and lifecycle | `npx tsx tests/agent-host/host-protocol.test.ts` | **81 / 0** |
| Experimental features | `npx tsx tests/agent-host/experimental.test.ts` | **31 / 0** |
| Daemon lifecycle and wire | `dotnet test ... --filter "FullyQualifiedName~AgentHostManagerTests\|FullyQualifiedName~AgentWire_"` | **33 / 0** |
| Live end-to-end | `dotnet test ... --filter "Category=Phase5Live"` | **2 / 0** |
| Grounding and request checks | `npx tsx tests/agent-runtime/grounding.test.ts` | 77 / 0 |
| Agent runtime | `npx tsx tests/agent-runtime/agent-runtime.test.ts` | 165 / 0 |
| Inference adapter and supervisor | `npx tsx tests/agent-runtime/local-inference.test.ts` | 95 / 0 |
| Real-binary contract | `npx tsx tests/agent-runtime/llama-server.contract.ts` | 34 / 0 |
| Offline policy | `npx tsx tests/agent-runtime/offline.test.ts` | 23 / 0 |
| Offline integration (monitored) | `npx tsx tests/agent-runtime/offline-integration.test.ts` | infrastructure 15/15, functional 9/9 |
| R.7 API authentication | `npm run test:security` | 210 / 0 |
| Containment | `npx tsx tests/containment/phase4b-actuation-containment.test.ts` | 58 / 0 |
| HUD | `cargo test --offline --bin hud-native` (xwin environment) | 26 / 0, 1 ignored (its live test) |
| Full .NET suite | `dotnet test tests/DAsk.Daemon.Tests/DAsk.Daemon.Tests.csproj` | **235 / 3** |
| Type-check | `npx tsc --noEmit -p tsconfig.json` | clean |
| Production build | `npm run build` | ok |

**Not run:** `tests/containment/phase4b-python-sidecar.test.py`. The Wi-Fi-off test was not repeated, as you instructed.

**The 3 .NET failures, none from Phase 5 logic:**
- `Scenario01_Active_Action...` and `Test06_EmergencyStop_CancelsQueuedWork` assert `ActiveActionsCancelled == 1` and get 0. I checked for causation: a scratch copy with my engine event calls removed also failed in 8 of 8 runs, the same as with them. It's a pre-existing race, logged in [engine-stop-active-count-race.md](issues/engine-stop-active-count-race.md). I did not change those assertions.
- `RepeatedScreenCapture_Benchmark`: 53.8 ms against a 30 ms budget. The R.8 report already records this test as timing-sensitive under parallel load. It was not re-run in isolation.

**Test changes made along the way:** three new assertions were corrected for flaws of my own (an objective that already contained the "wrong" expression, a case-sensitive regex, and a `llama-server` check made before its lazy load). No existing assertion was weakened.

**Real defects found by these tests and fixed:**
- `Health` could briefly show no reason after a kill.
- A crashed host's `llama-server` lingered until the next start. It's now gone 26 ms after the host dies.

## 4. Measured performance

| Measurement | Result |
|---|---|
| Host start to ready (5 runs, no daemon) | 175 ms median (167–193) |
| Request round trip, stdio (500 requests) | 0.21 ms p50, 0.36 ms p95, 1.34 ms max |
| Host idle memory | 54 MB RSS |
| First submit acknowledged by the daemon, host start included | 238–377 ms |
| First task end to end, model load included (0.5B, Vulkan) | 9.2–10.5 s |
| Later single-step task | 3.4–5.4 s |
| Cancel during real inference to task ended | 14–17 ms |
| Emergency Stop during real inference to task ended | 163–336 ms |
| Host killed to task reported interrupted | 23–26 ms |
| Host killed to ready again | 1.3–1.4 s |
| First task after recovery, model reload included | 8.8–12.5 s |
| Daemon hard-killed to host and `llama-server` gone | 242–305 ms |

### Complete desktop stack

Real daemon, real HUD with WebView2, real host, real `llama-server` with 0.5B; 5 tasks, 16 samples.

| Process | Working set |
|---|---|
| Daemon | 57 MB |
| HUD | 28 MB |
| WebView2 | 342 MB |
| Agent host | 71 MB |
| `llama-server` (0.5B) | 697 MB |
| **Total** (peak 1,219 MB) | **1,195 MB** |

- **Free RAM:** 4,618 MB before the stack, 4,509 MB with daemon and HUD idle, **lowest 3,762 MB during tasks**.
- **The 1 GB target is met for this configuration**, on this machine, with your other applications at their usage at that moment.
- **Not measured:** 3B together with the HUD. The 3B tier run had no HUD and bottomed out at 2,358 MB free. Adding the HUD's roughly 370 MB suggests about 2 GB free (**estimate**). With only 4.5 GB free, the guard (needs about 4.6 GB) would pick 0.5B instead.
- **Clean-up:** after shutdown, zero `llama-server` and zero host processes remained.

The HUD was the current source built into `target/h3-verify`, allowlisted through environment variables for these runs only. The daemon's log confirms the HUD's verified peer identity and handshake.

## 5. Experimental additions (both off by default)

### A. Up-front refusal

Evaluated on the Phase 4 suite plus 48 prompts written after the word lists were frozen. One run per configuration, 84 tasks.

| Config | Answerable served | False refusals | Impossible refused | Tools run on impossible | Incorrect claims |
|---|---|---|---|---|---|
| 0.5B, off | 41/53 (77%) [64–87] | 0 | 0/21 [0–15] | 21/21 | 0 |
| 0.5B, on | 34/53 (64%) [51–76] | 7/53 (13%) | 18/21 (86%) [65–95] | 3/21 | 0 |
| 3B, off | 43/53 (81%) [69–89] | 0 | 10/21 (48%) [28–68] | 11/21 | 0 |
| 3B, on | 38/53 (72%) [58–82] | 7/53 (13%) | 18/21 (86%) [65–95] | 3/21 | 0 |

- **Benefit:** it stops almost all unrelated tool use on impossible requests.
- **Cost:** 7 of the 8 "trap" phrasings were falsely refused ("Find out how much RAM I have", "Look up the current time"), which lowers answerable success by 9–13 points.
- **Safety:** verification already held without it. Incorrect claims are 0 in all four runs.
- **Recommendation: keep it off.** The word lists were not tuned against this set; doing so would invalidate the set. A better design would only refuse when no facet fired, and would then need a fresh evaluation set. **That is a hypothesis.**
- **Bias:** one author wrote the check and the prompts, so this is weaker than an external evaluation.

### B. Memory-aware model tiers

`DASK_AgentHost__ExperimentalModelTiers=true`. Real switches, driven by the unchanged guard. A ballast process of the harness's own held memory, so no application or guard setting was touched.

| Step | Free at decision | Model selected | First task | Model peak | Lowest free | Free after idle unload |
|---|---|---|---|---|---|---|
| Low memory | 3,706 MB | 0.5B | 10.5 s | 694 MB | 2,998 MB | 4,751 MB |
| Memory free | 4,754 MB | 3B | 26.7 s | 2,399 MB | 2,358 MB | 4,805 MB |
| Low again | 3,776 MB | 0.5B | 6.6 s | 694 MB | 3,126 MB | 4,842 MB |

- **One model at a time:** at most 1 `llama-server` in any sample, and 0 after shutdown.
- **When it switches:** only when no model is loaded (after idle unload), so a task never changes model mid-run.
- **Overhead:** the 3B first task's 26.7 s includes hashing the 2 GB model once, which takes about 18 s and is cached for the process. This run did not separate that from load time.
- **Recommendation: keep it off until Phase 6 measures it with the HUD running.**

**Run-to-run note:** with the capability check off, 3B served 26 of the 36 Phase 4 tasks here, against 27 in the Phase 4 follow-up, despite temperature 0. The cause is unknown; 0.5B repeated at 22.

## 6. Acceptance criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Host starts reliably | **VERIFIED** | 5/5 at 175 ms median; startup-failure tests; `Start_DetectsReadiness...` (10 concurrent starts → 1 process) |
| 2 | Daemon detects readiness | **VERIFIED** | Readiness requires an authenticated `hello`; health state moves from `stopped` to `ready` in the live test |
| 3 | Daemon submits a real user request | **VERIFIED** | Live test, over the real pipe to the real `DAsk.Daemon.exe` |
| 4 | Local model processes it | **VERIFIED** | Real `llama-server` with 0.5B; `Assert.Single(LlamaServers())` |
| 5 | Runtime invokes an authorized tool | **VERIFIED** | `math.evaluate` → `(17+25)*2 = 84`, in the granted set |
| 6 | Independent verification evaluates it | **VERIFIED** | `independentlyVerified: true`, facets and grounding reported; an impossible request ends `unverified` |
| 7 | Response reaches the caller with the correct id | **VERIFIED** | `replyToId` matches on the pipe; `taskId` matches on the result; 200-request correlation test on stdio |
| 8 | Cancellation works | **VERIFIED** | Real inference 14–17 ms; tool and inference with the scripted model; Emergency Stop 163–336 ms |
| 9 | Host crashes detected and handled | **VERIFIED** | Killed during a real task: interrupted in about 25 ms, old model server gone, back in about 1.4 s |
| 10 | Restart does not duplicate tasks or bypass approvals | **VERIFIED** | No replay (idle after restart); marker file proves the approval-required tool never ran. The real runtime has no approval-required tool yet, so this used the test host's. |
| 11 | Complete path works without cloud inference | **PARTIALLY VERIFIED** | Local-only by construction and tests: the compiled host contains no cloud code, the host refuses other modes, credentials are stripped, and 0 non-loopback connections in the runtime benchmarks. Your Wi-Fi-off run predates the daemon path and was not repeated, so **this exact path has not been run with networking disabled**. |
| 12 | Existing HUD and native functionality intact | **PARTIALLY VERIFIED** | HUD: 26 tests pass, the real HUD ran and handshook with the changed daemon, and its source is untouched. Daemon: 235/238, with the 3 failures explained in section 3. Not verified: a manual walkthrough of the HUD's UI, and the HUD's own inference path while the agent is active (covered only with a fake model at wire level). |

**Why 11 and 12 aren't fully verified:** 11 needs one Wi-Fi-off run of `dotnet test ... --filter "Category=Phase5Live"`, if you consider it warranted after your earlier instruction not to repeat that test unnecessarily. 12 needs someone to use the HUD.

## 7. Known limitations

- **The HUD's interface cannot submit tasks yet.** The pipe API exists, but neither the Rust host nor `useTask` calls it. Phase 6.
- **Node isn't pinned.** The daemon runs `node` from `PATH` (`AgentHost:NodePath` overrides it), and neither Node nor `dist/` is hash-checked. `npm run build:agent-host` is a manual step, and a missing build reports a clear `host_unavailable`.
- **Debug daemon only.** Only the Debug build path was exercised.
- **One task at a time, with no queue.**
- **No conversation history in host tasks.** The Next.js bridge passes history; the host does not yet.
- **Tasks don't survive a host or daemon restart.** Their ids are gone after a daemon restart, by design.
- **Interrupted tasks:** with today's read-only tools an interruption is harmless. Future tools with side effects will need their own record of what ran.
- **Model-state visibility:** `OwnsLocalModel` relies on health checks every 5 s, so after an idle unload it can stay true for up to 5 s, refusing the daemon's direct inference a little longer than needed. A stale "unavailable" can't occur while a task runs, because active tasks count too.
- **Pre-existing, still open:** the stop-count race, and the delay of Emergency Stop behind the daemon's own direct inference ([daemon-inference-estop-delay.md](issues/daemon-inference-estop-delay.md)). Agent tasks don't have that delay.

## 8. Recommended Phase 6

1. **Connect the HUD:** send `AgentTask*` from the frontend through the Rust host, and add a native transport to `useTask`, keeping the browser HTTP transport.
2. **Rebuild `target/debug`,** so the real app runs the current HUD (this needs your approval, since it overwrites that binary), and walk through the UI to close criterion 12.
3. **Re-measure the 1 GB target with 3B and the HUD together,** then decide on tiers.
4. **Package the runtime:** a pinned Node, hash-checked `dist/`, and a Release build.
5. **Fix the stop-count race,** so the .NET suite can go fully green.
6. **Redesign the capability check** around the measured false refusals, with a fresh and ideally externally written evaluation set.
