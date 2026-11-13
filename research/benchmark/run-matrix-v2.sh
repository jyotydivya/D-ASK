#!/usr/bin/env bash
# Phase 4 follow-up (v2 code) benchmark matrix. Sequential: one model loaded at a time.
# Never forces a model: if the supervisor's memory guard refuses, the run is retried
# later (1.5B only, every 60 s for up to 40 min) and otherwise recorded as not admitted.
# Writes v2_* result files only; Phase 4 (v1) results are never overwritten.
set -u
cd "$(dirname "$0")/../.."
R="npx tsx research/benchmark/run.ts"
H=qwen2.5-0.5b-instruct-q4_k_m; O=qwen2.5-1.5b-instruct-q4_k_m; T=qwen2.5-3b-instruct-q4_k_m
OUT=research/benchmark/results

admitted() { node -e "process.exit(require('./$OUT/'+process.argv[1]+'.json').admitted?0:1)" "$1" 2>/dev/null; }

# run_until_admitted <tag> <retries> <args...>
run_until_admitted() {
  local tag=$1 tries=$2; shift 2
  for ((i=0; i<=tries; i++)); do
    $R "$@" --tag "$tag"
    if admitted "$tag"; then return 0; fi
    if (( i < tries )); then echo "[matrix] $tag not admitted; waiting 60 s ($((i+1))/$tries)"; sleep 60; fi
  done
  echo "[matrix] $tag NOT ADMITTED after retries"
}

for M in $H $O; do
  N=$([ "$M" = "$O" ] && echo 40 || echo 3)
  run_until_admitted v2_${M}_vulkan_product        $N --model $M --backend vulkan
  run_until_admitted v2_${M}_vulkan_pgOn           $N --model $M --backend vulkan --pg on
  run_until_admitted v2_${M}_vulkan_grOn           $N --model $M --backend vulkan --gr on
  run_until_admitted v2_${M}_vulkan_argsOff        $N --model $M --backend vulkan --args off
done
run_until_admitted v2_${O}_vulkan_product_rep2     40 --model $O --backend vulkan
run_until_admitted v2_${H}_cpu_product             3  --model $H --backend cpu
run_until_admitted v2_${O}_cpu_product             40 --model $O --backend cpu
run_until_admitted v2_${H}_vulkan_product_unstructured 3 --model $H --backend vulkan --structured off
run_until_admitted v2_${O}_vulkan_product_unstructured 40 --model $O --backend vulkan --structured off
run_until_admitted v2_${T}_vulkan_product          0  --model $T --backend vulkan
echo MATRIX DONE
