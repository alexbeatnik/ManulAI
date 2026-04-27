# Copilot Instructions

Version: 0.0.15

This repository contains a VS Code extension named ManulAI: a local AI coding assistant that talks to a user-supplied Ollama server through the VS Code Chat participant API.

## Architecture (current)

- Entry point: [src/extension.ts](src/extension.ts) — registers the `@manulai` Chat participant and the Settings webview in the Activity Bar.
- Chat participant: [src/copilotChatParticipant.ts](src/copilotChatParticipant.ts) — handles every `@manulai` request, builds the system mandate, streams from Ollama, dispatches tool calls, and surfaces results in the VS Code Chat UI. Slash commands: `/selectModel`, `/model`, `/setAgentMode`, `/toggleAutoApprove`, `/instructions`, `/skills`.
- Tool executor: [src/agentExecutor.ts](src/agentExecutor.ts) — single dispatch table for the agent's tools.
- Ollama streaming: [src/ollamaStreamParser.ts](src/ollamaStreamParser.ts) — NDJSON parser plus `<think>` reasoning extraction.
- Settings panel: [src/settingsPanel.ts](src/settingsPanel.ts) — Activity Bar webview for model/agent-mode/base-URL configuration.
- Workspace context readers: [src/agentInstructionsReader.ts](src/agentInstructionsReader.ts) (AGENTS.md / CLAUDE.md), [src/skillsReader.ts](src/skillsReader.ts) (`.claude/skills/`).
- Model context sizing: [src/modelContextConfig.ts](src/modelContextConfig.ts).
- Standalone test harness: [scripts/debug-agent.mjs](scripts/debug-agent.mjs) — mirrors the live agent loop without VS Code, used for regression testing across local models.

There is **no chat webview**. The chat surface is the built-in VS Code Chat view, exposed through the participant API. The only webview the extension owns is `manulai.settings`.

## Extension Laws

### Air-Gap Law
The extension must never initiate network requests to any external host except the local Ollama server (default `http://localhost:11434`). No telemetry, analytics, tracking, or cloud AI APIs are permitted. Model catalog refresh, chat inference, and tool calls are the only permitted network surface, and they must target the user-configured Ollama base URL only.

### Fetch Law
All HTTP fetches are strictly limited to the validated Ollama base URL. The base URL validator strips embedded credentials from non-loopback addresses. Every fetch must use an `AbortController` linked to a timeout watchdog so user stops and network stalls are distinguishable. User-initiated aborts are never retried; timeout aborts are rewritten into distinct errors before retry classification.

### Memory Law
All long-lived resources must be disposed correctly to avoid leaking memory or Promises:
- Clear every `NodeJS.Timeout` on disposal.
- Abort every in-flight `AbortController` on disposal.
- Resolve any pending approval Promise so awaiting callers do not hang.
- Dispose every launched VS Code terminal on disposal.
- Guard async entry points in the chat participant and settings panel against use after disposal.

## Core Rules

- Keep the extension local-first and Ollama-only.
- Do not add any cloud AI dependency or remote model API unless explicitly requested.
- The chat surface is the VS Code Chat participant `@manulai`. Do not reintroduce a custom chat webview.
- Keep Ollama integration compatible with native tool calling through `/api/chat`.
- Prefer `vscode.workspace.fs` for file operations inside the extension.
- Avoid unrelated refactors when making targeted changes.
- Preserve the distinction between Chat Mode, Agent Mode, and Planner Mode (set via `/setAgentMode`).
- In Chat Mode, never claim that files were created, modified, or deleted.
- In Chat Mode, answer direct code-explanation or review requests in plain text.
- In Chat Mode, do not return full file dumps for create-file requests; give brief manual guidance or a minimal one-file starter only when explicitly asked.
- Planner Mode uses the same tools as Agent Mode conceptually but may expose a reduced subset for very small local models; its system mandate stays condensed and step-by-step.
- Planner Mode must still answer direct text questions without requiring tool calls.
- For small edit requests, prefer surgical edits over whole-file rewrites.
- Never delete unrelated file content when the user asked for a narrow change.
- When the user references a likely target file such as `README`, `LICENSE`, `package.json`, or an explicit path, prefer resolving it automatically instead of waiting for manual attachment.

## Code Style

