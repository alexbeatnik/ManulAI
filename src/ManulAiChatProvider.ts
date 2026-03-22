import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

interface ToolFunctionCall {
  type?: 'function';
  function: {
    index?: number;
    name: string;
    arguments?: Record<string, unknown> | string;
  };
}

interface OllamaMessage {
  role: ChatRole;
  content: string;
  tool_calls?: ToolFunctionCall[];
  tool_name?: string;
  hiddenFromTranscript?: boolean;
  attachmentContext?: boolean;
}

interface OllamaResponse {
  message?: OllamaMessage;
  done: boolean;
  done_reason?: string;
}

interface ParsedToolCall {
  name: string;
  arguments?: Record<string, unknown> | string;
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
  command:
    | 'ready'
    | 'sendMessage'
    | 'addFileContext'
    | 'addFileContent'
    | 'addFilePathContext'
    | 'removeFileContext'
    | 'selectModel'
    | 'refreshModels'
    | 'browseFiles'
    | 'toggleAgentMode'
    | 'toggleAutoApprove';
  text?: string;
  path?: string;
  paths?: string[];
  model?: string;
  value?: boolean;
  filename?: string;
  content?: string;
  attachments?: Array<{ name: string; content: string }>;
}

interface WebviewRenderableMessage {
  role: Exclude<ChatRole, 'system'> | 'status';
  content: string;
}

