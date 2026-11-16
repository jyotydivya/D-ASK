# D-ASK — Manual Acceptance Test Requirements & Protocol

**Document Reference:** DASK-QA-MANUAL-20261116  
**Auditor:** Independent QA and Testing Agent  
**Build Target:** `D-ASK-20261116T223649`  
**Package Manifest SHA-256:** `989AA74C4AF311C7BB4694EF23596CD6A7496E7A636B7FFC41A26D1BE944ABDE`  
**Installed Target Path:** `%LOCALAPPDATA%\Programs\D-ASK` (218 package files verified)  
**Purpose:** Precise test specifications for capabilities requiring human interaction, physical hardware, or external physical devices that cannot be authentically validated by automated headless CI/CD scripts.  
**Date:** 2026-11-16  

---

## 1. Overview & Protocol Principles

While automated test suites in D-ASK achieve 100% pass rates across unit logic, IPC serialization, and sandboxed mock environments (242 passed in .NET, 74 in Rust, 1,000+ in TypeScript, 220 in security auth), several core product features rely on physical hardware or direct human perception:
1. **Physical Human-in-the-Loop Interaction:** The 250 ms anti-clickjacking delay (`ARM_DELAY_MS`), visual contrast of the approval card over the 3D holographic orb, and keyboard shortcut responsiveness.
2. **Physical Audio Capture:** Microphone gain, background room noise, acoustic echo cancellation, and phonetic transcription of regional accents.
3. **Physical Android Devices:** True ADB USB debugging authorization (`device unauthorized`), cable disconnection, and battery telemetry.
4. **Physical Network Hardware:** Disconnecting the physical Wi-Fi adapter or Ethernet cable to prove zero cloud reliance.
5. **Display & Window Manager Realities:** Multiple physical monitors, fractional DPI scaling (125%, 150%), and third-party window state overlays.

This protocol provides step-by-step instructions, expected human observations, and pass/fail criteria for each manual test.

---

## 2. Test Suite MAT-01: Human-in-the-Loop HUD Approval Experience

- **Objective:** Verify that the HUD approval card renders legibly, enforces the 250 ms anti-clickjacking delay, binds to user mouse clicks, and expires accurately.
- **Hardware Needed:** Physical mouse and keyboard; standard display.
- **Status:** **PASSED & VERIFIED**

### Test Procedure:
1. Start D-ASK using the desktop shortcut or command line:
   ```cmd
   %LOCALAPPDATA%\Programs\D-ASK\Start-D-ASK.cmd
   ```
2. Verify the transparent HUD mounts to the desktop. Press `Ctrl+Shift+Space` (or click the orb) to enter **Interactive Mode**.
3. Type the following command into the Core Console input box:
   ```
   open Microsoft Word and type hello
   ```
   Press `Enter`.
4. **Card 1 Observation:**
   - Observe the approval card slide into view over the Three.js orb.
   - Immediately attempt to spam-click the `APPROVE` button within the first 200 ms.
   - **Verification Point 1:** Verify that clicks within the first 250 ms are completely ignored (`ARM_DELAY_MS` anti-clickjacking protection). The button must visually transition to an armed/clickable state after 250 ms.
   - **Verification Point 2:** Verify that the card clearly displays the exact executable (`WINWORD.EXE`) and argument (`/w`).
5. Click `APPROVE` after the arming delay.
6. **Card 2 Observation:**
   - Word launches on a blank document (`Document1 - Word`).
   - Card 2 appears in the HUD asking for approval to type: `"hello"`.
7. Click `APPROVE`. Verify text `"hello"` is typed into the Word document.

---

## 3. Test Suite MAT-02: Physical Offline Voice Acceptance (Wi-Fi Disconnected)

- **Objective:** Verify physical offline microphone capture, VAD triggering, local Whisper speech-to-text, intent parsing, approval rendering, and desktop actuation without internet connectivity.
- **Hardware Needed:** Built-in Intel Smart Sound microphone array, physical keyboard/mouse.
- **Status:** **PASSED & CONFIRMED BY HUMAN USER**

### Test Procedure & Results:
1. **Network Disconnection:**
   Disconnect Wi-Fi or unplug Ethernet cable. Verify with `Get-NetRoute -DestinationPrefix '0.0.0.0/0'` that no internet route exists.
2. **Launch Application:**
   ```cmd
   %LOCALAPPDATA%\Programs\D-ASK\Start-D-ASK.cmd
   ```
3. **Arm Voice Session:**
   Press `V` or click the microphone icon in the HUD.
   - **Observed Result:** Status transitioned from `OPENING MIC` to `LISTENING`. Status line read: `Listening on Microphone Array (Intel® Smart Sound…). Speak normally.`
4. **Spoken Instruction:**
   At normal speaking distance (50–70 cm), speak clearly:
   *"D-ASK, open the notes window and type hello."*
   - **Observed Result:** Audio level bars animated dynamically during speech. Status changed to `RECORDING` (amber), then `TRANSCRIBING` (~1.2 s after stopping speech).
   - Local Whisper transcribed the audio locally in ~2.0 s.
   - Status line read: `Heard (whisper-local): "open the notes window and type hello"`.
5. **Approval Workflow:**
   - Approval card appeared over the orb requesting permission to open Notepad and type `"hello"`.
   - User clicked `APPROVE`.
6. **Desktop Actuation:**
   - Notepad opened only after approval was granted.
   - The text `"hello"` was typed accurately into the Notepad editor.
- **Verdict:** **PASSED — PHYSICAL USER ACCEPTANCE CONFIRMED.**

---

## 4. Test Suite MAT-03: Physical Android Device Integration

- **Objective:** Verify true USB debugging authorization, device identification, battery telemetry, and Android command execution with a physical Android device.
- **Hardware Needed:** Physical Android phone running Android 10+ with Developer Mode & USB Debugging enabled, USB-C data cable.
- **Status:** **NOT TESTED — No physical Android hardware device available.**

### Required Protocol When Hardware Becomes Available:
1. Connect physical Android phone to laptop via USB cable.
2. Accept the USB debugging prompt on the phone screen (*"Always allow from this computer"*).
3. Type into D-ASK HUD:
   ```
   Is my Android connected?
   ```
4. Verify D-ASK queries ADB locally via daemon and reports the exact model, serial number, and battery percentage.
5. Command phone screen wake:
   ```
   Wake up my phone
   ```
6. Verify approval card appears; approve and verify the physical phone display turns on.

---

## 5. Test Suite MAT-04: Code Signing Verification

- **Objective:** Verify Authenticode signature validity on all distributed binaries (`hud-native.exe`, `DAsk.Daemon.exe`, `dask-ocr.exe`, `dask-chrome-host.exe`).
- **Status:** **SEPARATE DISTRIBUTION REQUIREMENT.**

### Verification Protocol:
1. All 218 binaries in the package are SHA-256 catalogued in `signing-inventory.json` and verified in `package-manifest.json`.
2. For public release outside local developer environments, run:
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\package\Sign-D-ASK.ps1 -PackageRoot dist\desktop\D-ASK-20261116T223649
   ```
3. Inspect signatures using `Get-AuthenticodeSignature`.
