# D-ASK — Product Capability Inventory and Architectural Trace Audit

**Audit Date:** 2026-11-16  
**Audited Target:** D-ASK Release Candidate `D-ASK-20261115T023936`  
**Git Reference:** Branch `main`, Commit `6c3113b`  
**Execution Context:** Windows 11 Enterprise (x64), Local Offline Architecture  

---

## 1. Executive Summary & Audit Scope

This document provides a comprehensive, component-by-component inventory of all intended and implemented capabilities in the **D-ASK** personal AI assistant. 

Following reported manual verification failures—specifically involving Microsoft Word execution/typing and Google Chrome launching/searching—this audit inspects the full codebase across TypeScript/Node.js, C# (.NET 8 Daemon), Rust (HUD Native), and C++ binaries to establish the true operational status of every product feature.

### Classification Categories

In accordance with audit guidelines, capabilities are strictly classified into one of six mutually exclusive states. Code presence or unit test execution does not constitute verification:

1. **`IMPLEMENTED_AND_VERIFIED`**: Full end-to-end execution path exists, and the feature has been verified on live Windows hardware with genuine OS observations (window appearances, UIA modifications, process lifecycles).
2. **`IMPLEMENTED_BUT_UNVERIFIED`**: Full production code exists across all layers (HUD, Host, Daemon), but verification has only been performed via automated mocks, synthetic test harnesses, or without required external physical devices/certificates.
3. **`PARTIALLY_IMPLEMENTED`**: Feature is functional for a restricted, hardcoded subset of targets (e.g., Notepad only) but completely unhandled or blocked for general targets.
4. **`SIMULATED`**: The UI or test harness displays success or simulates an interaction, but the underlying OS operation is stubbed, bypassed, or mocked.
5. **`NOT_IMPLEMENTED`**: Feature is defined in design docs, user interfaces, or legacy prototypes, but has no execution pathway in the production native daemon and agent host.
6. **`BROKEN`**: The capability was intended to function, but code bugs, regex mismatches, policy conflicts, or unhandled exceptions cause it to fail during normal user workflows.

---

## 2. Complete Capability Inventory

### 2.1. Core Shell, Windowing & HUD Subsystem

| Capability ID | Feature Description | Classification | Implementation Components | Verification Evidence & Audit Findings |
|---|---|---|---|---|
| `CAP-HUD-01` | Transparent, click-through overlay window | `IMPLEMENTED_AND_VERIFIED` | `src/hud-native/src/overlay.rs`, `src/hud-native/src/main.rs` | Win32 `WS_EX_LAYERED`, `WS_EX_TRANSPARENT`. DwmExtendFrameIntoClientArea verified via `inspect_webview2_transparency.rs`. |
| `CAP-HUD-02` | Interactive/Ambient mode toggle | `IMPLEMENTED_AND_VERIFIED` | `src/hud-native/src/render/interaction.rs` | Hit-test tracking removes click-through when mouse enters HUD controls; verified in round-3 console tests. |
| `CAP-HUD-03` | Hardware-accelerated 3D Jarvis Orb rendering | `IMPLEMENTED_AND_VERIFIED` | `src/hud-native/src/render/orb_renderer.rs`, `orb.wgsl` | wgpu rendering pipeline with custom WGSL shaders; states (idle, listening, thinking, speaking, error) verified. |
| `CAP-HUD-04` | Command Bar / Core Console Input | `IMPLEMENTED_AND_VERIFIED` | `app/components/JarvisOrb.tsx`, `src/hud-native/src/main.rs` | Interactive prompt input directly attached to AgentHost stdio bridge. Fix in Round 3 restored input focus. |
| `CAP-HUD-05` | Action Approval Modal Dialogs | `PARTIALLY_IMPLEMENTED` | `src/hud-native/src/approval_fixture.rs`, `agent/host/desktopBridge.ts` | Approval cards render properly, but automated tests use simulated pipe injections. Genuine human-in-the-loop click acceptance remains unverified. |
| `CAP-HUD-06` | Global Emergency Stop (`Ctrl+Shift+F12`) | `IMPLEMENTED_AND_VERIFIED` | `src/hud-native/src/state/emergency_stop.rs` | Low-level Win32 keyboard thread sets atomic monotonic stop latch, increments epoch, and drains IPC pipes. |
| `CAP-HUD-07` | Liveness Heartbeat & Lease Renewal | `IMPLEMENTED_AND_VERIFIED` | `src/hud-native/src/state/liveness.rs`, `src/DAsk.Daemon/Automation/Policy/ApprovalGate.cs` | 5-second lease ping between HUD and Daemon. Daemon invalidates pending approvals if HUD disconnects. |

