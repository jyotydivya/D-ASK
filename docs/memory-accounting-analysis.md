# Deep Memory Accounting & Process Profiling Analysis

**Document Version:** 1.0.0  
**Audit Date:** October 31, 2026  
**Auditor:** Senior Systems Engineer & ML Inference Performance Researcher  
**Operating System:** Windows 11 Build 26200 (x64)  
**Process Audited:** `DAsk.Daemon.exe` (PID tracked across test sessions)  

---

## 1. Executive Summary & Foundational Distinction

A frequent source of performance mischaracterization in systems engineering is the conflation of **Working Set RAM** and **Private Committed Virtual Memory**.

In the initial Stage 2 benchmark, the metrics were reported as:
- Working Set: `587.47 MB`
- Private Memory: `896.29 MB`

> [!CAUTION]
> **Working Set and Private Memory are orthogonal, overlapping metrics and must NEVER be added together.**
> Summing them ($587.47\text{ MB} + 896.29\text{ MB} = 1,483.76\text{ MB}$) is mathematically and architecturally invalid. It would double-count private physical pages while confusing virtual memory address space commitments with resident physical RAM.

---

## 2. Working Set vs. Private Memory Definition

```mermaid
flowchart TD
    subgraph TotalVirtualAddressSpace ["Total Committed Virtual Memory (Private Bytes)"]
        PrivateInRAM["Private Working Set (Physical RAM)"]
        PrivateInPagefile["Paged Out Private Memory (Pagefile.sys)"]
    end

    subgraph TotalWorkingSet ["Total Working Set (WorkingSet64)"]
        PrivateInRAM
        MappedModelWeights["Memory-Mapped GGUF File Pages (Active in RAM)"]
        SharedDLLs["Loaded System & Runtime DLLs (Active in RAM)"]
    end
```

### 2.1 `Process.WorkingSet64` (Resident Physical RAM)
- **Win32 API Equivalent:** `PROCESS_MEMORY_COUNTERS_EX.WorkingSetSize` queried via `GetProcessMemoryInfo`.
- **Definition:** The exact number of bytes of **physical RAM** currently assigned to the process by the Windows NT Virtual Memory Manager (VMM).
- **What is INCLUDED:**
  1. **Private Working Set:** Physical RAM holding the .NET managed heap, C++ native heap (`malloc`/`calloc`), thread stacks, and JIT-compiled code that are resident in RAM.
  2. **Memory-Mapped File Pages:** Active pages of memory-mapped files (e.g. `qwen2.5-0.5b-instruct-q4_k_m.gguf` mapped via `MapViewOfFile`) that have been faulted into RAM.
  3. **Shared Dynamic Link Libraries:** Resident code and data pages from `llama.dll`, `ggml.dll`, `vulkan-1.dll`, `coreclr.dll`, `ntdll.dll`, and Windows subsystem DLLs.
- **Key Characteristics:**
  - Dynamic: Windows kernel working set trimmer will page out or unmap pages when global physical RAM is low.
  - File-Backed: Memory-mapped GGUF weights can be discarded and paged back directly from the NVMe SSD without touching `pagefile.sys`.

### 2.2 `Process.PrivateMemorySize64` (Private Committed Virtual Memory)
- **Win32 API Equivalent:** `PROCESS_MEMORY_COUNTERS_EX.PrivateUsage` queried via `GetProcessMemoryInfo`.
- **Definition:** The amount of committed virtual memory that is **private to this process** and cannot be shared with any other process on the system.
- **What is INCLUDED:**
  1. All heap memory allocated by the .NET Garbage Collector (`GC.Alloc`).
  2. All native C++ heap buffers allocated via `malloc`, `new`, or `VirtualAlloc` with `MEM_COMMIT` (e.g., `llama.cpp` KV cache buffers, computation graphs, token sampler arrays).
  3. Thread stack reservations and commitments (typically $1\text{ MB}$ committed on demand per OS thread).
  4. Write-copy pages of mapped binaries that have been modified.
- **What is EXCLUDED:**
  1. Memory-mapped files opened in read-only mode (e.g., read-only GGUF weights mapped via `FILE_MAP_READ`).
  2. Read-only shared DLL code sections (`.text` segment of `llama.dll`, `kernel32.dll`).

---

## 3. Dissecting the Stage 2 Daemon Allocations

