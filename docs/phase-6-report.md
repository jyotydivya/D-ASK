# Phase 6: HUD-to-agent integration

**Date:** 2026-11-05. **Machine:** i5-1335U, 15.7 GB RAM, Iris Xe. **Branch:** `baseline/phase-4b-1`. Nothing was staged or committed.

## Summary

A task typed into the real holographic HUD now runs the whole path and shows the real result:

`HUD frontend → Rust host → daemon named pipe → stdio agent host → AgentRuntime → llama-server → tool → independent verification → back to the HUD`

Typing `What is (17+25)*2?` shows `RESULT — COMPLETED`, `INDEPENDENTLY VERIFIED`, `(17+25)*2 = 84`. See `results/phase6/walkthrough-release-relocated/01-completed.png`.

**Status of the nine priorities:** priorities 1–5 and 7–9 are done, each with the limits noted below. For priority 6, both models are measured and tiers stay off.

**Criterion 11 is now VERIFIED.** The one Wi-Fi-off run of the Phase 5 live test passed on 2026-11-06; see "Wi-Fi-off verification" below.

**Still open:**
- **Manual walkthrough:** I drove the real HUD with real OS mouse and keyboard input, but no person has used it.
- **One failing test:** the screen-capture timing benchmark.

## Bugs that only the real UI found

Unit tests passed through all of these. All were there before Phase 6.

| Bug | Effect | Fix | Evidence |
|---|---|---|---|
| **The STOP/RESUME button could not be clicked** | `.hud-header` has `pointer-events: none`, so mouse clicks passed through. The button has been dead since at least the committed baseline. Only the hotkey worked. | `pointerEvents: "auto"` on the button | Before: the click never reached the HUD and the task ran to completion. After: the click stops the task, in all three final walkthroughs. |
| **Pipe deadlock on the first Emergency Stop** | The HUD stopped reading while writing, and the daemon's pipe has zero buffers. A stop landing just before the 5 s heartbeat blocked both sides until a 500 ms timeout dropped the session, losing the real result and showing "Lost the connection". | Frames are read on their own task | Live, against the real daemon: **pre-fix 2 of 12 dropped, fixed 0 of 24** (`scripts/hud/first-stop-race.ps1`). |
| **A refused resume looked like success** | The HUD cleared its stopped display on any resume response. | It now checks `success` | Source check. A refused resume was not exercised live. |
| **Canned reply** | The HUD answered everything with a stub "D-ASK ONLINE". | Removed; requests go to the agent | Walkthrough |
| **Requests in the HUD log** | Raw bridge messages, including typed text and the session token, were logged. | Sizes only | Walkthrough log scan: 0 hits |

### Correction to the Phase 5 report

Phase 5 reported the complete stack at **1,195 MB with WebView2 at 342 MB. That was wrong.** That harness started the HUD from the wrong working directory, so the WebView showed a 404 page instead of the orb. The real figures are below: about **2,350 MB** for 0.5B, with WebView2 at about 1,400 MB. The 1 GB free target is still met. A correction note is in [phase-5-report.md](phase-5-report.md).

## What was built

- **Rust bridge:** [agent_bridge.rs](../src/hud-native/src/ipc/agent_bridge.rs).
  - The frontend can send only an objective or a task id; any extra field is rejected.
  - Requests are refused locally during Emergency Stop or when disconnected, so nothing is queued for later.
  - A request left over from an earlier session fails instead of starting a task on the new one.
- **Frontend transport:** [nativeAgent.ts](../hooks/nativeAgent.ts) handles correlation, ordering, progress that overtakes the reply, late acceptance, and connection loss. [useTask.ts](../hooks/useTask.ts) picks the native path only when the Rust bridge exists.
- **Browser HTTP transport:** preserved. The event reducer is now shared between the two paths.
- **Panel:** shows the outcome, verification and interruption as the daemon reports them. An unreadable result counts as failed, never as success.
- **Package check:** [PackageVerifier.cs](../src/DAsk.Daemon/AgentHost/PackageVerifier.cs) runs before every host start.
- **Package builder:** [build-package.mjs](../scripts/package/build-package.mjs).
- **Stop count fix:** the Emergency Stop count race, see below.

