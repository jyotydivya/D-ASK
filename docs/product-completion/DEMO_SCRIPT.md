# D-ASK demonstration script

Three end-to-end demonstrations, then the supporting sequence. Each line says what has been exercised and how: **REAL-HUD** = typed or clicked through the real HUD in an acceptance run (evidence path given); **UNIT/REAL-MODEL** = automated tests and the real local model, but not yet through the real HUD; **NOT DONE** = not demonstrated.

**Setup.** Close Chrome and heavy IDEs first: the local model is admitted only with about 2,973 MB available (a deliberate guard that is never lowered). Wi-Fi may be off for the whole demo. Start the packaged app with `Start-D-ASK.cmd` (the product profile: every capability is offered, every protected action still shows an approval card; `Start-D-ASK-Safe.cmd` starts the core assistant only). The folder D-ASK may organise and keep notes in is `Documents\D-ASK`. Wait for the HUD to show the daemon connected; press Ctrl+Alt+Space to make the HUD interactive. Emergency Stop is Ctrl+Shift+F12.

## Demo 1: voice conversation (question → answer → spoken)

1. Click the microphone (ARM VOICE), wait for ARMED, say: **"What is seven times eight?"**
   - Local speech recognition (whisper-local, SAPI fallback) shows the transcript; the request goes to the same runtime as typed text.
   - The question is recognised as arithmetic, the `math.evaluate` tool computes it, deterministic grounding ties the result to the request's own numbers: `COMPLETED · INDEPENDENTLY VERIFIED`, answer **56**, spoken by the local voice.
   - Status: number-word grounding and `completed`/verified outcome are UNIT/REAL-MODEL (`tests/agent-runtime/conversation.test.ts`, `scripts/diag/conversation-trace.ts`). The earlier real-HUD voice run (`results/offline-voice/20261112T190439`) showed `UNVERIFIED` because spoken numbers were not understood; that is fixed in code and **not yet re-run through the HUD with a voice**.
2. Say: **"What is the capital of France?"** (or "Why is the sky blue?")
   - No tool and no computer action are involved. The local model answers; the HUD shows `RESULT — answered` and the badge **ANSWERED BY THE LOCAL MODEL · NOT CHECKED AGAINST A SOURCE**; the answer is spoken. It is never shown as completed or verified.
   - Status: UNIT/REAL-MODEL; not yet through the HUD.
3. Say: **"What is the weather in Pune?"**: refused honestly (no tool, nothing current is known offline). **"What is my favourite editor?"** is answered from memory only if you asked D-ASK to remember it (below).
4. Typed questions behave identically. Questions that name your computer, files, "my ...", or anything current never take the conversational path.

## Demo 2: native Windows operation (approved, verified)

1. Open the guarded input fixture window (or any window with a labelled button). Type or say: `Click the Go button in the window titled "<title>"`.
2. An approval card names the window and the control. APPROVE: one real click is sent and verified by a change in the UI tree. DENY: nothing happens. Press Ctrl+Shift+F12 while a card is pending: it is invalidated.
3. `Type "hello d-ask" into the notes field of the window titled "<title>", then press Backspace`: two cards, in order; the exact text is on the card.
   - Status: REAL-HUD, online and Wi-Fi off, `results/p1p2-hud/offline/20261109T213052` (23/23) and multi-step `results/offline-full/20261110T133942` (11/11), on the fixture window.
4. **Open a real application and type into it (the headline demonstration):** type or say `Open Notepad and type HELLO`. Card 1 shows the exact application and path (`C:\Windows\System32\notepad.exe`, no arguments); APPROVE; a new Notepad window opens. Card 2 shows the exact text and the Notepad editor; APPROVE; HELLO is typed. The HUD reports `COMPLETED · INDEPENDENTLY VERIFIED` only because the daemon saw the new window and then re-read the editor's value.
   - Status: **REAL-HUD on the packaged app, 8/8**: `results/packaging/notepad-run3-20261112T210818` (package `D-ASK-20261112T210818`, run by `scripts/package/verify-notepad.ps1`). A separate UI Automation read of Notepad's editor returned exactly `HELLO`; the screenshot `desktop-final.png` shows the window and the HUD together. Online (not run with Wi-Fi off). Only Notepad is in the launch list; other applications are not supported.

