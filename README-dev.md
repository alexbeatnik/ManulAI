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
- **Modes:** The extension supports tool-enabled Agent Mode and plain Chat Mode with separate system prompts.
- **File System:** Uses `vscode.workspace.fs` for file inspection and edits.
- **State:** Conversation history and file context remain available in memory during the VS Code session. They are not sent to any cloud provider.

## Context And Scan Behavior

- **Attached Files:** Explicitly attached files are serialized into hidden attachment context messages and should not be re-read unless the user asks for fresh disk state.
- **Workspace Snapshot:** Project scan requests can attach a folder snapshot containing the workspace tree and a capped subset of file contents. This gives weaker local models broader context without trying to inline the entire repository.
- **Folder Isolation:** Attached folders are marked separately from regular files and must not be treated as editable file targets.
- **Auto File Discovery:** Edit requests can auto-resolve likely targets such as `README.md`, `LICENSE`, `package.json`, `tsconfig.json`, and explicit file paths before the model starts editing.
- **Scan Nudges:** Full-project scan requests inject hidden guidance to keep reading relevant files and not stop after the first directory or first detected issue.

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

- **Views:** Contributes the `manulai.chatView` webview to the Secondary Sidebar.
- **File Context:** Supports dropping files into the UI, or using commands like `manulai.attachActiveFile` and `manulai.attachExplorerSelection` via context menus.
- **Configuration:** `package.json` still contributes `manulai.ollamaModel`, `manulai.ollamaBaseUrl`, `manulai.agentMode`, `manulai.autoApprove`, `manulai.debugMode`, and `manulai.systemPrompt`, but file-backed workspaces now persist the effective workspace state in `.manulai/settings.json`.

## Workspace Settings Storage

- **Workspace Source Of Truth:** For a file-backed workspace, ManulAI reads and writes workspace-owned settings only from `.manulai/settings.json`.
- **No `.vscode/settings.json` Runtime Dependency:** The provider no longer uses workspace `manulai.*` entries from `.vscode/settings.json` as its runtime fallback. Missing values fall back to built-in defaults.
- **Migration Path:** On initialization, existing workspace-level `manulai.*` values are migrated from `.vscode/settings.json` into `.manulai/settings.json`, then the old workspace entries are cleared.
- **No-Workspace Case:** When no file-backed workspace exists, global VS Code settings still act as the fallback store because there is no `.manulai/` folder to write into.

Reference shape:

```json
{
  "ollamaModel": "llama3.2",
  "ollamaBaseUrl": "http://localhost:11434",
  "agentMode": true,
  "autoApprove": false,
  "debugMode": false,
  "systemPrompt": "You are ManulAI, a privacy-first local coding assistant running inside VS Code. Work across any programming language. Prefer precise, minimal changes and explain results clearly."
}
```

`debugMode` logs go to `.manulai/logs/` for file-backed workspaces, or to extension storage when the workspace is not file-backed.

## Current Workspace Tools

Agent Mode currently exposes these tools to Ollama:

- `read_active_file`
- `read_specific_file`
- `create_or_edit_file`
- `write_to_file`
- `replace_in_file`
- `execute_terminal_command`
- `delete_file`
- `list_workspace_files`

Direct pre-agent handlers also exist for common fast-path edits such as Markdown title rename and LICENSE author rename.

## Response Pipeline Notes

- Agent Mode sends tool definitions to Ollama and continues the loop automatically.
- Auto-Approve can bypass per-tool confirmations when enabled.
- Chat Mode bypasses tool fallback write layers and returns plain text only.
- Agent Mode still includes fallback write extraction layers for weaker models that fail to emit native tool calls reliably.
- Ollama requests are not hard-timed out by the extension; users can stop them explicitly.

## Transcript And Tool Feedback

- Tool results are rendered back into the chat transcript instead of staying hidden in backend-only messages.
- Terminal transcripts include command, exit code, stdout, stderr, and execution errors when available.
- File write results include previews for newly created content and for writes that fill previously empty files.
- The provider can inject local-only progress messages such as `Step 2: Reading README.md` while tools are executing. These messages are visible in chat but are filtered out from the next model request.

## Agent Reliability Safeguards

- Recent successful reads are tracked separately from successful fix actions so a model cannot satisfy the loop just by listing files.
- Replace failures like `old_text not found` are treated as incomplete work and should trigger a read-then-retry path.
- Responses that claim commands ran, claim fixes were completed, or end on partial plans without executing the work should be nudged back into the tool loop.
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
