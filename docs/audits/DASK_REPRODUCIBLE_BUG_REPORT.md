# D-ASK — Reproducible Defect & Bug Discovery Report

**Document Reference:** DASK-QA-BUGS-20261116  
**Auditor:** Independent QA and Testing Agent  
**Build Evaluated:** `D-ASK-20261116T223649`  
**Package Manifest SHA-256:** `989AA74C4AF311C7BB4694EF23596CD6A7496E7A636B7FFC41A26D1BE944ABDE`  
**Installed Target Path:** `%LOCALAPPDATA%\Programs\D-ASK` (218 package files verified)  
**Commit Baseline:** `2fbae54` on branch `main` (with verified remediations from `2026-11-16`)  
**Host Environment:** Windows 11 Home (Build 26100), Intel Core i5-1335U, 16 GB RAM  
**Date:** 2026-11-16  

---

## Defect Inventory Overview

| Bug ID | Title | Component | Severity | Priority | Status |
|---|---|---|---|---|---|
| **BUG-001** | `npm run test:security` crashes with `ENOENT` looking for deleted `main.js` | `tests/security/api-auth.test.ts` | **High** | **P1** | **RESOLVED & VERIFIED** |
| **BUG-002** | Screen Observation BitBlt Capture Failure in Headless / Unattended Sessions | `src/DAsk.Daemon/.../Win32ScreenObservationService.cs` | **Medium** | **P2** | **RESOLVED & VERIFIED** |
| **BUG-003** | Microsoft SAPI 5.4 Phonetic Substitution Error on Indian Proper Nouns | `src/hud-native/src/stt.rs` | **Medium** | **P2** | **RESOLVED & VERIFIED** |
| **BUG-004** | Chromium Headless Speech Synthesis Reports Zero Available Audio Voices | `tests/hud-agent/voice.test.ts` | **Low** | **P3** | Documented (Environment) |
| **BUG-005** | Node.js `DEP0190` Deprecation Warning on Child Process Spawning | `tests/hud-agent/voice.test.ts` | **Low** | **P3** | Code Hygiene |
| **BUG-006** | Packaged HUD Test Harness Halts Closed When No Foreground Window Exists | `scripts/hud/hud-driver.ps1` | **Informational** | **P3** | By Design (Safety) |
| **BUG-007** | Windows OCR Window Text Read Fails When Fixture Window Is Occluded | `tests/DAsk.Daemon.Tests/WindowTextReadTests.cs` | **Low** | **P3** | Documented (Environmental) |
| **BUG-008** | Physical Offline Voice Failure in Installed Build (VAD Dilution & AudioContext Suspension) | `components/JarvisOrb.tsx`, `lib/pcmRecorder.ts` | **High** | **P1** | **RESOLVED & VERIFIED** |
| **BUG-009** | Strict TypeScript nullability error in `tests/hud-agent/voice-capture.test.ts:275` | `tests/hud-agent/voice-capture.test.ts` | **Low** | **P3** | Reported for Claude Code |

---

## Detailed Bug Reports & Resolution Verification

### BUG-001: `npm run test:security` Crashes with `ENOENT` Looking for Deleted `main.js`
- **Severity:** High (Severity 1 - Broken Core Security Test Suite)
- **Component:** Test Infrastructure / API Security Verification
- **Status:** **RESOLVED & INDEPENDENTLY VERIFIED** in Build `210103` and preserved in `223649`
- **Remediation:** Removed references to `main.js`; validates socket loopback bindings via static AST check; constant-time auth tokens via `crypto.timingSafeEqual`.
- **Verification:** `npm run test:security` passed **220/220 assertions**.

---

### BUG-002: Screen Observation BitBlt Capture Failure in Headless / Unattended Sessions
- **Severity:** Medium (Severity 2 - Unattended Automation Degradation)
- **Component:** Daemon / Screen Observation Subsystem
- **Status:** **RESOLVED & INDEPENDENTLY VERIFIED** in Build `210103` and preserved in `223649`
- **Remediation:** Added `InteractiveDesktop.Probe()`. When desktop composition is unavailable, it fails closed gracefully with code `DesktopUnavailable`.
- **Verification:** Full .NET daemon test suite passed **242 passed, 0 failed, 11 skipped**.

