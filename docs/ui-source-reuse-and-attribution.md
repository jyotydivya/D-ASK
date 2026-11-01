# D-ASK UI Source Reuse and Attribution Map

## 1. Upstream Source Repository & License Compliance

### 1.1 Authoritative Reference Repository
* **Project**: ULTRON Orb UI
* **Repository**: [`https://github.com/SAGAR-TAMANG/ultron-by-sagar-builds`](https://github.com/SAGAR-TAMANG/ultron-by-sagar-builds)
* **Author / Creator**: Sagar Tamang ([@sagar_builds](https://github.com/SAGAR-TAMANG))
* **License**: **MIT License**
* **Project Description**: An open-source, Iron Man/Jarvis-inspired holographic user interface built with Next.js, Three.js, and MediaPipe bare-hand gesture recognition.

### 1.2 MIT License Terms & Attribution Notice
The upstream repository is distributed under the terms of the MIT License:

```text
MIT License

Copyright (c) 2025 Sagar Tamang

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 1.3 Compliance Directives
1. **Attribution Preservation**: The copyright notice above must be preserved in all source distributions and documentation.
2. **Modular Boundary**: D-ASK retains the original UI files as the visual interface layer, keeping upstream authorship clear and distinct from D-ASK's native Rust host and .NET daemon.
3. **No Wholesale Overwrites**: Changes made to the UI are focused on transparent composition adjustments and connecting to the D-ASK native IPC bridge, preserving all original artistic geometry, shaders, and animations.

---

## 2. Component-Level Reuse & Migration Map

The table below catalogs every component, its origin, its status in D-ASK, and the migration strategy for the Native Rust + WebView2 desktop host:

| File / Component | Upstream Origin (`SAGAR-TAMANG`) | Current Status in D-ASK | Reuse Strategy for Native WebView2 Host |
| :--- | :--- | :--- | :--- |
| **`lib/orbScene.ts`** | Original Core 3D Scene | Contains 8-layer Three.js orb, custom post-processing, theme palettes, and animation loops. | **100% REUSED**. Enable `alpha: true` and `setClearColor(0x000000, 0)` for desktop transparency. |
| **`lib/handTracker.ts`** | Original MediaPipe Tracker | Bare-hand landmark detection (`HandLandmarker`), pinch detection, spin/zoom gestures. | **100% REUSED**. Handled seamlessly via WebView2 camera permissions. |
| **`lib/soundEngine.ts`** | Original Audio Synthesizer | Web Audio API procedural synthesis (boot, click, spin, zoom, error tones). | **100% REUSED**. Pure Web Audio API oscillators, zero external audio assets. |
| **`components/JarvisOrb.tsx`** | Original HUD Wrapper | Main interactive HUD combining canvas, video, theme controls, telemetry, and command input. | **REUSED & ADAPTED**. Connect command input and telemetry display to `window.chrome.webview`. |
| **`app/globals.css`** | Original HUD Stylesheet | Sci-fi film grain, scanlines, HUD borders, typography, theme color variables. | **REUSED & ADAPTED**. Update `body` and `.orb-root` background to `transparent !important`. |
| **`app/layout.tsx`** | Original Root Layout | Root HTML/body structure with metadata. | **100% REUSED**. Add viewport and transparency flags. |
| **`app/page.tsx`** | Original Page Entry | Single-line export rendering `<JarvisOrb />`. | **100% REUSED**. Unchanged. |
| **`components/AgentStatusPanel.tsx`** | D-ASK Extension | Displays live agentic node progress, approval gates, and task events. | **REUSED**. Mounted directly inside `JarvisOrb.tsx` overlay. |
| **`components/DevicePanel.tsx`** | D-ASK Extension | Hardware matrix for connected Android/iOS devices. | **REUSED**. Mounted conditionally in HUD sidebar. |
| **`hooks/useTask.ts`** | D-ASK Extension | React hook managing task state and event streams. | **REUSED**. Receives events from native bridge. |
| **`main.js` (Electron)** | Legacy Electron Host | Electron window launcher with `electron` APIs. | **PERMANENTLY DELETED / RETIRED**. Replaced by native Rust host. |

---

## 3. Detailed Architectural Comparison of Frontend Assets

### 3.1 Three.js 3D Scene Architecture (`lib/orbScene.ts`)
The original 3D orb scene in `lib/orbScene.ts` consists of 8 distinct visual layers:
1. **Layer 1: Outer Shell**: Dense wireframe grid with 31 latitude rings and 24 meridians, featuring cross lines and equator highlights.
2. **Layer 2: Grid Panels**: Spherical grid segments positioned at latitude/longitude intersections.
3. **Layer 3: Equatorial Rings**: 6 nested equatorial rings with varying radii ($R \in [1.8, 2.4]$) and line opacities.
4. **Layer 4: Holographic Arcs**: 12 dynamic circular arcs with random angular spans that counter-rotate.
5. **Layer 5: Inner Spiral Core**: Double-helix dense volumetric core with 280 connected vertex segments.
6. **Layer 6: Floating Code Fragments**: Sprite text particles displaying sci-fi code strings and telemetry coordinates.
7. **Layer 7: Ambient Debris Particles**: 300 slow-orbiting ambient dust particles.
8. **Layer 8: Dust Particle Cloud**: 600 high-density particles reacting to sound and animation speed.

#### Shaders and Materials:
* **Custom Chromatic Aberration & Color Grading**: Implemented as a custom Three.js `ShaderPass` (`chromaticShader`) with radial barrel distortion and chromatic aberration ($R/G/B$ channel offsets).
* **Cinematic Bloom**: `UnrealBloomPass` with strength 1.8, radius 0.4, threshold 0.2.
* **Theme Palettes**: 4 complete dynamic palettes (`amber`, `crimson`, `cyan`, `emerald`) mapped to all line, mesh, and point materials.

### 3.2 MediaPipe Bare-Hand Gesture Engine (`lib/handTracker.ts`)
* **Tracking Framework**: `@mediapipe/tasks-vision@0.10.35` running `HandLandmarker`.
* **WASM / Model Loading**:
  * WASM CDN: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm`
  * Model URL: `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`
* **Landmark Geometry**:
  * Tracks landmarks: `WRIST (0)`, `THUMB_TIP (4)`, `INDEX_TIP (8)`, `MIDDLE_MCP (9)`.
  * Normalizes pinch distance against hand scale: $\text{scale} = \|\text{WRIST} - \text{MIDDLE\_MCP}\|$.
  * Pinch ratio: $\text{ratio} = \|\text{THUMB\_TIP} - \text{INDEX\_TIP}\| / \text{scale}$.
* **Gesture State Machine**:
  * `PINCH_ON = 0.32`, `PINCH_OFF = 0.45` (hysteresis prevents jitter).
  * **Single Pinch (Spin Mode)**: Moving a single pinched hand rotates the camera around the Three.js orb (`deltaTheta`, `deltaPhi`).
  * **Dual Pinch (Zoom Mode)**: Moving two pinched hands apart or together zooms the camera distance in or out.

### 3.3 Audio Synthesizer Engine (`lib/soundEngine.ts`)
* **Pure Web Audio API**: No external WAV/MP3 files required.
* **Procedural Sounds**:
  * `playBootSound()`: Frequency sweep from 80 Hz to 440 Hz (sine) + harmonic chime from 880 Hz to 1760 Hz (triangle).
  * `playClickSound()`: 2400 Hz short high-pass burst.
  * `playSpinSound()`: Modulated tone tracking gesture angular velocity.
  * `playZoomSound()`: Ascending/descending sine sweep.
  * `playErrorSound()`: Low-frequency dissonant buzz (140 Hz + 148 Hz).
  * `playThemeChangeSound()`: Arpeggiated high-tech chord.

---

## 4. Dependencies & Version Compatibility

| Dependency | Upstream Version | D-ASK Current Version | Compatibility Assessment |
| :--- | :--- | :--- | :--- |
| **`three`** | `^0.185.1` | `^0.185.1` | **Identical**. Full WebGL/DirectX support in WebView2. |
| **`@mediapipe/tasks-vision`** | `^0.10.35` | `^0.10.35` | **Identical**. Supported via Chromium WebAssembly/WebGL backend. |
| **`react`** | `^19.2.7` | `^19.2.7` | **Identical**. React 19 client components execute natively. |
| **`react-dom`** | `^19.2.7` | `^19.2.7` | **Identical**. Unchanged. |
| **`next`** | `^16.2.10` | `^16.2.10` | **Identical**. Supports dev server and static export. |
| **`electron`** | `^44.3.0` | `^44.3.0` (devDep) | **REMOVED**. Electron packages will be uninstalled. |

---

## 5. Components Requiring Adaptation for Native WebView2

The table below details the exact adaptations required to connect the original UI to the native desktop host:

| Component | Required Code Adjustment | Reason |
| :--- | :--- | :--- |
| **`app/globals.css`** | Change `body { background: #000; }` to `html, body { background: transparent !important; }`. | Enables Windows DWM per-pixel desktop transparency. |
| **`lib/orbScene.ts`** | Add `alpha: true, premultipliedAlpha: true` to `THREE.WebGLRenderer` options. | Allows WebGL clear color to pass through transparently to desktop. |
| **`components/JarvisOrb.tsx`** | Add listener for `window.chrome.webview` messages to receive live telemetry from the .NET daemon. | Replaces mock telemetry with live daemon metrics (`CPU`, `RAM`, `GPU UMA Budget`). |
| **`package.json`** | Remove `"electron": "^44.3.0"` and `"electron-builder"`. Add native desktop scripts. | Eliminates Electron dependency from repository. |
| **`main.js`** | Delete file permanently. | Superseded by native Rust desktop host. |

---

## 6. Verification & Governance Summary

* **Origin Attribution**: Credited to Sagar Tamang under MIT License in all relevant documentation.
* **Feature Preservation**: All 8 Three.js orb layers, custom shaders, post-processing bloom, Web Audio synthesis, and MediaPipe hand tracking are 100% retained.
* **Zero Electron**: Electron is eliminated from the runtime architecture.
* **No Practice Shaders**: The production interface will display the original Three.js ULTRON orb, not the WGPU practice orb.

