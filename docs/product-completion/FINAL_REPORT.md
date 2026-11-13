# D-ASK: an offline-first, native Windows desktop AI assistant

Project report (draft assembled from recorded evidence; every number below comes from a file under `results/` or from the test output named next to it. Nothing here is estimated).

## 1. Abstract

D-ASK is a Windows 11 desktop assistant that understands natural-language requests with a local language model, observes the desktop, manages files, drives the browser and (with approval) the mouse and keyboard, runs saved and scheduled multi-step workflows, loads sandboxed plugins, remembers user-approved facts, listens and speaks, all without cloud services. It is built as a native stack (Rust host with WebView2, a .NET daemon, a TypeScript agent runtime, a React/Three.js interface; no Electron). Its distinguishing design decision is that **the model only proposes; a separate daemon owns authorization and execution**: every privileged action needs a daemon-validated, single-use approval that the user grants in the HUD, and an Emergency Stop latch halts observation, inference and actions. The system was accepted feature by feature through the real HUD, several of them again with the Wi-Fi radio switched off.

## 2. Introduction and problem

People repeat computer chores (finding and summarising documents, organising folders, taking notes, running routines at fixed times) and existing assistants either cannot act on the desktop, or act with broad cloud-mediated authority and little accountability. Cloud assistants also fail offline and send personal context to a third party. D-ASK targets an ordinary laptop (Core i5-1335U, 16 GB RAM, integrated graphics) and asks: can a small quantised local model be a useful, *safe* computer assistant?

## 3. Objectives

1. Local inference and local speech, vision (OCR) and memory; core functions work with no network.
2. A model that cannot authorize itself: daemon-owned policy, approvals, audit and Emergency Stop.
3. Truthful results: a task is reported `COMPLETED` only if independently verified; otherwise `UNVERIFIED`, `PARTIAL`, `REFUSED` or `FAILED`.
4. Real integration: voice, text, workflows, scheduler and plugins share one runtime and one approval path.
5. A native, installable Windows distribution.

## 4. Limitations of existing systems (stated as design motivations, not as measured comparisons)

Cloud-bound assistants need connectivity and disclose context; script-style automation has no natural-language layer; agent frameworks that let the model call tools directly have no independent authorization boundary. D-ASK was not benchmarked against other products in this project.

## 5. Proposed system and architecture

```
                 +--------------------------- Windows 11 ---------------------------+
 user -- voice --> Rust HUD host (WebView2 + React/Three.js HUD)                     |
        text   -->   | Named Pipe IPC (authenticated, protocol-checked)              |
                     v                                                                |
              .NET Daemon  <-- owner of: approvals, policy, execution latch,          |
                 |   |            Emergency Stop, audit, workflow store + scheduler,  |
                 |   |            plugin approvals, guarded input, window OCR/UIA     |
                 |   +--> Windows UI Automation, SendInput (guarded), shared-memory   |
                 |        desktop observation, dask-ocr (Windows.Media.Ocr)          |
                 v  stdio protocol v2 (hash-verified package)                        |
          Agent host (Node, TypeScript): planner -> validated tool calls -> verifier |
                 |        tools: files, notes, workflows, plugins, browser, memory,  |
                 |        desktop (via the daemon bridge only)                       |
                 v                                                                   |
          llama-server (local GGUF, Qwen 0.5B default; memory-guarded)              |
                 whisper.cpp / SAPI (speech-to-text), SAPI (text-to-speech)          |
                 Playwright + local Chromium (browser), sandboxed Node (plugins)     |
                 +-------------------------------------------------------------------+
```

Key properties:
- **Separation of powers.** The agent host has no handle to input injection or the file system outside configured roots; it can only *request* an action through the daemon bridge. The daemon validates the request, shows an approval card in the HUD, and executes only after a single-use approval bound to the exact request.
- **Fail-closed grounding.** Tool arguments are pinned to the user's words (argument domains); a model-invented target is refused before any approval. Facets of the request must be satisfied by a verified execution for `COMPLETED`.
- **Package integrity.** The daemon checks every agent-host file, the pinned Node runtime and the plugin sandbox against a SHA-256 manifest before each host start.

