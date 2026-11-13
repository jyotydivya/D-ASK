# D-ASK product completion: progress checkpoint

Last updated: 2026-11-10 21:20 (+05:30). Latest: "File summarisation (`filesystem.summarize`) real-HUD acceptance" near the end (online 12 / 12 and Wi-Fi-off 12 / 12 PASS), then the updated Status; before it, "Note creation (notes.create)" (11 / 11 each). Keep this file short; it is the resume point.

## Baseline (verified from evidence, not re-investigated)

- Phase 7B.3 P0 functional acceptance: **PASS** on the updated build, `results/phase7b3/offline-live/20261109T193116/`: wire 1 / 1, real HUD 17 / 17, Wi-Fi off before and after, 0 non-loopback connections. The wrapper `results/phase7b3/acceptance-runs/20261109T193106/` switched the radio off, confirmed it, and restored it.
- Screen-capture median latency < 30 ms: NOT ACHIEVED (tracked separately, report §6.16). P95 < 50 ms: achieved.

## Gap matrix (repository evidence, 2026-11-09)

| Area | State before this sprint | Evidence |
|---|---|---|
| A AI brain | Local llama.cpp (Qwen 0.5B/1.5B/3B GGUF), planner, verifier, re-planning, completion loop | `agent/runtime/*`, 7B.3 report |
| B Voice | **Missing offline.** The legacy STT route calls Groq/OpenAI (cloud); no local STT/TTS models on disk | `app/api/stt/route.ts` |
| C Vision | Window list/inspect + UIA tree + GDI capture; no screen understanding model | `DesktopReadService`, `WindowsUiAutomationService` |
| D Memory | **Legacy only, cloud-bound** (OpenAI embeddings); the production runtime has history only | `lib/agent/memory/*` |
| E Windows control | Window ops (7B.3). **Mouse/keyboard were missing** (legacy engine simulated-only) | `ActionExecutionEngine.cs:887` |
| F Files | Search/metadata/read/find_text with roots and exclusions; no summarize/organize | `agent/runtime/tools/filesystem*.ts` |
| G Browser | Playwright dependency + Chromium 1243 installed locally; no production tool | `package.json`, `ms-playwright` |
| H Agentic | Plan → execute → verify → re-plan, cancellation, Emergency Stop | runtime + daemon |
| I HUD | Rust + WebView2 orb HUD, approvals, Stop/Resume, reconnection | `src/hud-native`, 7B.x reports |
| J Automation | Missing | none |
| K Plugins | ToolRegistry only (static) | `toolRegistry.ts` |
| L Packaging | Missing (`electron` still listed as a devDependency: to be removed in packaging) | `package.json` |

## Batch 1: P1 mouse + P2 keyboard/text (daemon). DONE and verified

Files:
- `src/DAsk.Daemon/Automation/Input/GuardedInput.cs`: contracts, control resolver, chord allowlist, text rules, sequencer.
- `src/DAsk.Daemon/Automation/Input/Win32GuardedInput.cs`: SendInput, the D-4 low-level hook monitor, UIA hit-test/focus/value.
- `src/DAsk.Daemon/Automation/Input/GuardedInputRequestService.cs`: the approval pathway, plus the composite router.
- Edits:
  - `ActionPolicyEngine.cs`: new `Desktop.*` types, Elevated.
  - `AgentHostManager.cs`: `DesktopMouseInput` / `DesktopKeyboardInput`, default false.
  - `Program.cs`: wiring.
- Tests:
  - `tests/DAsk.Daemon.Tests/GuardedInputTests.cs` (36);
  - `GuardedInputLiveTests.cs` (opt-in `DASK_LIVE_INPUT=1`);
  - `Fixtures/input-fixture.ps1`.

Tools (agent-facing, daemon-side): `desktop.click_element`, `desktop.type_text`, `desktop.press_keys`. Element-bound (control type plus automation id or name); no coordinates, handles or key codes from the agent.

Results:
- Unit tests 36 / 36.
- **Real OS on the fixture 1 / 1**: click verified (fixture reported `CLICKS 1`); typing an exact insertion; Backspace; foreign input stopped typing after 1 of 4 steps.
- **Full daemon suite 439: 438 passed, 1 skipped (opt-in live), 0 failed.**
- Evidence: `results/p1p2-input/20261109T*/`.

Configuration: both input kinds are **off** in code and in `appsettings.json` (not yet set). Enable them only after the agent tools and the HUD approval card are verified end-to-end.

## Batch 1b: P1/P2 agent side. DONE and verified (2026-11-09 20:46)

- `agent/runtime/tools/desktop.ts`:
  - `requestedInputAction` covers one click / one quoted text / one allowed chord per request.
  - `canonicalChord` mirrors the daemon's allow-list.
  - `createInputTool` + `inputCheck`: the window, control, text and keys are grounded in the request; facets are satisfied only by a daemon-verified execution.
  - `requestedTitle` prefers the quote after "window titled" (input requests quote text too).
  - `actuationRefusal(o, inputOffered)`: an input request passes ONLY if the daemon offered that tool. With input off it is refused exactly as before (the 7B.1b live test still passes unchanged).
- `agent/host/desktopBridge.ts`: `offers(tool)`.
- Daemon: input tools get a separate per-task budget (`MaxInputRequestsPerTask = 6`, each separately approved). Window operations keep exactly 1 (`AgentHostDesktopCalls.cs`). Only enabled input kinds are offered to the agent.
- **Pre-existing crash fixed:** `WindowsUiAutomationService` worker loop: `Dispose` (500 ms join) could dispose the queue under a busy worker, and the unhandled `ObjectDisposedException` killed the process (it crashed a full-suite test host on 2026-11-09 20:31). The worker now ends quietly, and the queue is disposed only after the worker exits. The crashed run orphaned one test daemon tree (daemon 25240, agent host 14852, llama-server 22108); it was verified as such and stopped.
- **Tests changed (superseded pre-P1 contract, made stricter, not weaker)** in `tests/agent-runtime/desktop.test.ts`:
  - R18 (+double-click, right-click, drag, click-then-close still refused; +R18b);
  - S1 (tool list);
  - S10 (+S10b: coordinates never reach the daemon);
  - S12 (+S12b: double-click still refused with no model call);
  - new [I] I1–I18.
- Results:
  - desktop.test.ts 200 / 200;
  - all other TS suites pass;
  - tsc 0;
  - **daemon suite 439: 438 passed, 1 skipped (opt-in live input), 0 failed**.
  - Evidence: `results/p1p2-input/20261109T201117/` (`full-suite-5.*`).

## Batch 1c: HUD integration and real-HUD / offline acceptance of guarded input. DONE (2026-11-09 21:35)

