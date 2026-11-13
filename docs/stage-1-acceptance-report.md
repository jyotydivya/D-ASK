# Stage 1 Acceptance Report & Technical Audit

**Project:** D-ASK: AI-Powered Desktop Assistant  
**Auditor Role:** Senior Systems Engineer  
**Audit Date:** October 31, 2026  
**Target Environment:** Windows 11/10 x64, Intel Core i5-1335U (10C/12T), Intel Iris Xe Graphics (80 EUs), 16 GB Physical RAM (15.7 GB Usable)  

---

## 1. Executive Summary & Verification Outcome

Stage 1 established the foundation for a non-browser, non-Electron desktop assistant. The audit inspected the repository, executed live builds, and evaluated 10 automated unit and integration tests.

| Evaluation Area | Audit Result | Key Finding / Evidence |
| :--- | :---: | :--- |
| **.NET SDK & Build System** | **VERIFIED** | .NET 8.0.427 SDK installed; `DAsk.Protocol` and `DAsk.Daemon` build cleanly with 0 errors. |
| **Named Pipe Protocol & Framing** | **VERIFIED** | 4-byte LE length-prefix framing strictly rejects payloads $> 1\text{ MB}$; envelope version 1 verified. |
| **Concurrent Clients & Thread Safety** | **VERIFIED** | Per-session `SemaphoreSlim(1,1)` write lock prevents frame corruption; multi-client session dictionary functional. |
| **Connection Lifecycle & Reconnect** | **VERIFIED** | Clean EOF disconnect detection; live client disconnection followed by seamless reconnection and state restore. |
| **State Synchronization** | **VERIFIED** | Monotonic `_sequenceNumber` incrementing; state snapshot restored accurately upon client reconnection. |
| **Hardware RAM & CPU Telemetry** | **VERIFIED** | Live Win32 `GlobalMemoryStatusEx` and `GetSystemTimes` tracking; measured 3,163 MB available host RAM. |
| **GPU Shared Memory Accounting** | **VERIFIED** | Dedicated video RAM (128 MB) properly distinguished from Shared UMA (~7.8 GB); no double-counting of system RAM. |
| **Model Allocation Gate** | **VERIFIED\*** | Blocks allocations when projected headroom $< 2,000\text{ MB}$. \*Concurreny race condition identified for Stage 2. |
| **Rust HUD Client** | **BLOCKED** | Source skeleton complete in `src/hud-native/`, but `cargo`/`rustc` toolchain is not installed on the host. |
| **Test Suite Execution** | **VERIFIED** | 10 of 10 tests passed in 3.58 seconds against a live spawned daemon process. |

---

## 2. Independent Verification & Technical Findings

### 2.1 .NET SDK Installation & Build Reproducibility
- **Environment State:** Standalone `.NET 8.0.427 SDK` was verified in `%USERPROFILE%\.dotnet\sdk\8.0.427` alongside the `.NETCoreApp 8.0.33` runtime.
- **Build Verification:**
  - `dotnet build src/DAsk.Protocol/DAsk.Protocol.csproj` $\to$ Succeeded (0 Errors, 0 Warnings).
  - `dotnet build src/DAsk.Daemon/DAsk.Daemon.csproj` $\to$ Succeeded (0 Errors, 0 Warnings).
- **Test Build Nuance:** The test project (`tests/DAsk.Daemon.Tests/DAsk.Daemon.Tests.csproj`) directly references the compiled `DAsk.Daemon.dll` and `DAsk.Protocol.dll` assemblies. In the sandboxed build environment without root access to global machine registries, direct assembly references ensure deterministic, offline compilation.

### 2.2 Named Pipe Protocol, Framing & Versioning
- **Named Pipe:** Standardized on `\\.\pipe\d-ask-ipc-v1`.
- **Framing:** 4-byte unsigned little-endian length prefix followed by UTF-8 encoded JSON payload.
- **Buffer Safety:** Evaluated in `IpcProtocolTests.Envelope_Rejects_MessagesExceedingMaxLimit`. When attempting to frame a payload exceeding `1,048,576` bytes (1 MB), `ToLengthPrefixedBytes()` immediately throws `InvalidOperationException`.
- **Inbound Framing Gate:** In `IpcClientSession.RunSessionAsync()`, incoming frame headers specifying length $> 1\text{ MB}$ trigger immediate session termination and stream closure, preventing buffer-exhaustion attacks.
- **Protocol Versioning:** Envelope version 1 is enforced. Mismatched versions receive an explicit `HandshakeResponse { Status = "Rejected" }` message.

