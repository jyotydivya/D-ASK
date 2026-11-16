# D-ASK — Catalog of Unimplemented, Missing, and Detached Capabilities

**Audit Scope:** Features in Design Specs, Legacy Code, or UI Prototypes Missing a Native Execution Path  
**Audited Target:** D-ASK Release Candidate `D-ASK-20261115T023936`  
**Git Baseline:** Commit `6c3113b` on branch `main`  
**Date:** 2026-11-16  

---

## 1. Executive Summary

This document inventories capabilities that have been described in project documentation, exist as detached prototype code from earlier phases, or appear in user-facing concepts, but **do not possess a functioning execution pathway in the production D-ASK native runtime**.

Identifying these features prevents false assumptions regarding product maturity and defines the boundaries of what D-ASK can realistically be expected to deliver today.

---

## 2. Unimplemented & Missing Capabilities Catalog

### 2.1. Multi-Agent Cloud Orchestrator (`agent/orchestrator.ts`, `blackboard.ts`)
- **Advertised / Prototype Concept:** A multi-agent system where a central coordinator delegates sub-tasks to specialized sub-agents (`browserAgent`, `codingAgent`, `deviceAgent`, `memoryAgent`, `pcAgent`) collaborating via a shared blackboard.
- **Architectural Reality:** **Completely Detached.**
  - These files belong to the original Next.js web prototype.
  - The production D-ASK assistant runs via `agent/host/stdioHost.ts` using a single-agent sequential planner (`AgentRuntime.ts` + `Planner.ts` + `Brain.ts`).
  - The multi-agent orchestrator is never imported, initialized, or invoked by the native daemon or HUD.
- **Status:** **UNIMPLEMENTED IN PRODUCTION.**

---

### 2.2. Legacy Python Desktop Automation (`mouse_keyboard.py`)
- **Advertised / Prototype Concept:** Desktop mouse and keyboard control executed via Python and PyAutoGUI with screen coordinate interpolation.
- **Architectural Reality:** **Blocked & Inactive.**
  - Located in `lib/agent/tools/desktop/python/mouse_keyboard.py`.
  - In `lib/agent/tools/desktop/pcAgent.ts`, actuation tools pointing to this script are explicitly listed under `BLOCKED_ACTUATION_TOOLS`.
  - The production daemon executes desktop input strictly via C# Win32 `SendInput` in `Win32GuardedInput.cs`. The Python scripts are dead code.
- **Status:** **DEPRECATED / UNIMPLEMENTED.**

---

### 2.3. Headless Playwright Browser Engine (`playwrightEngine.ts`)
- **Advertised / Prototype Concept:** An isolated, headless Chromium browser managed via Microsoft Playwright for background web scraping and automated page navigation without user browser interference.
- **Architectural Reality:** **Unbundled & Unregistered.**
  - The file `agent/runtime/browser/playwrightEngine.ts` exists in the repository.
  - However, in `agent/runtime/defaults.ts`, `createBrowserTools` is omitted. Playwright is excluded from the default tool registry to keep the packaged runtime dependency-light and avoid bundling heavy Playwright binaries.
  - The only browser engine registered in production is the Chrome Native Messaging extension bridge (`chrome.ts`).
- **Status:** **UNIMPLEMENTED IN RUNTIME.**

---

### 2.4. Local Whisper.cpp Speech-to-Text (`whisper.rs`)
- **Advertised / Prototype Concept:** High-accuracy, offline neural speech recognition powered by whisper.cpp and quantized GGML models (`ggml-base.en.bin`).
- **Architectural Reality:** **Missing Binaries and Model Weights.**
  - In `src/hud-native/src/whisper.rs` and `stt.rs`, code exists to spawn `whisper-cli.exe` and transcribe audio files.
  - However, neither `local-inference/whisper-cli.exe` nor `models/ggml-base.en.bin` are included in the repository, installer, or release package.
  - When invoked, `stt.rs` detects the missing binary, logs a debug message (`[STT] whisper not available; using the Windows recognizer`), and falls back to classic Windows SAPI 5.4.
- **Status:** **UNIMPLEMENTED (FALLBACK ACTIVE).**

---

### 2.5. Universal Focused GUI Text Entry
- **Advertised / Prototype Concept:** The ability for D-ASK to type user-dictated text into whatever application window is currently active or focused (e.g. Word, WordPad, browser forms, IDEs, Discord).
- **Architectural Reality:** **Hardcoded Exclusively to Notepad.**
  - The typing pipeline (`GuardedInputRequestService.cs` and `desktop.ts`) strictly requires a UI Automation target matching `{ controlType: "Document", name: "Text editor" }`.
  - No fallback mechanism exists to locate the active window's focused element (`IUIAutomation::GetFocusedElement`) or inject keystrokes via Win32 `SendInput` into non-Notepad windows.
  - Any prompt asking D-ASK to type into Word, Excel, Chrome, or terminals fails.
