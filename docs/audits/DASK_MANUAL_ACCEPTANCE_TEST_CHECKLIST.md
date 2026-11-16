# D-ASK — Manual Acceptance Test Checklist

**Target Installation:** D-ASK Release Candidate `D-ASK-20261115T023936`  
**Installed Location:** `%LOCALAPPDATA%\Programs\D-ASK`  
**Purpose:** Step-by-Step Manual Verification Checklist for Human Testers  
**Date:** 2026-11-16  

---

## 1. Pre-Test Environment Preparation

Before beginning manual testing, ensure the following environment preconditions are met:

1. **System Memory Check:**  
   Open Windows Task Manager (`Ctrl+Shift+Esc`) → *Performance* → *Memory*.  
   **Ensure Available RAM is at least 3.5 GB.** If available RAM is below 3.2 GB, close heavy applications (such as IDEs, Chrome, or Docker) so D-ASK's local inference memory guard does not refuse requests.
2. **Launch Installed D-ASK:**  
   Click the Start Menu shortcut **D-ASK**, or run:
   ```cmd
   "%LOCALAPPDATA%\Programs\D-ASK\Start-D-ASK.cmd"
   ```
3. **Verify Startup:**  
   - The holographic 3D Jarvis Orb should appear in the lower-right area of the screen.
   - The Core Console command bar should be visible and ready for text input.
   - Task Manager should show three running processes: `hud-native.exe`, `DAsk.Daemon.exe`, and `node.exe` (running from the D-ASK directory).

---

## 2. Interactive Acceptance Test Cases

### Category A: Core AI, Reasoning & Offline Knowledge

#### Test Case A1: Offline Mathematical Calculation
- **Preconditions:** D-ASK running; Wi-Fi can be on or off.
- **Exact Prompt:**  
  `What is (17 + 25) * 2?`
- **Expected Behavior in HUD:**  
  - Orb enters "Thinking" state.
  - Event log displays: `Plan ready — 1 steps`, `Step complete: math.evaluate`.
  - Console outputs: `84` with the label `INDEPENDENTLY VERIFIED`.
- **Independent Verification:**  
  Verify mathematical correctness ($42 \times 2 = 84$).
- **Status:** **PASS**

#### Test Case A2: Local Model Knowledge Chit-Chat (Offline)
- **Preconditions:** D-ASK running.
- **Exact Prompt:**  
  `What is the capital of France?`
- **Expected Behavior in HUD:**  
  - Local Qwen 2.5 model generates the answer.
  - Console outputs: `The capital of France is Paris.`
  - The response is explicitly labeled: `ANSWERED BY THE LOCAL MODEL` (never claimed as independently verified).
- **Independent Verification:**  
  Verify that 0 network requests were made to external cloud AI providers.
- **Status:** **PASS**

---

### Category B: Windows Application Lifecycle & Desktop Control

#### Test Case B1: Launch Whitelisted Application (Notepad)
- **Preconditions:** Notepad is not running.
- **Exact Prompt:**  
  `open Notepad`
- **Expected Behavior in HUD:**  
  - Action Approval Modal appears on the HUD displaying:
    * Action: `Open Notepad`
    * Application: `notepad.exe`
    * Reversible: `Yes: close the window.`
  - Click **Approve**.
  - Notepad launches and a new window appears on screen.
  - Event log confirms: `Opened Notepad: a new Notepad window titled "Untitled - Notepad" is open`.
- **Independent Verification:**  
  Check Task Manager for `notepad.exe`.
- **Status:** **PASS**

#### Test Case B2: Launch Discovered Application (Microsoft Word)
- **Preconditions:** Microsoft Word installed; Word closed.
- **Exact Prompt:**  
  `open Microsoft Word`
- **Expected Behavior in HUD:**  
  - Action Approval Modal appears on the HUD displaying:
    * Action: `Open Word`
    * Target: `C:\Program Files\Microsoft Office\Root\Office16\WINWORD.EXE`
  - Click **Approve**.
  - Microsoft Word starts and its window appears in the foreground.
