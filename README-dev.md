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
- **Provider Split:** `src/ManulAiChatProvider.ts` remains the stateful orchestration layer, while `src/providerRefactorUtils.ts` contains pure large-refactor/bootstrap inference and generated-module validation helpers.
- **Modes:** The extension supports tool-enabled Agent Mode and plain Chat Mode with separate system prompts.
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
  "agentMode": true,
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
- `delete_file`
- `list_workspace_files`
- `project_scan`
- `read_workspace_notes`
- `write_workspace_notes`

Direct pre-agent handlers also exist for common fast-path edits such as Markdown title rename and LICENSE author rename.

`read_file_slice` is the bounded-reader path for large files. It accepts a file path plus 1-based inclusive `startLine` and `endLine`, and should be preferred when the model only needs a local section instead of the entire file.

`project_scan` is the high-level orientation tool. It summarizes key files, likely entry points, language hints, project type hints, package manager signals, `frameworkHints`, and important top-level modules across common ecosystems without forcing the model to open many files first. Its manifest parsing is deeper for Python, Java, C#, Rust, and Go so the model can recover framework and runtime-entry signals before doing narrow file reads.

`read_workspace_notes` and `write_workspace_notes` persist project memory in `.manulai/notes.md`. The provider can auto-append short notes after completed tasks so important discoveries survive beyond the active request.

Chats also persist a compact `summaryMemory` alongside the full transcript in `.manulai/chats.json`; those summaries are injected back into the agent mandate as short dialog memory so the model can reuse prior outcomes without replaying the entire conversation.

## Response Pipeline Notes

- Agent Mode sends tool definitions to Ollama and continues the loop automatically.
- Auto-Approve can bypass per-tool confirmations when enabled.
- Chat Mode bypasses tool fallback write layers and returns plain text only.
- Agent Mode still includes fallback write extraction layers for weaker models that fail to emit native tool calls reliably.
- After successful file writes, the provider attempts an automatic `build_verify` step using the best available project command for the detected stack, such as package scripts, `tsc --noEmit`, `cargo check`, `go test ./...`, `python -m compileall`, `mvn compile`, `gradle build`, or `dotnet build`.
- Ollama requests are not hard-timed out by the extension; users can stop them explicitly.
- Debug sessions append to stable JSONL files so live debugging does not depend on a long-lived writable stream.
- Every debug event includes the extension version and session identifier, not only the session-start record.
- User prompts are logged as explicit debug events before hidden scan nudges, auto-attachments, or tool-loop retries modify the request context.

## Transcript And Tool Feedback

- Tool results are rendered back into the chat transcript instead of staying hidden in backend-only messages.
- Terminal transcripts include command, exit code, stdout, stderr, and execution errors when available.
- File write results prefer diffs for edits to existing files and previews for newly created content or writes that fill previously empty files.
- Revertable file tool results carry revert metadata through transcript rendering so the webview can show `Revert changes` directly on those entries.
- The provider can inject local-only progress messages such as `Step 2: Reading README.md` while tools are executing. These messages are visible in chat but are filtered out from the next model request.

## Multi-Chat Behavior

- The webview can create, switch, clear, and delete multiple chats during one VS Code session.
- Each chat keeps its own `messages` collection and attached file context.
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
- Repeated narrated large-refactor steps can now be auto-bootstrapped into a real `read_file_slice`, `create_or_edit_file`, or `replace_in_file` call when the model keeps restating the same action instead of executing it.
- If retry exhaustion is reached and the model still returns pseudo-progress or plan text, the backend should surface a deterministic failure message instead of leaking raw `Step 1/3`-style output into the final answer.
- Large refactor requests should receive hidden guidance to inspect structure first, form a short module/file split plan, and then execute one concrete step at a time instead of attempting a whole-file rewrite.
- When a file is large, bounded reads through `read_file_slice` are preferred over re-reading the entire file.
- The system mandate explicitly treats unread files as unknown state: file edits require a prior read, project-structure assumptions require listing, and completion claims require successful tool confirmation.
- If the task required changes and the model has not used tools, the response is considered wrong and should be nudged back into tool execution.

## Release Notes

- **0.0.5:** Split provider-side large-refactor/bootstrap helpers into `src/providerRefactorUtils.ts`. Production now matches the stronger repeated narrated-call bootstrap behavior already validated in the standalone harness, and Go/Rust extraction writes are screened for obviously invalid generated blocks before they hit disk.
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
