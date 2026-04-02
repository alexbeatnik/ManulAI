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

- **UI Provider:** Built using `WebviewViewProvider` for the chat interface in the Secondary Sidebar.
- **Agent Loop:** All context forwarding and tool results are handled by returning tool outputs directly to Ollama.
- **Provider Split:** `src/ManulAiChatProvider.ts` remains the stateful orchestration layer, while `src/providerRefactorUtils.ts` contains pure large-refactor/bootstrap inference and generated-module validation helpers, `src/providerSafetyUtils.ts` contains build-verify classification, structured-write guards, preview generation, and placeholder/path heuristics, `src/providerPersistenceUtils.ts` contains workspace settings/chat persistence helpers, `src/providerWebviewUtils.ts` contains attachment rendering plus transcript/webview formatting helpers, `src/providerToolParsingUtils.ts` contains tool-call parsing plus malformed JSON recovery helpers, and `src/providerFileFallbackUtils.ts` contains fallback file-write extraction heuristics.
- **Modes:** The extension supports three working modes: tool-enabled Agent Mode, condensed step-by-step Planner Mode (same tools, shorter mandate, can answer text questions directly), and plain Chat Mode with no tool calls. Agent and Planner behavior are also model-size-aware: very small models get shorter mandates, less injected context, lower retry budgets, and a reduced tool surface.
- **File System:** Uses `vscode.workspace.fs` for file inspection and edits.
- **State:** Conversation history and file context remain available in memory during the VS Code session. They are not sent to any cloud provider.
- **Chat Sessions:** The provider maintains multiple chat sessions; each chat owns its own transcript and attached file context while sharing the same workspace settings and tool/runtime layer. File-backed workspaces persist this state under `.manulai/chats.json`, with extension-storage fallback when no file-backed workspace exists.

## Context And Scan Behavior

- **Attached Files:** Explicitly attached files are serialized into hidden attachment context messages and should not be re-read unless the user asks for fresh disk state.
- **Workspace Snapshot:** Project scan requests can attach a folder snapshot containing the workspace tree and a capped subset of file contents. This gives weaker local models broader context without trying to inline the entire repository.
- **Folder Isolation:** Attached folders are marked separately from regular files and must not be treated as editable file targets.
- **Auto File Discovery:** Edit requests can auto-resolve likely targets such as `README.md`, `LICENSE`, `package.json`, `tsconfig.json`, and explicit file paths before the model starts editing.
- **Scan Nudges:** Full-project scan requests inject hidden guidance to keep reading relevant files and not stop after the first directory or first detected issue.
- **Workspace Listing:** `list_workspace_files` must accept both workspace-relative directories and absolute paths without incorrectly re-rooting absolute paths under the workspace.

## Product Constraints and Rules

- **Strictly Local-First:** No cloud dependencies, no remote models, no third-party APIs. Only Ollama.
- **Sidebar Position:** The chat view must stay in the Secondary Sidebar (on the right side by default).
- **Tool Compatibility:** Must maintain compatibility with native Ollama tool calling via the `/api/chat` endpoint.
- **Target Independence:** Must work smoothly for any programming language or project structure opened in VS Code.
- **Chat Mode Honesty:** When tools are disabled, the assistant must never claim that files were modified.
- **Surgical Edits:** Small requests must produce targeted edits, not destructive whole-file rewrites.

## Code Style & Implementation Details

- **Language:** TypeScript with strict typing.
- **Webviews & Templates (CRITICAL RULE):** NEVER use backslash-quote escaping (`\"` or `\'`) inside JavaScript template literals intended for inline webview scripts. Template literal evaluation strips backslashes before the HTML reaches the browser, causing silent syntax errors. Always use `String.fromCharCode()` or pass proper JSON blobs through standard messaging.
- **Refactoring:** Keep edits minimal and strictly focused on the task at hand. Avoid unrelated refactors.
- **File Editing Safety:** Prefer `replace_in_file` for surgical edits. Read the file before editing, preserve all unrelated content, and never remove content that the user did not explicitly ask to remove.
- **Project Structure:**
  - `src/` — Extension backend and core logic.
  - `media/` — Assets, icons, and webview HTML definitions.

## Setup for Development

1. Clone the repository.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Open the project in VS Code.
4. Press `F5` to open the Extension Development Host.

Make sure you have Ollama running locally (`http://localhost:11434` by default) with a tool-capable model pulled (e.g., `llama3.2` or `deepseek-coder`).

## Commands and Views

