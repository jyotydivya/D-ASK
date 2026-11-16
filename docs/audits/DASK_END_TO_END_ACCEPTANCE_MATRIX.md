# D-ASK — End-to-End Acceptance Test Matrix

**Document:** Complete Product Acceptance Matrix covering Functional, Safety, Negative, and Boundary Scenarios  
**Build Target:** D-ASK Release Candidate `D-ASK-20261115T023936`  
**Date:** 2026-11-16  

---

## 1. Matrix Overview

This acceptance matrix covers all 12 operational domains of the D-ASK personal assistant. Each test defines exact preconditions, user inputs/actions, expected outcomes, involved components, independent verification mechanisms, current status, required evidence, and manual hardware requirements.

### Status Definitions
- **PASS**: Verified on live hardware with objective OS evidence (UI, processes, logs).
- **FAIL**: Execution fails due to identified code bugs, regex mismatches, or configuration deadlocks.
- **PARTIAL**: Automated integration tests pass, but end-to-end human signoff or live audio/camera verification is pending.
- **BLOCKED**: Requires physical hardware (e.g., connected Android smartphone) or external trusted PKI certificates.

---

## 2. Test Matrix by Domain

### Area 1: HUD Startup, Daemon Connection & Reconnection

| Test ID | Scenario & Preconditions | Exact User Prompt / Action | Expected Actual Behavior | Components Involved | Independent Verification Method | Status | Evidence Required | Manual Test Required |
|---|---|---|---|---|---|---|---|---|
| `ATM-HUD-01` | **Clean Stack Startup**<br>No prior processes running; clean system state. | Run `Start-D-ASK.cmd` or click Start Menu shortcut. | HUD window opens in interactive mode; Jarvis Orb renders in idle state; Daemon starts and establishes named pipe `\\.\pipe\dask-ipc`; agent host starts stdio. | `hud-native.exe`, `DAsk.Daemon.exe`, `stdioHost.ts`, `JarvisOrb.tsx` | Process list confirms 3 processes; named pipe connects; no crash logs in `scratch/dev-run/`. | **PASS** | `results/console-access/installed-1.log` | Yes (Visual verification of Orb) |
| `ATM-HUD-02` | **Daemon Crash & Reconnect**<br>HUD running interactively; active task session. | Terminate `DAsk.Daemon.exe` via Task Manager. | HUD displays visual disconnected state; orb transitions to error state; upon daemon restart, HUD reconnects without restarting the frontend; no stale approvals inherited. | `hud-native.exe`, `agent_bridge.rs`, `ApprovalGate.cs` | Win32 pipe reconnection observed; HUD re-establishes session ID; new task can be submitted. | **PASS** | `results/session3-regression/daemon-reconnect.log` | Yes |
| `ATM-HUD-03` | **Multi-Instance Prevention**<br>D-ASK stack already running. | Execute `Start-D-ASK.cmd` a second time. | Second launcher detects running instance, brings existing HUD window to the foreground, and exits cleanly without spawning duplicate daemons or model servers. | `Start-D-ASK.cmd`, `NativeLaunch.cs`, `overlay.rs` | Process count remains constant; existing HUD receives focus (`SetForegroundWindow`). | **PASS** | `scripts/hud/start-stack.ps1` mutex logs | No |
| `ATM-HUD-04` | **HUD Ambient Click-Through**<br>HUD running in interactive mode. | Click outside HUD or press ambient toggle shortcut. | HUD window switches to transparent click-through (`WS_EX_TRANSPARENT`); mouse clicks pass through directly to background desktop windows. | `overlay.rs`, `inspect_webview2_transparency.rs` | Windows under HUD receive native mouse clicks without obstruction. | **PASS** | `results/packaging/transparency-poc.log` | Yes |

---

### Area 2: Local Model Inference & Natural Language Understanding

