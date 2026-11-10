# Phase 4 benchmark — computed results

Generated 2026-11-02T20:33:31.236Z from 27 result files in research/benchmark/results/. Temperature 0, context 4096, llama.cpp b11720.
Rates show 95% Wilson intervals in brackets. n = tasks in the configuration.

**qwen2.5-0.5b-instruct-q4_k_m_cpu_full: not admitted by the memory guard.** LocalInferenceError: Local model failed: Insufficient physical memory: 2272 MB available, model needs ~973 MB (estimate), leaving 1299 MB < required headroom 2000 MB
Estimate 973 MB; available before start 2298 MB; admission: {"ok":false,"availableBytes":2382458880,"requiredBytes":1020668768,"minHeadroomBytes":2097152000,"projectedHeadroomBytes":1361790112,"reason":"Insufficient physical memory: 2272 MB available, model needs ~973 MB (estimate), leaving 1299 MB < required headroom 2000 MB"}

**qwen2.5-0.5b-instruct-q4_k_m_vulkan_full_unstructured: not admitted by the memory guard.** LocalInferenceError: Local model failed: Insufficient physical memory: 2116 MB available, model needs ~973 MB (estimate), leaving 1143 MB < required headroom 2000 MB
Estimate 973 MB; available before start 2148 MB; admission: {"ok":false,"availableBytes":2218995712,"requiredBytes":1020668768,"minHeadroomBytes":2097152000,"projectedHeadroomBytes":1198326944,"reason":"Insufficient physical memory: 2116 MB available, model needs ~973 MB (estimate), leaving 1143 MB < required headroom 2000 MB"}

**qwen2.5-1.5b-instruct-q4_k_m_cpu_full: not admitted by the memory guard.** LocalInferenceError: Local model failed: Insufficient physical memory: 2185 MB available, model needs ~1634 MB (estimate), leaving 551 MB < required headroom 2000 MB
Estimate 1634 MB; available before start 2350 MB; admission: {"ok":false,"availableBytes":2291445760,"requiredBytes":1713698336,"minHeadroomBytes":2097152000,"projectedHeadroomBytes":577747424,"reason":"Insufficient physical memory: 2185 MB available, model needs ~1634 MB (estimate), leaving 551 MB < required headroom 2000 MB"}

**qwen2.5-1.5b-instruct-q4_k_m_vulkan_baseline: not admitted by the memory guard.** LocalInferenceError: Local model failed: Insufficient physical memory: 2272 MB available, model needs ~1634 MB (estimate), leaving 638 MB < required headroom 2000 MB
Estimate 1634 MB; available before start 2296 MB; admission: {"ok":false,"availableBytes":2382630912,"requiredBytes":1713698336,"minHeadroomBytes":2097152000,"projectedHeadroomBytes":668932576,"reason":"Insufficient physical memory: 2272 MB available, model needs ~1634 MB (estimate), leaving 638 MB < required headroom 2000 MB"}

**qwen2.5-1.5b-instruct-q4_k_m_vulkan_full: not admitted by the memory guard.** LocalInferenceError: Local model failed: Insufficient physical memory: 2249 MB available, model needs ~1634 MB (estimate), leaving 615 MB < required headroom 2000 MB
Estimate 1634 MB; available before start 2260 MB; admission: {"ok":false,"availableBytes":2358349824,"requiredBytes":1713698336,"minHeadroomBytes":2097152000,"projectedHeadroomBytes":644651488,"reason":"Insufficient physical memory: 2249 MB available, model needs ~1634 MB (estimate), leaving 615 MB < required headroom 2000 MB"}

**qwen2.5-1.5b-instruct-q4_k_m_vulkan_full_rep2: not admitted by the memory guard.** LocalInferenceError: Local model failed: Insufficient physical memory: 1980 MB available, model needs ~1634 MB (estimate), leaving 345 MB < required headroom 2000 MB
Estimate 1634 MB; available before start 2038 MB; admission: {"ok":false,"availableBytes":2075840512,"requiredBytes":1713698336,"minHeadroomBytes":2097152000,"projectedHeadroomBytes":362142176,"reason":"Insufficient physical memory: 1980 MB available, model needs ~1634 MB (estimate), leaving 345 MB < required headroom 2000 MB"}

**qwen2.5-1.5b-instruct-q4_k_m_vulkan_full_unstructured: not admitted by the memory guard.** LocalInferenceError: Local model failed: Insufficient physical memory: 2141 MB available, model needs ~1634 MB (estimate), leaving 507 MB < required headroom 2000 MB
Estimate 1634 MB; available before start 2153 MB; admission: {"ok":false,"availableBytes":2244874240,"requiredBytes":1713698336,"minHeadroomBytes":2097152000,"projectedHeadroomBytes":531175904,"reason":"Insufficient physical memory: 2141 MB available, model needs ~1634 MB (estimate), leaving 507 MB < required headroom 2000 MB"}

**qwen2.5-3b-instruct-q4_k_m_vulkan_full: not admitted by the memory guard.** LocalInferenceError: Local model failed: Insufficient physical memory: 2189 MB available, model needs ~2608 MB (estimate), leaving -419 MB < required headroom 2000 MB
Estimate 2608 MB; available before start 1986 MB; admission: {"ok":false,"availableBytes":2295152640,"requiredBytes":2734864800,"minHeadroomBytes":2097152000,"projectedHeadroomBytes":-439712160,"reason":"Insufficient physical memory: 2189 MB available, model needs ~2608 MB (estimate), leaving -419 MB < required headroom 2000 MB"}

## Reliability

