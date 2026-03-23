# Copilot Instructions

This repository contains a VS Code extension named ManulAI.

## Core Rules

- Keep the extension local-first and Ollama-only.
- Do not add any cloud AI dependency or remote model API unless explicitly requested.
- Preserve the chat view in the Secondary Sidebar on the right side.
- Keep Ollama integration compatible with native tool calling through `/api/chat`.
- Prefer `vscode.workspace.fs` for file operations inside the extension.
- Prefer `WebviewViewProvider` for the chat UI.
- Keep the webview implementation simple and production-oriented.
- Avoid unrelated refactors when making targeted changes.

## Code Style

- Use TypeScript with strict typing.
- Keep edits minimal and focused.
- Preserve the existing project structure under `src/` and `media/`.
- NEVER use backslash-quote escaping (`\"` or `\'`) inside JavaScript template literals for inline webview scripts. Template literal evaluation strips backslashes before the HTML reaches the browser, causing syntax errors. Use `String.fromCharCode()` or structured data instead.
- Add comments only when they clarify non-obvious logic.

## Product Constraints

- The extension must work for any programming language opened in VS Code.
- Conversation history must remain available in memory for request context.
- Dropped file context must remain visible in the UI and be forwarded to the model context.
- Tool results must be returned to Ollama using the native `tool` role flow.

## Documentation

- Keep README accurate when behavior or setup changes.
- Keep wording direct and technical.
- Keep README tone alpha-stage and avoid marketing fluff.
- User-facing README should describe ManulAI primarily as a local AI assistant for Ollama inside VS Code.
- Avoid adding unnecessary installation/setup sections to the user-facing README unless behavior changes require them.
- Keep the `What's New` section at the bottom of the README, immediately before `License`.