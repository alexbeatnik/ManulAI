import * as vscode from 'vscode';

interface OllamaTagModel {
  name?: string;
  model?: string;
}

export class SettingsPanel implements vscode.WebviewViewProvider {
  public static readonly viewType = 'manulai.settings';
  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly output?: vscode.OutputChannel
  ) {}

  private log(msg: string): void {
    this.output?.appendLine(msg);
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      try {
        switch (msg?.command) {
          case 'ready':
            await this.refreshAll();
            break;
          case 'refreshModels':
            await this.sendModels();
            break;
          case 'changeModel':
            await this.changeModel(msg.model);
            break;
          case 'changeBaseUrl':
            await this.changeBaseUrl(msg.baseUrl);
            break;
          case 'changeSystemPrompt':
            await this.changeSystemPrompt(msg.systemPrompt);
            break;
          case 'setDebugMode':
            await this.setDebugMode(msg.value);
            break;
          case 'openChat':
            await vscode.commands.executeCommand('workbench.action.chat.open', '@manulai ');
            break;
        }
      } catch (err: any) {
        this.log(`[SettingsPanel] error: ${err?.message || err}`);
        this.post({ command: 'toast', text: `Error: ${err?.message || err}`, kind: 'error' });
      }
    });
  }

  private async refreshAll(): Promise<void> {
    const config = vscode.workspace.getConfiguration('manulai');
    this.post({
      command: 'setState',
      model: String(config.get('ollamaModel', '')),
      baseUrl: String(config.get('ollamaBaseUrl', 'http://localhost:11434')),
      systemPrompt: String(config.get('systemPrompt', '')),
      debugMode: Boolean(config.get('debugMode', false)),
    });
    await this.sendModels();
  }

  private async sendModels(): Promise<void> {
    this.post({ command: 'setModelsLoading', value: true });
    try {
      const config = vscode.workspace.getConfiguration('manulai');
      const baseUrl = String(config.get('ollamaBaseUrl', 'http://localhost:11434')).replace(/\/$/, '');
      const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) {
        throw new Error(`Ollama HTTP ${res.status}`);
      }
      const json = await res.json() as { models?: OllamaTagModel[] };
      const models = (json.models || [])
        .map((m) => String(m.name || m.model || '').trim())
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
      this.post({ command: 'setModels', models });
    } catch (err: any) {
      this.log(`[SettingsPanel] fetchModels failed: ${err?.message || err}`);
      this.post({ command: 'setModels', models: [] });
    } finally {
      this.post({ command: 'setModelsLoading', value: false });
    }
  }

  private async changeModel(model: string): Promise<void> {
    if (!model) return;
    const config = vscode.workspace.getConfiguration('manulai');
    await config.update('ollamaModel', model, vscode.ConfigurationTarget.Global);
    this.post({ command: 'toast', text: `Model set: ${model}`, kind: 'ok' });
    await this.refreshAll();
  }

  private async changeBaseUrl(baseUrl: string): Promise<void> {
    if (!baseUrl) return;
    const config = vscode.workspace.getConfiguration('manulai');
    await config.update('ollamaBaseUrl', baseUrl, vscode.ConfigurationTarget.Global);
    this.post({ command: 'toast', text: `Base URL set: ${baseUrl}`, kind: 'ok' });
    await this.refreshAll();
  }

  private async changeSystemPrompt(systemPrompt: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('manulai');
    await config.update('systemPrompt', systemPrompt, vscode.ConfigurationTarget.Global);
    this.post({ command: 'toast', text: 'System prompt updated', kind: 'ok' });
  }

  private async setDebugMode(value: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration('manulai');
    await config.update('debugMode', value, vscode.ConfigurationTarget.Global);
    this.post({ command: 'toast', text: `Debug mode: ${value ? 'on' : 'off'}`, kind: 'ok' });
    await this.refreshAll();
  }

  private post(msg: any): void {
    this.view?.webview.postMessage(msg);
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = this.nonce();
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};`;
    return /* html */ `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  :root {
    --bg: var(--vscode-editor-background, #1e1e1e);
    --fg: var(--vscode-editor-foreground, #ccc);
    --input-bg: var(--vscode-input-background, #3c3c3c);
    --input-fg: var(--vscode-input-foreground, #ccc);
    --border: var(--vscode-panel-border, #3c3c3c);
    --accent: var(--vscode-focusBorder, #007acc);
    --button-bg: var(--vscode-button-background, #0e639c);
    --button-fg: var(--vscode-button-foreground, #fff);
    --muted: var(--vscode-descriptionForeground, #858585);
    --error: var(--vscode-errorForeground, #f48771);
    --ok: var(--vscode-testing-iconPassed, #73c991);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    background: var(--bg); color: var(--fg);
    padding: 12px; display: flex; flex-direction: column; gap: 14px;
  }
  h3 { margin: 0 0 4px; font-size: 13px; text-transform: uppercase; color: var(--muted); letter-spacing: 0.5px; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  .field label { font-weight: 600; font-size: 12px; }
  .row { display: flex; gap: 6px; align-items: center; }
  select, input[type=text], textarea {
    flex: 1; min-width: 0;
    background: var(--input-bg); color: var(--input-fg);
    border: 1px solid var(--border); border-radius: 4px;
    padding: 5px 7px; font-family: inherit; font-size: 12px; outline: none;
  }
  select:focus, input:focus, textarea:focus { border-color: var(--accent); }
  textarea { resize: vertical; min-height: 60px; }
  button {
    background: var(--button-bg); color: var(--button-fg);
    border: none; border-radius: 4px; padding: 5px 10px; cursor: pointer;
    font-size: 12px;
  }
  button.ghost { background: transparent; color: var(--muted); border: 1px solid var(--border); }
  button.ghost:hover { background: var(--input-bg); color: var(--fg); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .toast {
    position: fixed; bottom: 8px; left: 50%; transform: translateX(-50%);
    padding: 6px 12px; border-radius: 4px; font-size: 11px; opacity: 0;
    pointer-events: none; transition: opacity 0.25s; z-index: 1000;
    background: var(--button-bg); color: var(--button-fg);
  }
  .toast.show { opacity: 1; }
  .toast.error { background: var(--error); }
  .toast.ok { background: var(--ok); color: #000; }
  .checkbox-row { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
  .status { font-size: 11px; color: var(--muted); }
  .open-chat { margin-top: 4px; padding: 8px; text-align: center; }
  hr { border: 0; border-top: 1px solid var(--border); margin: 0; }
  .spinner {
    display: none; width: 12px; height: 12px;
    border: 2px solid var(--border); border-top-color: var(--accent);
    border-radius: 50%; animation: spin 0.8s linear infinite;
  }
  .spinner.active { display: inline-block; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <div class="field">
    <h3>ManulAI Settings</h3>
    <div id="activeLabel" class="status">—</div>
  </div>

  <hr/>

  <div class="field">
    <label for="modelSelect">Ollama Model</label>
    <div class="row">
      <select id="modelSelect"></select>
      <button class="ghost" id="refreshBtn" title="Refresh models">&#8635;</button>
      <div class="spinner" id="spinner"></div>
    </div>
    <div class="row">
      <input type="text" id="customModelInput" placeholder="custom model id…" />
      <button id="setCustomModel">Set</button>
    </div>
  </div>

  <div class="field">
    <label for="baseUrlInput">Ollama Base URL</label>
    <input type="text" id="baseUrlInput" placeholder="http://localhost:11434" />
    <button id="setBaseUrlBtn">Set Base URL</button>
  </div>

  <div class="field">
    <label for="systemPromptInput">System Prompt</label>
    <textarea id="systemPromptInput" placeholder="Enter system prompt..."></textarea>
    <button id="setSystemPromptBtn">Set System Prompt</button>
  </div>

  <hr/>

  <div class="checkbox-row">
    <input type="checkbox" id="debugModeCheck" />
    <label for="debugModeCheck">Debug mode (JSONL logs)</label>
  </div>

  <hr/>

  <button class="ghost open-chat" id="openChatBtn">Open @manulai in Chat</button>

  <div class="toast" id="toast"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);
    const modelSelect = $('modelSelect');
    const customModelInput = $('customModelInput');
    const baseUrlInput = $('baseUrlInput');
    const systemPromptInput = $('systemPromptInput');
    const debugModeCheck = $('debugModeCheck');
    const toast = $('toast');
    const spinner = $('spinner');
    const refreshBtn = $('refreshBtn');
    const activeLabel = $('activeLabel');
    let allModels = [];

    function showToast(text, kind) {
      toast.textContent = text;
      toast.className = 'toast ' + (kind || '') + ' show';
      setTimeout(() => toast.classList.remove('show'), 1800);
    }

    function rebuildModelOptions() {
      const current = modelSelect.value;
      modelSelect.innerHTML = '';
      const placeholder = document.createElement('option');
      placeholder.value = ''; placeholder.textContent = '-- model --';
      modelSelect.appendChild(placeholder);
      for (const m of allModels) {
        const opt = document.createElement('option');
        opt.value = m; opt.textContent = m;
        modelSelect.appendChild(opt);
      }
      if (current) {
        for (const opt of modelSelect.options) {
          if (opt.value === current) { modelSelect.value = current; break; }
        }
      }
    }

    modelSelect.addEventListener('change', () => {
      if (modelSelect.value) {
        vscode.postMessage({ command: 'changeModel', model: modelSelect.value });
      }
    });
    $('setCustomModel').addEventListener('click', () => {
      const v = customModelInput.value.trim();
      if (v) vscode.postMessage({ command: 'changeModel', model: v });
    });
    $('setBaseUrlBtn').addEventListener('click', () => {
      const v = baseUrlInput.value.trim();
      if (v) vscode.postMessage({ command: 'changeBaseUrl', baseUrl: v });
    });
    $('setSystemPromptBtn').addEventListener('click', () => {
      vscode.postMessage({ command: 'changeSystemPrompt', systemPrompt: systemPromptInput.value });
    });
    debugModeCheck.addEventListener('change', () => {
      vscode.postMessage({ command: 'setDebugMode', value: debugModeCheck.checked });
    });
    refreshBtn.addEventListener('click', () => vscode.postMessage({ command: 'refreshModels' }));
    $('openChatBtn').addEventListener('click', () => vscode.postMessage({ command: 'openChat' }));

    window.addEventListener('message', (event) => {
      const m = event.data;
      if (m.command === 'setState') {
        customModelInput.value = '';
        baseUrlInput.value = m.baseUrl || '';
        systemPromptInput.value = m.systemPrompt || '';
        debugModeCheck.checked = Boolean(m.debugMode);
        activeLabel.textContent = (m.model || 'No model') + ' @ ' + (m.baseUrl || '—');
        if (m.model) {
          modelSelect.value = m.model;
          for (const opt of modelSelect.options) {
            if (opt.value === m.model) { modelSelect.value = m.model; break; }
          }
        }
      }
      if (m.command === 'setModels') {
        allModels = m.models || [];
        rebuildModelOptions();
      }
      if (m.command === 'setModelsLoading') {
        if (m.value) { refreshBtn.disabled = true; spinner.classList.add('active'); }
        else { refreshBtn.disabled = false; spinner.classList.remove('active'); }
      }
      if (m.command === 'toast') {
        showToast(m.text, m.kind);
      }
    });

    vscode.postMessage({ command: 'ready' });
  </script>
</body></html>`;
  }

  private nonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
    return text;
  }
}