| Config | n | Task success | First plan JSON ok | First plan valid (structure) | First plan valid (+grounding) | Valid after repair | Tool selection exact | Refusals correct |
|---|---|---|---|---|---|---|---|---|
| qwen2.5-0.5b-instruct-q4_k_m_vulkan_baseline | 36 | 28% (10/36) [16–44] | 100% (36/36) | 44% (16/36) | 33% (12/36) | 92% (33/36) | 50% (18/36) | 0% (0/5) |
| qwen2.5-0.5b-instruct-q4_k_m_vulkan_full | 36 | 22% (8/36) [12–38] | 100% (36/36) | 44% (16/36) | 33% (12/36) | 58% (21/36) | 28% (10/36) | 0% (0/5) |
| v2_qwen2.5-0.5b-instruct-q4_k_m_cpu_product | 36 | 56% (20/36) [40–70] | 100% (36/36) | 97% (35/36) | 97% (35/36) | 100% (36/36) | 61% (22/36) | 0% (0/5) |
| v2_qwen2.5-0.5b-instruct-q4_k_m_vulkan_argsOff | 36 | 33% (12/36) [20–50] | 97% (35/36) | 94% (34/36) | 94% (34/36) | 97% (35/36) | 47% (17/36) | 0% (0/5) |
| v2_qwen2.5-0.5b-instruct-q4_k_m_vulkan_grOn | 36 | 61% (22/36) [45–75] | 100% (36/36) | 100% (36/36) | 100% (36/36) | 100% (36/36) | 64% (23/36) | 0% (0/5) |
| v2_qwen2.5-0.5b-instruct-q4_k_m_vulkan_pgOn | 36 | 61% (22/36) [45–75] | 100% (36/36) | 100% (36/36) | 97% (35/36) | 100% (36/36) | 64% (23/36) | 0% (0/5) |
| v2_qwen2.5-0.5b-instruct-q4_k_m_vulkan_product | 36 | 61% (22/36) [45–75] | 100% (36/36) | 100% (36/36) | 100% (36/36) | 100% (36/36) | 64% (23/36) | 0% (0/5) |
| v2_qwen2.5-0.5b-instruct-q4_k_m_vulkan_product_unstructured | 36 | 0% (0/36) [0–10] | 94% (34/36) | 8% (3/36) | 3% (1/36) | 6% (2/36) | 0% (0/36) | 0% (0/5) |
| v2_qwen2.5-1.5b-instruct-q4_k_m_cpu_product | 36 | 56% (20/36) [40–70] | 100% (36/36) | 100% (36/36) | 100% (36/36) | 100% (36/36) | 61% (22/36) | 0% (0/5) |
| v2_qwen2.5-1.5b-instruct-q4_k_m_vulkan_argsOff | 36 | 44% (16/36) [30–60] | 100% (36/36) | 100% (36/36) | 100% (36/36) | 100% (36/36) | 67% (24/36) | 40% (2/5) |
| v2_qwen2.5-1.5b-instruct-q4_k_m_vulkan_grOn | 36 | 58% (21/36) [42–73] | 100% (36/36) | 100% (36/36) | 100% (36/36) | 100% (36/36) | 64% (23/36) | 0% (0/5) |
| v2_qwen2.5-1.5b-instruct-q4_k_m_vulkan_pgOn | 36 | 56% (20/36) [40–70] | 100% (36/36) | 100% (36/36) | 100% (36/36) | 100% (36/36) | 64% (23/36) | 0% (0/5) |
| v2_qwen2.5-1.5b-instruct-q4_k_m_vulkan_product | 36 | 56% (20/36) [40–70] | 100% (36/36) | 100% (36/36) | 100% (36/36) | 100% (36/36) | 64% (23/36) | 0% (0/5) |
| v2_qwen2.5-1.5b-instruct-q4_k_m_vulkan_product_rep2 | 36 | 56% (20/36) [40–70] | 100% (36/36) | 100% (36/36) | 100% (36/36) | 100% (36/36) | 64% (23/36) | 0% (0/5) |
| v2_qwen2.5-1.5b-instruct-q4_k_m_vulkan_product_unstructured | 36 | 56% (20/36) [40–70] | 100% (36/36) | 92% (33/36) | 78% (28/36) | 94% (34/36) | 64% (23/36) | 20% (1/5) |
| v2_qwen2.5-3b-instruct-q4_k_m_vulkan_product | 36 | 75% (27/36) [59–86] | 100% (36/36) | 97% (35/36) | 97% (35/36) | 97% (35/36) | 78% (28/36) | 60% (3/5) |
| v3_qwen2.5-0.5b-instruct-q4_k_m_vulkan_product | 36 | 61% (22/36) [45–75] | 100% (36/36) | 100% (36/36) | 100% (36/36) | 100% (36/36) | 64% (23/36) | 0% (0/5) |
| v3_qwen2.5-1.5b-instruct-q4_k_m_vulkan_product | 36 | 56% (20/36) [40–70] | 100% (36/36) | 100% (36/36) | 100% (36/36) | 100% (36/36) | 64% (23/36) | 0% (0/5) |
| v3_qwen2.5-3b-instruct-q4_k_m_vulkan_product | 36 | 75% (27/36) [59–86] | 100% (36/36) | 97% (35/36) | 97% (35/36) | 97% (35/36) | 78% (28/36) | 60% (3/5) |

## Success by category