- **Status:** **UNIMPLEMENTED.**

---

### 2.6. Continuous Background Wake-Word Detection
- **Advertised / Prototype Concept:** An always-on ambient listener that wakes D-ASK upon hearing a spoken trigger phrase like *"Hey Jarvis"* or *"D-ASK"*.
- **Architectural Reality:** **Missing.**
  - Speech recognition in the native HUD is triggered only when the user explicitly clicks the microphone icon in the HUD or submits audio via `#ultron-command`.
  - There is no background audio capture loop, acoustic model, or keyword spotting engine (such as Porcupine or Snowboy) running in `hud-native.exe`.
- **Status:** **UNIMPLEMENTED.**

---

### 2.7. Camera-Based Holographic Gesture Recognition
- **Advertised / Prototype Concept:** Hand tracking and gesture control of the 3D Jarvis Orb using the user's webcam via MediaPipe.
- **Architectural Reality:** **Unwired Assets.**
  - MediaPipe hand model weights (`hand_landmarker.task`) are shipped in `public/mediapipe/`.
  - However, the native HUD is a Rust/WebView2 application (`hud-native.exe`), and camera frame capture is not wired into the native event loop or orb renderer.
  - The 3D orb responds only to mouse hover, mouse drag, and window focus events.
- **Status:** **UNIMPLEMENTED IN NATIVE HUD.**

---

### 2.8. Real Physical Android Device Integration
- **Advertised / Prototype Concept:** Full mobile management of connected Android smartphones via ADB (transfers, wireless pairing, hardware keys).
- **Architectural Reality:** **Zero Physical Hardware Validation.**
  - While `AndroidService.cs` contains complete command logic, all passing tests were executed using synthetic mock output fixtures.
  - ADB Platform-Tools are not installed by default on user machines.
  - D-ASK has never been tested against a live, physically attached Android device.
- **Status:** **UNVERIFIED PROTOTYPE.**

---

### 2.9. Authenticode Digital Code Signing
- **Advertised / Prototype Concept:** A cryptographically signed Windows desktop application with valid Authenticode certificates establishing publisher identity and eliminating Windows SmartScreen warnings.
- **Architectural Reality:** **Missing Trusted Certificate.**
  - `Sign-D-ASK.ps1` correctly implements the signing pipeline, and policy tests pass.
  - However, no publicly trusted EV/OV code-signing certificate exists in the workspace.
  - In the packaged release `D-ASK-20261115T023936`, **all 9 D-ASK binaries are completely unsigned**.
- **Status:** **UNIMPLEMENTED (BLOCKED ON CERTIFICATE).**

---

## 3. Summary Matrix of Unimplemented Capabilities

| Capability | Appears In | Reason Missing from Production | Implementation Effort |
|---|---|---|---|
| **Multi-Agent Orchestrator** | Next.js prototype (`agent/orchestrator.ts`) | Replaced by single-agent sequential native runtime | High (Requires complete re-architecture) |
| **PyAutoGUI Automation** | Legacy Python (`mouse_keyboard.py`) | Replaced by safe Win32 UIA input; blocked by safety policy | None (Intentional deprecation) |
| **Playwright Engine** | Repo (`playwrightEngine.ts`) | Omitted from default bundle to reduce package footprint | Medium (Needs bundling Playwright browsers) |
| **Whisper Neural STT** | Rust HUD (`whisper.rs`) | Missing `whisper-cli.exe` and `ggml-base.en.bin` files | Low (Add downloader script to build pipeline) |
| **Universal Focused Typing** | Product Docs / User Expectation | Typing hardcoded exclusively to Notepad Document control | Medium (Add `GetFocusedElement` + `SendInput`) |
| **Background Wake-Word** | Design Vision | No continuous background microphone listener | High (Requires local KWS engine integration) |
| **Webcam Gesture Control** | Public assets (`public/mediapipe/`) | Web camera capture not wired into native Rust HUD | High (Requires WebRTC / OpenCV camera capture) |
| **Real Android Control** | Docs / ADB Service | No physical phone testing or pre-installed ADB tools | Low (Requires physical device validation) |
| **Authenticode Signing** | Package Docs / Pipeline | Requires purchasing trusted public EV/OV certificate | External (Requires public CA verification) |