## Demo 3: multi-step task with observation and verification

1. `Read the text in the window titled "<an app>"` (offline OCR of one window; password fields are not revealed).
2. `Organize the files in "<a folder under Documents\D-ASK>" by type`: a card lists every move; APPROVE; each file is moved once and re-checked on disk; `COMPLETED · INDEPENDENTLY VERIFIED`; then `Undo the last file organisation`.
3. `Save a workflow called "morning check": What is 6*7?; then Organize the files in "<folder>" by type`, then `Run the workflow "morning check"` (a workflow name with spaces must be quoted; D-ASK refuses to guess where an unquoted name ends): steps run in order, a workflow is completed only if every step completed and verified. `Schedule the workflow morning check every day at <2 minutes from now>`: a card lists every step and the time; at the time the run starts by itself, asks for its own approval, and the result appears as a `SCHEDULED RUN` entry.
   - Status: REAL-HUD, online and Wi-Fi off: `results/features-hud/live-20261110T161046`, `results/offline-features/20261110T161650` (16/16); scheduling `results/timed-hud/live-20261112T174849` (17/17 online, scheduled-run entry shown). The Wi-Fi-off timed run has not been repeated after the harness fixes.

## Supporting sequence

| Capability | Say / type | What is seen | Status |
|---|---|---|---|
| Memory | `Remember that my favourite editor is Neovim.` → `What is my favourite editor?` → `Forget my favourite editor.` (a password is refused) | Stored locally, recalled, really deleted; MANAGE panel lists and forgets | REAL-HUD online 11/11 and Wi-Fi off 11/11 (`results/memory-hud/live-20261112T043505`, `results/offline-memory/20261112T050528`) |
| Plugins | `Install the plugin note_reader`, APPROVE (compute only), then grant `files.read` in the MANAGE panel | Permissions are granted one by one; `.env` stays refused; revoke is immediate | REAL-HUD online 16/16 (`results/plugperm-hud/live-20261112T042606`) |
| Browser | `On <local fixture URL>, type "me@example.com" into the Email field, then click the Subscribe button` | Two separate cards, in order; the page shows the thanks message | REAL-HUD online and Wi-Fi off 11/11 (`results/browser-stage2/hud-20261110T131501`) |
| Notes | `Create a note titled Meeting. The note should contain the exact words, open quote, remember to submit the project report by Friday, close quote.` | Card with file name and exact words; byte-for-byte verified | REAL-HUD online and Wi-Fi off 11/11 |
| Files | `Summarize docs/project-brief.md`, `Give me an overview of the data folder` | Quotes at real line numbers; `.env` and outside folders refused | REAL-HUD online and Wi-Fi off 12/12 |
| Packaged app | `Start-D-ASK.cmd` from the package folder | Same stack from the package; tampered files stop the host | package verification 18/18 for `D-ASK-20261112T045745`; the newer package is not yet verified |
| Stop | Start a long task, press STOP or Ctrl+Shift+F12 | Everything stops until RESUME | REAL-HUD (`results/phase7b3/offline-live/20261109T193116`) |

## Honest answers to likely questions

- *Does it need the internet?* No. Acceptance runs were repeated with the Wi-Fi radio off and the D-ASK process tree monitored for non-loopback connections (0 observed; the monitor polls TCP, not UDP).
- *Can the model approve its own actions?* No. The daemon owns policy, approval tokens, the execution latch and Emergency Stop; the model only proposes.
- *Is an answered question verified?* No, and the HUD says so. Only tool-computed answers whose request the system can tie to the result are `COMPLETED · INDEPENDENTLY VERIFIED`; a conversational answer is the local 0.5B model's own words.
- *How accurate is the 0.5B model?* It misreads some wordings. The host never guesses: unclear requests are not acted on, and results it cannot verify are labelled `UNVERIFIED`.
- *Vision?* Window OCR and the UI Automation tree are real and offline; there is **no screenshot-understanding model** (it would not fit the memory budget on this machine).
- *What is not finished?* See the status table in `FINAL_REPORT.md` (section 11).