- **Independent Verification:**  
  Check Task Manager for `WINWORD.EXE`.
- **Status:** **PASS**

#### Test Case B3: Compound Launch + Type (Known Bug Verification)
- **Preconditions:** Microsoft Word closed.
- **Exact Prompt:**  
  `open Microsoft Word and type hello`
- **Expected Behavior (Known Failure):**  
  - D-ASK immediately refuses with:  
    *"I can't click, type, scroll, move, resize, close or launch anything. I can list open windows, describe a window you name..."*
  - **No approval card appears; Word never launches.**
- **Diagnostic Cause:**  
  Regex parsing failure in `agent/runtime/tools/desktop.ts` (`appSession` only supports Notepad; `openAppRequest` fails on trailing text).
- **Status:** **FAIL (Reported Release Blocker)**

#### Test Case B4: Native Office Word Document Generation (The Working Word Workflow)
- **Preconditions:** Microsoft Word installed.
- **Exact Prompt:**  
  `create a new word document named "AuditReport" with text "This document was generated offline by D-ASK."`
- **Expected Behavior in HUD:**  
  - Approval Modal appears:
    * Action: `Create Word document "AuditReport.docx"`
    * Destination: `%USERPROFILE%\Documents\AuditReport.docx`
  - Click **Approve**.
  - Daemon uses background Office COM automation to write the `.docx` file.
  - Console confirms: `Created AuditReport.docx`.
- **Independent Verification:**  
  Open File Explorer, navigate to `%USERPROFILE%\Documents\`, and open `AuditReport.docx` in Word. Confirm the text is present.
- **Status:** **PASS**

---

### Category C: Desktop Input Automation (Mouse & Keyboard)

#### Test Case C1: Guarded Typing into Notepad
- **Preconditions:** Notepad closed.
- **Exact Prompt:**  
  `open Notepad and type "Hello World from D-ASK"`
- **Expected Behavior in HUD:**  
  - Step 1 Approval Modal: `Open Notepad`. Click **Approve**.
  - Notepad opens.
  - Step 2 Approval Modal: `Type into Notepad (Text editor)`. Click **Approve**.
  - Text `"Hello World from D-ASK"` is typed into Notepad's document area.
- **Independent Verification:**  
  Inspect the open Notepad window on your desktop to verify the text was typed.
- **Status:** **PASS**

#### Test Case C2: Physical User Input Intervention (Safety Test)
- **Preconditions:** Submit a prompt requiring typing: `open Notepad and type "This is a very long text paragraph intended to test physical user input intervention."`
- **Action During Execution:**  
  As soon as typing begins in Notepad, **immediately move your physical mouse or strike any key on your keyboard**.
- **Expected Behavior:**  
  - Typing halts immediately (within 15 ms).
  - D-ASK aborts execution and reports: `interrupted_by_user`.
  - No keys remain stuck down.
- **Independent Verification:**  
  Verify that the full sentence was not completed in Notepad.
- **Status:** **PASS**

#### Test Case C3: Window State Minimization and Restoration
- **Preconditions:** Notepad open on screen.
- **Exact Prompt:**  
  `minimize the Notepad window`
- **Expected Behavior in HUD:**  
  - Approval Modal appears: `Minimize window "Untitled - Notepad"`.
  - Click **Approve**.
  - The Notepad window minimizes to the Windows taskbar.
- **Follow-up Prompt:**  
  `restore the Notepad window`
- **Expected Behavior:**  
  - Approval Modal appears: `Restore window "Untitled - Notepad"`.
  - Click **Approve**.
  - The Notepad window unminimizes and returns to the screen.
- **Status:** **PASS**

---

### Category D: Browser Automation & Web Operations

#### Test Case D1: Standalone Google Chrome Launch
- **Preconditions:** Google Chrome closed.
- **Exact Prompt:**  
  `open Chrome`
- **Expected Behavior in HUD:**  
  - Approval Modal appears: `Open Google Chrome`.
  - Click **Approve**.
  - Chrome starts and opens on your desktop.
- **Independent Verification:**  
  Verify `chrome.exe` is running.
- **Status:** **PASS**

#### Test Case D2: Web Search via Chrome (Known Failure Verification)
- **Preconditions:** Wi-Fi connected and active; Chrome running.
- **Exact Prompt:**  
  `open Chrome and search for "weather"`
- **Expected Behavior (Known Failure):**  
  - D-ASK reports:  
    *"A web search needs internet access, and D-ASK is in offline mode (web searches are switched off: AgentHost:WebSearch). Nothing was opened or searched."*
  - **No search is executed, despite your active Wi-Fi.**
- **Diagnostic Cause:**  
  Security policy flag `AgentHost:WebSearch` defaults to `false`. Conflates policy lock with physical network disconnection.
- **Status:** **FAIL (Reported Release Blocker)**

#### Test Case D3: Tab Inspection with D-ASK Chrome Extension
- **Preconditions:**  
  1. Open Chrome.
  2. Navigate to `chrome://extensions`.
  3. Enable **Developer mode** (top-right toggle).
  4. Click **Load unpacked** and select:
     `%LOCALAPPDATA%\Programs\D-ASK\extensions\dask-chrome`
  5. Open two tabs: `wikipedia.org` and `github.com`.
