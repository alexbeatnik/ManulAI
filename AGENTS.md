# ManulAI Agent Instructions

You are a Principal TypeScript Engineer working on **ManulAI**, a local AI coding assistant VS Code extension powered by Ollama.

## Core Philosophy

1. **Air-Gap by Design:** ManulAI never initiates network requests to any external host except the local Ollama server (`http://localhost:11434`). No telemetry, no cloud APIs, no tracking.
2. **Local-First:** All model execution stays on the user's machine via the local Ollama runtime.
3. **Minimal Edits:** Keep changes surgical. Never rewrite whole files when a targeted edit suffices.
4. **TypeScript Strict:** All code is TypeScript with `strict: true`. Avoid `any` unless interfacing with untyped external data.
5. **Alpha Stage:** APIs and behavior may change. Never imply production guarantees.

## Build & Test Commands

```bash
# Compile TypeScript
npm run compile

# Watch mode
npm run watch

# Lint
npm run lint

# Run tests
npm run test

# Package VSIX
npx vsce package --no-yarn

# Install locally
code --install-extension manulai-local-agent-*.vsix
```

## Architecture

```
src/
  extension.ts              # Activation, command registration, participant + settings wiring
  copilotChatParticipant.ts # VS Code Chat participant (@manulai) for native Chat panel
  settingsPanel.ts          # Activity Bar settings webview (model picker with /api/tags fetch)
  ollamaStreamParser.ts     # NDJSON stream parser with <think> reasoning extraction
  types.ts                  # Shared types
media/
  manulai-icon.svg          # Extension icon
```

### Chat Surface

ManulAI exposes a **single chat surface**: the **Copilot Chat Participant** (`@manulai`).

- It streams Ollama responses into the native VS Code Chat panel.
- Supports slash commands: `/selectModel`, `/model`, `/toggleAutoApprove`.
- Reads global VS Code settings: `ollamaModel`, `ollamaBaseUrl`, `systemPrompt`, `agentMode`.
- Auto-approve state is stored in `ExtensionContext.globalState` (not settings), toggled via `/toggleAutoApprove`.
- Implemented by `copilotChatParticipant.ts`.

### Settings Panel

- Activity Bar `WebviewViewProvider` (`manulai.settings`).
- Fetches model list from Ollama `/api/tags` on load and refresh.
- Controls: model dropdown, base URL, agent mode, system prompt, debug mode.
- Writes to global VS Code settings (`ConfigurationTarget.Global`).

### Streaming & Reasoning

`ollamaStreamParser.ts` parses Ollama NDJSON streams and extracts:
- `content` from `message.content`
- `reasoning` from `<think>...</think>` tags inside content

## Code Style

- Use TypeScript with strict typing.
- Keep edits minimal and focused.
- NEVER use backslash-quote escaping (`\"` or `\'`) inside JavaScript template literals for inline webview scripts.
- Prefer `vscode.workspace.fs` for file operations.
- Prefer `replace_in_file`-style targeted edits when changing existing file content.
- Add comments only when they clarify non-obvious logic.

## Product Constraints

- Extension must work for any programming language opened in VS Code.
- The Settings panel must stay in the Activity Bar (`manulaiActivityBar`).
- The chat participant must stream responses for real-time UX.
- Reasoning blocks (`<think>`) must render as live blockquotes before the answer.

## Skill Navigation

Read the relevant skill file **before** making changes to related systems.

| Area | Skill file |
|------|-----------|
| Copilot Chat participant, `@manulai`, streaming | `.claude/skills/copilot-chat-participant/SKILL.md` |
| Settings panel, Activity Bar webview | `.claude/skills/settings-panel/SKILL.md` |
| Ollama streaming, reasoning extraction | `.claude/skills/ollama-streaming/SKILL.md` |
| Packaging, versioning, VSIX build | `.claude/skills/extension-packaging/SKILL.md` |
| Version bump + docs sync | `.claude/skills/bump-version/SKILL.md` |
| Pre-commit docs sanity check | `.claude/skills/verify-docs-sync/SKILL.md` |

## Doc Sync Rule

When updating a feature's documentation, keep **all** of these in sync: `README.md`, `README-dev.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, and `AGENTS.md`. A feature documented in one but not the others is a documentation bug.

## Token Optimization

Keep responses concise and go straight to implementation.
