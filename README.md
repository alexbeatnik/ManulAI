# ManulAI Local Agent

![Alpha](https://img.shields.io/badge/status-alpha-bf5b04)
![Manul Product Line](https://img.shields.io/badge/product%20line-Manul-111827)

ManulAI is a **local AI coding assistant for VS Code** built on top of Ollama. It runs as a native Copilot Chat participant — no separate panels, just type `@manulai` in the Chat panel.

![ManulAI Copilot Chat](media/screenshots/Chat.png)

## Quick Demo

### Hands-On In VS Code

```bash
ollama serve
ollama pull qwen3-coder:30b
```

Open VS Code, install the ManulAI extension, then open the Chat panel (`Ctrl+Alt+I` / `Cmd+Alt+I`) and type:

```text
@manulai hello
```

Streaming response appears token-by-token, including live **reasoning** blocks for thinking models.

### Chat, Agent, Planner

ManulAI supports three modes, toggled via chat commands:

- **Chat**: plain text only. Use it for explanation, review, and discussion.
- **Agent**: the model may suggest file edits, terminal commands, and browser automation steps.
- **Planner**: concise, step-by-step responses with smaller deliberate actions.

### Slash commands

| Command | Description |
|---------|-------------|
| `/selectModel` | Open the model picker |
| `/model` | Show active model, agent mode and auto-approve status |
| `/setAgentMode <chat\|agent\|planner>` | Switch agent mode |
| `/toggleAutoApprove` | Toggle auto-approve |
| `/instructions` | Show loaded workspace agent instructions |
| `/skills` | Show loaded workspace skills |

### Workspace agent instructions

ManulAI automatically reads agent instruction files from your workspace and injects them into every chat request. Supported file names (searched in this order):

- `AGENTS.md`
- `CLAUDE.md`
- `.claude/AGENTS.md`
- `.claude/CLAUDE.md`
- `.github/copilot-instructions.md`
- `.cursorrules`
- `.ai/agents.md`
- `docs/AGENTS.md`
- `docs/CLAUDE.md`

Place an `AGENTS.md` in your project root to give the model context about your codebase conventions, architecture, or rules.

### Workspace skills

ManulAI also reads **skills** from your workspace and injects them into every chat request. Skills are markdown files with YAML frontmatter (`name`, `description`) stored in skill directories:

- `.claude/skills/<skill-name>/SKILL.md`
- `skills/<skill-name>/SKILL.md`
- `.github/skills/<skill-name>/SKILL.md`
- `.ai/skills/<skill-name>/SKILL.md`

Example skill file:

```markdown
---
name: my-project-rules
description: Guidelines for working with this codebase
---

# my-project-rules

1. Always use TypeScript strict mode.
2. Prefer functional components over class components.
```

Use `@manulai /skills` to see which skills are currently loaded.

### Settings panel

Click the **ManulAI** icon in the Activity Bar to open Settings:

![ManulAI Settings](media/screenshots/Settings.png)

The panel automatically fetches installed Ollama models from `/api/tags`. You can also:
- Update the Ollama base URL
- Edit the system prompt
- Toggle debug mode

The Settings view is also reachable via the **ManulAI: Open Settings** command.

### Integration Patterns

#### Embed ManulAI Into Another VS Code Extension Or Web IDE

Use ManulAI as the execution layer while your product owns the surrounding UI, approvals, and workflow triggers. The core pattern is: collect workspace context, send a bounded request, expose only the tools you want, and render tool output back into your own product surface.

```ts
type ProductTask = {
  prompt: string;
  mode: 'chat' | 'agent' | 'planner';
  allowedTools: string[];
};

const task: ProductTask = {
  prompt: 'Scan this workspace and summarize release risks.',
  mode: 'planner',
  allowedTools: ['project_scan', 'read_file_slice', 'read_workspace_notes']
};

console.log('Dispatch task to local ManulAI runtime', task);
```

Outcome: **your product gets a workspace-aware local assistant without needing to build a full agent loop from scratch.**

#### Run ManulAI In CI For Structured Reports

Use ManulAI as a local analysis step that reads the repo, produces structured output, and hands the result to downstream policy or reporting systems.

```bash
ollama serve &
npm ci
npm run compile
node scripts/debug-agent.mjs --prompt "Run project_scan and return a structured JSON report of entry points, frameworks, and likely risk areas."
```

Outcome: **CI gets a local workspace summary that can feed release checks, dashboards, or internal reporting pipelines.**

#### Power A Product Support Assistant

Use ManulAI to read docs, README files, and targeted source files before suggesting a fix path to support or solution-engineering teams.

```text
Read README.md, README-dev.md, and the provider entrypoints, then suggest the smallest safe fix for a failing tool-call workflow.
```

Outcome: **support teams get product-aware guidance grounded in real repo content instead of generic model guesses.**

## Integration And Extension Points

### Local Ollama Integration

ManulAI talks to **your local Ollama runtime** through `/api/chat` and keeps model selection explicit. The extension is intentionally **Ollama-only** and does not add a cloud AI dependency.

- Local runtime: `http://localhost:11434` by default
- Recommended baseline models: `phi4-mini:3.8b`, `llama3.1:8b`, `qwen3-coder:30b`, `gemma4:latest`, `gemma4:31b`
- `gemma4` models use a text-tool fallback because native tool calling is currently unreliable in Ollama for those thinking models

### Tool Surface

ManulAI exposes a practical local tool layer for product use:

- `read_active_file`
- `read_specific_file`
- `read_file_slice`
- `create_or_edit_file`
- `replace_in_file`
- `execute_terminal_command`
- `launch_in_terminal`
- `delete_file`
- `list_workspace_files`
- `project_scan`
- `read_workspace_notes`
- `write_workspace_notes`
- `manul_run_step`
- `manul_run_goal`
- `manul_scan_page`
- `manul_read_page_text`
- `manul_get_state`
- `manul_save_hunt`
- `manul_run_hunt`
- `manul_run_hunt_file`

For product deployments, the important pattern is not just the tools themselves, but **which tools you expose to which workflow**.

Recommended restrictions:

- **Docs assistant**: `project_scan`, `read_specific_file`, `read_file_slice`
- **Guided editor flow**: add `replace_in_file`, `create_or_edit_file`
- **Controlled automation**: add `execute_terminal_command` only behind approvals
- **Browser automation**: enable `manul_*` tools only when ManulEngine is installed and the workflow explicitly needs it

### Workspace State

File-backed workspaces store ManulAI state under `.manulai/`:

- `.manulai/settings.json`: workspace-level settings
- `.manulai/chats.json`: persisted chat sessions
- `.manulai/notes/<chatId>.md`: per-chat notes and memory
- `.manulai/logs/`: debug JSONL logs when debug mode is enabled

This makes ManulAI easier to integrate into product workflows because state is **file-backed, inspectable, and scriptable**.

### Webhook And CLI Patterns For CI

ManulAI itself is a VS Code extension, but product teams can still use its surrounding runtime patterns in CI and internal tooling:

1. Start Ollama locally on the runner.
2. Open the workspace in a controlled extension host or use the debug harness.
3. Run `project_scan` or bounded read tasks.
4. Capture JSON or transcript output.
5. Feed the result into policy checks, dashboards, or release reports.

Example structured scan pattern:

```bash
node scripts/debug-agent.mjs \
  --prompt "Run project_scan and return only JSON with entryPoints, frameworkHints, importantModules, and risks." \
  > manulai-project-scan.json
```

Outcome: **downstream tooling receives machine-consumable output from a local, workspace-aware agent step.**

## Safety, Auditability, And Operational Controls

ManulAI is designed to be useful in real product environments, not just interactive demos.

- **Recommended: `autoApprove = false`** for any workflow that can write files or run commands.
- **Manual approval support** lets teams gate tool execution before a file write or terminal action happens.
- **Command blocklist** rejects dangerous shell patterns such as destructive deletes, pipe-to-shell installers, privileged commands, and machine-level shutdown/reboot operations.
- **Debug JSONL logs** capture user requests, tool calls, fallback decisions, and runtime behavior for local inspection.
- **Model-aware context trimming** keeps smaller local models usable by reducing context and tool scope instead of overwhelming them.
- **Revertable edits** keep snapshots so transcript-visible file changes can be rolled back.
- **Per-chat notes** preserve important project facts without replaying the full history every time.
- **Safe editing behavior** prefers read-before-edit, bounded reads, targeted replacements, and visible tool output over blind rewrites.

For product deployments, policy enforcement usually means:

- keep a curated local model list
- disable or gate terminal tools
- keep debug logging on in non-production evaluation environments
- require manual approval for file mutations
- restrict browser automation tools to explicitly provisioned environments

## Quickstart For Product Teams

### Runtime Setup

Install Ollama and a supported local model:

```bash
ollama serve
ollama pull qwen3-coder:30b
```

Optional browser automation runtime:

```bash
pip install manul-engine
playwright install
```

No separate `manul serve` process is required in the extension workflow. ManulAI launches its bundled Python bridge on the first `manul_*` tool call.

Build the extension locally:

```bash
npm ci
npm run compile
```

### Recommended Workspace Defaults

Create `.manulai/settings.json`:

```json
{
  "ollamaModel": "qwen3-coder:30b",
  "ollamaBaseUrl": "http://localhost:11434",
  "agentMode": "agent",
  "autoApprove": false,
  "debugMode": true,
  "systemPrompt": "You are ManulAI, a local product-grade coding assistant. Prefer bounded reads, precise edits, visible tool results, and safe execution."
}
```

Recommended defaults for product integration:

- **default: local models only**
- **recommended: `autoApprove = false`**
- **recommended: `debugMode = true` in evaluation and CI**
- **recommended: start with `planner` for new gated flows**

### Headless Project Scan For CI Consumption

Use the regression/debug harness to run a local scan and capture output:

```bash
ollama serve &
node scripts/debug-agent.mjs \
  --prompt "Run project_scan and return JSON only with languageHints, frameworkHints, entryPoints, importantModules, and risks." \
  > artifacts/manulai-scan.json
```

Outcome: **your CI job gets a local JSON artifact that other tools can parse without exposing repo code to a hosted AI service.**

## Ecosystem And Examples

### VS Code Extension

ManulAI is a native VS Code Copilot Chat participant (`@manulai`) powered by local Ollama models:

- Chat, Agent, and Planner modes
- Streaming responses with live reasoning blocks
- Local Ollama model selection via Settings panel
- Activity Bar settings for quick configuration

### MCP And Programmatic Control Patterns

For product teams that need automation beyond the chat UI, the practical approach is to use the same local patterns ManulAI uses internally: scoped tools, predictable outputs, local files as state, and explicit approvals. ManulAI also integrates with ManulEngine for browser automation through a local bridge.

Example MCP-style bridge usage pattern:

```ts
async function requestWorkspaceSummary() {
  return {
    tool: 'project_scan',
    args: {},
    policy: {
      allowWrites: false,
      allowTerminal: false
    }
  };
}
```

Example browser automation bridge pattern:

```ts
const huntRequest = {
  tool: 'manul_run_goal',
  args: {
    goal: 'Open the docs site, search for API keys, and verify that the settings page mentions local models only.',
    title: 'docs_local_model_check',
    context: 'Validate docs messaging for product release readiness'
  }
};

console.log(huntRequest);
```

Example Python-side runtime bootstrap for internal tooling:

```bash
pip install manul-engine
playwright install
python -c "from manul_engine import ManulSession; print('manul-engine ready')"
```

Outcome: **teams can embed local agent behavior into IDEs, dashboards, QA flows, and automation surfaces without changing the local-first operating model.**

## Contribute And Deploy

Product teams extending ManulAI typically do three things:

- add curated model profiles for their local environment
- narrow or expand the exposed tool surface for a specific workflow
- package the extension and settings for internal distribution

Useful local commands:

```bash
npm run compile
npm run lint
npm run test
node scripts/debug-agent.mjs
node scripts/run-regression-matrix.mjs
```

Deployment notes:

- keep internal builds pinned to validated local model families
- test new prompts and tool policies through the regression harness before rollout
- update `README.md`, `README-dev.md`, and versioned packaging metadata together when product behavior changes
- prefer incremental tool and policy changes over broad prompt rewrites

## Try It In Your Product Workflow

Run ManulAI locally, point it at a real workspace, and evaluate it against an actual product task: repo triage, release-readiness scanning, guided documentation support, or safe file editing inside an internal IDE flow.

- Marketplace: https://marketplace.visualstudio.com/items?itemName=manul-engine.manulai-local-agent
- Open VSX: https://open-vsx.org/extension/manul-engine/manulai-local-agent
- GitHub: https://github.com/alexbeatnik/ManulAI
- Docs: https://github.com/alexbeatnik/ManulAI/blob/main/README-dev.md
- Enterprise integration guidance: https://github.com/alexbeatnik/ManulAI/issues

## What's New

- **0.0.15:** Model availability verification and loading resilience. Before every request, ManulAI now queries Ollama `/api/tags` to confirm the selected model is actually installed locally. If the model is missing, the user gets a clear "Model not found" message with instructions to pull the model or select a different one — instead of a cryptic HTTP 500. Added automatic retry with exponential backoff (3s / 5s / 7s, up to 3 retries) for transient Ollama HTTP 500/503 "model failed to load" / "model is loading" errors. If retries are exhausted, a user-friendly diagnostic message explains possible causes (insufficient RAM/VRAM, model still downloading, GPU contention) and suggests next steps. **Smart OOM fallback:** when a large model (15B+ parameters) fails to load due to memory limits, ManulAI automatically checks which smaller models are already installed and recommends them inline — e.g. "You already have smaller models installed: `qwen3-coder:8b`, `phi4-mini:3.8b`". If no smaller model is installed, it suggests lightweight alternatives with approximate RAM requirements. Covers both streaming chat and non-streaming compaction calls. **Read-loop prevention:** Added tracking of read files per session with early nudges when the model tries to read the same file twice. Redundant `list_workspace_files` calls are automatically blocked after `project_scan` since the full directory tree is already known. Auto-bootstrap triggers after 2 consecutive read-only turns: the agent injects a user message forcing the model to stop reading and create the requested file. This prevents models like `qwen3-coder:30b` from getting stuck in read loops instead of executing write operations. **Tool limit:** Maximum 3 tools per turn to prevent context explosion from models attempting to read dozens of files simultaneously. **Auto-generated plan UI:** When a model outputs tool calls without explanatory text, ManulAI automatically generates a human-readable plan from the tool calls and displays it in chat (e.g. "📖 Reading `README.md`", "📝 Creating `description.md`"). This gives users visibility into what the agent is doing even when the model itself doesn't narrate its actions. **Clean agent UI:** Raw tool JSON is hidden from chat in agent/planner modes; only human-friendly tool results are shown. Packaging version updated to `0.0.15`.
- **0.0.14:** Full agent tool execution with human-friendly output. ManulAI now executes tools in Agent and Planner modes: `create_or_edit_file`, `replace_in_file`, `read_specific_file`, `execute_terminal_command`, and more. Tool results are shown in a human-readable format — created files display content with syntax highlighting, file edits show a diff view, and reads/terminal commands show concise summaries. Added automatic context-window management per model (256K for Gemma 4, 128K for Llama/Qwen, etc.) with history truncation. Workspace skills are now read from `.claude/skills/`, `skills/`, `.github/skills/`, and `.ai/skills/` directories and injected into the system prompt. Added loop detection to stop infinite tool-call cycles. Added interactive ✅ Approve / ❌ Decline buttons in chat for tool approval. Agent mode now defaults to auto-approve. Rewrote `scripts/debug-agent.mjs` to match the new architecture with streaming, tool execution, and context truncation. New source files: `src/agentExecutor.ts` (tool execution), `src/modelContextConfig.ts` (context window mapping), `src/skillsReader.ts` (skill discovery). Agent loop now stops immediately after any successful terminal command to prevent unnecessary post-completion reads and tool calls. Terminal command execution auto-retries `git push` with `--set-upstream` when the error indicates no upstream branch. Added debug JSONL logging to the Copilot Chat participant (`@manulai`) — when `debugMode` is enabled, detailed event logs are written to `.manulai/logs/YYYYMMDD-HHMMSS.jsonl` covering user requests, Ollama calls, tool executions, context trims, loop detection, and agent stops. Added conversation compaction: when the context window fills up, old history is summarized via Ollama into compact memory instead of being silently dropped, preserving critical context across long sessions. **Safety hardening:** Expanded command blocklist (`isBlockedCommand`) to cover `rm -rf` variants targeting system directories (`/usr`, `/etc`, `/var`, `/bin`, `/sbin`, `/lib`, `/boot`, `/sys`, `/dev`, `/proc`, `/tmp`, `/*`), `poweroff`, `halt`, `kill -9`, `pkill`, `killall`, `init 0/6`, `systemctl poweroff/reboot`, `dd of=/dev/`, device file writes, global package uninstalls (`npm -g uninstall`, `pip uninstall` without `--user`), and more. Added `isBlockedFilePath` guard that blocks writes, edits, and deletes targeting system paths, the home directory root, the workspace root, and critical project files (`.git/`, `package.json`, `tsconfig.json`, `Dockerfile`, `Cargo.toml`, `go.mod`, `.env`, `LICENSE`, `README.md`, `CLAUDE.md`, `AGENTS.md`, and 30+ others). **Model loading resilience:** Added automatic retry with exponential backoff for Ollama HTTP 500/503 "model failed to load" and "model is loading" errors. Retries up to 3 times with delays of 3s/5s/7s before surfacing a user-friendly diagnostic message with troubleshooting steps. Applies to both streaming chat and non-streaming compaction calls. Packaging version updated to `0.0.14`.
- **0.0.13:** Copilot Chat integration and settings panel. ManulAI now registers as a native VS Code Chat participant (`@manulai`) so you can chat with your local Ollama model directly in the Copilot Chat panel. Streaming responses are rendered token-by-token, including live reasoning blocks extracted from `<think>` tags for thinking models. Added a dedicated Settings webview in the Activity Bar (`manulai.settings`) for quick access to model, base URL, agent mode, system prompt, auto-approve, and debug toggles. New source files: `src/copilotChatParticipant.ts` (chat participant handler), `src/settingsPanel.ts` (settings UI), and `src/ollamaStreamParser.ts` (streaming + reasoning extraction). Updated `src/extension.ts` and `package.json` to register the participant and views. Packaging version updated to `0.0.13`.
- **0.0.12:** Extension hardening and documentation sync. The webview message handler now guards against unhandled Promise rejections and use-after-dispose races, so a crashed handler or late message cannot wedge the chat UI. `dispose()` now resolves any pending approval Promise before tearing down, preventing the extension from hanging if the user had an open approval dialog during deactivation. The `ManulBridge` Python subprocess is also explicitly disposed on provider teardown instead of relying only on the constructor subscription. `getWebviewHtml` is now crash-protected: if `media/webview.html` is missing or unreadable it returns a minimal error page instead of crashing the extension host. `refreshModelCatalog` now defensively skips malformed `/api/tags` entries instead of assuming every array element is a valid object. Agent-recovery hardening: `recoverRequestScopedCreateTargetPath` no longer fires on EDIT tasks, so when the model hallucinates an unrelated filename (e.g. `.gitignore`) with unrelated content, the write is not silently redirected to an existing edit target and corrupted with that unrelated content — recovery now only applies in explicit-create, preferred-greenfield, or large-refactor flows where the model's content is semantically about the requested target. The read-loop nudge that tells the model "you have enough context, stop reading" now requires at least one SUCCESSFUL read; previously `totalReadOps` included ENOENT failures, so a model that kept hallucinating the wrong path was told to produce an answer from context it never actually obtained. A matching `successfulReadOps` counter is tracked alongside `totalReadOps`. `scripts/debug-agent.mjs` received the same recovery gate, plus two harness-only fixes: the trivial-single-line `replace_in_file` rejection ("not a valid extraction step") is now gated on `IS_SPLIT_TASK` so ordinary surgical one-line edits are no longer blocked for non-split flows, and the bare-mention `read_specific_file` fallback (which defaulted the filepath to `TARGET_FILE` when only the tool name appeared in text) is also gated on `IS_SPLIT_TASK`, preventing unrelated reads of `src/ManulAiChatProvider.ts` from being injected into non-split tasks. Cross-variation root-command failure detector added: the existing failed-command tracking clustered only by exact-normalized command string, so a model that varied flags across retries (`npx tailwindcss init -p` → `npx tailwindcss init` → `npm install -g tailwindcss`) would never trip the repeat guard even though every attempt was hitting the same root cause (Tailwind v4 removed the `init` CLI). A new tracker keys failures by a root signature extracted from the first token or the runner+subject pair (`npx <pkg>`, `npm <subcommand>`, `pip install`, `cargo run`, etc.); once the same root signature fails across 2+ distinct argument variations, a single nudge is emitted telling the model to stop varying arguments and switch approach (read the installed package's docs/`bin` field, write the config manually, or use a different integration). Tracking is reset per user request and cleared on any successful run of the same root so the detector never punishes legitimate follow-up commands. New `CLAUDE.md` created at repository root and `.github/copilot-instructions.md` updated to reflect version `0.0.12`, adding the **Air-Gap Law** (no external network except local Ollama), **Fetch Law** (validated base URL + AbortController watchdogs), and **Memory Law** (dispose timeouts, aborts, approvals, bridge, and terminals). Packaging version updated to `0.0.12`.
- **0.0.11:** LLM interaction layer hardening. Ollama HTTP calls now run under a hard watchdog timeout (600s for `/api/chat`, 20s for `/api/tags`) wired into a dedicated `AbortController` so a hung daemon surfaces a user-readable timeout error instead of pinning the chat forever. The retry path in `fetchOllamaChatResponse` was upgraded from a single fixed 700ms retry to two retries with exponential backoff and jitter, and the transient-error classifier now also catches timeout-originated aborts, `undici` fetch-error causes, and HTTP 503 "model is loading"-style responses. The 503 backoff was further tuned to use a longer model-loading curve (5s / 10s / 20s with jitter, capped at 20s) instead of the short network-retry curve, so cold starts on large models (gemma4:31b, qwen3-coder:30b, llama3.1:70b) no longer fail spuriously while Ollama is still loading weights from disk. Context-window overflow is now recovered instead of thrown: when Ollama returns an HTTP 500/413 whose body names a context/token limit, `callOllama` performs an in-place emergency trim (keep system prompts + halve the retained tail, strip `tool_calls` from the boundary assistant) and retries once. The pre-call sliding-window trim in `processOllamaResponse` was also hardened to strip dangling `tool_calls` off the boundary assistant when its paired `tool` responses were discarded, preventing phantom call IDs from poisoning the next turn. Both `/api/chat` and `/api/tags` response bodies now pass through dependency-free runtime guards (`parseOllamaChatResponse`, `parseOllamaTagsResponse`) that validate shape and produce a readable error on malformed JSON instead of bare `SyntaxError`. No new dependencies added — the air-gap mandate is preserved. Packaging version updated to `0.0.11`.
- **0.0.10:** ManulEngine browser automation integration. ManulAI now bridges directly to the [ManulEngine](https://github.com/alexbeatnik/ManulEngine) Python runtime through a bundled subprocess runner (`media/manul_bridge_api.py`) launched by `src/manulBridge.ts`. ManulEngine (`pip install manul-engine`) is a separate Python runtime — distinct from ManulMcpServer (the VS Code Copilot bridge extension). Eight new browser automation tools are available in Agent and Planner Mode: `manul_run_step`, `manul_run_goal`, `manul_scan_page`, `manul_read_page_text`, `manul_get_state`, `manul_save_hunt`, `manul_run_hunt`, and `manul_run_hunt_file`. The full Hunt DSL command set (NAVIGATE, Click, Fill, HOVER, Drag, VERIFY, EXTRACT, SCROLL, WAIT, PRESS, UPLOAD and more) and all contextual qualifiers (NEAR, ON HEADER, ON FOOTER, INSIDE row with) are documented inline in the agent and planner mandates so the model knows the correct syntax without guessing. A VERIFY-after-every-action table is included: after Fill/Type the model verifies the entered value, after navigation it verifies a landmark, after a click that changes state it verifies the new state. After completing any browser automation session, ManulAI reconstructs the executed steps as a `.hunt` file preview and proposes saving it for later replay; `manul_save_hunt` is confirmation-gated and is rejected unless the latest user message explicitly asks to save the file. Hunt previews are now also reconstructed locally from successful Manul tool results, using returned `page_scan` data to infer missing VERIFY lines after navigation and click actions so the preview is not left without post-action assertions. `manul_get_state` and successful terminal VERIFY steps now also surface `hunt_proposal` / `_nextAction` hints when a session already has executed steps so the model can stop after success instead of replaying earlier navigation/click steps. `manul_save_hunt` still writes the file to disk when explicitly requested even if the subprocess bridge cannot complete the save, using VS Code FS as a fallback inside the workspace root. The `manul_run_hunt_file` tool reads an existing `.hunt` file from the workspace and runs it. `scripts/debug-agent.mjs` was updated in the same release: all 8 tool stubs are present in `executeTool()`, the same confirmation-gated save rule is documented there, and both `buildAgentMandate()` and `buildPlannerMandate()` carry the same DSL reference, VERIFY table, and session completion rule as the extension provider. Packaging version updated to `0.0.10`.
- **0.0.9:** Security and reliability hardening. Terminal command blocklist expanded (`isBlockedCommand`) to cover `rm -rf ~`, `$HOME`-targeting removes, `sudo`, `shutdown`/`reboot`, `mkfs`, `dd if=`, fork-bomb pattern, `chmod -R 777 /`, and curl/wget pipe-to-shell; both `execute_terminal_command` and `launch_in_terminal` now delegate to this shared check. The `ollamaBaseUrl` setting is validated before use to strip embedded credentials and reject non-HTTP/HTTPS schemes, preventing SSRF-class requests. An AbortController race on the retry path is fixed so the previous request is always cancelled before a retry controller is assigned. Terminals created by `launch_in_terminal` are now tracked and disposed when the extension deactivates. The agent loop now enforces a hard absolute turn cap (`maxNudgeRetriesCap + 8`) at `processOllamaResponse` entry, surfacing a user-readable message instead of unbounded recursion. Context trimming no longer orphans `tool`-role messages at the tail: the trim window now walks forward past any leading `tool` messages so every tool result in the kept window has its paired `assistant` call. Persistence failures are now logged instead of swallowed silently. Large `content`/`new_text`/`old_text` fields in debug log tool-call entries are capped at 80 characters to prevent full file bodies from leaking into the log. The webview CSP is tightened from `style-src 'unsafe-inline'` to nonce-based `style-src 'nonce-…'`. In-memory chat list is capped at 50 entries, evicting the oldest non-active chat when the limit is reached. `engines.vscode` lowered to `^1.107.0` for compatibility with Antigravity and comparable VS Code forks. Packaging version updated to `0.0.9`.
- **0.0.8:** Added support for `gemma4:latest` and `gemma4:31b`. Both are thinking models that return empty responses when Ollama's native tools array is present (Ollama 0.20.0 behavior). ManulAI now detects these models via a new `useTextTools` profile flag and automatically switches to a text-tool fallback mode: tool descriptions are injected into the system prompt as structured text, tool calls are returned as `{"tool": "name", "args": {...}}` JSON in the model's text content, and tool results are forwarded as user-role messages. The `think: false` option is also sent to suppress internal thinking tokens from consuming context. Both gemma4 variants are now part of the validated picker baseline and appear first in the model selector alongside `phi4-mini:3.8b`, `llama3.1:8b`, and `qwen3-coder:30b`. Additional agent reliability fixes in this release: Go files now always use standalone `gofmt` for syntax verification instead of falling through to `npm run compile` when a `package.json` is present in the project; degenerate-output detection now catches bracket-soup token patterns typical of `phi4-mini` at the limits of its context window; case-insensitive workspace path correction prevents writes to wrong-case absolute paths when small models reproduce the workspace root with the wrong letter casing; `phi4-mini` now runs with `repeat_penalty: 1.15` to reduce repetitive-loop output; and a verify-failure nudge was added so that after a failed syntax verification the model is immediately pushed to fix the errors rather than continuing or declaring completion. Full regression matrix results for this release (5 models × 14 tasks = 70 runs): `gemma4:31b` 14/14, `gemma4:latest` 14/14, `qwen3-coder:30b` 13/14, `llama3.1:8b` 12/14, `phi4-mini:3.8b` 5/14 — total 58/70. Packaging version updated to `0.0.8`.
- **0.0.7:** Agent and Planner behavior is now model-aware. Smaller Ollama models run with shorter mandates, tighter retry budgets, bounded-read bias, and a reduced tool set so weak local models are less likely to stall or ramble. The runtime also recovers more aggressively from malformed tool output: raw leaked tool-call text can be re-parsed, exact `package.json` name/version and `README.md` title requests can be answered deterministically, and explicit create-path requests are handled more reliably instead of drifting to the wrong file. Preferred local models are now curated around the currently validated baseline `phi4-mini:3.8b`, `llama3.1:8b`, and `qwen3-coder:30b`, with stronger greenfield-create nudges and tighter guardrails against placeholder scaffolds. The standalone debug harness was kept in sync with the extension runtime for the same recovery and model-profile behavior. Packaging version updated to `0.0.7`.
- **0.0.6:** Workspace notes are now per-chat: each chat stores its own notes under `.manulai/notes/<chatId>.md` instead of a shared `.manulai/notes.md`. Notes are automatically deleted when the chat is deleted. The nudge system now detects conversational user messages (greetings, short non-actionable text) and skips action-forcing nudges so the model responds naturally instead of executing stale tasks from earlier context. Packaging version updated to `0.0.6`.
- **0.0.5:** Added Planner Mode as the third working mode alongside Chat and Agent — uses the same tools as Agent Mode but with a condensed step-by-step mandate; it can also answer direct text questions without requiring tool calls. Added `launch_in_terminal` tool for running interactive programs (games, REPLs, scripts needing user input) in a visible VS Code terminal instead of the non-interactive `execute_terminal_command`. Terminal command execution now detects timeout-killed processes and reports that stdin is unavailable, preventing futile retries of interactive programs. Context trimming is now model-aware: the sliding-window size and `num_ctx` sent to Ollama are derived from the model size tag (e.g. `:7b`, `:30b`) instead of using hardcoded limits. Large-refactor recovery is stricter for weaker local models. If the model keeps narrating the same `read_file_slice`, `create_or_edit_file`, or `replace_in_file` step instead of executing it, ManulAI can now auto-bootstrap the real tool call on the repeated response and continue the agent loop. Generated extraction output for Go and Rust is also screened harder before writes so obviously invalid cross-language blocks are rejected instead of being saved. Tool-call stripping in the response pipeline was tightened so only `json`, `tool_call`, and `tool` code blocks are removed instead of all fenced code blocks. Internally, the provider-side large-refactor/bootstrap helpers were split into a dedicated module to keep the production provider maintainable. Packaging version updated to `0.0.5`.
- **0.0.4:** Removed the separate Activity Bar launcher badge so ManulAI stays focused on the Secondary Sidebar chat view. The header and chat controls were compacted further, with chat creation and deletion moved next to the chat selector. Empty-model handling is now truthful instead of showing a fake fallback model, and revertable native file-tool transcript entries expose `Revert changes` again. Large files can now be read with bounded line slices through `read_file_slice`, and large refactor requests are nudged toward step-by-step module/file plans instead of whole-file summaries. Agent Mode now also exposes `project_scan`, `read_workspace_notes`, and `write_workspace_notes`, persists compact project notes in `.manulai/notes.md`, and stores short chat-summary memory so future requests can recover prior context with less re-reading. Packaging version updated to `0.0.4`. *(Note: `project_scan`, workspace notes, and chat-summary memory were first introduced in 0.0.4 and remain available in later versions.)*
- **0.0.3:** Debug JSONL entries now include the ManulAI extension version on every event, making mixed-log debugging across installed builds easier. Debug logs also capture user requests that enter the agent pipeline. The sidebar now supports creating, switching, deleting, and restoring multiple chats. File-backed workspaces persist chat state in `.manulai/chats.json`. Packaging version updated to `0.0.3`.
- **0.0.2:** Auto-retry without tools when the model does not support tool calling (HTTP 400 fallback). Diff markers no longer leak into written files. Destructive writes to critical files like `package.json` are blocked (invalid JSON, shell commands as content, suspiciously short content). Code block extraction now rejects diff-formatted blocks and shell command blocks during fallback file-write extraction. Raw or malformed JSON tool-call payloads are now retried as tool executions instead of being mistaken for file content. Edit transcripts now prefer diffs for existing-file changes instead of dumping full rewritten content. Project scan requests can attach a capped workspace snapshot. Tool results are visible in chat with terminal output and file previews. Multi-step actions can print progress while tools run. Edit requests can auto-discover likely files such as `README.md` when they are mentioned but not attached. `list_workspace_files` now handles absolute paths correctly. Debug logging uses stable JSONL session files under `.manulai/logs/` for file-backed workspaces. The sidebar UI is compacted further for narrow and low-height screens. Publisher ID updated to `manul-engine`.
- **0.0.1 (Alpha Release):** Initial public alpha with right-side chat UI, local Ollama integration, workspace file attachments, native tool-calling support, agent/chat mode separation, approval controls, directory listing and file deletion tools, and stricter prompt rules for safer file edits.

## License

This project is licensed under the Apache License 2.0.
See the `LICENSE` file included in the extension package for details.