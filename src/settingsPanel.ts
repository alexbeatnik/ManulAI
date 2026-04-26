import * as vscode from 'vscode';

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
          case 'changeModel':
            await this.changeModel(msg.model);
            break;
          case 'changeBaseUrl':
            await this.changeBaseUrl(msg.baseUrl);
            break;
          case 'changeSystemPrompt':
            await this.changeSystemPrompt(msg.systemPrompt);
            break;
          case 'setAgentMode':
            await this.setAgentMode(msg.value);
            break;
          case 'setAutoApprove':
            await this.setAutoApprove(msg.value);
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
      agentMode: config.get('agentMode', true),
      autoApprove: Boolean(config.get('autoApprove', false)),
      debugMode: Boolean(config.get('debugMode', false)),
    });
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

  private async setAgentMode(value: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('manulai');
    await config.update('agentMode', value, vscode.ConfigurationTarget.Global);
    this.post({ command: 'toast', text: `Agent mode: ${value}`, kind: 'ok' });
    await this.refreshAll();
  }

  private async setAutoApprove(value: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration('manulai');
    await config.update('autoApprove', value, vscode.ConfigurationTarget.Global);
    this.post({ command: 'toast', text: `Auto-approve: ${value ? 'on' : 'off'}`, kind: 'ok' });
    await this.refreshAll();
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
</style>
</head>
<body>
  <div class="field">
    <h3>ManulAI Settings</h3>
    <div id="activeLabel" class="status">—</div>
  </div>

  <hr/>

  <div class="field">
    <label for="modelInput">Ollama Model</label>
    <input type="text" id="modelInput" placeholder="e.g. qwen3-coder:30b" />
    <button id="setModelBtn">Set Model</button>
  </div>

  <div class="field">
    <label for="baseUrlInput">Ollama Base URL</label>
    <input type="text" id="baseUrlInput" placeholder="http://localhost:11434" />
    <button id="setBaseUrlBtn">Set Base URL</button>
  </div>

  <div class="field">
    <label for="agentModeSelect">Agent Mode</label>
    <select id="agentModeSelect">
      <option value="chat">Chat</option>
      <option value="agent">Agent</option>
      <option value="planner">Planner</option>
    </select>
  </div>

  <div class="field">
    <label for="systemPromptInput">System Prompt</label>
    <textarea id="systemPromptInput" placeholder="Enter system prompt..."></textarea>
    <button id="setSystemPromptBtn">Set System Prompt</button>
  </div>

  <hr/>

  <div class="checkbox-row">
    <input type="checkbox" id="autoApproveCheck" />
    <label for="autoApproveCheck">Auto-approve tool calls</label>
  </div>

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
    const modelInput = $('modelInput');
    const baseUrlInput = $('baseUrlInput');
    const systemPromptInput = $('systemPromptInput');
    const agentModeSelect = $('agentModeSelect');
    const autoApproveCheck = $('autoApproveCheck');
    const debugModeCheck = $('debugModeCheck');
    const toast = $('toast');
    const activeLabel = $('activeLabel');

    function showToast(text, kind) {
      toast.textContent = text;
      toast.className = 'toast ' + (kind || '') + ' show';
      setTimeout(() => toast.classList.remove('show'), 1800);
    }

    $('setModelBtn').addEventListener('click', () => {
      const v = modelInput.value.trim();
      if (v) vscode.postMessage({ command: 'changeModel', model: v });
    });
    $('setBaseUrlBtn').addEventListener('click', () => {
      const v = baseUrlInput.value.trim();
      if (v) vscode.postMessage({ command: 'changeBaseUrl', baseUrl: v });
    });
    $('setSystemPromptBtn').addEventListener('click', () => {
      vscode.postMessage({ command: 'changeSystemPrompt', systemPrompt: systemPromptInput.value });
    });
    agentModeSelect.addEventListener('change', () => {
      vscode.postMessage({ command: 'setAgentMode', value: agentModeSelect.value });
    });
    autoApproveCheck.addEventListener('change', () => {
      vscode.postMessage({ command: 'setAutoApprove', value: autoApproveCheck.checked });
    });
    debugModeCheck.addEventListener('change', () => {
      vscode.postMessage({ command: 'setDebugMode', value: debugModeCheck.checked });
    });
    $('openChatBtn').addEventListener('click', () => vscode.postMessage({ command: 'openChat' }));

    window.addEventListener('message', (event) => {
      const m = event.data;
      if (m.command === 'setState') {
        modelInput.value = m.model || '';
        baseUrlInput.value = m.baseUrl || '';
        systemPromptInput.value = m.systemPrompt || '';
        if (m.agentMode) {
          for (const opt of agentModeSelect.options) {
            if (opt.value === m.agentMode) { agentModeSelect.value = m.agentMode; break; }
          }
        }
        autoApproveCheck.checked = Boolean(m.autoApprove);
        debugModeCheck.checked = Boolean(m.debugMode);
        activeLabel.textContent = (m.model || 'No model') + ' @ ' + (m.baseUrl || '—');
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
