# D-ASK — Complete Capability Inventory and Subsystem Audit

**Document Reference:** Complete Product Capability Discovery  
**Audit Target:** D-ASK Release Candidate `D-ASK-20261115T023936`  
**Git Baseline:** Commit `6c3113b` on branch `main`  
**Installed Target:** `%LOCALAPPDATA%\Programs\D-ASK`  
**Date:** 2026-11-16  

---

## 1. Inventory Scope & Discovery Methodology

This document establishes the exhaustive, repository-wide inventory of all advertised and implemented capabilities in the **D-ASK** personal AI assistant. 

Every capability in this inventory is derived directly from:
- Production tool registries (`agent/runtime/defaults.ts`, `agent/runtime/hostRegistry.ts`, `agent/runtime/tools/*.ts`).
- Daemon service implementations (`src/DAsk.Daemon/Automation/**/*.cs`).
- Native HUD host architecture (`src/hud-native/src/**/*.rs`).
- Native extension and relay implementations (`extensions/dask-chrome/`, `src/DAsk.Daemon/Automation/Chrome/`).
- Local inference supervisor and model configuration (`agent/runtime/inference/*.ts`, `models/`).
- Feature profiles (`features.default.cmd`, `package-manifest.json`).

No hypothetical or unadvertised capabilities have been added.

---

## 2. Complete Inventory by Functional Domain

### Domain 1: HUD, Windowing & Display Subsystem
*Source Components:* `src/hud-native/`, `app/components/JarvisOrb.tsx`, `overlay.rs`, `render/`

1. **Transparent Frameless Desktop Window (`HUD-01`):**  
   Win32 layered window (`WS_EX_LAYERED`, `WS_EX_TRANSPARENT`) using `DwmExtendFrameIntoClientArea` to create a transparent desktop canvas hosting a WebView2 overlay.
2. **Ambient vs. Interactive State Management (`HUD-02`):**  
   Automatic hit-testing transitions the window from click-through ambient mode (mouse events pass to desktop) to interactive mode when cursor enters HUD boundaries or upon hotkey activation.
3. **Hardware-Accelerated 3D Jarvis Orb (`HUD-03`):**  
   Custom wgpu rendering engine with WGSL shaders (`orb.wgsl`) rendering an animated 3D holographic sphere reflecting assistant states: *Idle, Listening, Thinking, Speaking, Action Approval, Error*.
4. **Core Console Command Bar (`HUD-04`):**  
   Direct text input bar (`#ultron-command`) focused on startup in interactive mode, submitting natural-language instructions to the agent host over stdio JSON-RPC.
5. **Interactive Action Approval Modals (`HUD-05`):**  
   Presents approval cards displaying action risk levels, exact parameters, affected window/file targets, reversibility explanations, and Approve/Decline buttons.
6. **Hardware Emergency Stop Hotkey (`HUD-06`):**  
   Global low-level Win32 keyboard hook (`Ctrl+Shift+F12`) running on a dedicated thread, latching the system into an immediate emergency stop state.
7. **Liveness Heartbeat & Lease Maintenance (`HUD-07`):**  
   Five-second cyclic lease ping over IPC between the HUD and .NET Daemon to ensure that unattended or orphaned daemons cannot act without an active user UI.

---

### Domain 2: Local AI Inference & Agent Reasoning Subsystem
*Source Components:* `agent/runtime/`, `local-inference/`, `models/`, `agent/host/`

8. **Supervised Local LLM Execution (`AI-01`):**  
   Supervises pinned `llama-server.exe` (Vulkan/CPU builds) running quantized GGUF models (`qwen2.5-0.5b-instruct-q4_k_m.gguf` / `qwen2.5-1.5b`) with `--offline` enforcement and strict per-host PID management.
9. **Physical RAM Inference Guard (`AI-02`):**  
   Checks available physical system memory before launching inference, refusing to start `llama-server` if available RAM is below 3.2 GB to prevent system thrashing.
