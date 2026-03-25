#!/usr/bin/env bash
# Test debug-agent.mjs across multiple models and scenarios.
# Results are saved to .manulai/test-results/
#
# Usage:  bash scripts/test-models.sh
# Env:    DRY_RUN=true (default) — simulates writes. Set to false for real writes.

set -euo pipefail
cd "$(dirname "$0")/.."

DRY_RUN="${DRY_RUN:-true}"
RESULTS_DIR=".manulai/test-results"
mkdir -p "$RESULTS_DIR"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

# ── Models to test (ordered small → large) ──────────────────────────────────
MODELS=(
  "qwen2.5-coder:7b"
  "qwen2.5-coder:14b"
  "qwen2.5-coder:32b"
  "qwen3-coder:30b"
  "glm-4.7-flash"
  "gemma3n:e4b"
)

# ── Scenarios ────────────────────────────────────────────────────────────────
# Each scenario: NAME|MAX_TURNS|TARGET|PROMPT
SCENARIOS=(
  'greenfield|8||Create a simple calculator web app with HTML, CSS, and JavaScript. It should support add, subtract, multiply, divide. Create all 3 files: index.html, style.css, and app.js in src/debug-lab/calculator/'
  'edit-existing|6|src/debug-lab/polyglot/go-fixture/main.go|Read the Go file and add a fibonacci function that computes the Nth fibonacci number using iteration. Write the updated file.'
  'summarize|4|src/debug-lab/SandboxTarget.ts|Read the first 200 lines of this TypeScript file and provide a concise summary of what the code does, what classes and interfaces it defines, and the overall architecture.'
  'split-refactor|10|src/debug-lab/SandboxTarget.ts|Split this large TypeScript file into smaller modules. Extract the first group of interfaces and types (roughly lines 1-120) into a new file called src/debug-lab/SandboxTypes2.ts, then update the original file to import from it.'
)

pass=0
fail=0
skip=0
total=0

summary_file="$RESULTS_DIR/summary-$TIMESTAMP.md"
echo "# Model Test Results — $TIMESTAMP" > "$summary_file"
echo "" >> "$summary_file"
echo "| Model | Scenario | Turns | Tool Calls | Files Written | Result |" >> "$summary_file"
echo "|-------|----------|-------|------------|---------------|--------|" >> "$summary_file"

for model in "${MODELS[@]}"; do
  for scenario_str in "${SCENARIOS[@]}"; do
    IFS='|' read -r scenario_name max_turns target prompt <<< "$scenario_str"
    total=$((total + 1))

    # Build short ID for log file
    model_short="${model//:/_}"
    model_short="${model_short//./}"
    log_name="${model_short}__${scenario_name}"
    out_file="$RESULTS_DIR/${log_name}-${TIMESTAMP}.log"

    echo ""
    echo "═══════════════════════════════════════════════════════════════"
    echo "  Model: $model | Scenario: $scenario_name | MaxTurns: $max_turns"
    echo "═══════════════════════════════════════════════════════════════"

    # Build command
    cmd="DRY_RUN=$DRY_RUN MAX_TURNS=$max_turns MANUL_MODEL=$model"
    if [ -n "$target" ]; then
      cmd="$cmd node scripts/debug-agent.mjs --target $target"
    else
      cmd="$cmd node scripts/debug-agent.mjs"
    fi
    cmd="$cmd \"$prompt\""

    echo "  CMD: $cmd"
    echo "  Log: $out_file"
    echo ""

    # Run with timeout (5 min per test)
    set +e
    timeout 300 bash -c "$cmd" > "$out_file" 2>&1
    exit_code=$?
    set -e

    if [ $exit_code -eq 124 ]; then
      echo "  ⏰ TIMEOUT (5 min)"
      result="TIMEOUT"
      skip=$((skip + 1))
    elif [ $exit_code -ne 0 ]; then
      echo "  ❌ FAILED (exit $exit_code)"
      result="FAIL"
      fail=$((fail + 1))
    else
      result="OK"
      pass=$((pass + 1))
    fi

    # Extract stats from log
    turns=$(grep -c '^\[TURN ' "$out_file" 2>/dev/null || echo "0")
    tool_calls=$(grep -c '^\[TOOL CALLS\]' "$out_file" 2>/dev/null || echo "0")
    files_written=$(grep -c '^\[.*write\]' "$out_file" 2>/dev/null || echo "0")
    # Check for DRY-RUN writes too
    dry_writes=$(grep -c 'DRY-RUN write' "$out_file" 2>/dev/null || echo "0")
    files_written=$((files_written + dry_writes))

    # Check for specific failure patterns
    if grep -q 'OLLAMA ERROR' "$out_file" 2>/dev/null; then
      result="OLLAMA_ERROR"
      if [ "$result" != "TIMEOUT" ]; then
        fail=$((fail + 1))
        pass=$((pass - 1))
      fi
    fi

    echo "  Turns: $turns | Tool Calls: $tool_calls | Files Written: $files_written | Result: $result"

    # Append to summary
    echo "| $model | $scenario_name | $turns | $tool_calls | $files_written | $result |" >> "$summary_file"

    # Show last few lines of output for quick review
    echo "  --- Last 5 lines ---"
    tail -5 "$out_file" | sed 's/^/  /'
    echo ""
  done
done

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  TOTAL: $total | PASS: $pass | FAIL: $fail | SKIP/TIMEOUT: $skip"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "Totals: $total tests — $pass pass, $fail fail, $skip timeout" >> "$summary_file"
echo ""
echo "Summary saved to: $summary_file"
echo "Individual logs in: $RESULTS_DIR/"