---

### 2.2. Local Inference & Natural Language Understanding

| Capability ID | Feature Description | Classification | Implementation Components | Verification Evidence & Audit Findings |
|---|---|---|---|---|
| `CAP-LLM-01` | Pinned Local Model Execution (`llama-server.exe`) | `IMPLEMENTED_AND_VERIFIED` | `agent/runtime/inference/llamaServerModel.ts`, `supervisor.ts` | Vulkan/CPU `llama-server.exe` managed with per-host PID files and `--offline` flag. Tested on Qwen 2.5 0.5B / 1.5B GGUF. |
| `CAP-LLM-02` | Deterministic Request Parsing & Facet Extraction | `IMPLEMENTED_AND_VERIFIED` | `agent/runtime/grounding.ts`, `agent/runtime/tools/*.ts` | Extracts argument domains, intent boundaries, and constraints deterministically before LLM invocation. |
| `CAP-LLM-03` | Constrained Plan Proposal & Schema Enforcement | `IMPLEMENTED_AND_VERIFIED` | `agent/runtime/planner.ts`, `agent/runtime/brain.ts` | 2-turn plan generation with schema validation and repair rounds. Off-domain arguments rejected. |
| `CAP-LLM-04` | Local Embeddings Generation | `IMPLEMENTED_AND_VERIFIED` | `agent/runtime/knowledge/embedder.ts` | Pinned `bge-small-en-v1.5` GGUF loaded via CPU instance of llama-server for offline semantic indexing. |
| `CAP-LLM-05` | Freeform Conversational Chit-Chat | `IMPLEMENTED_AND_VERIFIED` | `agent/runtime/conversation.ts`, `brain.ts` | Answers general knowledge prompts directly via local model when no tools are requested. |
| `CAP-LLM-06` | Multi-Agent Orchestration Engine | `NOT_IMPLEMENTED` | `agent/orchestrator.ts`, `agent/blackboard.ts` | Legacy prototype files exist in `agent/` but are completely detached from production native runtime. |

---

### 2.3. Speech, Audio & Voice Interaction

| Capability ID | Feature Description | Classification | Implementation Components | Verification Evidence & Audit Findings |
|---|---|---|---|---|
| `CAP-VOI-01` | Offline Speech-to-Text via Windows SAPI | `IMPLEMENTED_BUT_UNVERIFIED` | `src/hud-native/src/stt.rs` | Uses Win32 `ISpRecognizer` on dedicated STA thread. Tested with automated WAV files; unverified with real user speech in release build. |
| `CAP-VOI-02` | Offline Speech-to-Text via Whisper.cpp | `NOT_IMPLEMENTED` | `src/hud-native/src/whisper.rs`, `scripts/inference/fetch-whisper.mjs` | Whisper fallback logic exists in code, but neither `whisper-cli.exe` nor `ggml-base.en.bin` are provisioned in the repository or package. |
| `CAP-VOI-03` | Offline Text-to-Speech via Windows SAPI | `IMPLEMENTED_AND_VERIFIED` | `src/hud-native/src/tts.rs` | Uses Win32 `ISpVoice` with `SPF_PURGEBEFORESPEAK`. Verified in automated audio tests (`tts.speak("D-ASK offline voice test")`). |
| `CAP-VOI-04` | Voice Gating & Microphone Wake-Word | `PARTIALLY_IMPLEMENTED` | `src/hud-native/src/voice_gate.rs`, `lib/voiceCommand.ts` | Energy threshold and quote normalization exist, but background continuous wake-word listening is unverified on live microphones. |

---

### 2.4. Windows Application Lifecycle & Launching