---

### BUG-003: SAPI / Whisper Fallback Reporting & Diagnostics
- **Severity:** Medium (Severity 2 - Diagnostic Invisibility)
- **Component:** Rust Native HUD / Speech-to-Text Pipeline
- **Status:** **RESOLVED & INDEPENDENTLY VERIFIED** in Build `210103` and preserved in `223649`
- **Remediation:** Added `/api/stt/status` endpoint and detailed transcript metadata (`Transcript.fallback_reason`) in `stt.rs` and `whisper.rs`.
- **Verification:** `cargo test` in `src/hud-native` passed **74 passed, 0 failed, 4 ignored**.

---

### BUG-008: Physical Offline Voice Failure in Installed Build
- **Severity:** High (Severity 1 - Core User Interaction Failure)
- **Component:** Frontend Audio Capture, VAD, Normalization, & Pre-roll
- **Files Affected:** `components/JarvisOrb.tsx`, `lib/pcmRecorder.ts`, `lib/micSession.ts`, `lib/voiceActivity.ts`
- **Discovered In:** Build `D-ASK-20261116T210103`
- **Current Status:** **RESOLVED & VERIFIED** in Build `D-ASK-20261116T223649`
- **User Physical Acceptance:** **CONFIRMED & PASSED BY HUMAN USER**

#### Description & Root Cause:
In build `210103`, physical offline voice failed completely on real hardware. Independent diagnosis revealed:
1. `AudioContext` was instantiated asynchronously without synchronous user gesture and never called `resume()`, keeping it suspended in WebView2.
2. The VAD averaged all 128 FFT bins across 0–24 kHz against a fixed `0.05` threshold. On this machine's Intel microphone array, real speech peak amplitude was measured at **0.29% full-scale (-50.7 dBFS)**, evaluating to `normalized = 0.002`, failing to trigger the recorder.
3. Lack of pre-roll ring buffer clipped the first 200–500 ms of speech if shouted.
4. Un-normalized PCM audio caused Whisper to evaluate input as silence (`[BLANK_AUDIO]`), returning an empty transcript that was silently dropped.

#### Remediation Implemented in Build `223649`:
1. **Synchronous Entry:** `new AudioContext()` and `ctx.resume()` called synchronously in `lib/micSession.ts` during user click/hotkey event.
2. **Speech-Band VAD:** Implemented `SpeechBandMeter` with 4th-order biquad bandpass filter (300–4500 Hz) and dynamic noise-floor learning in `lib/voiceActivity.ts`.
3. **500 ms Pre-Roll Buffer:** Implemented `PreRollBuffer` in `lib/pcmRecorder.ts` to retain audio leading up to the trigger.
4. **Digital Peak Normalization:** `prepareForStt` in `lib/pcmRecorder.ts` amplifies speech to -1 dBFS with soft-knee limiter for transients, while rejecting pure silence and noise.
5. **HUD Feedback:** Clear status messages displayed for all recording states and rejection causes.

#### Independent QA Verification:
- Automated suite `tests/hud-agent/voice-capture.test.ts`: **41/41 passed, 0 failed**.
- Automated suite `tests/hud-agent/voice.test.ts`: **7/7 passed, 0 failed**.
- **Human Physical Test:** User confirmed microphone detected, audio level ring animated, local Whisper transcribed, approval card appeared, and Notepad opened and typed into.

---

### BUG-009: Strict TypeScript Nullability Error in `voice-capture.test.ts`
- **Severity:** Low (Severity 3 - Test Code Typing Inconsistency)
- **Component:** Test Code (`tests/hud-agent/voice-capture.test.ts`)
- **Status:** **Reported for Claude Code**
- **Description:** Line 275 contains:
  ```ts
  check(sf.kind === "issue" && sf.issue === "stt-failed" && sf.detail?.includes("timeout"), "...");
  ```
  `sf.detail?.includes("timeout")` evaluates to `boolean | undefined`. Under `strictNullChecks`, `check(cond: boolean)` flags type error TS2345.
- **Recommended Remediation for Claude Code:** Add `Boolean(...)` or `!!(...)` around the optional chain expression.
- **Impact:** Test logic executes and passes cleanly under tsx; affects only strict `tsc --noEmit`. Does not affect production application runtime.