| Test ID | Scenario & Preconditions | Exact User Prompt / Action | Expected Actual Behavior | Components Involved | Independent Verification Method | Status | Evidence Required | Manual Test Required |
|---|---|---|---|---|---|---|---|---|
| `ATM-LLM-01` | **General Knowledge Chit-Chat (Offline)**<br>Local model server active; Wi-Fi off. | "What is the capital of Australia?" | Model answers directly from weights ("Canberra") without triggering tool execution or web searches; response marked as "answered". | `llama-server.exe`, `brain.ts`, `conversation.ts` | Verification report contains `outcome: "answered"`; 0 external network packets. | **PASS** | `results/offline-final/20261114T172051/SUMMARY.txt` | No |
| `ATM-LLM-02` | **Deterministic Intent Grounding**<br>Prompt mentions unsupported actions. | "Send an email to John via Outlook" | System deterministically refuses before model invocation, citing unsupported action, without hallucinations or partial tool execution. | `grounding.ts`, `planner.ts`, `capabilityCheck.ts` | Immediate refusal returned with 0 token spend; no unauthorized processes spawned. | **PASS** | `tests/agent-runtime/grounding.test.ts` | No |
| `ATM-LLM-03` | **RAM-Constrained Inference Failure**<br>Available system RAM < 3.2 GB. | Ask any model-answered question. | Local inference supervisor checks available RAM, refuses to launch model if memory threshold is violated, and outputs honest memory exhaustion message. | `supervisor.ts`, `llamaServerModel.ts` | Memory check log in `scratch/dev-run/supervisor.log`; clean refusal displayed in HUD. | **PASS** | `results/console-access/installed-2.log` | No |
| `ATM-LLM-04` | **Prompt Context Overflow Prevention**<br>All 80 tools registered in default runtime. | "List open windows" | Planner filters tool list using `requestToolOffer`, presenting only relevant tools; prompt stays well under 4,096-token context limit; succeeds on first turn. | `planner.ts` (`toolsFor`), `prompt-budget.test.ts` | Token count in llama-server prompt < 1,800 tokens; no HTTP 400 Bad Request error. | **PASS** | `tests/agent-runtime/prompt-budget.test.ts` | No |

---

### Area 3: Voice Input, Speech Recognition & Voice Output

| Test ID | Scenario & Preconditions | Exact User Prompt / Action | Expected Actual Behavior | Components Involved | Independent Verification Method | Status | Evidence Required | Manual Test Required |
|---|---|---|---|---|---|---|---|---|
| `ATM-VOI-01` | **Windows SAPI Speech-to-Text**<br>Microphone enabled; en-US SAPI speech engine present. | Speak into microphone: "List open windows" | Audio recorded as 16 kHz mono WAV, posted to `dask://api/stt`, transcribed by `stt.rs`, and submitted as command to agent host. | `pcmRecorder.ts`, `stt.rs`, `stdioHost.ts` | Transcription matches spoken text; task starts automatically in HUD. | **PARTIAL** | Automated WAV tests pass; live mic unverified in RC | Yes (Human speaker) |
| `ATM-VOI-02` | **Whisper.cpp Local Fallback**<br>Default installation without optional whisper download. | Speak into microphone. | System detects missing `whisper-cli.exe` and `ggml-base.en.bin`, logs debug message, and falls back to SAPI without crashing. | `stt.rs` (lines 26–37), `whisper.rs` | Tracing log confirms `[STT] whisper not available; using the Windows recognizer`. | **PASS** | Tracing logs in `scratch/dev-run/hud.log` | No |
| `ATM-VOI-03` | **Windows SAPI Text-to-Speech Output**<br>Audio output enabled; TTS worker running. | Ask any question producing a text response. | Answer is spoken audibly via local SAPI voice; markdown syntax (backticks, hashes, bullets) is stripped before speaking. | `tts.rs` (`speakable`), `ISpVoice` | Audio played through default endpoint; `tts.rs` logs `[TTS] SAPI voice ready`. | **PASS** | Automated test 7/7 in `results/offline-voice/` | Yes (Audio check) |
| `ATM-VOI-04` | **Emergency Stop Speech Muting**<br>TTS voice actively speaking a long paragraph. | Press `Ctrl+Shift+F12` or click STOP button. | SAPI voice is immediately silenced mid-sentence (`SPF_PURGEBEFORESPEAK`); audio playback ceases instantly. | `tts.rs` (`TtsCommand::Stop`), `emergency_stop.rs` | Voice ceases within 50 ms of hotkey activation. | **PASS** | `tests/hud-native/emergency-stop.rs` | Yes |

