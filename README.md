# 😼 ManulAI Local Agent

![Alpha](https://img.shields.io/badge/status-alpha-bf5b04)
![Manul Product Line](https://img.shields.io/badge/product%20line-Manul-111827)

ManulAI is a local AI coding assistant for Visual Studio Code powered entirely by your own Ollama runtime.

It is built for developers who want workspace-aware chat and local tool execution inside the editor without cloud APIs, remote inference, or account-based workflow. ManulAI keeps the chat in the right-side Secondary Sidebar, forwards local file context to Ollama, and runs file and terminal actions through Ollama native tool-calling flow.

> The Manul goes hunting and never returns without its prey.

> **Status: Alpha.**
> **Developed by a single person.**
>
> ManulAI is already useful for real work, but it is still being battle-tested on real-world projects. Bugs, rough edges, and behavioral changes are expected while the product matures. The priority is transparent local behavior, predictable tool execution, and strong Ollama-first integration rather than polished marketing promises.

---

## Why Use ManulAI

ManulAI is designed for developers who already want Ollama as the model runtime and need a practical assistant inside VS Code:

- local-first by default
- no cloud AI dependency or remote model API
- chat and tools stay close to the code you are editing
- works across any programming language opened in VS Code
- keeps attached file context and conversation history available during the session
- supports both plain chat and agent-driven tool execution

---

## What It Does

### Right-Side Chat UI

- dedicated ManulAI chat view in the Secondary Sidebar
- launcher view in the Activity Bar
- chat stays beside the editor instead of replacing the main work area
- conversation history is kept in memory for follow-up requests

### Local Ollama Integration

- uses your local Ollama server through `/api/chat`
- supports native Ollama tool-calling flow with `tool` role responses
- no hard request timeout inside the extension; long-running local responses can finish naturally
- model selection is exposed inside the extension UI and settings

### Agent Mode And Chat Mode

ManulAI has two working modes:

- `Agent Mode` enables local tools and lets Ollama continue the tool loop automatically
- `Chat Mode` disables tools and responds as plain chat only
- in chat-only mode, ManulAI should not claim that files were changed
- `Auto-Approve` can be turned on to execute tools immediately or off to require confirmation for every tool call

### File Context Flow

- attach the active editor file to the chat
- attach files from the Explorer context menu
- browse and attach files from disk
- keep attached file context visible in the UI
- forward attached content into the model context for the next requests

### Built-In Workspace Tools

Agent Mode currently exposes these tools to Ollama:

- `read_active_file`
- `read_specific_file`
- `create_or_edit_file`
- `write_to_file`
- `replace_in_file`
- `execute_terminal_command`
- `delete_file`
- `list_workspace_files`

These cover the main local coding tasks: reading files, targeted edits, full rewrites when necessary, file creation, file deletion, listing workspace directories, and running local shell commands.

### Safer Editing Behavior

The extension now pushes stricter file-editing rules into the agent prompt:

- make surgical edits for small requests instead of rewriting entire files
- never remove content that the user did not explicitly ask to remove
- prefer targeted replacement over full-file overwrite when possible
- read the file before editing so the model has the full structure
- do not claim a file changed unless a real tool changed it

This exists specifically to reduce destructive edits like replacing an entire README when the request was only to remove one line or one image block.

### Direct Command Handling

For common requests, ManulAI also has direct handlers before the full agent loop:

- title rename in Markdown files
- LICENSE author rename

This helps simple edits complete faster and more predictably.

---

## Commands

The extension contributes these VS Code commands:

- `ManulAI: Open Chat`
- `ManulAI: Open Secondary Sidebar`
- `ManulAI: Select Ollama Model`
- `Attach to ManulAI Chat`
- `Attach Active File to ManulAI Chat`
- `Attach Explorer Selection to ManulAI Chat`

---

## Configuration

The extension exposes these settings:

- `manulai.ollamaModel` — local Ollama model used for chat and tool calling
- `manulai.ollamaBaseUrl` — base URL for the local Ollama server
- `manulai.agentMode` — turns tool-enabled agent behavior on or off
- `manulai.autoApprove` — skips approval prompts for tool execution when enabled
- `manulai.systemPrompt` — extra system prompt text prepended to each Ollama request

Default values:

- model: `llama3.2`
- Ollama base URL: `http://localhost:11434`
- agent mode: `true`
- auto-approve: `false`

---

## Notes

- `icon.png` is used as the extension icon in the VS Code manifest
- `media/manulai-icon.svg` is used for the contributed sidebar container and view icon
- the project is intentionally Ollama-only and local-first
- the README describes current behavior and avoids cloud-oriented setup or product marketing fluff

---

## What's New

- **0.0.2:** Auto-retry without tools when the model does not support tool calling (HTTP 400 fallback). Diff markers no longer leak into written files. Destructive writes to critical files like `package.json` are blocked (invalid JSON, shell commands as content, suspiciously short content). Code block extraction now rejects diff-formatted blocks. Publisher ID updated to `manul-engine`.
- **0.0.1 (Alpha Release):** Initial public alpha with right-side chat UI, local Ollama integration, workspace file attachments, native tool-calling support, agent/chat mode separation, approval controls, directory listing and file deletion tools, and stricter prompt rules for safer file edits.

## License

This project is licensed under the Apache License 2.0.
See the `LICENSE` file included in the extension package for details.