- Use TypeScript with strict typing.
- Keep edits minimal and focused.
- Preserve the existing project structure under `src/` and `media/`.
- Add comments only when they clarify non-obvious logic.
- Prefer `replace_in_file`-style targeted edits when changing existing file content.
- Read the current file before editing when correctness depends on surrounding structure.

## Product Constraints

- The extension must work for any programming language opened in VS Code.
- Conversation history is owned by the VS Code Chat API; the extension only reads it during request handling for context.
- Tool results must be returned to Ollama using the native `tool` role flow.
- Agent Mode and Planner Mode should support approvals, auto-approve, and fallback handling for weaker local models.
- Keep direct handlers and fallback layers conservative: fast for common edits, but not destructive.
- Treat unread files and unlisted project structure as unknown state; for edit tasks, require real tool-based inspection before claiming or applying a fix.
- Fallback layers must reject raw or malformed tool-call JSON leaked into assistant text or code blocks and retry via native tool execution instead of treating that payload as file content.
- Fallback file-write extraction must ignore shell-language fenced code blocks and reject suspicious pseudo-filenames such as numeric dotted names or names with trailing dots.
- `create_or_edit_file` must reject calls where the model omitted the `content` field entirely. Coercing missing content to `""` silently truncates the target file and lets the model claim success on a destroyed target. Empty files are still allowed when the model passes `content: ""` explicitly. The same rule applies to `write_to_file`.
- Keep tool output visible in the chat transcript, including terminal stdout and stderr and previews for file writes.
- Prefer diff-style transcript output for existing-file edits; reserve full previews mainly for new files or initially empty files.
- Keep `list_workspace_files` compatible with both workspace-relative and absolute directory paths.
- Keep bounded file reading available for large files; prefer a line-range reader (`read_file_slice`) over full-file reads when only a section is needed.
- Keep debug JSONL entries attributable to a specific build; include the extension version in the logged session/event payloads.
- Keep debug logging useful for reproducing issues; log the original user request before local hidden nudges or retries alter the effective agent context.
- Keep the model selector truthful: when no local model is chosen, the UI and backend state must remain empty rather than showing a fake fallback model.
- Keep the built-in model picker focused on the currently validated local agent models. Other installed Ollama models may still be shown for manual selection and testing, but they should not displace the validated families from the top of the picker.
- Treat the current validated baseline as `phi4-mini:3.8b`, `llama3.1:8b`, `qwen3-coder:30b`, `gemma4:latest`, and `gemma4:31b`, based on direct Ollama `/api/chat` checks plus standalone agent-loop testing rather than picker assumptions alone.
- `gemma4` models use the text-tools fallback path because Ollama 0.20.0 does not support native tool calling for thinking models — the backend returns empty responses when a `tools` array is present. Tool descriptions are injected into the system prompt as text and `{"tool": "name", "args": {...}}` JSON is parsed from the model's text content instead of native `tool_calls`.
- `gpt-oss:20b` may be tested manually but must not enter the built-in picker baseline until its agent/planner create and edit loops stop failing on malformed or truncated tool-call behavior.
- For explicit multi-file write requests, do not accept final completion text until the recorded successful file-tool writes cover every requested target file.
- For explicit file-path create requests, recover weak-model shallow or wrong-directory writes back toward the exact requested targets when that mapping is unambiguous.
- Never apply request-target path recovery on EDIT tasks. Path recovery is only safe when the model's content is semantically about the requested target. On an ordinary edit, redirecting a model's unrelated write (e.g. an accidental `.gitignore` dump) to an existing edit target silently corrupts that target.
- The "you have enough context, stop reading" nudge must only fire after at least one SUCCESSFUL read. Failed reads (ENOENT on hallucinated paths, permission errors) do not create context. Track successful reads separately from total read attempts.
- Repeated-terminal-failure detection must cluster by a root-command signature (first token, or runner+subject pair such as `npx <pkg>`, `npm <subcommand>`, `pip install`, `cargo <subcommand>`), not just by exact command string. Once the same root has failed across ≥2 distinct argument variations, nudge once and direct the model to switch approach. Tracking resets per user request and clears on any successful run of the same root.
- Detect duplicate-write loops: if the same `(toolName, argsHash)` repeats more than twice in a single run, bail with a deterministic backend failure rather than burning the full turn budget on identical writes.
- Detect malformed-tool-call leaks: when the model emits tool-shaped text but the JSON does not parse, treat that as a recoverable failure (nudge, do not declare "done"); after three consecutive malformed turns, bail.
- For large refactor requests, nudge the model toward short module/file plans and iterative execution instead of one-shot whole-file rewrites.
- Keep context trimming model-aware; derive sliding-window size and `num_ctx` from the model size tag rather than using hardcoded limits.
- Keep prompt/context simplification model-aware too: ultra-small models should receive shorter mandates, less injected workspace memory, tighter retry budgets, and fewer tools when that improves reliability.
- For ultra-small model tiers, prefer no-plan execution: one immediate bounded action instead of showing or accepting a plan.
- Raw function-call assistant text such as `tool_name(...)` must not be accepted as a final answer; route it through native-tool recovery or continue nudging until a real tool call happens.
- If a small or medium local model produces degenerate repetitive output, do not fail immediately on the first hit; strip the bad output and retry once with a stricter one-step recovery nudge.
- Keep `num_ctx` always present in the Ollama request body so the runtime allocates an appropriate KV-cache window.
- Keep `execute_terminal_command` documented as having no stdin; interactive programs must use `launch_in_terminal` which opens a real VS Code terminal.
- When `execute_terminal_command` times out because the child process was killed, the error must hint that stdin is unavailable and the program should not be retried.
- When the latest user message is conversational (greeting, small talk) and no tools were called in the current exchange, do not nudge the model to execute stale tasks from earlier context; let it respond naturally.