10. **Deterministic Intent Recognition & Grounding (`AI-03`):**  
    Deterministic regular-expression grammar (`agent/runtime/grounding.ts`) extracting exact user argument domains (files, numbers, windows, query strings) before invoking the LLM.
11. **Context-Constrained Prompt Budgeting (`AI-04`):**  
    Dynamic tool filtering (`requestToolOffer`) presenting only relevant tool schemas and constraints to the LLM, keeping plan prompts within the 4,096-token local context limit.
12. **Structured Two-Turn Plan Generation (`AI-05`):**  
    Forces local LLM output into a strict JSON schema (`PROPOSAL_SCHEMA`). Automatically triggers one structured self-repair round if turn 1 contains schema errors.
13. **Sequential Execution Runtime (`AI-06`):**  
    Executes validated plan steps sequentially, validating permissions, parameter domains, and single-use approval tokens prior to each call.
14. **Deterministic Post-Condition Verifier (`AI-07`):**  
    Independent verifier inspecting external OS state (disk, UIA tree, window handles) after each tool execution, refusing to rely on tool self-reports.
15. **Local Vector Embeddings (`AI-08`):**  
    Dedicated CPU instance of `llama-server` executing `bge-small-en-v1.5` to generate 384-dimensional vector embeddings for local semantic retrieval.

---

### Domain 3: Windows Desktop Application Lifecycle
*Source Components:* `src/DAsk.Daemon/Automation/Desktop/`, `agent/runtime/tools/desktop.ts`

16. **Fixed Whitelist Application Launch (`APP-01`):**  
    Launches predefined applications: Notepad (`notepad.exe`), Calculator (`calc.exe`), and Character Map (`charmap.exe`) with `UseShellExecute=false` and zero arguments.
17. **Dynamic Installed Application Discovery (`APP-02`):**  
    Discovers installed applications across Start Menu `.lnk` shortcuts, Registry `App Paths`, and Windows Store/MSIX packages via `IApplicationActivationManager`.
18. **Application Window Post-Launch Verification (`APP-03`):**  
    Monitors UI Automation window enumeration following `CreateProcess` to confirm that exactly one new visible window appears before reporting success.
19. **Single-Instance Application Bring-to-Front (`APP-04`):**  
    Detects if a requested single-instance application is already running, bringing its existing window to the foreground instead of failing.
20. **Windows Settings Direct Deep-Linking (`APP-05`):**  
    Launches canonical Windows Settings pages (`ms-settings:display`, `ms-settings:sound`, `ms-settings:network`, `ms-settings:bluetooth`) from a validated lookup table.
21. **Targeted Application Launch with Search / Folder Argument (`APP-06`):**  
    Launches browsers with a search query or VS Code/Explorer with an existing folder path.
22. **Launched Window Task Tracking (`APP-07`):**  
    `LaunchedWindowRegistry` correlates opened HWND, process ID, and process creation timestamp with the specific task ID to prevent misdirected subsequent input.

---

### Domain 4: Desktop UI Automation & Input Injection
*Source Components:* `src/DAsk.Daemon/Automation/Input/`, `src/DAsk.Daemon/Automation/Desktop/`

23. **Desktop Window Enumeration & Inspection (`INP-01`):**  
    `desktop.list_windows` and `desktop.inspect_window` enumerate visible desktop windows and dump UI Automation element trees up to depth 12 and 600 nodes.
24. **Offline Desktop OCR Vision (`INP-02`):**  
    `desktop.read_text` captures window pixels via GDI `BitBlt` into shared memory and transcribes visible text using `dask-ocr.exe` (Windows.Media.Ocr).
25. **Window State Control (`INP-03`):**  
    `desktop.focus_window` and `desktop.set_window_state` safely minimize, maximize, restore, or focus validated window handles.
26. **Element-Bound Guarded Mouse Clicks (`INP-04`):**  
    Derives click coordinates from UIA element bounding rectangles; checks for overlay occlusion; injects clicks via Win32 `SendInput`.