**Security boundaries:**
- The daemon still owns the host.
- Tasks stay bound to the session that started them, and that identity comes from the pipe.
- The HUD has no way to name a tool, grant or approval.
- Peer checks are unchanged, with no allowlist overrides in the main walkthroughs, the memory runs or the package.
- `DASK_INFERENCE=local` is forced by the daemon.
- Memory guards are untouched.
- Up-front refusal and model tiers are off by default.

## HUD interaction evidence

Driven by [walkthrough.ps1](../scripts/hud/walkthrough.ps1) on the real window with real inference. Controls are located through UI Automation, then clicked and typed with `SendInput`. The page is never scripted, and input is only sent while the HUD is the foreground window.

| Run | Result |
|---|---|
| Debug build, final code (`results/phase6/walkthrough-debug-final`) | **22 of 22** |
| Release package, copied outside the repo, no system Node on `PATH` (`results/phase6/walkthrough-release-relocated`) | **22 of 22** |

Earlier runs are kept as evidence: the first attempt found the dead STOP button, and the second found the pipe deadlock.

### Task lifecycle results (Release package)

| Scenario | Result | Time |
|---|---|---|
| First task, including model load | `COMPLETED`, verified | 25.8 s in this run (13–15 s in later runs) |
| Next task, model loaded | `COMPLETED`, verified | 6–8 s |
| Impossible request (email) | `UNVERIFIED`, never completed | 6.5 s |
| CANCEL during inference | `CANCELLED` | 0.63 s click to result |
| Second request while busy | Refused; the first still completes | |
| STOP button during inference | `CANCELLED`, latched | 0.63 s click to result |
| Task during Emergency Stop | Refused, with the reason | |
| RESUME, then a task | `COMPLETED` | 6.2 s |
| Ctrl+Shift+F12 during inference | `CANCELLED`, latched | 0.54 s |
| 5 stops aimed at the heartbeat | All `CANCELLED`, 0 reconnects | |
| Host killed mid-task | `FAILED`, `INTERRUPTED — NOT RETRIED` | 0.37 s |
| Next task after that crash | `COMPLETED` on a new host | 13.4 s |
| Daemon killed mid-task | "Lost the connection"; host and model server gone | 0.48 s; tree gone in 0.33 s |
| Task with no daemon | Refused immediately, not queued | 0.44 s |
| Daemon restarted | Reconnects, nothing replayed, exactly 1 task runs | |
| HUD killed mid-task | Daemon cancels the task and stays up | 0.15 s |
| HUD reopened | No task shown as still running; next task `COMPLETED` | |
| Logs scanned | No request text or credentials | |

Click-to-result times include the driver's click delay and its slow polling of the UI, so they are upper bounds. The daemon log shows the host acknowledging a stop in 5–7 ms.

## Full-stack memory (measured, Release package)

Real tasks from the real HUD, foreground window rendering the orb, two runs each.

| | 0.5B (run 1 / 2) | 3B (run 1 / 2) |
|---|---|---|
| Free RAM before starting | 6,623 / 6,589 MB | 6,534 / 6,657 MB |
| Stack idle, no model | 1,474 / 1,467 MB | 1,469 / 1,485 MB |
| **Peak stack total** | **2,349 / 2,368 MB** | **4,066 / 4,088 MB** |
| `llama-server` peak | 700 / 715 MB | 2,399 / 2,399 MB |
| **Lowest free RAM** | **4,386 / 4,394 MB** | **2,753 / 2,736 MB** |
| `llama-server` GPU shared memory (peak) | 581 MB | 2,280 MB |
| Largest `llama-server` count | 1 | 1 |
| First task | 14.5 / 15.3 s | 46.0 / 44.7 s |
| Later tasks | 6.9–9.5 s | 25.8–28.3 s |
| Tasks completed and verified | 8 of 8 | 8 of 8 |

**After tasks (0.5B, run 1):** daemon 59, HUD 25, WebView2 1,494, host 70, `llama-server` 697 MB.

**WebView2 breakdown at idle:** GPU process 930, renderer 260, browser 106, others 93 MB. Most of it is the WebGL orb, and it is the largest item in the stack apart from the 3B model. I did not change the orb, as that's a design decision.

Working sets are summed, so shared pages can count more than once. The free-RAM figures are the reliable ones.