| Config | single | trap | paraphrase | multi | unsupported | failure |
|---|---|---|---|---|---|---|
| qwen2.5-0.5b-instruct-q4_k_m_vulkan_baseline | 40% (4/10) | 60% (3/5) | 40% (2/5) | 17% (1/6) | 0% (0/6) | 0% (0/4) |
| qwen2.5-0.5b-instruct-q4_k_m_vulkan_full | 40% (4/10) | 40% (2/5) | 20% (1/5) | 17% (1/6) | 0% (0/6) | 0% (0/4) |
| v2_qwen2.5-0.5b-instruct-q4_k_m_cpu_product | 90% (9/10) | 100% (5/5) | 40% (2/5) | 50% (3/6) | 17% (1/6) | 0% (0/4) |
| v2_qwen2.5-0.5b-instruct-q4_k_m_vulkan_argsOff | 70% (7/10) | 40% (2/5) | 40% (2/5) | 17% (1/6) | 0% (0/6) | 0% (0/4) |
| v2_qwen2.5-0.5b-instruct-q4_k_m_vulkan_grOn | 100% (10/10) | 100% (5/5) | 80% (4/5) | 33% (2/6) | 17% (1/6) | 0% (0/4) |
| v2_qwen2.5-0.5b-instruct-q4_k_m_vulkan_pgOn | 100% (10/10) | 100% (5/5) | 80% (4/5) | 33% (2/6) | 17% (1/6) | 0% (0/4) |
| v2_qwen2.5-0.5b-instruct-q4_k_m_vulkan_product | 100% (10/10) | 100% (5/5) | 80% (4/5) | 33% (2/6) | 17% (1/6) | 0% (0/4) |
| v2_qwen2.5-0.5b-instruct-q4_k_m_vulkan_product_unstructured | 0% (0/10) | 0% (0/5) | 0% (0/5) | 0% (0/6) | 0% (0/6) | 0% (0/4) |
| v2_qwen2.5-1.5b-instruct-q4_k_m_cpu_product | 90% (9/10) | 100% (5/5) | 60% (3/5) | 33% (2/6) | 17% (1/6) | 0% (0/4) |
| v2_qwen2.5-1.5b-instruct-q4_k_m_vulkan_argsOff | 60% (6/10) | 60% (3/5) | 40% (2/5) | 33% (2/6) | 50% (3/6) | 0% (0/4) |
| v2_qwen2.5-1.5b-instruct-q4_k_m_vulkan_grOn | 90% (9/10) | 100% (5/5) | 60% (3/5) | 50% (3/6) | 17% (1/6) | 0% (0/4) |
| v2_qwen2.5-1.5b-instruct-q4_k_m_vulkan_pgOn | 90% (9/10) | 100% (5/5) | 60% (3/5) | 33% (2/6) | 17% (1/6) | 0% (0/4) |
| v2_qwen2.5-1.5b-instruct-q4_k_m_vulkan_product | 90% (9/10) | 100% (5/5) | 60% (3/5) | 33% (2/6) | 17% (1/6) | 0% (0/4) |
| v2_qwen2.5-1.5b-instruct-q4_k_m_vulkan_product_rep2 | 90% (9/10) | 100% (5/5) | 60% (3/5) | 33% (2/6) | 17% (1/6) | 0% (0/4) |
| v2_qwen2.5-1.5b-instruct-q4_k_m_vulkan_product_unstructured | 90% (9/10) | 100% (5/5) | 60% (3/5) | 17% (1/6) | 33% (2/6) | 0% (0/4) |
| v2_qwen2.5-3b-instruct-q4_k_m_vulkan_product | 100% (10/10) | 100% (5/5) | 80% (4/5) | 67% (4/6) | 67% (4/6) | 0% (0/4) |
| v3_qwen2.5-0.5b-instruct-q4_k_m_vulkan_product | 100% (10/10) | 100% (5/5) | 80% (4/5) | 33% (2/6) | 17% (1/6) | 0% (0/4) |
| v3_qwen2.5-1.5b-instruct-q4_k_m_vulkan_product | 90% (9/10) | 100% (5/5) | 60% (3/5) | 33% (2/6) | 17% (1/6) | 0% (0/4) |
| v3_qwen2.5-3b-instruct-q4_k_m_vulkan_product | 100% (10/10) | 100% (5/5) | 80% (4/5) | 67% (4/6) | 67% (4/6) | 0% (0/4) |

## Verification integrity: product (fail-closed) rule vs legacy (model-trust) rule

Incorrect completion claim = outcome `completed` while the independent oracle says the request was not correctly and fully served.
Missed completion = the oracle says the request WAS served, but the outcome is not `completed` (cost of being conservative).

