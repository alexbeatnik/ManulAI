import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

interface ToolFunctionCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface OllamaMessage {
  role: ChatRole;
  content: string;
  tool_calls?: ToolFunctionCall[];
  tool_name?: string;
}

interface OllamaResponse {
  message?: OllamaMessage;
  done: boolean;
  done_reason?: string;
}

interface AttachedFileContext {
  uri: vscode.Uri;
  name: string;
  content: string;
  languageId: string;
}

interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface WebviewInboundMessage {
  command: 'ready' | 'sendMessage' | 'addFileContext' | 'removeFileContext';
  text?: string;
  path?: string;
}

interface WebviewRenderableMessage {
  role: Exclude<ChatRole, 'system' | 'tool'> | 'status' | 'tool';
  content: string;
}

export class ManulAiChatProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'manulai.chatView';

  private webviewView?: vscode.WebviewView;
  private readonly messages: OllamaMessage[] = [];
  private readonly attachedFiles = new Map<string, AttachedFileContext>();
  private requestInFlight = false;

  public constructor(private readonly extensionContext: vscode.ExtensionContext) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.webviewView = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionContext.extensionUri, 'media')]
    };

    webviewView.webview.html = this.getWebviewHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(
      async (message: WebviewInboundMessage) => {
        await this.handleWebviewMessage(message);
      },
      undefined,
      this.extensionContext.subscriptions
    );
  }

  public reveal(preserveFocus = false): void {
    this.webviewView?.show(preserveFocus);
  }

  private async handleWebviewMessage(message: WebviewInboundMessage): Promise<void> {
    switch (message.command) {
      case 'ready':
        this.postStateToWebview();
        return;
      case 'sendMessage':
        if (!message.text?.trim()) {
          return;
        }
        await this.sendUserMessage(message.text.trim());
        return;
      case 'addFileContext':
        if (!message.path) {
          return;
        }
        await this.addFileContext(message.path);
        return;
      case 'removeFileContext':
        if (!message.path) {
          return;
        }
        this.attachedFiles.delete(message.path);
        this.postStateToWebview();
        return;
      default:
        return;
    }
  }

  private async sendUserMessage(text: string): Promise<void> {
    if (this.requestInFlight) {
      this.postStatus('A request is already running. Wait for the current response to finish.');
      return;
    }

    this.messages.push({ role: 'user', content: text });
    this.postStateToWebview();
    await this.runAgentLoop();
  }

  private async runAgentLoop(): Promise<void> {
    this.requestInFlight = true;
    this.postBusyState(true);

    try {
      while (true) {
        const response = await this.callOllama();
        const assistantMessage = response.message;

        if (!assistantMessage) {
          throw new Error('Ollama returned no message payload.');
        }

        this.messages.push({
          role: 'assistant',
          content: assistantMessage.content ?? '',
          tool_calls: assistantMessage.tool_calls
        });
        this.postStateToWebview();

        if (assistantMessage.tool_calls?.length) {
          for (const toolCall of assistantMessage.tool_calls) {
            const toolResult = await this.executeToolCall(toolCall);
            this.messages.push({
              role: 'tool',
              content: toolResult,
              tool_name: toolCall.function.name
            });
            this.postToolResult(toolCall.function.name, toolResult);
          }

          continue;
        }

        break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.postStatus(`Request failed: ${message}`);
    } finally {
      this.requestInFlight = false;
      this.postBusyState(false);
      this.postStateToWebview();
    }
  }

  private async callOllama(): Promise<OllamaResponse> {
    const config = vscode.workspace.getConfiguration('manulai');
    const baseUrl = String(config.get('ollamaBaseUrl', 'http://localhost:11434')).replace(/\/$/, '');
    const model = String(config.get('ollamaModel', 'llama3.2'));
    const systemPrompt = String(config.get('systemPrompt', ''));

    const contextMessages: OllamaMessage[] = [];

    contextMessages.push({
      role: 'system',
      content: systemPrompt
    });

    if (this.attachedFiles.size > 0) {
      const renderedFiles = Array.from(this.attachedFiles.values())
        .map(file => {
          return [
            `File: ${file.name}`,
            `Path: ${file.uri.fsPath}`,
            `Language: ${file.languageId || 'plaintext'}`,
            'Content:',
            file.content
          ].join('\n');
        })
        .join('\n\n---\n\n');

      contextMessages.push({
        role: 'system',
        content: `Attached file context for the current task:\n\n${renderedFiles}`
      });
    }

    const body = {
      model,
      stream: false,
      messages: [...contextMessages, ...this.messages],
      tools: this.getToolDefinitions()
    };

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama HTTP ${response.status}: ${errorText}`);
    }

    return (await response.json()) as OllamaResponse;
  }

  private getToolDefinitions(): ToolDefinition[] {
    return [
      {
        type: 'function',
        function: {
          name: 'read_active_file',
          description: 'Return the full text and language ID of the currently active editor tab.',
          parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'read_specific_file',
          description: 'Read a specific file from disk using an absolute or workspace-relative path.',
          parameters: {
            type: 'object',
            properties: {
              filepath: {
                type: 'string',
                description: 'Absolute path or workspace-relative path to read.'
              }
            },
            required: ['filepath'],
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'create_or_edit_file',
          description: 'Create or overwrite a file in the current workspace.',
          parameters: {
            type: 'object',
            properties: {
              filename: {
                type: 'string',
                description: 'Workspace-relative or absolute output file path.'
              },
              content: {
                type: 'string',
                description: 'Complete file contents to write.'
              }
            },
            required: ['filename', 'content'],
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'execute_terminal_command',
          description: 'Execute a shell command in the workspace and return stdout and stderr.',
          parameters: {
            type: 'object',
            properties: {
              command: {
                type: 'string',
                description: 'The shell command to execute.'
              }
            },
            required: ['command'],
            additionalProperties: false
          }
        }
      }
    ];
  }

  private async executeToolCall(toolCall: ToolFunctionCall): Promise<string> {
    const { name, arguments: args } = toolCall.function;

    switch (name) {
      case 'read_active_file':
        return this.readActiveFile();
      case 'read_specific_file':
        return this.readSpecificFile(String(args.filepath ?? ''));
      case 'create_or_edit_file':
        return this.createOrEditFile(String(args.filename ?? ''), String(args.content ?? ''));
      case 'execute_terminal_command':
        return this.executeTerminalCommand(String(args.command ?? ''));
      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  }

  private async readActiveFile(): Promise<string> {
    const editor = vscode.window.activeTextEditor;

    if (!editor) {
      return JSON.stringify({ error: 'No active text editor found.' });
    }

    const { document } = editor;
    return JSON.stringify({
      path: document.uri.fsPath,
      languageId: document.languageId,
      content: document.getText()
    });
  }

  private async readSpecificFile(filepath: string): Promise<string> {
    if (!filepath.trim()) {
      return JSON.stringify({ error: 'filepath is required.' });
    }

    try {
      const uri = this.resolveWorkspaceUri(filepath);
      const bytes = await vscode.workspace.fs.readFile(uri);
      const content = Buffer.from(bytes).toString('utf8');
      const languageId = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString())?.languageId ?? 'plaintext';

      return JSON.stringify({
        path: uri.fsPath,
        languageId,
        content
      });
    } catch (error) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : 'Failed to read file.'
      });
    }
  }

  private async createOrEditFile(filename: string, content: string): Promise<string> {
    if (!filename.trim()) {
      return JSON.stringify({ error: 'filename is required.' });
    }

    const target = this.resolveWorkspaceUri(filename);

    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(target.fsPath)));
      await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
      return JSON.stringify({
        path: target.fsPath,
        bytesWritten: Buffer.byteLength(content, 'utf8')
      });
    } catch (error) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : 'Failed to write file.'
      });
    }
  }

  private async executeTerminalCommand(command: string): Promise<string> {
    const trimmed = command.trim();

    if (!trimmed) {
      return JSON.stringify({ error: 'command is required.' });
    }

    const forbiddenFragments = ['rm -rf /', 'sudo ', 'shutdown', 'reboot', 'mkfs', ':(){:|:&};:'];
    if (forbiddenFragments.some(fragment => trimmed.includes(fragment))) {
      return JSON.stringify({ error: 'Command rejected by basic safety policy.' });
    }

    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    return new Promise(resolve => {
      exec(trimmed, { cwd, timeout: 60_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        resolve(JSON.stringify({
          command: trimmed,
          exitCode: (error as NodeJS.ErrnoException | null)?.code ?? 0,
          stdout,
          stderr,
          error: error ? error.message : undefined
        }));
      });
    });
  }

  private async addFileContext(rawPath: string): Promise<void> {
    try {
      const decodedPath = this.normalizeDroppedPath(rawPath);
      const uri = decodedPath.startsWith('file:') ? vscode.Uri.parse(decodedPath) : this.resolveWorkspaceUri(decodedPath);
      const bytes = await vscode.workspace.fs.readFile(uri);
      const content = Buffer.from(bytes).toString('utf8');
      const document = await vscode.workspace.openTextDocument(uri);

      this.attachedFiles.set(uri.fsPath, {
        uri,
        name: path.basename(uri.fsPath),
        content,
        languageId: document.languageId
      });

      this.postStateToWebview();
      this.postStatus(`Attached ${path.basename(uri.fsPath)} to the next requests.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to attach file.';
      this.postStatus(`Unable to attach dropped file: ${message}`);
    }
  }

  private normalizeDroppedPath(rawPath: string): string {
    const value = rawPath.trim();

    if (!value) {
      throw new Error('Dropped path is empty.');
    }

    if (value.includes('\n')) {
      return value.split(/\r?\n/)[0].trim();
    }

    return value;
  }

  private resolveWorkspaceUri(targetPath: string): vscode.Uri {
    if (path.isAbsolute(targetPath)) {
      return vscode.Uri.file(targetPath);
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      throw new Error('Open a workspace folder before using file tools.');
    }

    return vscode.Uri.file(path.join(workspaceRoot, targetPath));
  }

  private getWebviewHtml(webview: vscode.Webview): string {
    const htmlUri = vscode.Uri.joinPath(this.extensionContext.extensionUri, 'media', 'webview.html');
    const htmlBytes = fs.readFileSync(htmlUri.fsPath);
    const nonce = this.createNonce();
    return Buffer.from(htmlBytes)
      .toString('utf8')
      .replaceAll('{{nonce}}', nonce)
      .replaceAll('{{cspSource}}', webview.cspSource);
  }

  private postStateToWebview(): void {
    if (!this.webviewView) {
      return;
    }

    const renderableMessages: WebviewRenderableMessage[] = this.messages.reduce<WebviewRenderableMessage[]>((result, message) => {
      if (message.role === 'system') {
        return result;
      }

      if (message.role === 'tool') {
        result.push({
          role: 'tool',
          content: `${message.tool_name ?? 'tool'}\n${message.content}`
        });
        return result;
      }

      result.push({
        role: message.role,
        content: message.content
      });
      return result;
    }, []);

    void this.webviewView.webview.postMessage({
      command: 'state',
      messages: renderableMessages,
      attachments: Array.from(this.attachedFiles.values()).map(file => ({
        path: file.uri.fsPath,
        name: file.name
      }))
    });
  }

  private postStatus(content: string): void {
    if (!this.webviewView) {
      return;
    }

    void this.webviewView.webview.postMessage({
      command: 'status',
      message: content
    });
  }

  private postToolResult(toolName: string, result: string): void {
    if (!this.webviewView) {
      return;
    }

    void this.webviewView.webview.postMessage({
      command: 'toolResult',
      toolName,
      result
    });
  }

  private postBusyState(busy: boolean): void {
    if (!this.webviewView) {
      return;
    }

    void this.webviewView.webview.postMessage({
      command: 'busy',
      busy
    });
  }

  private createNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let value = '';
    for (let index = 0; index < 32; index += 1) {
      value += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return value;
  }
}