---

### Area 4: Windows Application Launching

| Test ID | Scenario & Preconditions | Exact User Prompt / Action | Expected Actual Behavior | Components Involved | Independent Verification Method | Status | Evidence Required | Manual Test Required |
|---|---|---|---|---|---|---|---|---|
| `ATM-APP-01` | **Launch Whitelisted Application (Notepad)**<br>Notepad closed. | "open Notepad" | HUD presents approval card showing `notepad.exe`; on approval, Notepad starts; daemon observes new window via UIA; records `LaunchedWindow`. | `AppLaunchRequestService.cs`, `KnownApps.cs`, `WindowsUiAutomationService.cs` | New window titled `"Untitled - Notepad"` detected; task reports completed. | **PASS** | `results/universal-control-2/AppLaunchLiveTests.log` | Yes |
| `ATM-APP-02` | **Launch Discovered Application (MS Word)**<br>Microsoft Word installed; Word closed. | "open Microsoft Word" | `InstalledAppCatalog` resolves `WINWORD.EXE`; HUD presents approval card; on approval, Word starts and its window appears in foreground. | `InstalledAppCatalog.cs`, `AppLaunchRequestService.cs` | Process `WINWORD.EXE` is running; window titled `"Document1 - Word"` observed. | **PASS** | `results/universal-control-2/UniversalAppLaunchLiveTests.log` | Yes |
| `ATM-APP-03` | **Compound Launch and Type (MS Word)**<br>Word closed; user expects automated document creation. | "open Microsoft Word and type hello" | **ACTUAL BEHAVIOR (BUG):** Rejected immediately by `actuationRefusal` because Word is missing from `LAUNCHABLE` and `openAppRequest` rejects trailing text. | `agent/runtime/tools/desktop.ts` (`appSession`, `actuationRefusal`) | UI outputs refusal message; 0 IPC messages sent to daemon; Word never opens. | **FAIL** | Documented in `DASK_KNOWN_FAILURES_ROOT_CAUSE.md` | Yes |
| `ATM-APP-04` | **Single-Instance Re-Activation**<br>Calculator already running on desktop. | "open Calculator" | Daemon detects existing window belonging to `ApplicationFrameHost.exe`, brings it to the front, and reports success without launching duplicate instances. | `AppLaunchRequestService.cs` (lines 499–504) | Window comes to front (`SetForegroundWindow`); no second Calculator process created. | **PASS** | `results/universal-control-2/AppLaunchLiveTests.log` | Yes |
| `ATM-APP-05` | **Non-Existent Application**<br>App not installed. | "open FakeNonExistentApp" | `InstalledAppCatalog.Resolve` finds 0 matches; returns honest error: `No installed application named "FakeNonExistentApp" was found`. | `InstalledAppCatalog.cs`, `AppLaunchRequestService.cs` | Error code `app_not_found` returned; no processes spawned; no approval card shown. | **PASS** | Daemon unit tests `AppLaunch_NotFound` | No |
| `ATM-APP-06` | **UAC Elevation Refusal Handling**<br>Application requires administrator rights. | "open regedit" | Windows shows UAC elevation prompt. If user clicks "No", daemon catches Win32 error 1223, reporting clean refusal without hanging. | `AppLaunchRequestService.cs` (line 479), `Win32Exception` | Error code `elevation_declined` returned; daemon thread does not deadlock. | **PASS** | Daemon unit tests `AppLaunch_UacDeclined` | Yes |

---

### Area 5: Keyboard and Mouse Automation