| Capability ID | Feature Description | Classification | Implementation Components | Verification Evidence & Audit Findings |
|---|---|---|---|---|
| `CAP-APP-01` | Fixed Whitelist Application Launch (Notepad, Calculator, Charmap) | `IMPLEMENTED_AND_VERIFIED` | `src/DAsk.Daemon/Automation/Desktop/AppLaunchRequestService.cs`, `KnownApps.cs` | Win32 `CreateProcess` (no shell), post-launch window identity verification via UIA, records `LaunchedWindow`. Verified in live tests. |
| `CAP-APP-02` | Discovered Applications Launch via Start Menu / MSIX Catalog | `IMPLEMENTED_AND_VERIFIED` | `src/DAsk.Daemon/Automation/Desktop/InstalledAppCatalog.cs`, `AppActivation.cs` | Discovers `.lnk` shortcuts, registry `App Paths`, and Store apps (`IApplicationActivationManager`). Verified for isolated "open Word" or "open VS Code". |
| `CAP-APP-03` | Compound App Launch + Typing (`"open Word and type hello"`) | `BROKEN` | `agent/runtime/tools/desktop.ts` (`appSession`, `openAppRequest`, `OPEN_ANY`) | `appSession` only parses Notepad/Calc/Charmap. `openAppRequest` rejects trailing text. Falls through to `actuationRefusal`. Request refused up front! |
| `CAP-APP-04` | Single-Instance Application Bring-to-Front | `IMPLEMENTED_AND_VERIFIED` | `src/DAsk.Daemon/Automation/Desktop/AppLaunchRequestService.cs` (lines 499–504) | If target app is already running, detects foreground window matching exe name and reports success. |
| `CAP-APP-05` | Windows Settings Direct Navigation | `IMPLEMENTED_AND_VERIFIED` | `src/DAsk.Daemon/Automation/Desktop/AppLaunchRequestService.cs` (`desktop.open_settings`) | Launches canonical `ms-settings:` URIs from a fixed table (Display, Sound, Network, Bluetooth). |
| `CAP-APP-06` | UAC Elevation Handling | `IMPLEMENTED_AND_VERIFIED` | `AppLaunchRequestService.cs` (lines 478–483) | Catches Win32Exception error 1223 (ERROR_CANCELLED) if user declines UAC, reporting honest refusal without hanging. |

---

### 2.5. Desktop Automation & Input Injection (Mouse & Keyboard)

| Capability ID | Feature Description | Classification | Implementation Components | Verification Evidence & Audit Findings |
|---|---|---|---|---|
| `CAP-INP-01` | UI Automation Target Element Resolution | `IMPLEMENTED_AND_VERIFIED` | `src/DAsk.Daemon/Automation/Input/GuardedInput.cs`, `WindowsUiAutomationService.cs` | Traverses UIA tree to depth 12, max 600 nodes. Resolves control bounds and SHA-256 path hash. |
| `CAP-INP-02` | Guarded Mouse Click / Double Click / Right Click | `IMPLEMENTED_AND_VERIFIED` | `src/DAsk.Daemon/Automation/Input/Win32GuardedInput.cs` | Derives click point from element center; checks occlusion; verifies foreground before clicking. Tested on real UI. |
| `CAP-INP-03` | Guarded Text Entry into Notepad | `IMPLEMENTED_AND_VERIFIED` | `agent/runtime/tools/desktop.ts`, `src/DAsk.Daemon/Automation/Input/GuardedInput.cs` | Specifically binds to Notepad's `Document` control named `"Text editor"` using `ValuePattern`. Verified end-to-end. |
| `CAP-INP-04` | Universal Text Entry into Non-Notepad Applications (MS Word, WordPad, Browsers) | `NOT_IMPLEMENTED` | `agent/runtime/tools/desktop.ts`, `GuardedInput.cs` | No UIA Document mapping exists for MS Word or other apps. Generic focused text entry without hardcoded element names is completely missing. |
| `CAP-INP-05` | Physical Input Intervention Safeguard | `IMPLEMENTED_AND_VERIFIED` | `src/DAsk.Daemon/Automation/Input/Win32GuardedInput.cs` | Low-level Win32 hooks (`WH_MOUSE_LL`, `WH_KEYBOARD_LL`) abort automated input instantly if the physical user moves mouse or presses a key. |
| `CAP-INP-06` | Legacy Mouse/Keyboard Automation via Python / PyAutoGUI | `SIMULATED` / `DEPRECATED` | `lib/agent/tools/desktop/mouseKeyboard.ts`, `mouse_keyboard.py` | Legacy Python sidecar script with hardcoded coordinates. Disabled by `BLOCKED_ACTUATION_TOOLS` in `pcAgent.ts`. |
| `CAP-INP-07` | Window State Management (Focus, Minimize, Maximize, Restore) | `IMPLEMENTED_AND_VERIFIED` | `src/DAsk.Daemon/Automation/Desktop/WindowOperationExecutor.cs` | Safe Win32 `ShowWindow` / `SetForegroundWindow` calls bound to verified HWNDs after single-use approval. |

