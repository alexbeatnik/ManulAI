---
name: debug-agent-run
description: Run scripts/debug-agent.mjs against the full validated Ollama baseline (phi4-mini:3.8b, llama3.1:8b, gemma4:latest, gemma4:31b, qwen3-coder:30b) for a single user prompt. Collects pass/fail per model and reports JSONL log paths. Use this for regression testing after any change to the agent loop, recovery/nudge logic, mandate, or tool handlers.
---

# debug-agent-run

Regression-test a prompt against every model in the validated baseline so you can see at a glance which tiers still work after a change.

## When to invoke

- After any fix in `scripts/debug-agent.mjs` or `src/ManulAiChatProvider.ts` that affects the agent loop, tool execution, recovery, nudges, or mandate.
- When the user asks to "test this across models" / "прогони на моделях" / "перевір на всіх моделях".
- When validating a new bug reproducer before claiming the fix works.

## Inputs

The user's prompt for the agent, passed as `args`. Example:

```
/debug-agent-run Create file sandbox/hello.py that prints 'hi'
```

If `args` is empty, ask the user for a prompt — do not pick one silently.

## Baseline models (from CLAUDE.md)

Run in order from fastest to slowest so the first signal comes quickly:

1. `phi4-mini:3.8b` — known weak on native tool calls; fails are expected but non-corrupting failures are the bar.
2. `llama3.1:8b` — baseline medium.
3. `gemma4:latest` — uses text-tools fallback (`useTextTools: true`).
4. `qwen3-coder:30b` — large, slow, usually reliable.
5. `gemma4:31b` — largest, slowest, text-tools.

Do NOT skip models — part of the value is the diff between tiers.

## Execution rules

- `DRY_RUN=false` by default so the user can inspect real file writes. Only use `DRY_RUN=true` if the user explicitly asks for simulation.
- `MAX_TURNS=8` for simple prompts; bump to `12` if the task is multi-file or refactor.
- Wrap each run in `timeout` with generous values: 240s for phi4/llama, 360s for gemma4:latest, 600s for qwen3-coder:30b, 900s for gemma4:31b. Ollama cold starts on large models are slow.
- Run large models (qwen3-coder:30b, gemma4:31b) in the background via `Bash(run_in_background=true)` and poll with `TaskOutput` so the foreground stays responsive.
- Log files go to `.manulai/logs/debug-<timestamp>.jsonl` by default — note the path per model in the final report.
- For prompts that write files, create per-model sandbox dirs under `.manulai/debug-sandbox/<task-label>-<model-slug>/` so runs do not stomp on each other.

## Template command

```bash
MANUL_MODEL=<model> DRY_RUN=false MAX_TURNS=8 timeout <sec> \
  node scripts/debug-agent.mjs "<prompt>" 2>&1 | tail -25
```

Use `tail -25` to keep the transcript short in your context window — the full log is on disk.

## Reporting

Return a single compact table the user can read at a glance:

| Model | Result | Turns | Log |
|---|---|---|---|
| phi4-mini:3.8b | ✓ / ❌ / ⚠ loop | N | `.manulai/logs/debug-...jsonl` |
| ... | ... | ... | ... |

Then a one-line summary per failure: what went wrong, which bug pattern it matches (e.g. "hallucinated wrong path", "markdown-JSON tool call instead of native", "repetitive loop recovered").

If any **new** failure mode appears that does not match a known bug pattern documented in `README-dev.md` Release Notes, flag it explicitly — that's the signal to open a fix cycle.

## What NOT to do

- Do not claim success just because a file exists. Read the file content and confirm it matches what the prompt asked for (phi4 in particular writes `content="print('A')"` instead of `print('A')` — that is a fail even if the file was created).
- Do not rerun a failed model without changing something. If the code hasn't changed, the result won't change.
- Do not skip `gemma4:31b` "to save time" — its text-tools path exercises code that smaller gemma4:latest runs also hit but with different timing, and the slowest model often exposes race conditions the fast ones miss.
