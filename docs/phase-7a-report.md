# Phase 7A: safe local filesystem intelligence

**Date:** 2026-11-08. **Machine:** i5-1335U, 15.7 GB RAM, Iris Xe. Nothing was staged or committed.

D-ASK can now find files, describe them, read text files (whole, by line range, or by section) and search inside them, all from natural language. It is read-only, runs through the existing runtime, and stays inside folders you allow.

## Architecture reused, nothing replaced

The four tools are ordinary `ToolSpec`s in the existing `ToolRegistry`. Each brings a deterministic `requestCheck`, so the existing pieces apply unchanged:
- argument domains enforced in the output grammar, at plan validation and before every call;
- grounding, request facets and the whole-request vocabulary rule;
- the fail-closed `decideOutcome`.

They are registered in `createDefaultRegistry`, which the stdio host already uses. The daemon, IPC, HUD, inference, memory guard, approvals and Emergency Stop were not changed.

**One planner addition, measured:** `requestToolOffer` (product default on) offers the model only the tools whose request check recognised part of the request. A tool with no detected facet can never be part of a "completed" result, so this removes only options that could at best end "unverified".
- **Before the correction pass:** when no check recognised anything, every tool was offered. Without the offer at all, the larger tool menu cut the default 0.5B model's score on the existing Phase 4 suite from 22/36 to 12/36; with it, the score was 19/36.
- **After the correction pass:** when nothing is recognised, the model is offered every tool that could concern the request, and never a tool whose required argument the request forbids. The 0.5B score is now 24/36 (see "Correction pass" below).

## Tools and boundaries

| Tool | Inputs | Returns |
|---|---|---|
| `filesystem.search` | `query` (all words must be in the name), `extension`, `path`, `recursive`, `sort` (`name` or `modified`), `maxResults` (≤ 200) | Path, root, size, created and modified time for each file, in deterministic order |
| `filesystem.metadata` | `path` (or a unique bare file name) | Name, extension, kind, type, size, created and modified time |
| `filesystem.read` | `path`, `startLine`/`endLine`, `heading`, `maxBytes` (≤ 64 KiB) | The exact text, with its line range and section |
| `filesystem.find_text` | `query`, `path`, `extension`, `maxResults` (≤ 200) | Each matching line with its file and line number |

`workspace.list_dir` is unchanged. A separate `filesystem.list` was deliberately not added: it would duplicate `workspace.list_dir`, and the small model is measurably worse with near-duplicate tools.

**Roots:** the workspace (`DASK_WORKSPACE_ROOT`, or the D-ASK folder) plus folders listed in `DASK_FS_ROOTS`. Refused as roots, and reported rather than widened: drives, the Windows folder, Program Files and ProgramData, the whole user profile, relative paths, and missing folders.

