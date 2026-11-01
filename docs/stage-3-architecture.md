# D-ASK Stage 3 — Native HUD Architecture Specification

## 1. System Overview & Design Philosophy

D-ASK Stage 3 delivers the native visual interface for the local-first autonomous desktop assistant. Replacing slow, memory-intensive web or Electron-based frontends, D-ASK employs a high-performance **Rust / wgpu** holographic desktop HUD that interfaces via versioned Windows Named Pipes (`d-ask-ipc-v1`) with the .NET 8 assistant daemon.

```mermaid
graph TD
    subgraph Windows 11 Desktop
        DWM[Desktop Window Manager DWM]
        User[User Interaction Drag / Hotkeys]
    end

    subgraph Rust Native HUD "hud-native"
        Winit[winit 0.29 Frameless Window AlwaysOnTop]
        WGPU[wgpu 23 DX12 / Vulkan Engine]
        Shader[orb.wgsl Holographic Shader]
        OrbStateEngine[12-State Canonical Engine]
        HudClient[IpcClient Async Tokio Client]
    end

    subgraph IPC Channel
        Pipe[Named Pipe: \\.\pipe\d-ask-ipc-v1]
    end

    subgraph .NET 8 Assistant Daemon
        PipeServer[NamedPipeServer Framing & Serialization]
        StateManager[StateManager Sequence & Canonical State]
        ResourceManager[ResourceManager Safety Allocation Gate]
        ModelRuntime[ModelRuntime llama.cpp CPU/Vulkan]
        Telemetry[WindowsSystemMonitor & IntelGpuMonitor]
    end

    User -->|Drag Move / Space Toggle / Esc Quit| Winit
    Winit --> WGPU
    WGPU --> Shader
    Shader --> DWM
    OrbStateEngine -->|Colors, Speeds, Halo| Shader
    HudClient -->|Handshake, Ping, StateRestore| Pipe
    Pipe --> PipeServer
    PipeServer --> StateManager
    PipeServer --> Telemetry
    PipeServer --> ModelRuntime
    Telemetry -->|RAM, CPU, GPU UMA Broadcast| PipeServer
    StateManager -->|Canonical State Broadcast| PipeServer
```

---

## 2. Component Architecture

### 2.1 Native Rust HUD (`src/hud-native`)

The HUD is written entirely in native Rust using the `wgpu` graphics abstraction and `winit` windowing library, compiled with the official MSVC Windows SDK toolchain via user-space linkers (`rust-lld` + Microsoft CRT/SDK libraries).

1. **Windowing & Composition (`src/hud-native/src/main.rs`)**:
   - Frameless, non-resizable window (`480x520` logical pixels).
   - Configured with `WindowLevel::AlwaysOnTop` to float above active desktop applications.
   - Transparent background (`with_transparent(true)`) with Win32 DWM frame extension.
   - Native input handling:
     - Left-click drag: invokes native Win32 window movement (`window.drag_window()`).
     - Right-click / Spacebar / Tab: toggles contextual glassmorphic telemetry HUD overlay.
     - Escape / 'Q': triggers clean application shutdown.
     - `--headless` flag: runs without windowing/graphics for headless CI, automation, and daemon telemetry verification.
     - `--duration-secs <N>`: sets automated execution lifetime for benchmark suites.

2. **Render Engine & WGSL Pipeline (`src/hud-native/src/render/`)**:
   - `RenderContext`: selects high-performance hardware adapter (DirectX 12 preferred, Vulkan fallback) on Intel Iris Xe Graphics.
   - `OrbRenderer`: maintains uniform buffer memory (`OrbUniforms`, 80 bytes, 16-byte aligned) updated per frame.
   - `orb.wgsl`:
     - **Volumetric Holographic Sphere**: procedural 3D sphere ray-intersection with Fresnel rim glow and inner swirling energetic turbulence.
     - **Three Counter-Rotating Gimbal Rings**: inner, middle, and outer horizon rings with angular tick segmentation and radiant glow falloff.
     - **Orbiting Particle Swarm**: 18 Lissajous harmonic orbital points providing dynamic depth and active intelligence motion.
     - **Critical Halo**: calm, persistent 0.9 Hz deep crimson outer corona (preventing rapid flashing/strobing).
     - **Contextual Glassmorphic Telemetry Cards**: rounded translucent box with real-time filled CPU and RAM meter bars and Intel Iris Xe UMA shared budget visualization.

3. **12-State Canonical Animation Engine (`src/hud-native/src/state/hud_state.rs`)**:
   - Tracks primary color, secondary color, rotational speed multiplier, breathing pulse frequency, and panel visibility.
   - Implements exponential smoothing (lerp decay $dt \times 4.0$) between incoming states, guaranteeing zero jarring color snaps or discontinuous rotational jumps.

4. **IPC Named Pipe Client (`src/hud-native/src/ipc/`)**:
   - Connects to Windows Named Pipe `\\.\pipe\d-ask-ipc-v1`.
   - Length-prefixed binary framing (4-byte little-endian header, up to 1 MB payload).
   - Versioned JSON envelopes (`version: 1`, UUID message IDs, RFC 3339 timestamps).
   - Autonomous heartbeat pinger and exponential backoff reconnect loop (100 ms to 2000 ms).
   - Automatic state synchronization and restoration upon connection/reconnection.