**Limits of this measurement:** free RAM before the runs was about 6.6 GB with your usual apps open. These are short runs, not a soak test. The 8-of-8 figures are simple arithmetic and say nothing about general model quality. In one earlier run, free RAM briefly fell to about 2.3 GB because of my own test script, and the guard correctly refused 0.5B and showed why in the HUD.

### Model tiers: keep off

- **It fits today, narrowly:** 3B's lowest free RAM of about 2.74 GB meets the 1 GB target, but it is only about 240 MB above the daemon's 2,500 MB Warning level. Heavier use of other apps would reach it.
- **It is slower:** 3–4× on every task.
- **The gain is small:** in the Phase 5 benchmark, answerable tasks succeeded 81% on 3B against 77% on 0.5B, with 0 incorrect claims on either.

The evidence doesn't support turning it on by default. Automatic switching would also make response time unpredictable.

## Packaging verification

`dist/desktop/D-ASK/` (gitignored), built by `node scripts/package/build-package.mjs`.

| Item | Value |
|---|---|
| Node | v24.18.1, zip SHA-256 `ec56b84a…3765`, from nodejs.org's published `SHASUMS256.txt` |
| Manifest | 26 files (Node + every host file), SHA-256 `62e1d37b…d5be` |
| Daemon | Release, self-contained win-x64 |
| HUD | Release, SHA-256 `c4b67594…52ba` |
| Layout | Mirrors the repo, so both peer checks work unchanged |
| Models | Hard links, so not duplicated. Don't edit them in place in either location. |

**Checks** ([verify-package.ps1](../scripts/package/verify-package.ps1), **11 of 11**, on a copy outside the repo with no system Node):

- `Start-D-ASK.cmd` starts the stack and a task completes with verification.
- The host runs on the packaged `node.exe`, and `llama-server` runs from the package.
- Each of these stops the host, the HUD shows the refusal, the daemon logs the exact cause, and restoring the file recovers without a restart: a changed host file, a changed `node.exe`, an added host file, an edited manifest.

**Limit:** this catches corruption and changes to those files. Someone who can also rewrite the daemon and its settings in the same folder can defeat it. That needs code signing and a protected install location, which are not done. The package has been tested only on this machine.

## Emergency Stop count race

`TriggerEmergencyStopAsync` counted active actions after firing the shared cancel token, so an action could finish first and be missed. It now takes the snapshot under the lock, before cancelling. **The existing assertions are unchanged.**

| | Result |
|---|---|
| Before the fix (the two original tests) | at least one failure in 7 of 8 runs |
| After the fix (those two, plus two new tests) | **20 of 20 runs pass** |
| New regression test against the old engine | Failed, as it should |

**Also found:** the test project references the prebuilt daemon DLL, so tests silently run old code unless the daemon is built first. My first post-fix run was invalid for that reason. [run-regressions.sh](../scripts/hud/run-regressions.sh) builds in the right order.

## Regression results

| Suite | Result |
|---|---|
| HUD agent transport (new) | 92 / 0 |
| Browser HTTP transport, real Edge against `next start`, API stubbed (new) | 7 / 0 |
| HUD (Rust) | 38 / 0, 1 ignored (needs a live daemon) |
| Host protocol | 81 / 0 |
| Experimental features | 31 / 0 |
| Grounding | 77 / 0 |
| Agent runtime | 165 / 0 |
| Inference | 95 / 0 |
| Real-binary contract | 34 / 0 |
| Offline policy | 23 / 0 |
| API auth | 210 / 0 |
| Containment | 58 / 0 |
| Python sidecar containment (not run in Phase 5) | 15 / 0 |
| Type-check, production build | Pass |
| **Full .NET suite** (includes the 2 Phase 5 live tests, Wi-Fi on) | **256 / 1** |

**Remaining failure:** `RepeatedScreenCapture_Benchmark_And_ResourceStability_Test`. P95 capture latency was 51.84 ms against a 50 ms budget. It failed 4 of 5 runs alone, so it is a consistent narrow miss on this machine, not parallel-load noise as I suggested in Phase 5. Phase 6 didn't change capture code or this test. I did not raise the budget, and it is still open.

**Not run, as you instructed:** the earlier offline integration test.