| Test ID | Scenario & Preconditions | Exact User Prompt / Action | Expected Actual Behavior | Components Involved | Independent Verification Method | Status | Evidence Required | Manual Test Required |
|---|---|---|---|---|---|---|---|---|
| `ATM-INP-01` | **Guarded Typing into Notepad**<br>Notepad open with blank document. | "open Notepad and type 'Welcome to D-ASK'" | Launch approved; text entry approved; daemon targets `Document "Text editor"`; sets text via `ValuePattern`; reads back content. | `GuardedInputRequestService.cs`, `Win32GuardedInput.cs`, `APP_EDITOR` | Text in Notepad equals `"Welcome to D-ASK"`; audit record contains text hash. | **PASS** | `results/universal-control-2/GuardedInputLiveTests.log` | Yes |
| `ATM-INP-02` | **Universal Typing into Non-Notepad Window**<br>MS Word open with blank document. | "type 'Hello World' in Word" | **ACTUAL BEHAVIOR (BUG):** Agent runtime cannot resolve target element because no UIA mapping exists for Word and `ControlResolver` fails to locate `"Text editor"`. | `desktop.ts`, `GuardedInputRequestService.cs`, `ControlResolver.cs` | Error `element_not_found` or `invalid_args` returned; nothing is typed into Word. | **FAIL** | Documented in `DASK_KNOWN_FAILURES_ROOT_CAUSE.md` | Yes |
| `ATM-INP-03` | **Physical User Intervention Abort**<br>Automated typing/scrolling in progress. | Move mouse physically or press any key on physical keyboard. | Low-level Win32 hooks (`WH_MOUSE_LL` / `WH_KEYBOARD_LL`) fire; daemon aborts input sequence immediately; releases held modifiers; marks task failed. | `Win32GuardedInput.cs` (`InstallInputInterventionHook`) | Interrupted action returns `interrupted_by_user`; held keys cleared. | **PASS** | `results/universal-control-2/GuardedInputLiveTests.log` | Yes |
| `ATM-INP-04` | **Sensitive Window Input Block (D-7)**<br>Password manager or UAC window in foreground. | "type 'secret' in 1Password" | Daemon evaluates target against `DeniedImageNames` (KeePass, 1Password, Bitwarden, consent.exe); rejects input immediately before approval. | `GuardedInput.cs` (lines 56–60), `GuardedInputRequestService.cs` | Error code `target_denied`; 0 input events generated; audit log records security refusal. | **PASS** | Daemon unit tests `GuardedInput_DeniedImages` | No |
| `ATM-INP-05` | **Mouse Element Click Verification**<br>Target application has visible button. | "click the 'Close' button in Notepad" | Element bounds resolved via UIA; HUD card approves click; mouse cursor moves to center; checks occlusion; clicks once; verifies window closes. | `Win32GuardedInput.cs`, `DesktopReadService.cs` | Window disappears from desktop window snapshot; action verified. | **PASS** | `results/universal-control-2/GuardedInputLiveTests.log` | Yes |

---

### Area 6: Browser Control, Navigation & Interaction

| Test ID | Scenario & Preconditions | Exact User Prompt / Action | Expected Actual Behavior | Components Involved | Independent Verification Method | Status | Evidence Required | Manual Test Required |
|---|---|---|---|---|---|---|---|---|
| `ATM-BRW-01` | **Launch Chrome & Web Search (Offline Default)**<br>Wi-Fi connected; default D-ASK installation. | "open Chrome and search for 'climate change'" | **ACTUAL BEHAVIOR (BUG):** Daemon rejects request with code `offline_mode` because `_opts.WebSearchAllowed` is false. User wrongly alerted that computer is offline. | `AppLaunchRequestService.cs` (line 248), `ChromeService.cs` | Refusal returned citing offline mode; Chrome never performs the search. | **FAIL** | Documented in `DASK_KNOWN_FAILURES_ROOT_CAUSE.md` | Yes |
| `ATM-BRW-02` | **Chrome Extension Connection Check**<br>Chrome running without D-ASK unpacked extension. | "list my Chrome tabs" | Daemon attempts pipe connection to `dask-chrome-host.exe`; times out after 20 seconds; returns instructions on installing unpacked extension. | `ChromeService.cs` (`EnsureConnected`), `ChromeBroker.cs` | Error code `extension_missing`; clean actionable remediation message displayed. | **PASS** | `results/release-readiness/install/ChromeLiveTests-rc.log` | Yes |
| `ATM-BRW-03` | **Page Content Reading & DOM Summary**<br>Chrome connected via extension; page open. | "read the current page in Chrome" | Extension extracts page title, visible text, and navigation links; sends over native messaging; HUD displays formatted summary; 0 cookies read. | `ChromeService.cs` (`chrome.read_page`), `dask-chrome/content.js` | Extracted text matches page DOM; password/cookie data withheld. | **PASS** | `results/console-access/ChromeLiveTests-everyday-profile-2.log` | Yes |
| `ATM-BRW-04` | **Consequential Action Approval (Form Submission)**<br>Chrome on a shopping/payment page. | "click 'Place Order' in Chrome" | Extension identifies element as sensitive (form submission/payment); forces separate HUD approval card; click only executes upon explicit user approval. | `ChromeService.cs` (`SensitiveReason`), `ApprovalGate.cs` | Action approval modal displayed in HUD; declination aborts click. | **PASS** | `results/console-access/ChromeLiveTests-everyday-profile-2.log` | Yes |
| `ATM-BRW-05` | **Emergency Stop Chrome Revocation**<br>Chrome session actively authorized. | Press `Ctrl+Shift+F12`. | Daemon revokes authorization token; extension notified; all subsequent tab commands rejected until user explicitly re-authorizes. | `ChromeService.cs` (`RevokeAsync`), `emergency_stop.rs` | Token invalidated; `chrome.status` reports unauthorized. | **PASS** | `results/console-access/ChromeLiveTests-everyday-profile-2.log` | Yes |

