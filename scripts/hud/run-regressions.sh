#!/usr/bin/env bash
# Phase 6 regression run. Writes one log per suite and a summary to results/phase6/regression/.
# The earlier offline integration test is deliberately not part of this run.
cd "$(dirname "$0")/../.." || exit 1
OUT=results/phase6/regression
mkdir -p "$OUT"
SUMMARY="$OUT/summary.txt"
: > "$SUMMARY"

run() {
  local name="$1"; shift
  local started=$SECONDS
  "$@" > "$OUT/$name.log" 2>&1
  local code=$?
  local line
  line=$(grep -aE "passed|Passed!|Failed!|test result|Compiled successfully|Error\(s\)" "$OUT/$name.log" | tail -1 | cut -c1-110)
  printf '%-22s exit=%-3s %4ss  %s\n' "$name" "$code" "$((SECONDS - started))" "$line" | tee -a "$SUMMARY"
}

# The test project references the built daemon DLL, so the daemon has to be built first.
run build-daemon     dotnet build src/DAsk.Daemon/DAsk.Daemon.csproj -v q --nologo
run build-tests      dotnet build tests/DAsk.Daemon.Tests/DAsk.Daemon.Tests.csproj -v q --nologo
run build-host       npm run build:agent-host
run build-host-test  npm run build:agent-host-test
run tsc              npx tsc --noEmit -p tsconfig.json
run next-build       npm run build
run hud-agent        npx tsx tests/hud-agent/native-agent.test.ts
run browser          node tests/hud-agent/browser-transport.mjs
run host-protocol    npx tsx tests/agent-host/host-protocol.test.ts
run experimental     npx tsx tests/agent-host/experimental.test.ts
run grounding        npx tsx tests/agent-runtime/grounding.test.ts
run agent-runtime    npx tsx tests/agent-runtime/agent-runtime.test.ts
run local-inference  npx tsx tests/agent-runtime/local-inference.test.ts
run contract         npx tsx tests/agent-runtime/llama-server.contract.ts
run offline-policy   npx tsx tests/agent-runtime/offline.test.ts
run auth             npx tsx tests/security/api-auth.test.ts
run containment      npx tsx tests/containment/phase4b-actuation-containment.test.ts
run python-sidecar   python tests/containment/phase4b-python-sidecar.test.py
run hud-tests        bash -c "cd src/hud-native && cargo test --bin hud-native"
run hud-build        bash -c "cd src/hud-native && cargo build --bin hud-native"
run dotnet-full      dotnet test tests/DAsk.Daemon.Tests/DAsk.Daemon.Tests.csproj --no-build --nologo
echo finished >> "$SUMMARY"
