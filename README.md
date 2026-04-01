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

ManulAI has three working modes:

- `Chat Mode` disables tools and responds as plain chat only
- `Agent Mode` enables local tools and lets Ollama continue the tool loop automatically
- `Planner Mode` uses the same tools as Agent Mode but with a condensed system mandate focused on step-by-step planning and execution; it can also answer direct text questions without requiring tool calls
- tiny local models are simplified automatically by model size: smaller context windows, shorter mandates, fewer hidden notes/summaries, and a reduced tool menu for ultra-small models so even `0.5b`-class models have a chance to stay on task
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

These cover the main local coding tasks: reading files, targeted edits, full rewrites when necessary, file creation, file deletion, listing workspace directories, running local shell commands, and launching interactive programs.

For very small models, ManulAI automatically narrows this tool surface. Ultra-small models get a compact read/edit/list tool subset instead of the full menu, and small models get shorter prompts plus tighter retry/read limits to reduce planning loops and context overload.

For ultra-small models, a few very simple requests can bypass the full agent loop entirely. Narrow cases like reading `package.json` name/version, reading the `README.md` title, replacing one exact line in a known file, or creating one explicit file with inline code can be handled deterministically instead of asking a `0.5b`-class model to survive a full tool-planning cycle.

`execute_terminal_command` runs a shell command and captures stdout/stderr. It has no stdin support, so interactive programs (games, REPLs, scripts using `input()` or `readline`) will hang and time out. When a timeout occurs because the process was killed, the error message explicitly hints that stdin is unavailable.

`launch_in_terminal` opens a visible VS Code integrated terminal and runs the given command there. The user can interact with the program directly (type input, respond to prompts). The tool returns immediately — the model does not see the terminal output.

`project_scan` returns a higher-level summary of the workspace, including likely entry points, key files, package manager hints, language hints, project type hints, `frameworkHints`, and important modules across common ecosystems such as JavaScript/TypeScript, Python, Go, Rust, Java/Kotlin, C#, PHP, Ruby, Swift, and C/C++. It also does deeper manifest parsing for Python, Java, C#, Rust, and Go to recover framework and entry-point signals from their manifest files.

`read_workspace_notes` and `write_workspace_notes` persist compact per-chat project memory under `.manulai/notes/<chatId>.md` so important architectural facts and recent completed-task notes survive across VS Code restarts. Notes are scoped to the active chat and automatically deleted when that chat is deleted.

`list_workspace_files` accepts both workspace-relative directories and absolute paths inside the current machine workspace context.

`read_file_slice` reads only a bounded 1-based line range from a file and is intended for large files where a full-file read would waste context or push a weaker local model into summary-only behavior.

After successful file edits, ManulAI also tries to run a stack-appropriate verification command automatically when the workspace provides one, instead of assuming every project is TypeScript-only.

### Safer Editing Behavior

The extension now pushes stricter file-editing rules into the agent prompt:

- make surgical edits for small requests instead of rewriting entire files
- never remove content that the user did not explicitly ask to remove
- prefer targeted replacement over full-file overwrite when possible
- read the file before editing so the model has the full structure
- do not claim a file changed unless a real tool changed it
- do not treat a failed replacement or failed terminal command as a completed fix
- do not stop on partial plans like `Step 1/3` when more reading or fixing is still required
- for ultra-small tiers, do not plan at all; execute one bounded action immediately
- do not declare success unless all required steps ran and the relevant tool calls succeeded
- do not modify a file before reading it first
- if unsure, read more files and gather more context instead of guessing
- for large refactor requests, inspect structure first, then split the work into small module/file steps instead of attempting a one-shot rewrite
- prefer `read_file_slice` over whole-file reads when a large file only needs bounded inspection
- do not leak raw or malformed tool-call JSON into fallback file writes; those responses are retried as tool calls instead of being treated as file content
- raw function-call text like `list_workspace_files()` or `create_or_edit_file(...)` is treated as a broken tool call and pushed back into recovery instead of being accepted as a final answer
- if a small or medium local model falls into repetitive garbage output, ManulAI retries once with a much stricter one-step recovery nudge instead of failing immediately
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
- `manulai.agentMode` — working mode: `chat` (plain text), `agent` (tool-enabled), or `planner` (condensed step-by-step planning with tools)
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
	"agentMode": "agent",
	"autoApprove": false,
	"debugMode": false,
	"systemPrompt": "You are ManulAI, a privacy-first local coding assistant running inside VS Code. Work across any programming language. Prefer precise, minimal changes and explain results clearly."
}
```

If an older workspace still has `manulai.*` values in `.vscode/settings.json`, ManulAI migrates those workspace values into `.manulai/settings.json` and clears the old workspace entries.

Default values:

- model: empty until you choose a local Ollama model
- Ollama base URL: `http://localhost:11434`
- agent mode: `agent`
- auto-approve: `false`
- debug mode: `false`

---

## Notes

- `icon.png` is used as the extension icon in the VS Code manifest
- `media/manulai-icon.svg` is used for the contributed sidebar container and view icon
- the project is intentionally Ollama-only and local-first
- workspace-owned ManulAI state lives under `.manulai/`; settings use `.manulai/settings.json`, chats use `.manulai/chats.json`, and debug logs use `.manulai/logs/` when the workspace is file-backed
- workspace-owned ManulAI state also includes per-chat notes under `.manulai/notes/` for persistent project memory scoped to each chat; notes are deleted when the chat is deleted
- chats now persist a compact per-chat summary memory in addition to the full transcript so future requests can reuse prior dialog outcomes without replaying the whole conversation
- the README describes current behavior and avoids cloud-oriented setup or product marketing fluff

