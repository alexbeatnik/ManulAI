# 😼 ManulAI — Developer Guide

<p align="center">
  <img src="icon.png" width="128" alt="ManulAI Logo">
</p>

![Alpha](https://img.shields.io/badge/status-alpha-bf5b04)
![Manul Product Line](https://img.shields.io/badge/product%20line-Manul-111827)


This document covers development guidelines, constraints, and architecture for the ManulAI VS Code extension.

> **Status: Alpha.**
> **Tone:** No marketing fluff, purely technical documentation.

---

## Core Architecture

ManulAI is a local-first, privacy-focused coding agent for VS Code. All intelligent operations are powered by a local Ollama process. It connects to the `/api/chat` native tooling flow for agentic execution.

- **Chat Surface:** Single VS Code Chat Participant (`@manulai`) registered in [src/copilotChatParticipant.ts](src/copilotChatParticipant.ts). Streams Ollama responses into VS Code's native Chat panel. There is no custom chat webview.
- **Agent Loop:** Lives in [src/copilotChatParticipant.ts](src/copilotChatParticipant.ts). It builds the system mandate, calls Ollama, parses tool calls, dispatches them through [src/agentExecutor.ts](src/agentExecutor.ts), feeds results back, and stops when the model returns no further tool calls or a stop signal fires.
- **Modes:** Three working modes — tool-enabled Agent Mode, condensed step-by-step Planner Mode, and plain Chat Mode with no tool calls. Switched via the `/setAgentMode` slash command.
- **File System:** Uses `vscode.workspace.fs` for file inspection and edits.
- **State:** Conversation history is owned by the VS Code Chat API (`context.history`) and lives in memory during the session. Settings live in global VS Code settings; agent mode and auto-approve live in `ExtensionContext.globalState`.

## Source Layout

- [src/extension.ts](src/extension.ts) — Activation. Registers the chat participant, the Settings webview, and the slash-command commands.
- [src/copilotChatParticipant.ts](src/copilotChatParticipant.ts) — Chat participant handler, system-mandate builder, agent loop, debug logging, conversation compaction, model verification, malformed-tool nudges, read-loop guards.
- [src/agentExecutor.ts](src/agentExecutor.ts) — Single dispatch table for the agent's tools. Holds the `isBlockedCommand` and `isBlockedFilePath` safety guards.
- [src/ollamaStreamParser.ts](src/ollamaStreamParser.ts) — NDJSON parser plus `<think>` reasoning extraction.
- [src/settingsPanel.ts](src/settingsPanel.ts) — Activity Bar Settings webview (the only webview the extension owns).
- [src/agentInstructionsReader.ts](src/agentInstructionsReader.ts) — Reads `AGENTS.md` / `CLAUDE.md` style instruction files from the workspace.
- [src/skillsReader.ts](src/skillsReader.ts) — Reads `.claude/skills/`-style skill files from the workspace.
- [src/modelContextConfig.ts](src/modelContextConfig.ts) — Model context-window mapping and token estimation.
- [scripts/debug-agent.mjs](scripts/debug-agent.mjs) — Standalone test harness. Mirrors the live agent loop without VS Code; used for regression testing.

## Context Window Management

[src/modelContextConfig.ts](src/modelContextConfig.ts) maintains a mapping of known Ollama models to their context-window sizes (in tokens). Before each request, [src/copilotChatParticipant.ts](src/copilotChatParticipant.ts) estimates the prompt size and automatically truncates the oldest history messages if the total would exceed a safe threshold (~75 % of the model's window).

### Known context windows

| Model family | Context window |
|-------------|----------------|
| `gemma4` | 256K |
| `llama3.1`, `llama3.2`, `llama3.3` | 128K |
| `qwen3`, `qwen2.5` | 128K |
| `deepseek` | 128K |
| `phi4`, `phi3` | 128K |
| `mistral`, `mixtral` | 32K |
| `codellama` | 16K |
| `gemma2`, `gemma:` | 8K |
| unknown / default | 128K |

### Truncation rules

1. **System prompt is never dropped.** It contains instructions, skills, and mode configuration.
2. **Current user message is never dropped.** It is the actual query.
3. **Oldest history pairs are dropped first** until the estimated token count fits.
4. **Conservative estimate.** Token count is estimated as `ceil(characters / 3.5)` — intentionally over-counts to avoid overflow.

When truncation removes meaningful history, the participant runs a non-streaming compaction call to summarize the dropped messages and re-injects the result as a `[Previous conversation summarized]:` system message instead of silently losing the context.

## Product Constraints and Rules

- **Strictly Local-First:** No cloud dependencies, no remote models, no third-party APIs. Only Ollama.
- **Chat Surface:** Native VS Code Chat participant. Do not reintroduce a custom chat webview.
- **Tool Compatibility:** Must maintain compatibility with native Ollama tool calling via the `/api/chat` endpoint.
- **Target Independence:** Must work for any programming language or project structure opened in VS Code.
- **Chat Mode Honesty:** When tools are disabled, the assistant must never claim that files were modified.
- **Surgical Edits:** Small requests must produce targeted edits, not destructive whole-file rewrites.

## Code Style

- **Language:** TypeScript with strict typing.
- **Refactoring:** Keep edits minimal and strictly focused on the task at hand. Avoid unrelated refactors.
- **File Editing Safety:** Prefer `replace_in_file` for surgical edits. Read the file before editing, preserve all unrelated content, and never remove content that the user did not explicitly ask to remove.

## Setup for Development

1. Clone the repository.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Open the project in VS Code.
4. Press `F5` to open the Extension Development Host.

Make sure you have Ollama running locally (`http://localhost:11434` by default) with a tool-capable model pulled (e.g., `qwen3-coder:30b` or `llama3.1:8b`).

## Commands and Views

- **Chat Participant:** `@manulai` is registered via `vscode.chat.createChatParticipant` in [src/extension.ts](src/extension.ts). The handler lives in [src/copilotChatParticipant.ts](src/copilotChatParticipant.ts). Slash commands declared in `package.json`: `/selectModel`, `/model`, `/setAgentMode`, `/toggleAutoApprove`, `/instructions`, `/skills`.
- **Settings Panel:** [src/settingsPanel.ts](src/settingsPanel.ts) is registered as `manulai.settings` inside the `manulaiActivityBar` Activity Bar container. It lets users view and update model, base URL, agent mode, system prompt, auto-approve, and debug toggles. All writes target global VS Code settings (`ConfigurationTarget.Global`).
- **Agent Instructions Reader:** [src/agentInstructionsReader.ts](src/agentInstructionsReader.ts) discovers `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, `.cursorrules`, etc. The content is appended to the system prompt on every chat request.
- **Skills Reader:** [src/skillsReader.ts](src/skillsReader.ts) discovers skill files from `.claude/skills/`, `skills/`, `.github/skills/`, and `.ai/skills/`. Each skill is a markdown file with YAML frontmatter (`name`, `description`).
- **Configuration:** `package.json` contributes `manulai.ollamaModel`, `manulai.ollamaBaseUrl`, `manulai.debugMode`, and `manulai.systemPrompt`.

## Global State Storage

- **`agentMode`** and **`autoApprove`** live in `ExtensionContext.globalState`, toggled via slash commands.
- **Settings Panel** writes model, base URL, system prompt, and debug mode to global VS Code settings.
- No workspace-level `.manulai/settings.json` or `.manulai/chats.json` is used. Conversation history is owned by the VS Code Chat API.

`debugMode` logs go to `.manulai/logs/` for file-backed workspaces, or to extension storage when the workspace is not file-backed. Each JSONL entry includes the extension version and session identifier so logs can be matched back to a specific build.

## Agent Tools

The dispatch table in [src/agentExecutor.ts](src/agentExecutor.ts):

| Tool | Notes |
|------|-------|
| `read_active_file` | Reads the currently open editor file. |
| `read_specific_file(filepath)` | Full file contents. |
| `read_file_slice(filepath, startLine, endLine)` | Bounded line range. Preferred over full reads for large files. |
| `create_or_edit_file(filename, content)` | Creates or overwrites. `content` is required — see below. |
| `write_to_file(filepath, content)` | Alias of `create_or_edit_file`. Same `content` requirement. |
| `replace_in_file(filepath, old_text, new_text)` | Replaces text in an existing file. |
| `execute_terminal_command(command)` | Shell command via Node `exec()`. **No stdin.** Hangs on interactive programs and times out at 60 s. |
| `launch_in_terminal(command)` | Opens a visible VS Code integrated terminal. Fire-and-forget. |
| `delete_file(filepath)` | Deletes a file. |
| `list_workspace_files(directory?)` | Workspace-relative or absolute. |
| `project_scan()` | Recursive workspace tree, manifest parsing for common ecosystems. |

### `content` is required

`create_or_edit_file` and `write_to_file` reject calls where the model omitted the `content` field entirely. Coercing missing content to `""` would silently truncate the target file and let the model claim success on a destroyed target. Empty files are still allowed when the model passes `content: ""` explicitly.

### Tool aliases

[src/agentExecutor.ts](src/agentExecutor.ts) maps common model hallucinations to the real tool names: `create_file`, `write_file`, `edit_file`, `update_file` → `create_or_edit_file`.

### Safety guards

`isBlockedCommand` blocks destructive shell patterns (`rm -rf` against system paths, `sudo`, `shutdown`, `reboot`, `mkfs`, `dd if=`, fork bombs, `chmod -R 777 /`, curl/wget pipe-to-shell, global package uninstalls, `dd of=/dev/`, etc.). `isBlockedFilePath` blocks writes/edits/deletes targeting system paths, the home directory root, the workspace root, and ~30 critical project files (`.git/`, `package.json`, `tsconfig.json`, `Dockerfile`, `Cargo.toml`, `go.mod`, `.env`, `LICENSE`, `README.md`, `CLAUDE.md`, `AGENTS.md`, etc.).

## Response Pipeline Notes

- Agent Mode sends tool definitions to Ollama and continues the loop automatically.
- Planner Mode uses the same tools but a shorter, step-by-step mandate. Direct text questions still answer without requiring tool calls.
- Chat Mode uses a no-tools mandate. Direct code-explanation requests answer in plain text. The model never claims to have created or modified files in this mode.
- For micro/small model tiers, plan-style behavior is suppressed; the runtime biases toward one immediate bounded action.
- The model picker keeps the validated baseline (`phi4-mini:3.8b`, `llama3.1:8b`, `qwen3-coder:30b`, `gemma4:latest`, `gemma4:31b`) at the top; other installed Ollama models are still surfaced underneath.
- `gemma4` thinking models run in text-tool fallback mode: no native `tools` array is sent, tool descriptions are injected in the system mandate, and `{"tool": "name", "args": {...}}` JSON is parsed from the model's content.
- Auto-Approve can bypass per-tool confirmations when enabled.
- Raw function-call text such as `list_workspace_files()` or `create_or_edit_file('file.ts', '...')` is treated as a malformed tool call and routed into recovery instead of being accepted as final prose.
- Ollama HTTP 500 / 503 "model is loading" / "model failed to load" errors are retried with exponential backoff (3s / 5s / 7s, up to 3 retries).
- Before every request, `verifyModelAvailable()` queries `/api/tags` to confirm the selected model is installed locally; missing models surface a clear error instead of HTTP 500.
- When a large model fails to load due to memory limits, the OOM-fallback handler queries `/api/tags` for installed smaller alternatives and recommends them inline.
- Context trimming is model-aware (sliding window and `num_ctx` derived from the model size tag). `num_ctx` is always present in the Ollama request body so the runtime allocates an appropriate KV-cache window.
- Debug sessions append to stable JSONL files under `.manulai/logs/`; every event includes the extension version and session id.

## Tested Model Baseline

Baseline derived from direct `/api/chat` checks and standalone [scripts/debug-agent.mjs](scripts/debug-agent.mjs) runs across multi-file create, surgical rename, and refactor/split prompts.

- `qwen3-coder:30b` — strongest validated model. Most reliable at native tool calls and multi-step execution.
- `gemma4:31b` — strong 31B thinking model. Runs in text-tool fallback mode.
- `gemma4:latest` (8B, thinking) — same text-tool fallback path. Strong across Chat / Agent / Planner.
- `llama3.1:8b` — viable; passes basic create and surgical rename, struggles with multi-file refactors.
- `phi4-mini:3.8b` — viable for simple file creation; struggles with multi-occurrence rename and refactor tasks. Needs more recovery help around malformed tool-call formatting.
- `gpt-oss:20b` — not in the picker baseline; agent/planner create-edit loops still produce too many malformed or truncated tool-call failures.

The practical difference between the working and non-working groups is not just code quality. Stronger models are better at selecting the next tool, creating the first concrete file without stalling, and surviving the loop after the first write.

## Agent Reliability Safeguards

- **Read-loop prevention:** A per-session `readFilesThisSession` set tracks every file the model has read. A repeated `read_specific_file` / `read_file_slice` call with identical args triggers a system nudge ("You have already read X. Do NOT read it again."). Redundant `list_workspace_files` calls are blocked after `project_scan`. After 2 consecutive read-only turns, the loop auto-bootstraps a user message forcing the model to write instead.
- **Tool limit per turn:** `MAX_TOOLS_PER_TURN = 3` caps the number of tools executed in a single turn, prioritising writes over reads.
- **Auto-generated plan UI:** When a model outputs tool calls without explanatory text, the loop generates a human-readable plan from the parsed tool calls and shows it in chat as "**Next step:**".
- **Clean agent UI:** Raw assistant text containing tool JSON is suppressed from the chat stream in agent/planner modes; only reasoning blocks (`<think>`) and the auto-generated plan are shown.
- **Successful-read tracking:** Failed reads (ENOENT on hallucinated paths, permission errors) are counted separately from successful reads. The "you have enough context, stop reading" nudge only fires after at least one SUCCESSFUL read so a model that keeps hitting `ENOENT` is not told to answer from nonexistent context.
- **Repeated-terminal-failure clustering:** Failures cluster by a root-command signature (first token, or runner+subject pair such as `npx <pkg>`, `npm <subcommand>`, `pip install`, `cargo <subcommand>`). Once the same root has failed across ≥2 distinct argument variations, a single nudge directs the model to switch approach instead of varying flags.
- **Malformed tool-call detection:** When the model emits tool-shaped text but the JSON does not parse (broken escapes, mismatched quotes, missing colons), the loop nudges instead of declaring "done"; after three consecutive malformed turns, it bails.
- **Duplicate-write-loop detection:** When the same `(toolName, argsHash)` repeats more than twice in a single run, the loop bails with a deterministic backend failure rather than burning the full turn budget on identical writes.
- **Conversational-message exception:** When the latest user message is conversational (greeting, short non-actionable text) and no tools were called in the current exchange, action-forcing nudges are suppressed so the model can respond naturally.

## Debug Script Parity

[scripts/debug-agent.mjs](scripts/debug-agent.mjs) is the standalone test harness for the agent loop. It mirrors the live agent loop in [src/copilotChatParticipant.ts](src/copilotChatParticipant.ts) and the tool dispatch in [src/agentExecutor.ts](src/agentExecutor.ts) without VS Code, so the same regression prompts can be run reproducibly across local models.

When a behavioral fix (parser robustness, malformed-tool detection, duplicate-write bail, hallucination guard, nudge condition) proves correct in `debug-agent.mjs`, treat it as a required backport — do not leave the production loop diverged.

## Documentation Sync

- Keep `README.md`, `README-dev.md`, `CLAUDE.md`, and `.github/copilot-instructions.md` aligned when tools, modes, safety constraints, or setup behavior change.
- `CLAUDE.md` and `.github/copilot-instructions.md` must be **byte-identical** (the `verify-docs-sync` skill enforces this).
- User-facing README stays product-focused and concise.
- Developer documentation should explain architecture, safety constraints, and real implemented behavior rather than intended behavior.

## Compilation & Packaging

To compile the TypeScript code:

```bash
npm run compile
```

To create a VSIX package for distribution:

```bash
npx @vscode/vsce package
```

## Automatic Marketplace Publishing

GitHub Actions release publishing is defined in `.github/workflows/release.yml`.

Trigger behavior:

- push a tag like `v0.0.15` to build the VSIX, create a GitHub release, and publish to marketplaces
- or run `workflow_dispatch` and pass an existing tag name

Required repository secrets:

- `VSCE_PAT` — Personal Access Token for the VS Code Marketplace publisher
- `OPEN_VSX_TOKEN` — access token for `https://open-vsx.org/`

Workflow behavior:

- always builds, tests, packages, and attaches the VSIX to the GitHub release
- publishes to the VS Code Marketplace when `VSCE_PAT` is configured
- publishes to Open VSX when `OPEN_VSX_TOKEN` is configured
- if one or both tokens are missing, the workflow emits a warning and skips that publish target instead of failing the whole release

Typical release flow:

```bash
git tag v0.0.15
git push origin v0.0.15
```

## Release Notes

- **0.0.15:** Cleanup release plus model availability verification, loading resilience, and read-loop prevention.
  - **Dead-provider cleanup:** Removed the legacy webview-based provider that had been unwired since 0.0.13. Deleted `src/ManulAiChatProvider.ts`, `src/manulBridge.ts`, all `src/provider*Utils.ts` files, `src/types.ts`, `media/webview.html`, and `media/manul_bridge_api.py` — about 17,000 lines of dead source/HTML/Python that the live VS Code Chat participant (`src/copilotChatParticipant.ts` + `src/agentExecutor.ts`) no longer referenced. The browser-automation `manul_*` tools shipped in 0.0.10 lived only in that legacy provider and are not part of the current build. CLAUDE.md and copilot-instructions.md were rewritten to reflect the live architecture.
  - **`content` field required (`src/agentExecutor.ts`):** `create_or_edit_file` and `write_to_file` now reject calls where the model omitted the `content` field entirely. Previously `String(args.content ?? '')` silently coerced missing content to `""`, truncating the target file and letting the model claim success on a destroyed target. Empty files are still allowed when the model passes `content: ""` explicitly.
  - **Auto-mkdir parent dirs (`src/agentExecutor.ts`):** `toolCreateOrEditFile` now calls `vscode.workspace.fs.createDirectory(parent)` before `writeFile` so greenfield writes like `src/index.ts` in a fresh project work without an explicit "first call mkdir" turn. The harness in `scripts/debug-agent.mjs` got the matching `mkdirSync(parent, { recursive: true })`.
  - **Strict `replace_in_file` (`src/agentExecutor.ts`):** Now errors on multi-match (`old_text matched N times — add more surrounding context`) instead of silently replacing the first occurrence, and rejects calls where `old_text === new_text`. Previously a short `old_text` like `return 1` that appeared in both branches of an `if`/`else` would replace the first occurrence and let the model "fix" the buggy line while corrupting the correct one. Mirrors production semantics. The harness got the same change plus an explicit `all: true` opt-in for genuine replace-all intent.
  - **Refusal-detection nudge (`src/copilotChatParticipant.ts`):** When `originalUserPrompt` contains action verbs (create/edit/rename/fix/delete/replace/update/implement/refactor/etc.) AND the model's response has zero tool calls AND no successful tool execution has happened yet AND the nudge has not fired before, the loop injects a one-shot user message: "You answered with prose, but this task requires you to actually call tools. Do not describe hypothetical changes. Call the appropriate tool now." This catches phi4-mini-style refusals ("we don't have access to your files") without misfiring on follow-up summarisation turns. Tracked via `toolsExecutedAny` and `refusalNudgeFired` flags.
  - **Standalone test harness hardening (`scripts/debug-agent.mjs`):** Brace-balanced JSON tool-call extraction (handles tool calls whose `content` strings contain literal `{` or `}` — the previous non-greedy regex broke on Python dicts inside string literals); alt tool-call shape parser for the weak-model `{"<tool_name>": {<args>}}` form; malformed-tool-call detection that nudges the model when tool-shaped text fails to parse instead of silently declaring "done", with a 3-strike consecutive-malformed bail; duplicate-write-loop bail when the same `(tool, argsHash)` repeats more than twice; refusal-detection nudge mirroring the live participant; per-turn tool cap (`MAX_TOOLS_PER_TURN = 3`) with write/terminal/read prioritisation, plus within-turn dedup of identical `(tool, args)` pairs (qwen3-coder:30b once emitted 20+ duplicate reads in a single response on a "scan and explain" prompt — the cap mirrors the live agent loop); strict multi-match `replace_in_file` plus `all: true` opt-in; auto-mkdir parent directories on writes; fix for spurious `STOP — Max turns reached` after a clean break (the previous check on `messages.length` mis-counted because tool-result messages inflate the count).
  - **Model pre-flight check (`src/copilotChatParticipant.ts`):** New `verifyModelAvailable()` method queries Ollama `/api/tags` before every request. If the model is missing, the user receives a clear "Model not found" message with actionable steps instead of a cryptic HTTP 500.
  - **Transient model-loading retry (`src/copilotChatParticipant.ts`):** New `fetchWithModelRetry()` wrapper for all Ollama `/api/chat` calls. Detects HTTP 500/503 responses whose body contains "model failed to load", "model is loading", "loading model", or "resource limitations". Retries up to 3 times with exponential backoff (3s, 5s, 7s). Each retry is logged via `debugLog` event `ollama_model_loading_retry`. If all retries are exhausted, throws a user-friendly error explaining likely causes and suggesting troubleshooting steps. Covers both the streaming chat loop and the non-streaming compaction path.
  - **OOM fallback suggestions (`src/copilotChatParticipant.ts`):** New `getFallbackModelSuggestion()` method detects when a large model (15B+ parameters) fails to load and queries `/api/tags` for installed smaller alternatives. If any are found, the error message includes a "You already have smaller models installed" block. If none, it recommends three lightweight options with approximate RAM footprints.
  - **Read-loop prevention (`src/copilotChatParticipant.ts`):** Three mechanisms work together: per-session read tracking, early repeated-read nudges, redundant `list_workspace_files` blocking after `project_scan`, and an auto-bootstrap user message after 2 consecutive read-only turns ("STOP. Output ONLY a create_or_edit_file tool call NOW.").
  - **Tool limit per turn (`src/copilotChatParticipant.ts`):** `MAX_TOOLS_PER_TURN = 3` caps execution per turn, prioritising writes.
  - **Auto-generated plan UI and clean agent UI (`src/copilotChatParticipant.ts`):** When the model emits tool calls without explanatory text, a human-readable plan is generated from the parsed tool calls and shown as "**Next step:**". Raw tool JSON is suppressed from the chat stream in agent/planner modes.
  - Packaging version updated to `0.0.15`.
- **0.0.14:** Agent tool execution, context management, and UX improvements. Added the agent loop with text-based tool calls (`src/agentExecutor.ts`), context-window mapping (`src/modelContextConfig.ts`), workspace skills reader (`src/skillsReader.ts`), human-friendly tool output, loop detection, stop nudges, approval buttons, agent-mode auto-approve default, debug JSONL logging in the chat participant, conversation compaction via Ollama summarization, and a major safety hardening pass (expanded command blocklist and a new file-path guard covering 30+ critical project files). Packaging version updated to `0.0.14`.
- **0.0.13:** Copilot Chat integration and settings panel. Registered `@manulai` as a native VS Code Chat participant in `src/copilotChatParticipant.ts`, with streaming `/api/chat` and `<think>` reasoning extraction in `src/ollamaStreamParser.ts`. Added `src/settingsPanel.ts` for the Activity Bar Settings webview. Packaging version updated to `0.0.13`.
- **0.0.1 – 0.0.12:** Earlier alpha releases shipped a custom webview-based chat provider (`src/ManulAiChatProvider.ts` and a stack of `provider*Utils.ts` helpers) with browser-automation tools (`manul_*` via `src/manulBridge.ts` and `media/manul_bridge_api.py`), per-chat workspace notes, persisted chat sessions, and an extensive provider-side fallback layer for weak local models. That entire provider stack was retired in 0.0.15 in favor of the leaner VS Code Chat participant introduced in 0.0.13. Release-by-release notes for those versions remain in the git history.