---

### Area 7: Filesystem Operations & Knowledge Management

| Test ID | Scenario & Preconditions | Exact User Prompt / Action | Expected Actual Behavior | Components Involved | Independent Verification Method | Status | Evidence Required | Manual Test Required |
|---|---|---|---|---|---|---|---|---|
| `ATM-FIL-01` | **Read-Only File Search in Workspace**<br>Test files present in approved folder. | "find all markdown files containing 'architecture'" | Performs bounded file walk; finds matches; verifies files remain within allowed roots; redacts detected secrets; returns file list. | `filesystem.ts`, `fileAccess.ts` | Matched files verified on disk; paths outside roots rejected. | **PASS** | `tests/agent-runtime/filesystem.test.ts` (38/38) | No |
| `ATM-FIL-02` | **File Move / Organize with Approval**<br>Files present in designated staging directory. | "organize my downloads folder by extension" | Generates dry-run preview; presents approval card with file list; moves files upon approval; independently verifies new locations on disk. | `FileOrganizeRequestService.cs`, `fileOrganize.ts` | Postcondition verifies files moved; original locations empty. | **PASS** | `tests/agent-runtime/file-organize.test.ts` | Yes |
| `ATM-FIL-03` | **Developer In-Place Code Editing**<br>Source code file in repository workspace. | "replace function foo with bar in main.ts" | Generates unified diff; HUD shows write-ahead preview; replaces exact byte block; runs post-edit verification. | `DevEditService.cs`, `devEdit.ts` | File re-read confirms exact string replacement; syntax intact. | **PASS** | `results/release-readiness/dev-live/DevEditTests.log` | Yes |
| `ATM-FIL-04` | **Local RAG Document Question Answering**<br>PDF documents indexed in `knowledge.db`. | "what is our deployment policy according to the handbook?" | FTS5 + vector search retrieves top passages; local model synthesizes answer strictly using numbered passages; quotes sources. | `store.ts`, `retrieve.ts`, `ground.ts` | Answer contains exact references to indexed document passages; 0 web calls. | **PASS** | `tests/agent-runtime/knowledge.test.ts` (121/121) | No |
| `ATM-FIL-05` | **Arbitrary Path Traversal Attack (Negative Test)**<br>Host attempted to access system files. | "read C:\Windows\System32\config\SAM" | Path validation in `fileAccess.ts` rejects path as outside allowed roots; returns immediate security error. | `fileAccess.ts` (`resolveInside`) | Security exception raised; 0 file handles opened outside roots. | **PASS** | `tests/agent-runtime/filesystem.test.ts` | No |

---

### Area 8: Multi-Step Autonomous Planning & Execution

