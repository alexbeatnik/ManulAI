---
name: agent-instructions-reader
description: Guidelines for modifying the workspace agent instructions reader in src/agentInstructionsReader.ts. Covers file discovery, AGENTS.md/CLAUDE.md parsing, and injection into the Copilot Chat system prompt.
---

# agent-instructions-reader

`agentInstructionsReader.ts` discovers and reads agent instruction files (AGENTS.md, CLAUDE.md, etc.) from the workspace and injects them into the Copilot Chat system prompt.

## Scope

- `src/agentInstructionsReader.ts` — file discovery and reading utilities.
- `src/copilotChatParticipant.ts` — consumer that injects instructions into the system prompt.

## Search paths (in priority order)

The reader checks these paths relative to each workspace folder root:

1. `AGENTS.md`
2. `CLAUDE.md`
3. `.claude/AGENTS.md`
4. `.claude/CLAUDE.md`
5. `.github/copilot-instructions.md`
6. `.cursorrules`
7. `.ai/agents.md`
8. `docs/AGENTS.md`
9. `docs/CLAUDE.md`

First match wins per workspace folder. Use `readAllAgentInstructions()` to collect all matches.

## Rules

1. **Auto-inject on every chat.** When the participant builds the Ollama message list, it calls `readAgentInstructions()` before the system prompt is finalized. If a file is found, its content is appended to the system prompt with a source header.
2. **No caching.** Instructions are read fresh on every message so live edits to AGENTS.md take effect immediately.
3. **UTF-8 only.** Non-UTF-8 files are skipped; no encoding detection.
4. **Silent on missing files.** If no instruction file exists, the chat proceeds normally with only the base system prompt.
5. **Source attribution.** `formatInstructionsForPrompt()` prepends `[Instructions from <path>]` so the model knows where the context came from.
6. **Size limits.** The raw file content is injected as-is; very large instruction files will consume context window. There is no automatic truncation yet.

## Slash command

`/instructions` — shows the user which file was found and a 500-character preview of its content.

## Common mistakes

- Adding a search path that is too generic (e.g., `README.md`) — would pollute the system prompt with unrelated content.
- Forgetting that the reader scans **all** workspace folders in a multi-root workspace.
- Expecting the instructions to persist across VS Code restarts — they are read from disk every time.

## Testing

Test by:
1. Creating an `AGENTS.md` in the workspace root with a short instruction.
2. Typing `@manulai hello` and confirming the response follows the instruction.
3. Running `@manulai /instructions` to confirm the file is detected.
4. Renaming the file to `CLAUDE.md` and confirming it is still found.
