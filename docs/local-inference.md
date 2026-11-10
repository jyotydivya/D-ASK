# Local inference (offline-first AI brain)

Status as of 2026-11-03:
- **Phases 1–3:** implemented. Offline isolation was verified with Wi-Fi disabled.
- **Phase 4 and its follow-up:** the benchmark is in `research/benchmark/`.
- **Phase 5:** the stdio agent host and daemon integration are implemented; see [phase-5-report.md](phase-5-report.md) and [agent-host-protocol.md](agent-host-protocol.md).
- **Phase 6:** the HUD's interface is connected to the agent, and a packaged Release build exists; see [phase-6-report.md](phase-6-report.md).
- **Phase 7A:** read-only filesystem tools (search, metadata, read, find_text) over the workspace and approved folders; see [phase-7a-report.md](phase-7a-report.md).

In the desktop stack the .NET daemon owns the agent host, and the host's supervisor owns `llama-server`. Build the host with `npm run build:agent-host`, or the whole package with `node scripts/package/build-package.mjs`. Experimental switches, both off by default: `AgentHost:ExperimentalCapabilityCheck` and `AgentHost:ExperimentalModelTiers`.

## Architecture

```
AgentRuntime ─▶ Brain ─▶ LanguageModel
                           └─ SelectedLanguageModel        agent/runtime/inference/index.ts
                                ├─ local (default) ─▶ LlamaServerModel ─▶ InferenceSupervisor ─▶ llama-server ─▶ GGUF
                                └─ cloud (only DASK_INFERENCE=cloud) ─▶ cloudModel.ts ─▶ agent/modelRouter.ts
```

- **Single model owner:** `llama-server` is the only process that loads a model for agent inference. The .NET daemon keeps its own inference path for its existing uses. It is not called by the agent runtime.
- **No fallback** in either direction between local and cloud.

| File | Role |
|---|---|
| `agent/runtime/inference/schemas.ts` | Output schemas generated from the registered tools (one `const`-keyed step variant per usable tool) |
| `agent/runtime/inference/llamaServerModel.ts` | HTTP adapter: loopback only, bearer key, schema-constrained output, timeout, cancellation and size cap |
| `agent/runtime/inference/supervisor.ts` | Hash verification, memory admission, launch, readiness, auth self-check, restarts, Vulkan→CPU fallback, idle unload, shutdown |
| `agent/runtime/inference/memory.ts` | Memory estimate: weights + KV cache + compute + overhead, with the daemon's 2000 MB headroom |
| `agent/runtime/inference/policy.ts` | `DASK_INFERENCE`: unset or `local` means local; `cloud` is explicit opt-in; anything else means local |
| `agent/runtime/inference/artifacts.json` | Pinned runtime and model manifest, with SHA-256 of every file |
| `scripts/inference/fetch-llama-server.mjs` | The only downloader. It runs only when invoked explicitly and never downloads models. |

## Pinned artifacts

| Artifact | Value |
|---|---|
| Runtime | llama.cpp **b11720** (commit `0878f7c3`), `win-vulkan-x64`, published 2026-10-18 |
| Archive SHA-256 | `065723b20985e2228de044b7f675f7b512dd0be1fb5bb7093b8ad62e7b83557d` (GitHub release asset digest) |
| Installed to | `local-inference/llama.cpp/b11720-win-vulkan-x64/` (gitignored). All 52 files are hash-pinned. |
| Model (integration) | `models/qwen2.5-0.5b-instruct-q4_k_m.gguf`, SHA-256 `74a4da8c…a9db`, equal to Hugging Face's published LFS hash |
| Model (Phase 4) | `models/qwen2.5-3b-instruct-q4_k_m.gguf`, SHA-256 `626b4a66…c62d`, equal to Hugging Face's published LFS hash |

- **Install:** `node scripts/inference/fetch-llama-server.mjs`
- **Re-verify:** `node scripts/inference/fetch-llama-server.mjs --verify`

## Settings
All are optional environment variables.

| Variable | Default | Meaning |
|---|---|---|
| `DASK_INFERENCE` | `local` | `cloud` re-enables the legacy hosted stack (explicit opt-in) |
| `DASK_LOCAL_MODEL` | `qwen2.5-0.5b-instruct-q4_k_m` | Model id from `artifacts.json` |
| `DASK_LOCAL_BACKEND` | `auto` | `auto` (Vulkan, falls back to CPU), `vulkan` or `cpu` |
| `DASK_LOCAL_CTX` | `4096` | Context size in tokens |
| `DASK_LOCAL_IDLE_MS` | `300000` | Idle unload delay; `0` means never |

## Security properties

**How llama-server is launched**
- **Address:** it listens on `127.0.0.1`, on a random port.
- **Settings:** launched with `--offline --no-webui --no-slots --fit off --cache-ram 0` and an explicit device.
- **Clean environment:** inherited `LLAMA_*`, `HF_*` and `GGML_*` variables are stripped before launch.