- **Views:** Contributes the `manulai.chatView` webview to the Secondary Sidebar. The separate Activity Bar launcher container was removed so the extension stays focused on the right-side chat view.
- **File Context:** Supports dropping files into the UI, or using commands like `manulai.attachActiveFile` and `manulai.attachExplorerSelection` via context menus.
- **Dev/Test Prompt Entry:** Also contributes `manulai.devSendPrompt`, which can inject a prompt directly into the installed provider flow without typing into the webview. This is intended for local debugging and repeatable extension-level smoke tests.
- **Configuration:** `package.json` still contributes `manulai.ollamaModel`, `manulai.ollamaBaseUrl`, `manulai.agentMode`, `manulai.autoApprove`, `manulai.debugMode`, and `manulai.systemPrompt`, but file-backed workspaces now persist the effective workspace state in `.manulai/settings.json`.

## Workspace Settings Storage

- **Workspace Source Of Truth:** For a file-backed workspace, ManulAI reads and writes workspace-owned settings only from `.manulai/settings.json`.
- **No `.vscode/settings.json` Runtime Dependency:** The provider no longer uses workspace `manulai.*` entries from `.vscode/settings.json` as its runtime fallback. Missing values fall back to built-in defaults.
- **Migration Path:** On initialization, existing workspace-level `manulai.*` values are migrated from `.vscode/settings.json` into `.manulai/settings.json`, then the old workspace entries are cleared.
- **No-Workspace Case:** When no file-backed workspace exists, global VS Code settings still act as the fallback store because there is no `.manulai/` folder to write into.
- **Chat Storage:** Chat session state is stored separately from settings in `.manulai/chats.json` for file-backed workspaces, or under extension storage when there is no file-backed workspace.

Reference shape:

```json
{
  "ollamaModel": "",
  "ollamaBaseUrl": "http://localhost:11434",
  "agentMode": "agent",
  "autoApprove": false,
  "debugMode": false,
  "systemPrompt": "You are ManulAI, a privacy-first local coding assistant running inside VS Code. Work across any programming language. Prefer precise, minimal changes and explain results clearly."
}
```

`debugMode` logs go to `.manulai/logs/` for file-backed workspaces, or to extension storage when the workspace is not file-backed. Each JSONL entry includes the extension version and session identifier so logs can be matched back to a specific build. Incoming user requests are also logged before they enter the agent loop.

## Current Workspace Tools

Agent Mode currently exposes these tools to Ollama:

- `read_active_file`
- `read_specific_file`
- `read_file_slice`
- `create_or_edit_file`
- `write_to_file`
- `replace_in_file`
- `execute_terminal_command`
- `launch_in_terminal`
- `delete_file`
- `list_workspace_files`
- `project_scan`
- `read_workspace_notes`
- `write_workspace_notes`

Direct pre-agent handlers also exist for common fast-path edits such as Markdown title rename and LICENSE author rename.

`read_file_slice` is the bounded-reader path for large files. It accepts a file path plus 1-based inclusive `startLine` and `endLine`, and should be preferred when the model only needs a local section instead of the entire file.

For ultra-small local models, the runtime automatically filters this tool list down to a compact read/edit/list subset. This is intentional: `0.5b`-class models are more reliable when they are not asked to choose among notes, project-scan, terminal, delete, and interactive-terminal tools at the same time.

`execute_terminal_command` runs a shell command via Node `exec()` and captures stdout/stderr. It has no stdin — interactive programs will hang and time out after 60 seconds. When a timeout occurs because the child process was killed, the error explicitly hints that stdin is unavailable and that interactive programs should not be retried.

`launch_in_terminal` opens a visible VS Code integrated terminal via `vscode.window.createTerminal()` and sends the command to it. The user can interact with the program directly (type input, respond to prompts, play games). The tool returns immediately with `{ launched: true }` — the model does not see the terminal output. This is fire-and-forget by design.

`project_scan` is the high-level orientation tool. It summarizes key files, likely entry points, language hints, project type hints, package manager signals, `frameworkHints`, and important top-level modules across common ecosystems without forcing the model to open many files first. Its manifest parsing is deeper for Python, Java, C#, Rust, and Go so the model can recover framework and runtime-entry signals before doing narrow file reads.

`read_workspace_notes` and `write_workspace_notes` persist per-chat project memory under `.manulai/notes/<chatId>.md`. Each chat has its own notes file, and notes are automatically deleted when the chat is deleted. The provider can auto-append short notes after completed tasks so important discoveries survive beyond the active request.

