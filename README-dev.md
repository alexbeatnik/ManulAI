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
- **File System:** Uses `vscode.workspace.fs` for file inspection and edits.
- **State:** Conversation history and file context remain available in memory during the VS Code session. They are not sent to any cloud provider.

## Product Constraints and Rules

- **Strictly Local-First:** No cloud dependencies, no remote models, no third-party APIs. Only Ollama.
- **Sidebar Position:** The chat view must stay in the Secondary Sidebar (on the right side by default).
- **Tool Compatibility:** Must maintain compatibility with native Ollama tool calling via the `/api/chat` endpoint.
- **Target Independence:** Must work smoothly for any programming language or project structure opened in VS Code.

## Code Style & Implementation Details

- **Language:** TypeScript with strict typing.
- **Webviews & Templates (CRITICAL RULE):** NEVER use backslash-quote escaping (`\"` or `\'`) inside JavaScript template literals intended for inline webview scripts. Template literal evaluation strips backslashes before the HTML reaches the browser, causing silent syntax errors. Always use `String.fromCharCode()` or pass proper JSON blobs through standard messaging.
- **Refactoring:** Keep edits minimal and strictly focused on the task at hand. Avoid unrelated refactors.
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

## Compilation & Packaging

To compile the TypeScript code:

```bash
npm run compile
```

To create a VSIX package for distribution:

```bash
npx @vscode/vsce package
```