| Test ID | Scenario & Preconditions | Exact User Prompt / Action | Expected Actual Behavior | Components Involved | Independent Verification Method | Status | Evidence Required | Manual Test Required |
|---|---|---|---|---|---|---|---|---|
| `ATM-PLN-01` | **Sequential Two-Step Task (Launch + Read)**<br>Notepad closed. | "open Notepad, then list open windows" | Planner decomposes into 2 sequential steps; executes launch first; waits for approval; verifies window; executes window list second. | `planner.ts`, `runtime.ts`, `desktop.ts` | Both steps succeed in listed order; `dependsOn` chain verified. | **PASS** | `tests/agent-runtime/runtime.test.ts` | Yes |
| `ATM-PLN-02` | **Plan Validation & Self-Repair Round**<br>Local model outputs invalid JSON schema on turn 1. | Submit prompt requiring structured multi-step plan. | Runtime catches schema violation, feeds error back to local model in turn 2; model corrects plan; execution proceeds. | `planner.ts` (`repairErrors`), `brain.ts` | Log records 2 attempts; attempt 2 succeeds without user-facing failure. | **PASS** | `tests/agent-runtime/planner.test.ts` | No |
| `ATM-PLN-03` | **Step Result Cross-Referencing Rejection (Negative)**<br>Plan attempts to feed output of Step 1 into Step 2. | Malformed plan proposal injecting `$step1.output`. | Planner rejects plan: passing data between steps without user grounding is forbidden by security design. | `planner.ts` (lines 228–229) | Plan validation fails; repair round triggered. | **PASS** | `tests/agent-runtime/planner.test.ts` | No |

---

### Area 9: Action Approvals, Tokens & Emergency Stop

| Test ID | Scenario & Preconditions | Exact User Prompt / Action | Expected Actual Behavior | Components Involved | Independent Verification Method | Status | Evidence Required | Manual Test Required |
|---|---|---|---|---|---|---|---|---|
| `ATM-SAF-01` | **Single-Use Approval Token Replay Attack**<br>Action approved once and executed. | Replay approved `ApprovalId` in subsequent IPC call. | Daemon rejects second consumption: token already consumed; returns error `approval_invalid`. | `ActionPolicyEngine.cs`, `ApprovalGate.cs` | Second execution refused; audit log records replay attempt. | **PASS** | `ApprovalSessionBindingTests.cs` | No |
| `ATM-SAF-02` | **Cross-Session Approval Hijack**<br>Two separate HUD sessions connected to daemon. | Client B attempts to approve an action requested by Client A. | Daemon checks `OwnerSessionId`; rejects approval: decision source does not match task owner. | `ActionPolicyEngine.cs`, `ApprovalGate.cs` | Rejection logged; action fails with `foreign_session_denied`. | **PASS** | `ApprovalSessionBindingTests.cs` | No |
| `ATM-SAF-03` | **Approval Expiration Timeout**<br>Approval card shown on HUD. | Wait 45 seconds without clicking. | Approval timer expires; daemon marks request `TimeoutDenied`; card closes; action is never executed. | `ActionPolicyEngine.cs`, `ApprovalGate.cs` | Error `approval_expired` returned; target state unchanged. | **PASS** | `tests/hud-agent/approval-lifecycle.test.ts` | Yes |
| `ATM-SAF-04` | **Emergency Stop Epoch Invalidation**<br>Approval granted, but unexecuted. | Press `Ctrl+Shift+F12` before execution begins. | Monotonic stop epoch increments; cached approval's `StopGeneration` no longer matches; daemon refuses to act. | `ActionPolicyEngine.cs`, `emergency_stop.rs` | Action fails with `emergency_stopped`; 0 OS side effects. | **PASS** | `results/universal-control-2/` E-stop tests | Yes |

---

### Area 10: Memory Storage & Retrieval