| Config | Completed claims (product) | Incorrect claims (product) | Missed (product) | Completed claims (legacy) | Incorrect claims (legacy) | Missed (legacy) | Model assessor agrees with oracle |
|---|---|---|---|---|---|---|---|
| qwen2.5-0.5b-instruct-q4_k_m_vulkan_baseline | 9 | 0% (0/9) [0–30] | 1 | 29 | 66% (19/29) [47–80] | 0 | 34% (10/29) |
| qwen2.5-0.5b-instruct-q4_k_m_vulkan_full | 7 | 0% (0/7) [0–35] | 1 | 18 | 56% (10/18) [34–75] | 0 | 44% (8/18) |
| v2_qwen2.5-0.5b-instruct-q4_k_m_cpu_product | 16 | 0% (0/16) [0–19] | 4 | 26 | 31% (8/26) [17–50] | 2 | 69% (18/26) |
| v2_qwen2.5-0.5b-instruct-q4_k_m_vulkan_argsOff | 9 | 0% (0/9) [0–30] | 3 | 22 | 55% (12/22) [35–73] | 2 | 45% (10/22) |
| v2_qwen2.5-0.5b-instruct-q4_k_m_vulkan_grOn | 18 | 0% (0/18) [0–18] | 4 | 29 | 28% (8/29) [15–46] | 1 | 72% (21/29) |
| v2_qwen2.5-0.5b-instruct-q4_k_m_vulkan_pgOn | 18 | 0% (0/18) [0–18] | 4 | 30 | 30% (9/30) [17–48] | 1 | 70% (21/30) |
| v2_qwen2.5-0.5b-instruct-q4_k_m_vulkan_product | 18 | 0% (0/18) [0–18] | 4 | 30 | 30% (9/30) [17–48] | 1 | 70% (21/30) |
| v2_qwen2.5-0.5b-instruct-q4_k_m_vulkan_product_unstructured | 0 | n/a | 0 | 2 | 100% (2/2) [34–100] | 0 | 0% (0/2) |
| v2_qwen2.5-1.5b-instruct-q4_k_m_cpu_product | 15 | 7% (1/15) [1–30] | 6 | 24 | 33% (8/24) [18–53] | 4 | 61% (17/28) |
| v2_qwen2.5-1.5b-instruct-q4_k_m_vulkan_argsOff | 10 | 0% (0/10) [0–28] | 4 | 21 | 43% (9/21) [24–63] | 2 | 59% (16/27) |
| v2_qwen2.5-1.5b-instruct-q4_k_m_vulkan_grOn | 16 | 6% (1/16) [1–28] | 6 | 24 | 29% (7/24) [15–49] | 4 | 63% (19/30) |
| v2_qwen2.5-1.5b-instruct-q4_k_m_vulkan_pgOn | 15 | 7% (1/15) [1–30] | 6 | 24 | 33% (8/24) [18–53] | 4 | 60% (18/30) |
| v2_qwen2.5-1.5b-instruct-q4_k_m_vulkan_product | 15 | 7% (1/15) [1–30] | 6 | 24 | 33% (8/24) [18–53] | 4 | 60% (18/30) |
| v2_qwen2.5-1.5b-instruct-q4_k_m_vulkan_product_rep2 | 15 | 7% (1/15) [1–30] | 6 | 24 | 33% (8/24) [18–53] | 4 | 60% (18/30) |
| v2_qwen2.5-1.5b-instruct-q4_k_m_vulkan_product_unstructured | 14 | 7% (1/14) [1–31] | 6 | 22 | 32% (7/22) [16–53] | 4 | 61% (17/28) |
| v2_qwen2.5-3b-instruct-q4_k_m_vulkan_product | 16 | 0% (0/16) [0–19] | 8 | 18 | 0% (0/18) [0–18] | 6 | 84% (21/25) |
| v3_qwen2.5-0.5b-instruct-q4_k_m_vulkan_product | 18 | 0% (0/18) [0–18] | 4 | 30 | 30% (9/30) [17–48] | 1 | 70% (21/30) |
| v3_qwen2.5-1.5b-instruct-q4_k_m_vulkan_product | 14 | 0% (0/14) [0–22] | 6 | 24 | 33% (8/24) [18–53] | 4 | 60% (18/30) |
| v3_qwen2.5-3b-instruct-q4_k_m_vulkan_product | 16 | 0% (0/16) [0–19] | 8 | 18 | 0% (0/18) [0–18] | 6 | 84% (21/25) |

## Injected failures

| Config | f01 always-fail info | f02 always-fail math | f03 fail-first math (recovery) | f04 hang time |
|---|---|---|---|---|
| qwen2.5-0.5b-instruct-q4_k_m_vulkan_baseline | failed (legacy failed) | unverified (legacy completed) | failed (legacy failed) | failed (legacy failed) |
| qwen2.5-0.5b-instruct-q4_k_m_vulkan_full | failed (legacy failed) | unverified (legacy completed) | failed (legacy failed) | failed (legacy failed) |
| v2_qwen2.5-0.5b-instruct-q4_k_m_cpu_product | failed (legacy failed) | partial (legacy partial) | failed (legacy failed) | failed (legacy failed) |
| v2_qwen2.5-0.5b-instruct-q4_k_m_vulkan_argsOff | failed (legacy failed) | partial (legacy partial) | failed (legacy failed) | failed (legacy failed) |
| v2_qwen2.5-0.5b-instruct-q4_k_m_vulkan_grOn | failed (legacy failed) | partial (legacy partial) | failed (legacy failed) | failed (legacy failed) |
| v2_qwen2.5-0.5b-instruct-q4_k_m_vulkan_pgOn | failed (legacy failed) | partial (legacy partial) | failed (legacy failed) | failed (legacy failed) |
| v2_qwen2.5-0.5b-instruct-q4_k_m_vulkan_product | failed (legacy failed) | partial (legacy partial) | failed (legacy failed) | failed (legacy failed) |
| v2_qwen2.5-0.5b-instruct-q4_k_m_vulkan_product_unstructured | failed (legacy failed) | failed (legacy failed) | failed (legacy failed) | failed (legacy failed) |
| v2_qwen2.5-1.5b-instruct-q4_k_m_cpu_product | unverified (legacy completed) | partial (legacy partial) | failed (legacy failed) | failed (legacy failed) |
| v2_qwen2.5-1.5b-instruct-q4_k_m_vulkan_argsOff | unverified (legacy completed) | partial (legacy partial) | failed (legacy failed) | failed (legacy failed) |
| v2_qwen2.5-1.5b-instruct-q4_k_m_vulkan_grOn | unverified (legacy completed) | partial (legacy partial) | failed (legacy failed) | failed (legacy failed) |
| v2_qwen2.5-1.5b-instruct-q4_k_m_vulkan_pgOn | unverified (legacy completed) | partial (legacy partial) | failed (legacy failed) | failed (legacy failed) |
| v2_qwen2.5-1.5b-instruct-q4_k_m_vulkan_product | unverified (legacy completed) | partial (legacy partial) | failed (legacy failed) | failed (legacy failed) |
| v2_qwen2.5-1.5b-instruct-q4_k_m_vulkan_product_rep2 | unverified (legacy completed) | partial (legacy partial) | failed (legacy failed) | failed (legacy failed) |
| v2_qwen2.5-1.5b-instruct-q4_k_m_vulkan_product_unstructured | unverified (legacy completed) | partial (legacy partial) | failed (legacy failed) | failed (legacy failed) |
| v2_qwen2.5-3b-instruct-q4_k_m_vulkan_product | failed (legacy failed) | partial (legacy partial) | failed (legacy failed) | failed (legacy failed) |
| v3_qwen2.5-0.5b-instruct-q4_k_m_vulkan_product | failed (legacy failed) | partial (legacy partial) | failed (legacy failed) | failed (legacy failed) |
| v3_qwen2.5-1.5b-instruct-q4_k_m_vulkan_product | unverified (legacy completed) | partial (legacy partial) | failed (legacy failed) | failed (legacy failed) |
| v3_qwen2.5-3b-instruct-q4_k_m_vulkan_product | failed (legacy failed) | partial (legacy partial) | failed (legacy failed) | failed (legacy failed) |

