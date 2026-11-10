#!/usr/bin/env bash
# Phase 4 benchmark matrix. Runs sequentially (one model loaded at a time).
set -u
cd "$(dirname "$0")/../.."
R="npx tsx research/benchmark/run.ts"
H=qwen2.5-0.5b-instruct-q4_k_m; O=qwen2.5-1.5b-instruct-q4_k_m; T=qwen2.5-3b-instruct-q4_k_m
$R --model $H --backend vulkan --variant full
$R --model $H --backend vulkan --variant baseline
$R --model $O --backend vulkan --variant full
$R --model $O --backend vulkan --variant baseline
$R --model $H --backend cpu --variant full
$R --model $O --backend cpu --variant full
$R --model $H --backend vulkan --variant full --structured off
$R --model $O --backend vulkan --variant full --structured off
$R --model $T --backend vulkan --variant full
$R --model $O --backend vulkan --variant full --tag ${O}_vulkan_full_rep2
echo MATRIX DONE
