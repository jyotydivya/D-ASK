#!/usr/bin/env bash
# Final-code (v3: + whole-request explanation) product configuration per model.
# Same guard-respecting retry as v2; never overwrites earlier result files.
set -u
cd "$(dirname "$0")/../.."
R="npx tsx research/benchmark/run.ts"; OUT=research/benchmark/results
admitted() { node -e "process.exit(require('./$OUT/'+process.argv[1]+'.json').admitted?0:1)" "$1" 2>/dev/null; }
run_until_admitted() { local tag=$1 tries=$2; shift 2
  for ((i=0; i<=tries; i++)); do $R "$@" --tag "$tag"; admitted "$tag" && return 0
    (( i < tries )) && { echo "[matrix] $tag not admitted; waiting 60 s"; sleep 60; }; done; echo "[matrix] $tag NOT ADMITTED"; }
for M in qwen2.5-0.5b-instruct-q4_k_m qwen2.5-1.5b-instruct-q4_k_m; do run_until_admitted v3_${M}_vulkan_product 20 --model $M --backend vulkan; done
run_until_admitted v3_qwen2.5-3b-instruct-q4_k_m_vulkan_product 5 --model qwen2.5-3b-instruct-q4_k_m --backend vulkan
echo MATRIX DONE
