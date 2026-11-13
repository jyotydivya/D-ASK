# D-ASK Technical Debt & Architectural Ledger

This ledger tracks technical debt, temporary workarounds, and known architectural constraints discovered during the Stage 1 audit.

---

## 1. High-Priority Items (Fix Before Autonomous Execution)

### TD-01: Rust Toolchain & HUD Build Environment
- **Classification:** **HIGH**
- **Discovery Date:** 2026-10-31
- **Component:** `src/hud-native`
- **Issue:** The host Windows machine does not have `rustc`, `cargo`, or the MSVC/GNU linker installed. While the Rust HUD source skeleton is written, it has not been compiled or tested as a running binary.
- **Remediation Plan:** Install `rustup` (`x86_64-pc-windows-msvc`) and ensure the C++ build tools are available. Compile and execute `src/hud-native` to verify the Direct3D 12 wgpu surface.

### TD-02: Time-of-Check to Time-of-Use (TOCTOU) in Model Allocation Gate [RESOLVED IN STAGE 2]
- **Classification:** **HIGH** (RESOLVED)
- **Discovery Date:** 2026-10-31
- **Resolution Date:** 2026-10-31 (Stage 2)
- **Component:** `src/DAsk.Daemon/ResourceManagement/ResourceManager.cs`
- **Issue:** `CanAllocateModelAsync` previously read current available physical memory without taking an atomic lease. Rapid concurrent allocation requests could both observe sufficient headroom before either had allocated memory, overcommitting system RAM.
- **Resolution:** Implemented `TryAcquireReservationAsync` backed by `MemoryReservationLease` and a strict `SemaphoreSlim(1, 1)` critical section. Approved model allocation leases are registered in `_activeReservations` and immediately deducted from effective headroom calculations (`TotalActiveReservationsBytes`). Leases implement `IDisposable` and release reservations upon model eviction or cancellation.
- **Verification:** Verified by `ResourceManagerTests.Concurrent_Reservations_Prevent_Overcommit_TOCTOU` where 5 concurrent 1.5 GB allocation requests competed against 3.0 GB available headroom; exactly 1 reservation was granted and 4 were rejected, with zero memory overcommit.

---

## 2. Medium-Priority Items (Address in Subsequent Stages)

### TD-03: Intel Iris Xe DXGI Segment Budget Polling
- **Classification:** **MEDIUM**
- **Discovery Date:** 2026-10-31
- **Component:** `src/DAsk.Daemon/Telemetry/IntelGpuMonitor.cs`
- **Issue:** GPU shared memory accounting currently uses structured heuristic telemetry (`isSharedMemoryArchitecture: true`, 7.8 GB budget, 128 MB dedicated) rather than direct `IDXGIAdapter3::QueryVideoMemoryInfo` COM vtable traversal.
- **Remediation Plan:** Integrate DirectML or pinvoke COM interfaces for `IDXGIFactory4` to read live GPU memory segment budgets dynamically at 1 Hz.

### TD-04: Outbound IPC Write Timeout
- **Classification:** **MEDIUM**
- **Discovery Date:** 2026-10-31
- **Component:** `src/DAsk.Daemon/IPC/IpcClientSession.cs`
- **Issue:** `SendEnvelopeAsync` acquires `_writeLock` without a timeout. If a connected client stalls and stops reading from the pipe, the daemon's write loop could be blocked indefinitely.
- **Remediation Plan:** Add a 3,000 ms write timeout (`CancellationTokenSource(3000)`) to `WriteAsync` in `SendEnvelopeAsync`. Disconnect stalled clients if the timeout elapses.

### TD-07: Subsystem Allocation Tracker Omits Native Compute Buffers & KV Cache
- **Classification:** **MEDIUM**
- **Discovery Date:** 2026-10-31 (Stage 2 Post-Acceptance Audit)
- **Component:** `src/DAsk.Daemon/ResourceManagement/ResourceManager.cs` & `LlamaModelRuntime.cs`
- **Issue:** `RegisterSubsystemAllocation` registers model file size on disk (`fileSize`), but does not dynamically account for native `llama.cpp` compute buffers (`sched_reserve`: ~300 MB) or KV cache allocations (~12–36 MB). While the 2,000 MB safety headroom prevents memory exhaustion, the subsystem ledger under-reports total unmanaged memory commitments by ~340 MB.
- **Remediation Plan:** Expose unmanaged memory commitment telemetry from `IModelRuntime` to `ResourceManager` upon context creation and update `RegisterSubsystemAllocation` with total resident buffers (`fileSize + kvCacheBytes + computeBufferBytes`).

---

## 3. Low-Priority Items (Cleanup & Maintenance)

### TD-05: Test Project Binary Assembly Hinting
- **Classification:** **LOW**
- **Discovery Date:** 2026-10-31
- **Component:** `tests/DAsk.Daemon.Tests/DAsk.Daemon.Tests.csproj`
- **Issue:** Test project references `DAsk.Daemon.dll` and `DAsk.Protocol.dll` via `<Reference><HintPath>` instead of `<ProjectReference>` due to a sandboxed MSBuild SDK resolution quirk during transitive dependency evaluation.
- **Remediation Plan:** Revert to standard `<ProjectReference>` once global SDK workloads are fully registered.

### TD-06: Legacy Next.js / Electron Artifacts
- **Classification:** **LOW**
- **Discovery Date:** 2026-10-31
- **Component:** Repository Root (`app/`, `main.js`, `next.config.ts`, `components/`)
- **Issue:** The repository still contains legacy web application files from the original prototype.
- **Remediation Plan:** Keep legacy files for backward reference until Stage 4 (full feature parity), then archive into `legacy/` or remove.

### TD-08: Explicit Thread Affinity for Intel Hybrid Architectures
- **Classification:** **LOW**
- **Discovery Date:** 2026-10-31 (Stage 2 Post-Acceptance Audit)
- **Component:** `src/DAsk.Daemon/ModelRuntime/LlamaModelRuntime.cs`
- **Issue:** Thread scheduling is currently unpinned and managed by the Windows kernel scheduler and Intel Thread Director. Under concurrent desktop load, thread migration between P-cores and E-cores introduces throughput variance ($\sigma = 4.34$ on CPU, $\sigma = 8.74$ on Vulkan).
- **Remediation Plan:** Conduct comparative benchmarks between unpinned Windows Thread Director scheduling and explicit Win32 `SetThreadAffinityMask` pinning worker threads to logical processors 0–3 (P-core hyperthreads). Implement configurable affinity if empirical evidence demonstrates a sustained throughput gain.