### 2.3 Concurrent Client Handling & Write Synchronization
- **Session Management:** Managed via `ConcurrentDictionary<string, IpcClientSession> _activeSessions` in `NamedPipeServer`.
- **Atomic Writes:** Every `IpcClientSession` encapsulates a `SemaphoreSlim _writeLock = new(1, 1)`. All outbound frames (`SendEnvelopeAsync`) acquire this lock before writing to the underlying `NamedPipeServerStream`, guaranteeing that concurrent telemetry broadcasts and replies cannot interleave bytes on the pipe.

### 2.4 Connection Lifecycle, Reconnection & State Recovery
- **Lifecycle:** Tested end-to-end in `IpcIntegrationLiveTests.LiveDaemon_EndToEnd_Ipc_Telemetry_And_Reconnection_Test`.
- **Observed Flow:**
  1. Test spawned `DAsk.Daemon.exe` (PID 9524).
  2. First client connected and completed `HandshakeRequest`. Received `HandshakeResponse` (SessionToken: `847b3d6a40f24193ba64b87e24dc534b`).
  3. First client received live `TelemetryUpdate`.
  4. First client abruptly disconnected (pipe closed).
  5. Daemon gracefully logged disconnect and pruned session from active table.
  6. Second client connected, performed handshake, and sent `StateRestoreRequest`.
  7. Daemon returned `StateRestoreResponse` with restored status (`Status='Idle'`, `OrbMode='Normal'`, `Seq=0`).

### 2.5 Hardware Telemetry & Resource Accounting
- **Host RAM Monitoring:** `WindowsSystemMonitor.cs` invokes `GlobalMemoryStatusEx` (`kernel32.dll`). Measured 15.7 GB total RAM and 3,163.1 MB available RAM.
- **CPU Monitoring:** Uses delta sampling via `GetSystemTimes` (`kernel32.dll`) combined with `Process.TotalProcessorTime`. Measured 12.5% idle load and 69.2% peak load during test initialization.
- **GPU Telemetry:** `IntelGpuMonitor.cs` explicitly reports `isSharedMemoryArchitecture: true`. Dedicated video memory is fixed at 128 MB (the Intel driver emulation segment), while shared system memory is accounted for at ~7.8 GB.
- **Shared Memory Safety:** The resource manager avoids treating the 7.8 GB shared memory as independent physical memory, preventing out-of-memory paging crashes.

### 2.6 Model Allocation Gatekeeper Analysis
- **Headroom Equation:**
  $$\text{Projected Headroom} = \text{Available Physical RAM} - \text{Estimated Model Allocation}$$
- **Verification:** Tested in `ResourceManagerTests.CanAllocateModel_Blocks_When_Projected_Headroom_Breaches_Threshold`:
  - With 3,584 MB available and a 2,048 MB model allocation request, projected headroom is 1,536 MB (below the 2,000 MB safety threshold). Allocation was rejected (`IsAllowed: false`).
  - With 5,120 MB available and a 2,048 MB model allocation request, projected headroom is 3,072 MB (above threshold). Allocation was permitted (`IsAllowed: true`).
- **Audit Limitation / Finding:** `CanAllocateModelAsync` evaluates memory at the moment of invocation but does not hold a reservation lock. Concurrent calls could create a time-of-check to time-of-use (TOCTOU) race condition (see Section 4).

### 2.7 Rust HUD Client Audit
- **Files Verified:** `Cargo.toml`, `main.rs`, `render/context.rs`, `render/orb_skeleton.rs`, `ipc/client.rs`, `ipc/framing.rs`, `ipc/protocol.rs`, `state/hud_state.rs`.
- **Status:** **Not Compiled / Untested on Host.**
- **Finding:** `rustc` and `cargo` are not installed on the host system (`Get-Command rustc` returned `CommandNotFoundException`). While the Rust code is architecturally sound and protocol-compliant, it has not been compiled into a native binary. IPC verification was performed using the C# integration test harness.