---

### 2.6. Browser Control & Web Automation

| Capability ID | Feature Description | Classification | Implementation Components | Verification Evidence & Audit Findings |
|---|---|---|---|---|
| `CAP-BRW-01` | User Chrome Connection via Native Messaging Extension | `IMPLEMENTED_BUT_UNVERIFIED` | `src/DAsk.Daemon/Automation/Chrome/ChromeBroker.cs`, `extensions/dask-chrome/` | Communicates over user-only stdin/stdout relay pipe `dask-chrome-host.exe`. Requires manual developer-mode extension installation. |
| `CAP-BRW-02` | Chrome Tab Management (List, Switch, Open, Close) | `IMPLEMENTED_AND_VERIFIED` | `src/DAsk.Daemon/Automation/Chrome/ChromeService.cs` | Fully implemented and verified via automated test harness with throwaway Chrome profile. |
| `CAP-BRW-03` | Page Content Extraction & Summarization | `IMPLEMENTED_AND_VERIFIED` | `src/DAsk.Daemon/Automation/Chrome/ChromeService.cs` (`chrome.read_page`) | Extracts DOM text, links, and form fields without accessing sensitive autofill or cookie data. |
| `CAP-BRW-04` | Web Search via Chrome (`"open Chrome and search..."`) | `BROKEN` | `AppLaunchRequestService.cs` (line 248), `ChromeService.cs` (line 149) | Offline-first security policy (`AgentHost:WebSearch=false`) immediately aborts web search with `"offline_mode"` error, falsely reported to user. |
| `CAP-BRW-05` | Consequential Web Clicks (Forms, Payments, Submissions) | `IMPLEMENTED_AND_VERIFIED` | `src/DAsk.Daemon/Automation/Chrome/ChromeService.cs` (`SensitiveReason`) | Separate HUD approval card required for any button/link with verbs like "buy", "pay", "submit", "delete". |
| `CAP-BRW-06` | Headless Playwright Browser Engine | `NOT_IMPLEMENTED` | `agent/runtime/browser/playwrightEngine.ts` | File exists as a stub; not registered in production default tool registry. |

---

### 2.7. Filesystem, Workspace & Knowledge Subsystem

| Capability ID | Feature Description | Classification | Implementation Components | Verification Evidence & Audit Findings |
|---|---|---|---|---|
| `CAP-FIL-01` | Read-Only File Search & Text Matching | `IMPLEMENTED_AND_VERIFIED` | `agent/runtime/tools/filesystem.ts`, `fileAccess.ts` | Bounded file tree walk, regex/text search strictly confined to `workspaceRoot` and user-approved `extraRoots`. |
| `CAP-FIL-02` | File Summarization & Content Extraction | `IMPLEMENTED_AND_VERIFIED` | `agent/runtime/tools/fileSummary.ts` | Reads file text up to size limits, redacting detected API keys, passwords, and tokens. |
| `CAP-FIL-03` | File Organization (Move / Rename) with Preview | `IMPLEMENTED_AND_VERIFIED` | `src/DAsk.Daemon/Automation/Files/FileOrganizeRequestService.cs` | Preview phase computes proposed moves; apply phase requires explicit approval; verifies file existence before/after. |
| `CAP-FIL-04` | Structured Note Creation | `IMPLEMENTED_AND_VERIFIED` | `src/DAsk.Daemon/Automation/Files/NoteCreateRequestService.cs` | Approved writing of markdown notes strictly to designated notes directory. |
| `CAP-FIL-05` | Developer In-Place File Editing | `IMPLEMENTED_AND_VERIFIED` | `src/DAsk.Daemon/Automation/Dev/DevEditService.cs` | Exact find-and-replace block editing with write-ahead unified diff shown on HUD approval card. |
| `CAP-FIL-06` | Local Knowledge Base RAG & Semantic Retrieval | `IMPLEMENTED_AND_VERIFIED` | `agent/runtime/knowledge/store.ts`, `service.ts` | SQLite database (`knowledge.db`) utilizing FTS5 full-text search + cosine similarity over `bge-small` vector embeddings. |
| `CAP-FIL-07` | Offline Scanned PDF OCR Indexing | `IMPLEMENTED_AND_VERIFIED` | `src/hud-native/src/bin/dask-ocr.rs`, `agent/runtime/knowledge/pdf.ts` | Renders PDF pages with `Windows.Data.Pdf` and transcribes using on-device `Windows.Media.Ocr`. |