---

## What's New

- **0.0.7:** Model simplification is now tied directly to the selected Ollama model size. Ultra-small models such as `0.5b` get a much smaller context window, a shorter agent/planner mandate, fewer injected workspace summaries/notes, tighter retry budgets, and a reduced tool menu focused on bounded reads plus surgical file edits. Small models around `1.5b` to `3b` also run with stepwise execution bias and lower read-loop thresholds. Raw function-call text like `list_workspace_files()` and `create_or_edit_file(...)` is now treated as recovery input instead of a final answer, ultra-small tiers have deterministic fast paths for very simple package.json reads, README title reads, exact-line replacements in known files, and single-file create requests, and degenerate repetitive output now gets one strict recovery retry before the runtime gives up. The standalone debug harness now uses the same model-size profile logic as the extension runtime. Packaging version updated to `0.0.7`.
- **0.0.6:** Workspace notes are now per-chat: each chat stores its own notes under `.manulai/notes/<chatId>.md` instead of a shared `.manulai/notes.md`. Notes are automatically deleted when the chat is deleted. The nudge system now detects conversational user messages (greetings, short non-actionable text) and skips action-forcing nudges so the model responds naturally instead of executing stale tasks from earlier context. Packaging version updated to `0.0.6`.
- **0.0.5:** Added Planner Mode as the third working mode alongside Chat and Agent — uses the same tools as Agent Mode but with a condensed step-by-step mandate; it can also answer direct text questions without requiring tool calls. Added `launch_in_terminal` tool for running interactive programs (games, REPLs, scripts needing user input) in a visible VS Code terminal instead of the non-interactive `execute_terminal_command`. Terminal command execution now detects timeout-killed processes and reports that stdin is unavailable, preventing futile retries of interactive programs. Context trimming is now model-aware: the sliding-window size and `num_ctx` sent to Ollama are derived from the model size tag (e.g. `:7b`, `:30b`) instead of using hardcoded limits. Large-refactor recovery is stricter for weaker local models. If the model keeps narrating the same `read_file_slice`, `create_or_edit_file`, or `replace_in_file` step instead of executing it, ManulAI can now auto-bootstrap the real tool call on the repeated response and continue the agent loop. Generated extraction output for Go and Rust is also screened harder before writes so obviously invalid cross-language blocks are rejected instead of being saved. Tool-call stripping in the response pipeline was tightened so only `json`, `tool_call`, and `tool` code blocks are removed instead of all fenced code blocks. Internally, the provider-side large-refactor/bootstrap helpers were split into a dedicated module to keep the production provider maintainable. Packaging version updated to `0.0.5`.
- **0.0.4:** Removed the separate Activity Bar launcher badge so ManulAI stays focused on the Secondary Sidebar chat view. The header and chat controls were compacted further, with chat creation and deletion moved next to the chat selector. Empty-model handling is now truthful instead of showing a fake fallback model, and revertable native file-tool transcript entries expose `Revert changes` again. Large files can now be read with bounded line slices through `read_file_slice`, and large refactor requests are nudged toward step-by-step module/file plans instead of whole-file summaries. Agent Mode now also exposes `project_scan`, `read_workspace_notes`, and `write_workspace_notes`, persists compact project notes in `.manulai/notes.md`, and stores short chat-summary memory so future requests can recover prior context with less re-reading. Packaging version updated to `0.0.4`. *(Note: `project_scan`, workspace notes, and chat-summary memory were first introduced in 0.0.4 and remain available in later versions.)*
- **0.0.3:** Debug JSONL entries now include the ManulAI extension version on every event, making mixed-log debugging across installed builds easier. Debug logs also capture user requests that enter the agent pipeline. The sidebar now supports creating, switching, deleting, and restoring multiple chats. File-backed workspaces persist chat state in `.manulai/chats.json`. Packaging version updated to `0.0.3`.
- **0.0.2:** Auto-retry without tools when the model does not support tool calling (HTTP 400 fallback). Diff markers no longer leak into written files. Destructive writes to critical files like `package.json` are blocked (invalid JSON, shell commands as content, suspiciously short content). Code block extraction now rejects diff-formatted blocks and shell command blocks during fallback file-write extraction. Raw or malformed JSON tool-call payloads are now retried as tool executions instead of being mistaken for file content. Edit transcripts now prefer diffs for existing-file changes instead of dumping full rewritten content. Project scan requests can attach a capped workspace snapshot. Tool results are visible in chat with terminal output and file previews. Multi-step actions can print progress while tools run. Edit requests can auto-discover likely files such as `README.md` when they are mentioned but not attached. `list_workspace_files` now handles absolute paths correctly. Debug logging uses stable JSONL session files under `.manulai/logs/` for file-backed workspaces. The sidebar UI is compacted further for narrow and low-height screens. Publisher ID updated to `manul-engine`.
- **0.0.1 (Alpha Release):** Initial public alpha with right-side chat UI, local Ollama integration, workspace file attachments, native tool-calling support, agent/chat mode separation, approval controls, directory listing and file deletion tools, and stricter prompt rules for safer file edits.

## License

This project is licensed under the Apache License 2.0.
See the `LICENSE` file included in the extension package for details.