## 6. Modules

| Module | Implementation | Notes |
|---|---|---|
| AI brain | `agent/runtime/*`: planner, verifier, completion loop, tool registry; local llama.cpp | Qwen 0.5B default (1.5B / 3B pinned); memory guard requires about 2,973 MB available |
| Workflow interpretation | `agent/host/workflowIntent.ts`, `workflowManage.ts` | Exact parser first; model-assisted interpretation only for free wording, then host validation; an explicit name is required |
| Voice | `src/hud-native/src/tts.rs`, `stt.rs`, `whisper.rs` | SAPI TTS, whisper.cpp (hash-pinned) or SAPI STT; falls back automatically |
| Vision | UIA tree, window list, GDI capture, `dask-ocr` (Windows OCR) | Named-window OCR; no cloud, no VLM (memory) |
| Windows control | daemon `Automation/Input` | click, type, key chords; element-bound, no coordinates from the agent; any physical input stops it |
| Files | `filesystem*.ts`, `fileSummary.ts`, `fileOrganize.ts`, `notes.ts` | search/read/summarise/overview, organise+undo (approval), notes (approval), secret and outside-root refusal |
| Browser | `agent/runtime/browser/*`, `browserActions.ts` | read pages; approved fill/click; policy-locked Chromium |
| Workflows + scheduler | daemon `Automation/Workflows` | 1-8 steps, no recursion, schedule needs approval, 20 s tick, missed runs never caught up |
| Plugins | `agent/runtime/plugins/*`, daemon `Plugins/PluginService.cs` | install = approval card showing tools; compute-only sandbox; hash re-check per call; revoke |
| Memory | `agent/runtime/memory/*` (SQLite, FTS5) | secrets refused; real deletion; user controls via CLI |
| Knowledge (local RAG) | `agent/runtime/knowledge/*` (own `knowledge.db`) | PDF/DOCX/MD/TXT/HTML/code parsers (no extra modules), structure-aware chunks, bge-small-en-v1.5 embeddings on the pinned llama.cpp runtime, FTS5 BM25 + int8 cosine fused by RRF, citations assigned by code |
| Research Mode | `agent/runtime/knowledge/research.ts` | same index; deterministic aspect plan, verbatim evidence extracts, model synthesis with checked citations, saved and resumable projects; local sources only |
| HUD | `components/*`, `hooks/*`, `src/hud-native` | approval cards, progress, result panel, Stop/Resume, reconnection |
| Packaging | `scripts/package/*` | no-admin per-user installer, manifest verification |

## 7. Algorithms and technical contributions (as implemented; not claimed as novel)

