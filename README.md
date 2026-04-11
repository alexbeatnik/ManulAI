# ManulAI Local Agent

![Alpha](https://img.shields.io/badge/status-alpha-bf5b04)
![Manul Product Line](https://img.shields.io/badge/product%20line-Manul-111827)

ManulAI is a **local, embeddable AI agent for software products and developer workflows**. It runs inside VS Code on top of Ollama, but its real value is as a **predictable product component** teams can wire into IDE plugins, CI jobs, internal tools, and documentation-assisted support flows.

**Default: local models only.** ManulAI keeps model execution, file access, tool actions, and workspace state on your machine or inside your controlled environment.

> **Status: Alpha.**
> ManulAI is already useful for real work, but it is still being hardened through real-world use. The priority is local control, safe edits, predictable tool execution, and practical integration with existing engineering systems.

## What This Enables For Your Product

- **Embed a local agent into product workflows** without sending code or prompts to a cloud AI provider.
- **Add workspace-aware assistance to internal tools** such as engineering dashboards, product CLIs, or support consoles.
- **Run safe, reviewable code edits in gated flows** with approvals, diffs, and revertable changes.
- **Power internal IDE experiences** with a right-side assistant that understands files, tools, and project structure.
- **Generate structured reports in CI** from local scans, bounded reads, and deterministic tool output.
- **Keep product teams in control** with local models, command restrictions, debug logs, and file-backed workspace state.

## Quick Demo

### Hands-On In VS Code

Minimal path from install to a real file write:

```bash
ollama serve
ollama pull qwen3-coder:30b
```

Open VS Code, install the ManulAI extension, then run:

```text
ManulAI: Open Secondary Sidebar
ManulAI: Select Ollama Model
Attach Active File to ManulAI Chat
```

Prompt the agent:

```text
Create src/hello.ts with a function that returns "hello from ManulAI".
```

Expected transcript shape:

```text
User: Create src/hello.ts with a function that returns "hello from ManulAI".

Assistant tool: create_or_edit_file
Path: src/hello.ts

Preview:
export function hello(): string {
  return 'hello from ManulAI';
}

Assistant: Created src/hello.ts with a small exported helper.
```

Outcome: **a local model creates a real file through a visible, approval-aware tool action instead of only suggesting code in chat.**

### Chat, Agent, Planner

- **Chat**: plain text only. Use it for explanation, review, and discussion when no file changes should happen.
- **Agent**: tool-enabled execution. Use it for reads, edits, scans, terminal commands, and automation.
- **Planner**: constrained stepwise execution. Use it when you want smaller, more deliberate actions with less prompt overhead.

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

ManulAI is a compact right-side assistant for VS Code with:

- Chat, Agent, and Planner modes
- workspace file attachments
- visible tool transcript output
- local Ollama model selection
- file-backed workspace state

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
- GitHub: https://github.com/manulai/manulai-local-agent
- Docs: https://github.com/manulai/manulai-local-agent/blob/main/README-dev.md
- Enterprise integration guidance: https://github.com/manulai/manulai-local-agent/issues

## What's New

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