27. **Guarded Mouse Drag-and-Drop & Scrolling (`INP-05`):**  
    Performs element-to-element drag operations and notched mouse wheel scrolling bound to UI Automation containers.
28. **Notepad Document Text Insertion (`INP-06`):**  
    Sets text into Notepad's Document control (`"Text editor"`) using UIA `ValuePattern`.
29. **Physical User Input Intervention Abort (`INP-07`):**  
    Low-level Win32 hooks (`WH_MOUSE_LL`, `WH_KEYBOARD_LL`) immediately terminate automated input sequences if the human user moves the physical mouse or strikes a key.
30. **Sensitive Window Protection Shield (`INP-08`):**  
    Hardcoded blocklist (`DeniedImageNames`) refusing to inject input into password managers (KeePass, 1Password, Bitwarden) or OS credential prompts (consent.exe, LogonUI).
31. **Win32 Clipboard Read/Write (`INP-09`):**  
    Reads and writes clipboard text after explicit single-use approval, filtering secret-looking strings (private keys, passwords).

---

### Domain 5: Browser Control & Web Automation
*Source Components:* `src/DAsk.Daemon/Automation/Chrome/`, `extensions/dask-chrome/`, `agent/runtime/tools/chrome.ts`

32. **User Chrome Extension Native Messaging Relay (`BRW-01`):**  
    Bidirectional JSON protocol between `dask-chrome-host.exe` and Chrome MV3 extension over user-only stdin/stdout pipes (0 listening network ports).
33. **Chrome Session Authorization (`BRW-02`):**  
    One-time HUD approval card authorizing D-ASK to control the connected Chrome browser for a 2-hour lease or until Emergency Stop.
34. **Chrome Tab Management (`BRW-03`):**  
    `chrome.list_tabs`, `chrome.open_tab`, `chrome.switch_tab`, and `chrome.close_tab` inspect and manipulate Chrome tabs without accessing history or cookies.
35. **Web Page DOM Reading (`BRW-04`):**  
    `chrome.read_page` extracts page title, text, form fields, and up to 15 navigation links.
36. **Web Element Interaction (`BRW-05`):**  
    `chrome.click` and `chrome.fill` target links, buttons, and input fields by visible text or label.
37. **Consequential Web Action Approval Gate (`BRW-06`):**  
    Mandatory separate HUD approval card required for any web click identified as consequential (purchases, payments, deletions, form submissions).
38. **Web Search Policy Lock (`BRW-07`):**  
    `AgentHost:WebSearch` toggle enforcing offline-first boundaries by refusing web searches when operating in default offline mode.

---

### Domain 6: Filesystem, Documents & Knowledge Subsystem
*Source Components:* `agent/runtime/tools/filesystem.ts`, `src/DAsk.Daemon/Automation/Files/`, `agent/runtime/knowledge/`

39. **Bounded Read-Only File Search (`FIL-01`):**  
    `filesystem.search` and `filesystem.find_text` perform bounded recursive searches strictly confined to `workspaceRoot` and configured `extraRoots`.
40. **File Content Inspection & Secret Redaction (`FIL-02`):**  
    `filesystem.read` and `filesystem.summarize` read documents up to 500 KB, automatically redacting recognized API tokens and passwords.
41. **Two-Phase File Organization (`FIL-03`):**  
    `filesystem.plan_organize` generates dry-run move previews; `filesystem.organize` applies approved file moves with pre/post existence verification and undo support.