Chats also persist a compact `summaryMemory` alongside the full transcript in `.manulai/chats.json`; those summaries are injected back into the agent mandate as short dialog memory so the model can reuse prior outcomes without replaying the entire conversation.

Safe deterministic known-file reads are now available beyond the ultra-small tier for a couple of exact read requests. When the user asks only for `package.json` name/version or the `README.md` title, the runtime can answer directly instead of forcing a weaker or quirky model through a full tool-planning loop just to rediscover an obvious target.

## Response Pipeline Notes

- Agent Mode sends tool definitions to Ollama and continues the loop automatically.
- Planner Mode sends the same tools as Agent Mode conceptually, but the runtime may reduce the actual tool set for smaller models. Planner Mode also uses a shorter system mandate focused on step-by-step execution; direct text questions are answered without requiring tool calls.
- Chat Mode uses a dedicated no-tools mandate. Direct code explanation/review requests in chat should be answered in short plain text, while explicit visible-snippet edit requests stay in manual `Old:` / `New:` suggestion format.
- Chat Mode also suppresses full file dumps for file-creation requests; those requests should degrade to brief manual guidance and push the user toward Agent Mode or a one-file-at-a-time starter snippet.
- For micro/small tiers, visible and hidden plan behavior is suppressed; the runtime biases toward one immediate bounded action instead of accepting or displaying plans.
- The runtime now also curates the visible model picker toward the currently reliable agent-capable local models: `phi4-mini:3.8b`, `llama3.1:8b`, and `qwen3-coder:30b`. Smaller glitch-prone coder models are no longer surfaced in the picker by default.
- `gpt-oss:20b` has now been exercised on the local regression stack as well. Its chat behavior is solid and its exact package/README read cases are now recoverable. The runtime now also retries one transient Ollama fetch failure once and stops early after successful explicit create-only writes instead of always forcing one more model turn. Even with those guards, its agent/planner create and edit loops still produce too many malformed, empty, or truncated tool-call failures to justify surfacing it in the built-in picker yet.
- Auto-Approve can bypass per-tool confirmations when enabled.
- Chat Mode bypasses tool fallback write layers and returns plain text only.
- Agent Mode still includes fallback write extraction layers for weaker models that fail to emit native tool calls reliably.
- Raw function-call text such as `list_workspace_files()` or `create_or_edit_file('file.ts', '...')` is parsed as a broken tool call and routed into recovery instead of being accepted as final prose.
- Ollama `HTTP 500` parse failures are now also recoverable in a narrower case: if the backend error includes a raw tool-call payload and that payload can be parsed locally, the runtime feeds that recovered tool intent back into the normal tool loop instead of failing immediately.
- After successful file writes, the provider attempts an automatic `build_verify` step using the best available project command for the detected stack, such as package scripts, `tsc --noEmit`, `cargo check`, `go test ./...`, `python -m compileall`, `mvn compile`, `gradle build`, or `dotnet build`.
- Automatic build verification now skips unrelated cross-stack standalone files, so creating a single Python file inside a TypeScript workspace does not force the model into a TypeScript verify loop.
- Ollama requests are not hard-timed out by the extension; users can stop them explicitly.
- Context trimming is model-aware: the provider derives sliding-window size and `num_ctx` from the model size tag (for example `:0.5b` → 8 messages / 4K context, `:3b` → 10 / 6K, `:7b` → 16 / 8K, `:30b` → 32 / 16K) rather than using hardcoded limits. `num_ctx` is always present in the Ollama request body so the runtime allocates an appropriate KV-cache window.
- Debug sessions append to stable JSONL files so live debugging does not depend on a long-lived writable stream.
- Every debug event includes the extension version and session identifier, not only the session-start record.
- User prompts are logged as explicit debug events before hidden scan nudges, auto-attachments, or tool-loop retries modify the request context.

## Tested Model Baseline

The current model policy is based on direct `/api/chat` checks against Ollama plus standalone `scripts/debug-agent.mjs` runs on simple greenfield coding tasks, especially single-file creation tasks such as a Python console dice game.