**Smoke test only:** `phase6_session_survives_a_daemon_reply_overlapping_a_write` also passes on the old loop, because Windows absorbs those writes for a tokio server. Its comment says so. The proof of the deadlock fix is the live 2-of-12 vs 0-of-24 comparison.

## Acceptance criteria

### Phase 5 criteria, updated

| # | Criterion | Status |
|---|---|---|
| 1–10 | Startup through no replay or approval bypass | **VERIFIED**, now also from the HUD |
| 11 | Works without cloud | **VERIFIED** 2026-11-06 by the one Wi-Fi-off run (below) |
| 12 | HUD and native features intact | **PARTIALLY VERIFIED.** Agent features are verified with real input; other features were not walked through (below). |

### Phase 6 priorities

| # | Priority | Status |
|---|---|---|
| 1 | HUD connected to AgentTask messages | **VERIFIED** |
| 2 | Submit, progress, results, errors, cancel, Emergency Stop | **VERIFIED** |
| 3 | Browser HTTP preserved | **VERIFIED** at the page level with a stubbed API; routes covered by the auth and runtime suites |
| 4 | Daemon stays trusted; no bypass | **VERIFIED** |
| 5 | Real manual UI walkthrough | **PARTIALLY VERIFIED.** Real window and OS input, but not a person. |
| 6 | 0.5B and 3B on the full stack; tiers | **VERIFIED**: measured, tiers stay off |
| 7 | Pinned Node, hash-checked dist, Release build | **VERIFIED** on this machine |
| 8 | Stop count race | **VERIFIED** fixed |
| 9 | Regressions, failures reported | **Done**, 1 failure open |

## Known limitations

- **No person has used it.** Things a script can't judge: how it feels, readability over a busy desktop, sound and speech.
- **Not walked through:** voice, gestures, camera, phone panel, themes. Voice can't work in the HUD today: `/api/stt` has no native route, and it was a cloud path. That is not new.
- **Behaviour change:** in the HUD, anything that isn't a local command goes to the agent, so small talk like "hello" ends as refused or unverified rather than a chat reply. There is no local conversation mode yet.
- **Approvals:** the real runtime has no approval-required tool, so that path through the HUD hasn't been exercised with one.
- **Panel layout:** the agent panel covers the lower rows of the command history while it's open.
- **Refusals before a task starts** appear in the history, not the panel.
- **Repeat requests:** the same text within 5 s is silently ignored (existing debounce).
- **History:** requests are kept in plain text in the WebView's `localStorage` (existing behaviour).
- **Logs:** the `Start-D-ASK.cmd` launcher doesn't keep the daemon's log.

## Things to check in my work

- **Unrelated binaries rebuilt, against your instruction:** my plain `cargo build` also rebuilt `transparency_poc.exe`, `webview_transparency_poc.exe` and `inspect_webview2_transparency.exe` in `target/debug`. Same source, but the originals are gone. Later builds used `--bin hud-native` only.
- **Release HUD overwritten:** `target/release/hud-native.exe` was replaced by the requested Release build. You had explicitly authorized only the debug path, so I backed this one up too.
- **Extra build folder:** `target/p6-prefix` (1.7 GB) holds a pre-fix HUD for the before/after test. It connected through a temporary environment allowlist during that test only.
- **Screenshots show your desktop** through the transparent HUD, including this editor. `results/phase6/` is untracked but not gitignored, so don't commit it as is.

## Binary hashes

| Binary | SHA-256 |
|---|---|
| `target/debug/hud-native.exe`, before | `124e4f2b…972a` (backup: `results/phase6/backup/hud-native.debug.pre-phase6.exe`) |
| `target/debug/hud-native.exe`, now | `f76ea8c7…b9c8` |
| `target/release/hud-native.exe`, before | `52fcaeea…18d3` (backup: `results/phase6/backup/hud-native.release.pre-phase6.exe`) |
| `target/release/hud-native.exe`, now | `c4b67594…52ba` |
| `target/h3-verify/debug/hud-native.exe` | `96618828…91` at the start of Phase 6 and now, not overwritten |

## Wi-Fi-off verification (criterion 11)

You ran `dotnet test tests/DAsk.Daemon.Tests/DAsk.Daemon.Tests.csproj --filter "Category=Phase5Live"` through `scripts/hud/offline-phase5live.ps1`, with Wi-Fi off. It ran exactly once; the marker now prevents another run. Evidence is in `results/phase6/offline-live/`.