**Paths:**
- **Text checks first:** `..`, UNC, `\\?\` and `\\.\` forms, URLs, drive-relative forms, alternate data streams, reserved device names, trailing dots and spaces, wildcards and control characters are all refused.
- **Then the canonical path decides:** the OS resolves the path (junctions, symbolic links and 8.3 names), and the result must still be inside the same root.
- **Walks never follow links:** a walk does not enter a link, junction or other reparse point.

**Never shown, read or searched:**
- folders: `.git`, `node_modules`, `.ssh`, `.aws`, `.gnupg` and similar;
- secret-named files: `.env*`, keys and certificates, `id_rsa`, `.npmrc`, `.netrc`, credential and password stores, `*secret*`, `*token*`;
- in returned text, well-known credential formats are redacted (heuristic).

**Content:**
- **Readable types:** a list of text extensions only. PDF, Office, image and binary files are refused, as is binary content in a text file.
- **Encodings:** UTF-8 (with or without BOM), UTF-16 LE/BE with BOM, and a Windows-1252 fallback.

**Bounds:**

| Bound | Limit |
|---|---|
| Folder depth | 12 |
| Entries visited per walk | 50,000 |
| Largest file `read` opens | 4 MiB |
| Largest file `find_text` scans | 1 MiB |
| Files `find_text` scans | 2,000 |
| Bytes `find_text` reads in total | 64 MiB |
| Tool time limit | 5–15 s |

Cancellation is checked between entries.

**Read-only:** no write, move, delete or execute path exists in these modules.

## Verification

Each tool's postcondition re-reads the filesystem itself:
- listed files must still exist inside a root;
- every reported line must contain the term;
- returned text must equal those lines of the file now.

Completion also needs the request checks:
- **Search:** the extension, name term and sort order must be the ones the request names. "All" fails if the walk stopped early or results were cut; "latest" requires newest-first.
- **Read and metadata:** the path must be a file the request names. When the request names no file, the path is forbidden outright, so no file can be opened at all (see "Which file").
- **Content search:** the search term must be the one the request names, and the scan must have finished. When the request names no term, the term is forbidden.

### Which file: the ambiguous-file policy

D-ASK never chooses a file for you, whether by recency, by listing order or by the model's preference.

| Request | What happens |
|---|---|
| "Read the introduction of this report", "What does the document say?", "Summarize the report…", "Find the latest report and read it", "How big is this file?" | It asks: "Which report do you mean? Please name the file (its file name or path). I won't choose a file for you." Nothing runs and the model is not called. |
| A bare name that matches several files ("Read guide.md") | It lists the candidates and asks: "2 files are named guide.md: data/guide.md, docs/guide.md. Which one do you mean?" No content is shown. |
| An explicit unique name ("Read architecture.md") or path ("Read docs/guide.md") | It reads that file. |
| A file the model picks for a request that names none | Refused at plan validation: the path must be omitted, so the call never runs. |
| A file named in an earlier request | Not reused, because the native host does not pass conversation history to the runtime, so an earlier file cannot be established reliably. It asks instead. |

**How it is enforced:**
- **The question:** asked deterministically from the request text, before planning. It uses the existing `refused` outcome, because adding an outcome would change the IPC protocol. The HUD therefore shows such an answer under its "refused" status, with the question as the text.
- **The real guarantee:** the forbidden path. It holds even when the question's wording detector misses a phrasing.

### Summaries: extraction verified, summary not

- **What the response contains:** the tools' own evidence, never model prose. The model's free-text assessment is never shown.
- **For "Summarize docs/x.md":**
  - The read counts as an extraction request, so it is grounded and its facet is checked against the file.
  - Because no check can confirm a summary, the outcome stays "unverified", and the response says both: "Verified: read docs/x.md (checked against the source by the tools)." and "Not verified: the summary. No check can confirm a summary, so none is given; the text above is the file's own content."
- **When "Verified:" appears:** only when every step succeeded and was grounded and every detected part of the request was shown by a tool result.
  - A truncated read, or the wrong section, never gets it.
  - It does appear when the model's semantic check is unavailable, because it does not depend on the model.
- **What was not added:** a summary-verification algorithm or a second model.

## Test results

| Suite | Result |
|---|---|
| Filesystem tools, security and verification (new, synthetic fixtures) | 143 / 0; **184 / 0** after the correction pass |
| Live, real model (new): 0.5B | 27 / 0 |
| Live, real model (new): 3B | 27 / 0 |
| Release acceptance through the HUD (new) | **12 / 12** |
| Existing: grounding / runtime / host protocol / experimental | 77 / 165 / 81 / 31, all 0 failures |
| Existing: inference / offline / contract / auth / containment / HUD transport | 95 / 23 / 34 / 210 / 58 / 92, all 0 failures |
| Daemon agent-host tests (incl. 2 live) | 47 / 0 |
| Phase 6 walkthrough / overlay suite on the new package | 22 / 22; 22 run + 1 skipped |

**One existing assertion was updated:** "default registry exposes exactly the 4 safe tools" now lists the exact 8. It stays an exact allowlist, and the no-write/spawn/network assertion is unchanged.

**Not tested:**
- **File symbolic links:** creating one needs a privilege this account lacks. Junctions go through the same canonical-path check and were tested.

**Phase 4 suite with the new registry** (36 tasks, temperature 0):

| Model | 4 tools (v3) | 8 tools, all offered | 8 tools, request offer (before correction) | After correction (product) |
|---|---|---|---|---|
| 0.5B | 22 | 12 | 19 | **24** (two identical runs) |
| 3B | 27 | 28 | 28 | **28** |
| Incorrect completion claims | 0 | 0 | 0 | 0 |

See "Correction pass" for the per-task causes.

## Correction pass (2026-11-08)

### The 0.5B regression (22 → 19, now 24)

Per-task classification of the 19/36 run against v3:

| Task | Failure type | Cause |
|---|---|---|
| p01 "How many hours are in a week?", p02 "What is seventeen times three?" | Tool discovery | No check recognised the request, so all 8 tools were offered and the model chose `system.time` |
| p04 "What does the clock say in New York?" | Argument generation | `timeZone` was optional, so the model omitted the named zone and got local time |
| m01 "What time is it and what is 17*3?" | Plan completeness | The correct two tools were offered; the model planned only one |

**Fixes:**
1. **Offer:** when nothing is recognised, file tools are offered only if the request has file wording. A tool whose required argument the request forbids is not offered either. This changes only what the model is offered: validation and verification are untouched, and none of those tools could have reached "completed" for such a request anyway.
2. **`timeZone` is required when the request names a zone.** This is stricter: verification already contradicted a call without it, so the grammar now enforces what verification required.

**Result:**
- **0.5B:** 24/36, the same in two identical runs (all 36 outcomes equal), against v3's 22.
- **Gained:**
  - p04 and m03, both from the required zone;
  - m01 and m06;
  - p02, still "unverified" but counted a success by the harness;
  - p03, kept from the earlier offer change.
- **Lost:** p01 (the model wrote `1 week * 24 hours`, which was rejected).
- **Likely cause of the m01, m06 and p01 changes (inference, not proven per task):** their offered tools did not change. What did change is the planner prompt, which lists argument rules for every registered tool, including the new "omit path" rules for the file tools.
- **3B:** 28/36, unchanged in total. m05 was lost and u05 gained.
- **Both models:** no incorrect completion claims.

**Raw results:** `research/benchmark/results/p7a_fix_*`. No earlier result file was changed.

### Other results after the correction

- **All suites rerun with 0 failures:**
  - grounding 77, runtime 165, host protocol 81, experimental 31;
  - inference 95, offline 23, contract 34, auth 210, containment 58, HUD transport 92;
  - offline integration 15 + 9.
- **The one updated assertion** was "with nothing recognised, every tool is offered". It now asserts the four non-file tools.
- **Live, 0.5B:** 27 / 0. C and E now ask which report. E2 shows the "Verified" and "Not verified" lines.
- **Live, 3B: not rerun.** Twice, the memory guard refused to load the model. In the first attempt, 4,586 MB was available, about 22 MB short of the 2,000 MB headroom. The guard was not changed. C and E still asked without calling the model.
- **Release HUD acceptance: not rerun.** The fix is entirely in the agent runtime and covered above; rerunning needs a package rebuild and real desktop input. The table below is from before the correction. With the fix, C and E now get the clarifying question.

## Release acceptance (HUD, real input, Release package, synthetic project)

| Request | Outcome | Answer |
|---|---|---|
| Find all PDF files in my authorized project directory | completed, verified | `docs/manual.pdf`, `reports/annual-2025.pdf` with sizes and dates |
| Find the latest report and show its metadata | completed, verified | `docs/reports/2026-q3-report.md`, 171 B, modified 2026-10-01 |
| Read the introduction of this report | unverified | Names no file; never completed |
| Read the introduction of docs/reports/2026-q3-report.md | completed, verified | Section "1. Introduction", lines 3–6, exact text |
| Find every occurrence of the term architecture in the project documentation | completed, verified | 4 lines in 3 files, each `file:line: text` |
| Summarize the report using its actual contents | partial | Names no file; the model ran unrelated tools |
| Summarize docs/reports/2026-q3-report.md … | unverified | Shows the real text; no claim that it is a summary |

Other checks in the same run:
- CANCEL during a content search over 3,000 files ended `cancelled` in 0.63 s.
- No D-ASK process opened a non-loopback connection.
- The host started from the hash-verified package (29 files).
- No `.env` or `.pem` content appeared in any answer.
- The logs hold no file contents or request text.

## Offline

**Done:**
- In the live tests, an in-process guard blocked any non-loopback connection; none was attempted.
- The OS TCP table showed none for `llama-server`.
- In the Release run, no D-ASK process had any non-loopback connection.

**Wi-Fi-off run: done once, passed.** On 2026-11-08 at 03:21 the user ran `scripts/hud/offline-phase7a.ps1` with Wi-Fi off. The offline preflight passed, and then:
- **Result:** the live filesystem test reported 27 passed, 0 failed, exit code 0.
- **Network:** stayed offline: True.
- **Evidence:** `results/phase7a/offline-live/` (`preflight-20261108T032112.json`, `live-20261108T032112.json`, `live-20261108T032112.log`). It was not modified or rerun.
- **Scope:** that run was the repository's live test, the agent runtime with the real local model through `llama-server`. It was not the packaged daemon and HUD.
- **Version:** it ran the code from before the correction pass.

## Performance and memory (measured)

| | 0.5B | 3B |
|---|---|---|
| Live filesystem requests, end to end | 3.1–5.5 s | 12–20 s |
| `llama-server` working set | 698 MB | 2,399 MB |

**Tools alone, on 20,000 files in 200 folders:**
- search by extension or name: about 1.0 s for the full walk;
- content search hitting the 2,000-file cap: about 1.5 s;
- a term found early: 10–14 ms;
- reading one file: 1–2 ms;
- resident memory rose by about 3 MB across all runs.

## Known limitations

- **Small-model tool choice:** requests no check recognises can still get an unrelated tool (p01 now does). That ends "unverified" or "failed", never a false "completed". The planner prompt also describes argument rules for tools not offered; trimming that is untested.
- **No cross-task context:** in the native host, "this report" or "the report" cannot be resolved. D-ASK asks which file, and a request must name it.
- **The clarifying question is heuristic:** it detects phrasings like "this/the/that report". A phrasing it misses ("what does it say in the introduction?") gets no question, but the read is still refused because no file is named. The question uses the "refused" outcome.
- **Summaries are never verified:** by design, there is no verified free-text summary. The extraction is verified; the summary is not. Items the model lists as missing are still shown under "Not confirmed:".
- **"Summary" as a section name:** "give me a summary of docs/x.md" asks for a section called Summary, and fails if the file has none. This is unchanged behaviour.
- **Heuristic protections:** redaction and secret-name exclusion are heuristic. For example, a file named `my-secret-santa.md` is hidden, and an unusual credential format is not redacted.
- **Read, then check:** there is a short window between a read and its re-check (time-of-check to time-of-use).
- **File types:** PDF and Office files can be found and described, not read.
- **Absolute paths outside the workspace** work only for roots configured in `DASK_FS_ROOTS`. The daemon has no setting of its own for this; the variable is inherited from its environment.