**API key**
- **Per launch:** the server is started with a fresh 256-bit key.
- **How it's passed:** through the `LLAMA_API_KEY` environment variable, never on the command line.
- **Never exposed:** it never appears in logs, status or errors (server echoes are redacted).
- **Fail closed:** the supervisor refuses to serve unless an unauthenticated request is rejected with 401.

**Requests**
- **Loopback only:** the adapter accepts only `127.0.0.0/8` and `[::1]` with an explicit port. It refuses `localhost`, credentials, paths and redirects.

**Before every launch**
- **Hashes:** the SHA-256 of all 52 runtime files and of the model is checked. The model's hash is cached by size and mtime for the life of the process.
- **Memory:** the admission check uses the same `ullAvailPhys` figure as the daemon (through `os.freemem()`). Its 2000 MB headroom cannot be lowered.

**Trust in model output**
- Model output is untrusted even when it matches the schema.
- `Planner.check()` validates registration, permissions, input schema, step ids, dependencies and the step limit.
- The verifier caps outcomes based on the evidence.

## Measured results
Measured on this machine (i5-1335U, 15.7 GB, Iris Xe), with the 0.5B model and a 4096-token context.

| | Vulkan | CPU |
|---|---|---|
| Start (hash check + load + auth self-check) | 3.3–9.4 s | 1.6–2.3 s |
| Plan generation (planner prompt, schema-constrained) | 3.2–4.7 s | 8.9–9.2 s |
| llama-server working set / private bytes | 706–731 / 751–765 MB | 588 / 260–262 MB |
| GPU shared memory (Windows counter) | 574 MB | 0 MB |
| Supervisor memory estimate | 973 MB | 973 MB |
| Single-step task through `POST /api/tasks` | ~6 s | not run |

## Completion verification and planning rules (Phase 4 and follow-up)

**Completion is fail-closed and always on.** A task is `completed` only when all of the following hold:
- **Steps:** every step succeeded.
- **Grounding:** every step is grounded in the request text.
- **Coverage:** every request part detected deterministically is covered by real tool output.
- **Model:** the model's assessment also agrees. The model can only downgrade a result, never certify its own success.

Anything short of that is `unverified` or `partial`. The deterministic checks are in [grounding.ts](../agent/runtime/grounding.ts) and [requestChecks.ts](../agent/runtime/tools/requestChecks.ts).

**Arguments come from the request** (product default `argumentConstraints: true`). Where the request text determines an argument, the runtime derives the allowed values and enforces them in three places: the output grammar, plan validation, and a hard check before each tool call. The model is never trusted to invent them.

| Tool | Argument | Rule |
|---|---|---|
| `math.evaluate` | `expression` | Must be one of the expressions written in the request, verbatim. Whitespace is ignored; parentheses and precedence are preserved. |
| `system.time` | `timeZone` | Forbidden when no zone or city is named, so local time is used. Otherwise required, and restricted to the named IANA zones. |
| `workspace.list_dir` | `path` | Restricted to the folders named in the request. |

**Dependencies are generated by the runtime.**
- **Sequential order:** steps run in the listed order, and a failed step stops the steps after it.
- **No `dependsOn` from the model:** it's absent from the model's schema.
- **Bad references rejected explicitly:** a self, forward, cyclic or unknown `dependsOn` from an unconstrained model, or an input that references another step's result, is rejected. It is never silently dropped.

**Experimental switches** sit under `RuntimeConfig.experimental` and are both **off** by default:

| Switch | Effect |
|---|---|
| `planGrounding` | Rejects contradicted steps and spends the repair round on them |
| `gapReplanning` | Uncovered request parts trigger a follow-up round |

They're evaluated independently in `research/benchmark/`.

## Known limitations

**Resolved since Phase 1–3**
- **Self-dependency:** the model can no longer write `dependsOn`; see "Completion verification and planning rules" above.
- **Wrong answer accepted:** `17+25*2` completed for "(17+25)\*2". Fixed by argument domains plus fail-closed completion.

**Verified**
- **Offline isolation:** the user ran `--require-offline` with Wi-Fi disabled on 2026-11-02 and all assertions passed.
- **Desktop path offline:** on 2026-11-06 the user ran the Phase 5 live test once with Wi-Fi disabled: daemon, agent host, local model, tool and independent verification. 2 of 2 passed, with no non-loopback connections. See [phase-6-report.md](phase-6-report.md).

**Limits of the deterministic checks**
- **Paraphrased requests:** requests the checks don't understand, such as "hours in a week", end at most as `unverified`.
- **Mixed arithmetic:** a request mixing written arithmetic with paraphrased arithmetic can't serve the paraphrased part, because the expression is restricted to the written ones.

**Resolved in Phases 5 and 6**
- **Orphan cleanup:** one Windows Job Object per host instance ends the host and `llama-server` with the daemon.
- **Duplicate model copies:** direct daemon inference is refused while the agent owns the model.

**Still missing**
- **Code signing:** the package check catches corruption and changed files, but someone who can also rewrite the daemon and its settings can defeat it. See [phase-6-report.md](phase-6-report.md).
