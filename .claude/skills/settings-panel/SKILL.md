---
name: settings-panel
description: Guidelines for modifying the ManulAI Settings webview panel in src/settingsPanel.ts. Covers Activity Bar registration, model fetching from Ollama, webview HTML, message passing, and VS Code settings updates.
---

# settings-panel

The Settings Panel is a `WebviewViewProvider` registered in the Activity Bar (`manulaiActivityBar`). It provides a quick UI for changing ManulAI settings without editing `settings.json` manually.

## Scope

- `src/settingsPanel.ts` — the provider implementation.
- `package.json` — `viewsContainers.activitybar` and `views` contributions.
- `src/extension.ts` — registration of the provider.

## Rules

1. **Activity Bar container.** The panel lives in `manulaiActivityBar`, NOT in `manulai` (which was the old Secondary Sidebar). Do not confuse the two containers.
2. **Global settings only.** The panel writes to `vscode.ConfigurationTarget.Global` via `vscode.workspace.getConfiguration('manulai').update()`.
3. **Model fetching.** On `ready` and on manual refresh, the panel fetches `${baseUrl}/api/tags` from the local Ollama server with a 15s timeout. It populates a dropdown with the returned model names and preserves the current selection if it still exists in the list.
4. **Settings exposed:**
   - `ollamaModel` — dropdown of fetched models + custom text input fallback
   - `ollamaBaseUrl` — text input + set button
   - `agentMode` — dropdown: chat / agent / planner
   - `systemPrompt` — textarea + set button
   - `debugMode` — checkbox
   - (no `autoApprove` — that lives in the Copilot Chat participant via `/toggleAutoApprove`)
5. **Message protocol.** The webview posts messages like `{ command: 'changeModel', model: '...' }`. The provider handles them in `onDidReceiveMessage` and posts back `{ command: 'setState', ... }`, `{ command: 'setModels', ... }`, `{ command: 'setModelsLoading', ... }`, and `{ command: 'toast', ... }`.
6. **HTML generation.** The entire HTML is generated inline in `getHtml()` with a CSP nonce. NEVER use backslash-quote escaping inside the inline `<script>` — template literals strip backslashes before the HTML reaches the browser. Use `String.fromCharCode()` or JSON message passing instead.
7. **Open chat button.** Include an "Open @manulai in Chat" button that posts `openChat` and the provider executes `workbench.action.chat.open`.
8. **Retain context.** Register with `webviewOptions: { retainContextWhenHidden: true }` so state survives when the user switches away from the Activity Bar.

## Common mistakes

- Writing to `ConfigurationTarget.Workspace` — the panel is intentionally global-only.
- Assuming `/api/tags` always succeeds — Ollama may be offline; handle fetch errors gracefully and post an empty model list.
- Using `"` or `'` escapes inside template literal HTML — causes silent syntax errors in the webview.
- Forgetting to handle the `ready` message from the webview, leaving the UI blank until interaction.

## Testing

Test the panel by:
1. Clicking the ManulAI icon in the Activity Bar.
2. Confirming the model dropdown populates from Ollama (`ollama list` must show models).
3. Changing the model and confirming the toast appears.
4. Opening Copilot Chat and typing `@manulai /model` to confirm the new model is active.