- `qwen3-coder:30b` is the strongest validated model in this project so far. It is the most reliable at emitting native tool calls, starting with a concrete file write, and staying coherent across multi-step agent execution.
- `llama3.1:8b` is also viable. Raw coding output is solid and it is much more stable than the weak `qwen2.5-coder` tiers, but it still trails `qwen3-coder:30b` in tool-loop consistency.
- `phi4-mini:3.8b` is viable for agent use and much better than the weak small models, but it still needs more recovery help around pseudo-tool text and malformed tool-call formatting.
- `gpt-oss:20b` is not part of the validated picker baseline yet. In local testing it handled chat-only tasks well and benefited from deterministic exact-read recovery, but it still remained unstable in several agent/planner create or edit flows.
- `qwen2.5-coder:7b` is not treated as reliable enough for the built-in picker. It can produce partially acceptable raw coding output in English, but in planner/agent loops it still degrades too often into malformed, repetitive, or incoherent responses.
- `qwen2.5-coder:1.5b` and `qwen2.5-coder:0.5b` are not considered dependable agent models for this runtime. In current tests they collapse too early, often before the tool loop is even the main problem.

The practical difference between the working and non-working groups is not just code quality in plain text. The stronger models are better at selecting the next tool, creating the first concrete file without stalling, and surviving the loop after the first write. The weaker models are much more likely to narrate instead of acting, leak malformed tool text, repeat themselves, or fail immediately after one partial step.

## Transcript And Tool Feedback

- Tool results are rendered back into the chat transcript instead of staying hidden in backend-only messages.
- Terminal transcripts include command, exit code, stdout, stderr, and execution errors when available.
- File write results prefer diffs for edits to existing files and previews for newly created content or writes that fill previously empty files.
- Revertable file tool results carry revert metadata through transcript rendering so the webview can show `Revert changes` directly on those entries.
- The provider can inject local-only progress messages such as `Step 2: Reading README.md` while tools are executing. These messages are visible in chat but are filtered out from the next model request.

## Multi-Chat Behavior

- The webview can create, switch, clear, and delete multiple chats during one VS Code session.
- Each chat keeps its own `messages` collection, attached file context, and per-chat notes file under `.manulai/notes/<chatId>.md`.
- Chat switching is blocked while a request is in flight so a running tool loop cannot drift into a different transcript.
- Chat session state is persisted and restored across extension-host restarts.
- Persistence writes are debounced and stored in `.manulai/chats.json` for file-backed workspaces.

## Webview Layout Constraints

- The Secondary Sidebar UI must remain usable on narrow widths and low-height laptop screens.
- History needs to keep a visible, scrollable area even when the header, controls, attachments, and composer are present.
- The composer must not grow enough to push the history fully out of view; textarea growth should stay bounded by viewport-sensitive limits.
- When vertical space is constrained, non-essential copy such as subtitles, hints, or attachment chip overflow can be reduced before sacrificing message visibility.
- Chat selection, chat creation, and chat deletion controls should stay grouped together in the header row, with the status pill staying compact enough not to crowd the selector.

## Agent Reliability Safeguards

- Recent successful reads are tracked separately from successful fix actions so a model cannot satisfy the loop just by listing files.
- Replace failures like `old_text not found` are treated as incomplete work and should trigger a read-then-retry path.
- Responses that claim commands ran, claim fixes were completed, or end on partial plans without executing the work should be nudged back into the tool loop.
- When the user explicitly requests multiple file targets, completion is not accepted until the tool transcript contains successful writes covering each requested file.
- When the user explicitly requests concrete file paths, create-style writes should be recovered toward those exact targets when a weaker model drifts to a shallow alias or the wrong directory.
- Repeated narrated large-refactor steps can now be auto-bootstrapped into a real `read_file_slice`, `create_or_edit_file`, or `replace_in_file` call when the model keeps restating the same action instead of executing it.
- If retry exhaustion is reached and the model still returns pseudo-progress or plan text, the backend should surface a deterministic failure message instead of leaking raw `Step 1/3`-style output into the final answer.
- Large refactor requests should receive hidden guidance to inspect structure first, form a short module/file split plan, and then execute one concrete step at a time instead of attempting a whole-file rewrite.
- When a file is large, bounded reads through `read_file_slice` are preferred over re-reading the entire file.
- Exact package.json name/version reads and README title reads now have deterministic local fast paths across model tiers when the target is obvious. Ultra-small tiers additionally keep deterministic local fast paths for exact-line replacement in one known file and single explicit-file create requests, so a `0.5b`-class model does not need to survive the full loop for those narrow cases. Separately, agent/planner mode now retries one transient Ollama fetch failure once and can stop immediately after the requested explicit create-only file set has already been written successfully, instead of always demanding one more model response.
- Degenerate repetitive garbage output from micro/small/medium tiers no longer fails immediately on the first hit; the runtime now strips the bad output and retries once with a much stricter one-step recovery nudge, optionally suggesting a starter file path such as `main.ts` or `main.py` for simple greenfield create tasks.
- Preferred stronger models (`phi4-mini`, `llama3.1`, `qwen3-coder`) also run with model-specific profiles that bias toward one-step execution, trim away project-scan and notes tools by default, push greenfield create requests to start from the first concrete file instead of inspecting the workspace, reject shallow placeholder scaffolds including trivial `...` dumps, reject overly thin first source files for simple greenfield starts, recover some plain-text code dumps into synthetic `create_or_edit_file` calls, block `execute_terminal_command` both before the first real source-file write and immediately after the first concrete file write, keep arbitrary terminal commands blocked until the latest greenfield write passes syntax verification, and reject global package installs from the agent loop.
- The system mandate explicitly treats unread files as unknown state: file edits require a prior read, project-structure assumptions require listing, and completion claims require successful tool confirmation.
- If the task required changes and the model has not used tools, the response is considered wrong and should be nudged back into tool execution.
- When the latest user message is conversational (greeting, short non-actionable text) and no tools were called in the current exchange, action-forcing nudges are suppressed so the model can respond naturally instead of executing stale tasks from earlier context.