- Request-grounded tool arguments (`argumentDomains`), request *facets* and verification by independent re-reading (e.g. re-reading the created note's bytes).
- Ordered multi-step input with per-step approval and a deterministic continuation that does not depend on the small model re-planning.
- Workflow management routing: exact grammar, then a model interpretation that the host validates (name explicitly introduced by the user; time words must be present in the request; ambiguous or contradictory requests ask a question).
- A plugin sandbox on stock Node (`--permission`, plus a preload that closes every network entry point), measured against real escape attempts.
- A process-tree network monitor used by the Wi-Fi-off acceptance wrapper (with a PID-reuse repair, found when a Chrome process was misattributed).

## 8. Evaluation methodology

Each feature has (a) unit/component tests, (b) a real-HUD harness that types requests into the real HUD, clicks the real approval cards and checks effects independently (files on disk, stores, logs), and (c) for the main features, a repeat with the Wi-Fi radio switched off and the D-ASK process tree monitored for non-loopback connections. Harnesses refuse to run if the memory guard is not satisfied, and never reuse an evidence folder.

## 9. Measured results (all from recorded evidence)

| Area | Result | Evidence |
|---|---|---|
| Core P0 (Wi-Fi off) | wire 1/1, real HUD 17/17, 0 non-loopback connections | `results/phase7b3/offline-live/20261109T193116` |
| Guarded mouse/keyboard (Wi-Fi off) | real HUD 23/23: click, exact typing, Backspace, DENY, STOP while pending, foreign input stops typing after 4/120 steps | `results/p1p2-hud/offline/20261109T213052` |
| Browser Stage 2 | 11/11 online and Wi-Fi off | `results/browser-stage2/` |
| Organise, workflows, plugins, OCR (Wi-Fi off) | 16/16 each; sandboxed plugin ran; OCR read the fixture and did not show the password | `results/features-hud/live-20261110T161046`, `results/offline-features/20261110T161650` |
| Note creation | 11/11 online and 11/11 Wi-Fi off | `results/notes-hud/live-20261110T184729`, `results/offline-notes/20261110T185300` |
| File summarisation | 12/12 online, 12/12 Wi-Fi off; quotes at exact lines; folder counts equal the disk | `results/summarize-hud/live-20261110T200108`, `results/offline-summarize/20261110T210909` |
| Workflow naming/management fixes (N21/N22) | 8 of 9 requests correct (F06 model recall miss, no action taken) | `results/workflow-focused/live-20261112T022826` |
| Scheduled execution | 17/17: save, schedule, restart persistence (byte-identical store), real firing 17 s after due, timed step asked for its own approval, LastRun recorded, unschedule, cancelled schedule never fired | `results/timed-hud/live-20261112T023154` |
| Local memory (Wi-Fi off) | 11/11: remember, secret refused (not in DB/WAL), recall, restart persistence, forget; 0 non-loopback connections | `results/offline-memory/20261112T050528` |
| Native package with packaged memory | 18/18: real launcher, memory remember/recall/restart/forget, 5 tamper cases | `results/packaging/verify-20261112T045942` |
| Native package | 11/11 (real launcher, task verified in 21 s, four tamper cases each stop the host and recover) | `results/packaging/verify-20261110T155659` |
| Speech-to-text (synthetic voice) | whisper 3/3 exact (about 1.9 s each, CPU); SAPI 3/3 above threshold (about 0.35 s) | `results/voice-local/engines-20261110T124841` |
| OCR latency | 339 ms for a test image, exact text | `results/vision-ocr/` |
| Memory store | 5,000 memories in 2.06 MB; recall about 2.7 ms average | `results/memory-local/` |
| Memory with HUD and model | 3,466 MB available with the HUD running during one run (2,973 MB required) | `results/p1p2-hud/offline/20261109T213052` |
| Screen capture | P95 < 50 ms achieved; **median < 30 ms NOT achieved** | phase 7B.3 report |
| Automated tests (latest recorded) | agent-runtime 165, workflows 21, workflow-fixes 50, workflow-intent 81, desktop 242, grounding 77, HUD client 96, plus daemon suite 499 (498 passed, 1 skipped opt-in), Rust 61 | CHECKPOINT.md and this session's runs |

## 10. Security and privacy

- Preserved controls: approval-token binding and single use, owner-session checks, HUD liveness, expiry, Stop generation, the execution latch, the global panic hotkey (fails closed), and the unchanged local-model memory guard.
- Secret protection: secret-looking file names are excluded; passwords, keys and cards are refused by memory and by browser field filling; the audit stores only SHA-256 of typed text.
- Plugins: compute-only; no network, file write, process spawn or eval (each tested against real attempts); files re-hashed before every call.
- Privacy: no cloud API is called by the core; the native HUD never uses the legacy cloud speech route.
- Known caveat: the Wi-Fi-off monitor polls TCP every 300 ms and does not watch UDP.

## 11. Capability status (honest)

Levels: **IMPL** implemented, **TEST** automated tests pass, **HUD** accepted through the real HUD, **OFF** accepted with Wi-Fi off.

| Capability | IMPL | TEST | HUD | OFF | Gap |
|---|---|---|---|---|---|
| Local LLM, planning, verification | yes | yes | yes | yes | small model misreads some wordings |
| Workflows (save/list/run/delete) | yes | yes | yes | yes (features) | NL management via 0.5B: F06 style requests may not be claimed |
| Scheduling (fire, restart, cancel) | yes | yes | yes | no | Wi-Fi-off run not done; the `SCHEDULED RUN` result entry is shown in the real HUD (17/17, `results/timed-hud/live-20261112T044812`) |
| Plugins (install, run, revoke, per-permission grant, enable/disable) | yes | yes | yes (16/16, `results/plugperm-hud/live-20261112T042606`) | install/run yes; granular permissions not run offline | permissions `compute`, `files.read`, `memory.read`; only `compute` is granted at install |
| Files: search/read/summarise/organise/notes | yes | yes | yes | yes | |
| Windows control (click/type/keys) | yes | yes | yes | yes | one input action class per request limits; off by default |
| Vision: UIA + window OCR | yes | yes | yes | yes | no screen-understanding model |
| Browser read + approved actions | yes | yes | yes (Stage 2) | yes | Stage 1 not separately HUD-run |
| Voice (TTS, STT) | yes | yes | person voice run by the user, not as an acceptance | no | spoken request to verified result with Wi-Fi off not recorded; microphone loopback was poor |
| Local memory | yes | yes | yes (11/11 online `results/memory-hud/live-20261112T043505`) | yes (11/11, `results/offline-memory/20261112T050528`) | |
| HUD management panel (workflows, plugins, memory) | yes | yes (30) | yes, exercised by the plugin-permission run | no | native HUD only; each button submits an ordinary request |
| Knowledge / RAG (index, refresh, remove, search, grounded answers with citations, codebase) | yes | yes (108, `tests/agent-runtime/knowledge.test.ts`) | yes: `results/knowledge-hud/live-20261113T001657` (index, incremental refresh, grounded + cited answers, insufficient evidence, restart persistence, panel remove); packaged: `results/packaging/verify-20261113T012459-run2` | yes: 12/13 Wi-Fi off (`results/offline-integration/20261113T013857`; the FAIL is a harness regex typo, the capture is correct) | 0.5B answers are short and can be incomplete; citations are attributed by lexical support, not semantic entailment |
| Research Mode (plan, sources, evidence, synthesis, report, resume) | yes | yes | yes: literature review through the real HUD and in the package (report SHA-256 = project.json) | yes (offline knowledge run, K6) | local sources only (no online research path yet); contradiction detection is model-assisted |
| HUD KNOWLEDGE / RESEARCH tabs, grounded-answer badge | yes | yes (panel contract checked against real replies) | yes (real clicks: RESEARCH tab, REMOVE FROM INDEX with confirm; KNOWLEDGE tab row re-evaluated on the saved capture after a harness regex fix) | no | REFRESH INDEX and UPDATE buttons not clicked in the HUD (their requests are covered by the grammar tests) |
| Composition between capabilities ("..., then save it as a note called T", "... and remember it", "save that ..." / "remember that", also inside workflows) + conversation context | yes | yes (compose 33) | yes: `results/integration-hud/live-20261113T011246` 12/12 (knowledge->note, follow-up->memory->recall, scheduled workflow knowledge->note, Calculator, Emergency Stop mid-research); packaged: composition check in `verify-20261113T012459-run2` | yes: `results/offline-integration/20261113T013857` cross-feature 12/12, 0 non-loopback | only notes and memory are sinks; no free data flow between arbitrary tools (by design: inputs stay grounded in the request text) |
| App launch: Notepad (open + type), Calculator, Character Map | yes | yes (daemon 28, agent 34) | Calculator through the real HUD (card, new window confirmed) | yes (offline cross-feature run) | Character Map not HUD-run; Paint/WordPad are not in System32 on this machine |
| Packaging | yes | yes | package `D-ASK-20261113T012459` verified **26/26** on a throwaway copy through the real launcher (`results/packaging/verify-20261113T012459-run2`): packaged Node/llama-server, verified and answered questions, memory incl. restart, knowledge with the packaged embedder, literature review, composition (knowledge->memory), six tamper checks | not as a package (the same build ran Wi-Fi off through the dev stack) | earlier packages kept |

## 12. Limitations

- The default 0.5B model is small: it paraphrases poorly and sometimes repeats a step (for example `system.time` printed several times). The host's validation prevents wrong actions but cannot make it understand every wording.
- Several features are off by default and must be enabled by the user.
- No wake-word engine; no screen-understanding VLM; no cloud fallback by design.
- Evidence rests on one development machine.

## 13. Conclusion and future scope

The core claim, that a small local model can drive a useful desktop assistant when authorization and verification live outside the model, is supported by the acceptance evidence above for files, notes, workflows, scheduling, plugins, OCR, guarded input and browser actions. Future work: a human-voice acceptance with Wi-Fi off; Wi-Fi-off runs for scheduling and plugin permissions; a larger model tier when RAM allows; measured comparisons with other assistants.


## 14. Requirement status after round 3 (2026-11-13)

Classification: **HUD VERIFIED** = through the real native HUD; **PACKAGED VERIFIED** = through the real packaged launcher; **OFFLINE VERIFIED** = with the Wi-Fi radio off and 0 non-loopback connections from the D-ASK process tree. Final package: `dist/desktop/D-ASK-20261113T044615` (205 manifest files, `results/packaging/verify-20261113T044615` 26/26). The packaged Wi-Fi-off run used `D-ASK-20261113T042336` (same code except one evidence wording change in copy/rename).

| Requirement | Status | Evidence / gap |
|---|---|---|
| Local LLM, conversation, intent routing, planning, verification | HUD, PACKAGED, OFFLINE VERIFIED | package 26/26 online and offline (`results/offline-final/20261113T042633`) |
| Shared conversation context (last turns to the planner; "that"/"it" refer to the previous result) | INTEGRATED, HUD VERIFIED, PACKAGED VERIFIED | follow-up "Remember that" in the HUD (round 1) and in the package |
| Typed, provenance-preserving result passing between capabilities | INTEGRATED, HUD VERIFIED, PACKAGED VERIFIED, OFFLINE VERIFIED (knowledge->note/memory) | knowledge->note, plugin->memory, page->note, page->knowledge, scheduled workflow knowledge->note; destinations limited to note / memory / Notepad / web knowledge by design (inputs of actions stay grounded in request text) |
| Knowledge / RAG | HUD, PACKAGED, OFFLINE VERIFIED | |
| Research Mode, local | HUD, PACKAGED, OFFLINE VERIFIED | |
| Research Mode, optional online (named URLs, web collection, URL citations) | INTEGRATED, HUD VERIFIED (online by nature) | `round2-20261113T044042` Y5-Y7; no web search (only named pages) |
| File copy / rename / undo | INTEGRATED, HUD VERIFIED, OFFLINE VERIFIED (operations; offline outcome label fixed afterwards) | `round2-…044042` Y1 11/11; offline run 7/8 (UNVERIFIED label, files correct) before the wording fix; not in the package verification script |
| Windows control: Notepad (open+type), Calculator, Character Map | HUD VERIFIED, OFFLINE VERIFIED (Calculator, Character Map) | Notepad typing PACKAGED VERIFIED earlier (2026-11-12) |
| Plugins (install, permission refusal, grant, use, result -> memory) | HUD VERIFIED, OFFLINE VERIFIED | not in the package verification script |
| Browser automation (read; approved fill/click) | HUD VERIFIED (read this round; fill/click earlier) | online by nature |
| Memory | HUD, PACKAGED, OFFLINE VERIFIED | |
| Workflows + scheduler (incl. knowledge step and result passing in a scheduled run) | HUD VERIFIED, OFFLINE VERIFIED (round 1) | not in the package verification script |
| History recovery after a forced HUD kill | INTEGRATED, HUD VERIFIED, OFFLINE VERIFIED | recovered outcome shown after kill + full restart; owner-isolation preserved (daemon test) |
| Emergency Stop across long tasks / IPC | INTEGRATED, HUD VERIFIED (mid-research stop + resume, round 1), OFFLINE VERIFIED | code review this round; chain stops between parts (test) |
| Vision (UIA + OCR) | HUD VERIFIED earlier | no screen-understanding model (memory budget) |
| Voice: spoken multi-step and chained requests, offline | **PARTIAL** | harness ready (`approval-live-voice-chain.ps1`, offline wrapper `offline-voice-chain-acceptance.ps1`); needs a person at the microphone; single spoken question verified earlier |
| Packaged application with Wi-Fi off | PACKAGED + OFFLINE VERIFIED | 26/26, 0 non-loopback connections |
| Electron | removed | |