## Latency and resources (measured)

| Config | Load | Unload | Plan call p50 / p95 | Assess call p50 | Task e2e p50 / p95 | Multi-step e2e p50 / p95 | Peak llama-server WS | Min available RAM | CPU % p50 (system) | GPU engine % p50 | Non-loopback conns |
|---|---|---|---|---|---|---|---|---|---|---|---|
| qwen2.5-0.5b-instruct-q4_k_m_vulkan_baseline | 2.4 s | 0.3 s | 2.3 s / 9.0 s | 1.3 s | 5.2 s / 16.4 s | 6.6 s / 13.1 s | 721 MB | 1441 MB | 26 | 77 | 0 |
| qwen2.5-0.5b-instruct-q4_k_m_vulkan_full | 2.2 s | 0.2 s | 2.0 s / 7.1 s | 1.2 s | 4.3 s / 14.9 s | 7.3 s / 21.6 s | 732 MB | 2986 MB | 23 | 83 | 0 |
| v2_qwen2.5-0.5b-instruct-q4_k_m_cpu_product | 4.4 s | 0.1 s | 5.7 s / 10.9 s | 2.6 s | 8.2 s / 15.3 s | 9.2 s / 15.3 s | 614 MB | 4691 MB | 69 | 0 | 0 |
| v2_qwen2.5-0.5b-instruct-q4_k_m_vulkan_argsOff | 2.2 s | 0.2 s | 1.8 s / 10.2 s | 1.1 s | 2.9 s / 14.6 s | 2.9 s / 6.1 s | 706 MB | 2750 MB | 25 | 86 | 0 |
| v2_qwen2.5-0.5b-instruct-q4_k_m_vulkan_grOn | 2.4 s | 0.2 s | 2.3 s / 3.0 s | 1.2 s | 3.5 s / 8.8 s | 6.9 s / 9.1 s | 733 MB | 2877 MB | 29 | 83 | 0 |
| v2_qwen2.5-0.5b-instruct-q4_k_m_vulkan_pgOn | 2.3 s | 0.2 s | 2.1 s / 3.5 s | 1.2 s | 3.4 s / 5.2 s | 3.4 s / 7.0 s | 710 MB | 2889 MB | 28 | 80 | 0 |
| v2_qwen2.5-0.5b-instruct-q4_k_m_vulkan_product | 3.1 s | 0.2 s | 2.5 s / 4.9 s | 1.4 s | 3.9 s / 6.2 s | 4.1 s / 8.1 s | 722 MB | 1749 MB | 23 | 76 | 0 |
| v2_qwen2.5-0.5b-instruct-q4_k_m_vulkan_product_unstructured | 2.3 s | 0.2 s | 1.0 s / 2.2 s | 0.9 s | 2.0 s / 14.7 s | 2.4 s / 14.6 s | 736 MB | 4949 MB | 15 | 81 | 0 |
| v2_qwen2.5-1.5b-instruct-q4_k_m_cpu_product | 8.7 s | 0.3 s | 10.6 s / 18.5 s | 3.8 s | 14.1 s / 40.8 s | 14.1 s / 18.3 s | 1816 MB | 3423 MB | 69 | 0 | 0 |
| v2_qwen2.5-1.5b-instruct-q4_k_m_vulkan_argsOff | 5.5 s | 0.5 s | 3.7 s / 5.2 s | 1.4 s | 5.1 s / 13.1 s | 6.1 s / 12.9 s | 1413 MB | 3572 MB | 12 | 88 | 0 |
| v2_qwen2.5-1.5b-instruct-q4_k_m_vulkan_grOn | 5.8 s | 0.3 s | 4.2 s / 10.7 s | 1.6 s | 6.8 s / 17.4 s | 10.6 s / 19.9 s | 1403 MB | 2751 MB | 12 | 87 | 0 |
| v2_qwen2.5-1.5b-instruct-q4_k_m_vulkan_pgOn | 5.1 s | 0.4 s | 4.4 s / 10.7 s | 1.7 s | 6.1 s / 20.3 s | 6.5 s / 21.0 s | 1402 MB | 2002 MB | 25 | 93 | 0 |
| v2_qwen2.5-1.5b-instruct-q4_k_m_vulkan_product | 5.6 s | 0.3 s | 4.1 s / 10.3 s | 1.6 s | 5.7 s / 20.2 s | 6.2 s / 20.3 s | 1419 MB | 2112 MB | 26 | 94 | 0 |
| v2_qwen2.5-1.5b-instruct-q4_k_m_vulkan_product_rep2 | 5.9 s | 0.6 s | 4.1 s / 10.7 s | 1.6 s | 5.9 s / 20.0 s | 6.3 s / 20.8 s | 1409 MB | 3741 MB | 11 | 88 | 0 |
| v2_qwen2.5-1.5b-instruct-q4_k_m_vulkan_product_unstructured | 4.0 s | 0.3 s | 4.0 s / 5.6 s | 1.5 s | 6.0 s / 13.9 s | 6.3 s / 12.7 s | 1423 MB | 3957 MB | 23 | 94 | 0 |
| v2_qwen2.5-3b-instruct-q4_k_m_vulkan_product | 8.5 s | 0.5 s | 10.1 s / 17.6 s | 4.2 s | 14.1 s / 24.9 s | 19.3 s / 25.7 s | 2412 MB | 3074 MB | 20 | 96 | 0 |
| v3_qwen2.5-0.5b-instruct-q4_k_m_vulkan_product | 3.6 s | 0.2 s | 2.1 s / 3.6 s | 1.3 s | 3.5 s / 4.7 s | 3.6 s / 7.5 s | 703 MB | 4804 MB | 32 | 80 | 0 |
| v3_qwen2.5-1.5b-instruct-q4_k_m_vulkan_product | 7.2 s | 0.3 s | 4.4 s / 11.5 s | 1.6 s | 6.1 s / 22.1 s | 6.9 s / 22.7 s | 1409 MB | 4032 MB | 25 | 90 | 0 |
| v3_qwen2.5-3b-instruct-q4_k_m_vulkan_product | 9.1 s | 0.5 s | 10.4 s / 17.7 s | 4.5 s | 14.5 s / 25.7 s | 19.3 s / 25.8 s | 2426 MB | 3114 MB | 16 | 94 | 0 |