---

### 2.8. Operating System & Hardware Administration

| Capability ID | Feature Description | Classification | Implementation Components | Verification Evidence & Audit Findings |
|---|---|---|---|---|
| `CAP-SYS-01` | Process Termination (`"kill notepad"`) | `IMPLEMENTED_AND_VERIFIED` | `src/DAsk.Daemon/Automation/SystemAdmin/SystemAdminService.cs` | Terminates process by PID or image name after HUD approval. Protected processes (OS, security, D-ASK) cannot be killed. |
| `CAP-SYS-02` | Wi-Fi / Bluetooth Radio Toggle | `IMPLEMENTED_AND_VERIFIED` | `src/DAsk.Daemon/Automation/SystemAdmin/SystemPlatform.cs` | Uses Windows Runtime `Radio.GetRadiosAsync` to turn radio on/off after approval. Verified in live test suite. |
| `CAP-SYS-03` | Display Resolution & Refresh Rate Adjustment | `IMPLEMENTED_AND_VERIFIED` | `src/DAsk.Daemon/Automation/SystemAdmin/SystemPlatform.cs` | Win32 `ChangeDisplaySettingsEx` with `CDS_TEST` precheck and mandatory 15-second auto-rollback confirmation. |
| `CAP-SYS-04` | Audio Volume & Mute Control | `IMPLEMENTED_AND_VERIFIED` | `src/DAsk.Daemon/Automation/SystemAdmin/SystemPlatform.cs` | Windows Core Audio API (`IAudioEndpointVolume`). Reads/sets master volume percentage. |
| `CAP-SYS-05` | System Shutdown / Restart Scheduling | `IMPLEMENTED_AND_VERIFIED` | `src/DAsk.Daemon/Automation/SystemAdmin/SystemAdminService.cs` | Calls `shutdown.exe /s /t <sec>` or `/r /t <sec>`. Emergency Stop immediately executes `shutdown.exe /a` to abort. |

---

### 2.9. Mobile Subsystem (Android via ADB)

| Capability ID | Feature Description | Classification | Implementation Components | Verification Evidence & Audit Findings |
|---|---|---|---|---|
| `CAP-AND-01` | Connected Device Discovery (`adb devices -l`) | `IMPLEMENTED_BUT_UNVERIFIED` | `src/DAsk.Daemon/Automation/Android/AndroidService.cs` | Production daemon parser exists; passes 29 unit tests with mock ADB; unverified with a physical phone attached. |
| `CAP-AND-02` | Bi-directional File Transfer (`adb push` / `pull`) | `IMPLEMENTED_BUT_UNVERIFIED` | `src/DAsk.Daemon/Automation/Android/AndroidService.cs` | Transfers restricted to allowed folders and `/sdcard/`. SHA-256 verification on both sides. Live hardware verification blocked. |
| `CAP-AND-03` | Fixed Command Execution (Screenshot, Battery, Keyevent) | `IMPLEMENTED_BUT_UNVERIFIED` | `src/DAsk.Daemon/Automation/Android/AndroidService.cs` | 6 fixed ADB subcommands; no arbitrary shell. Requires live Android device for hardware signoff. |

---

## 3. End-to-End Execution Path Traces

### 3.1. Path Trace 1: The Failed Word Workflow (`"open Microsoft Word and type hello"`)

