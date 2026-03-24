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
- Preserve the distinction between Agent Mode and Chat Mode.
- In Chat Mode, never claim that files were created, modified, or deleted.
- For small edit requests, prefer surgical edits over whole-file rewrites.
- Never delete unrelated file content when the user asked for a narrow change.
- Keep project-scan behavior persistent enough that the model can continue across multiple files instead of stopping after the first step.
- When the user references a likely target file such as `README`, `LICENSE`, `package.json`, or an explicit path, prefer resolving it automatically instead of waiting for manual attachment.

## Code Style

- Use TypeScript with strict typing.
- Keep edits minimal and focused.
- Preserve the existing project structure under `src/` and `media/`.
- NEVER use backslash-quote escaping (`\"` or `\'`) inside JavaScript template literals for inline webview scripts. Template literal evaluation strips backslashes before the HTML reaches the browser, causing syntax errors. Use `String.fromCharCode()` or structured data instead.
- Add comments only when they clarify non-obvious logic.
- Prefer `replace_in_file`-style targeted edits when changing existing file content.
- Read the current file before editing when correctness depends on surrounding structure.

## Product Constraints

- The extension must work for any programming language opened in VS Code.
- Conversation history must remain available in memory for request context.
- Dropped file context must remain visible in the UI and be forwarded to the model context.
- Tool results must be returned to Ollama using the native `tool` role flow.
- Agent Mode should continue to support approvals, auto-approve, and fallback handling for weaker local models.
- Keep direct handlers and fallback layers conservative: fast for common edits, but not destructive.
- Fallback layers must reject raw or malformed tool-call JSON leaked into assistant text or code blocks and retry via native tool execution instead of treating that payload as file content.
- Keep tool output visible in the chat transcript, including terminal stdout and stderr and previews for file writes.
- Keep step-by-step progress messages visible in chat during multi-tool actions, but do not feed those local progress messages back into the next model request.
- Keep folder snapshot context distinct from file context so directories are never treated as editable files.

## Documentation

- Keep README accurate when behavior or setup changes.
- Keep `README-dev.md` accurate when architecture, tools, or safety behavior changes.
- Keep wording direct and technical.
- Keep README tone alpha-stage and avoid marketing fluff.
- User-facing README should describe ManulAI primarily as a local AI assistant for Ollama inside VS Code.
- Avoid adding unnecessary installation/setup sections to the user-facing README unless behavior changes require them.
- Keep the `What's New` section at the bottom of the README, immediately before `License`.
- When tool lists change, update user-facing docs and developer docs in the same change.
- When agent reliability or context-handling behavior changes, update README, README-dev, and these instructions in the same change.