- **Exact Prompt:**  
  `list my Chrome tabs`
- **Expected Behavior in HUD:**  
  - First-time authorization modal appears: `Let D-ASK control your Google Chrome`. Click **Approve**.
  - D-ASK lists your open Chrome tabs with their titles and URLs.
- **Status:** **PASS (When Extension Pre-Installed)**

---

### Category E: System Administration & OS Control

#### Test Case E1: Query System Audio Status
- **Preconditions:** D-ASK running.
- **Exact Prompt:**  
  `What's the volume?`
- **Expected Behavior in HUD:**  
  - D-ASK reads Windows Core Audio endpoint and reports volume percentage and mute status.
- **Status:** **PASS**

#### Test Case E2: Set System Audio Volume
- **Preconditions:** D-ASK running.
- **Exact Prompt:**  
  `set volume to 25%`
- **Expected Behavior in HUD:**  
  - Approval Modal appears: `Set volume to 25%`.
  - Click **Approve**.
  - Windows volume changes to 25%.
- **Independent Verification:**  
  Click the Windows speaker icon in the taskbar; verify slider shows 25%.
- **Status:** **PASS**

#### Test Case E3: Query Display Settings
- **Preconditions:** D-ASK running.
- **Exact Prompt:**  
  `Show the display settings`
- **Expected Behavior in HUD:**  
  - Outputs current resolution, refresh rate, and brightness percentage.
- **Status:** **PASS**

#### Test Case E4: List Running Processes
- **Preconditions:** D-ASK running.
- **Exact Prompt:**  
  `what processes are running?`
- **Expected Behavior in HUD:**  
  - Outputs list of top running processes sorted by memory consumption.
- **Status:** **PASS**

---

### Category F: Filesystem & Notes Management

