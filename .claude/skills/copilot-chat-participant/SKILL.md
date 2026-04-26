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

1. **Keep it self-contained.** The participant must not import or call into legacy provider files (`ManulAiChatProvider.ts`, `provider*.ts`). It reads VS Code settings directly via `vscode.workspace.getConfiguration('manulai')`.
2. **Settings it reads:** `ollamaModel`, `ollamaBaseUrl`, `systemPrompt`, `agentMode`.
3. **Settings it ignores:** `debugMode` — participant-level debugging goes through the Output channel, not a setting.
4. **Auto-approve state.** Stored in `ExtensionContext.globalState` under key `manulai.autoApproveState`, NOT in VS Code settings. Toggle via `/toggleAutoApprove`. Read via `globalState.get<boolean>()`. This keeps the toggle chat-local and fast.
5. **Agent mode injection.** The participant reads `agentMode` (boolean legacy or string: chat/agent/planner) and appends a mode-specific sentence to the system prompt:
   - `agent`: "You are in Agent mode. You may suggest file edits, terminal commands, and browser automation steps, but you cannot execute them directly in this chat panel."
   - `planner`: "You are in Planner mode. Prefer concise, step-by-step responses."
   - `chat`: "You are in Chat mode. Answer questions and review code without suggesting file changes or tool calls."
6. **Streaming only.** The participant calls Ollama with `stream: true` and uses `OllamaStreamParser` to emit chunks in real time.
7. **Reasoning display.** When `chunk.reasoning` arrives, render it as a markdown blockquote (`> _Thinking…_`). When `chunk.content` starts after reasoning, close the blockquote with `\n\n` before emitting content.
8. **History filtering.** Only include turns where `turn.participant === 'manulai.manulai'` in the message history. Other participants' messages must be ignored to avoid context pollution.
9. **Slash commands.** Register commands in `package.json` under `chatParticipants[0].commands`. Handle them in the handler before the main chat flow. Current commands: `/selectModel`, `/model`, `/toggleAutoApprove`.
10. **Cancellation.** Wire `token.onCancellationRequested()` to an `AbortController` and pass it to `fetch()`.
11. **Error handling.** Surface Ollama HTTP errors and fetch failures as markdown bold text in the chat response. Do not throw unhandled errors — they crash the participant silently.

## Common mistakes

- Importing legacy provider files into the participant.
- Storing `autoApprove` in VS Code settings instead of `globalState`.
- Forgetting to filter `context.history` by participant ID, causing Copilot or other participant messages to leak into Ollama context.
- Using `stream: false` — the participant must stream for real-time UX.

## Testing

Test the participant by:
1. Opening VS Code Chat panel (`Ctrl+Alt+I`).
2. Typing `@manulai hello`.
3. Confirming streaming text appears token by token.
4. Changing agent mode in Settings and confirming the next `@manulai` response reflects the new mode tone.
5. Running `@manulai /toggleAutoApprove` and `@manulai /model` to confirm state toggles and persists.
6. Canceling mid-stream and confirming no errors in Output channel "ManulAI Copilot".
