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
- **Configuration:** Settings handle `manulai.ollamaModel`, `manulai.ollamaBaseUrl`, `manulai.agentMode`, `manulai.autoApprove`, and `manulai.systemPrompt`.

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
