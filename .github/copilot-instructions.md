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
- Preserve the distinction between Chat Mode, Agent Mode, and Planner Mode.
- In Chat Mode, never claim that files were created, modified, or deleted.
- Planner Mode uses the same tools as Agent Mode but with a condensed system mandate focused on step-by-step planning and execution.
- Planner Mode must still answer direct text questions without requiring tool calls.
- For small edit requests, prefer surgical edits over whole-file rewrites.
- Never delete unrelated file content when the user asked for a narrow change.
- Keep project-scan behavior persistent enough that the model can continue across multiple files instead of stopping after the first step.
- When the user references a likely target file such as `README`, `LICENSE`, `package.json`, or an explicit path, prefer resolving it automatically instead of waiting for manual attachment.
- Keep the sidebar usable on narrow widths and low-height laptop screens; preserve a visible scrollable chat history above the composer.
- Do not reintroduce a separate Activity Bar launcher container; keep ManulAI focused on the Secondary Sidebar chat view.

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
- Multiple chats may exist in memory during a session; keep transcript and attached-file context scoped to the active chat.
- Persist chat sessions for file-backed workspaces under `.manulai/` so they survive VS Code restarts; keep transcript and attached-file context scoped to the active chat.
- Dropped file context must remain visible in the UI and be forwarded to the model context.
- Tool results must be returned to Ollama using the native `tool` role flow.
- Agent Mode and Planner Mode should continue to support approvals, auto-approve, and fallback handling for weaker local models.
- Keep direct handlers and fallback layers conservative: fast for common edits, but not destructive.
- Treat unread files and unlisted project structure as unknown state; for edit tasks, require real tool-based inspection before claiming or applying a fix.
- Fallback layers must reject raw or malformed tool-call JSON leaked into assistant text or code blocks and retry via native tool execution instead of treating that payload as file content.
- Fallback file-write extraction must ignore shell-language fenced code blocks and reject suspicious pseudo-filenames such as numeric dotted names or names with trailing dots.
- Keep tool output visible in the chat transcript, including terminal stdout and stderr and previews for file writes.
- Prefer diff-style transcript output for existing-file edits; reserve full previews mainly for new files or initially empty files.
- Keep step-by-step progress messages visible in chat during multi-tool actions, but do not feed those local progress messages back into the next model request.
- Keep folder snapshot context distinct from file context so directories are never treated as editable files.
- Keep `list_workspace_files` compatible with both workspace-relative and absolute directory paths.
- Keep bounded file reading available for large files; prefer a line-range reader over full-file reads when only a section is needed.
- Keep debug JSONL entries attributable to a specific build; include the extension version in the logged session/event payloads.
- Keep debug logging useful for reproducing issues; log the original user request before local hidden nudges or retries alter the effective agent context.
- Keep the model selector truthful: when no local model is chosen, the UI and backend state must remain empty rather than showing a fake fallback model.
- Keep revert metadata attached to revertable native file-tool transcript entries so the webview can surface `Revert changes` directly on those results.
- If retry exhaustion is reached and the model still returns pseudo-progress or plan text, surface a deterministic backend failure message instead of leaking raw `Step 1/3`-style output.
- For large refactor requests, nudge the model toward short module/file plans and iterative execution instead of one-shot whole-file rewrites.
- Keep context trimming model-aware; derive sliding-window size and `num_ctx` from the model size tag rather than using hardcoded limits.
- Keep `num_ctx` always present in the Ollama request body so the runtime allocates an appropriate KV-cache window.

## Debug Script Parity

- `scripts/debug-agent.mjs` is the standalone test harness for the agent loop. Fixes validated there must be ported to `src/ManulAiChatProvider.ts` in the same change or immediately after.
- When a behavioral fix (hallucination detection, JSON parsing, fallback logic, nudge conditions) proves correct in `debug-agent.mjs`, treat it as a required backport — do not leave the production provider diverged.
- Keep helper logic (e.g. `escapeJsonStringValues`, analysis flags, done-condition guards) in sync between the two files; if a helper is added or changed in the debug script, update the provider counterpart.
- Keep tool definitions in `scripts/test-model.mjs` aligned with the extension's real parameter names (e.g. `filename` not `filepath` for `create_or_edit_file`).

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
- When responsive chat layout behavior changes, update the docs if the change affects visible UX constraints or implementation rules.
- When sidebar navigation or transcript revert behavior changes, update these instructions in the same change so workspace guidance stays aligned with the implemented UX.