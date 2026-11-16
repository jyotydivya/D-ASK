# D-ASK — Complete End-to-End Functional Coverage Matrix

**Audit Reference:** Complete Product Functional Coverage  
**Audited Release Target:** `D-ASK-20261115T023936`  
**Git Baseline:** Commit `6c3113b` on branch `main`  
**Date:** 2026-11-16  

---

## 1. Matrix Overview

This matrix evaluates every advertised and implemented capability across the entire D-ASK product codebase. 

In accordance with audit rules:
- **Implementation Status:** `Implemented` (code complete), `Partial` (restricted/hardcoded subsets), or `Missing` (unimplemented).
- **Real Execution Status:** `Real` (drives real Windows APIs/hardware), `Simulated` (synthetic test harness actions), `Mocked` (mocked subprocess outputs), or `Unknown`.
- **Automated Test Status:** `Passed`, `Failed`, or `Not tested`.
- **Installed HUD Status:** `Passed`, `Failed`, or `Not tested` (tested through the actual installed package at `%LOCALAPPDATA%\Programs\D-ASK`).

---

## 2. Complete Functional Coverage Matrix

| Capability | User-facing purpose | Implementation status | Real execution status | Automated test status | Installed HUD status | Evidence | Known limitations | Priority |
|---|---|---|---|---|---|---|---|---|
| **HUD Transparent Window** (`HUD-01`) | Provide transparent, floating assistant overlay | Implemented | Real | Passed | Passed | `inspect_webview2_transparency.rs`, `1-start.png` | None | Medium |
| **Ambient / Interactive Toggle** (`HUD-02`) | Click-through to desktop when idle, interactive on hover/click | Implemented | Real | Passed | Passed | `results/console-access/installed-2/` | Mode switches on hit-test or Esc | Medium |
| **3D Jarvis Orb Rendering** (`HUD-03`) | Visual holographic sphere reflecting assistant states | Implemented | Real | Passed | Passed | `orb.wgsl`, wgpu renderer logs | Requires hardware GPU / Vulkan support | Low |
| **Core Console Command Bar** (`HUD-04`) | Type natural-language commands directly into HUD | Implemented | Real | Passed | Passed | `console-access-live.ps1`, `installed-1` | Must be focused in interactive mode | Critical |
| **Action Approval Dialogs** (`HUD-05`) | Review and approve/decline sensitive actions | Partial | Simulated in tests | Passed | Not tested (Human) | `approval-lifecycle.test.ts` (97/97) | Automated test harnesses simulate clicks; live human acceptance unverified | Critical |
| **Emergency Stop (`Ctrl+Shift+F12`)** (`HUD-06`) | Panic hotkey to immediately halt all automation | Implemented | Real | Passed | Passed | `emergency_stop.rs`, `aligned-stops.ps1` | None | Critical |
| **HUD Liveness Heartbeat** (`HUD-07`) | Invalidate approvals if HUD crashes/disconnects | Implemented | Real | Passed | Passed | `liveness.rs`, `ApprovalGate.cs` | 5-second lease window | High |
| **Local LLM Execution** (`AI-01`) | Run private inference on local Qwen 2.5 model | Implemented | Real | Passed | Passed | `llama-server.exe`, `local-inference.test.ts` | 4,096-token context limit | Critical |
| **Physical RAM Inference Guard** (`AI-02`) | Prevent OOM crashes by checking available memory | Implemented | Real | Passed | Passed | `supervisor.ts`, `installed-2.log` | Refuses inference if available RAM < 3.2 GB | High |
| **Deterministic Intent Grounding** (`AI-03`) | Parse arguments deterministically before LLM call | Implemented | Real | Passed | Passed | `grounding.test.ts` (82/82) | Brittle regular expressions; rejects compound commands | Critical |
| **Prompt Budgeting** (`AI-04`) | Keep plan prompts within context window | Implemented | Real | Passed | Passed | `prompt-budget.test.ts` (10/10) | Filters out unmentioned tools | High |
| **Two-Turn Plan Generation** (`AI-05`) | Generate structured plans with self-repair | Implemented | Real | Passed | Passed | `planner.test.ts` (36/36) | Limited to 2 turns; fails on complex multi-step reasoning | High |
| **Sequential Task Execution** (`AI-06`) | Execute plan steps one by one | Implemented | Real | Passed | Passed | `runtime.test.ts` (45/45) | No parallel execution; passing data between steps is forbidden | Medium |
| **Independent Verifier** (`AI-07`) | Verify actual external OS state changes | Implemented | Real | Passed | Passed | `verifier.ts` checks | Requires deterministic postconditions | High |
| **Local Vector Embeddings** (`AI-08`) | Offline semantic search via bge-small | Implemented | Real | Passed | Passed | `embedder.ts`, `bge-small-en-v1.5` | CPU only; bounded memory | Medium |
| **Fixed Whitelist App Launch** (`APP-01`) | Open Notepad, Calculator, Character Map | Implemented | Real | Passed | Passed | `AppLaunchLiveTests.log` | Strictly limited to 3 applications | Critical |
| **Discovered App Launch** (`APP-02`) | Open any installed app by name (Word, VS Code) | Implemented | Real | Passed | Passed | `UniversalAppLaunchLiveTests.log` | Isolated launch only; fails on compound commands | Critical |
| **Compound App Launch + Type** (`APP-03`) | "Open Word and type hello" in one prompt | Missing | Real | Failed | Failed | Documented in `DASK_KNOWN_FAILURES_ROOT_CAUSE.md` | Fails at regex parsing; returns static actuation refusal | Critical |
| **Window Post-Launch Verification** (`APP-04`) | Confirm new window appeared before reporting success | Implemented | Real | Passed | Passed | `AppLaunchRequestService.cs` UIA wait | Fails if app starts minimized to system tray | High |
| **Single-Instance Bring-to-Front** (`APP-05`) | Focus existing window if app already running | Implemented | Real | Passed | Passed | `AppLaunchRequestService.cs` (line 502) | Requires matching process image name | Medium |
| **Windows Settings Deep-Link** (`APP-06`) | Open specific Windows Settings pages | Implemented | Real | Passed | Passed | `AppLaunchRequestService.cs` (`open_settings`) | Fixed table of 12 settings pages only | Low |
| **Targeted App Launch (Search/Folder)** (`APP-07`) | Open browser with query or VS Code with folder | Partial | Real | Passed | Failed (Search) | `AppLaunchRequestService.cs` (line 248) | Folder open works; web search fails due to offline policy lock | High |
| **Desktop Window Listing** (`INP-01`) | List all open top-level windows | Implemented | Real | Passed | Passed | `desktop.list_windows`, live UIA tests | None | Medium |
| **Window UI Tree Inspection** (`INP-02`) | Inspect controls inside a named window | Implemented | Real | Passed | Passed | `desktop.inspect_window` | Depth capped at 12, max 600 nodes | Medium |
| **Offline Desktop OCR Vision** (`INP-03`) | Read text from a window using on-device OCR | Implemented | Real | Passed | Passed | `dask-ocr.exe`, `WindowTextReadService.cs` | Requires visible window; occluded text unread | High |
| **Window State Management** (`INP-04`) | Minimize, maximize, restore, focus windows | Implemented | Real | Passed | Passed | `WindowOperationExecutor.cs` | Win32 top-level windows only | High |
| **Guarded Mouse Click** (`INP-05`) | Click named UI buttons or links | Implemented | Real | Passed | Passed | `GuardedInputLiveTests.log` | Must resolve to single visible UIA element | High |
| **Guarded Drag & Scroll** (`INP-06`) | Drag elements and scroll containers | Implemented | Real | Passed | Passed | `GuardedInputLiveTests.log` | Scroll capped at 10 notches per step | Medium |
| **Notepad Text Entry** (`INP-07`) | Type text into Notepad | Implemented | Real | Passed | Passed | `GuardedInputLiveTests.log` | Binds strictly to Document "Text editor" via ValuePattern | Critical |
| **Universal Focused Text Entry** (`INP-08`) | Type text into Word, WordPad, browsers, terminals | Missing | Real | Failed | Failed | Documented in `DASK_SIMULATED_AND_UNIMPLEMENTED_FEATURES.md` | No universal focus typing exists; fails on non-Notepad apps | Critical |
| **Physical Intervention Abort** (`INP-09`) | Stop automation if user touches mouse/keyboard | Implemented | Real | Passed | Passed | `Win32GuardedInput.cs` low-level hooks | None | Critical |
| **Sensitive Window Shield** (`INP-10`) | Block input into password managers and UAC | Implemented | Real | Passed | Passed | `DeniedImageNames` (1Password, KeePass) | None | Critical |
| **Clipboard Read / Write** (`INP-11`) | Copy and paste text via Windows clipboard | Implemented | Real | Passed | Passed | `ClipboardService.cs` | Text > 1,900 chars refused; secrets redacted | Medium |
| **Legacy Python Desktop Input** (`INP-12`) | PyAutoGUI automation script | Missing | Stubbed | Not tested | Not tested | Blocked by `BLOCKED_ACTUATION_TOOLS` | Legacy code; never executed in production | Low |
| **Chrome Extension Connection** (`BRW-01`) | Connect to everyday Chrome via Native Messaging | Implemented | Real | Passed | Passed | `ChromeLiveTests-rc.log` | Requires manual unpacked extension loading | Critical |
| **Chrome Session Authorization** (`BRW-02`) | Authorize D-ASK to control Chrome | Implemented | Real | Passed | Passed | `ChromeService.cs` (`chrome.authorize`) | 2-hour lease; revoked on Emergency Stop | High |
| **Chrome Tab Management** (`BRW-03`) | List, switch, open, and close Chrome tabs | Implemented | Real | Passed | Passed | `ChromeLiveTests-everyday-profile-2.log` | Cannot access private/incognito tabs | High |
| **Web Page DOM Reading** (`BRW-04`) | Read visible page text and links in Chrome | Implemented | Real | Passed | Passed | `chrome.read_page` | Capped at 3,000 characters; 0 cookies read | High |
| **Web Element Interaction** (`BRW-05`) | Click links and fill text fields in Chrome | Implemented | Real | Passed | Passed | `chrome.click`, `chrome.fill` | Never fills password or credit card fields | High |
| **Consequential Web Action Approval** (`BRW-06`) | Approve payments, submissions, deletions | Implemented | Real | Passed | Passed | `SensitiveReason`, `ChromeService.cs` | Requires separate explicit approval card | Critical |
| **Web Search via Chrome** (`BRW-07`) | "Open Chrome and search for news" | Broken | Real | Failed | Failed | `AppLaunchRequestService.cs` (line 248) | Blocked by default offline policy (`offline_mode`) | Critical |
| **Headless Playwright Engine** (`BRW-08`) | Background headless browser automation | Missing | Real | Not tested | Not tested | `playwrightEngine.ts` unbundled in runtime | File exists in repo but is not registered | Low |
| **Workspace File Search** (`FIL-01`) | Find files by name pattern | Implemented | Real | Passed | Passed | `filesystem.test.ts` (38/38) | Confined strictly to allowed folder roots | High |
| **File Text Grep** (`FIL-02`) | Search file contents for matching lines | Implemented | Real | Passed | Passed | `filesystem.test.ts` | Skips binary and excluded files | High |
| **File Reading & Secret Redaction** (`FIL-03`) | Read document contents safely | Implemented | Real | Passed | Passed | `filesystem.read` | Capped at 500 KB; redacts API keys/passwords | High |
| **Two-Phase File Organization** (`FIL-04`) | Organize folder with preview and undo | Implemented | Real | Passed | Passed | `file-organize.test.ts` | Only inside approved FileOrganizeRoots | Medium |
| **Structured Note Creation** (`FIL-05`) | Create markdown notes in Documents | Implemented | Real | Passed | Passed | `NoteCreateRequestService.cs` | Written strictly to Documents\D-ASK\Notes | Medium |
| **Developer In-Place Code Editing** (`FIL-06`) | Find-and-replace code blocks with diff | Implemented | Real | Passed | Passed | `DevEditTests.log` | Diffs > 3,500 chars refused; dev roots only | High |
| **Native Word Document Creation** (`FIL-07`) | Create .docx files via Office COM | Implemented | Real | Passed | Passed | `OfficeDocumentService.cs` (`Word.Application`) | Requires user to say "create a word document" | High |
| **Native Excel Workbook Creation** (`FIL-08`) | Create .xlsx files via Office COM | Implemented | Real | Passed | Passed | `OfficeDocumentService.cs` (`Excel.Application`) | Requires user to say "create an excel workbook" | High |
| **Local Knowledge Base RAG** (`FIL-09`) | Offline semantic search over indexed files | Implemented | Real | Passed | Passed | `knowledge.test.ts` (121/121) | Files must be indexed first ("index folder as name") | High |
| **Scanned PDF OCR Indexing** (`FIL-10`) | Index image-only PDFs with Windows OCR | Implemented | Real | Passed | Passed | `knowledge-ocr.test.ts` (10/10) | Requires Windows.Data.Pdf support | Medium |
| **Dataset Analysis** (`FIL-11`) | Offline statistics and SVG chart generation | Implemented | Real | Passed | Passed | `dataset.ts`, `research-extras.test.ts` | CSV/TSV <= 50 MB in allowed folders | Medium |
| **Optional Online Research** (`FIL-12`) | Search papers on arXiv and Crossref | Implemented | Real | Passed | Not tested (Offline) | `scholar.ts`, `research-extras.test.ts` | Off by default; requires DASK_RESEARCH_ONLINE=1 | Low |
| **Windows SAPI Speech-to-Text** (`VOI-01`) | Transcribe voice from microphone | Implemented | Real | Passed (WAV) | Not tested (Live) | `stt.rs`, `offline-voice-acceptance.ps1` | Tested with audio fixtures; live mic unverified | High |
| **Whisper.cpp Local STT** (`VOI-02`) | Whisper model voice transcription | Missing | Real | Not tested | Not tested | `whisper.rs` | Binaries and weights not provisioned in package | Medium |
| **Dictated Quote Normalization** (`VOI-03`) | Convert "quote ... unquote" to quotes | Implemented | Real | Passed | Passed | `stt.rs` (`normalize_quotes`) | Odd quote counts dropped | Medium |
| **Windows SAPI Text-to-Speech** (`VOI-04`) | Speak assistant answers aloud | Implemented | Real | Passed | Passed | `tts.rs`, `ISpVoice` | Strips markdown symbols before speaking | High |
| **Emergency Stop Speech Muting** (`VOI-05`) | Silence voice immediately on stop | Implemented | Real | Passed | Passed | `tts.rs` (`SPF_PURGEBEFORESPEAK`) | Stops audio within 50 ms | High |
| **Continuous Background Wake-Word** (`VOI-06`) | Listen for "Jarvis" or "D-ASK" | Missing | Real | Not tested | Not tested | None | No background wake-word listening exists | Medium |
| **Process Listing & Detail Query** (`SYS-01`) | List processes ordered by memory | Implemented | Real | Passed | Passed | `system.list_processes` | Shows largest memory consumers | Medium |
| **Guarded Process Termination** (`SYS-02`) | Kill running programs after approval | Implemented | Real | Passed | Passed | `SystemAdminLiveTests.log` | Protected OS/security/D-ASK processes refused | High |
| **Windows Service Control** (`SYS-03`) | Query and start/stop Windows services | Implemented | Real | Passed | Passed | `SystemAdminService.cs` | Administrator services refused by Windows UAC | Medium |
| **Network & Radio Status** (`SYS-04`) | Check Wi-Fi SSID and radio states | Implemented | Real | Passed | Passed | `SystemPlatform.cs` | Queries Windows Runtime Radio APIs | Medium |
| **Wi-Fi & Bluetooth Radio Toggle** (`SYS-05`) | Turn Wi-Fi/Bluetooth on or off | Implemented | Real | Passed | Passed | `SystemAdminLiveTests.log` | Radio state changes after HUD approval | High |
| **System Audio Volume Control** (`SYS-06`) | Query/set volume percentage and mute | Implemented | Real | Passed | Passed | `results/console-access/installed-new-tools/` | Uses Core Audio IAudioEndpointVolume | High |
| **Display Mode & Resolution** (`SYS-07`) | Change screen resolution | Implemented | Real | Passed | Passed | `DisplayModeLiveTests.log` | 15-second auto-rollback confirmation | High |
| **Screen Brightness Control** (`SYS-08`) | Adjust display backlight percentage | Implemented | Real | Passed | Passed | `SystemPlatform.cs` (WMI/DDC-CI) | Not supported on external desktop monitors without DDC | Medium |
| **Windows Startup App Toggle** (`SYS-09`) | Enable/disable startup programs | Implemented | Real | Passed | Passed | `SystemAdminService.cs` | Current-user registry Run keys only | Medium |
| **Scheduled Power Actions** (`SYS-10`) | Schedule restart or shutdown | Implemented | Real | Passed | Passed | `SystemAdminLiveTests.log` | Min 30 s delay; E-Stop aborts via shutdown.exe /a | High |
| **ADB Device Discovery** (`AND-01`) | List connected Android devices | Partial | Mocked | Passed (Mock) | Failed (Missing adb) | `installed-new-tools/results.json` | Tested against mock output; unverified on real phone | High |
| **ADB Device Telemetry** (`AND-02`) | Query battery and storage on phone | Partial | Mocked | Passed (Mock) | Not tested | `AndroidTests.cs` | Requires authorized USB debugging | Medium |
| **Wireless Debugging Connect** (`AND-03`) | Pair Android device over Wi-Fi | Partial | Mocked | Passed (Mock) | Not tested | `AndroidService.cs` | Private IPv4 addresses only | Medium |
| **ADB File Push / Pull** (`AND-04`) | Transfer files to/from phone | Partial | Mocked | Passed (Mock) | Not tested | `AndroidService.cs` | Restricted to Documents\D-ASK and /sdcard/ | High |
| **Fixed Android Commands** (`AND-05`) | Send Home, Back, Lock, Wake to phone | Partial | Mocked | Passed (Mock) | Not tested | `AndroidService.cs` | 6 fixed commands; no arbitrary shell execution | Medium |
| **Fact Storage in Memory** (`MEM-01`) | Remember facts in SQLite database | Implemented | Real | Passed | Passed | `memoryStore.ts`, `memory.test.ts` | Local SQLite database only | High |
| **Memory Recall & Advisory Context** (`MEM-02`) | Recall stored facts across restarts | Implemented | Real | Passed | Passed | `verify-package-rc-console.log` | Advisory context only; never changes domains | High |
| **Memory Deletion** (`MEM-03`) | Forget specific facts | Implemented | Real | Passed | Passed | `memoryStore.ts` | Permanent deletion from SQLite | Medium |
| **Workflow Scheduling** (`WFL-01`) | Store and run multi-step routines | Implemented | Real | Passed | Passed | `WorkflowService.cs` | Stored in daemon SQLite database | Medium |
| **Canonical Action Hash & Signing** (`SAF-01`) | Canonicalize JSON and hash action parameters | Implemented | Real | Passed | Passed | `CanonicalJson.cs`, `ActionPolicyEngine.cs` | Parameters capped at 2,000 characters | Critical |
| **Single-Use Approval Tokens** (`SAF-02`) | Consume approval token once | Implemented | Real | Passed | Passed | `ApprovalSessionBindingTests.cs` | Replay attempts fail immediately | Critical |
| **Owner-Session Binding** (`SAF-03`) | Restrict approval to originating HUD session | Implemented | Real | Passed | Passed | `ApprovalSessionBindingTests.cs` | Foreign sessions cannot approve | Critical |
| **Target Process & HWND Validation** (`SAF-04`) | Re-verify window identity before input | Implemented | Real | Passed | Passed | `GuardedInputRequestService.cs` | Window title or PID mismatch aborts action | Critical |
| **Write-Ahead Audit Journaling** (`SAF-05`) | Persist audit record before OS actuation | Implemented | Real | Passed | Passed | `execution-evidence.jsonl` | Execution refused if journal write fails | Critical |
| **Standalone Package Bundle** (`PKG-01`) | Self-contained release folder | Implemented | Real | Passed | Passed | `D-ASK-20261115T023936` (~4 GB) | Bundles all runtime dependencies and weights | High |
| **One-Click User Installer** (`PKG-02`) | Install-D-ASK.ps1 script | Implemented | Real | Passed | Passed | `install-user.log` | Installs to %LOCALAPPDATA%\Programs\D-ASK | High |
| **Integrity Manifest Verification** (`PKG-03`) | SHA-256 validation of all files | Implemented | Real | Passed | Passed | `package-manifest.json` | 218 files verified on startup | High |
| **Authenticode Code Signing** (`PKG-04`) | Sign binaries with trusted certificate | Partial | Policy only | Passed (Policy) | Not tested (No cert) | `sign-policy.ps1` (7/7) | 0/9 D-ASK binaries signed; lacks public EV/OV cert | Critical |