## Release Notes

- **0.0.7:** Added model-size capability profiles to the runtime and debug harness. Ultra-small models now run with compact mandates, smaller workspace trees, lower retry budgets, lower read-loop thresholds, fewer injected summaries/notes, and a reduced tool menu aimed at bounded reads plus surgical edits. Small models also bias toward one-step-at-a-time execution instead of plan-heavy loops. Raw parenthesized tool-call text now routes into recovery rather than being accepted as final prose, ultra-small tiers have deterministic fast paths for a few narrow simple tasks such as package.json reads, README title reads, exact-line replacements, and explicit single-file creates, and degenerate repetitive output now gets one strict recovery retry before the runtime gives up. The visible picker is now curated toward `phi4-mini:3.8b`, `llama3.1:8b`, and `qwen3-coder:30b`, and those preferred models also receive tighter tool sets plus greenfield-create nudges. Packaging version updated to `0.0.7`.
- **0.0.6:** Workspace notes are now per-chat, stored under `.manulai/notes/<chatId>.md` instead of a shared `.manulai/notes.md`. Notes are deleted when the owning chat is deleted. The nudge system now detects conversational user messages (greetings, small talk) and bypasses action-forcing nudges so the model responds naturally to greetings instead of executing stale tasks from earlier context. Packaging version updated to `0.0.6`.
- **0.0.5:** Added Planner Mode as the third working mode alongside Chat and Agent — uses the same tools as Agent Mode but with a condensed step-by-step mandate; can answer direct text questions without tool calls. Added `launch_in_terminal` tool for running interactive programs in a visible VS Code terminal; `execute_terminal_command` now detects timeout-killed processes and reports stdin unavailability. Context trimming is now model-aware: sliding-window size and `num_ctx` are derived from the model size tag instead of hardcoded limits. Tool-call stripping was tightened so only `json`/`tool_call`/`tool` code blocks are removed instead of all fenced code blocks. Split provider-side helper logic out of `src/ManulAiChatProvider.ts` into `src/providerRefactorUtils.ts`, `src/providerSafetyUtils.ts`, `src/providerPersistenceUtils.ts`, `src/providerWebviewUtils.ts`, `src/providerToolParsingUtils.ts`, and `src/providerFileFallbackUtils.ts`. Production now matches the stronger repeated narrated-call bootstrap behavior already validated in the standalone harness, Go/Rust extraction writes are screened for obviously invalid generated blocks before they hit disk, tool-call parsing and malformed JSON recovery now live outside the main provider, and fallback file-write extraction heuristics are isolated from the orchestration layer. Test script tool definitions are aligned with the extension's real parameter names.
- Raw or malformed tool-call JSON leaked into assistant text must be treated as a failed tool invocation and retried; fallback file-write extractors must never treat that payload as file content.
- Fallback file-write extraction must ignore shell-language fenced blocks and reject suspicious pseudo-filenames such as numeric dotted names or names with trailing dots.
- Direct fast paths remain conservative and are limited to narrow cases such as Markdown title rename and LICENSE author rename.

## Documentation Sync

- Keep `README.md`, `README-dev.md`, and `.github/copilot-instructions.md` aligned when tools, modes, safety constraints, or setup behavior change.
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