42. **Structured Note Generation (`FIL-04`):**  
    `notes.create` writes approved markdown notes strictly into `%USERPROFILE%\Documents\D-ASK\Notes\`.
43. **In-Place Developer Code Editing (`FIL-05`):**  
    `dev.edit_file` computes unified diffs, displays write-ahead previews on HUD approval cards, and performs atomic block replacements.
44. **Native Microsoft Office Document Creation (`FIL-06`):**  
    `office.create_word_document` and `office.create_excel_workbook` generate `.docx` and `.xlsx` files using local Office COM automation (`Word.Application` / `Excel.Application`).
45. **Local SQLite Knowledge Base (`FIL-07`):**  
    `knowledge.db` indexing local folders using SQLite FTS5 full-text indexing and cosine similarity over `bge-small` vector embeddings.
46. **Scanned PDF Optical Character Recognition (`FIL-08`):**  
    Renders non-text PDF pages with `Windows.Data.Pdf` and transcribes passages using on-device `Windows.Media.Ocr`.
47. **Offline Scholarly Dataset Analysis (`FIL-09`):**  
    Parses local CSV/TSV datasets, computing descriptive statistics, correlation matrices, Welch t-tests, and generating SVG charts.
48. **Optional Online Scholarly Discovery (`FIL-10`):**  
    `DASK_RESEARCH_ONLINE=1` queries arXiv and Crossref over HTTPS strictly on allowed domains without following redirects.

---

### Domain 7: Speech, Voice & Audio Subsystem
*Source Components:* `src/hud-native/src/stt.rs`, `tts.rs`, `voice_gate.rs`, `whisper.rs`

49. **Windows SAPI Speech-to-Text (`VOI-01`):**  
    Captures 16 kHz mono WAV audio from default microphone and transcribes via local Windows SAPI 5.4 desktop recognizer on a dedicated STA thread.
50. **Whisper.cpp Local Engine Fallback (`VOI-02`):**  
    Execution wrapper for local `whisper-cli.exe` and `ggml-base.en.bin` when provisioned.
51. **Spoken Dictation Quote Normalization (`VOI-03`):**  
    Converts spoken markers (*"quote ... unquote"*) into exact punctuation quotes for input grammar parsing.
52. **Windows SAPI Text-to-Speech (`VOI-04`):**  
    Speaks assistant responses via local `ISpVoice` COM interface, automatically filtering markdown syntax (`#`, `*`, `` ` ``).
53. **Instant Audio Muting on Stop (`VOI-05`):**  
    Silences active TTS output immediately upon Emergency Stop or user interruption via `SPF_PURGEBEFORESPEAK`.

---

### Domain 8: System Administration & Operating System Control
*Source Components:* `src/DAsk.Daemon/Automation/SystemAdmin/`, `agent/runtime/tools/systemAdmin.ts`

54. **Process Listing & Detail Query (`SYS-01`):**  
    `system.list_processes` and `system.process_info` enumerate running Windows processes ordered by working set memory.
55. **Guarded Process Termination (`SYS-02`):**  
    `system.end_process` terminates non-protected processes by PID or unique image name after HUD approval.
56. **Windows Service Monitoring & Control (`SYS-03`):**  
    `system.list_services`, `system.service_info`, and `system.service_control` query and start/stop allowed Windows services.
57. **Network Adapter & Radio Monitoring (`SYS-04`):**  
    `system.network_status` inspects network adapters, IPv4/IPv6 addresses, Wi-Fi SSID, and radio states.
58. **Wi-Fi & Bluetooth Radio Toggle (`SYS-05`):**  
    `system.set_radio` turns physical Wi-Fi or Bluetooth radios on or off via Windows Runtime `Radio.SetStateAsync`.
59. **System Audio Volume & Mute Control (`SYS-06`):**  
    `system.audio_status` and `system.set_volume` query and adjust master volume percentage via Core Audio `IAudioEndpointVolume`.
60. **Display Mode & Resolution Adjustment (`SYS-07`):**  
    `system.display_status` and `system.set_display_mode` query supported modes and apply resolutions via `ChangeDisplaySettingsEx` with mandatory 15-second auto-rollback confirmation.
61. **Screen Brightness Control (`SYS-08`):**  
    `system.set_brightness` adjusts monitor backlight levels via WMI / DDC-CI.
62. **Windows Startup Program Management (`SYS-09`):**  
    `system.startup_apps` and `system.startup_toggle` inspect and enable/disable current-user startup registry entries.
63. **Scheduled Power Actions (`SYS-10`):**  
    `system.power` schedules sleep, restart, or shutdown with a minimum 30-second delay. `system.cancel_power` and Emergency Stop abort pending shutdowns via `shutdown.exe /a`.