```mermaid
flowchart TD
    A["User Prompt:<br/>'open Microsoft Word and type hello'"] --> B["HUD Web Frontend / JarvisOrb"]
    B --> C["Agent Host stdioBridge"]
    C --> D["agent/runtime/tools/desktop.ts<br/>actuationRefusal(o)"]
    
    subgraph Intent & Grounding Failure
        D --> E{"appSession(o)<br/>Check"}
        E -- "Word not in LAUNCHABLE<br/>(Only Notepad/Calc/Charmap)" --> F["appSession returns NULL"]
        F --> G{"openAppRequest(o)<br/>Check"}
        G -- "Fails regex: has trailing<br/>'and type hello'" --> H["openAppRequest returns NULL"]
        H --> I{"requestedInputActions(o)<br/>Check"}
        I -- "parseInputStep fails on<br/>'open Microsoft Word'" --> J["requestedInputActions returns []"]
        J --> K["actuationRefusal evaluates TRUE"]
    end
    
    K --> L["Hardcoded Refusal String:<br/>'I can't click, type, scroll, move, resize, close or launch anything...'"]
    L --> M["HUD Displays Refusal Message"]
    
    subgraph Disconnected / Never Reached
        N["Planner / LLM Tool Selection"]
        O["Named Pipe IPC to Daemon"]
        P["InstalledAppCatalog Resolution<br/>(Word.lnk exists!)"]
        Q["HUD Approval Card"]
        R["CreateProcess / AppActivation"]
        S["GuardedInput ValuePattern / SendInput"]
    end
    
    style K fill:#ff9999,stroke:#ff0000,stroke-width:2px
    style N fill:#e0e0e0,stroke:#999999,stroke-dasharray: 5 5
    style O fill:#e0e0e0,stroke:#999999,stroke-dasharray: 5 5
    style P fill:#e0e0e0,stroke:#999999,stroke-dasharray: 5 5
    style Q fill:#e0e0e0,stroke:#999999,stroke-dasharray: 5 5
    style R fill:#e0e0e0,stroke:#999999,stroke-dasharray: 5 5
    style S fill:#e0e0e0,stroke:#999999,stroke-dasharray: 5 5
```

**Trace Verdict:**  
The execution fails in the **Intent Recognition & Grounding Layer** before LLM planning, before IPC dispatch, and before daemon evaluation. Even though `InstalledAppCatalog` can discover `WINWORD.EXE`, the agent runtime frontend refuses the request due to rigid regexes designed only for Notepad.

---

### 3.2. Path Trace 2: The Failed Chrome Search Workflow (`"open Chrome and search for news"`)

```mermaid
flowchart TD
    A["User Prompt:<br/>'open Chrome and search for news'"] --> B["HUD Web Frontend / JarvisOrb"]
    B --> C["Agent Host stdioBridge"]
    C --> D["agent/runtime/tools/desktop.ts<br/>openTargetRequest(o)"]
    D --> E["Matches SEARCH_IN regex:<br/>app='Chrome', search='news'"]
    E --> F["Planner selects desktop.launch_app<br/>{ app: 'Chrome', search: 'news' }"]
    F --> G["IPC Named Pipe Dispatch:<br/>\\.\pipe\dask-ipc"]
    G --> H["Daemon: AppLaunchRequestService.RunAsync"]
    
    subgraph Daemon Policy Failure
        H --> I{"target.Kind == 'search' &&<br/>!_opts.WebSearchAllowed"}
        I -- "WebSearchAllowed is FALSE<br/>(Default Offline Mode)" --> J["Fails with code 'offline_mode'"]
    end
    
    J --> K["Error Message Returned:<br/>'A web search needs internet access, and D-ASK is in offline mode...'"]
    K --> L["IPC Reply to Host"]
    L --> M["HUD displays error: D-ASK is in offline mode"]
    M --> N["User confusion: Wi-Fi is active, but D-ASK reports offline"]
    
    subgraph Never Reached
        O["InstalledAppCatalog Chrome.exe"]
        P["HUD Approval Card"]
        Q["Chrome Process Launch"]
        R["Chrome Native Extension Relay"]
        S["Web Search Tab Navigation"]
    end
    
    style J fill:#ff9999,stroke:#ff0000,stroke-width:2px
    style O fill:#e0e0e0,stroke:#999999,stroke-dasharray: 5 5
    style P fill:#e0e0e0,stroke:#999999,stroke-dasharray: 5 5
    style Q fill:#e0e0e0,stroke:#999999,stroke-dasharray: 5 5
    style R fill:#e0e0e0,stroke:#999999,stroke-dasharray: 5 5
    style S fill:#e0e0e0,stroke:#999999,stroke-dasharray: 5 5
```

