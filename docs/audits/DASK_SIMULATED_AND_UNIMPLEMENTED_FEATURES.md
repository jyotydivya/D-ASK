# D-ASK — Audit of Real, Simulated, Constrained, and Unimplemented Features

**Audit Scope:** Verification of Real-World OS Actuation vs. Mocks, Stubs, Simulations, and Test Harness Artifices  
**Release Target:** D-ASK Release Candidate `D-ASK-20261115T023936`  
**Date:** 2026-11-16  

---

## 1. Executive Summary

A critical objective of this audit is distinguishing between:
1. **Real Production Functionality:** Code that drives real Windows APIs, manages live processes, verifies physical UI state changes, and records cryptographically signed evidence.
2. **Constrained Functionality:** Code that is fully implemented for a narrow, hardcoded target (e.g., Notepad) but fails for general targets.
3. **Simulated / Synthetic Verification:** Code where automated test suites pass by injecting synthetic approvals or driving mock subprocesses without human or physical hardware involvement.
4. **Detached / Legacy Prototypes:** Code left over from earlier project phases (e.g., Next.js web orchestrator, PyAutoGUI scripts) that is not part of the active native production pipeline.
5. **Unimplemented Features:** Capabilities visible in UI concepts, documentation, or design files that lack an underlying execution path.

---

## 2. Granular Subsystem Breakdown

### 2.1. Desktop Input Injection (Mouse & Keyboard)

| Subsystem Component | Operational Reality | Evidence & Technical Detail |
|---|---|---|
| **Notepad Text Entry** | **REAL** | Driven by `GuardedInputRequestService.cs` and `Win32GuardedInput.cs`. Resolves the UIA `Document` named `"Text editor"`, sets text via COM `IValueProvider.SetValue`, and reads back the content via UI Automation. |
| **Generic Text Entry into Other Windows (MS Word, WordPad, Browsers)** | **UNIMPLEMENTED** | No generic or focused text entry pathway exists. `desktop.ts` requires `{ controlType: "Document", name: "Text editor" }`. Without this exact element name, text injection fails. |
| **Mouse Click Injection (Buttons, Menus, Links)** | **REAL** | `Win32GuardedInput.cs` uses native Win32 `SendInput` (`MOUSEEVENTF_LEFTDOWN`, `MOUSEEVENTF_LEFTUP`). Derives coordinates strictly from UIA element bounding rectangles. |
| **Physical Intervention Safety Hook** | **REAL** | Uses Win32 low-level hooks (`WH_MOUSE_LL`, `WH_KEYBOARD_LL`). Any physical mouse movement or keypress by the human user immediately aborts the active input sequence. |
| **Legacy Python Desktop Automation (`mouse_keyboard.py`)** | **STUBBED / DETACHED** | Early implementation in `lib/agent/tools/desktop/python/mouse_keyboard.py` used PyAutoGUI with hardcoded coordinates. This is completely blocked by `BLOCKED_ACTUATION_TOOLS` in `lib/agent/tools/desktop/pcAgent.ts` and is never invoked by the production daemon. |

---

### 2.2. Windows Application Lifecycle & Control

| Subsystem Component | Operational Reality | Evidence & Technical Detail |
|---|---|---|
| **Notepad, Calculator, Charmap** | **REAL** | Handled via `AppLaunchRequestService.cs` and `KnownApps.cs`. Starts executable via `Process.Start` (no shell), observes window appearance over UIA, and records `LaunchedWindow`. |
| **General Installed Applications (MS Word, VS Code, Excel)** | **REAL (Single) / BROKEN (Compound)** | Isolated application launch (e.g. `"open Word"`) is REAL: `InstalledAppCatalog.cs` discovers shortcuts and executables and starts them cleanly. However, compound instructions (e.g. `"open Word and type hello"`) are BROKEN due to agent regex parsing failures. |
| **Window State Management (Minimize, Maximize, Restore, Focus)** | **REAL** | Handled via `WindowOperationExecutor.cs`. Calls Win32 `ShowWindow` and `SetForegroundWindow` bound to validated window handles (`HWND`). |

---

### 2.3. Browser Control & Web Automation

| Subsystem Component | Operational Reality | Evidence & Technical Detail |
|---|---|---|
| **Chrome Tab Management & Content Reading** | **REAL (Requires Manual Extension Setup)** | Driven by `ChromeService.cs` and `dask-chrome-host.exe`. Communicates with Chrome via Native Messaging. Real DOM reading, tab switching, and link clicking. |
| **Everyday Chrome Profile Human Testing** | **SIMULATED IN ACCEPTANCE** | In test suites (`results/console-access/ChromeLiveTests-everyday-profile-2.log`), approvals were injected programmatically by the test runner (`scripts/hud/`), not clicked by a human user. |
| **Web Search Execution** | **BROKEN BY POLICY** | Web search is blocked by default (`AgentHost:WebSearch = false`). When invoked, the daemon returns `offline_mode` without probing network connectivity. |
| **Headless Playwright Automation (`playwrightEngine.ts`)** | **UNIMPLEMENTED / UNREGISTERED** | `agent/runtime/browser/playwrightEngine.ts` exists in the repository but is omitted from `defaults.ts`. No headless Playwright instance is bundled or run. |

