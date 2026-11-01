# Qwen2.5-3B Model Validation & Hardware Feasibility Report

**Target Model:** `Qwen2.5-3B-Instruct-Q4_K_M`  
**File Name:** `qwen2.5-3b-instruct-q4_k_m.gguf`  
**Source Repository:** `Qwen/Qwen2.5-3B-Instruct-GGUF` (Hugging Face)  
**Host Hardware:** Intel Core i5-1335U, 16 GB Physical RAM (15.7 GB Usable), Intel Iris Xe Graphics  
**Audit Date:** October 31, 2026  
**Auditor:** Senior Systems Engineer & ML Inference Performance Researcher  

---

## 1. Executive Summary & Core Feasibility Finding

The original Stage 2 specification selected `Qwen2.5-3B-Instruct-Q4_K_M` as the primary local model. This audit downloaded, verified, and experimentally tested the 3B model against both the live host system and a controlled test environment.

### Core Feasibility Finding
> [!IMPORTANT]
> **On a 16 GB RAM machine with typical ambient desktop usage (~12.4 GB in use, ~3.3–3.6 GB available physical RAM), the 3B model CANNOT be safely loaded without violating system memory safety constraints.**
>
> The D-ASK Resource Manager correctly and automatically **BLOCKED** model allocation on the live host system. Loading the 3B model requires 2,007 MB for weights plus ~340 MB for KV cache and inference buffers ($\approx 2,348\text{ MB}$ total). Allocating this from 3,650 MB available RAM would leave only **1,302 MB projected headroom**, breaching the configured 2,000 MB safety threshold and the critical 1,800 MB boundary.
>
> For ambient, background-assistant operation alongside user applications on 16 GB hardware, the 0.5B model (`qwen2.5-0.5b-instruct-q4_k_m.gguf`, 468 MB weights, ~587 MB loaded working set) is the technically appropriate model. The 3B model is viable only on systems with $\ge 24\text{ GB}$ of physical RAM or in dedicated environments where ambient RAM usage is $< 10\text{ GB}$.

---

## 2. Model File Specifications & Integrity Verification

The model weights were downloaded directly from the official Qwen repository on Hugging Face:
- **Download URL:** `https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf`
- **Actual File Size:** `2,104,932,768` bytes ($2,007.42\text{ MB} = 1.960\text{ GiB}$)
- **Quantization:** `Q4_K_M` (4.94 Bits Per Weight)
- **Calculated SHA256:** `626B4A6678B86442240E33DF819E00132D3BA7DDDFE1CDC4FBB18E0A9615C62D`
- **Disk Free Space on Target Drive (D:):** $118.38\text{ GB}$ available before download ($116.42\text{ GB}$ after download).

### GGUF Metadata Parsed by `llama.cpp`
```text
print_info: model type            = 3B
print_info: model params          = 3.40 B
print_info: general.name          = qwen2.5-3b-instruct
qwen2.block_count u32             = 36 layers
qwen2.context_length u32          = 32768 tokens
qwen2.embedding_length u32        = 2048
qwen2.feed_forward_length u32     = 11008
qwen2.attention.head_count u32    = 16
qwen2.attention.head_count_kv u32 = 2
general.file_type u32             = 15 (Q4_K_M)
```

---

## 3. Live Resource Manager Safety Gate Audit

The 3B model was submitted to the live D-ASK `ResourceManager` on the development workstation.

### Live Host Hardware Measurement
- **Total Physical RAM:** `16,067.4 MB` (15.69 GB)
- **Available Physical RAM:** `3,650.0 MB` (77.0% load)
- **Required Model Size:** `2,007.42 MB`
- **Configured Min Headroom:** `2,000.0 MB`
- **Configured Critical Boundary:** `1,800.0 MB`

### Allocation Decision & Log Trace
```text
[Information] Evaluating model allocation: 'Qwen2.5 3B Instruct', Required: 2007 MB, Available: 3650 MB, ActiveReservations: 0 MB, Min Headroom: 2000 MB
[Warning] Model allocation BLOCKED: Insufficient physical RAM to load 'Qwen2.5 3B Instruct'. Effective Available (less reservations): 3650 MB, Required: 2007 MB. Projected headroom (1642 MB) would breach the minimum safety threshold of 2000 MB.
```

