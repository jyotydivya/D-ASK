# D-ASK: build, run, configure

Native Windows 11 assistant. No Electron: it is not a dependency (removed from `package.json` 2026-11-13; the Electron-only `main.js` was deleted) and the package build fails if any Electron file would be included. Core operation is offline: local llama.cpp inference, local speech, local OCR, local memory.

## Requirements

| Item | Version / note |
|---|---|
| OS | Windows 11 x64 (target: i5-1335U, 16 GB RAM, Iris Xe) |
| .NET SDK | 8.x (daemon) |
| Rust | stable, MSVC toolchain (native HUD, WebView2) |
| Node.js | 24.x for development (the package ships its own pinned Node) |
| WebView2 runtime | present on Windows 11 |
| RAM | the local model is admitted only with about 2,973 MB available with the HUD running (guard, unchanged) |

## Build from source

```powershell
npm install
npm run build:agent-host          # TypeScript agent host -> dist/agent-host
npm run build                     # HUD frontend (Next, webpack) -> .next
dotnet build src/DAsk.Daemon -c Debug
cargo build --manifest-path src/hud-native/Cargo.toml     # add --release for the package
node scripts/inference/fetch-model.mjs      # pinned local GGUF model(s), hash-checked
node scripts/inference/fetch-llama-server.mjs
node scripts/inference/fetch-whisper.mjs    # optional: better offline speech recognition
```

Run the development stack (real daemon + real HUD): `scripts\hud\start-stack.ps1 -OutDir <folder>` (stop: `stop-stack.ps1 -OutDir <folder>`).

## Native package (the distributable)

```powershell
node scripts/package/build-package.mjs        # Release daemon + HUD, frontend, agent host, pinned Node, llama-server, models, whisper, hash manifest
node scripts/package/build-package.mjs --verify --out dist\desktop\<package>
powershell -File scripts\package\verify-package.ps1 -PackageRoot <throwaway copy of the package> -OutDir results\packaging\verify-<stamp>   # real launcher + real HUD + tamper checks (it edits and restores files, so use a copy)
powershell -File dist\desktop\<package>\Install-D-ASK.ps1       # per-user install, no admin, Start Menu shortcut
```

The daemon verifies every host file, the Node runtime and the plugin sandbox against `package-manifest.json` before each agent-host start; a changed file stops the host with the reason shown in the HUD.
Uninstall: `Uninstall-D-ASK.ps1` (keeps `%LOCALAPPDATA%\D-ASK` unless `-RemoveData`).

## Configuration and data

- All features default to OFF in `appsettings.json` and in code. Turn features on for the packaged app with a user-owned file `%LOCALAPPDATA%\D-ASK\features.cmd` (copy `features.example.cmd` from the package). `Start-D-ASK.cmd` calls it if it exists. Any `AgentHost` option can also be set as an environment variable `DASK_AgentHost__<Option>=...`.
- Approvals, the daemon-owned policy, the execution latch and Emergency Stop (Ctrl+Shift+F12, or the HUD's STOP) apply to every feature; the switches only decide which tools are offered.
- Data: `%LOCALAPPDATA%\D-ASK` (workflows.json, plugins-approved.json, memory.db, notes default folder is under Documents\D-ASK Notes, logs `hud.log`).
- Local memory: works from the source tree. It is **not** available in the package yet (`better-sqlite3` is not shipped there).
- Memory controls (user, not agent): `npx tsx agent/runtime/memory/memoryCli.ts list | search <words> | export <file> | forget <id> | clear --yes`.
- Isolated test database: `DASK_MEMORY_DB` (absolute path) via `AgentHost:ExtraEnvironment`.

### Knowledge (local RAG) and Research Mode

On by default in the agent host (`DASK_AGENT_KNOWLEDGE=0` turns it off). Nothing leaves the computer.
- Embedding model: `models\bge-small-en-v1.5-q8_0.gguf` (BAAI bge-small-en-v1.5, MIT licence, 36,806,944 bytes, SHA-256 `ec38e8da…2f514`, pinned in `agent/runtime/knowledge/embedder.ts`). Served by the pinned `llama-server` in embedding mode on loopback with a per-launch key; started on first use (~75 MB), stopped after 90 s idle; needs 400 MB free. Missing or mismatched model: search is keyword-only and says so. Source: `https://huggingface.co/CompendiumLabs/bge-small-en-v1.5-gguf`.
- Index: `%LOCALAPPDATA%\D-ASK\knowledge.db` (`DASK_KNOWLEDGE_DB` overrides). Separate from `memory.db`.
- Folders that may be indexed: the workspace, `DASK_FS_ROOTS`, and `DASK_KNOWLEDGE_ROOTS` (`;`-separated; the product profile sets `%USERPROFILE%\Documents`). Drives, Windows, Program Files and the whole profile are refused.
- Research reports: `Documents\D-ASK\Research\<project>\report.md` (+ `report-vN.md`, `evidence-vN.json`, `project.json`); `DASK_RESEARCH_DIR` overrides.
- Requests (typed, spoken, workflow steps or scheduled; also the MANAGE panel's KNOWLEDGE and RESEARCH tabs):
  `index D:\Papers as research` · `index the codebase` · `refresh research` · `list my knowledge collections` · `list documents in research` · `remove the collection research` · `remove D:\Papers\old.pdf from my knowledge` ·
  `search my papers for graph attention` · `According to my documents, when is the release?` · `How does the approval registry work in this codebase?` ·
  `Prepare a literature review about graph neural networks from my research papers` · `Write a gap analysis on X` · `list research projects` · `resume research <name>` · `show research report <name>`.

## Tests

```powershell
npx tsc --noEmit -p tsconfig.json
foreach ($t in 'agent-runtime','workflows','workflow-fixes','workflow-intent','workflow-routing','desktop','grounding','filesystem','file-organize','notes','plugins','memory','browser','browser-actions','knowledge') { npx tsx tests/agent-runtime/$t.test.ts }
npx tsx tests/hud-agent/native-agent.test.ts
dotnet test tests/DAsk.Daemon.Tests
cargo test --manifest-path src/hud-native/Cargo.toml
```

Real-HUD acceptance harnesses (they type into the real HUD and click the real approval cards; run them in the background; each needs a NEW, empty `-OutDir`):
`scripts\hud\approval-live-7b3.ps1` (core), `approval-live-input.ps1`, `approval-live-multistep.ps1`, `approval-live-browser.ps1`, `approval-live-features.ps1`, `approval-live-notes.ps1`, `approval-live-summarize.ps1`, `approval-live-nl.ps1 [-Focused]`, `approval-live-timed.ps1`, `approval-live-memory.ps1`.
Wi-Fi-off wrapper: `scripts\hud\run-offline-acceptance-7b3.ps1 -AcceptanceScript <offline-*-acceptance.ps1>` (switches the radio off, confirms, monitors the D-ASK process tree for non-loopback connections, restores the radio).