| | Result |
|---|---|
| Started / finished | 2026-11-06T00:53:26 / 00:54:02 (+05:30) |
| Tests | 2 of 2 passed (`phase5live.trx`: total 2, executed 2, failed 0); `dotnet` exit code 0 |
| Offline before | Every non-loopback interface was Disconnected, Windows reported no connection profile, and all 4 probes failed as unreachable |
| Ignored default route | One stale DHCP route, `0.0.0.0/0` via 172.18.192.10 on the disconnected Wi-Fi |
| Offline after | Same: only loopback connected, all probes failed |
| Non-loopback connections by `node`, `llama-server`, the daemon, `dotnet` or the test host | 0. The monitor ran throughout, last alive 00:54:01. |

**What the live test recorded:**
- The daemon started the host and the local model loaded. The first task, including the model load, took 6.5 s.
- `math.evaluate` returned `(17+25)*2 = 84`, with `independentlyVerified: true`.
- Cancel during real inference: 19 ms. Emergency Stop: 103 ms.
- A host crash was detected in 32 ms and recovered in 1.24 s.
- After a daemon hard kill, the host and `llama-server` were gone in 116 ms.

**Files:**
- `RUN-COMPLETED.txt`: the one-time marker.
- `phase5live.trx` and `dotnet-test.log`: the test output.
- `network-before.json`, which is the same as `preflight-20261106T005325.json`, and `network-after.json`: the network evidence.
- `preflight-2026-11-06T004556-false-positive.json`: the earlier refused preflight, kept as evidence.

**Not created:** `non-loopback-connections.txt`, because the monitor writes it only when it sees a connection.

**A first attempt was refused and didn't count:** the preflight wrongly treated the stale route as being online. That was fixed before this run; see the note under "Your remaining steps".

## Your remaining steps

**1. The Wi-Fi-off run: done** (see above). For the record, the steps were: turn Wi-Fi off, then in your own terminal run:

```
powershell -ExecutionPolicy Bypass -File D:\D-ASK\D-ASK\scripts\hud\offline-phase5live.ps1
```

It runs your exact test command, with test-output logging added so the path is recorded. It changes no network settings and refuses to run if the machine still looks online. Adding `-PreflightOnly` checks the offline state without running the test or writing any files. (A first version wrongly treated a stale default route on the disconnected Wi-Fi as being online. Fixed 2026-11-06; the rules are in `scripts/hud/offline-preflight.ps1`.) It also records any non-loopback connection and won't run a second time once the test has executed. Turn Wi-Fi back on afterwards and tell me, and I'll read the evidence in `results/phase6/offline-live/`.

**2. A person trying the HUD.** About five minutes:
1. Run `dist\desktop\D-ASK\Start-D-ASK.cmd`.
2. Type `What is (17+25)*2?`.
3. Start another task and click CANCEL.
4. Start another task and click STOP, then RESUME.
5. Press Ctrl+Shift+F12, then RESUME.

To close it afterwards, end `hud-native.exe` and `DAsk.Daemon.exe`; the launcher has no quit control yet.

## Addendum (2026-11-07): full-screen, click-through overlay

**Why the HUD blocked the desktop:** it was an ordinary always-on-top window, 1280×800 logical (1600×1000 px at 125%), overlapping the taskbar. Windows sends a click to whichever window owns that pixel, transparent or not, and WebView2's child windows took every click in the rectangle. CSS `pointer-events` could not help, and neither could `WM_NCHITTEST`/`HTTRANSPARENT`, which only passes clicks to windows of the same thread; WebView2's windows belong to another process. The orb also filled about 95% of the window's height.

**What changed:**
- [overlay.rs](../src/hud-native/src/overlay.rs) and [main.rs](../src/hud-native/src/main.rs):
  - The window is layered at full alpha, which keeps WebView2's per-pixel transparency, and sized to the monitor's work area in physical pixels.
  - A watcher refits it every second.
  - `WS_EX_TRANSPARENT` makes Windows skip the whole window, children included, during hit-testing.