---

### 2.4. Filesystem, Workspace & Notes

| Subsystem Component | Operational Reality | Evidence & Technical Detail |
|---|---|---|
| **Workspace File Search & Text Grep** | **REAL** | Pure Node.js filesystem traversal in `filesystem.ts` and `fileAccess.ts`. Strictly confines file access to approved folder roots and redacts sensitive tokens. |
| **File Organization (Move / Rename)** | **REAL** | Two-phase operation (preview → approval → execution) in `FileOrganizeRequestService.cs`. Verifies file movement using file system stat checks. |
| **Note Creation** | **REAL** | Writes approved markdown files to designated notes directory via `NoteCreateRequestService.cs`. |
| **Developer Code Replacement (`dev.edit_file`)** | **REAL** | Finds exact matching blocks and applies replacements with diff verification in `DevEditService.cs`. |

---

### 2.5. Autonomous Planning & Multi-Agent Architecture

| Subsystem Component | Operational Reality | Evidence & Technical Detail |
|---|---|---|
| **Deterministic Intent & Grounding Engine** | **REAL** | Production runtime (`agent/runtime/grounding.ts`) extracts facets, pins arguments, and validates requests deterministically. |
| **Single-Agent Local LLM Planning (`Brain.ts`)** | **REAL** | Calls local `llama-server.exe` with Qwen 2.5 GGUF. Validates 2-turn JSON schema proposals. |
| **Multi-Agent Orchestrator (`orchestrator.ts`, `blackboard.ts`)** | **DETACHED / LEGACY** | Code exists under `agent/orchestrator.ts` with sub-agents (`browserAgent`, `codingAgent`, `deviceAgent`, `pcAgent`), but this belongs to the legacy web prototype and is never invoked by `stdioHost.ts`. |

---

### 2.6. Action Approvals, Human-in-the-Loop & Safety Verification

| Subsystem Component | Operational Reality | Evidence & Technical Detail |
|---|---|---|
| **Approval Token Validation & Action Hashes** | **REAL** | Daemon enforces SHA-256 canonical parameter hashes, single-use token consumption, and process creation time verification. |
| **Human-in-the-Loop Acceptance (HITL)** | **SIMULATED BY AUTOMATED HARNESSES** | **Critical Finding:** All documented 97/97 approval lifecycle tests and acceptance passes were executed by PowerShell automation scripts (`scripts/hud/*.ps1`) that simulated user decisions. **Genuine human-in-the-loop interactive click-through has never been formally recorded or signed off.** |
| **Emergency Stop (`Ctrl+Shift+F12`)** | **REAL** | Win32 low-level keyboard hook runs on a dedicated thread in `src/hud-native/src/state/emergency_stop.rs`. Monotonically increments stop epoch and purges pending actions. |

---

### 2.7. Mobile Subsystem (Android via ADB)

| Subsystem Component | Operational Reality | Evidence & Technical Detail |
|---|---|---|
| **ADB Architecture & Logic** | **REAL IN CODE** | Daemon contains complete `AndroidService.cs` managing device discovery, file transfers, and keyevents. |
| **Physical Device Verification** | **SIMULATED MOCKS ONLY** | The 29/29 passed tests in `tests/agent-runtime/android.test.ts` and 7 tests in `AndroidTests.cs` ran against fake/mock ADB outputs. The release candidate has never communicated with a real physical Android smartphone (`DASK_LIVE_ANDROID=1` was never active). |

---

### 2.8. Distribution & Binary Code Signing

| Subsystem Component | Operational Reality | Evidence & Technical Detail |
|---|---|---|
| **Signing Script Pipeline (`Sign-D-ASK.ps1`)** | **REAL IN CODE** | Implements inventory, sign, and verify modes with strict policy enforcement (refuses self-signed/private-root certs). |
| **Actual Shipped Binaries in Release Package** | **UNSIGNED (0/9 Signed)** | The release package `D-ASK-20261115T023936` contains **0 signed D-ASK binaries**. `hud-native.exe`, `DAsk.Daemon.exe`, and `dask-ocr.exe` are unsigned because no publicly trusted EV/OV code-signing certificate exists in the workspace. |

---

## 3. Summary of Apparent vs. Actual Functionality

| Apparent Feature in HUD / Docs | Reality Under the Hood | Technical Cause |
|---|---|---|
| **"Universal Desktop Automation"** | **Restricted to Notepad & Window State** | No universal typing target exists; only Notepad has a configured UIA `Document` editor binding. |
| **"Offline-First Web Search"** | **Completely Blocked by Configuration** | `AgentHost:WebSearch` defaults to `false`. Search requests fail with `offline_mode` even when Wi-Fi is active. |
| **"Human-Approved Safety"** | **Harness-Simulated Approvals** | Acceptance was proven by synthetic PowerShell scripts injecting approvals into named pipes, not human users clicking the HUD. |
| **"Android Phone Control"** | **Mock-Only ADB Verification** | Tested exclusively against mock command stubs; 0 real-phone verification. |
| **"Signed Windows Application"** | **Unsigned Binaries** | Signing pipeline exists, but zero D-ASK binaries are signed due to lack of a public CA certificate. |
