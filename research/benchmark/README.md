# Phase 4 benchmark: local model quality and performance

This is research code. It imports the product runtime (`agent/runtime/**`) unmodified, and nothing in the product imports from `research/`.

## Reproduce

```bash
node scripts/inference/fetch-llama-server.mjs --verify        # pinned runtime, hash-checked
node scripts/inference/fetch-model.mjs qwen2.5-1.5b-instruct-q4_k_m   # only if missing; refuses to overwrite
bash research/benchmark/run-matrix.sh                          # about 1–2 h on the reference machine
npx tsx research/benchmark/report.ts                           # writes RESULTS.md from results/*.json
```

A single configuration:

```bash
npx tsx research/benchmark/run.ts --model qwen2.5-1.5b-instruct-q4_k_m --backend vulkan --variant full
```

## Protocol
- **Task suite:** 36 tasks in `tasks.ts`, in six categories (single, trap, paraphrase, multi, unsupported, failure). The paraphrase category is phrased so the deterministic detectors are *not* designed for it, to measure what fail-closed verification costs.
- **Oracle:** hand-specified expected values, zones, folders and tool sets. It shares **no code** with `grounding.ts` or `requestChecks.ts`, so the verifier is never graded against itself.
- **Variants, v1 (Phase 4; files without a `v2_` prefix):**
  - **`full`:** planner grounding and gap replanning are both on.
  - **`baseline`:** both are off.
  - The v1 code still had model-authored `dependsOn` and no argument domains.
- **Variants, v2 (follow-up; `run-matrix-v2.sh`, files prefixed `v2_`):** each switch is changed independently against the product configuration.
  - **`product`:** argument domains on; experimental `planGrounding` and `gapReplanning` off.
  - **`pgOn`:** turns planner grounding on.
  - **`grOn`:** turns gap replanning on.
  - **`argsOff`:** turns argument domains off.
  - Dependencies are runtime-generated in every v2 run. Models that the memory guard refuses are retried later and never forced.
- **Outcome rules:** two are recorded for every run. The **product rule** is fail-closed: `completed` needs deterministic grounding and coverage, plus the model's agreement. The **legacy rule** lets the model's assessment alone establish `completed`.
- **Structured-output ablation:** `--structured off` drops the JSON schema (json_object mode only).
- **Decoding:** temperature 0, context 4096, one slot, llama.cpp b11720 (`win-vulkan-x64`).
- **Resources:** a PowerShell sampler (about every 1–2 s) records llama-server working set, system CPU %, available RAM, the maximum GPU engine utilisation of the llama-server process, and any non-loopback TCP connection of the Node and llama-server processes.
- **Network:** an in-process socket guard blocks and records any non-loopback connection.
- **Memory guard:** the 3B configuration goes through the normal supervisor admission check. If it's refused, the refusal is recorded; the guard is never overridden.

## Threats to validity
- **Small suite:** n = 36 per configuration, so the intervals are wide. The report shows 95% Wilson intervals.
- **Narrow tools:** there are only four read-only tools. Real D-ASK requests will be broader, and so will the share of requests the detectors can't ground. The paraphrase category is the proxy for that.
- **Same author:** one person wrote the detectors, the tasks and the oracle. Separating the oracle's code limits, but doesn't remove, shared assumptions about phrasing.
- **Determinism:** with temperature 0, runs are close to deterministic. One configuration is repeated to check this.
- **Background load:** system CPU % and available RAM include whatever else was running on the machine.