## Paired switch comparisons (v2 code)

Each row compares one configuration with the product configuration of the SAME model on the same 36 tasks.
Wins / losses = tasks whose oracle success changed; p = exact two-sided sign test on those discordant tasks (small n: treat as indicative only).

| Model | Variant vs product | Success (variant) | Success (product) | Wins | Losses | p | Valid after repair (variant / product) | Incorrect claims (variant / product) |
|---|---|---|---|---|---|---|---|---|
| 0.5b | argsOff | 12/36 | 22/36 | 0 | 10 | 0.00 | 35 / 36 | 0 / 0 |
| 0.5b | grOn | 22/36 | 22/36 | 0 | 0 | 1.00 | 36 / 36 | 0 / 0 |
| 0.5b | pgOn | 22/36 | 22/36 | 0 | 0 | 1.00 | 36 / 36 | 0 / 0 |
| 1.5b | argsOff | 16/36 | 20/36 | 2 | 6 | 0.29 | 36 / 36 | 0 / 1 |
| 1.5b | grOn | 21/36 | 20/36 | 1 | 0 | 1.00 | 36 / 36 | 1 / 1 |
| 1.5b | pgOn | 20/36 | 20/36 | 0 | 0 | 1.00 | 36 / 36 | 1 / 1 |

## Argument-domain enforcement (v2)

| Config | Argument violations (first plan + blocked at execution) | Planning failures after repair |
|---|---|---|
| v2_qwen2.5-0.5b-instruct-q4_k_m_cpu_product | 0 | 0 |
| v2_qwen2.5-0.5b-instruct-q4_k_m_vulkan_argsOff | 0 | 1 |
| v2_qwen2.5-0.5b-instruct-q4_k_m_vulkan_grOn | 0 | 0 |
| v2_qwen2.5-0.5b-instruct-q4_k_m_vulkan_pgOn | 0 | 0 |
| v2_qwen2.5-0.5b-instruct-q4_k_m_vulkan_product | 0 | 0 |
| v2_qwen2.5-0.5b-instruct-q4_k_m_vulkan_product_unstructured | 2 | 34 |
| v2_qwen2.5-1.5b-instruct-q4_k_m_cpu_product | 0 | 0 |
| v2_qwen2.5-1.5b-instruct-q4_k_m_vulkan_argsOff | 0 | 0 |
| v2_qwen2.5-1.5b-instruct-q4_k_m_vulkan_grOn | 0 | 0 |
| v2_qwen2.5-1.5b-instruct-q4_k_m_vulkan_pgOn | 0 | 0 |
| v2_qwen2.5-1.5b-instruct-q4_k_m_vulkan_product | 0 | 0 |
| v2_qwen2.5-1.5b-instruct-q4_k_m_vulkan_product_rep2 | 0 | 0 |
| v2_qwen2.5-1.5b-instruct-q4_k_m_vulkan_product_unstructured | 5 | 2 |
| v2_qwen2.5-3b-instruct-q4_k_m_vulkan_product | 0 | 1 |

## Model comparison — final code, product configuration (v3)

n = 36 tasks per model, one run each at temperature 0 (the 1.5B v2 repeat was 36/36 identical, so run-to-run variance is low; task-sampling uncertainty is shown as 95% Wilson intervals).