---

### Domain 9: Mobile Device Subsystem (Android via ADB)
*Source Components:* `src/DAsk.Daemon/Automation/Android/`, `agent/runtime/tools/android.ts`

64. **ADB Device Discovery (`AND-01`):**  
    `android.list_devices` executes `adb devices -l` to identify connected phones, USB authorization states, and model names.
65. **Device Hardware Telemetry (`AND-02`):**  
    `android.device_info` queries Android OS version, battery level, and internal storage availability.
66. **Wireless Debugging Pairing (`AND-03`):**  
    `android.connect` connects to an Android device over private IPv4 networks.
67. **Bidirectional File Transfer (`AND-04`):**  
    `android.push` and `android.pull` transfer files strictly between allowed local folders and `/sdcard/`, verified by SHA-256 hashes on both endpoints.
68. **Fixed Android Hardware Key & Command Execution (`AND-05`):**  
    `android.command` executes six fixed ADB actions: `home`, `back`, `wake`, `lock`, `volume_up`, `volume_down`, or opens HTTPS URLs via `am start`.

---

### Domain 10: Persistent Memory & Workflows
*Source Components:* `agent/runtime/memory/`, `src/DAsk.Daemon/Automation/Workflows/`

69. **Explicit Fact Storage (`MEM-01`):**  
    `memory.remember` records user facts and preferences in SQLite `memory.db`.
70. **Semantic Memory Recall (`MEM-02`):**  
    `memory.recall` and `memory.list` retrieve stored facts to inject as advisory planning context.
71. **Memory Deletion (`MEM-03`):**  
    `memory.forget` and `memory.forget_id` remove obsolete facts from the database.
72. **Daemon Workflow Storage & Scheduling (`WFL-01`):**  
    `workflow.list`, `workflow.save`, and `workflow.schedule` store multi-step task routines in the daemon database for recurring execution.

---

### Domain 11: Safety, Approvals & Audit Subsystem
*Source Components:* `src/DAsk.Daemon/Automation/Policy/`, `src/DAsk.Daemon/Research/`

73. **Deterministic Canonical Parameter Hashing (`SAF-01`):**  
    Normalizes action parameters to canonical JSON, computing SHA-256 action hashes to prevent parameter tampering.
74. **Single-Use Approval Token Consumption (`SAF-02`):**  
    Enforces atomic one-time consumption of approval IDs; replay attempts fail immediately.
75. **Owner-Session Binding (`SAF-03`):**  
    Binds approvals strictly to the originating HUD session ID; foreign clients cannot approve pending actions.
76. **Process Identity Validation (`SAF-04`):**  
    Validates target HWND, process ID, and process creation timestamp before admitting input actions.
77. **Write-Ahead Cryptographic Audit Journaling (`SAF-05`):**  
    Persists safety audit records to `execution-evidence.jsonl` prior to execution. If writing fails, execution is refused (`journal_unavailable`).

---

### Domain 12: Packaging, Code Signing & Distribution
*Source Components:* `scripts/package/`, `features.default.cmd`

78. **Self-Contained Standalone Packaging (`PKG-01`):**  
    Bundles Node.js runtime, .NET daemon, Rust HUD, llama-server, and GGUF model weights into a portable distribution package (`D-ASK-20261115T023936`).
79. **One-Click User Installer (`PKG-02`):**  
    `Install-D-ASK.ps1` installs D-ASK into `%LOCALAPPDATA%\Programs\D-ASK`, registers the Chrome native messaging host, and creates Start Menu shortcuts.
80. **Package Integrity Manifest (`PKG-03`):**  
    `package-manifest.json` verifies SHA-256 checksums of all 218 bundled files on startup.
81. **Windows Authenticode Code Signing Pipeline (`PKG-04`):**  
    `Sign-D-ASK.ps1` provides automated signing and verification of all native binaries with SHA-256 and RFC 3161 timestamps.
