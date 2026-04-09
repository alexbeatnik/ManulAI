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
- In Chat Mode, answer direct code-explanation or review requests in plain text; reserve `Old` / `New` suggestion format for explicit visible-snippet edit requests.
- In Chat Mode, do not return full file dumps for create-file requests; give brief manual guidance or a minimal one-file starter only when explicitly asked.
- Planner Mode uses the same tools as Agent Mode conceptually but may expose a reduced tool subset for very small local models; its system mandate stays condensed and step-by-step.
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
- Keep the built-in model picker focused on the currently validated local agent models unless explicit testing proves a new family reliable enough to surface by default. Other installed Ollama models may still be shown underneath for manual selection and testing, but they should not displace the validated families from the top of the picker.
- Treat the current validated baseline as `phi4-mini:3.8b`, `llama3.1:8b`, `qwen3-coder:30b`, `gemma4:latest`, and `gemma4:31b`, based on direct Ollama `/api/chat` checks plus standalone agent-loop testing rather than picker assumptions alone.
- `gemma4` models use the `useTextTools: true` profile flag because Ollama 0.20.0 does not support native tool calling for thinking models — the backend returns empty responses when a `tools` array is present. The fix injects tool descriptions in the system prompt as text and parses `{"tool": "name", "args": {...}}` JSON from the model's text content instead of native tool_calls.
- `gpt-oss:20b` may be tested manually, but do not add it to the built-in picker baseline until its agent/planner create and edit loops stop failing on malformed or truncated tool-call behavior.
- Keep the one-shot transient Ollama fetch retry and explicit create-only early-completion behavior in sync between `scripts/debug-agent.mjs` and `src/ManulAiChatProvider.ts`; if a requested explicit create-only target set was already written successfully, do not force an extra model turn just for a completion sentence.
- Keep revert metadata attached to revertable native file-tool transcript entries so the webview can surface `Revert changes` directly on those results.
- If retry exhaustion is reached and the model still returns pseudo-progress or plan text, surface a deterministic backend failure message instead of leaking raw `Step 1/3`-style output.
- For explicit multi-file write requests, do not accept final completion text until the recorded successful file-tool writes cover every requested target file.
- For explicit file-path create requests, recover weak-model shallow or wrong-directory writes back toward the exact requested targets when that mapping is unambiguous.
- For large refactor requests, nudge the model toward short module/file plans and iterative execution instead of one-shot whole-file rewrites.
- Keep context trimming model-aware; derive sliding-window size and `num_ctx` from the model size tag rather than using hardcoded limits.
- Keep prompt/context simplification model-aware too: ultra-small models should receive shorter mandates, less injected workspace memory, tighter retry budgets, and fewer tools when that improves reliability.
- Keep preferred stronger local models (`phi4-mini`, `llama3.1`, `qwen3-coder`, `gemma4`) on model-specific profiles that bias toward one-step execution and concrete file creation over unnecessary project scans for greenfield tasks.
- Keep exact `package.json` name/version reads and `README.md` title reads eligible for deterministic direct handling across model tiers when the target file is obvious.
- For preferred-model greenfield tasks, reject shallow placeholder scaffolds including trivial `...` dumps, reject overly thin first source files, recover valid plain-text code dumps into real file writes when that is safer than another retry loop, do not allow `execute_terminal_command` before the first real source-file write or immediately after the first successful `create_or_edit_file`, keep arbitrary terminal commands blocked until the latest greenfield write passes syntax verification, and reject global package installs from the agent loop; require another real file/tool step or a direct completion instead.
- Do not re-surface weaker `qwen2.5-coder` tiers in the built-in picker without new validation showing stable tool-loop behavior; partially acceptable raw code generation alone is not enough.
- For ultra-small model tiers, prefer no-plan execution: one immediate bounded action instead of showing or accepting a plan.
- Raw function-call assistant text such as `tool_name(...)` must not be accepted as a final answer; route it through native-tool recovery or continue nudging until a real tool call happens.
- If a small or medium local model produces degenerate repetitive output, do not fail immediately on the first hit; strip the bad output and retry once with a stricter one-step recovery nudge.
- Keep `num_ctx` always present in the Ollama request body so the runtime allocates an appropriate KV-cache window.
- Keep `execute_terminal_command` documented as having no stdin; interactive programs must use `launch_in_terminal` which opens a real VS Code terminal.
- When `execute_terminal_command` times out because the child process was killed, the error must hint that stdin is unavailable and the program should not be retried.
- Keep workspace notes per-chat: store under `.manulai/notes/<chatId>.md` and delete the notes file when the chat is deleted.
- When the latest user message is conversational (greeting, small talk) and no tools were called in the current exchange, do not nudge the model to execute stale tasks from earlier context; let it respond naturally.
- Keep browser-automation hunt saving confirmation-gated: `manul_save_hunt` must be rejected unless the latest visible user message explicitly asks to save the `.hunt` file or directly affirms the immediately preceding save question.
- When a Manul session already has executed steps, prefer returning `hunt_proposal` / `_nextAction` hints from VERIFY-completion and `manul_get_state` flows so the model stops after the goal is verified instead of replaying earlier navigation/click steps.

## Debug Script Parity

- `scripts/debug-agent.mjs` is the standalone test harness for the agent loop. Fixes validated there must be ported to `src/ManulAiChatProvider.ts` in the same change or immediately after.
- When a behavioral fix (hallucination detection, JSON parsing, fallback logic, nudge conditions) proves correct in `debug-agent.mjs`, treat it as a required backport — do not leave the production provider diverged.
- Keep helper logic (e.g. `escapeJsonStringValues`, analysis flags, done-condition guards) in sync between the two files; if a helper is added or changed in the debug script, update the provider counterpart.
- Keep tool definitions in `scripts/test-model.mjs` aligned with the extension's real parameter names (e.g. `filename` not `filepath` for `create_or_edit_file`).

## Documentation

- Keep README accurate when behavior or setup changes.
- Keep `README-dev.md` accurate when architecture, tools, or safety behavior changes.
- When packaging version changes, update `package.json`, `package-lock.json`, `README.md`, and `README-dev.md` in the same change.
- Keep wording direct and technical.
- Keep README tone alpha-stage and avoid marketing fluff.
- User-facing README should describe ManulAI primarily as a local AI assistant for Ollama inside VS Code.
- Avoid adding unnecessary installation/setup sections to the user-facing README unless behavior changes require them.
- Keep the `What's New` section at the bottom of the README, immediately before `License`.
- When tool lists change, update user-facing docs and developer docs in the same change.
- When agent reliability or context-handling behavior changes, update README, README-dev, and these instructions in the same change.
- When responsive chat layout behavior changes, update the docs if the change affects visible UX constraints or implementation rules.
- When sidebar navigation or transcript revert behavior changes, update these instructions in the same change so workspace guidance stays aligned with the implemented UX.