#### Test Case F1: Search Files by Name
- **Preconditions:** Files present in `%USERPROFILE%\Documents\`.
- **Exact Prompt:**  
  `find files named "*.md" in my workspace`
- **Expected Behavior in HUD:**  
  - Outputs list of matching markdown files within allowed roots.
- **Status:** **PASS**

#### Test Case F2: Create a Structured Note
- **Preconditions:** D-ASK running.
- **Exact Prompt:**  
  `create a note titled "MeetingNotes" with content "Discussed Q4 roadmap and D-ASK release."`
- **Expected Behavior in HUD:**  
  - Approval Modal appears: `Create note "MeetingNotes.md" in Documents\D-ASK\Notes`.
  - Click **Approve**.
  - Note is written to disk.
- **Independent Verification:**  
  Open `%USERPROFILE%\Documents\D-ASK\Notes\MeetingNotes.md` in Notepad.
- **Status:** **PASS**

---

### Category G: Safety & Emergency Stop Verification

#### Test Case G1: Action Approval Declination
- **Preconditions:** Notepad closed.
- **Exact Prompt:**  
  `open Notepad`
- **Action on Approval Modal:**  
  Click **Decline** (or press Esc).
- **Expected Behavior:**  
  - Approval card closes immediately.
  - D-ASK reports: `You declined. Nothing was opened.`
  - Notepad does not launch; 0 OS processes started.
- **Status:** **PASS**

#### Test Case G2: Global Emergency Stop (`Ctrl+Shift+F12`)
- **Preconditions:** Any multi-step task running or approval modal open.
- **Action:**  
  Press **`Ctrl+Shift+F12`** on your keyboard.
- **Expected Behavior:**  
  - Jarvis Orb immediately turns red (Emergency Stop state).
  - Active task is cancelled instantly.
  - Any pending approvals are permanently invalidated.
  - Any playing TTS audio stops mid-syllable.
- **Status:** **PASS**

---

### Category H: Speech & Voice Interaction

#### Test Case H1: Windows SAPI Voice Command
- **Preconditions:** USB/built-in microphone enabled and unmuted in Windows Settings.
- **Action:**  
  Click the microphone icon on the HUD, and speak clearly:
  > *"What's the volume?"*
- **Expected Behavior:**  
  - Audio waveform animates.
  - SAPI transcribes audio into `#ultron-command`.
  - D-ASK processes the command and speaks the answer aloud.
- **Status:** **MANUAL VERIFICATION REQUIRED**

---

## 3. Manual Testing Summary Sheet

| Area | Test Prompt / Action | Expected Result | Pass / Fail |
|---|---|---|---|
| **AI** | `What is (17 + 25) * 2?` | Output: `84` (Independently Verified) | [ ] Pass  [ ] Fail |
| **AI** | `What is the capital of France?` | Output: `Paris` (Answered by local model) | [ ] Pass  [ ] Fail |
| **App** | `open Notepad` | Approval card → Notepad opens | [ ] Pass  [ ] Fail |
| **App** | `open Microsoft Word` | Approval card → Word opens | [ ] Pass  [ ] Fail |
| **App** | `open Microsoft Word and type hello` | **Fails immediately (Actuation Refusal Bug)** | [ ] Expected Bug Confirmed |
| **Input** | `open Notepad and type "Test 123"` | Approval 1 → Approval 2 → Text in Notepad | [ ] Pass  [ ] Fail |
| **Input** | Move physical mouse while D-ASK types | Typing aborts instantly (`interrupted_by_user`) | [ ] Pass  [ ] Fail |
| **Office** | `create a new word document named "Test" with text "Sample"` | Document created in `Documents\Test.docx` | [ ] Pass  [ ] Fail |
| **Browser** | `open Chrome and search for "news"` | **Fails with "offline mode" (Policy Bug)** | [ ] Expected Bug Confirmed |
| **System** | `What's the volume?` | Volume percentage displayed | [ ] Pass  [ ] Fail |
| **System** | `set volume to 25%` | Approval card → Windows volume set to 25% | [ ] Pass  [ ] Fail |
| **Safety** | Click "Decline" on approval card | Action aborted honestly; nothing changed | [ ] Pass  [ ] Fail |
| **Safety** | Press `Ctrl+Shift+F12` | Emergency Stop latches; Orb turns red | [ ] Pass  [ ] Fail |
| **Voice** | Speak: *"What's the volume?"* | Transcribed and answered aloud | [ ] Pass  [ ] Fail |