## Agent Tools (live)

The agent dispatch table lives in [src/agentExecutor.ts](src/agentExecutor.ts):

- `read_active_file()` — read the currently open editor file.
- `read_specific_file(filepath)` — read full file contents.
- `read_file_slice(filepath, startLine, endLine)` — read a line range.
- `create_or_edit_file(filename, content)` — create or overwrite a file. `content` is required (see Product Constraints).
- `replace_in_file(filepath, old_text, new_text)` — replace text in an existing file.
- `execute_terminal_command(command)` — run a shell command (no stdin).
- `launch_in_terminal(command)` — open an integrated VS Code terminal for interactive commands.
- `delete_file(filepath)` — delete a file.
- `list_workspace_files(directory?)` — list files/folders in a directory.
- `project_scan()` — return a recursive tree of the workspace.

When this list changes, update [README.md](README.md), [README-dev.md](README-dev.md), this file, and [.github/copilot-instructions.md](.github/copilot-instructions.md) in the same change.

## Debug Script Parity

- [scripts/debug-agent.mjs](scripts/debug-agent.mjs) is the standalone test harness for the agent loop. Fixes validated there must be ported to the live code in [src/agentExecutor.ts](src/agentExecutor.ts) and/or [src/copilotChatParticipant.ts](src/copilotChatParticipant.ts) in the same change or immediately after.
- When a behavioral fix (parser robustness, malformed-tool detection, duplicate-write bail, hallucination guard, nudge condition) proves correct in `debug-agent.mjs`, treat it as a required backport — do not leave the production loop diverged.
- Helper logic added to the harness (e.g. brace-balanced JSON extractors, alt tool-call shapes, occurrence-count signals) must have an equivalent in the live code if the same model behavior can hit production.
- Keep tool definitions in `scripts/test-model.mjs` aligned with the extension's real parameter names (e.g. `filename` not `filepath` for `create_or_edit_file`).

## Documentation

- Keep [README.md](README.md) accurate when behavior or setup changes.
- Keep [README-dev.md](README-dev.md) accurate when architecture, tools, or safety behavior changes.
- When packaging version changes, update the version string in `package.json`, `package-lock.json` (both occurrences), `README.md` (What's New), `README-dev.md` (Release Notes), `CLAUDE.md`, and `.github/copilot-instructions.md` in the same change. The `bump-version` skill enforces this.
- Keep wording direct and technical.
- Keep README tone alpha-stage and avoid marketing fluff.
- User-facing README should describe ManulAI primarily as a local AI assistant for Ollama inside VS Code.
- Avoid adding unnecessary installation/setup sections to the user-facing README unless behavior changes require them.
- Keep the `What's New` section at the bottom of the README, immediately before `License`.
- When tool lists change, update user-facing docs and developer docs in the same change.
- When agent reliability or context-handling behavior changes, update README, README-dev, and these instructions in the same change.
