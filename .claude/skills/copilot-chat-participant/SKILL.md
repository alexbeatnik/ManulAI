---
name: copilot-chat-participant
description: Guidelines for modifying the VS Code Chat participant (@manulai) in src/copilotChatParticipant.ts. Covers streaming, slash commands, auto-approve state, agent mode awareness, history handling, and keeping it independent from legacy code.
---

# copilot-chat-participant

The Copilot Chat participant provides the only chat surface in ManulAI. It streams Ollama responses into VS Code's native Chat panel.

## Scope

- `src/copilotChatParticipant.ts` — the participant handler and streaming logic.
- `src/ollamaStreamParser.ts` — shared stream parser (reasoning + content extraction).
- `package.json` — `chatParticipants` contribution.

## Rules

1. **Keep it self-contained.** The participant must not import or call into the deleted legacy provider files. It reads VS Code settings directly via `vscode.workspace.getConfiguration('manulai')`.
2. **Settings it reads:** `ollamaModel`, `ollamaBaseUrl`, `systemPrompt`, `debugMode`.
3. **Global state it reads/writes:** `agentMode` (key `manulai.agentModeState`) and `autoApprove` (key `manulai.autoApproveState`) live in `ExtensionContext.globalState`, NOT in VS Code settings. Toggled via `/setAgentMode` and `/toggleAutoApprove`. This keeps mode/approval toggles chat-local and fast.
4. **Agent mode injection.** The participant reads `agentMode` (string: `chat` | `agent` | `planner`) and appends a mode-specific sentence to the system prompt. The mode determines whether the agent loop sends a `tools` array to Ollama and whether file/terminal tools are executable.
5. **Streaming only.** The participant calls Ollama with `stream: true` and uses `OllamaStreamParser` to emit chunks in real time.
6. **Reasoning display.** When `chunk.reasoning` arrives, render it as a markdown blockquote (`> _Thinking…_`). When `chunk.content` starts after reasoning, close the blockquote with `\n\n` before emitting content.
7. **History filtering.** Only include turns where `turn.participant === 'manulai.manulai'` in the message history. Other participants' messages must be ignored to avoid context pollution.
8. **Slash commands.** Register commands in `package.json` under `chatParticipants[0].commands`. Handle them in the handler before the main chat flow. Current commands: `/selectModel`, `/model`, `/setAgentMode`, `/toggleAutoApprove`, `/instructions`, `/skills`.
9. **Cancellation.** Wire `token.onCancellationRequested()` to an `AbortController` and pass it to `fetch()`.
10. **Error handling.** Surface Ollama HTTP errors and fetch failures as markdown bold text in the chat response. Do not throw unhandled errors — they crash the participant silently.
11. **Tool execution.** Tools are dispatched through `src/agentExecutor.ts`, not inside the participant. Adding a new tool means adding a `case` in `executeTool()` there, not in the participant.

## Agent loop guards

The agent loop in `runAgentLoop()` enforces several invariants the participant relies on:

- **Refusal-detection nudge.** When the user prompt contains action verbs (create/edit/rename/fix/etc.) AND the model returns prose with zero tool calls AND no successful tool execution has occurred yet, inject a one-shot nudge before accepting it as a final answer. Tracked via `toolsExecutedAny` and `refusalNudgeFired`.
- **Per-turn tool cap.** `MAX_TOOLS_PER_TURN = 3`. When the model emits more, prioritise writes, then terminal, then reads.
- **Read-loop prevention.** `readFilesThisSession` set + `consecutiveReadOrListTurns` counter. Repeated reads of the same file get nudged; redundant `list_workspace_files` after `project_scan` is skipped; after 2 consecutive read-only turns, auto-bootstrap a user message forcing the model to write.
- **Duplicate-call detection.** Same `(tool, argsHash)` repeated more than `MAX_SAME_TOOL_REPEAT` times stops the loop with a deterministic error.
- **Model verification.** `verifyModelAvailable()` queries `/api/tags` before every request to catch missing models with a friendly error instead of an HTTP 500.
- **Loading-failure retry.** `fetchWithModelRetry()` retries Ollama HTTP 500/503 "model is loading" / "model failed to load" up to 3 times with backoff (3s/5s/7s), with OOM-fallback suggestions on exhaustion.
- **Conversation compaction.** When context-window truncation drops history, the dropped messages are summarised via a non-streaming `/api/chat` call and re-injected as `[Previous conversation summarized]: …` instead of being silently lost.

## Common mistakes

- Importing the deleted legacy provider files into the participant.
- Storing `agentMode` or `autoApprove` in VS Code settings instead of `globalState`.
- Forgetting to filter `context.history` by participant ID, causing Copilot or other participant messages to leak into Ollama context.
- Using `stream: false` — the participant must stream for real-time UX.
- Adding tool-dispatch logic directly in the participant. Tool dispatch belongs in `src/agentExecutor.ts`.

## Testing

Test the participant by:
1. Opening VS Code Chat panel (`Ctrl+Alt+I`).
2. Typing `@manulai hello`.
3. Confirming streaming text appears token by token.
4. Running `@manulai /setAgentMode planner` and confirming the next `@manulai` response reflects the new mode tone.
5. Running `@manulai /toggleAutoApprove` and `@manulai /model` to confirm state toggles and persists.
6. Canceling mid-stream and confirming no errors in Output channel "ManulAI Copilot".

For loop-level changes (refusal nudge, tool cap, read-loop, etc.), regression-test through the standalone harness instead of the live participant — see the `debug-agent-run` skill.
