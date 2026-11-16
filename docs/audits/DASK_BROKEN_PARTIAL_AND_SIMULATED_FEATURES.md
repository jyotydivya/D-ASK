# D-ASK — Detailed Audit of Broken, Partial, and Simulated Features

**Audit Scope:** Comprehensive Analysis of Defective, Constrained, and Artificially Verified Features  
**Release Target:** D-ASK Release Candidate `D-ASK-20261115T023936`  
**Baseline Commit:** `6c3113b` on branch `main`  
**Date:** 2026-11-16  

---

## 1. Executive Summary

This report provides an in-depth technical analysis of every feature in D-ASK that:
1. **Fails during normal user workflows (Broken).**
2. **Works only under narrow, artificial constraints (Partially Implemented).**
3. **Passes automated CI/CD test suites via mocks, stubs, or synthetic harnesses without driving real hardware or human interaction (Simulated).**

Distinguishing between these states is vital to understanding why D-ASK achieves high automated test pass rates (e.g. 678 passed daemon tests, 2,276 passed TypeScript checks) yet breaks during basic manual user evaluation.

---

## 2. Category 1: Broken Features (Failing in Real Use)

### 2.1. Compound Application Launch & Typing
- **User Prompt:** `"open Microsoft Word and type hello"` or `"open Notepad and write 'welcome'"`
- **Observed Behavior:** The agent runtime immediately outputs:
  > *"I can't click, type, scroll, move, resize, close or launch anything. I can list open windows, describe a window you name..."*
- **Root Cause:**
  1. `agent/runtime/tools/desktop.ts` defines `appSession(o)`, but its `LAUNCHABLE` dictionary strictly hardcodes only: `notepad`, `calculator`, and `charmap`.
  2. The generic launch parser `openAppRequest(o)` uses regex `OPEN_ANY` which has an end-of-string anchor (`$`). Any prompt containing subsequent instructions (`"and type hello"`) causes `OPEN_ANY` to fail.
  3. Because neither parser matches, the prompt falls into `actuationRefusal(o)`, which classifies it as an ungrounded imperative and aborts execution before LLM invocation or daemon IPC dispatch.
- **Impact:** Critical user-facing defect. Users expect an AI desktop assistant to combine launching and typing into a single intuitive instruction.

### 2.2. Web Search via Chrome (False "Offline" Error)
- **User Prompt:** `"open Chrome and search for news"` or `"search Google in Chrome"`
- **Observed Behavior:** D-ASK fails and reports:
  > *"A web search needs internet access, and D-ASK is in offline mode (web searches are switched off: AgentHost:WebSearch). Nothing was opened or searched."*
- **Root Cause:**
  1. In `src/DAsk.Daemon/Automation/Desktop/AppLaunchRequestService.cs` (lines 248–250), `target?.Kind == "search"` checks `_opts.WebSearchAllowed`.
  2. `WebSearchAllowed` is populated from `hostOpts.WebSearch`, which defaults to `false` in production.
  3. The daemon immediately returns error code `"offline_mode"`.
  4. The error message explicitly uses the word `"offline"`, misleading the user into believing D-ASK's network interface detection failed when active Wi-Fi was present.
- **Impact:** Severe UX failure. Conflates architectural offline-first policy with physical hardware connectivity.

### 2.3. Universal Focused Text Entry
- **User Prompt:** `"type 'hello' in Word"` or `"type 'test' in the document"`
- **Observed Behavior:** Fails with `element_not_found` or `invalid_args`.
- **Root Cause:**
  1. In `agent/runtime/tools/desktop.ts` and `GuardedInputRequestService.cs`, typing is hardcoded to:
     ```typescript
     const APP_EDITOR = { controlType: "Document", name: "Text editor" } as const;
     ```
  2. This matches only the Windows 11 packaged Notepad editor control.
  3. Microsoft Word's editing canvas does not expose a control named `"Text editor"`, nor does it support UIA `ValuePattern`.
  4. D-ASK lacks a generic focused typing tool that identifies the active keyboard focus element (`GetFocusedElement`) and injects keystrokes via Win32 `SendInput`.
- **Impact:** D-ASK is fundamentally incapable of typing into any application other than Notepad.

### 2.4. Inference Refusal under Normal Desktop RAM Load
- **User Prompt:** Any model-answered question when free RAM < 3.2 GB.
- **Observed Behavior:** D-ASK reports that local model inference is unavailable due to memory constraints.
- **Root Cause:**
  1. `agent/runtime/inference/supervisor.ts` enforces a strict 3.2 GB free physical RAM threshold before launching `llama-server.exe`.
  2. On a typical 16 GB machine running Windows 11, Visual Studio / VS Code, and Chrome, available RAM frequently drops to 2.8–3.1 GB.
  3. While designed as a stability guard, it causes D-ASK's Core Console to refuse basic natural language queries on standard developer machines.
- **Impact:** High. Makes the assistant feel flaky or broken on everyday desktop configurations.

---

## 3. Category 2: Partially Implemented Features (Restricted Subsets)

