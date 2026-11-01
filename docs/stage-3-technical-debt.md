# D-ASK Stage 3 — Technical Debt & Architectural Ledger

## Overview

This document records technical tradeoffs, toolchain findings, hardware driver limitations, and deliberate deferrals identified during the implementation and verification of Stage 3 (Native HUD Orb Rendering & Visual Integration).

---

## 1. Toolchain Architecture: MSVC vs GNU

### 1.1 The Toolchain Tradeoff
During Stage 3 environment setup, two distinct Windows Rust targets were evaluated:
1. `x86_64-pc-windows-gnu` (MinGW / GCC toolchain)
2. `x86_64-pc-windows-msvc` (Microsoft Visual C++ ABI / Windows SDK)

| Criterion | `x86_64-pc-windows-gnu` | `x86_64-pc-windows-msvc` |
| :--- | :--- | :--- |
| **System Prerequisites** | MinGW-w64 runtime, GCC, binutils (`dlltool.exe`, `windres.exe`). | Microsoft CRT (`msvcrt.lib`, `ucrt.lib`) and Windows SDK (`kernel32.lib`). |
| **Windows API Compatibility** | Incomplete header coverage for modern Windows 11 DWM and DirectX 12 Agility SDK features. | 100% native compatibility with official Windows 11 SDK `10.0.26100`. |
| **Windows Defender Heuristics** | High false-positive rate on raw third-party MinGW zip distributions (`w64devkit` flagged). | Official Microsoft MSI/VSIX packages are fully verified and signed. |
| **Packaging & CI Alignment** | Requires bundling MinGW runtime DLLs (`libgcc_s_seh-1.dll`, `libwinpthread-1.dll`). | Uses universal Windows UCRT pre-installed on every Windows 10/11 machine. |
| **Production Readiness** | **Rejected** for production deployment. | **Selected & Validated** as production standard. |

### 1.2 User-Space MSVC Linking Implementation
To resolve the absence of an interactive administrator prompt (UAC) for the full Visual Studio Installer, D-ASK uses user-space SDK extraction (`xwin-sdk`):
- Official Microsoft Windows 11 SDK `10.0.26100` and MSVC CRT 14.44 libraries are splatted into `D:\D-ASK\D-ASK\.xwin-sdk`.
- LLVM's `rust-lld.exe` links MSVC-format `.lib` files without invoking `link.exe`.
- **Debt Item (TD-03)**: For production installer packaging and enterprise CI/CD pipelines, configure an unattended silent installation of Microsoft Visual Studio 2022 Build Tools (workload `Microsoft.VisualStudio.Workload.VCTools`) so developers with administrator access can compile with standard MSVC tools out of the box without manual `/LIBPATH` environment overrides.

---

## 2. Windows DWM Transparency & Swapchain Alpha Modes

### 2.1 The Windows 11 DWM Composition Behavior
User Correction 2 emphasized that `winit`'s `with_transparent(true)` and a `wgpu` surface do not automatically guarantee a transparent composited overlay on all Windows platforms.

Empirical testing on the host Intel Iris Xe GPU (Driver 31.0.101.4953) revealed:
- `wgpu` surface capabilities query (`surface.get_capabilities(&adapter).alpha_modes`) returns `[Opaque]` for both Vulkan and DirectX 12 flip swapchains (`DXGI_SWAP_EFFECT_FLIP_DISCARD`).
- Under standard DXGI flip models, the desktop window manager (DWM) treats swapchains declaring `DXGI_ALPHA_MODE_IGNORE` or `Opaque` as having an opaque black background even when `r: 0, g: 0, b: 0, a: 0` is cleared.
- To produce full transparency over the desktop, Windows applications typically require:
  1. Setting `DXGI_ALPHA_MODE_PREMULTIPLIED` on the swapchain (supported if the underlying driver/wgpu backend exposes it).
  2. Or using `SetWindowLongPtr` with `WS_EX_LAYERED` and `SetLayeredWindowAttributes` / `UpdateLayeredWindow`.
  3. Or compositing through Windows DirectComposition / Windows.UI.Composition APIs.

### 2.2 Debt Item (TD-04) — Resolved in Phase 2A
- **Status**: **RESOLVED IN PHASE 2A**
- **Resolution**:
  - Implemented Win32 native DWM client extension (`DwmExtendFrameIntoClientArea` with `-1` margins).
  - Applied `WS_EX_LAYERED` with `SetLayeredWindowAttributes(hwnd, 0x00000000, 0, LWA_COLORKEY)`.
  - Under Vulkan backend, utilized `CompositeAlphaMode::Inherit` (`VK_COMPOSITE_ALPHA_INHERIT_BIT_KHR`), which instructs the Vulkan swapchain to inherit the DWM alpha compositing behavior from the target HWND.
  - Verified empirically: Zero black rectangular backing, all 4 corners show desktop wallpaper directly behind the window, passing the Phase 2A transparency validation gate.

---

## 3. Intel Iris Xe GPU Engine Utilization Telemetry

### 3.1 Unmetered Engine Utilization
In compliance with User Correction 4, the HUD and daemon truthfully report:
- Dedicated Video Memory: 128 MB (fixed firmware carveout)
- Shared System Memory (UMA Budget): ~7.8 GB (50% host RAM)
- Active Adapter: Intel(R) Iris(R) Xe Graphics
- **Engine Utilization: Unmetered (N/A)**

### 3.2 Debt Item (TD-05)
- **Status**: Documented.
- **Action**: To obtain live GPU 3D/Compute core utilization percentages without third-party vendor dependencies, implement a Windows NT PDH (Performance Data Helper) query targeting `\GPU Engine(*)\Utilization Percentage` filtered by process ID or adapter LUID. Until implemented, engine utilization must strictly remain labeled as unmetered rather than displaying synthetic or simulated percentages.

---

## 4. Audio Reactivity Stub

### 4.1 Debt Item (TD-06)
- **Status**: Deferral.
- **Description**: The shader uniform buffer and state machine support dynamic pulse and frequency modulation parameters (`u.pulse`, `u.speed`), currently driven by mathematical trigonometric generators corresponding to canonical states (`Speaking`, `Listening`, etc.).
- **Action**: When the native microphone and audio input subsystem is developed in future stages, feed live real-time Fast Fourier Transform (FFT) frequency bands into the shader uniform buffer.

---

## 5. Summary of Technical Debt Register

| ID | Title | Priority | Target Stage | Impact |
| :--- | :--- | :---: | :---: | :--- |
| **TD-01** | Rust Toolchain Availability | Resolved | Stage 3 | **RESOLVED**: Configured Rust 1.99.1 + MSVC SDK via `xwin-sdk` and `rust-lld`. |
| **TD-02** | Atomic Model Memory Reservation Race | Resolved | Stage 2 | **RESOLVED**: Fixed via `Interlocked.Add` / atomic lock acquisition in `ResourceManager`. |
| **TD-03** | Production CI MSVC Build Tools | Low | Stage 4 | Package automated build script for CI runners with pre-installed MSVC tools. |
| **TD-04** | DirectComposition Native Overlay Hook | Medium | Stage 4 | Provide Win32 DirectComposition fallback for drivers reporting `alpha_modes: [Opaque]`. |
| **TD-05** | Windows PDH GPU Engine Utilization | Low | Stage 4 | Add NT PDH performance counter reader for real-time 3D engine utilization. |
| **TD-06** | Microphone Audio FFT Shader Hook | Low | Stage 5 | Connect live microphone frequency spectrum to orb wave displacement. |