---

## 3. Canonical 12-State Matrix

The 12 canonical states are synchronized identically across both the .NET Daemon (`DAsk.Protocol.IPC.Messages.AssistantState`) and the Rust HUD (`hud_state::OrbState`).

| State ID | Name | Primary RGBA | Secondary RGBA | Speed | Pulse Hz | Visual & Animation Characteristics |
| :---: | :--- | :--- | :--- | :---: | :---: | :--- |
| `0` | `Idle` | `[0.00, 0.75, 1.00, 1.0]` | `[0.00, 0.30, 0.80, 0.8]` | 1.00x | 1.0 Hz | Calm cyan/azure core, gentle breathing pulse, slow gimbal drift. |
| `1` | `Listening` | `[0.15, 0.55, 1.00, 1.0]` | `[0.05, 0.25, 0.90, 0.9]` | 1.80x | 2.2 Hz | Electric blue expanded core, undulating acoustic frequency ripples. |
| `2` | `Processing` | `[0.65, 0.25, 1.00, 1.0]` | `[0.35, 0.05, 0.70, 0.9]` | 3.00x | 3.0 Hz | Deep purple/violet, high-speed inward swirling vortex particles. |
| `3` | `Speaking` | `[1.00, 0.78, 0.15, 1.0]` | `[0.80, 0.40, 0.05, 0.8]` | 2.20x | 2.8 Hz | Warm gold/amber radiant core with dynamic ring oscillations. |
| `4` | `ModelLoading` | `[0.25, 0.45, 0.95, 1.0]` | `[0.10, 0.70, 0.90, 0.8]` | 2.00x | 1.8 Hz | Deep indigo/cyan, clockwise radial scanning ring fill pattern. |
| `5` | `ModelGenerating` | `[1.00, 0.15, 0.75, 1.0]` | `[0.70, 0.05, 0.90, 0.9]` | 3.80x | 4.0 Hz | Neon magenta, high-velocity particle streaming aura. |
| `6` | `Warning` | `[1.00, 0.55, 0.05, 1.0]` | `[0.70, 0.25, 0.00, 0.8]` | 1.50x | 2.0 Hz | Vivid amber persistent corona, warning banner in telemetry panel. |
| `7` | `Critical` | `[0.92, 0.06, 0.06, 1.0]` | `[0.50, 0.02, 0.02, 0.9]` | 0.85x | 0.9 Hz | **Persistent deep crimson halo**, gentle 0.9 Hz pulse (no strobing). |
| `8` | `Disconnected` | `[0.45, 0.48, 0.52, 0.8]` | `[0.20, 0.22, 0.25, 0.6]` | 0.30x | 0.4 Hz | Desaturated slate grey, faint drifting rings, offline indicator. |
| `9` | `Reconnecting` | `[0.95, 0.82, 0.15, 0.9]` | `[0.60, 0.50, 0.05, 0.7]` | 1.60x | 1.8 Hz | Seeking amber-yellow outward radar expansion pulses. |
| `10` | `TaskCompleted` | `[0.12, 0.92, 0.35, 1.0]` | `[0.05, 0.60, 0.20, 0.8]` | 1.40x | 1.5 Hz | Emerald green resonant harmonic bloom settling smoothly to Idle. |
| `11` | `TaskFailed` | `[0.88, 0.18, 0.18, 1.0]` | `[0.50, 0.05, 0.05, 0.8]` | 1.20x | 1.5 Hz | Crimson flare settling back to Warning or Idle. |

---

## 4. Telemetry Precision and Hardware Truthfulness

In compliance with architectural rules, all telemetry presented by the HUD reflects verified host metrics:

1. **System RAM**:
   - Queries `GlobalMemoryStatusEx` via `WindowsSystemMonitor`.
   - Metrics: Available RAM (GB / MB), Total Physical RAM (15.69 GB), Memory Load (%).
2. **System CPU**:
   - Queries Windows NT performance counters (`\Processor(_Total)\% Processor Time`).
   - Normalizes usage across all 12 logical processors (2 P-cores + 8 E-cores).
3. **Intel Iris Xe GPU Metrics**:
   - Queries DXGI Adapter 0 (`IDXGIAdapter3` / `DXGI_ADAPTER_DESC2`).
   - Dedicated Video Memory: 128 MB (fixed firmware carveout).
   - Shared System Memory (UMA Budget): ~7.8 GB (50% host RAM).
   - **Engine Utilization: Unmetered (N/A)**. Never fabricated or displayed as a pseudo-estimate.
4. **Active Model Telemetry**:
   - Name: `Qwen2.5-0.5B-Instruct`
   - Active Backend: AVX2 CPU / Vulkan
   - Model Memory Footprint: verified through `IResourceManager` active reservation gates.

---

## 5. Security & Isolation Boundaries

- The native HUD contains zero OS manipulation capabilities, shell execution routines, or filesystem mutation APIs.
- The HUD is purely an input/output telemetry display and visual feedback mechanism.
- All assistant execution, model inference, safety gates, and tool execution remain strictly locked inside the .NET 8 daemon behind its permission checks and SQLite WAL evidence logger.