### 3.1. Discovered Application Launching
- **Status:** **Partial**
- **Capabilities:**
  - `InstalledAppCatalog.cs` discovers applications from Start Menu `.lnk` files, Registry `App Paths`, and Windows Store/MSIX packages.
  - Isolated launch commands work perfectly (e.g. `"open Word"`, `"open Calculator"`, `"open VS Code"`).
- **Restrictions:**
  - Cannot accept arguments or subsequent commands.
  - Does not support typing into the launched application (except Notepad).
  - Cannot launch applications that exist only on the user's `PATH` without a Start Menu shortcut or App Path registration.

### 3.2. Google Chrome Automation
- **Status:** **Partial**
- **Capabilities:**
  - Tab listing, tab switching, URL navigation, DOM reading, and link clicking are fully implemented in `ChromeService.cs`.
- **Restrictions:**
  - Requires the user to manually open `chrome://extensions`, enable Developer Mode, and load the unpacked extension from `%LOCALAPPDATA%\Programs\D-ASK\extensions\dask-chrome`.
  - If a user simply types `"open Chrome"`, the daemon tries to connect to the extension; if missing, it times out after 20 seconds instead of immediately launching the browser executable.

### 3.3. Offline Speech-to-Text (STT)
- **Status:** **Partial**
- **Capabilities:**
  - `stt.rs` contains production code to transcribe 16 kHz mono WAV audio via the Windows SAPI 5.4 desktop recognizer.
  - Automated tests pass using pre-recorded audio fixtures.
- **Restrictions:**
  - No background continuous wake-word listening ("Hey Jarvis").
  - Live microphone acceptance has not been formally verified on physical hardware in the release candidate.
  - SAPI 5.4 accuracy is significantly lower than modern neural STT models.

### 3.4. Scholarly Research Mode
- **Status:** **Partial**
- **Capabilities:**
  - Offline dataset analysis (CSV/TSV statistics, Welch t-test, SVG chart generation) and local literature review with LaTeX/BibTeX export.
- **Restrictions:**
  - Online search over arXiv and Crossref requires setting an environment variable (`DASK_RESEARCH_ONLINE=1`) and is disabled by default.
  - Quality of synthesized literature reviews has not been evaluated by human subject-matter experts.

---

## 4. Category 3: Simulated & Mocked Features in Test Suites

A critical finding of this audit is that **several high-visibility capabilities passed automated test suites only because the tests used synthetic mocks rather than real hardware or human interaction**:

| Feature Area | What the Tests Claimed | What Actually Happened in Tests | Real Production Reality |
|---|---|---|---|
| **Human-in-the-Loop (HITL) Approvals** | **97/97 Passed**<br>(`approval-lifecycle.test.ts`) | PowerShell scripts (`scripts/hud/`) programmatically called named pipe endpoints or memory fixtures to simulate clicking "Approve". | **Zero human interactive signoffs.** A real user clicking buttons in the WebView2 HUD was never recorded. |
| **Android Mobile Integration** | **29/29 Passed**<br>(`tests/agent-runtime/android.test.ts`) | Tests ran against mock ADB output strings in unit test memory. | **Zero real phone tests.** `RealDevice_ReadOnlyAndRoundTrip` was skipped because `DASK_LIVE_ANDROID=1` was not set and no phone was attached. |
| **Authenticode Code Signing** | **7/7 Passed**<br>(`tests/package/sign-policy.ps1`) | Policy scripts tested that untrusted certificates were correctly rejected. | **0/9 D-ASK binaries are signed.** All executables (`hud-native.exe`, `DAsk.Daemon.exe`, `dask-ocr.exe`) in the installed build remain unsigned. |
| **Everyday Chrome Profile** | **Passed**<br>(`ChromeLiveTests-everyday-profile-2.log`) | Automated test scripts pre-authorized the session and simulated link clicks on throwaway test pages. | The user's real daily Chrome browsing session was never driven interactively by a human. |
| **Offline Voice Acceptance** | **7/7 Passed**<br>(`results/offline-voice/`) | Audio was fed into SAPI using synthetic `.wav` audio files on disk. | Real-time speech captured from a physical microphone by a human speaker was not tested in the release candidate. |

---

## 5. Architectural Contradictions Summary

The disconnect between automated test metrics and real-world user experience stems from three core architectural contradictions:

1. **The "Happy Path" Regex Bias:**  
   Automated unit tests only test the exact phrases hardcoded in the regexes (e.g., testing `"open Notepad"` and `"open Calculator"` separately). They never tested the natural compound sentence `"open Microsoft Word and type hello"`.
2. **The "Notepad Is The Desktop" Assumption:**  
   Desktop typing was implemented specifically for Notepad's UIA Document control. Because Notepad passed 100% of integration tests, the system was documented as having "Desktop Keyboard Input", obscuring the fact that it could not type into any other application on Windows.
3. **Synthetic Approval Decoupling:**  
   Because safety policies require human approval, automated test suites created automated approval bypasses (fixtures and test hooks). This allowed all 678 daemon tests to pass in CI without proving that a human user can successfully interact with the HUD approval modal in real time.