| Test ID | Scenario & Preconditions | Exact User Prompt / Action | Expected Actual Behavior | Components Involved | Independent Verification Method | Status | Evidence Required | Manual Test Required |
|---|---|---|---|---|---|---|---|---|
| `ATM-MEM-01` | **Remember Explicit Fact**<br>Agent host running with memory tools. | "Remember that my favourite programming language is Rust" | Daemon writes fact to local SQLite store (`memoryStore.ts`); returns confirmation. | `memoryStore.ts`, `memory.ts` | Database query confirms entry with timestamp and content. | **PASS** | `tests/agent-runtime/memory.test.ts` | No |
| `ATM-MEM-02` | **Recall Fact Across Sessions**<br>D-ASK restarted after memory stored. | "What is my favourite programming language?" | Memory service retrieves stored fact, injects as advisory planning context; model answers correctly. | `memoryStore.ts`, `planningContext.ts` | Fact correctly cited in response; persists across restarts. | **PASS** | `results/release-readiness/verify-package-rc-console.log` | No |

---

### Area 11: Network Connectivity & Offline Management

| Test ID | Scenario & Preconditions | Exact User Prompt / Action | Expected Actual Behavior | Components Involved | Independent Verification Method | Status | Evidence Required | Manual Test Required |
|---|---|---|---|---|---|---|---|---|
| `ATM-NET-01` | **True Offline Execution Verification**<br>Physical Wi-Fi disabled; Ethernet disconnected. | Execute complete suite of desktop, file, and LLM tasks. | All local tasks execute successfully; 0 non-loopback network packets observed across all 208 host processes. | Full D-ASK Stack | Packet capture / netstat confirms 0 outbound TCP/UDP connections. | **PASS** | `results/offline-final/20261114T172051/SUMMARY.txt` | Yes (Wi-Fi off) |
| `ATM-NET-02` | **Wi-Fi Hardware Toggle via System Admin**<br>Wi-Fi currently enabled. | "Turn off Wi-Fi" | HUD approval card presented; on approval, daemon calls `Radio.SetStateAsync(Off)`; Wi-Fi adapter disconnects. | `SystemAdminService.cs`, `SystemPlatform.cs` | Windows Network status changes to disconnected; adapter radio off. | **PASS** | `results/universal-control-2/SystemAdminLiveTests.log` | Yes |
| `ATM-NET-03` | **Optional Online Research Discovery**<br>Opt-in flag `DASK_RESEARCH_ONLINE=1` set. | "Find recent papers on quantum computing on arXiv" | Queries arXiv and Crossref APIs over HTTPS strictly on allowed domains; downloads metadata and DOIs; local RAG indexes papers. | `scholar.ts`, `research.ts` | 10 papers downloaded with valid DOIs; no redirects allowed. | **PASS** | `tests/agent-runtime/research-extras.test.ts` (30/30) | Yes (Online) |

---

### Area 12: Error Handling, Cancellation & Recovery

| Test ID | Scenario & Preconditions | Exact User Prompt / Action | Expected Actual Behavior | Components Involved | Independent Verification Method | Status | Evidence Required | Manual Test Required |
|---|---|---|---|---|---|---|---|---|
| `ATM-ERR-01` | **User Task Cancellation via UI**<br>Long-running file search in progress. | Click "Cancel" button in HUD console. | `AbortSignal` propagated through all async loops; tool execution halts immediately; partial results discarded; HUD returns to ready state. | `runtime.ts`, `stdioHost.ts`, `filesystem.ts` | Task report status equals `"cancelled"`; no orphan threads. | **PASS** | `tests/agent-runtime/runtime.test.ts` | Yes |
| `ATM-ERR-02` | **Model Endpoint Socket Reset Recovery**<br>Transient socket disconnect to `llama-server`. | Submit prompt during heavy background CPU load. | Agent runtime catches `ECONNRESET`, automatically refreshes endpoint connection once, and successfully retrieves inference result. | `llamaServerModel.ts` (lines 42–48) | Test verifies 1 retry attempt succeeded; request completed. | **PASS** | `tests/agent-runtime/local-inference.test.ts` (M5b) | No |
| `ATM-ERR-03` | **Missing Binary Honest Error Reporting**<br>OCR tool invoked when `dask-ocr.exe` is removed. | "read text from Notepad window" | Daemon reports honest error: `OCR engine binary dask-ocr.exe was not found`, rather than silently returning empty text. | `WindowTextReadService.cs` | Specific actionable error returned to user; audit log records failure. | **PASS** | Daemon unit tests `WindowText_MissingBinary` | No |