- **Outcome:** `IsAllowed = False`. Zero memory allocated, zero leases granted.
- **Verification:** The safety gate prevented system memory exhaustion without crashing.

---

## 4. Controlled Loading & Memory Footprint Audit

To measure the intrinsic memory consumption and compute overhead of the 3B model without crashing the host, testing was conducted in a controlled test harness configured with simulated 6.5 GB available headroom.

### 4.1 Loading & Unloading Latency
| Phase | Measured Time | Note |
| :--- | :---: | :--- |
| **Model Weight Mapping (`mmap`)** | **4,106 ms** (4.11 s) | Initial disk read & virtual mapping of 2.1 GB weights |
| **Model Unloading & Unmapping** | **375 ms** | Invocation of `llama_free`, lease release, and `GC.Collect()` |

### 4.2 Physical Memory Consumption (Measured)
| Metric | Baseline (Pre-Load) | Model Loaded | Delta ($\Delta$) | Post-Unload | Memory Recovered |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Working Set RAM** | **57.1 MB** | **2,159.4 MB** | **+2,102.3 MB** | **72.9 MB** | **2,086.5 MB** (99.2%) |
| **Private Bytes** | **17.7 MB** | **2,492.4 MB** | **+2,474.7 MB** | **27.5 MB** | **2,464.9 MB** (99.6%) |

### 4.3 KV Cache & Compute Buffer Scaling
Measurements obtained directly from `llama.cpp` buffer reservations:

| Parameter | Value |
| :--- | :--- |
| **Attention Layers** | 36 layers |
| **Key/Value Attention Heads** | 2 heads per layer |
| **Head Dimension (`n_embd_head_k_all`)** | 128 |
| **KV Cache Data Type** | FP16 ($2\text{ bytes}$ per element) |
| **KV Cache at Context = 512** | **18.00 MiB** ($K = 9\text{ MiB}, V = 9\text{ MiB}$) |
| **KV Cache at Context = 1024** | **36.00 MiB** ($K = 18\text{ MiB}, V = 18\text{ MiB}$) |
| **KV Cache at Context = 2048** | **72.00 MiB** ($K = 36\text{ MiB}, V = 36\text{ MiB}$) |
| **KV Cache at Context = 4096** | **144.00 MiB** ($K = 72\text{ MiB}, V = 72\text{ MiB}$) |
| **Scheduler Compute Buffer (`sched_reserve`)** | **304.75 MiB** (1,230 graph nodes, 1 graph split) |
| **Total Non-Weight Overhead** | **~340.75 MiB** at 1024 context |

---

## 5. Inference Performance (3B Model on CPU AVX2)

In the controlled harness, the 3B model was prompted with `"Hello! Tell me in 3 words who you are."`:
- **Generated Output:** `'D-ASK AI.'` (5 tokens)
- **Time to First Token (TTFT):** **1,225.9 ms**
- **Generation Throughput:** **5.50 tokens/sec**
- **Hardware Threads:** 4 threads (`n_threads=4`)

### Performance Comparison: 3B vs 0.5B
| Metric | Qwen2.5 0.5B | Qwen2.5 3B | Performance Trade-Off |
| :--- | :---: | :---: | :---: |
| **Weight Size** | 468.6 MB | 2,007.4 MB | 4.28x larger |
| **Working Set RAM** | ~587 MB | ~2,159 MB | 3.68x larger |
| **CPU Throughput** | **22.68 tok/s** (mean) | **5.50 tok/s** | **~4.1x slower** |
| **TTFT** | **546.6 ms** (mean) | **1,225.9 ms** | **2.24x slower** |

---

## 6. Recommendations & Technical Conclusion

1. **Keep 0.5B as the Default Tier-1 Model:** For instant interactive desktop queries, quick intent parsing, and tool-call routing on 16 GB hardware, the 0.5B model provides 22–35 tokens/sec throughput with $< 600\text{ MB}$ working set.
2. **Tier-2 Scaled Model (Optional):** The 3B model is viable if physical memory availability $> 4.2\text{ GB}$. The daemon's `IModelRuntime` and `ResourceManager` already support swapping between 0.5B and 3B based on live available memory.
3. **Hardware Requirement for 3B Default:** To deploy 3B as the permanent, always-resident model, the host workstation should have 24 GB or 32 GB of physical RAM.