- **Ambient** (the default): transparent and `WS_EX_NOACTIVATE`, so the HUD never takes clicks or focus.
- **Interactive** (Ctrl+Alt+Space): the page reports its panel and control rectangles. The watcher clears `WS_EX_TRANSPARENT` only while the cursor is over one of them, so empty space still passes through. Escape or Ctrl+Alt+Space returns to Ambient and gives focus back.
- **Hidden** (Ctrl+Alt+H): `SW_HIDE`, and the WebView stops rendering. Nothing else stops.
- **Page requests:** the page may only ask for Ambient or Hidden, never Interactive.
- **Hotkeys:** Ctrl+Shift+Space was avoided, because VS Code-based editors use it. If a hotkey can't be registered, the mode it would be needed to leave is refused.
- **Frontend** ([hudInteraction.ts](../hooks/hudInteraction.ts), JarvisOrb, AgentStatusPanel, DevicePanel, globals.css, orbScene.ts):
  - compact Ambient layout, full Interactive layout, and a mode indicator with AMBIENT and HIDE buttons;
  - panels laid out from measured positions, so they don't overlap or run off screen;
  - an orb sized to about 56% of the shorter screen side on large displays.

**Tests**, with real input against a probe application of known colour ([overlay-tests.ps1](../scripts/hud/overlay-tests.ps1)):
- **Release package:** 23 of 23, plus the existing 22-step walkthrough, 22 of 22.
- **Debug:** 22 of 23. The one failure is the Notepad test, see below.
- **Rust:** 43 / 0, 1 ignored (5 new overlay tests).
- **Frontend:** agent transport 92 / 0, browser transport 7 / 0, `tsc` clean.

**Notepad, an incident:** Windows 11 Notepad restores its previous session at launch. The one run that used it reopened the user's own Notepad windows, including an unsaved tab whose title begins with what looks like an API key. Part of that title appeared in the session's tool output. The text typed into the test's own file also arrived corrupted, and the cause was not established. Notepad is now opt-in (`-WithNotepad`) and was not used again.

**Limits:**
- Only the monitor the HUD is on is covered.
- A real DPI or resolution change was not performed; a forced move off the work area was used as a stand-in.
- No person has used the overlay yet.
- Not walked through in the new modes: voice, gestures, camera, phone panel, themes.

### Follow-up (2026-11-07): the orb blocked clicks in human testing

**Cause:** two HUDs were running at once; it was not the orb or the WebView.
- `Start-D-ASK.cmd` had been run twice, and nothing stopped a second HUD from starting.
- The second HUD couldn't register any hotkeys, Ctrl+Shift+F12 included, because the first held them.
- Its fallback then put it in **Interactive** mode "so the HUD remains usable". In Interactive mode empty space passes clicks through, but the orb's central drag region takes them, so two stacked overlays blocked exactly the orb's centre.

**Also found:**
- **A small race:** a watcher step that started in Interactive could clear click-through for about 16 ms after a switch to Ambient.
- **Lost logs:** a second HUD truncated the running HUD's log file before exiting, which is why the first HUD's log was missing.

**Fixes** in [main.rs](../src/hud-native/src/main.rs) and [overlay.rs](../src/hud-native/src/overlay.rs):
- **One HUD per session:** a named mutex is taken before the log is opened, and a second HUD exits at once.
- **No automatic Interactive:** the HUD never enters Interactive except by the user's hotkey. A hotkey conflict now leaves it in Ambient, click-through, with a notice on screen.
- **Race closed:** the watcher only clears click-through if the mode is still Interactive while it holds the style lock.

**Tests:** [orb-clickthrough-tests.ps1](../scripts/hud/orb-clickthrough-tests.ps1), on the Release package, with real input and a probe window verified to sit directly behind the orb: **10 of 10**.
- **Ambient:** clicks at the orb's centre and outer ring reach the probe.
- **Interactive:** the centre goes to the orb, and drag and scroll still rotate and zoom it.
- **Switching:** Interactive → Ambient, by the hotkey and by Escape, passes clicks again. 20 quick switches leaked no input state.
- **Emergency Stop:** Ctrl+Shift+F12 in Ambient stopped a running task.
- **Second instance:** a second HUD exits, and the first HUD's log is preserved.
- **Hotkey conflict:** with the hotkey held by another program, the HUD stays Ambient and click-through.

**Re-run on the same package:** overlay tests 23 of 23, walkthrough 22 of 22, Rust 44 / 0 with 1 ignored.
