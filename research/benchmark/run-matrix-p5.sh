#!/usr/bin/env bash
# Phase 5: capability check on vs off, real local models. Never forces a model; refusals are retried, then recorded.
set -u
cd "$(dirname "$0")/../.."
R="npx tsx research/benchmark/run.ts"; OUT=research/benchmark/results
admitted() { node -e "process.exit(require(\"./$OUT/\"+process.argv[1]+\".json\").admitted?0:1)" "$1" 2>/dev/null; }
run() { local tag=$1 tries=$2; shift 2; for ((i=0;i<=tries;i++)); do $R "$@" --suite all --tag "$tag"; admitted "$tag" && return 0; (( i<tries )) && sleep 60; done; echo "[matrix] $tag NOT ADMITTED"; }
H=qwen2.5-0.5b-instruct-q4_k_m; T=qwen2.5-3b-instruct-q4_k_m
run p5_0.5b_capOff 10 --model $H --backend vulkan --cap off
run p5_0.5b_capOn 10 --model $H --backend vulkan --cap on
run p5_3b_capOff 5 --model $T --backend vulkan --cap off
run p5_3b_capOn 5 --model $T --backend vulkan --cap on
echo MATRIX DONE