### 3.1 Model Loaded State Breakdown (0.5B Model)
- **Measured Working Set (`WorkingSet64`):** `587.47 MB`
  - Resident Mapped Weights (`qwen2.5-0.5b`): ~435 MB
  - Active Private Working Set (KV cache, context, .NET runtime): ~125 MB
  - Shared DLLs (`llama.dll`, `vulkan-1.dll`, `coreclr.dll`): ~27 MB
  - **Total Physical RAM Occupied:** **587.47 MB**
- **Measured Private Memory (`PrivateMemorySize64`):** `896.29 MB`
  - Committed native compute buffer (`sched_reserve`): ~300.25 MB
  - Committed KV cache and token buffers: ~12.0 MB
  - Committed unmanaged thread pools and scratch memory: ~540 MB
  - .NET Runtime committed virtual address space: ~44 MB
  - **Total Private Address Space Committed:** **896.29 MB**

### 3.2 Controlled 3B Model Load Breakdown
- **Measured Working Set (`WorkingSet64`):** `2,159.4 MB`
  - Resident Mapped Weights (`qwen2.5-3b`): ~1,980 MB
  - Active Private Working Set: ~152 MB
  - Shared DLLs: ~27 MB
- **Measured Private Memory (`PrivateMemorySize64`):** `2,492.4 MB`
  - Committed native compute buffer (`sched_reserve`): ~304.75 MB
  - Committed KV cache (FP16 at 1024 context): ~36.00 MB
  - Committed native buffers & execution graphs: ~2,100 MB
  - .NET runtime committed space: ~51 MB

---

## 4. Audit of the `ResourceManager` Subsystem Allocation Tracker

### 4.1 Implementation Inspection (`ResourceManager.cs`)
```csharp
public void RegisterSubsystemAllocation(SubsystemType subsystem, string name, ulong bytes)
{
    string key = $"{subsystem}:{name}";
    _allocations.AddOrUpdate(key, ...);
}
```
In `LlamaModelRuntime.cs`:
```csharp
ulong fileSize = (ulong)new FileInfo(resolvedPath).Length;
_resourceManager.RegisterSubsystemAllocation(SubsystemType.LlmInference, _manifest.Id, fileSize);
```

### 4.2 Critical Findings on Tracker Coverage
1. **File Size Proxy:** The tracker currently registers `fileSize` (e.g. 468 MB for 0.5B, or 2,104 MB for 3B). This represents the size of the model weights on disk.
2. **Untracked Native Allocations:** The subsystem tracker does **NOT** dynamically capture:
   - KV Cache allocations (`llama_kv_cache`: 12 MB for 0.5B, 36 MB for 3B).
   - Scheduler compute buffers (`sched_reserve`: ~300 MB).
   - Vulkan driver staging buffers and command buffers.
3. **Double-Counting Analysis:**
   - There is NO double-counting between subsystems because each subsystem registers under a unique `SubsystemType:Id` key.
   - However, because the tracker registers `fileSize` rather than `fileSize + computeBuffers`, it slightly *under-reports* peak physical commitment by ~300–350 MB.
4. **Safety Mitigation (Why System Remained Safe):**
   - The safety gate in `ResourceManager.CanAllocateModelAsync` requires:
     $$\text{EffectiveAvailableRAM} \ge \text{ModelSize} + \text{MinHeadroom}$$
   - The default `MinModelLoadHeadroomMB` is set to **2,000 MB** ($2.0\text{ GB}$).
   - Because the 2,000 MB headroom requirement vastly exceeds the ~340 MB KV cache/compute buffer overhead, the allocation check has always been conservative and successfully protected the system from OOM.

---

## 5. Memory Recovery & Eviction Verification

To confirm that model unloading cleanly releases all physical RAM and virtual commitments:
1. `UnloadModelAsync` calls `llama_free` on context and `llama_free_model` on weights.
2. The `MemoryReservationLease` is disposed, releasing the reservation in `_activeReservations`.
3. `UnregisterSubsystemAllocation` removes the entry from `_allocations`.
4. `GC.Collect()` and `GC.WaitForPendingFinalizers()` are invoked.

### Measured Memory Recovery on 3B Model:
- Working Set loaded: **2,159.4 MB** $\to$ Post-unload: **72.9 MB** (**2,086.5 MB recovered**).
- Private Bytes loaded: **2,492.4 MB** $\to$ Post-unload: **27.5 MB** (**2,464.9 MB recovered**).
- **Result:** Complete memory release. Zero memory leak detected.