| Metric | 0.5b | 1.5b | 3b |
|---|---|---|---|
| Task success (oracle) | 61% (22/36) [45–75] | 56% (20/36) [40–70] | 75% (27/36) [59–86] |
| Multi-step success | 33% (2/6) | 33% (2/6) | 67% (4/6) |
| First plan valid | 100% (36/36) | 100% (36/36) | 97% (35/36) |
| Valid after repair | 100% (36/36) | 100% (36/36) | 97% (35/36) |
| Tool selection exact (answerable) | 74% (23/31) | 74% (23/31) | 81% (25/31) |
| Instruction following (u06: list only) | yes | yes | yes |
| Impossible requests refused | 0% (0/5) [0–43] | 0% (0/5) [0–43] | 60% (3/5) [23–88] |
| Impossible requests NOT claimed completed | 100% (5/5) | 100% (5/5) | 100% (5/5) |
| Incorrect completion claims (product rule) | 0/18 [0–18] | 0/14 [0–22] | 0/16 [0–19] |
| Incorrect completion claims (legacy model-trust rule) | 9/30 [17–48] | 8/24 [18–53] | 0/18 [0–18] |
| Missed completions (served but not completed) | 4 | 6 | 8 |
| Task latency p50 / p95 | 3.5 s / 4.7 s | 6.1 s / 22.1 s | 14.5 s / 25.7 s |
| Multi-step latency p50 / p95 | 3.6 s / 7.5 s | 6.9 s / 22.7 s | 19.3 s / 25.8 s |
| Model load | 3.6 s | 7.2 s | 9.1 s |
| Peak llama-server working set | 703 MB | 1409 MB | 2426 MB |
| Lowest available system RAM during run | 4804 MB | 4032 MB | 3114 MB |
| GPU engine utilisation p50 / p95 (Vulkan) | 80% / 86% | 90% / 97% | 94% / 99% |
| Non-loopback connections | 0 | 0 | 0 |

## Determinism (repeat run, same configuration)

- v2_qwen2.5-1.5b-instruct-q4_k_m_vulkan_product_rep2 vs v2_qwen2.5-1.5b-instruct-q4_k_m_vulkan_product: identical outcome on 100% (36/36), identical oracle success on 100% (36/36).

## Per-task outcomes

