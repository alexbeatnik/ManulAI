#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT_DIR/.manulai/logs/smoke-model-profiles"
mkdir -p "$LOG_DIR"

run_case() {
  local case_name="$1"
  local model="$2"
  local mode="$3"
  local prompt="$4"
  local turns="$5"

  local slug
  slug="$(printf '%s' "$case_name" | tr '[:upper:]' '[:lower:]' | tr ' /:' '---')"
  local log_file="$LOG_DIR/${slug}.jsonl"
  local out_file="$LOG_DIR/${slug}.out"

  echo "== $case_name =="
  echo "model=$model mode=$mode log=$log_file"

  (
    cd "$ROOT_DIR"
    env \
      MANUL_MODEL="$model" \
      MANUL_MODE="$mode" \
      DRY_RUN=true \
      MAX_TURNS="$turns" \
      LOG_FILE="$log_file" \
      node scripts/debug-agent.mjs "$prompt"
  ) | tee "$out_file"

  echo
}

run_case \
  "planner-0.5b-read" \
  "qwen2.5-coder:0.5b" \
  "planner" \
  "Read package.json and answer with the extension name and version only. Use tools if needed." \
  "4"

run_case \
  "agent-0.5b-dry-write" \
  "qwen2.5-coder:0.5b" \
  "agent" \
  "Create src/debug-lab/smoke/hello.ts exporting function smokeHello(): string { return 'hello'; }. Do not modify any other file." \
  "5"

run_case \
  "planner-1.5b-read" \
  "qwen2.5-coder:1.5b" \
  "planner" \
  "Read package.json and answer with the extension name and version only. Use tools if needed." \
  "4"

run_case \
  "agent-1.5b-dry-write" \
  "qwen2.5-coder:1.5b" \
  "agent" \
  "Create src/debug-lab/smoke/hello.ts exporting function smokeHello(): string { return 'hello'; }. Do not modify any other file." \
  "5"

run_case \
  "planner-3.8b-read" \
  "phi4-mini:3.8b" \
  "planner" \
  "Read package.json and answer with the extension name and version only. Use tools if needed." \
  "4"

run_case \
  "agent-3.8b-dry-write" \
  "phi4-mini:3.8b" \
  "agent" \
  "Create src/debug-lab/smoke/hello.ts exporting function smokeHello(): string { return 'hello'; }. Do not modify any other file." \
  "5"

run_case \
  "planner-7b-read" \
  "qwen2.5-coder:7b" \
  "planner" \
  "Read package.json and answer with the extension name and version only. Use tools if needed." \
  "4"

run_case \
  "agent-7b-dry-write" \
  "qwen2.5-coder:7b" \
  "agent" \
  "Create src/debug-lab/smoke/hello.ts exporting function smokeHello(): string { return 'hello'; }. Do not modify any other file." \
  "5"

echo "Smoke runs complete. Outputs saved under $LOG_DIR"