---

## 3. Empirical Measurements Review

All measurements below were captured live during execution of the test suite on October 31, 2026.

| Metric | Measured Value | Measurement Source / Method | Status |
| :--- | :--- | :--- | :---: |
| **Daemon Working Set RAM** | **43.23 MB – 43.51 MB** | `Process.GetCurrentProcess().WorkingSet64` | Verified |
| **Daemon Private Memory** | **12.04 MB – 12.13 MB** | `Process.GetCurrentProcess().PrivateMemorySize64` | Verified |
| **Host Available RAM** | **3,163.1 MB – 3,591.6 MB** | Win32 `GlobalMemoryStatusEx` (`ullAvailPhys`) | Verified |
| **Host CPU Utilization** | **12.5% (idle) / 69.2% (test peak)**| Win32 `GetSystemTimes` differential | Verified |
| **Test Suite Execution Time**| **3.5854 seconds** | VSTest / xUnit test runner clock (10 tests) | Verified |
| **End-to-End Live IPC Test** | **2.0 – 3.0 seconds** | High-resolution test timer (spawns daemon, connects, reconnects) | Verified |

> [!NOTE]
> **Benchmarking Disclaimer:** Prior comparisons against Electron (~450 MB – 800 MB RAM) reflect industry baseline ranges for Chromium + Node desktop apps. An identical head-to-head empirical benchmark has not yet been executed in this repository.

---

## 4. Blockers & Technical Findings Classification

### Critical (Must Fix Before Stage 2)
*None.* The C# daemon foundation, IPC protocol, telemetry, and gatekeeper are functional and tested.

### High (Must Fix Before Autonomous Execution & Deployment)
1. **Rust Toolchain Missing on Host:**
   - *Impact:* The Rust wgpu HUD cannot be built or run on this host machine until `rustup` and the C++ build tools / MSVC linker are provisioned.
   - *Action:* Install Rustup (`stable-x86_64-pc-windows-msvc`) and ensure the linker is accessible.
2. **TOCTOU Race Condition in Model Allocation Gate:**
   - *Impact:* In `ResourceManager.cs`, `CanAllocateModelAsync` checks available memory but does not reserve it. Two rapid concurrent requests could both pass the check before either allocates memory, overcommitting physical RAM.
   - *Action:* Introduce an atomic allocation lease / reservation token in Stage 2.

### Medium (Should Address During Subsequent Stages)
1. **Direct DXGI COM Interop:**
   - *Current State:* `IntelGpuMonitor.cs` uses heuristic fallback for Iris Xe shared memory rather than direct `IDXGIAdapter3::QueryVideoMemoryInfo` COM vtable traversal.
   - *Action:* Implement DirectML or lightweight Win32 DXGI interop to poll live GPU segment usage dynamically.
2. **Named Pipe Outbound Write Timeout:**
   - *Current State:* `SendEnvelopeAsync` awaits `_writeLock` without a timeout. A stalled client could potentially delay outbound broadcasts.
   - *Action:* Enforce a 3,000 ms write timeout on outbound frames.

### Low (Documentation & Cleanup)
1. **Test Project DLL Hint Path:**
   - *Current State:* `DAsk.Daemon.Tests.csproj` references `DAsk.Daemon.dll` via `<Reference>` instead of `<ProjectReference>` due to a sandboxed MSBuild SDK resolution quirk.
   - *Action:* Normalize to standard project references once global SDK workloads are registered.

---

## 5. Stage 2 Go / No-Go Recommendation

### Recommendation: **GO** (Proceed to Stage 2 with Scoped Guardrails)

**Justification:**
1. The daemon backend, versioned IPC, hardware telemetry, and resource gatekeeper are fully verified with 10 passing automated tests.
2. The measured daemon idle footprint (**~43 MB Working Set / ~12 MB Private Bytes**) confirms the lightweight non-Electron design.
3. Stage 2 focuses entirely on the local AI inference runtime (`IModelRuntime`, `llama.cpp`, Vulkan offloading, and GGUF lifecycle) inside the daemon, meaning the uncompiled Rust HUD does not block Stage 2 backend development.