| Task | 0.5b_vulkan_baseline | 0.5b_vulkan_full | v2_0.5b_cpu_product | v2_0.5b_vulkan_argsOff | v2_0.5b_vulkan_grOn | v2_0.5b_vulkan_pgOn | v2_0.5b_vulkan_product | v2_0.5b_vulkan_product_unstructured | v2_1.5b_cpu_product | v2_1.5b_vulkan_argsOff | v2_1.5b_vulkan_grOn | v2_1.5b_vulkan_pgOn | v2_1.5b_vulkan_product | v2_1.5b_vulkan_product_rep2 | v2_1.5b_vulkan_product_unstructured | v2_3b_vulkan_product | v3_0.5b_vulkan_product | v3_1.5b_vulkan_product | v3_3b_vulkan_product |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| s01 | partial | failed | partial ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | failed | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | partial ✓ | completed ✓ | completed ✓ | partial ✓ |
| s02 | completed ✓ | completed ✓ | partial ✓ | partial ✓ | partial ✓ | partial ✓ | partial ✓ | failed | partial ✓ | partial | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | partial ✓ | completed ✓ | completed ✓ |
| s03 | failed | failed | partial | failed | completed ✓ | completed ✓ | completed ✓ | failed | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ |
| s04 | partial | failed | completed ✓ | partial | completed ✓ | completed ✓ | completed ✓ | failed | completed ✓ | partial | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ |
| s05 | failed | failed | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | failed | completed ✓ | partial ✓ | partial ✓ | partial ✓ | partial ✓ | partial ✓ | partial ✓ | partial ✓ | completed ✓ | partial ✓ | partial ✓ |
| s06 | failed | failed | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | failed | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ |
| s07 | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | failed | unverified | unverified | unverified | unverified | unverified | unverified | unverified | partial ✓ | completed ✓ | unverified | partial ✓ |
| s08 | completed ✓ | completed ✓ | completed ✓ | partial ✓ | completed ✓ | completed ✓ | completed ✓ | failed | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ |
| s09 | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | failed | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ |
| s10 | unverified | unverified | completed ✓ | unverified | completed ✓ | completed ✓ | completed ✓ | failed | completed ✓ | failed | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ |
| t01 | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | failed | partial ✓ | partial ✓ | partial ✓ | partial ✓ | partial ✓ | partial ✓ | partial ✓ | partial ✓ | completed ✓ | partial ✓ | partial ✓ |
| t02 | partial | failed | completed ✓ | partial | completed ✓ | completed ✓ | completed ✓ | failed | partial ✓ | partial | partial ✓ | partial ✓ | partial ✓ | partial ✓ | partial ✓ | completed ✓ | completed ✓ | partial ✓ | completed ✓ |
| t03 | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | failed | partial ✓ | completed ✓ | partial ✓ | partial ✓ | partial ✓ | partial ✓ | partial ✓ | partial ✓ | completed ✓ | partial ✓ | partial ✓ |
| t04 | completed ✓ | failed | completed ✓ | partial | completed ✓ | completed ✓ | completed ✓ | failed | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ |
| t05 | unverified | failed | completed ✓ | unverified | completed ✓ | completed ✓ | completed ✓ | failed | completed ✓ | refused | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ |
| p01 | failed | failed | failed | failed | unverified ✓ | unverified ✓ | unverified ✓ | unverified | unverified ✓ | unverified ✓ | unverified ✓ | unverified ✓ | unverified ✓ | unverified ✓ | unverified ✓ | unverified ✓ | unverified ✓ | unverified ✓ | unverified ✓ |
| p02 | unverified | unverified | unverified ✓ | unverified ✓ | unverified ✓ | unverified ✓ | unverified ✓ | failed | unverified ✓ | unverified ✓ | unverified ✓ | unverified ✓ | unverified ✓ | unverified ✓ | unverified ✓ | unverified ✓ | unverified ✓ | unverified ✓ | unverified ✓ |
| p03 | unverified | partial | partial | unverified | partial | unverified | unverified | failed | partial | unverified | partial | partial | partial | partial | failed | partial ✓ | unverified | partial | partial ✓ |
| p04 | completed ✓ | failed | partial | unverified | completed ✓ | completed ✓ | completed ✓ | failed | completed ✓ | refused | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ |
| p05 | unverified ✓ | unverified ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | failed | refused | refused | refused | refused | refused | refused | refused | failed | completed ✓ | refused | failed |
| m01 | unverified | unverified | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | failed | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ |
| m02 | completed ✓ | completed ✓ | unverified | failed | unverified | unverified | unverified | failed | unverified | unverified | unverified | unverified | unverified | unverified | unverified | completed ✓ | unverified | unverified | completed ✓ |
| m03 | unverified | failed | partial | partial | partial | unverified | partial | failed | unverified | unverified | completed ✓ | unverified | unverified | unverified | unverified | completed ✓ | partial | unverified | completed ✓ |
| m04 | partial | failed | unverified | unverified | unverified | unverified | unverified | failed | unverified | partial | unverified | partial | partial | partial | partial | partial | unverified | partial | partial |
| m05 | unverified | unverified | unverified ✓ | unverified | unverified ✓ | unverified ✓ | unverified ✓ | failed | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | unverified | partial | unverified ✓ | completed ✓ | partial |
| m06 | unverified | unverified | completed ✓ | partial | unverified | unverified | unverified | failed | unverified | unverified | partial | unverified | unverified | unverified | unverified | completed ✓ | unverified | unverified | completed ✓ |
| u01 | unverified | unverified | unverified | partial | unverified | unverified | unverified | failed | partial | partial | unverified | unverified | unverified | unverified | refused ✓ | refused ✓ | unverified | unverified | refused ✓ |
| u02 | unverified | unverified | unverified | unverified | unverified | unverified | unverified | failed | unverified | partial | unverified | unverified | unverified | unverified | failed | refused ✓ | unverified | unverified | refused ✓ |
| u03 | unverified | failed | unverified | partial | unverified | unverified | unverified | failed | partial | partial | partial | partial | partial | partial | partial | refused ✓ | unverified | partial | refused ✓ |
| u04 | unverified | failed | partial | partial | partial | partial | partial | failed | completed | refused ✓ | completed | completed | completed | completed | completed | failed | partial | unverified | failed |
| u05 | unverified | unverified | unverified | partial | unverified | unverified | unverified | failed | failed | refused ✓ | failed | failed | failed | failed | failed | partial | unverified | failed | partial |
| u06 | unverified | unverified | completed ✓ | partial | completed ✓ | completed ✓ | completed ✓ | unverified | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ | completed ✓ |
| f01 | failed | failed | failed | failed | failed | failed | failed | failed | unverified | unverified | unverified | unverified | unverified | unverified | unverified | failed | failed | unverified | failed |
| f02 | unverified | unverified | partial | partial | partial | partial | partial | failed | partial | partial | partial | partial | partial | partial | partial | partial | partial | partial | partial |
| f03 | failed | failed | failed | failed | failed | failed | failed | failed | failed | failed | failed | failed | failed | failed | failed | failed | failed | failed | failed |
| f04 | failed | failed | failed | failed | failed | failed | failed | failed | failed | failed | failed | failed | failed | failed | failed | failed | failed | failed | failed |

✓ = oracle says the request was correctly and fully served (or correctly refused).

## First-plan rejection reasons (all configs, normalised)

- 44× qwen2.5-0.5b-instruct-q4: step: dependsOn "…" is not an earlier step
- 21× v2: plan.intent: must be one of task, question, unsupported
- 7× v2: plan.goal: required
- 7× v2: plan.steps: required
- 6× qwen2.5-0.5b-instruct-q4: step: time zone Asia/Kolkata is not what the request asks for (no zone named; omit timeZon
- 5× v2: step: unknown tool "…"
- 5× v2: step: system.time.timeZone must be omitted for this request (no time zone is named in the 
- 4× qwen2.5-0.5b-instruct-q4: step: the request names london; pass that timeZone
- 4× qwen2.5-0.5b-instruct-q4: step: time zone agent/runtime is not what the request asks for (tokyo)
- 4× qwen2.5-0.5b-instruct-q4: step: listed the workspace root, but the request names docs
- 3× v2: plan.intent: required
- 2× qwen2.5-0.5b-instruct-q4: step: the request names tokyo; pass that timeZone
- 2× qwen2.5-0.5b-instruct-q4: step: "…" (= 15) does not match the request, which asks for (3+4)*(5-2); evaluate it exact
- 2× qwen2.5-0.5b-instruct-q4: step: listed the workspace root, but the request names agent/runtime/tools
- 2× qwen2.5-0.5b-instruct-q4: step: time zone UTC is not what the request asks for (new york)
- 2× qwen2.5-0.5b-instruct-q4: step: time zone Asia/Kolkata is not what the request asks for (new york)
- 2× qwen2.5-0.5b-instruct-q4: step: "…" (= 67) does not match the request, which asks for (17+25)*2; evaluate it exactly
- 2× qwen2.5-0.5b-instruct-q4: step: listed /docs, but the request names docs
- 2× v2: a task or question needs at least one step
- 2× v2: step: the request names tokyo; pass that timeZone