export class ManulAiChatProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'manulai.chatView';

  private webviewView?: vscode.WebviewView;
  private readonly messages: OllamaMessage[] = [];
  private readonly attachedFiles = new Map<string, AttachedFileContext>();
  private availableModels: string[] = [];
  private agentMode = true;
  private autoApprove = false;
  private requestInFlight = false;

  public constructor(private readonly extensionContext: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration('manulai');
    this.agentMode = Boolean(config.get('agentMode', true));
    this.autoApprove = Boolean(config.get('autoApprove', false));
  }

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

  public async refreshModelCatalog(postStatusOnError = false): Promise<void> {
    const currentModel = this.getSelectedModel();

    try {
      const config = vscode.workspace.getConfiguration('manulai');
      const baseUrl = String(config.get('ollamaBaseUrl', 'http://localhost:11434')).replace(/\/$/, '');
      const response = await fetch(`${baseUrl}/api/tags`);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama HTTP ${response.status}: ${errorText}`);
      }

      const payload = (await response.json()) as { models?: Array<{ name?: string }> };
      const names = (payload.models ?? [])
        .map(model => String(model.name ?? '').trim())
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right));

      this.availableModels = Array.from(new Set([currentModel, ...names].filter(Boolean)));
    } catch (error) {
      this.availableModels = Array.from(new Set([currentModel, ...this.availableModels].filter(Boolean)));

      if (postStatusOnError) {
        const message = error instanceof Error ? error.message : 'Failed to load Ollama models.';
        this.postStatus(`Unable to refresh Ollama models: ${message}`);
      }
    }
  }

  public getSelectedModel(): string {
    const config = vscode.workspace.getConfiguration('manulai');
    return String(config.get('ollamaModel', 'llama3.2'));
  }

  public async setSelectedModel(model: string): Promise<void> {
    const normalizedModel = model.trim();
    if (!normalizedModel) {
      return;
    }

    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;

    await vscode.workspace.getConfiguration('manulai').update('ollamaModel', normalizedModel, target);
    await this.refreshModelCatalog(false);
    this.postStateToWebview();
    this.postStatus(`Ollama model set to ${normalizedModel}.`);
  }

  public getAvailableModels(): string[] {
    return [...this.availableModels];
  }

  public async handleConfigurationChange(): Promise<void> {
    const config = vscode.workspace.getConfiguration('manulai');
    this.agentMode = Boolean(config.get('agentMode', true));
    this.autoApprove = Boolean(config.get('autoApprove', false));
    await this.refreshModelCatalog(false);
    this.postStateToWebview();
  }

  public async attachFilesByUri(uris: vscode.Uri[]): Promise<void> {
    for (const uri of uris) {
      await this.addFileContext(uri.fsPath);
    }
  }

  private async handleWebviewMessage(message: WebviewInboundMessage): Promise<void> {
    switch (message.command) {
      case 'ready':
        await this.refreshModelCatalog(false);
        this.postStateToWebview();
        return;
      case 'sendMessage':
        if (!message.text?.trim()) {
          return;
        }
        await this.sendUserMessage(message.text.trim(), message.attachments);
        return;
      case 'addFileContext':
        if (Array.isArray(message.paths) && message.paths.length > 0) {
          for (const pathToAdd of message.paths) {
            if (!pathToAdd?.trim()) {
              continue;
            }

            await this.addFileContext(pathToAdd);
          }
          return;
        }
        if (!message.path) {
          return;
        }
        await this.addFileContext(message.path);
        return;
      case 'addFileContent':
        if (!message.filename || !message.content) {
          return;
        }
        this.addFileContentDirect(message.filename, message.content);
        return;
      case 'addFilePathContext':
        if (Array.isArray(message.paths) && message.paths.length > 0) {
          for (const uriPath of message.paths) {
            if (uriPath?.trim()) {
              await this.addFilePathContext(uriPath.trim());
            }
          }
        }
        return;
      case 'removeFileContext':
        if (!message.path) {
          return;
        }
        this.attachedFiles.delete(message.path);
        this.removeAttachmentContextMessages();
        this.postStateToWebview();
        return;
      case 'selectModel':
        if (!message.model?.trim()) {
          return;
        }
        await this.setSelectedModel(message.model.trim());
        return;
      case 'refreshModels':
        await this.refreshModelCatalog(true);
        this.postStateToWebview();
        return;
      case 'browseFiles':
        await this.browseAndAttachFiles();
        return;
      case 'toggleAgentMode':
        await this.setAgentMode(message.value);
        return;
      case 'toggleAutoApprove':
        await this.setAutoApprove(message.value);
        return;
      default:
        return;
    }
  }

  private async sendUserMessage(text: string, frontendAttachments?: Array<{ name: string; content: string }>): Promise<void> {
    if (this.requestInFlight) {
      this.postStatus('A request is already running. Wait for the current response to finish.');
      return;
    }

    this.synchronizeAttachmentContextMessage();

    if (frontendAttachments && frontendAttachments.length > 0) {
      const fileBlocks = frontendAttachments
        .map(a => `[FILE: ${a.name}]\n${a.content}\n[/FILE]`)
        .join('\n\n');
      this.messages.push({
        role: 'user',
        content: fileBlocks,
        hiddenFromTranscript: true
      });
    }

    this.messages.push({ role: 'user', content: text });
    this.postStateToWebview();
    await this.runAgentLoop();
  }

  private async runAgentLoop(): Promise<void> {
    this.requestInFlight = true;
    this.postBusyState(true);

    try {
      await this.processOllamaResponse(this.messages);
      this.postStateToWebview();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.postStatus(`Request failed: ${message}`);
    } finally {
      this.requestInFlight = false;
      this.postBusyState(false);
      this.postStateToWebview();
    }
  }

  private async processOllamaResponse(messages: OllamaMessage[]): Promise<void> {
    const responseData = await this.callOllama(messages);
    const assistantMessage = responseData.message;

    if (!assistantMessage) {
      throw new Error('Ollama returned no message payload.');
    }

    const resolvedToolCalls = this.agentMode ? this.extractToolCalls(assistantMessage) : [];

    if (resolvedToolCalls.length > 0) {
      const wasNative = (assistantMessage.tool_calls?.length ?? 0) > 0;
      const visibleContent = wasNative
        ? (assistantMessage.content ?? '')
        : this.stripToolCallsFromContent(assistantMessage.content ?? '');

      if (!this.autoApprove) {
        const toolNames = resolvedToolCalls.map(tc => tc.function?.name || 'unknown').join(', ');
        this.postStatus(`Tool call requested: ${toolNames}. Waiting for approval...`);
        const choice = await vscode.window.showInformationMessage(
          `ManulAI wants to call: ${toolNames}`,
          { modal: false },
          'Allow',
          'Deny'
        );
        if (choice !== 'Allow') {
          messages.push({
            role: 'assistant',
            content: visibleContent || `[Tool call denied by user: ${toolNames}]`
          });
          return;
        }
      }

      messages.push({
        role: 'assistant',
        content: visibleContent,
        tool_calls: resolvedToolCalls,
        hiddenFromTranscript: true
      });

      for (const toolCall of resolvedToolCalls) {
        const toolName = toolCall.function?.name || 'unknown_tool';
        const toolResult = await this.executeToolCall(toolCall);
        messages.push({
          role: 'tool',
          content: toolResult,
          tool_name: toolName,
          hiddenFromTranscript: true
        });
      }

      await this.processOllamaResponse(messages);
      return;
    }

    let finalContent = assistantMessage.content ?? '';
    if (this.agentMode) {
      finalContent = await this.applyInlineFileBlocks(finalContent);
    }
    messages.push({
      role: 'assistant',
      content: finalContent
    });
  }

  private async callOllama(messages: OllamaMessage[]): Promise<OllamaResponse> {
    const config = vscode.workspace.getConfiguration('manulai');
    const baseUrl = String(config.get('ollamaBaseUrl', 'http://localhost:11434')).replace(/\/$/, '');
    const model = this.getSelectedModel();
    const systemPrompt = String(config.get('systemPrompt', '')).trim();

    const requestMessages: OllamaMessage[] = [];

    if (this.agentMode) {
      const workspaceInstructions = await this.getWorkspaceInstructions();

      let agentMandate = 'You are an autonomous VS Code Agent with direct file-system access through tools. ' +
        'CRITICAL RULES:\n' +
        '1. When the user asks you to modify, update, fix, or create a file — call the `write_to_file` tool. ' +
        'Do NOT paste file content into your response text. Do NOT use [FILE:] blocks. ' +
        'Only tool calls actually write to disk.\n' +
        '2. Always call `write_to_file` with the COMPLETE new file content, not a diff.\n' +
        '3. After writing, confirm briefly what you changed — do not repeat the entire file.\n' +
        '4. You may still use chat text for explanations, questions, or reasoning.';

      if (workspaceInstructions) {
        agentMandate += '\n\n<workspace_instructions>\n' + workspaceInstructions + '\n</workspace_instructions>';
      }

      requestMessages.push({
        role: 'system',
        content: agentMandate,
        hiddenFromTranscript: true
      });
    }

    if (systemPrompt) {
      requestMessages.push({ role: 'system', content: systemPrompt, hiddenFromTranscript: true });
    }

    requestMessages.push(...messages);

    const body: {
      model: string;
      stream: false;
      messages: OllamaMessage[];
      tools?: ToolDefinition[];
    } = {
      model,
      stream: false,
      messages: requestMessages
    };

    if (this.agentMode) {
      body.tools = this.getToolDefinitions();
    }

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

  private extractToolCalls(message: OllamaMessage): ToolFunctionCall[] {
    if (message.tool_calls?.length) {
      return message.tool_calls;
    }

    return this.parseToolCallsFromContent(message.content);
  }

  private stripToolCallsFromContent(content: string): string {
    let stripped = content;
    stripped = stripped.replace(/```(?:json|tool_call|tool)?\s*\n?[\s\S]*?```/g, '');
    stripped = stripped.replace(/<tool_call>\s*[\s\S]*?\s*<\/tool_call>/g, '');
    return stripped.trim();
  }

  private parseToolCallsFromContent(content: string): ToolFunctionCall[] {
    const trimmed = content.trim();
    if (!trimmed) {
      return [];
    }

    // Direct JSON parse when the whole content looks like JSON
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        const calls = this.normalizeParsedToolCalls(parsed);
        if (calls.length > 0) {
          return calls;
        }
      } catch {
        // Fall through to regex extraction
      }
    }

    // Regex fallback: extract JSON from markdown code blocks or <tool_call> tags.
    // Local LLMs (e.g. Qwen) often wrap tool-call JSON in ```json ... ``` blocks.
    const knownToolNames = new Set(this.getToolDefinitions().map(t => t.function.name));
    const candidates: string[] = [];

    const codeBlockPattern = /```(?:json|tool_call|tool)?\s*\n?([\s\S]*?)```/g;
    const tagPattern = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

    let match: RegExpExecArray | null;
    while ((match = codeBlockPattern.exec(trimmed)) !== null) {
      const inner = match[1].trim();
      if (inner.startsWith('{') || inner.startsWith('[')) {
        candidates.push(inner);
      }
    }
    while ((match = tagPattern.exec(trimmed)) !== null) {
      const inner = match[1].trim();
      if (inner.startsWith('{') || inner.startsWith('[')) {
        candidates.push(inner);
      }
    }

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate) as unknown;
        const calls = this.normalizeParsedToolCalls(parsed);
        // Only accept if every parsed name matches a known tool definition
        if (calls.length > 0 && calls.every(c => knownToolNames.has(c.function.name))) {
          return calls;
        }
      } catch {
        // Try next candidate
      }
    }

    return [];
  }

  private normalizeParsedToolCalls(rawValue: unknown): ToolFunctionCall[] {
    if (!rawValue || typeof rawValue !== 'object') {
      return [];
    }

    if (Array.isArray(rawValue)) {
      return rawValue
        .map(item => this.normalizeSingleParsedToolCall(item))
        .filter((toolCall): toolCall is ToolFunctionCall => toolCall !== undefined);
    }

    const record = rawValue as Record<string, unknown>;

    if (Array.isArray(record.tool_calls)) {
      return record.tool_calls
        .map(item => this.normalizeSingleParsedToolCall(item))
        .filter((toolCall): toolCall is ToolFunctionCall => toolCall !== undefined);
    }

    const singleToolCall = this.normalizeSingleParsedToolCall(record);
    return singleToolCall ? [singleToolCall] : [];
  }

  private normalizeSingleParsedToolCall(rawValue: unknown): ToolFunctionCall | undefined {
    if (!rawValue || typeof rawValue !== 'object') {
      return undefined;
    }

    const record = rawValue as Record<string, unknown>;
    const directName = typeof record.name === 'string' ? record.name.trim() : '';
    const directArguments = record.arguments;
    const functionRecord = this.toObjectRecord(record.function);
    const normalizedArguments = this.normalizeParsedToolArguments(functionRecord?.arguments ?? directArguments);

    const parsedToolCall: ParsedToolCall = {
      name: typeof functionRecord?.name === 'string' ? functionRecord.name.trim() : directName,
      arguments: normalizedArguments
    };

    if (!parsedToolCall.name) {
      return undefined;
    }

    return {
      type: 'function',
      function: {
        name: parsedToolCall.name,
        arguments: parsedToolCall.arguments
      }
    };
  }

  private toObjectRecord(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }

    return value as Record<string, unknown>;
  }

  private normalizeParsedToolArguments(value: unknown): Record<string, unknown> | string | undefined {
    if (typeof value === 'string') {
      return value;
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }

    return undefined;
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
          name: 'write_to_file',
          description: 'Overwrites or creates a file with new content. Use this IMMEDIATELY when the user asks to change code or update a file.',
          parameters: {
            type: 'object',
            properties: {
              filepath: {
                type: 'string',
                description: 'The absolute or workspace-relative path to the file.'
              },
              content: {
                type: 'string',
                description: 'The complete new content for the file.'
              }
            },
            required: ['filepath', 'content'],
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

  private extractInlineFileBlocks(content: string): Array<{ fullMatch: string; filepath: string; fileContent: string }> {
    const blocks: Array<{ fullMatch: string; filepath: string; fileContent: string }> = [];
    const pattern = /(?:```[\w]*\s*\n?)?\[FILE:\s*([^\]]+)\]\s*\n([\s\S]*?)\n?\s*\[\/FILE\]\s*(?:\n?```)?/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      blocks.push({
        fullMatch: match[0],
        filepath: match[1].trim(),
        fileContent: match[2]
      });
    }
    return blocks;
  }

  private async applyInlineFileBlocks(content: string): Promise<string> {
    const blocks = this.extractInlineFileBlocks(content);
    if (blocks.length === 0) {
      return content;
    }

    let result = content;
    for (const block of blocks) {
      const writeResult = await this.createOrEditFile(block.filepath, block.fileContent);
      const parsed = JSON.parse(writeResult) as Record<string, unknown>;
      const status = parsed.error
        ? `Failed to write ${block.filepath}: ${String(parsed.error)}`
        : `Wrote ${block.filepath} (${String(parsed.bytesWritten)} bytes)`;
      result = result.replace(block.fullMatch, status);
    }

    return result;
  }

  private async executeToolCall(toolCall: ToolFunctionCall): Promise<string> {
    const name = toolCall.function?.name ?? '';
    const args = this.normalizeToolArguments(toolCall.function?.arguments);

    switch (name) {
      case 'read_active_file':
        return this.readActiveFile();
      case 'read_specific_file':
        return this.readSpecificFile(String(args.filepath ?? ''));
      case 'create_or_edit_file':
        return this.createOrEditFile(String(args.filename ?? ''), String(args.content ?? ''));
      case 'write_to_file':
        return this.createOrEditFile(String(args.filepath ?? ''), String(args.content ?? ''));
      case 'execute_terminal_command':
        return this.executeTerminalCommand(String(args.command ?? ''));
      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  }

  private normalizeToolArguments(rawArguments: Record<string, unknown> | string | undefined): Record<string, unknown> {
    if (!rawArguments) {
      return {};
    }

    if (typeof rawArguments === 'string') {
      try {
        const parsed = JSON.parse(rawArguments) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return {};
      }

      return {};
    }

    return rawArguments;
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
        const exitCode = typeof (error as NodeJS.ErrnoException | null)?.code === 'number'
          ? (error as NodeJS.ErrnoException).code
          : 0;

        resolve(JSON.stringify({
          command: trimmed,
          exitCode,
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

      this.removeAttachmentContextMessages();
      this.postStateToWebview();
      this.postStatus(`Attached ${path.basename(uri.fsPath)} to the next requests.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to attach file.';
      this.postStatus(`Unable to attach dropped file: ${message}`);
    }
  }

  private addFileContentDirect(filename: string, content: string): void {
    const ext = path.extname(filename).slice(1).toLowerCase();
    const langMap: Record<string, string> = {
      ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact',
      py: 'python', rs: 'rust', go: 'go', java: 'java', c: 'c', cpp: 'cpp',
      cs: 'csharp', rb: 'ruby', php: 'php', swift: 'swift', kt: 'kotlin',
      md: 'markdown', json: 'json', yaml: 'yaml', yml: 'yaml',
      html: 'html', css: 'css', scss: 'scss', xml: 'xml', sql: 'sql',
      sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript',
      toml: 'toml', ini: 'ini'
    };
    const languageId = langMap[ext] || 'plaintext';
    const syntheticUri = vscode.Uri.file(path.join('/dropped', filename));

    this.attachedFiles.set(syntheticUri.fsPath, {
      uri: syntheticUri,
      name: filename,
      content,
      languageId
    });

    this.removeAttachmentContextMessages();
    this.postStateToWebview();
    this.postStatus(`Attached ${filename} to the next requests.`);
  }

  private async addFilePathContext(rawUri: string): Promise<void> {
    try {
      const uri = rawUri.startsWith('file:') ? vscode.Uri.parse(rawUri) : this.resolveWorkspaceUri(rawUri);
      const bytes = await vscode.workspace.fs.readFile(uri);
      const content = Buffer.from(bytes).toString('utf8');
      const name = path.basename(uri.fsPath);

      let languageId = 'plaintext';
      try {
        const document = await vscode.workspace.openTextDocument(uri);
        languageId = document.languageId;
      } catch {
        // Keep plaintext fallback.
      }

      this.attachedFiles.set(uri.fsPath, {
        uri,
        name,
        content,
        languageId
      });

      this.removeAttachmentContextMessages();
      this.postStateToWebview();
      this.postStatus(`Attached ${name} to the next requests.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to attach file.';
      this.postStatus(`Unable to attach file: ${message}`);
    }
  }

  private async browseAndAttachFiles(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFiles: true,
      canSelectFolders: false,
      openLabel: 'Attach',
      title: 'Attach files to ManulAI context'
    });

    if (!uris?.length) {
      return;
    }

    for (const uri of uris) {
      await this.addFileContext(uri.fsPath);
    }
  }

  private async setAgentMode(value: boolean | undefined): Promise<void> {
    this.agentMode = value !== undefined ? value : !this.agentMode;

    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;

    await vscode.workspace.getConfiguration('manulai').update('agentMode', this.agentMode, target);
    this.postStateToWebview();
    this.postStatus(
      this.agentMode
        ? 'Agent Mode enabled. Ollama can call local tools and continue the loop automatically.'
        : 'Agent Mode disabled. Requests run as plain chat without any tools.'
    );
  }

  private async setAutoApprove(value: boolean | undefined): Promise<void> {
    this.autoApprove = value !== undefined ? value : !this.autoApprove;

    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;

    await vscode.workspace.getConfiguration('manulai').update('autoApprove', this.autoApprove, target);
    this.postStateToWebview();
    this.postStatus(
      this.autoApprove
        ? 'Auto-Approve enabled. Tools will execute without asking.'
        : 'Auto-Approve disabled. You will be asked before each tool execution.'
    );
  }

  private synchronizeAttachmentContextMessage(): void {
    this.removeAttachmentContextMessages();

    if (this.attachedFiles.size === 0) {
      return;
    }

    this.messages.push({
      role: 'user',
      content: this.renderAttachmentContextMessage(),
      hiddenFromTranscript: true,
      attachmentContext: true
    });
  }

  private removeAttachmentContextMessages(): void {
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      if (this.messages[index].attachmentContext) {
        this.messages.splice(index, 1);
      }
    }
  }

  private renderAttachmentContextMessage(): string {
    const renderedFiles = Array.from(this.attachedFiles.values())
      .map(file => {
        const filePath = file.uri.fsPath.startsWith('/dropped/') || file.uri.fsPath.startsWith('/attached/')
          ? (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
            ? `${vscode.workspace.workspaceFolders[0].uri.fsPath}/${file.name}`
            : file.name)
          : file.uri.fsPath;
        return [
          `[Attached File: ${file.name} | Path: ${filePath}]`,
          file.content,
          '[/Attached File]'
        ].join('\n');
      })
      .join('\n\n');

    return [
      'The user has attached the following file(s) for reference.',
      'The complete file contents are provided below. Do NOT use tools to re-read these files. Do NOT overwrite them unless the user explicitly asks you to modify them.',
      renderedFiles
    ].join('\n\n');
  }

  private normalizeDroppedPath(rawPath: string): string {
    let value = rawPath.trim();

    if (!value) {
      throw new Error('Dropped path is empty.');
    }

    if (value.includes('\n')) {
      value = value.split(/\r?\n/)[0].trim();
    }

    if (value.startsWith('file:')) {
      try {
        value = decodeURIComponent(value);
      } catch {
        // Keep original if decoding fails.
      }
    }

    return value;
  }

  private async getWorkspaceInstructions(): Promise<string> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceRoot) {
      return '';
    }

    const candidates = [
      '.manul-instructions',
      '.cursorrules',
      '.github/copilot-instructions.md',
      '.copilot-instructions'
    ];

    for (const candidate of candidates) {
      try {
        const uri = vscode.Uri.joinPath(workspaceRoot, candidate);
        const bytes = await vscode.workspace.fs.readFile(uri);
        const content = Buffer.from(bytes).toString('utf8').trim();
        if (content) {
          return content;
        }
      } catch {
        // File does not exist or is unreadable — try next candidate.
      }
    }

    return '';
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

  private getDisplayPath(file: AttachedFileContext): string {
    const fsPath = file.uri.fsPath;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot && fsPath.startsWith(workspaceRoot + '/')) {
      return fsPath.slice(workspaceRoot.length + 1);
    }
    if (fsPath.startsWith('/dropped/') || fsPath.startsWith('/attached/')) {
      return file.name;
    }
    return fsPath;
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
      if (message.role === 'system' || message.role === 'tool' || message.hiddenFromTranscript) {
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
      currentModel: this.getSelectedModel(),
      availableModels: this.availableModels,
      agentMode: this.agentMode,
      autoApprove: this.autoApprove,
      attachments: Array.from(this.attachedFiles.values()).map(file => ({
        path: file.uri.fsPath,
        displayPath: this.getDisplayPath(file),
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
