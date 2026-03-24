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
- chat stays beside the editor instead of replacing the main work area
- conversation history is kept in memory for follow-up requests
- multiple chats can be created, switched, cleared, and deleted from the sidebar, and file-backed workspaces persist them under `.manulai/chats.json`
- the sidebar layout is compacted for narrow widths and low-height laptop screens so chat history remains visible above the composer
- the chat picker, chat actions, and composer controls use a denser toolbar-style layout so more history stays visible in the sidebar

### Local Ollama Integration

- uses your local Ollama server through `/api/chat`
- supports native Ollama tool-calling flow with `tool` role responses
- no hard request timeout inside the extension; long-running local responses can finish naturally
- model selection is exposed inside the extension UI and settings
- if no local model is selected, the UI stays empty instead of showing a fake fallback model

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
- attach the whole workspace as a scan snapshot when the user asks to scan or remember the project
- keep attached file context visible in the UI
- forward attached content into the model context for the next requests

### Project Scan And File Discovery

- project scan requests can attach a workspace snapshot with the file tree and a capped set of file contents
- scan requests push the agent to keep reading and fixing instead of stopping after the first directory or first issue
- edit requests can auto-discover likely targets such as `README.md`, `LICENSE`, `package.json`, `tsconfig.json`, and explicit file paths even if those files were not attached first
- when a likely target file is auto-discovered, the chat prints that discovery as a visible progress step before the next tool actions

### Visible Tool Transcript

- tool execution results are rendered in the chat with compact summaries, diffs for file edits, previews for new or first-fill file writes, or full terminal output as appropriate
- terminal actions show the command, exit code, stdout, stderr, and tool error text when present
- file creation and rewrite actions show a preview, including when an empty file was filled for the first time
- revertable file edits expose a `Revert changes` action directly in the transcript while the written file still matches the saved snapshot
- multi-step actions can print progress step-by-step while tools are running

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

`list_workspace_files` accepts both workspace-relative directories and absolute paths inside the current machine workspace context.

### Safer Editing Behavior

The extension now pushes stricter file-editing rules into the agent prompt:

- make surgical edits for small requests instead of rewriting entire files
- never remove content that the user did not explicitly ask to remove
- prefer targeted replacement over full-file overwrite when possible
- read the file before editing so the model has the full structure
- do not claim a file changed unless a real tool changed it
- do not treat a failed replacement or failed terminal command as a completed fix
- do not stop on partial plans like `Step 1/3` when more reading or fixing is still required
- do not declare success unless all required steps ran and the relevant tool calls succeeded
- do not modify a file before reading it first
- if unsure, read more files and gather more context instead of guessing
- do not leak raw or malformed tool-call JSON into fallback file writes; those responses are retried as tool calls instead of being treated as file content
- do not treat shell command blocks as file content during fallback file-write extraction
- reject suspicious pseudo-filenames such as numeric dotted names or names with trailing dots before writing files

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
- `manulai.debugMode` — saves detailed local debug logs when enabled, including the ManulAI extension version in each JSONL entry and the user requests sent into the agent pipeline
- `manulai.systemPrompt` — extra system prompt text prepended to each Ollama request

When a file-backed workspace is open, ManulAI treats `.manulai/settings.json` as the only workspace-level source of truth for these values. It does not keep workspace state in `.vscode/settings.json` anymore.

That file is created on first write and stores the settings that the ManulAI UI manages inside the workspace.

Example `.manulai/settings.json`:

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

If an older workspace still has `manulai.*` values in `.vscode/settings.json`, ManulAI migrates those workspace values into `.manulai/settings.json` and clears the old workspace entries.

Default values:

- model: empty until you choose a local Ollama model
- Ollama base URL: `http://localhost:11434`
- agent mode: `true`
- auto-approve: `false`
- debug mode: `false`

---

## Notes

- `icon.png` is used as the extension icon in the VS Code manifest
- `media/manulai-icon.svg` is used for the contributed sidebar container and view icon
- the project is intentionally Ollama-only and local-first
- workspace-owned ManulAI state lives under `.manulai/`; settings use `.manulai/settings.json`, chats use `.manulai/chats.json`, and debug logs use `.manulai/logs/` when the workspace is file-backed
- the README describes current behavior and avoids cloud-oriented setup or product marketing fluff

---

## What's New

- **0.0.4:** Removed the separate Activity Bar launcher badge so ManulAI stays focused on the Secondary Sidebar chat view. The header and chat controls were compacted further, with chat creation and deletion moved next to the chat selector. Empty-model handling is now truthful instead of showing a fake fallback model, and revertable native file-tool transcript entries expose `Revert changes` again. Packaging version updated to `0.0.4`.
- **0.0.3:** Debug JSONL entries now include the ManulAI extension version on every event, making mixed-log debugging across installed builds easier. Debug logs also capture user requests that enter the agent pipeline. The sidebar now supports creating, switching, deleting, and restoring multiple chats. File-backed workspaces persist chat state in `.manulai/chats.json`. Packaging version updated to `0.0.3`.
- **0.0.2:** Auto-retry without tools when the model does not support tool calling (HTTP 400 fallback). Diff markers no longer leak into written files. Destructive writes to critical files like `package.json` are blocked (invalid JSON, shell commands as content, suspiciously short content). Code block extraction now rejects diff-formatted blocks and shell command blocks during fallback file-write extraction. Raw or malformed JSON tool-call payloads are now retried as tool executions instead of being mistaken for file content. Edit transcripts now prefer diffs for existing-file changes instead of dumping full rewritten content. Project scan requests can attach a capped workspace snapshot. Tool results are visible in chat with terminal output and file previews. Multi-step actions can print progress while tools run. Edit requests can auto-discover likely files such as `README.md` when they are mentioned but not attached. `list_workspace_files` now handles absolute paths correctly. Debug logging uses stable JSONL session files under `.manulai/logs/` for file-backed workspaces. The sidebar UI is compacted further for narrow and low-height screens. Publisher ID updated to `manul-engine`.
- **0.0.1 (Alpha Release):** Initial public alpha with right-side chat UI, local Ollama integration, workspace file attachments, native tool-calling support, agent/chat mode separation, approval controls, directory listing and file deletion tools, and stricter prompt rules for safer file edits.

## License

This project is licensed under the Apache License 2.0.
See the `LICENSE` file included in the extension package for details.