**Acceptance (Wi-Fi off), PASS**:
- Evidence: `results/p1p2-hud/offline/20261109T213052/` (P1/P2) and `results/phase7b3/offline-live/20261109T213055/` (P0, unchanged script).
- Wrapper: `results/phase7b3/acceptance-runs/20261109T213040/`. The radio was confirmed Off before and after, and restored to On.
- P0: wire 1 / 1, real HUD **17 / 17**, 0 non-loopback connections.
- P1/P2: real HUD **23 / 23**, 0 non-loopback connections. Memory with the HUD running: 3,466 MB (2,973 required). The model server started and became ready (Vulkan).
- Input results:
  - click verified (the fixture reported 1 click);
  - "hello d-ask" verified as an exact insertion (the fixture's SHA-256 matches);
  - Backspace verified (the fixture shows one character fewer);
  - DENY: no input;
  - STOP while pending: invalidated, no input; RESUME;
  - foreign input stopped typing after **4 / 120** steps, nothing retried;
  - no button or modifier held afterwards;
  - flags default off.

**Changes in this batch**:
- HUD card (`hooks/approvalLifecycle.ts`, `components/ApprovalSurface.tsx`):
  - labels for the three types;
  - a "WHAT WILL HAPPEN" line;
  - no decision is offered if the control, point, keys or exact text are missing or inconsistent.
- HUD native:
  - `ipc/client.rs` publishes the VERIFIED daemon PID;
  - `main.rs`: on APPROVE of an input action, `AllowSetForegroundWindow(verified daemon PID)` and a bounded (45 s) **input pass-through** until the task's result;
  - `overlay.rs`: `begin/end_input_passthrough`, so the HUD can never cover the approved target. Stop stays on Ctrl+Shift+F12, and physical input stops the action.
- Daemon (`GuardedInput*`):
  - control-type aliases, and one exact identifier may be the name or the automation id (still unique);
  - one `SetForegroundWindow` (never retried), then up to 600 ms of observation;
  - occlusion and hit-test checked after the pointer move and immediately before the button event (200 ms settle);
  - refusal codes and unresolved selectors are logged (never text).
- Agent (`desktop.ts`, `planner.ts`):
  - the control is pinned to the request through argument domains (`controlType`/`control`). The local model invented `goButton` / `windowContains` before this.
  - Identical input steps are deduplicated. The model put the same typing step in one plan 5 times, and the 2nd copy asked for a 2nd approval of the same text.
  - At most one input approval per task.
- Harnesses:
  - `scripts/hud/approval-live-input.ps1` (23 checks; reuses the P0 helpers verbatim);
  - `scripts/hud/offline-input-acceptance.ps1`;
  - the wrapper gained `-AcceptanceScript`;
  - `input-fixture.ps1` gained `-OutFile`.

**Regression**:
- daemon suite **441: 440 passed, 1 skipped (opt-in live), 0 failed**;
- TS desktop 204, approval-lifecycle 60, all others unchanged and passing;
- tsc 0;
- Rust 53 passed, 1 ignored;
- wrapper tests 21 / 21.
- Evidence: `results/p1p2-hud/20261109T205308/` (online diagnostic runs 1–11 and final-regression).

**Limitations (honest)**:
- One input action per request; multi-step input needs ordered input facets.
- Clicks are verified by a change in the window's UI tree. A click with no visible effect is reported `execution_unverified`, never success.
- During an approved input action the HUD's STOP button is not clickable (pass-through); Ctrl+Shift+F12 and any physical input stop it.
- Mouse and keyboard input stay **off by default** (appsettings and code); the acceptance enabled them only in its daemon's environment.

## Batch 1d: multi-step input in one request. IMPLEMENTED; unit/integration verified; real-HUD run BLOCKED by memory (2026-11-09 23:15)

- Agent (`agent/runtime/tools/desktop.ts`):
  - `requestedInputActions(o)`: ordered steps split on ", then" / "and then" / "then" / "and" / ";" only before an input verb (quotes masked). A later step may omit its control ("…, then press Enter" → same control; "then type" only after an Edit).
  - Limits: ≤ 6 steps (`MAX_INPUT_STEPS` = the daemon's per-task budget), one window. Fail closed: any unparseable, forbidden or non-input part refuses the WHOLE request.
  - One `sequence` facet per step (`input-steps`). `ground` and `satisfies` require the exact (control, text/keys) tuple of one step; no recombining across steps.
  - Per-task progress replaces "one input per task". Step k reaches the daemon only after steps 1..k-1 were performed AND verified. Out-of-order and repeated steps never reach it. Any step not performed+verified halts the sequence: no retries, and re-plans cannot ask again. Without the objective (direct invocation): one per task, as before.
- Runtime: `ToolExecutionContext.objective` (optional) plumbed through `toolRegistry.invoke`.
- Planner: `ToolRequestCheck.identicalStepsAllowed`; duplicate removal keeps exactly the repeats the request asks for ("Backspace, then Backspace").
- HUD (`overlay.rs`): `begin_approval` ends input pass-through, so step 2's card is clickable after step 1 (+1 Rust test).
- Daemon: unchanged. It already serialises calls (one active per task, ≤ 6 input approvals, each separately approved).
- Tests:
  - desktop.test.ts **230 / 230**: new [J] J1–J18. I7 updated: it asserted the superseded single-step contract and now asserts the sequence.
  - Rust **54 passed, 1 ignored**.
  - All other TS suites unchanged and passing; tsc 0.
  - Evidence: `results/p1p2-multistep/20261109T231214-regression/`.
- Real-HUD harness: `scripts/hud/approval-live-multistep.ps1` (11 checks: type→Backspace with two cards, approve both; then approve step 1 + DENY step 2). Setup now waits for the handshake.
  - **Not yet passed.** Three attempts (`results/p1p2-multistep/live-*`) all stopped before any task, and none is a product failure:
    - one harness timing fault (fixed);
    - twice the unchanged memory preflight refused, at 2,004 MB and 2,207 MB free (2,973 needed). User applications (Chrome, IDE) hold the memory, and none were closed.
  - Re-run it when memory allows, then add it to the offline wrapper.

## Batch 2a: browser stage 1 (read pages the user names, local Chromium). DONE (2026-11-09 23:12)

- `agent/runtime/browser/policy.ts`:
  - only http(s), no credentials in the URL;
  - only the named site (plus subdomains). For a local address the user typed: that host AND port only;
  - private, loopback and link-local addresses are refused unless typed by the user; DNS-rebinding check.
  - `urlsIn` covers schemes and bare domains with known TLDs. File names, e-mail addresses and versions are not URLs.
- `agent/runtime/browser/playwrightEngine.ts`, one fresh headless Chromium per read:
  - `--host-resolver-rules=MAP * ~NOTFOUND`: the browser itself cannot resolve any name;
  - every request goes through the route handler: policy → DNS check → Node fetch with redirects OFF. Each redirect hop is re-checked; a main-frame redirect re-navigates;
  - WebSockets, downloads, service workers and dialogs are blocked or dismissed;
  - lazy `require("playwright")`.
  - Found while testing: Playwright does not route the browser's own redirect follow-ups. The resolver lockdown still blocked them, and redirects are now followed manually.
- `agent/runtime/tools/browser.ts`:
  - `browser.read_page` takes `url`, pinned to the request (argument domain). Satisfied only for a 2xx page on the named site with text. ≤ 3 pages per request.
  - Page actions (click, fill, log in, buy, download, post …) are refused before planning.
  - Permission `network`.
- Registration: `defaults.ts` `browser` option. `stdioHost.ts` enables it only with `DASK_AGENT_BROWSER=1`, granting `network` only then. **Off by default.**
- Tests: `tests/agent-runtime/browser.test.ts` **34 / 34**. 9 are LIVE on the real Chromium 1243 against loopback servers: read, block another host / another port / external / WebSocket (the other server got 0 hits), same-site redirect, off-site redirect refused, download refused, file:// refused, cancellation, and real runtime completed + independently verified.

## Batch 2b: browser stage 2 (approved clicks and field fills). IMPLEMENTED; daemon, fixture and live-Chromium verified; real HUD NOT yet run (2026-11-09 23:45)

Status:
- Implemented, integrated, automated tests passed, live tests on the real local Chromium against a loopback fixture site passed.
- Not yet tested: real HUD, offline run. The HUD card logic is unit-tested.
- Off by default: `AgentHost:BrowserActions = false` and `BrowserRead = false`.

Daemon (approval authority):
- `src/DAsk.Daemon/Automation/Browser/BrowserActionRequestService.cs`, tool `browser.request_action`.
  - Strict arguments: kind click|fill; http(s) `pageUrl` without credentials; `pageTitle`; element {role from an allow-list, name, tag, SHA-256 fingerprint}; text for fill only (≤ 500 characters, text roles only); `ownerPid`. Unknown fields are refused.
  - `Browser.Click` / `Browser.Fill` are classified Elevated, never auto-allowed.
  - Uses the same policy engine as the desktop actions: owner session, HUD liveness, digest, expiry, Stop generation, single-use consumption. The audit stores only the text's SHA-256, never the text.
  - Offered only when enabled AND an audit journal exists. Shares the per-task input budget (6).
- Options (`AgentHostManager.cs`): `BrowserRead`, `BrowserActions`, `BrowserPersistentProfile`, `Memory`, all false. They map to the host environment variables `DASK_AGENT_BROWSER`, `DASK_BROWSER_PROFILE`, `DASK_AGENT_MEMORY`.

HUD (`hooks/approvalLifecycle.ts`):
- `Browser.Click` / `Browser.Fill` labels and a "WHAT WILL HAPPEN" line.
- No decision is offered if the site and the page address disagree, if the element or fingerprint is missing, or if the text length mismatches.

Agent:
- `agent/runtime/browser/playwrightEngine.ts`:
  - `GuardedPage` is shared by stage 1 and stage 2. Popups, file choosers, downloads, WebSockets and dialogs are blocked or dismissed.
  - `identify`: exactly one visible, enabled element of that role with that accessible name (exact, case-insensitive), in the main frame. Password and payment-secret fields are never identified for filling.
  - `act`: revalidates the page URL and element fingerprint after approval, performs the action once, then verifies it: the field holds exactly the text; or, for a click, the address, the content or the checked state changed. Otherwise the step is not successful. A screenshot is saved as evidence.
  - `BrowserSessions`: one page per task, closed at task end (new `ToolSpec.endTask` hook, called by the runtime), on abort, or after 5 idle minutes.
- `agent/runtime/tools/browserActions.ts`:
  - Grammar: "On <url>, type "…" into the X field, then click the Y button" / "Go to <site> and click the Z link". Up to 6 steps, one site.
  - Fails closed: downloads, uploads, passwords, cards, tokens, a second site, unquoted text, or any part that doesn't parse refuses the whole request.
  - Arguments pinned to the request; strict order; a step that isn't performed and verified halts the sequence.
  - The approval must match the identified element (fingerprint and page) or nothing is done.
- Desktop `actuationRefusal` leaves fully parsed browser-action requests to the browser tools. They refuse when the daemon doesn't offer actions.
- Profile:
  - Default is a fresh in-memory profile per task.
  - Opt-in persistence uses D-ASK's own profile at `%LOCALAPPDATA%\D-ASK\browser-profile`.
  - `agent/runtime/browser/profileCli.ts`: `status`, `signin <url>` (a visible window; the user signs in), `clear --yes` (logs out everywhere). It refuses any Chrome or Edge directory.

Tests:
- `BrowserActionTests.cs` 18 / 18.
- Full daemon suite **458 passed, 1 skipped (opt-in), 0 failed**.
- `browser-actions.test.ts` **37 / 37**, 17 of them LIVE on the real Chromium:
  - fill then click, approved separately and in order; the page shows "Thanks, me@example.com!"; screenshots captured; browser closed at task end;
  - deny stops everything; wrong order never reaches the daemon; a same-site link navigates;
  - an ambiguous or disabled element is refused before approval; a password field is refused;
  - an element changed after approval is not clicked; an approval for another element is unused;
  - an off-site redirect is not followed (0 hits on the other server); cancellation closes the browser;
  - a cookie persists only with the opt-in profile, and cookies are never returned to the agent.
- `browser.test.ts` 34 / 34 after the refactor.
- approval-lifecycle 66 / 66 (+B1–B6).
- Evidence: `results/browser-stage2/20261109T234229/`.

Bug found and fixed while testing: a stale incremental daemon build gave "unknown argument ownerPid" in the first full run; an explicit rebuild fixed it.

## Batch 3: local persistent memory. IMPLEMENTED; automated tests passed; not yet HUD-tested (2026-11-09 23:55)

- `agent/runtime/memory/memoryStore.ts`:
  - SQLite (existing better-sqlite3) in `%LOCALAPPDATA%\D-ASK\memory.db`;
  - FTS5 BM25 with porter stemming, blended with pinning, recency and use;
  - metadata: kind, tags, source, created/updated/used, expiry;
  - dedupe; secrets refused (passwords, PINs, cards, API keys, JWTs, private keys, identity numbers);
  - real deletion (secure_delete plus a WAL checkpoint);
  - export; `TaskScratch` holds in-memory task state only.
  - No embedding service. A local embedding model could be added later behind `recall()`.
- `agent/runtime/tools/memory.ts`:
  - `memory.remember` stores the user's own words, pinned;
  - `memory.recall` takes the user's question;
  - `memory.forget` handles one named subject, at most 5 entries. "Forget everything" is refused in chat and is a user control.
  - New permissions `memory:read` / `memory:write`.
- User controls: `agent/runtime/memory/memoryCli.ts` (`list`, `search`, `export`, `forget <id>`, `clear --yes`).
- Legacy: `agent/agents/memoryAgent.ts` store/search now uses the local store. Nothing calls `embeddingService` any more (the file remains, cloud-gated).
- Enablement: `AgentHost:Memory` (default false) maps to `DASK_AGENT_MEMORY=1`.
- Tests: `memory.test.ts` **31 / 31**:
  - relevance and stemming; metadata filters; dedupe; 5 kinds of secret refused;
  - update re-indexes; forget removes the row and its index entry, and the text is absent from the DB and WAL bytes;
  - restart persistence; expiry; FTS-injection-safe queries; scratch separation;
  - end-to-end remember → restart → recall → forget through the real runtime; no grant means nothing is stored.
  - Footprint: 5,000 memories in 2.06 MB, recall about 2.7 ms on average.
- Evidence: `results/memory-local/`.
- Not yet: memory is not injected into planning context automatically (tools only). That is the next memory step.

## Multi-step real-HUD acceptance: still outstanding

The fourth attempt at 23:47 (`results/p1p2-multistep/live-20261109T234736`) was refused by the unchanged memory guard: 2,945 MB available, 2,973 required (28 MB short). Re-run when more memory is free.

## Batch 4: offline voice (TTS + STT). IMPLEMENTED; real SAPI engines tested; real HUD + real microphone NOT yet tested (2026-11-10 00:25)

Investigation (this machine):
- Installed: SAPI voices David and Zira, OneCore David / Mark / Zira, and the SAPI desktop recognizer MS-1033-80-DESK (en-US). No Whisper or Vosk model on disk.
- `System.Speech` is not in the local NuGet cache, so I used SAPI through the `windows` 0.62.2 crate already in the cargo registry: features `Win32_Media_Speech`, `Win32_Media_Audio`, `Win32_System_Com` (no download).
- The old HUD voice picker preferred "Google" / "Natural" voices, which are online voices. Native `/api/stt` returned 404, so voice input did not work offline at all.

TTS:
- `src/hud-native/src/tts.rs`: an STA worker owning SAPI `ISpVoice`. Speech is async with purge-before-speak and `SPF_IS_NOT_XML` (markup is never interpreted), bounded at 4,000 characters. Stopped on every Emergency Stop path (hotkey and daemon response).
- Page messages `Speak` / `StopSpeaking`.
- `lib/soundEngine.ts` uses native SAPI inside the HUD. Elsewhere `pickLocalVoice` uses local voices only (never Online / Natural / Google); with no local voice, nothing is spoken. `stop()` handles interruption: the mic opening stops speech, and so does Emergency Stop.

STT:
- `src/hud-native/src/stt.rs`: the SAPI in-process recognizer with dictation over a WAV file, on its own COM thread, ≤ 20 s. WAV validation: 16-bit PCM, ≤ 2 MB.
- `main.rs`: the `dask://` protocol is now asynchronous. `POST /api/stt` validates the WAV, transcribes on a worker thread, and deletes the recording.
- `lib/pcmRecorder.ts`: 16 kHz mono 16-bit WAV capture, downsampling and encoding, with the MediaRecorder-like surface. `components/JarvisOrb.tsx` uses it and posts raw WAV. No cloud STT in the native HUD; the legacy Next `/api/stt` stays cloud-only and refuses in local mode.

Tests and evidence:
- Rust **56 passed, 3 ignored**: TTS text rules; WAV validation; the real SAPI speak-and-stop test was run once (passed).
- `tests/hud-agent/stt-roundtrip.ps1`: a local SAPI voice speaks into WAV, then the recognizer transcribes it. **3 / 3 passed the 70 % word threshold**, 0.75–1.24 s each. Errors seen: "type" heard as "inside", "Pune" as "include a". Evidence: `results/voice-local/stt-20261110T001257/`.
- `tests/hud-agent/voice.test.ts` **7 / 7**. T7 runs audio upsampled to 48 kHz, re-encoded by the HUD code, through the real recognizer: "What is the weather like today", exact, 206 ms.
  - T5 is weak: headless Chromium exposes 0 voices, so the WebView2 voice list is unverified until the real HUD runs.
- Next build OK.
- Fixed during this batch: `defaults.ts` → `desktop.ts` → `browserActions` pulled the Playwright engine into the Next bundle (an EPERM glob over `%LOCALAPPDATA%` failed `next build`). Host-only tools moved to `agent/runtime/hostRegistry.ts`, and `BrowserPolicyError` moved to the pure `policy.ts`.

Limitations:
- SAPI dictation accuracy is modest. The test audio was synthetic, so real-microphone accuracy will be lower.
- Higher accuracy needs whisper.cpp: a binary plus a model (tiny.en ≈ 75 MB / base.en ≈ 142 MB, about 0.3–0.5 GB RAM). That is a provisioning decision for the user. The engine-neutral contract (`stt::transcribe_wav`) is ready for it.
- No wake-word engine (the old transcript-regex "wake" path is kept).

## Session 2026-11-10 (11:40–13:00). Evidence levels: AUTO = automated tests; FIXTURE = real engine/model on fixtures; REAL-HUD = through the real HUD; OFFLINE = accepted with Wi-Fi off

### Batch 1e: multi-step input fix, found by the first real-HUD run

- **Real-HUD run 1** (`results/p1p2-multistep/live-20261110T114435`): step 1 was approved, typed and verified. The task then ended `unverified` and never asked for step 2. This was a real product defect.
- Root cause, reproduced deterministically with the real local model (`scripts/diag/multistep-plan-trace.ts`, a fake daemon, no desktop input):
  - for the text "ok", the model plans only step 1, and its assessment says "done";
  - `experimental.gapReplanning` is off by default (Phase 4 decision), so the uncovered step-2 facet never triggered a round;
  - once a round was forced, the model's re-plan repeated step 1. It was correctly refused, not re-typed, but step 2 depended on it, so it was skipped.
- Fixes (general gap replanning stays off):
  - `grounding.ts`: `pendingOrdered` lists the unsatisfied ordered-sequence facets, only when every executed step succeeded. `verifier.ts` always treats these as a gap.
  - `runtime.ts`: `orderedContinuation`. When the ONLY gaps are ordered steps whose arguments the request fully determines (`ToolRequestCheck.stepFor`, implemented for desktop input), the follow-up round is built deterministically, with no model re-plan. It is validated by `Planner.check` and then still goes through the argument domains, the in-order progress gate, and a separate daemon approval for each step.
  - `planner.ts`: `performed` steps from earlier rounds count against `identicalStepsAllowed`, so a model re-plan never repeats a performed input.
- AUTO: desktop.test.ts **235 / 235**, including:
  - J19: only step 1 planned and the model says done → step 2 still runs;
  - J20: the continuation is deterministic, the model plans once, step 1 is not repeated;
  - J21: a denied step 1 gets no follow-up round;
  - J22: a repeated key keeps exactly the allowance;
  - J23: the planner drops copies of performed steps.
  - J15 had passed only because its scripted model asked for more steps.
- FIXTURE (real model, fake daemon): 3 / 3 completed (type → Backspace).
- **REAL-HUD run 2** (`live-20261110T115937`, the fix minus the deterministic continuation):
  - card 1 approved: typed and verified;
  - card 2 (Backspace) appeared, was approved, pressed and verified (daemon log);
  - the fixture's text went from 2 characters to 1, and the task finished `completed`.
  - The harness process then died: my tool's 10-minute limit killed it after the product had finished, so the 2b/2c/3 checks were never recorded. I stopped its orphaned daemon/HUD/fixture tree.
- Real-HUD run 3 (`live-20261110T121141`): the model's re-plan again lacked step 2. That led to the deterministic continuation above, which has **not yet been run in the real HUD**.
- Runs 4–6 (`live-20261110T1228*`, `124349`, `125318`): the unchanged memory guard refused at 2,885 / 2,889 / 2,642 / 2,937 MB (2,973 required). No task was sent and no application was closed.
- **Status: multi-step 11 / 11 real-HUD still outstanding.** Run `scripts/hud/approval-live-multistep.ps1` in the background (it can take more than 10 minutes), after `npm run build:agent-host`.

### Batch 4b: optional whisper.cpp STT. FIXTURE-tested; real microphone tried, NOT accepted; not real-HUD, not offline-accepted

- Pinned in `agent/runtime/inference/whisper-artifacts.json`:
  - whisper.cpp **b5454** `whisper-bin-x64.zip` (CPU), using the GitHub digest;
  - **ggml-base.en-q5_1** (57 MB, about 200 MB RAM), with the Hugging Face LFS SHA-256;
  - the 41 extracted files are pinned too.
- Installer: `scripts/inference/fetch-whisper.mjs` (`--verify`, `--from <dir>`).
  - Node's fetch and curl stalled on this network: there was a certificate-revocation-offline error, and the CDN stalled.
  - `curl --ssl-no-revoke` worked; integrity comes from the pins.
  - Installed in `local-inference/whisper.cpp/` (git-ignored); `--verify` passes.
- `src/hud-native/src/whisper.rs`:
  - uses the engine only if EVERY pinned file and the model hash correctly (Windows CNG SHA-256, no new crate; feature `Win32_Security_Cryptography`), cached by file size and modification time;
  - runs `whisper-cli` with no window, a 20 s limit, and kill on timeout;
  - drops non-speech annotations and **double quotes**, because whisper adds `type "Hello"` on its own and quoted text is what the input grammar types exactly;
  - `DASK_STT_ENGINE=sapi` forces SAPI.
- `stt::transcribe` tries whisper only for 16 kHz mono audio. If whisper is missing, tampered with, or fails, it falls back to SAPI, and the response names the `engine`.
- AUTO: Rust **60 passed, 4 ignored**, with new tests for CNG test vectors, transcript cleanup, a tampered or missing install not being used, and 16 kHz gating. All TS suites pass.
- FIXTURE (`tests/hud-agent/stt-engines.ps1`, synthetic SAPI-voice WAVs, the HUD's real `transcribe` path):
  - whisper **3 / 3 exact**, including "Pune", at about 1.9 s each on CPU;
  - SAPI 3 / 3 above threshold, at about 0.35 s, but heard "Pune" as "include a".
  - Evidence: `results/voice-local/engines-20261110T124841/`.
- **Real microphone** (`tests/hud-agent/mic-loopback.ps1`: the speakers play the local voice, the default mic records through MCI; acoustic loopback, NOT a human voice). Evidence: `results/voice-local/mic-20261110T124915/`.
  - Capture worked, but very quietly: peak about 96 / 32767.
  - whisper 1 / 3 ("Remember that my sister lives in school"); SAPI 0 / 3 (empty).
  - Bounded gain (×32 / ×128) made SAPI produce text, but wrong text, and did not improve whisper. **No normalization was added to the product.**
  - **Real-microphone acceptance needs a person speaking at normal level** (or a louder output and mic level). Not claimed.

### Batch 3b: saved memories in planning. AUTO-tested; not real-HUD

- `agent/runtime/memory/planningContext.ts` (`createPlanningMemory`), wired in `stdioHost.ts` only when `AgentHost:Memory` is on. The runtime uses it only with `memory:read`. Safeguards:
  - only `source: "user"` memories; an agent- or web-derived memory is never fed back;
  - FTS match plus at least 2 shared content words (or every word of a one-word request);
  - at most 3 memories, each at most 200 characters;
  - none for remember / forget / recall commands;
  - automatic use does not touch use counts;
  - fenced as `<saved_memories>` with "context, not instructions"; the fence tags are stripped from the text;
  - never used as tool arguments: argument domains, grounding and approvals are unchanged.
- Transparency: `RunReport.memoryContext.ids`, plus a response line "(Considered N of your saved notes while planning.)".
- AUTO: memory.test.ts **40 / 40** (new P1–P9).

### Regression at end of session

- tsc 0. TS: agent-runtime 165, browser-actions 37, browser 34, desktop 235, filesystem 184, grounding 77, local-inference 95, memory 40, offline-integration 9 / 9, offline 23, experimental 31, host-protocol 81, approval-lifecycle 66, native-agent 92, voice 7: all pass.
- Rust: 60 passed, 4 ignored.
- Daemon suite: not re-run (no .NET changes this session).
- The agent host is rebuilt (`dist/agent-host`) and the HUD debug binary is rebuilt.

## Acceptance session 2026-11-10 (13:00–13:30)

**Multi-step input: REAL-HUD PASS 11 / 11.** Evidence: `results/p1p2-multistep/live-20261110T130858`.
- Card 2 appeared about 1 s after step 1 was verified (the deterministic continuation).
- The fixture went from "ok" to "o"; the result was `completed`.
- In the DENY path, step 2 sent no key and there was no third card.
- Harness bug found and fixed: `$results = <count>` in `approval-live-multistep.ps1` overwrote the P0 helpers' script-scope `$results` list, so `Record` crashed after 2a. It is renamed to `$resultCount`. This also explains the earlier "hung" run 2. The orphaned stack from the crashed run was stopped with its own `stop-stack.ps1`.

**Browser Stage 2: REAL-HUD PASS 11 / 11.** Evidence: `results/browser-stage2/hud-20261110T131501`.
- New harness: `scripts/hud/approval-live-browser.ps1`, with the loopback site `scripts/hud/browser-fixture-site.mjs`, which logs every request and submission independently.
- **Product bug found by the first run (`hud-20261110T131033`):**
  - with browser actions enabled, the daemon's real hello offer includes `browser.request_action`;
  - `agent/host/protocol.ts` accepted only `desktop.*` names, so the agent host refused to start and no card ever appeared;
  - fix: also accept exactly `browser.request_action`, with a maximum of 10 offered tools;
  - tests P4b (the real offer parses) and P4c (`browser.navigate` and look-alike names are still refused).
- Run results:
  - fill card: site, field and complete text shown, approved, consumed once;
  - click card, same task: approved, `completed` / Verified;
  - the site logged exactly one `SUBSCRIBE "me@example.com"`;
  - second request: the fill was DENIED, with no second card, nothing consumed, no submission, and a `FAILED` result.
- Also added: `stepFor` for browser actions (deterministic continuation, live test L1b on the real Chromium), and the browser tools now in `DEDUPLICATED_TOOLS`.

**Whisper quote handling (changed from batch 4b):**
- Observed with b5454 base.en: whisper writes a spoken "quote hello world unquote" as `"Hello World"`, so stripping quotes lost dictated text.
- Now:
  - quotes are kept;
  - spoken markers become quotes for both engines ("quote … unquote", "open/close quote", "end quote");
  - whisper's leftover marker words are removed;
  - **unbalanced quotes → all quotes dropped** (nothing ambiguous is typed);
  - quoted text is still shown exactly on the approval card before anything is typed.
- Known limit: whisper sometimes adds quotes nobody dictated (`type "Hello"` from "type hello", seen once). The card shows the exact text, and DENY prevents typing.
- Rust: 61 passed, 4 ignored.
- FIXTURE through the real `transcribe` path: "Type "Hello World"…", "Type "good morning"…", "Type hello…" (no quotes). Evidence: `results/voice-local/quotes-*`.

**Whisper real-HUD with a person speaking: NOT DONE.**
- `scripts/hud/voice-live.ps1` started the real stack and waited 8 minutes (`results/voice-local/hud-20261110T131612`).
- No microphone permission request and no `/api/stt` call reached the HUD: the mic button was never used. No transcript, no claim.

**Wi-Fi-off acceptance: RAN, BLOCKED by the memory guard.**
- New combined script `scripts/hud/offline-full-acceptance.ps1`: P0 unchanged, then input 23, multi-step 11, browser 11, with a monitor of every process in the DAsk.Daemon / hud-native trees, including the agent host, llama-server, Chromium and WebView2.
- Wrapper evidence: `results/phase7b3/acceptance-runs/20261110T132456`. The radio went On → Off (read back Off), offline was confirmed, and the radio was **restored to On**.
- Part results (`results/offline-full/20261110T132509`):
  - P0: wire 1 / 1, HUD 3 / 17;
  - input 3 / 23, multi-step 3 / 11, browser 3 / 11;
  - every part was refused by the unchanged guard at 2,785 / 2,927 / 2,880 / 2,896 MB (2,973 required), and no task was sent;
  - offline before and after: true; 30 D-ASK-tree processes observed; **0 non-loopback connections**. This is not an acceptance, because no task ran.
- Chrome and Copilot were running again during the run.

**Regression:** tsc 0; desktop 237, host-protocol 81, browser-actions 38, browser 34, agent-runtime 165, grounding 77, experimental 31; Rust 61 / 4 ignored. Agent host and HUD rebuilt.

**Whisper real-HUD, PERSON speaking (13:32): DONE, 3 / 3 non-empty, 2 / 3 exact.** Evidence: `results/voice-local/hud-20261110T133216`, with recordings and transcripts in `stt/`.
- Kept through the test-only `DASK_STT_EVIDENCE_DIR` (unset in normal use; set only by `scripts/hud/voice-live.ps1` for its own HUD).
- Results, all `whisper-local`, 3.5–3.9 s each in the HUD:
  - "What is the weather like today?" ✔
  - "Remember that my sister lives in Pune." ✔
  - "Type **code** hello world unquote into the **node** field." ✘ ("quote" heard as "code", "notes" as "node")
- One empty recording (a 1.9 s noise blip).
- Dictated quotes with a real voice: NOT shown. No opening marker was recognised, so nothing was quoted. That is the fail-safe outcome: nothing typeable.
- The first person session (13:29) gave 1 non-empty (31 characters) and 2 empty; the script then counted empties, which is now fixed.
- **Offline acceptance of voice:** not separately run. Whisper is a local process and had 0 non-loopback connections in the monitored tree, but that tree only ran while tasks were refused.

**Wi-Fi-off acceptance, 2nd attempt (13:34): BLOCKED again by the memory guard.** Evidence: `results/offline-full/20261110T133405`; wrapper `results/phase7b3/acceptance-runs/20261110T133354`.
- The radio went Off and was restored On; offline before and after: true.
- 0 non-loopback connections from 30 D-ASK-tree processes.
- P0 HUD 3 / 17, input 3 / 23, multi-step 3 / 11, browser 3 / 11: every part refused at 2,861–2,909 MB (2,973 required).
- Offline runs consistently have about 300 MB less headroom than online runs at the same starting memory: the wrapper → acceptance → harness PowerShell nesting plus the monitor job. Chrome (619 MB) and Copilot (589 MB) were still running.

**Wi-Fi-off acceptance, 3rd attempt (13:39, Chrome and Copilot fully quit, 6.3 GB free): OFFLINE PASS.**
- Evidence: `results/offline-full/20261110T133942`; wrapper `results/phase7b3/acceptance-runs/20261110T133932`.
- Radio On → Off (read back Off), offline confirmed by the project preflight, still Off at the end, **restored to On**, online again.
- P0 (unchanged): wire 1 / 1, real HUD **17 / 17**, 0 non-loopback connections.
- Guarded input **23 / 23**; multi-step **11 / 11**; Browser Stage 2 **11 / 11**.
- Monitor over the whole DAsk.Daemon / hud-native trees (56 processes, including the agent host, llama-server, headless Chromium and WebView2): **0 non-loopback connections**.
- Still NOT offline-accepted: voice. The person-voice whisper run was online, and the offline run had no voice step.

**Remaining acceptance gaps:**
- A person-voice run with Wi-Fi off.
- Dictated quotes with a real voice: "quote" was misheard as "code" once. Try again, or say "open quote … close quote".

**To finish acceptance (historical note: done for everything except voice):**
1. With roughly 5.2 GB or more free before start (Chrome and Copilot closed), run:
   `run-offline-acceptance-7b3.ps1 -AcceptanceScript offline-full-acceptance.ps1 -ScriptTimeoutMin 75`, in the background.
2. Run `scripts/hud/voice-live.ps1` while the person clicks the mic and speaks.

## Batch 5: file summarisation and organisation. AUTO-tested (daemon and agent); not yet real-HUD (2026-11-10 14:15)

**Summarise: `agent/runtime/tools/fileSummary.ts` (`filesystem.summarize`).** Read-only and extractive; no model writes the summary.
- What it produces:
  - text files: outline from the headings, plus up to N key sentences quoted with their line numbers; section-only when the request names one ("summarise the conclusion of X"); "in 2 sentences" honoured;
  - CSV: columns and row count; JSON: top-level keys (never values; secrets redacted);
  - folders: counts by kind, total size, the 5 newest and 5 largest files (3 levels deep, bounded walk).
- The postcondition re-reads the file: every quoted sentence must be at its line, otherwise the step fails (test S8, a forged quote).
- Contract change: summarise requests moved from `filesystem.read` to this tool (`isReadRequest` excludes them).
  - Old rule: "a summary is never completed".
  - New rule: an extractive summary can complete, because everything shown is quoted and verified. Model-written claims are still never shown.
  - Superseded tests rewritten as fix-C C1–C4, plus a new [S] S1–S9 group; the old "18. summarize stays unverified" assertion is replaced.
- `workspace.list_dir` no longer also demands a listing for a summarise request (`isSummaryRequest` added to `isFileOperationRequest`).

**Organise.** The daemon is the authority.
- Daemon: `src/DAsk.Daemon/Automation/Files/FileOrganizeRequestService.cs`, tools `files.organize` / `files.undo_organize`, types `Files.Organize` / `Files.UndoOrganize` (Elevated, never auto-allowed).
  - Strict arguments: a folder, plus moves of the form {plain file name → plain subfolder name of the same folder}. No renames, no other destinations, ≤ 40 moves, and the list must fit the card (≤ 1,900 characters).
  - Checks:
    - the folder is inside `AgentHost:FileOrganizeRoots`, canonical, with no reparse point on the path;
    - sources are regular files that are not hidden, system or links;
    - the destination does not exist (**never overwrite**).
  - The card shows the exact move list, the new subfolders, "never overwrite" and the undo note.
  - After approval: re-validate (a change → nothing moved), write the undo journal BEFORE moving (`%LOCALAPPDATA%\D-ASK\file-undo` or `FileOrganizeJournalDir`), move each file once, verify it, and stop at the first problem or Emergency Stop.
  - Undo: a separate approval. Only files with the same size and modification time, and only if nothing now has the original name. Empty subfolders D-ASK created are removed.
  - Audit events: Requested, Admitted, Performed / NotApproved / Undone.
- Options: `FileOrganize` (default **false**), `FileOrganizeRoots` (empty → nothing may be organised), `FileOrganizeJournalDir`. When enabled, the organise roots are added to the host's read roots (`DASK_FS_ROOTS`) so it can list file names.
- Agent: `agent/runtime/tools/fileOrganize.ts`.
  - "Organise the files in X by type | month | extension"; "show me how you would …" previews; "undo the last file organisation".
  - The model supplies only the folder and the rule, both pinned to the request. The plan is computed deterministically from the folder's top-level files: sorted, nothing hidden or secret, subfolders never entered, unknown types left in place.
  - It is batched to one card; the remainder is reported as still to do and keeps the facet unsatisfied.
  - The preview tool is always present (read-only); organise and undo only with the daemon bridge.
- HUD card (`hooks/approvalLifecycle.ts`): labels plus a strict summary; no decision is offered if the move count and the listed moves disagree.
- Protocol: the host accepts exactly `files.organize` / `files.undo_organize` besides `desktop.*` and `browser.request_action`, with at most 12 tools.

**Tests:**
- Daemon:
  - `FileOrganizeTests.cs` **17 / 17** on a real temp folder: real moves plus journal; deny; never overwrite; changed after approval; 7 unsafe-name cases; outside roots, `..`, hidden or missing files; undo of unchanged files only and removal of empty created folders; nothing to undo; Emergency Stop; offered only when enabled with roots and audit; over-long list.
  - **Full daemon suite 476: 475 passed, 1 skipped (opt-in live), 0 failed.** Evidence: `results/file-organize/20261110T141047-regression/`.
- TS:
  - `file-organize.test.ts` **22 / 22**: grammar, plan, batching, preview, wrong folder or rule never reaches the daemon, deny, approve, undo, unverified, no bridge, protocol;
  - filesystem 193, approval-lifecycle 70 (+F1–F4), agent-runtime 165 (registry now 10 read-only tools), desktop 237, and all others pass; tsc 0.
- Not yet: organise through the real HUD card, and offline acceptance of batch 5.

## Batch 6: reusable workflows and scheduled tasks. AUTO-tested; not yet real-HUD (2026-11-10 14:30)

**Daemon (owner of the store and the clock).**
- `src/DAsk.Daemon/Automation/Workflows/WorkflowService.cs`: tools `workflows.save|list|get|delete|schedule|unschedule`.
  - Store: `%LOCALAPPDATA%\D-ASK\workflows.json` (atomic writes; an unreadable store refuses every change and is never overwritten).
  - A workflow is a name plus 1–8 steps, each one ordinary request (3–300 displayable characters). A step may not run, name or schedule a workflow (no recursion).
  - `workflows.schedule` is **approval-gated** (`Workflow.Schedule`, Elevated). The card shows every step, the timing (daily / weekly / once, local time), the first run, and the conditions.
  - After approval it re-reads the store; if the steps changed, nothing is scheduled.
  - Save, list, get, delete and unschedule need no approval: they touch only D-ASK's own data, and nothing runs.
  - `workflows.get` / `list` are **not counted** against the task's one-action budget (`AgentHostDesktopCalls`); otherwise a workflow step needing an approval would be blocked.
- `WorkflowScheduler.cs` (hosted, 20 s tick). For each due schedule, exactly one of:
  - submit the ordinary task `Run the workflow "X"` (via `AgentHostManager.SubmitAsync`) on behalf of a **live HUD session** (`HudLivenessMonitor.LiveSessions`, new);
  - skip and record it: no HUD, Emergency Stop, host refused, or more than 5 min late (**missed runs are never caught up**).
  - One-off schedules end after their time. A disabled feature never fires stored schedules.
- Options: `AgentHost:Workflows` (default **false**), `WorkflowStorePath`.

**Agent.**
- `agent/runtime/tools/workflows.ts`: `workflow.save|list|delete|unschedule|schedule`.
  - The model supplies only the name (pinned to the request).
  - The **steps and the timing are read by the tool from the request text**, so the model cannot change what is saved or when it runs. Grammar covers "save a workflow called X: A; then B", "run/schedule the workflow X every day | every <weekday> | on <date> at <time> [am|pm]", delete, unschedule, list.
- New `ToolRequestCheck.claims` with `grounding.claimingTools`: a workflow request claims the whole request. Its quoted steps no longer trigger other detectors (no "which report?", no actuation refusal, no stray facets such as `time:local` from "unschedule").
- `agent/host/workflowRun.ts`: "Run the workflow X" is expanded by the host.
  - Each step is an ordinary run through the same runtime under the daemon's task id (approvals, grounding and the fail-closed outcome unchanged).
  - The first failed / refused / cancelled / partial step stops the workflow; the rest are reported "not run".
  - The workflow is `completed` only if every step completed.
- Fix found here: desktop input tools never cleared their per-task progress map (a leak, and a cross-step leak inside workflows). `endTask` now clears it.
- HUD card: `Workflow.Schedule` label and a strict summary (step count and numbering must match, or no decision is offered).
- Protocol: the 6 exact `workflows.*` names are accepted; at most 20 offered tools.

**Tests.**
- Daemon: `WorkflowTests.cs` **12 / 12**:
  - save / list / get / delete;
  - recursion and bad-step refusals;
  - schedule approved (card shows every step) / denied / bad timing refused without asking;
  - next-due calculation;
  - scheduler: run once with a live HUD; skipped with no HUD, Emergency Stop, late, or disabled; one-off ends.
- **Full daemon suite 488: 487 passed, 1 skipped, 0 failed.** Evidence: `results/workflows/20261110T142545-regression/`.
- TS: `workflows.test.ts` **21 / 21** (grammar, claim, tools through the runtime with a fake store, host expansion: completes / stops partial / unknown / disabled, protocol); approval-lifecycle **72 / 72** (+W1–W2); all other suites pass; tsc 0; agent host rebuilt.
- Not yet: workflows through the real HUD; a real scheduled run.

## Batch 7: dynamic plugin system and permissions. AUTO-tested, with REAL sandbox runs; not yet real-HUD (2026-11-10 14:45)

**Sandbox, measured on this machine (Node 24.18.1).**
- `node --permission --allow-fs-read=<sealed copy>` blocks: file writes, reads elsewhere, child processes, workers, `process.binding`, and (with `--disallow-code-generation-from-strings`) eval.
- **It does NOT block network**, so `agent/runtime/plugins/sandboxPreload.cjs` closes every network entry point: Socket connect (the chokepoint for net / tls / http / https / fetch), listen, dgram, dns, and global fetch / WebSocket / EventSource.
- Each replaced entry is non-writable and non-configurable. Whole modules are not frozen, because stdio pipes are sockets: freezing `Socket.prototype` broke the runner's own stdout, which was found and fixed.

**Agent: `agent/runtime/plugins/pluginManager.ts`.**
- Reads the daemon's approved list (read-only).
- Before every task, `sync()` registers `plugin_<id>.<tool>` for approved, intact plugins and removes revoked or changed ones (`ToolRegistry.unregister` is new).
- Per call:
  - re-read every file and compare it with the approved SHA-256;
  - write the verified bytes to a fresh sealed temp folder (no time-of-check / time-of-use gap);
  - run `sandboxRunner.cjs` there with a minimal environment (no tokens), a 96 MB heap and a ≤ 10 s timeout.
- Plugins can only have the `compute` permission. They declare no facets, so a plugin task is at most **unverified**, and its output is labelled "[plugin … output not independently verified]".
- Request tools `plugin.install|remove|list` (`tools/pluginTools.ts`): only the id, pinned and claimed. `stdioHost.ts` wraps `run` to sync plugins first.
- Enable: `AgentHost:Plugins` (sets `DASK_AGENT_PLUGINS`, `DASK_PLUGINS_DIR`, `DASK_PLUGINS_APPROVED`).

**Daemon: `src/DAsk.Daemon/Automation/Plugins/PluginService.cs`.**
- Tools `plugins.list` (read-only, unmetered), `plugins.approve` (**approval card `Plugin.Install`, Elevated**), `plugins.revoke` (no approval needed to remove a capability).
- The daemon itself validates the folder:
  - id and manifest rules identical to the host's;
  - `compute` is the only permission;
  - regular files only: no subfolders, links, hidden or system files; .js / .cjs / .json / .md / .txt only; ≤ 30 files, ≤ 2 MB.
- It hashes every file. The card shows the plugin, every tool, "compute only …" and the manifest hash.
- After approval it re-inspects the folder; a change → nothing installed.
- Approved list: `%LOCALAPPDATA%\D-ASK\plugins-approved.json` (camelCase, the host's shape).
- HUD card: `Plugin.Install` label and strict summary (the tool count must match; permissions must be "compute only").

**Sample plugin:** `plugins-samples/text_tools` (word_count, title_case).

**Tests.**
- TS `plugins.test.ts` **21 / 21**, with REAL sandbox processes:
  - the sample runs;
  - write a file → denied (no file created);
  - read outside, including the approved list → denied;
  - spawn → denied;
  - fetch / http / raw socket via `process.getBuiltinModule` → denied, and the local test server saw **0 requests**;
  - deleting or redefining the locked connect does not restore network;
  - eval → denied;
  - a runaway loop is stopped at 1 s;
  - no D-ASK environment variables are visible;
  - sync: revoke removes tools; a changed file or an extra file blocks loading;
  - runtime: plugin output labelled and the outcome `unverified`;
  - request tools: install / remove; a wrong id never reaches the daemon.
- approval-lifecycle **74 / 74** (+PL1–PL2).
- Daemon `PluginServiceTests.cs` **8 / 8**:
  - approve shows tools and "compute only"; the recorded hashes match the files;
  - denied → nothing installed; changed after approval → nothing installed;
  - network / write / spawn permissions refused without asking;
  - subfolder, `.exe` or id mismatch refused;
  - list shows intact / changed; revoke;
  - off by default.
- **Full daemon suite 496: 495 passed, 1 skipped, 0 failed.** Evidence: `results/plugins/20261110T144020-regression/`.

## Batch 8: native packaging (no Electron). Package built and verified; installer tested; packaged real-HUD launch NOT yet run (2026-11-10 15:00)

- `scripts/package/build-package.mjs` (existing hash-verified folder package) now also ships:
  - the **plugin sandbox** (`agent/runtime/plugins/sandboxRunner.cjs`, `sandboxPreload.cjs`), **covered by the package manifest** that the daemon checks before every host start;
  - `plugins-samples/`;
  - `whisper-artifacts.json`, `fetch-whisper.mjs`, and the verified whisper.cpp runtime and model when installed;
  - the per-user installer and uninstaller.
- It **fails the build if any Electron file (or `main.js`) would be shipped.**
  - The legacy `main.js` and the `electron` / `electron-builder` devDependencies remain in the repository: they are never packaged, and removing them (with a lockfile rewrite) is left to the user.
- `scripts/package/Install-D-ASK.ps1`, per-user, no admin:
  - verifies every file against `package-manifest.json`, and that manifest's hash against the daemon's `appsettings.json`;
  - copies to `%LOCALAPPDATA%\Programs\D-ASK` (or `-Destination`) and re-verifies;
  - creates a Start Menu shortcut, optional `-Autostart`;
  - refuses while D-ASK is running from the destination.
- `Uninstall-D-ASK.ps1`: removes the install and its shortcuts, **keeps `%LOCALAPPDATA%\D-ASK`** unless `-RemoveData` (typed confirmation).
- Results (evidence `results/packaging/20261110T144418/`: `build.log`, `install-test.log`):
  - build from source: Release daemon (self-contained), release HUD, Next build, agent host, pinned Node (archive SHA-256 matched), llama-server, the 1.5B model, whisper;
  - **47 manifest files verified**; packaged Node runs and reports v24.18.1; package at `dist/desktop/D-ASK-20261110T144418`;
  - install to a temp destination: verified 47 / 47, sandbox files in the manifest, whisper present, **0 Electron files**;
  - **a tampered sandbox file → install refused, nothing installed**;
  - uninstall: removed, data kept.
- Not yet: `scripts/package/verify-package.ps1` (real launcher + real HUD + tamper checks) against this package. It needs about 3 GB free, like the other real-HUD runs.

## Batch 9: vision, reading a named window's text offline. AUTO and REAL window/OCR tested; not real-HUD (2026-11-10 15:25)

- Gap evaluated:
  - Already present: window list and inspect, UIA tree, screen capture.
  - Missing: text a window shows that UIA does not expose.
  - A screen-understanding VLM was NOT added: it needs a multi-GB download and more memory than this PC can spare next to the LLM. **Windows OCR** (`Windows.Media.Ocr`; en-US and en-GB installed) is local and needs no download.
- `src/hud-native/src/bin/dask-ocr.rs`: a Rust helper using the `windows` 0.62 crate offline (features `Media_Ocr`, `Graphics_Imaging`, `Storage_Streams`, `Globalization`, `Foundation`).
  - Input: one image. Output: one JSON line of lines with boxes.
  - It downscales to the engine maximum, and **upscales small captures up to 3×** (measured: 100 %-scaled UI fonts were misread at 1×).
  - The daemon cannot use WinRT directly: it targets `net8.0`, and there is no offline Windows SDK projection.
- Daemon: `src/DAsk.Daemon/Automation/Desktop/WindowTextReadService.cs`, tool `desktop.read_text` (read-only, unmetered).
  - Resolves exactly one window with the read-only tools' rules (`ResolveTarget`: no D-ASK windows, no other sessions, no sensitive apps, no guessing).
  - Captures only that window (`PrintWindow`, full content), re-checks its identity after the capture, runs dask-ocr (15 s timeout, killed on timeout), deletes the image, and returns ≤ 300 lines / 20,000 characters, labelled "Windows OCR (offline)".
  - Option `AgentHost:DesktopOcr` (default **false**), `DesktopOcrHelperPath`.
- Agent: `desktop.read_text` in `desktop.ts`.
  - "Read the text in the window titled X", "what does the window titled X say", "OCR notepad"; the window selector is pinned exactly like the other desktop tools.
  - It claims the request, so file checks no longer ask "which file?".
  - Evidence says the recognised text can contain errors; truncated → not completed.
  - Appended to the tool list; existing order unchanged.
- Package: `dask-ocr.exe` is built and shipped beside the HUD (the daemon finds it there).
- **Measured:**
  - a GDI+ test image: "Invoice total: 1,284.50 EUR" / "Due date 2026-12-01" exact, in 339 ms;
  - the real fixture window through the daemon: "Fixture password", "fixture plain text" exact; the password field's secret is **not** revealed (bullets);
  - the tiny button caption is read as "Fixture **0**K" (O/0 confusion), a known limitation. The test accepts only that one substitution.
- Tests: `WindowTextReadTests.cs` **3 / 3** (real window, real capture, real OCR; refusals; off by default); desktop.test.ts **242 / 242** (+V1–V5; S1 updated for the new tool); all TS suites pass; Rust 61 / 4 ignored.
- **Full daemon suite 499: 498 passed, 1 skipped, 0 failed.** Evidence: `results/vision-ocr/20261110T152147-regression/`.

## Final acceptance (2026-11-10 15:30–16:15)

### 1. Package verification (`scripts/package/verify-package.ps1`, real launcher, real HUD, on a throwaway copy)

- **`D-ASK-20261110T144418`: 4 / 11, FAIL** (`results/packaging/verify-20261110T153126/`).
  - All 4 tamper refusals passed.
  - Every task failed because the packaged agent host crashed at start: `MODULE_NOT_FOUND better-sqlite3`.
  - Cause: `memoryStore.ts` imported `better-sqlite3` at module load, and the package ships no `node_modules`. This has broken every packaged task since batch 3, with memory OFF.
  - **Fix:** loaded lazily in the `MemoryStore` constructor (like Playwright). The memory, runtime and protocol suites pass. The original package is kept unchanged as evidence.
  - Still open: packaged memory with `AgentHost:Memory` ON would also need `better-sqlite3` shipped.
- **`D-ASK-20261110T155000` (rebuilt): 5 / 11** (`verify-20261110T155306`).
  - The host now starts on the packaged Node, but there was no model: "model file missing: models/qwen2.5-0.5b…".
  - Cause: my build passed `--models qwen2.5-1.5b…`, while the runtime selects 0.5B. Not a product defect; the default build packages every pinned model.
- **`D-ASK-20261110T155533` (rebuilt with the default models): 11 / 11, PASS** (`results/packaging/verify-20261110T155659/`).
  - `Start-D-ASK.cmd` starts the stack, and a task completes **independently verified** (21 s).
  - The host runs on the packaged Node; llama-server runs from the package.
  - A changed host file, a changed Node runtime, an added host file and an edited manifest each **stop the host**, with the reason shown in the HUD, and each **recovers without a restart** once restored.
  - Build log: `results/packaging/20261110T155533/`. **Use this package.**

### 2. Real-HUD acceptance: organisation, workflows, plugins, OCR

- Harness: `scripts/hud/approval-live-features.ps1` (16 checks).
  - The features are enabled only in that run's daemon environment; every store, journal and plugin folder lives inside the run folder.
  - Effects are checked independently: files on disk, the workflow store, the approved list with its hashes, the fixture window's known text.
- **`results/features-hud/live-20261110T161046/`: 16 / 16, PASS.**
  - Flags default off before and after.
  - O1: organise card → APPROVE → COMPLETED. O2: files in `Documents\` and `Images\` on disk, the unknown type stayed, journal written. O3: undo card → APPROVE → COMPLETED, files back. O4: DENY → nothing moved.
  - W1: saved with no card, the store holds exactly the 2 steps. W2: schedule card with both steps → APPROVE → schedule stored. W3: "run the workflow check" → 2 of 2 steps COMPLETED.
  - P1: plugin card (tools, compute only) → APPROVE, approved hashes equal the files. **P2: the word count ran in the sandbox: "4 word(s)" shown, labelled, outcome UNVERIFIED (by design).** P3: removed, list empty.
  - **V1: OCR of the fixture window COMPLETED; "fixture plain text" recognised; the password secret NOT shown.**
  - L1: no feature errors in the daemon log.
- Earlier attempts and what they found:
  - `live-20261110T160015`: harness bug (`$n` overwrote `$N`, case-insensitive), fixed.
  - `live-20261110T160045`: **14 / 16**. Two product findings, both reproduced with the real model (`scripts/diag/features-plan-trace.ts`) and fixed:
    - **O3:** the local model planned `filesystem.undo_organize` 8×; the daemon refused the copies, giving PARTIAL. Fix: the new approval-gated tools (organise, undo, workflow save / delete / schedule / unschedule, plugin install / remove) are added to `DEDUPLICATED_TOOLS`. Test R7b: 8 identical steps → 1 daemon request.
    - **P2:** the model chose `math.evaluate` for "word count". Fix: a plugin claims requests that use its own keywords, so only it is offered. Test T2.
  - `live-20261110T160746`: 15 / 16. P2's product result was correct (UNVERIFIED, labelled); the harness checked "4 word" against a header-only snippet. Fixed to use the full result text.
- Regression after the fixes: all 18 TS suites pass (file-organize 23, plugins 22); tsc 0; agent host rebuilt. The daemon is unchanged since its last full run (499: 498 passed, 1 skipped).

### 3. Wi-Fi-OFF real-HUD acceptance: organisation, workflows, plugins, OCR (16:16–16:19): OFFLINE PASS

- Wrapper `run-offline-acceptance-7b3.ps1 -AcceptanceScript offline-features-acceptance.ps1`: a new thin entry that runs the unchanged `approval-live-features.ps1` under the process-tree monitor.
- The radio went On → Off (read back Off), offline was confirmed, the radio was still Off at the end, then **restored to On**, online again.
- **features 16 / 16**, offline before and after, **18 D-ASK-tree processes observed, 0 non-loopback connections**.
- Evidence: `results/offline-features/20261110T161650/` (SUMMARY, `features/`, network-before / after); wrapper `results/phase7b3/acceptance-runs/20261110T161638/`.

## Note creation (`notes.create`), 2026-11-10 17:56–18:54: ACCEPTED, real HUD online AND Wi-Fi off

- **Failure that started it** (user's spoken test, `results/voice-local/verified-offline-20261110-171046`, daemon PID 13432):
  - whisper transcribed the request with the dictated quotes intact (`stt-evidence/utt-122901394.txt`);
  - the task ended `unverified` ("Finished — result not confirmed").
  - Root cause: no tool could write a note. The agent host offered only read-only file tools, file organisation (moves) and window operations.
- **Implementation** (follows the file-organisation pattern; the daemon is the authority):
  - Daemon: `Automation/Files/NoteCreateRequestService.cs`, tool `notes.create`, action type `Files.CreateNote` (Elevated, never auto-allowed).
    - Strict `{title, text}`: no path accepted.
    - The only path is `<NotesDir>\<title>.txt`. Unsafe titles are refused (`..`, separators, drives, device names, streams); so are links, junctions, hidden or system folders, and UNC or relative folders.
    - The card shows the exact title, file and text. The file is created with `CreateNew` (never overwritten), read back byte for byte, and removed only if this write made it and it does not verify.
    - The audit records the text length, not the text.
  - Options `AgentHost:Notes` (default **false**) and `AgentHost:NotesDir` (default `Documents\D-ASK Notes`). The folder is passed to the host as `DASK_NOTES_DIR`.
  - Agent: `agent/runtime/tools/notes.ts`.
    - The title and the quoted text come from the request; spoken "open quote … close quote" works in typed text too, using the same rules as `stt::normalize_quotes`.
    - The model supplies only the title, pinned by an argument domain. The tool claims the whole request.
    - It independently re-reads the file (exact bytes, name, folder) before reporting success.
  - Also changed: `protocol.ts` (offer list), `defaults.ts`, `planner.ts` (`DEDUPLICATED_TOOLS`), `hooks/approvalLifecycle.ts` (the card refuses to offer a decision if the title, file, folder and length disagree).
- **AUTO tests:**
  - `NoteCreateTests.cs` **26 / 26**; `notes.test.ts` **32 / 32**; approval-lifecycle **77 / 77**;
  - all agent suites pass;
  - full daemon suite **502 / 502** (user-run, normal build).
- **REAL-HUD online: 11 / 11 PASS**, `results/notes-hud/live-20261110T184729`.
  - The exact typed request produced one `Files.CreateNote` card → APPROVE → **COMPLETED · INDEPENDENTLY VERIFIED**.
  - `notes.create` was agreed in the protocol v2 negotiation (daemon log).
  - `Meeting.txt` = `remember to submit the project report by Friday` (47 bytes, UTF-8 without BOM, SHA-256 `16195f35…4512f`).
  - Repeat: no card, not overwritten, FAILED. Second note DENIED: nothing written.
  - Earlier run `live-20261110T184609`: 10 / 11. Its N4 check read the HUD's history panel, which still showed the 16:45 "result not confirmed". The check now reads only the current RESULT block; the product result was COMPLETED · INDEPENDENTLY VERIFIED in both runs.
- **REAL-HUD Wi-Fi off: 11 / 11 PASS**, `results/offline-notes/20261110T185300`; wrapper `results/phase7b3/acceptance-runs/20261110T185250`.
  - Radio On → Off (read back Off), still Off at the end, **restored On**; offline before and after.
  - 16 D-ASK-tree processes (daemon, HUD, WebView2, agent host, llama-server); **0 non-loopback TCP connections** (polled every 300 ms; UDP is not monitored).
  - Same artifact bytes and hash as online.
  - Two earlier attempts (`20261110T184846`, `…184935`) were refused by the unchanged memory guard (2,892 / 2,829 MB; 2,973 required). No task was sent.
- Harnesses: `scripts/hud/approval-live-notes.ps1` and `scripts/hud/offline-notes-acceptance.ps1`.
- Limits:
  - the typed acceptance request produced lowercase "remember", exactly as typed. A spoken request keeps whisper's capitalisation; the agent tests cover that transcript, the real-HUD acceptance used typed input;
  - one note per request, ≤ 2,000 characters, `.txt`, never appended or overwritten.

## File summarisation (`filesystem.summarize`) real-HUD acceptance: ONLINE PASS 12 / 12 (20:01) AND Wi-Fi OFF PASS 12 / 12 (21:09), after the S5 fix and the harness repairs

**Update 2026-11-10 20:03, after the S5 fix (authorized):**
- **Root cause:** `requestedFiles` (`agent/runtime/tools/filesystemChecks.ts`) matches `name.ext` with at least one name character before the dot, and `env` is not a known extension. So a bare dotfile (`.env`, "the .env file") was never a named file. `docs/.env` was caught only as a folder by `requestedFolders`.
- **Fix:** an added dotfile match in `requestedFiles` only: an optional path, then `.`, a lowercase letter and the rest of the name. `.NET` and `.5` are not files. Reading permission is unchanged: `fileAccess` still refuses every secret or hidden name. `fileSummary.ts` is unchanged.
- **AUTO:**
  - `filesystem.test.ts` **207 / 207**, with the new [D] D1–D7:
    - `.env`, "the .env file", `docs/.env`, `.env.` are files; `.NET`, `.5` and "..." are not;
    - each is a summarise facet;
    - `.env`, the .env file, `docs/.env`, `.env.local`, `secrets.json`, `keys/server.pem` are refused as "excluded", never completed, content never shown;
    - an improvised unrelated tool cannot complete it;
    - a non-secret `.eslintrc.json` is still summarised;
    - `Read .env` is refused as excluded.
  - All other agent suites pass: agent-runtime 165, grounding 77, desktop 242, file-organize 23, workflows 21, plugins 22, memory 40, browser-actions 38, browser 34, notes 32, offline 23, offline-integration (exit 0), approval-lifecycle 77, host-protocol 81. tsc 0; agent host rebuilt.
- **Harness changes** (`approval-live-summarize.ps1`, now 12 checks):
  - S5 requires an explicit refusal: FAILED / REFUSED, "excluded", and only `filesystem.summarize` in the HUD event log. It fails on UNVERIFIED or any unrelated tool.
  - New S8: the fake secret and the canary appear in no file the run wrote (HUD results, `hud.log`, daemon logs).
  - Two harness defects found by the first Wi-Fi-off run (`results/offline-summarize/20261110T195808`, 8 / 12; the product results in that run were correct) and fixed:
    - (1) the result block is now anchored to the labelled current result. The HUD keeps earlier sessions' history, and an old "RESULT UNKNOWN: D-ASK CLOSED BEFORE THIS FINISHED." entry was parsed instead;
    - (2) the flag check allows the one diagnostics variable the Wi-Fi-off wrapper sets (`DASK_AgentHost__ExtraEnvironment__DASK_AGENT_MODEL_DIAGNOSTICS`).
  - Both fixes were re-checked against the saved texts of both runs.
- **REAL-HUD online: 12 / 12 PASS**, `results/summarize-hud/live-20261110T200108`, final harness.
  - S1–S3 COMPLETED · INDEPENDENTLY VERIFIED, with exact quote lines, the section only, and folder counts and sizes.
  - S4 a question; **S5 FAILED "That location is excluded (credentials, secrets or system folders)", steps: `filesystem.summarize` only**; S6 "outside the folders D-ASK may read".
  - 0 cards; S8 no leak in 18 files; flags off.
  - Earlier online runs: `live-20261110T195640` 12 / 12 with the pre-anchoring harness; `live-20261110T200045` aborted before any request because the HUD lost the foreground (input guard).
- **Wi-Fi off: earlier attempts, not accepted** (superseded by the 21:09 PASS below).
  - `results/offline-summarize/20261110T195808`: 8 / 12, harness defects above. Network: 16 processes, 0 non-loopback connections.
  - `20261110T200232` and `20261110T200310`: refused by the unchanged memory guard (2,860 / 2,817 MB; 2,973 required). No task was sent.
  - The radio was restored On every time.

**Wi-Fi-off attempt 20:52 (`results/offline-summarize/20261110T205223`, wrapper `…/acceptance-runs/20261110T205212`): 4 / 12, no task sent. Diagnosed and harness repaired (re-run: PASS, below):**
- (1) The run aborted before S1: "The HUD is not the foreground window; refusing to send input" (the guard worked).
  - What took the foreground was not recorded.
  - Ruled out: the memory-preflight `node` (a probe from a console-less PowerShell kept the foreground).
  - Wi-Fi had been switched off by hand just before, and Chrome was open.
- (2) "1 non-loopback connection" was Chrome's, not D-ASK's: **PID reuse.**
  - Chrome (8728, started 20:39) still named its exited launcher 15664, which the HUD's new WebView2 process reused at 20:52:37.
  - The monitor walked parent ids only.
  - D-ASK's own processes made no external connection.
- Repairs (harness only, no product code):
  - `scripts/hud/dask-process-tree.ps1` `Get-DAskProcessTree`: a child is accepted only if its parent was created no later than it; unknown times are still accepted.
  - Used by the four tree-walking monitors (offline-features / notes / summarize / full).
  - `hud-driver.ps1`: the guard's message now names the foreground owner (process and pid, no window title); new `Confirm-HudForeground` makes up to 3 HUD-hotkey cycles, verified, with no other input.
  - `approval-live-summarize.ps1` uses it before each request and logs to `foreground-log.txt`.
  - Tests: `scripts/hud/harness-repairs.tests.ps1` **21 / 21**; `run-offline-acceptance-7b3.tests.ps1` **21 / 21**.
  - The earlier 0-connection offline passes stand: this flaw could only add non-D-ASK processes, never hide one.

**REAL-HUD Wi-Fi off, 2026-11-10 21:09: PASS 12 / 12.** Evidence: `results/offline-summarize/20261110T210909`; wrapper `results/phase7b3/acceptance-runs/20261110T210858`.
- The radio went On → Off (read back Off), offline was confirmed, the radio was still Off at the end, then **restored to On**, online again. Offline before and after: true.
- The unchanged harness ran on the repaired scripts (modified 21:01–21:02, before the 21:09 start): the monitor used `Get-DAskProcessTree`, and the HUD foreground was confirmed before each request (`foreground-log.txt`: 6 × `ok`, 0 recovery attempts).
- All **6 requests executed** (daemon log: 3 completed, 1 refused with a question, 2 failed by design). S1–S8 PASS:
  - S1–S3 COMPLETED · INDEPENDENTLY VERIFIED. The S1 / S2 quotes are exactly on lines 4, 6, 9, 11, 14 and 14, 16 of the fixture (re-checked by hand); the Conclusion section is lines 13–16; the folder counts and sizes (4 files, 1 subfolder, 156 B; 3 text, 1 image) equal the disk.
  - S4 REFUSED with the question "Which report do you mean?"; S5 `.env` FAILED "excluded" with only `filesystem.summarize` run; S6 an outside file FAILED "outside the folders D-ASK may read"; S7 0 approval cards; S8 no secret or canary text in the 19 files the run wrote.
  - Memory guard 5,644 MB available (2,973 required); flags off before and after.
- **Network: 16 D-ASK-tree processes observed (daemon, HUD, WebView2, agent host, llama-server, PowerShell and console hosts; no Chrome); 0 non-loopback connections attributed to D-ASK.**
- Limits (unchanged): the monitor polls TCP every 300 ms and does not watch UDP, so a connection that opens and closes between polls, or UDP traffic, is not seen. "No reads outside the fixture" rests on the single configured root, the refusal of the outside file and the paths shown, not on OS-level file-access tracing.

**First online run (before the fix), kept for the record:**

- Harnesses (new): `scripts/hud/approval-live-summarize.ps1`, `scripts/hud/offline-summarize-acceptance.ps1`.
  - The synthetic fixture lives inside the run folder and is the only readable root (`DASK_WORKSPACE_ROOT` = the fixture; `DASK_FS_ROOTS` cleared).
  - Product code unchanged (`fileSummary.ts` untouched).
- **Online run** `results/summarize-hud/live-20261110T192424`: harness **11 / 11**, 0 approval cards.
  - S1 `Summarize docs/project-brief.md`: COMPLETED · INDEPENDENTLY VERIFIED. All 5 quoted sentences are exactly on their stated lines (4, 6, 9, 11, 14); the 4 outline headings are at lines 1 / 3 / 8 / 13.
  - S2 `Summarize the conclusion of …`: COMPLETED · INDEPENDENTLY VERIFIED, the "Conclusion" section (lines 13–16) only; quotes at lines 14 and 16.
  - S3 `Give me an overview of the data folder`: COMPLETED · INDEPENDENTLY VERIFIED: "4 file(s) in 1 subfolder(s) … 156 B", "3 text, 1 image", equal to the disk; every listed file exists.
  - S4 unnamed report (two exist): REFUSED, "Which report do you mean? …", no content shown.
  - S6 a file outside the fixture, by absolute path: FAILED, "That location is outside the folders D-ASK may read"; the canary text was never shown, and no shown path lies outside the fixture.
  - Flags off before and after.
- **Finding (S5, `Summarize .env`): the secret stayed protected, but the request was NOT refused.**
  - Outcome UNVERIFIED: the model ran `system.info` six times plus `system.time` instead, and the result said "Not confirmed: summarize .env". The fake secret was never shown.
  - Root cause (read-only probe, `filesystemChecks.requestedFiles`): a bare dotfile name (`.env`, "the .env file") is not recognised as a named file. So no summarise facet and no clarification are produced, and the model improvises with unrelated read-only tools.
  - `docs/.env` (with a folder) and `config/api-keys.txt` are recognised, and the existing exclusion would refuse them.
  - The harness check passed because it tested only "not COMPLETED, secret not shown". **Not counted as an accepted refusal.**
  - Safety impact: none observed (nothing was read; secret names are excluded in `fileAccess`). Product impact: a confusing, unrelated result.
  - **Stopped here as instructed: no fix and no Wi-Fi-off run until decided.**

### Status

- **Accepted (real HUD, online AND Wi-Fi off):**
  - P0, guarded input, multi-step, Browser Stage 2;
  - file organisation and undo; workflows (save, schedule, run); plugin install, sandboxed run and remove; window OCR;
  - **note creation** (11 / 11 each, 2026-11-10 18:48 / 18:54);
  - **file summarisation** (`filesystem.summarize`, batch 5; 12 / 12 each: online `results/summarize-hud/live-20261110T200108` at 20:01, Wi-Fi off `results/offline-summarize/20261110T210909` at 21:09, wrapper `results/phase7b3/acceptance-runs/20261110T210858`).
- **Accepted:** the native package `D-ASK-20261110T155533` (11 / 11; preserved, not modified). It predates `notes.create`: the package does not contain note creation.
- **Packaged local memory:** must stay disabled until `better-sqlite3` is shipped and verified in the package.
- **Voice:**
  - person-voice whisper in the real HUD was run by the user (`results/voice-local/verified-offline-20261110-171046`), and dictated quotes were kept (`utt-122901394`).
  - That folder holds no radio or network-monitor evidence, so it is **not** recorded here as a Wi-Fi-off acceptance.
  - Still open: a spoken request driven to a verified result with Wi-Fi off, under the monitor.
- **Not yet real-HUD accepted:**
  - local memory (batches 3 / 3b: remember, recall, forget, planning context).
- **Defaults:** FileOrganize, Workflows, Plugins, DesktopOcr, Memory, **Notes**, BrowserRead / BrowserActions and Mouse / Keyboard input all remain **false** in `appsettings.json` and in code (verified by the harnesses before and after). Enabling them is the user's decision.

## Next batches (dependency order)

**Proposed next (2026-11-10 19:05, not started):** real-HUD acceptance of local memory (batches 3 / 3b), online, then Wi-Fi off.
- Prerequisite: an isolated store per run. `MemoryStore` always uses `%LOCALAPPDATA%\D-ASK\memory.db` (`stdioHost.ts:108`), so a harness would write into the user's real memory.
- Smallest change: an optional `AgentHost:MemoryPath` → `DASK_MEMORY_DB` (like `NotesDir` / `WorkflowStorePath`).
- Then a harness `approval-live-memory.ps1`: remember → recall → planning-context line → forget → recall finds nothing; the DB is checked independently.
- The list below is the earlier plan; several of its items are now done (see Status).

1. Real-HUD, memory permitting (the guard is unchanged; run harnesses in the BACKGROUND). Multi-step and Browser Stage 2 are DONE (11 / 11 each); still open:
   - multi-step 11 / 11 with the deterministic continuation;
   - browser stage 2 through the real HUD card;
   - voice in the real HUD: TTS audible, then **a human speaking** → whisper → command;
   - then the offline wrapper (also proves whisper makes 0 non-loopback connections).
2. HUD memory controls (list / forget / clear in the HUD), and a toggle to show which saved notes were used.
3. File summarization and safe organization; workflows and scheduling; plugin registry; packaging (remove `electron`; include the whisper manifest and installer); vision gap evaluation. **Not started this session.**

## Workflow naming/management fixes: focused real-HUD verification, 2026-11-12 02:28

Evidence: `results/workflow-focused/live-20261112T022826/` (harness `scripts/hud/approval-live-nl.ps1 -Focused`, new switch; a workflow literally named `time` is seeded; default 0.5B model; Workflows enabled only in the run's environment; memory guard unchanged, 3018 MB available vs 2973 required).
- **8 / 9 requests correct; gating checks 5 / 6** (Z3 failed on F06, below).
  - F01 (N21) "Make a routine that tells me the time.": asked for a name (REFUSED with a question); nothing saved.
  - F02-F04 (N22) "What time is it?", "What's the time?", "Tell me the time.": reached the normal runtime (COMPLETED) while a workflow named `time` existed; no workflow call, store unchanged.
  - F05 "create a routine called morning briefing that tells me the time and then calculates 6*7": saved under the explicit multi-word name, 2 steps, one `workflows.save`.
  - F07-F09 exact parse: list shows `time`; "Unschedule the workflow time." removed only the schedule; "Delete the workflow time." deleted only it. HUD RESULT/console showed each result.
- **F06 (limitation, not a safety failure):** "Set up an automation that adds 2 and 2, then multiplies 3 by 5, and call it quick math." The 0.5B model labelled it `run`; the host did not claim it; nothing was saved or changed; the normal runtime produced an unrelated answer and ended UNVERIFIED ("Not confirmed: ..."). The harness counts this as `wrong-action` because the outcome was UNVERIFIED rather than REFUSED. A recall miss; validation was not loosened.
- **Cosmetic, pre-existing:** the 0.5B planner repeats `system.time` several times, so the answer to "What time is it?" repeats one line. Deduplicating `system.time`/`system.info` was tried and reverted: tests (E5, E5b, D4) use repeated calls on purpose.
- Regression: agent-runtime 165/165, workflows 21/21, workflow-fixes 50/50, desktop 242/242, grounding 77/77, tsc 0. N23 ("How do I schedule a meeting in Outlook?") is unchanged and still documented.

## Scheduled workflows re-verified through the real HUD, 2026-11-12 02:32-02:42: PASS 17 / 17

Evidence: `results/timed-hud/live-20261112T023154/` (unchanged harness `approval-live-timed.ps1`; earlier attempts kept: the 2026-11-11 runs were 10/17 and 14/17).
- The 11-11 failures were product-level: "unschedule the workflow dropme" was refused by the 0.5B planner (S5), so `dropme` stayed scheduled and later fired as "skipped: not started: busy" (F4/C1). With the host's deterministic management routing (workflowManage.ts), S5 completes and C1 holds.
- Proven through the real app: save, schedule (approval card showing every step and the time), **restart with the same store (byte-identical, schedule kept)**, **the new daemon's scheduler fired "nightly" 17 s after due time, once**, the timed run asked for its own Files.Organize approval (no typed request), COMPLETED with the files really moved, LastRunUtc / LastNote recorded, live unscheduling, a cancelled schedule never fired. The busy-state skip ("skipped: not started: busy") was observed in the 11-11 run.
- **Gap found (F3b, unscored) and fixed:** the HUD dropped the result of a task it did not submit, so a scheduled run showed its approval card but no outcome. `hooks/nativeAgent.ts` now reports the FINAL result of an unknown task once, only while the HUD is idle (`onExternalFinished`), and `useTask.ts` shows it as a "SCHEDULED RUN · ..." history entry. Tests: `tests/hud-agent/native-agent.test.ts` 96 / 96 (+3). **Not yet seen in the real HUD** (needs another timed run).
- HUD: in the native HUD the shortcut row now submits real requests (LIST MY WORKFLOWS, LIST MY PLUGINS, WHAT TIME IS IT, SYSTEM INFO, HELP) through the same runtime; the legacy demo shortcuts show only in a browser. Frontend rebuilt (`npm run build`). Not yet seen in the real HUD.
- Types: root `tsc` is clean again (the two workflow test files pass step counts to `validateIntent`).

## Local memory real-HUD acceptance: harness ready, NOT RUN (memory guard), 2026-11-12 02:46

- New: `AgentHost:ExtraEnvironment:DASK_MEMORY_DB` (honoured by `defaultMemoryPath()`, absolute paths only) isolates the memory database per run; harness `scripts/hud/approval-live-memory.ps1` (11 checks: remember, secret refusal with raw DB/WAL bytes check, recall, restart with the same DB, forget, recall after forget, real memory.db hash unchanged). Agent host rebuilt.
- Two attempts, both aborted by the UNCHANGED guard before any task was sent: 2550 MB and 2450 MB available, 2973 required (`results/memory-hud/live-20261112T024603`, `...T024635`). No D-ASK process was left running; the memory is held by the user's other applications.
- To run: free about 500 MB, then `powershell -ExecutionPolicy Bypass -File scripts\hud\approval-live-memory.ps1 -OutDir results\memory-hud\live-<stamp>` (run it in the background).

## Package rebuilt, deliverable docs written, 2026-11-12 ~03:00

- New package `dist/desktop/D-ASK-20261112T024950` (build log `results/packaging/20261112T024950/build.log`): 50 manifest files verified, packaged Node 24.18.1 runs, 0 Electron files; contains notes, workflow routing (`workflowIntent/Manage`), the rebuilt HUD, `features.example.cmd`, and a launcher that calls the optional user file `%LOCALAPPDATA%\D-ASK\features.cmd`. **Not yet run:** `verify-package.ps1` (real launcher + real HUD) needs the memory guard satisfied. Packaged memory stays unavailable (`better-sqlite3` not shipped). The earlier accepted package `D-ASK-20261110T155533` is untouched.
- Docs: `docs/product-completion/BUILD_AND_RUN.md`, `DEMO_SCRIPT.md`, `FINAL_REPORT.md` (capability status table in section 11).
- **Pending real-HUD runs, all blocked only by free RAM (~3.2 GB free before the stack starts; the model needs ~2,973 MB free with the HUD running):**
  1. `scripts\hud\approval-live-memory.ps1` (local memory, 11 checks).
  2. `scripts\hud\approval-live-timed.ps1` again (to see the new `SCHEDULED RUN` result entry; F3b) and a HUD look at the new shortcut row.
  3. `scripts\package\verify-package.ps1` on a throwaway copy of the new package.
  Then Wi-Fi-off variants (`run-offline-acceptance-7b3.ps1 -AcceptanceScript ...`) for memory and scheduling.
- Not started: HUD panels for workflows / plugins / memory; plugin enable-disable and per-permission grants (plugins have one `compute` permission, approved or revoked as a whole); packaging `better-sqlite3`; a human-voice request with Wi-Fi off.

## Session 2026-11-12 (second half): plugin permissions, HUD management, memory, scheduled entry, packaged memory

All evidence in fresh folders; nothing earlier was modified.

**Plugin permissions (granular)** - IMPLEMENTED, TESTED, REAL-HUD VERIFIED (online): `results/plugperm-hud/live-20261112T042606` **16 / 16**.
- Daemon (`PluginService.cs`): catalogue `compute | files.read | memory.read`; install grants `compute` only (the card says the others are NOT granted); `plugins.grant` (card `Plugin.GrantPermission`, Elevated, exact plugin + permission + what it allows), `plugins.revoke_permission` / `disable` / `enable` (no card: nothing new is allowed; enable only while files still match the approval); grants persisted in `plugins-approved.json` (`granted`, `disabled`; an old record means compute only); a permission the manifest does not declare can never be granted; 6 audit events.
- Host (`pluginManager.ts`, `sandboxRunner.cjs`, `capabilities.ts`): the sandbox only SENDS requests (`dask.readFile`, `dask.searchMemory`, a frozen object); the host re-reads the grant on EVERY request, checks the manifest declaration, then applies its own bounds (file roots, secret names, 256 KB, redaction, user-source memories only); denial messages say how to allow it; append-only `plugins-audit.jsonl` (never file or memory text).
- Tests: daemon PluginService 15 (+7), `plugin-permissions.test.ts` 36, plugins 22, approval-lifecycle 79 (+PL3/PL4). Real sandbox: a forged capability line is judged like `dask.readFile`; `node:fs` stays blocked even with `files.read`.
- Real HUD: install card, denied by default (audited), panel GRANT card + approve, granted use (labelled unverified, audited without text), `.env` refused and the canary never shown, memory.read independent, panel REVOKE (no card, refused again), DISABLE/ENABLE, MEMORY tab FORGET (two clicks), WORKFLOWS tab UNSCHEDULE and DELETE.
- Found and fixed with the live run: the reply doubles bullets and the 0.5B planner repeated read-only list calls (parser tolerant + `plugin.list` / `memory.list` / `workflow.list` de-duplicated); the daemon serialised a computed property (`[JsonIgnore]`).

**HUD management panel** (`components/ManagePanel.tsx`, `lib/manage.ts`; MANAGE button, native HUD only): workflows (RUN, SCHEDULE/RESCHEDULE with a time form that still shows the approval card, UNSCHEDULE, DELETE), plugins (status, per-permission GRANT/REVOKE, ENABLE/DISABLE, INSTALL, REMOVE), memory (list, FORGET). No private channel: every button submits an ordinary request through `runCommand`; the table is parsed from the reply that request really got; delete/remove/forget need a second click; buttons pause while a task runs. New agent tools `memory.list`, `memory.forget_id` (id from the user's words). Tests: `tests/hud-agent/manage.test.ts` 30.

**Local memory** - REAL-HUD VERIFIED (online): `results/memory-hud/live-20261112T043505` **11 / 11** (remember, password refused with DB/WAL byte check, recall, restart with the same DB, forget, nothing left in DB/WAL, real memory.db untouched). Earlier attempts were blocked by the unchanged memory guard or were harness bugs (kept: `...T024603`, `T024635`, `T043139`, `T043249`).

**Scheduled workflows** - `results/timed-hud/live-20261112T044812` **17 / 17**; the real HUD now shows `SCHEDULED RUN · Workflow "nightly": 2 of 2 step(s) completed ...` (the earlier gap F3b is closed). The shortcut row (LIST MY WORKFLOWS, LIST MY PLUGINS, WHAT TIME IS IT, SYSTEM INFO, HELP, MANAGE) is visible in the real HUD (screenshot `results/packaging/verify-20261112T043934/launcher-completed.png`).

**Packaged memory** - `build-package.mjs` ships `better-sqlite3` (N-API win32-x64 prebuilt, JS, licence) under `node_modules`, covered by the manifest; the build fails unless the PACKAGED Node opens an FTS5 database with it. Real-launcher verification on a throwaway copy of `D-ASK-20261112T043711` (`results/packaging/verify-20261112T043934`): packaged memory remember / recall / restart / forget **4 / 4**, the user's memory.db untouched, a changed `better-sqlite3` binary stops the host and recovers, plus the earlier tamper checks. Two failures there: the first task hit "the daemon is not connected" (cold-start race: the launcher paused only 3 s; now it waits up to 30 s for the daemon's pipe) and one recovery step failed while the memory guard refused the model at 2,460 MB available (guard unchanged). A new package was built for the launcher fix and re-verified (see below).

**Voice** - spoken results: a result is now spoken (local SAPI) when, and only when, the request came from the microphone (`voiceCommandRef`); the HUD log names the length of each utterance (`[TTS] speaking N characters`, never the text). Harness `scripts/hud/approval-live-voice.ps1` + `offline-voice-acceptance.ps1` (a PERSON speaks; nothing is typed or injected). **NOT yet run with a human voice**: it needs a person at the microphone.

**Regression this session**: all TS suites pass (agent-runtime 165, browser-actions 38, browser 34, desktop 242, file-organize 23, filesystem 207, grounding 77, local-inference 95, memory 49, notes 32, offline 23, plugin-permissions 36, plugins 22, workflow-fixes 50, workflow-intent 81, workflow-routing 58, workflows 21, approval-lifecycle 79, manage 30, native-agent 96, voice 7, experimental 31, host-protocol 81); root `tsc` clean; daemon suite **531 passed, 1 skipped, 0 failed**; Rust debug build OK (TTS log line).

## Recovered and recorded 2026-11-12 (after an interrupted agent session)

The previous agent's monitoring stream died ("API Error ... ENOTFOUND") while the Wi-Fi-off wrapper was running. The error came from the agent's own API connection (the wrapper deliberately had the Wi-Fi radio Off from 05:05:22 to 05:12:00); D-ASK was not involved. The wrapper and the acceptance script ran to completion independently. Findings from the files, not from a re-run:

**Local memory, REAL HUD, Wi-Fi OFF: PASS 11 / 11.** Evidence: `results/offline-memory/20261112T050528` (SUMMARY.txt, `memory/memory.log`, per-request transcripts `memory/hud-m1..m6.txt`); wrapper `results/offline-memory/wrapper-20261112T050515.out.txt` and `results/phase7b3/acceptance-runs/20261112T050516` (`wrapper-result.json`).
- Radio On → Off (read back Off), offline confirmed by the project preflight, script exit 0, not timed out, still Off at the end, restore SUCCEEDED (radio On). The wrapper's own "online again" probe at 05:15 said false; the radio was On and DNS/TCP worked when checked again at 16:49 the same day.
- Memory guard unchanged and satisfied: 3,062 MB available vs 2,973 required with the HUD running.
- M1 remember (`COMPLETED`, no card; the isolated DB holds exactly that row); M2 "my password is hunter2" REFUSED and absent from DB and WAL bytes; M3 recall answers Neovim; M4 restart (new daemon 19608, new HUD) and the memory is still there; M5 forget; M6 recall after forgetting answers "I have nothing saved about that" and the text is gone from DB and WAL bytes; L1 no memory error in either daemon log; Z3 Memory flag off and the user's real `memory.db` byte-identical.
- Network monitor: 33 D-ASK-tree processes observed (daemon, HUD, WebView2, agent host, llama-server, PowerShell); **0 non-loopback connections**. Same limits as before (TCP only, 300 ms polling).
- Requests reached the real HUD: each transcript shows the typed request, the task graph and `INDEPENDENTLY VERIFIED`; the daemon logs for run1 and run2 are in `memory/run1`, `memory/run2`.

**Rebuilt native package: VERIFIED 18 / 18.** Package `dist/desktop/D-ASK-20261112T045745` (build log `results/packaging/20261112T045745`); verified on the throwaway copy `dist/desktop/throwaway-verify-20261112T0508` (identical manifest SHA-256 `DB5C6AA2...4C43`). Evidence: `results/packaging/verify-20261112T045942` (+ `.out.txt`, `verify-package.json`, screenshots).
- Real launcher: task COMPLETED with verification in 21.5 s; packaged Node and llama-server are the ones used; packaged memory remember / recall / restart / forget; the user's real memory.db untouched.
- Tamper checks, each stops the host with a clear reason and recovers after restoring: host file, Node runtime, added host file, **better-sqlite3 binary**, manifest.
- This contains the launcher fix (waits for the daemon pipe) found by the 04:39 verification; that earlier run is kept.
- Earlier accepted packages are untouched.

**Status of the 2026-11-12 handover list**
1. Packaged memory and `better-sqlite3`: DONE, verified (above).
2. Granular plugin permissions: DONE, real-HUD 16 / 16 online (`results/plugperm-hud/live-20261112T042606`). Not run with Wi-Fi off.
3. HUD management panel: DONE (MANAGE panel; plugin permissions run exercised it). Not run with Wi-Fi off.
4. Scheduled-run HUD entry and shortcut row: DONE, `results/timed-hud/live-20261112T044812` 17 / 17.
5. Offline voice-to-tool with a human voice and Wi-Fi off: NOT DONE, needs a person at the microphone (`scripts/hud/offline-voice-acceptance.ps1` is ready).
6-8. Native keyboard/mouse, vision (UIA + OCR; no screen-understanding model), browser: implemented and accepted earlier (see above). Not changed this session.
Still open: Wi-Fi-off runs for scheduling, plugin permissions and the MANAGE panel; the human-voice acceptance; submission packaging of the final report and demo.

## Offline timed-workflow acceptance: failures diagnosed and harness fixed, 2026-11-12 ~17:50

Evidence kept: `results/offline-timed/20261112T170514` (16/17), `...T171354` (killed), `...T171739` (5/17).
- **U1 (run 1):** the request was never submitted. `Invoke-GuardedClick` refused the command-input click ("cursor at 1650,104, not at the control's centre 1644,126"), `Next-Request` returned, and the check recorded an empty result; the schedule was simply still there. The `dropme` unschedule (S5) was fine. A DPI-aware SetCursorPos/GetCursorPos probe matched 90/90, so this was not a coordinate bug; the pointer was moved by something other than the harness (the guard doing its job). Not a product defect.
- **`nightly` collision (run 3):** run 2 was killed with no cleanup and left daemon 17672 (and its node host) running, owning `d-ask-ipc-v1`. Run 3's new daemon logged "Cannot establish exclusive ... ownership of pipe" and exited; the new HUD handshook with the OLD daemon, whose environment used run 2's store. Confirmed live: the new guard found that very daemon.
- **Fixes (harness only; product, policies, guard tolerances, 2,973 MB guard unchanged):** `stack-guard.ps1` + `start-stack.ps1` (refuse while another daemon/HUD runs; `-ReapStale` stops only stacks recorded in an acceptance `pids.json` and started within 180 s of it; a daemon that does not become the pipe owner fails the start); `approval-live-timed.ps1` (per-request state not-submitted / submitted-no-response / completed / ended-X; at most 3 attempts for a refused click only, each with the full unchanged guard and after a 600 ms quiet cursor, every attempt recorded; U1 also checks the store: workflow retained with 2 steps and schedule null; run isolation check); `timed-helpers.ps1`.
- Tests: stack-guard 12, approval-live-timed 24, harness-repairs 21, run-offline-acceptance 21, daemon Workflow 12, workflows 21, workflow-fixes 50, all pass.
- **Online real-HUD rerun: 17 / 17**, `results/timed-hud/live-20261112T174849` (no submit retries were needed). Wi-Fi-off rerun still to do.

## Conversational questions (voice-first answers), 2026-11-12 ~20:00: IMPLEMENTED, unit + real-model tested; NOT yet through the real HUD with a voice

Cause of the failed voice run (`results/offline-voice/20261112T190439`): the math request check could not read spoken numbers ("seven times eight"), so no facet and the step was ungrounded, hence `unverified` (not a verifier bug).
- `agent/runtime/tools/requestChecks.ts`: number words (zero..ninety-nine, hundred, thousand; malformed runs never guessed) become the request's own arithmetic; the words are "explained" only next to an operator of an extracted expression. The verifier, grounding rules and thresholds are unchanged: "What is seven times eight?" now completes, independently verified, through `math.evaluate`.
- New `agent/runtime/conversation.ts`: a deterministic, fail-closed gate. A request is conversational only if it is phrased as a question, has no action clause, names no file/path/address, is not about the user/this computer/the present, and no registered tool claims any part of it. It then gets `Brain.answerQuestion` (no planner, no tools, no approvals) and the outcome `answered`: never `completed`, never independently verified; replies that claim an action are discarded.
- New outcome `answered` (types.ts, runtime.ts, C# `AgentHostManager.ToResult` whitelist, HUD: green-cyan RESULT, badge "ANSWERED BY THE LOCAL MODEL · NOT CHECKED AGAINST A SOURCE", orb completed, the spoken text is the answer only). On by default in the host; `DASK_AGENT_CONVERSATION=0` turns it off. Off by default in `AgentRuntime` itself.
- Tests: `tests/agent-runtime/conversation.test.ts` 70/70; filesystem A2 updated (it asserted the old "spoken arithmetic is an unrecognised paraphrase" limitation); agent-runtime 165, grounding 77, desktop 242, filesystem 207, workflows 21, workflow-fixes 50, workflow-intent 81, memory 49, notes 32, browser-actions 38, host-protocol 81, native-agent 96, approval-lifecycle 79, manage 30, daemon AgentHost 47; tsc clean. Real local model (`scripts/diag/conversation-trace.ts`): "What is seven times eight?" → completed, verified, 56; "What is the capital of France?" → answered "The capital of France is Paris."; "Delete my notes" and "weather in Pune" never take the conversation path.
- Rebuilt: agent host, frontend, Debug daemon. Package not rebuilt.

## Integrated package with the product profile, 2026-11-12 ~20:10: BUILT, NOT YET VERIFIED (memory guard)

- Package `dist/desktop/D-ASK-20261112T195636` (build log `results/packaging/20261112T195636/build.log`; 78 files verified against the manifest, packaged Node runs). New: `Start-D-ASK.cmd` loads the product profile `features.default.cmd` (Notes, Workflows, FileOrganize with root `%USERPROFILE%\Documents\D-ASK`, Plugins, DesktopOcr, BrowserRead/Actions, Memory, mouse and keyboard input are all OFFERED; every protected action still needs its approval card; appsettings and code defaults stay OFF); a user `%LOCALAPPDATA%\D-ASK\features.cmd` replaces the profile; `Start-D-ASK-Safe.cmd` loads none. Contains the conversation path, spoken-number grounding and the Release daemon that accepts the `answered` outcome.
- `scripts/package/verify-package.ps1` gained two checks (spelled-out question verified; general question ANSWERED and labelled); `hud-driver.ps1` / `approval-live-7b3.ps1` recognise `ANSWERED`.
- First verification attempt (`results/packaging/verify-20261112T195636`): every task FAILED because the UNCHANGED memory guard refused the model ("2698 MB available ... 1725 MB < required headroom 2000 MB"; Antigravity IDE 3.6 GB, Chrome 1.8 GB, Claude 2 GB were running). It then stopped at a typo I made in the new screenshot path (fixed). Its leftover throwaway stack was stopped. No product failure was shown; nothing was verified either.
- To run: free about 1.5 GB (close Chrome and the IDE), then `node scripts/package/build-package.mjs --verify --out dist/desktop/D-ASK-20261112T195636` is NOT the real-HUD check; use `powershell -ExecutionPolicy Bypass -File scripts\package\verify-package.ps1 -PackageRoot D:\D-ASK\D-ASK\dist\desktop\throwaway-verify-20261112T195636 -OutDir results\packaging\verify-<new stamp>` (the throwaway copy already exists; run it in the background; it uses the mouse for several minutes).

## Real Windows application control: "Open Notepad and type HELLO", 2026-11-12 ~21:30: IMPLEMENTED; launch + both approvals REAL-HUD verified on the packaged app; full COMPLETED run pending one decision

Root cause of the user's failure: no application-launch capability existed anywhere (the daemon's read service says "no launch"); the planner had only window listing, so it ran desktop.list_windows ("No open windows of notepad.exe") and ended UNVERIFIED. Input tools existed but needed a quoted text and a named window title.
- Daemon: new `AppLaunchRequestService` (`desktop.launch_app`, action type `App.Launch`, Elevated): fixed list (Notepad only), the agent gives only `{app}` (never a path or arguments), the daemon resolves `System32\notepad.exe`, shows the exact application and path for approval (same policy engine, digest, owner session, liveness, expiry and Stop generation), consumes the approval once, writes the audit before acting, records the existing windows, ONE CreateProcess (no shell, no arguments), and reports success only if a fresh enumeration shows exactly ONE NEW visible Notepad window (on Windows 11 notepad.exe is a stub that exits; the window belongs to another process). The opened window is remembered per task (`LaunchedWindowRegistry`); the typing step prefers it (same handle, pid and creation time), so another Notepad the user has open can never receive the text. Off by default (`AgentHost:DesktopAppLaunch`), on in the product profile.
- Input service: for a window D-ASK opened for the same task, typing tolerates the title following the content (Notepad: "Untitled - Notepad" -> "*HELLO - Notepad") only while the part after the last " - " is unchanged (`SameApplicationSuffix`); the card states it; every other identity, control, foreground and per-event check is unchanged. Found by the real run: typing stopped after "HE" ("the window's title changed").
- Agent: `desktop.launch_app` tool; `appSession()` grammar ("Open Notepad [and type X]", quoted or unquoted text, refused if the text could run on into another instruction); the typing step is bound to Notepad's own editor (Document "Text editor"); `arrangeSteps` puts the plan in the request's order (launch first, then typing; stray steps dropped), found by the first packaged run where the real 0.5B model planned only the typing; typing is refused unless this task opened Notepad and the daemon confirmed it. HUD card text and strict checks for `App.Launch`.
- Tests: daemon AppLaunchTests 26 (+ GuardedInput 38, all pass); agent `app-launch.test.ts` 28/28 (including the original failing plan and the real-model plan); approval-lifecycle 82/82; desktop 242, agent-runtime 165, grounding 77, filesystem 207, workflows 21, workflow-fixes 50, memory 49, notes 32, browser-actions 38, plugin-permissions 36, conversation 70, host-protocol 81; tsc clean. Real local model with a fake daemon (`scripts/diag/app-session-trace.ts`): 3/3 launch -> type -> completed, verified.
- REAL packaged HUD, run 2 (`results/packaging/notepad-20261112T210304`, package throwaway of D-ASK-20261112T210304): packaged launcher started; card 1 (open Notepad, exact path) shown and approved; Notepad really opened (UIA saw 1 window); card 2 (type HELLO into Document "Text editor") shown and approved; typing stopped at "HE" -> PARTIAL (the title rule above; fixed afterwards). Run 1 (`results/packaging/notepad-20261112T205609-run1`) failed on the model's plan order (fixed by arrangeSteps).
- Package `dist/desktop/D-ASK-20261112T210818` contains all fixes (78 files verified). NOT yet re-run: the demonstration needs Notepad's own saved tab state to be empty, because Win11 Notepad restores unsaved tabs (my probe runs left one 76-byte tab; copy in `results/packaging/notepad-state-backup-20261112T210304`). Deleting it was blocked by the permission classifier and is left to the user.
- Next: delete `%LOCALAPPDATA%\Packages\Microsoft.WindowsNotepad_8wekyb3d8bbwe\LocalState\TabState\51e51f18-038b-475b-8f81-a76afcf33f55.bin` (Notepad closed), then run `scripts\package\verify-notepad.ps1` on `dist\desktop\throwaway-verify-20261112T210818` (it snapshots and restores Notepad's state itself).

## "Open Notepad and type HELLO": REAL-HUD PASS 8/8 on the packaged app, 2026-11-12 21:13

Evidence: `results/packaging/notepad-run3-20261112T210818` (+ `.out.txt`); package `dist/desktop/D-ASK-20261112T210818` (throwaway copy used); harness `scripts/package/verify-notepad.ps1`.
- Started from the packaged launcher; card 1 (open Notepad, exact path) shown and approved; UI Automation saw exactly one new Notepad window "Untitled - Notepad" before any typing; card 2 (type HELLO into Document "Text editor") shown and approved; the HUD reported COMPLETED · INDEPENDENTLY VERIFIED (4.3 s after the second approval); a separate UI Automation read of Notepad's editor returned exactly `HELLO`.
- Preconditions handled with the user's explicit approval (2026-11-12): Notepad was closed, the backup `results/packaging/notepad-state-backup-20261112T210304` was byte-identical (SHA-256 6F91050F...9966), and only the single saved-tab file `TabState\51e51f18-...bin` (left by my own probe runs) was deleted. The script snapshotted Notepad's saved state (empty), and restored it after the run: TabState holds 0 files; no D-ASK or Notepad process was left.
- Limits: online run only (no Wi-Fi-off repeat); Notepad is the only application in the launch list; if Notepad already has a window open and the launch only opens a tab in it, D-ASK reports "launch not confirmed" rather than typing; Notepad restores unsaved tabs, so typing appends to that text (the card shows the window title and the exact text).

## Local RAG + Research Mode, 2026-11-12 ~23:00-23:40: IMPLEMENTED, unit + real-model tested through the compiled host; NOT yet through the real HUD

Finding at the start of this session: **no RAG pipeline existed** (memory is FTS5 over user-stated facts only; no document ingestion, chunking, embeddings, retrieval or citations).
- New `agent/runtime/knowledge/`: `pdf.ts` (self-contained PDF text: objects, object streams, Flate + PNG predictors, page tree with inherited resources, ToUnicode CMaps, /Differences glyph names), `zip.ts` + `extract.ts` (DOCX, Markdown, text, HTML, code with declaration blocks and line ranges; credentials redacted before indexing; unreadable files reported, never guessed), `chunk.ts` (never crosses a heading or code symbol; sentence overlap within a section; stable ids), `embedder.ts`, `store.ts` (separate `knowledge.db`: collections, documents, chunks, FTS5, int8 vectors, index runs; per-document atomic replace; interrupted runs recorded at restart; a different embedding model drops old vectors), `indexer.ts` (incremental: size+mtime, then SHA-256; deleted files removed only after a complete walk; root containment on the canonical path; hidden/secret/dependency/build folders never read; cancel between files), `retrieve.ts` (BM25 + exact cosine, RRF k=60, cosine floor for vector-only hits, per-document cap, reference sections excluded for research), `ground.ts`, `research.ts`, `service.ts` (deterministic request grammar + RunReport/progress in the runtime's own protocol).
- **Embeddings:** BAAI bge-small-en-v1.5 q8_0 GGUF (MIT, 36.8 MB, SHA-256 `ec38e8da142596baa913124ae50550de284b6916bf59577ef2f0cb9660c2f514`), downloaded 2026-11-12 from `huggingface.co/CompendiumLabs/bge-small-en-v1.5-gguf` into `models/`. Served by the SAME pinned llama.cpp `llama-server` (runtime verified against `artifacts.json`) with `--embedding --pooling cls`, loopback, per-launch key (an unauthenticated request must get 401 or it is refused), ~75 MB RSS, idle stop 90 s, 400 MB free-memory check. No ONNX, no npm module, no second LLM.
- **Citations by code:** the first real-model run showed Qwen 0.5B ignores inline `[n]` instructions (every valid answer was downgraded to "insufficient"). Changed: the model names passages via a schema enum (only retrieved numbers are possible), and each sentence is attributed BY CODE to the passage(s) holding at least half of its content words; unsupported sentences are marked "model inference". Limitation: lexical support, not semantic entailment.
- **Integration:** the host's runtime wrapper (`stdioHost.ts`) offers every objective to the knowledge engine first, so typed, voice, workflow steps and scheduled runs all reach it; `host.ts` gained `knowledgeClaims` so a claimed request never goes to workflow-management interpretation (a collection and a workflow may share a name). "Run the workflow X" still comes first. `DASK_AGENT_KNOWLEDGE=0` disables it.
- **HUD:** MANAGE panel KNOWLEDGE tab (index folder / codebase, refresh, remove with second click, status incl. embedded count and unreadable files) and RESEARCH tab (start: type + topic + sources; show; update = new version); every button is an ordinary request. Result badge for knowledge answers: "ANSWERED FROM YOUR INDEXED DOCUMENTS · CITATIONS CHECKED BY D-ASK · UNCITED SENTENCES ARE MARKED" (steps `kb-*`). Spoken text omits the source list and `[n]` markers. Frontend rebuilt.
- **Packaging:** `build-package.mjs` ships the embedding model; the product profile sets `DASK_KNOWLEDGE_ROOTS=%USERPROFILE%\Documents`. **Package NOT rebuilt** this session.
- **Tests:** `tests/agent-runtime/knowledge.test.ts` 101/101 (grammar incl. 9 non-claims, built PDF + DOCX, chunking, incremental indexer incl. change/delete/cancel/embedder failure/restart/model change, retrieval, citation validation, end to end incl. Research Mode, resume, panel parsers against real replies); spoken-text 25 (+3). Regression: agent-runtime 165, browser-actions 39, browser 34, desktop 242, file-organize 23, filesystem 207, grounding 77, local-inference 95, memory 49, notes 32, offline 23, plugin-permissions 36, plugins 22, workflow-fixes 50, workflow-intent 81, workflow-routing 58, workflows 21, conversation 70, app-launch 28, experimental 31, host-protocol 81, manage 30, native-agent 96, approval-lifecycle 82; root `tsc` clean; agent host and frontend build. Daemon/Rust untouched (not re-run).
- **Real-model checks (throwaway DB and folders under the session scratchpad; the user's `%LOCALAPPDATA%` and Documents untouched):** three public arXiv PDFs (GCN 1609.02907, GraphSAGE 1706.02216, GAT 1710.10903). Extraction within 2-6% of `pdftotext` character counts; titles and section headings (incl. small caps) recovered. Index 3 papers / 214 passages in ~33 s; re-run 0 re-processed. Compiled host over its real stdio protocol: index COMPLETED+verified, list, hybrid search, grounded answer with page/section citation in 3.9 s, clean shutdown, no leftover llama-server. Literature review: 3 sources, evidence 5/5 aspects, 3 model-synthesised sections, saved and re-read (SHA-256). The off-topic question ("boiling point of water on Mars") was reported as insufficient evidence. Answer quality is bounded by the 0.5B model (e.g. "what aggregators does GraphSAGE propose" -> only "convolutional aggregator", correctly cited but incomplete).
- Not done: real-HUD run of the new tabs/badge; Wi-Fi-off run; online research path for Research Mode (local sources only; the report says so); OCR of scanned PDFs (reported unreadable).

## Knowledge / Research through the REAL HUD, final package, Electron removal, security review, 2026-11-12 23:50 - 2026-11-13 00:45

**Real HUD (new harness `scripts/hud/approval-live-knowledge.ps1` + read-only checker `scripts/hud/knowledge-db-check.mjs`; isolated index, research folder and indexable folder via AgentHost:ExtraEnvironment; three public arXiv PDFs + one note).**
- Run 1 `results/knowledge-hud/live-20261112T235447`: 11/13. K1-K7 passed; K8/K9 failed because of HARNESS bugs (panel detection looked for the word REFRESH in text that chat history also contained; `Get-HudText` returns Text elements only, never buttons). Kept.
- Run 2 `results/knowledge-hud/live-20261113T001657` (after the harness fix and the rebuilt HUD/frontend/host): **12/13**. Passed: index (COMPLETED + INDEPENDENTLY VERIFIED; 3 PDFs, 214/214 passages embedded, independent DB read), incremental refresh (1 indexed, 3 unchanged), grounded answer with knowledge badge and page citation (p-1706.02216.pdf, p. 2), a fact only in the new note answered and cited to `project-notes.md` (lines 5-5, § Project notes > Schedule), insufficient evidence for an unrelated question, literature review COMPLETED with report SHA-256 = project.json, RESTART with the same index (collection and project still listed; new daemon pid), RESEARCH tab (real clicks), REMOVE FROM INDEX with its confirm click (collection gone, PDFs byte-identical), no knowledge errors in daemon logs, user's real knowledge.db and Documents\D-ASK\Research unchanged. The one FAIL (K8 KNOWLEDGE tab) is a harness regex: React renders `[{kind}]` as three text nodes, reported as `[ research ]`; the saved capture `hud-k8-knowledge.txt` shows the correct row `research [ research ] 4 document(s) · 215 passage(s) SEMANTIC + KEYWORD` and passes the corrected regex (re-evaluated on the capture, not re-run). REFRESH INDEX / UPDATE (NEW VERSION) were not clicked in the HUD.
- Observed (not fixed): after a FORCED kill (`taskkill /F`) a few seconds after a task finishes, WebView2 may not have flushed the HUD's last `localStorage` history write; on the next start that entry shows "RESULT UNKNOWN: D-ASK CLOSED BEFORE THIS FINISHED" although the task completed (seen for K6 in both runs). History persistence only; the task and its saved report are unaffected.

**Defects fixed this session**
1. Time budgets vs the daemon's 330 s task limit (`AgentHost:TaskTimeoutMs`): indexing stops itself at 270 s (`INDEX_BUDGET_MS`) and reports PARTIAL "refresh to continue" (finished documents kept); Research Mode stops synthesising after 200 s (remaining aspects evidence-only, stated in the report). Before: a large folder or slow synthesis would be cancelled from outside.
2. Research project ids from the user-writable `project.json` must equal their folder name (slug characters); a crafted id can no longer direct a resumed run's report outside the research folder.
3. Native HUD bridge refuses `ModelInference` from the web view (`src/hud-native/src/main.rs`): it was unused by the frontend but reachable by a page script, and a long daemon generation on the HUD's pipe delays an Emergency Stop sent on the same pipe (`docs/issues/daemon-inference-estop-delay.md`). The daemon's serial session loop itself is unchanged.
Tests: knowledge 106/106 (+5), host-protocol 81, manage 30, native-agent 96, spoken-text 25, offline 23, agent-runtime 165; root tsc clean; Rust tests 61 passed (4 ignored).

**Electron removed (after proof it is unused):** no renderer code uses an Electron API; the native HUD serves `.next` through WebView2 (`main.rs` 231-233); no script/daemon/HUD invokes `main.js` or `npm run desktop`; the package build already rejected Electron files. `npm uninstall electron electron-builder` (package.json + package-lock.json; pnpm-lock.yaml had none), `"main"` and the `desktop` script removed, `main.js` deleted (tracked, unmodified: recoverable with `git checkout -- main.js`). Frontend, agent host and native HUD rebuilt afterwards; all real-HUD and package checks above ran on those builds.

**Final package `dist/desktop/D-ASK-20261113T003222`** (build log `results/packaging/20261113T003222/build.log`; 203 manifest files, manifest SHA-256 933c0abe…a2739fea; embedding model, whisper.cpp, better-sqlite3 FTS5 probe OK). Verified on the throwaway copy `dist/desktop/throwaway-verify-20261113T003222` (identical manifest; 1.5B/3B models not copied, unused) through the real launcher: **25/25** (`results/packaging/verify-20261113T003222` + `.out.txt`), including new packaged-knowledge checks (packaged llama-server running the packaged bge model, cited answer, literature review saved and hash-matched, a replaced embedding model refused by its pinned SHA-256 with search falling back to keyword-only and saying why) and the earlier memory and five tamper checks. User's memory.db and knowledge.db hashes unchanged; no process left running.

**Security review against the current code:** `docs/issues/engine-stop-active-count-race.md` is fixed in code (active actions snapshotted at ActionExecutionEngine.cs:194 before the cancel at :198). `docs/issues/daemon-inference-estop-delay.md`: the trigger is removed (item 3 above); the daemon's per-session serial loop remains (any future long handler on the HUD pipe would reintroduce it). Other "open" items in the audit reports are functional/performance (repeated window action → partial; screen-capture median latency) or stated residual risks (no code signing; the Wi-Fi-off monitor does not watch UDP).


## Cross-feature integration, 2026-11-13 00:55 - 02:05: composition, shared context, more apps; real HUD, package and Wi-Fi-off VERIFIED

**Gaps found in the code (not the docs):** (1) the host never passed conversation history to the runtime, so every request started cold; (2) no data could flow between capabilities (steps take inputs only from the request text, by design, and the knowledge engine claims requests outright); (3) only Notepad could be opened.

**Implemented**
- `agent/host/compose.ts` (new) + `host.ts` + `workflowRun.ts`: result passing without new model authority. "<request>, then save it as a note called T" / "<request> and remember it" / follow-ups "save that as a note called T" / "remember that" (previous turn; in a workflow, the previous STEP). The first part runs exactly as typed; its result becomes the literal text of an ordinary note/memory request through the same runtime (notes grammar, daemon approval card showing the exact text, secret refusal, independent file check, Emergency Stop). Fail-closed: nothing is saved if the first part did not succeed; too-long or secret results are refused with a reason. Second-part step ids are prefixed (`save.`) in progress and result. Workflow definitions/schedules are never parsed as chains.
- Conversation context: the host keeps the last 10 turns (in memory) and passes the last 5 to the planner (advisory; grounding still uses only the request).
- Apps: daemon `KnownApps` + agent `LAUNCHABLE` now Notepad (open + type), Calculator (calc.exe -> ApplicationFrameHost "Calculator" window, observed on this machine) and Character Map (charmap.exe, observed); same approval card, single-new-window confirmation and audit. Paint/WordPad are not in System32 on this machine and were not added.
- Defects found by the real HUD and fixed: a chain's saving request was routed through workflow-management interpretation, which read the quoted note CONTENT ("§ Project notes > Schedule") and refused it -> the saving request now goes straight to the runtime; the knowledge router could claim a note/memory request whose content mentions "literature review" -> note and memory requests are never claimed by it.
- Tests: `tests/agent-host/compose.test.ts` 33 (grammar, built requests, refusals, through AgentHost with history and step ids, the real-HUD regression, workflow step passing); app-launch 34 (+6); knowledge 108 (+2); daemon AppLaunch 28 (+2). Full regression: 27 TS suites all pass, root tsc clean, daemon 559 passed / 1 skipped.

**Real HUD cross-feature acceptance** (`scripts/hud/approval-live-integration.ps1`; all stores isolated): run 1 `results/integration-hud/live-20261113T010735` 8/12 (found the routing defect above; X4 used an unquoted multi-word workflow name, which the product correctly asked to quote). Run 2 `results/integration-hud/live-20261113T011246` **12/12**: knowledge index; knowledge -> note (card showed the answer; file holds answer + source); "Remember that" -> memory row -> recall; workflow "paper digest" (knowledge step + "save that as a note") saved, scheduled via its card, FIRED BY THE SCHEDULER, its note step asked for its own approval showing step 1's answer, note written, HUD showed the scheduled run; "Open Calculator" (card, new window confirmed, closed); Emergency Stop during research -> CANCELLED, RESUME, next task COMPLETED; no errors; one daemon + one agent host process throughout; user stores unchanged.

**Final package `dist/desktop/D-ASK-20261113T012459`** (204 manifest files, manifest SHA-256 e63e32f4...c45669). Verification on the throwaway copy through the real launcher: first attempt stopped at a harness defect (the new composition check read the locked memory DB without share mode; evidence kept: `results/packaging/verify-20261113T012459`); after fixing the read, **26/26** (`results/packaging/verify-20261113T012459-run2`), including packaged knowledge, literature review, embedding-model tamper refusal and the new packaged composition check ("Remember that" stores the previous knowledge answer).

**Wi-Fi OFF** (`run-offline-acceptance-7b3.ps1 -AcceptanceScript offline-integration-acceptance.ps1`, new script): radio Off 01:38:50 -> restored On 02:01:27 (SUCCEEDED, online again). Evidence `results/offline-integration/20261113T013857` + wrapper `results/phase7b3/acceptance-runs/20261113T013844`. Cross-feature **12/12 offline**; knowledge 12/13 offline; **0 non-loopback connections** across 53 D-ASK-tree processes. The one knowledge FAIL (K8) is a typo I introduced in the harness regex (missing space after `\]`); the saved capture `knowledge/hud-k8-knowledge.txt` shows the correct row and passes the corrected regex; the REFRESH INDEX button lookup in that check never ran (short-circuit). Not re-run with Wi-Fi off.


## Round 3 (2026-11-13 02:10 - 05:00): typed results, online research, copy/rename, history recovery, Emergency Stop review; HUD + package + Wi-Fi-off

**Implemented**
- Typed, provenance-preserving results: `Artifact` (types.ts) with kind, text, sources, provenance (tool, request, outcome, verified, online, time) and file. `agent/runtime/artifact.ts` derives it from TOOL OUTPUTS only (browser.read_page -> page, filesystem.summarize -> file-summary, filesystem.read -> file-text, desktop.read_text -> window-text, memory.recall -> memory, plugin_* -> plugin-output marked unverified); the knowledge engine sets its own (answer with cited sources, passages, saved report). Host-side only: stripped from task.finished (protocol unchanged). Composition (`compose.ts`) now passes the artifact, with its sources, to four destinations, each an ordinary request with its own grammar and approval: note (sources + "read from the web" time), memory (single source kept), Notepad (one line <= 200 chars, typing card shows it), knowledge ("add it to my knowledge": a page D-ASK read is re-read and indexed by URL). The chain re-checks the abort signal between parts.
- Optional online research: `fetchPage` (the same policy-locked local browser as browser.read_page, only when AgentHost:BrowserRead is on) -> "index the page <url> [into web]", research "… using <url> [and my papers]" (pages read now into a `web` collection, cited by URL, report scope says which sources were online and when; no web search). Pages the request names are always cited (fix found in the real HUD: identical pages, duplicate filter kept the other one). "refresh web" re-reads pages. Offline: refused/fails cleanly, nothing else depends on it.
- File copy / rename / undo (daemon `FileOrganizeRequestService` + agent `fileOrganize.ts` + HUD card validation): one file per request, canonical paths inside the allowed folders, no links/hidden/system files, safe names; copy never overwrites (a taken name becomes "name (copy).ext", shown on the card), SHA-256 verified; rename never overwrites, extension change shown; undo removes only an UNCHANGED copy or renames back; journal written before acting; audit events; Emergency Stop checked before acting; policy Elevated. Planner removes exact duplicate copy/rename/undo steps (the 0.5B model repeated undo 8 times in the real HUD).
- History recovery: the HUD records the task id on its history entry when the task is accepted; the daemon keeps the last 40 finished results (`TaskResultsPath`, default %LOCALAPPDATA%\D-ASK\task-results.json) and answers `AgentTaskStatusRequest` for a FINISHED task only when its owning session is no longer connected (a concurrently connected session still gets "not found": regression found by the existing pipe-security test and fixed). Rust bridge forwards `AgentTaskStatus` (task id only); HUD retries at 2.5/8/20 s and shows "RECOVERED AFTER RESTART · …".
- Emergency Stop review (code): host aborts the active task's signal; knowledge indexing, research, embedder, page reads, composition (between parts), workflows, model requests honour it; scheduler skips and records due runs while stopped; daemon file operations check stop before acting; the HUD bridge refuses page-initiated daemon inference (earlier). Resume semantics unchanged (generation-checked).
- Defects found by the real runs and fixed: host refused to START with every feature on (handshake capped the daemon's tool offer at 32 names and did not know files.copy/rename/undo) -> limit 64, names added, regression test; plugin -> memory chain passed noisy run text -> plugin-output artifact; "Undo: …" hint in evidence led the 0.5B assessor to invent an unmet criterion -> neutral wording.
- Tests: compose 50, knowledge 121, file-organize 33, app-launch 34, native-agent 102, approval-lifecycle 82; all 27 TS suites pass; root tsc clean; daemon 568 passed / 1 skipped (FileCopyRename 8 new, AgentHostWire recovery test new); Rust 62.

**Real HUD**: `scripts/hud/approval-live-integration2.ps1` (fails fast if the host does not answer a probe). Final run `results/integration-hud/round2-20261113T044042` **11/11 online**: copy/rename/undo, Character Map, plugin install -> refused before grant -> grant -> plugin result remembered, history recovered after a forced kill, browser page -> note (URL in note), web page -> knowledge, online research citing the named URL. Earlier attempts kept: two aborted by the unchanged memory guard (2,812 / 2,625 MB available), one with the host-start defect, one 9/11, one 10/11.

**Packaged + Wi-Fi OFF**: `scripts/hud/offline-final-acceptance.ps1` via the radio wrapper: radio Off 04:26:29 -> restored On 04:38:42, online again. `results/offline-final/20261113T042633`: **packaged application 26/26 offline** (package `D-ASK-20261113T042336`: real launcher, packaged Node + llama-server, verified/answered questions, memory incl. restart, packaged knowledge + embedder, literature review, composition, six tamper checks); offline cross-feature subset 7/8 (the FAIL: copy and rename ended UNVERIFIED because of the evidence wording above; files were correct; fixed afterwards, then 11/11 online). **0 non-loopback connections** across 181 D-ASK-tree processes.

**Voice (person required)**: `scripts/hud/approval-live-voice-chain.ps1` (+ `offline-voice-chain-acceptance.ps1`): three spoken requests (verified tool answer; knowledge -> memory chain; recall). NOT RUN: it needs a person at the microphone.

**Final package `dist/desktop/D-ASK-20261113T044615`** (manifest SHA-256 aa3bb59a…6b6f839, 205 files): `results/packaging/verify-20261113T044615` **26/26** through the real launcher (online). Contains every change of this round.