**Trace Verdict:**  
The execution reaches the Daemon over IPC, but fails at the **Daemon Action Policy Gate**. Because D-ASK is architected as offline-first, `AgentHost:WebSearch` defaults to `false`. The daemon immediately rejects the request with code `offline_mode`. The user's active Wi-Fi connection was never probed because the operation was barred by static configuration policy, not hardware disconnection.

---

### 3.3. Path Trace 3: Successful Notepad Launch & Type Workflow (`"open Notepad and type 'test'"`)

```mermaid
flowchart TD
    A["User Prompt:<br/>'open Notepad and type test'"] --> B["HUD Frontend"]
    B --> C["Agent Host stdioBridge"]
    C --> D["agent/runtime/tools/desktop.ts<br/>appSession(o)"]
    D --> E["Matches LAUNCHABLE.notepad:<br/>app='notepad', text='test'"]
    E --> F["Planner plans 2 steps:<br/>1. desktop.launch_app {app:'notepad'}<br/>2. desktop.type_text {process:'notepad.exe', text:'test'}"]
    
    subgraph Step 1: App Launch
        F --> G["IPC desktop.launch_app -> Daemon"]
        G --> H["AppLaunchRequestService: Evaluates Policy"]
        H --> I["HUD displays Action Approval Modal"]
        I --> J["User Approves Launch in HUD"]
        J --> K["ValidateConsumedApproval & RecordSafetyAudit"]
        K --> L["Win32AppProcessStarter.Start('notepad.exe')"]
        L --> M["WindowsUiAutomationService observes NEW window"]
        M --> N["LaunchedWindowRegistry records HWND & PID"]
        N --> O["Step 1 Returns OK"]
    end
    
    subgraph Step 2: Guarded Text Entry
        O --> P["IPC desktop.type_text -> Daemon"]
        P --> Q["GuardedInputRequestService: Binds to LaunchedWindow"]
        Q --> R["Resolves UIA Element: Document 'Text editor'"]
        R --> S["HUD displays Action Approval Modal for Text Entry"]
        S --> T["User Approves Typing in HUD"]
        T --> U["Win32GuardedInput sets ValuePattern text"]
        U --> V["Verifier reads back text from UIA element"]
        V --> W["Step 2 Returns OK"]
    end
    
    W --> X["HUD displays complete success and evidence"]
    
    style X fill:#99ff99,stroke:#00aa00,stroke-width:2px
```

**Trace Verdict:**  
The complete pipeline functions end-to-end ONLY because Notepad has dedicated, bespoke code handling across the regex parser (`appSession`), the planning arranger (`arrangeSteps`), the whitelist catalog (`KnownApps`), and the UI Automation target definition (`APP_EDITOR`).

---

## 4. Architectural Disconnects & Missing Connections

The capability audit reveals four fundamental architectural disconnects that cause user workflows to fail:

1. **The Compound Instruction Parsing Gap:**  
   The natural language frontend (`agent/runtime/tools/desktop.ts`) treats multi-step commands as single-step intents unless they match the specific `appSession` regex. A command like `"open Word and type hello"` is rejected as an ungrounded actuation imperative instead of being decomposed into a sequential 2-step plan: `[desktop.launch_app, desktop.type_text]`.

2. **The Hardcoded Target Editor Limitation:**  
   Typing automation is exclusively hardcoded to `{ controlType: "Document", name: "Text editor" }` (the Windows 11 packaged Notepad editor control). D-ASK has no concept of generic focused text entry or active document discovery for Microsoft Word, WordPad, browsers, or terminal windows.

3. **Policy-Lock Conflated with Network Disconnection:**  
   The daemon conflates security policy constraints (`AgentHost:WebSearch = false`) with hardware connectivity state. Returning `offline_mode` when internet access is disabled by configuration causes users to assume network interface detection is broken.

4. **Extension Installation Dependency vs. Application Launch:**  
   The Chrome subsystem requires an unpacked Chrome MV3 extension and native messaging registry key. If a user asks to `"open Chrome"`, D-ASK attempts to connect to the extension rather than simply launching the browser as an installed desktop application, resulting in a 20-second timeout and failure if the extension is not pre-configured.
