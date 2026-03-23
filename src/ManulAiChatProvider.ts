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
  activeEditorContext?: boolean;
  revertOperationIds?: string[];
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
    | 'stopRequest'
    | 'clearChat'
    | 'attachActiveFile'
    | 'revertFileChanges'
    | 'approvePendingAction'
    | 'declinePendingAction'
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
  autoApprove?: boolean;
  operationIds?: string[];
  filename?: string;
  content?: string;
  attachments?: Array<{ name: string; content: string }>;
}

interface WebviewRenderableMessage {
  role: Exclude<ChatRole, 'system'> | 'status';
  content: string;
  revertAction?: {
    operationIds: string[];
    label: string;
    details?: string;
  };
}

interface WebviewActiveFileState {
  path: string;
  name: string;
  displayPath: string;
}

interface WebviewPendingApprovalState {
  kind: 'tool' | 'file-write';
  title: string;
  message: string;
  details?: string;
  approveLabel: string;
  declineLabel: string;
}

interface RevertSnapshot {
  id: string;
  filepath: string;
  displayName: string;
  previousContent: string;
  updatedContent: string;
  reverted: boolean;
}

interface FileWriteSummary {
  summary: string;
  revertOperationId?: string;
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
  private stopRequested = false;
  private currentRequestAbortController?: AbortController;
  private pendingApproval?: WebviewPendingApprovalState;
  private pendingApprovalResolver?: (approved: boolean) => void;
  private readonly revertSnapshots = new Map<string, RevertSnapshot>();

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

  public handleActiveEditorChange(): void {
    this.postStateToWebview();
  }

  public async attachFilesByUri(uris: vscode.Uri[]): Promise<void> {
    for (const uri of uris) {
      await this.addFileContext(uri.toString());
    }
  }

  public async attachActiveEditorFile(): Promise<void> {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (!activeUri || activeUri.scheme === 'untitled') {
      this.postStatus('No saved active editor file to attach.');
      return;
    }

    await this.addFileContext(activeUri.toString());
  }

  public async attachExplorerSelectionFromClipboard(): Promise<void> {
    const previousClipboard = await vscode.env.clipboard.readText();

    try {
      await vscode.commands.executeCommand('copyFilePath');
      const clipboardText = await vscode.env.clipboard.readText();
      const candidates = clipboardText
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);

      if (candidates.length === 0 || clipboardText === previousClipboard) {
        this.postStatus('No Explorer file selection was available to attach. Focus Explorer and select a file first.');
        return;
      }

      for (const candidate of candidates) {
        await this.addFileContext(candidate);
      }
    } finally {
      await vscode.env.clipboard.writeText(previousClipboard);
    }
  }

  private async handleWebviewMessage(message: WebviewInboundMessage): Promise<void> {
    switch (message.command) {
      case 'ready':
        await this.refreshModelCatalog(false);
        this.postStateToWebview();
        return;
      case 'clearChat':
        this.clearChat();
        return;
      case 'attachActiveFile':
        await this.attachActiveEditorFile();
        return;
      case 'revertFileChanges':
        await this.revertFileChanges(message.operationIds);
        return;
      case 'approvePendingAction':
        this.resolvePendingApproval(true);
        return;
      case 'declinePendingAction':
        this.resolvePendingApproval(false);
        return;
      case 'sendMessage':
        if (!message.text?.trim()) {
          return;
        }
        await this.sendUserMessage(message.text.trim(), message.attachments, message.autoApprove);
        return;
      case 'stopRequest':
        this.stopActiveRequest();
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

  private async sendUserMessage(
    text: string,
    frontendAttachments?: Array<{ name: string; content: string }>,
    frontendAutoApprove?: boolean
  ): Promise<void> {
    if (this.requestInFlight) {
      this.postStatus('A request is already running. Wait for the current response to finish.');
      return;
    }

    if (typeof frontendAutoApprove === 'boolean') {
      this.autoApprove = frontendAutoApprove;
    }

    this.synchronizeActiveEditorContextMessage();
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

    if (this.agentMode) {
      const directSummary = await this.tryHandleDirectLicenseAuthorRename(text);
      if (directSummary) {
        this.messages.push(this.createAssistantMessage(directSummary.summary, directSummary.revertOperationId ? [directSummary.revertOperationId] : []));
        this.postStateToWebview();
        return;
      }
    }

    this.postStateToWebview();
    await this.runAgentLoop();
  }

  private looksLikeFileMutationRequest(text: string): boolean {
    const normalized = text.trim().toLowerCase();
    if (!normalized) {
      return false;
    }

    const editVerbPattern = /\b(change|edit|modify|update|rewrite|rename|replace|fix|refactor|add|remove|delete|create|write|insert|patch)\b|(?:^|\s)(?:поміняй|зміни|измени|поменяй|онови|обнови|заміни|замени|відредагуй|редагуй|перепиши|додай|добавь|видали|удали|створи|создай|виправ|исправь)(?:\s|$)/i;
    const fileTargetPattern = /\b(file|files|readme|license|package\.json|tsconfig|title|header|line|code|text)\b|(?:^|\s)(?:тайтл|заголовок|хедер|ридми|рідмі|файл|код|текст)(?:\s|$)|(?:^|\s)[.\w\-/]+\.(?:ts|tsx|js|jsx|json|md|css|html|py|yml|yaml)(?:\s|$)/i;

    return editVerbPattern.test(normalized) && fileTargetPattern.test(normalized);
  }

  private async tryHandleDirectLicenseAuthorRename(text: string): Promise<FileWriteSummary | undefined> {
    const match = text.match(/change\s+author\s+name\s+to\s+(.+?)\s+in\s+license\b/i);
    if (!match) {
      return undefined;
    }

    const requestedAuthor = match[1].trim().replace(/^[`"']+|[`"']+$/g, '');
    if (!requestedAuthor) {
      return undefined;
    }

    const licenseUri = this.resolveWorkspaceUri('LICENSE');
    const currentContent = await this.readWorkspaceText(licenseUri);
    const updatedContent = currentContent.replace(
      /^Copyright(\s+\(c\))?\s+(\d{4})\s+.+$/gm,
      (_fullMatch, copyrightMarker: string | undefined, year: string) => `Copyright${copyrightMarker ?? ''} ${year} ${requestedAuthor}`
    );

    if (updatedContent === currentContent) {
      return { summary: 'LICENSE: no changes detected.' };
    }

    return this.writeFileWithDiff(licenseUri.fsPath, updatedContent);
  }

  private clearChat(): void {
    if (this.requestInFlight) {
      this.postStatus('Cannot clear chat while a request is running. Wait for the current response to finish.');
      return;
    }

    this.messages.length = 0;
    this.attachedFiles.clear();
    this.postStateToWebview();
    this.postStatus('Chat history and attached context cleared.');
  }

  private async runAgentLoop(): Promise<void> {
    this.requestInFlight = true;
    this.stopRequested = false;
    this.postBusyState(true);

    try {
      await this.processOllamaResponse(this.messages);
      this.postStateToWebview();
    } catch (error) {
      if (this.isAbortError(error)) {
        this.postStatus('Request stopped.');
        return;
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.postStatus(`Request failed: ${message}`);
    } finally {
      this.currentRequestAbortController = undefined;
      this.stopRequested = false;
      this.requestInFlight = false;
      this.postBusyState(false);
      this.postStateToWebview();
    }
  }

  private async processOllamaResponse(messages: OllamaMessage[], retryCount = 0): Promise<void> {
    this.throwIfRequestStopped();
    const responseData = await this.callOllama(messages);
    this.throwIfRequestStopped();
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
        const approved = await this.requestApproval({
          kind: 'tool',
          title: 'Tool Approval Required',
          message: `ManulAI wants to call: ${toolNames}`,
          details: visibleContent || undefined,
          approveLabel: 'Approve',
          declineLabel: 'Decline'
        });
        if (!approved) {
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
        this.throwIfRequestStopped();
        const toolName = toolCall.function?.name || 'unknown_tool';
        const toolResult = await this.executeToolCall(toolCall);
        this.throwIfRequestStopped();
        messages.push({
          role: 'tool',
          content: toolResult,
          tool_name: toolName,
          hiddenFromTranscript: true
        });
      }

      await this.processOllamaResponse(messages, 0);
      return;
    }

    let finalContent = assistantMessage.content ?? '';

    if (!this.agentMode) {
      // Chat mode: display the model response as-is, no file-write fallback processing.
      finalContent = this.truncateLargeCodeBlocks(finalContent);
      if (!finalContent.trim()) {
        finalContent = 'The model returned an empty response. Try rephrasing your question.';
      }
      messages.push({ role: 'assistant', content: finalContent });
      return;
    }

    {
      // --- Fallback layer 1: detect [Begin of FILE]...[End of FILE] markers ---
      const markerWrite = this.extractMarkerFileWrite(finalContent);
      if (markerWrite) {
        const writeApproved = await this.approveFileWrite([markerWrite.filepath]);
        if (!writeApproved) {
          messages.push({ role: 'assistant', content: `[File write denied by user: ${markerWrite.filepath}]` });
          return;
        }
        const summary = await this.writeFileWithDiff(markerWrite.filepath, markerWrite.fileContent);
        const remaining = finalContent.replace(markerWrite.fullMatch, '').trim();
        finalContent = summary.summary + (remaining ? '\n\n' + this.truncateLongResponse(remaining) : '');
        messages.push(this.createAssistantMessage(finalContent, summary.revertOperationId ? [summary.revertOperationId] : []));
        return;
      }

      // --- Fallback layer 2: detect code blocks with filepath hints ---
      const codeBlockWrites = this.extractCodeBlockFileWrites(finalContent);
      if (codeBlockWrites.length > 0) {
        const fileNames = codeBlockWrites.map(w => w.filepath);
        const writeApproved = await this.approveFileWrite(fileNames);
        if (!writeApproved) {
          messages.push({ role: 'assistant', content: `[File write denied by user: ${fileNames.join(', ')}]` });
          return;
        }

        const appliedSummaries: string[] = [];
        const revertOperationIds: string[] = [];
        for (const block of codeBlockWrites) {
          const summary = await this.writeFileWithDiff(block.filepath, block.fileContent);
          appliedSummaries.push(summary.summary);
          if (summary.revertOperationId) {
            revertOperationIds.push(summary.revertOperationId);
          }
          finalContent = finalContent.replace(block.fullMatch, '');
        }
        finalContent = appliedSummaries.join('\n\n') + (finalContent.trim() ? '\n\n' + this.truncateLongResponse(finalContent.trim()) : '');
        messages.push(this.createAssistantMessage(finalContent, revertOperationIds));
        return;
      }

      // --- Fallback layer 2b: detect simple unified diffs ---
      const unifiedDiffWrite = await this.extractUnifiedDiffWrite(finalContent);
      if (unifiedDiffWrite) {
        const writeApproved = await this.approveFileWrite([unifiedDiffWrite.filepath]);
        if (!writeApproved) {
          messages.push({ role: 'assistant', content: `[File write denied by user: ${unifiedDiffWrite.filepath}]` });
          return;
        }
        const summary = await this.writeFileWithDiff(unifiedDiffWrite.filepath, unifiedDiffWrite.fileContent);
        const remaining = finalContent.replace(unifiedDiffWrite.fullMatch, '').trim();
        messages.push(this.createAssistantMessage(summary.summary + (remaining ? '\n\n' + this.truncateLongResponse(remaining) : ''), summary.revertOperationId ? [summary.revertOperationId] : []));
        return;
      }

      // --- Fallback layer 3: apply [FILE:] blocks ---
      const inlineFileBlocks = this.extractInlineFileBlocks(finalContent);
      if (inlineFileBlocks.length > 0) {
        const fileNames = inlineFileBlocks.map(b => b.filepath);
        const writeApproved = await this.approveFileWrite(fileNames);
        if (!writeApproved) {
          messages.push({ role: 'assistant', content: `[File write denied by user: ${fileNames.join(', ')}]` });
          return;
        }
        const appliedSummaries: string[] = [];
        const revertOperationIds: string[] = [];
        let remaining = finalContent;
        for (const block of inlineFileBlocks) {
          const summary = await this.writeFileWithDiff(block.filepath, block.fileContent);
          appliedSummaries.push(summary.summary);
          if (summary.revertOperationId) {
            revertOperationIds.push(summary.revertOperationId);
          }
          remaining = remaining.replace(block.fullMatch, '');
        }
        remaining = remaining.trim();
        finalContent = appliedSummaries.join('\n\n') + (remaining ? '\n\n' + this.truncateLongResponse(remaining) : '');
        messages.push(this.createAssistantMessage(finalContent, revertOperationIds));
        return;
      }

      // --- Fallback layer 4: detect described replacements (old → new code blocks) ---
      const describedReplacements = this.extractDescribedReplacements(finalContent);
      if (describedReplacements.length > 0) {
        // Resolve filepath: attached files → mentioned file name → active editor
        let targetFile = this.findAttachedFileForReplacements(describedReplacements);
        if (!targetFile) {
          targetFile = await this.findMentionedFileForReplacements(finalContent, describedReplacements);
        }
        if (!targetFile) {
          // Last resort: check the currently active editor
          const activeDoc = vscode.window.activeTextEditor?.document;
          if (activeDoc && !activeDoc.isUntitled) {
            const activeContent = activeDoc.getText();
            const anyMatch = describedReplacements.some(rep => activeContent.includes(rep.oldText));
            if (anyMatch) {
              targetFile = activeDoc.uri.fsPath;
            }
          }
        }
        if (targetFile) {
          const names = [path.basename(targetFile)];
          const writeApproved = await this.approveFileWrite([targetFile]);
          if (!writeApproved) {
            messages.push({ role: 'assistant', content: `[Replacement denied by user: ${names.join(', ')}]` });
            return;
          }

          const originalContent = await this.readWorkspaceText(vscode.Uri.file(targetFile));
          const appliedSummaries: string[] = [];
          let hadSuccessfulReplacement = false;
          for (const rep of describedReplacements) {
            let result = await this.replaceInFile(targetFile, rep.oldText, rep.newText);
            let parsed = JSON.parse(result) as Record<string, unknown>;
            if (typeof parsed.error === 'string' && /matched\s+\d+\s+times/i.test(parsed.error)) {
              result = await this.replaceAllInFile(targetFile, rep.oldText, rep.newText);
              parsed = JSON.parse(result) as Record<string, unknown>;
            }
            if (parsed.error) {
              if (hadSuccessfulReplacement && typeof parsed.error === 'string' && /old_text not found/i.test(parsed.error)) {
                const currentContent = await this.readWorkspaceText(vscode.Uri.file(targetFile));
                if (currentContent.includes(rep.newText) && !currentContent.includes(rep.oldText)) {
                  appliedSummaries.push(`Skipped overlapping replacement in ${path.basename(targetFile)}.`);
                  continue;
                }
              }
              appliedSummaries.push(`Replace failed in ${path.basename(targetFile)}: ${String(parsed.error)}`);
            } else {
              const replacements = Number(parsed.replacements ?? 1);
              hadSuccessfulReplacement = true;
              appliedSummaries.push(`Replaced ${replacements} occurrence(s) in ${path.basename(targetFile)}.`);
            }
          }

          if (hadSuccessfulReplacement) {
            const updatedContent = await this.readWorkspaceText(vscode.Uri.file(targetFile));
            const diffSummary = this.buildDiffSummary(path.basename(targetFile), originalContent, updatedContent);
            if (diffSummary) {
              const notes = appliedSummaries.filter(summary => !summary.startsWith('Replaced '));
              const revertOperationId = this.createRevertSnapshot(targetFile, originalContent, updatedContent);
              messages.push(this.createAssistantMessage(diffSummary + (notes.length > 0 ? '\n\n' + notes.join('\n') : ''), revertOperationId ? [revertOperationId] : []));
              return;
            }
          }

          messages.push({ role: 'assistant', content: appliedSummaries.join('\n') });
          return;
        }
      }

      // --- Fallback layer 4b: detect a whole-file dump in a fenced block without [FILE:] markers ---
      const describedFileDump = await this.extractDescribedFileDump(finalContent);
      if (describedFileDump) {
        const writeApproved = await this.approveFileWrite([describedFileDump.filepath]);
        if (!writeApproved) {
          messages.push({ role: 'assistant', content: `[File write denied by user: ${describedFileDump.filepath}]` });
          return;
        }
        const summary = await this.writeFileWithDiff(describedFileDump.filepath, describedFileDump.fileContent);
        const remaining = finalContent.replace(describedFileDump.fullMatch, '').trim();
        messages.push(this.createAssistantMessage(summary.summary + (remaining ? '\n\n' + this.truncateLongResponse(remaining) : ''), summary.revertOperationId ? [summary.revertOperationId] : []));
        return;
      }

      // --- Fallback layer 4: apply legacy [FILE:] blocks ---
      finalContent = await this.applyInlineFileBlocks(finalContent);

      // --- Fallback layer 5: if response is suspiciously large, try matching to attached, active, or any workspace file ---
      const matchedFile = this.matchResponseToAttachedFile(finalContent);
      if (matchedFile) {
        const writeApproved = await this.approveFileWrite([matchedFile.filepath]);
        if (!writeApproved) {
          messages.push({ role: 'assistant', content: `[File write denied by user: ${matchedFile.filepath}]` });
          return;
        }
        const summary = await this.writeFileWithDiff(matchedFile.filepath, matchedFile.fileContent);
        messages.push(this.createAssistantMessage(summary.summary, summary.revertOperationId ? [summary.revertOperationId] : []));
        return;
      }

      const matchedActiveFile = this.matchResponseToActiveFile(finalContent);
      if (matchedActiveFile) {
        const writeApproved = await this.approveFileWrite([matchedActiveFile.filepath]);
        if (!writeApproved) {
          messages.push({ role: 'assistant', content: `[File write denied by user: ${matchedActiveFile.filepath}]` });
          return;
        }
        const summary = await this.writeFileWithDiff(matchedActiveFile.filepath, matchedActiveFile.fileContent);
        messages.push(this.createAssistantMessage(summary.summary, summary.revertOperationId ? [summary.revertOperationId] : []));
        return;
      }

      // Universal fallback: match against all workspace files
      const workspaceFiles = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 100);
      for (const fileUri of workspaceFiles) {
        try {
          const bytes = await vscode.workspace.fs.readFile(fileUri);
          const fileContent = Buffer.from(bytes).toString('utf8');
          const originalLines = fileContent.split('\n').filter(l => l.trim().length > 20);
          if (originalLines.length < 5) continue;
          let matchCount = 0;
          for (const line of originalLines) {
            if (finalContent.includes(line.trim())) {
              matchCount++;
            }
          }
          const ratio = matchCount / originalLines.length;
          if (ratio > 0.4) {
            const extractedContent = this.extractTrustedFullFileContent(finalContent, fileContent);
            if (!extractedContent) {
              continue;
            }
            const summary = await this.writeFileWithDiff(fileUri.fsPath, extractedContent);
            messages.push(this.createAssistantMessage(summary.summary, summary.revertOperationId ? [summary.revertOperationId] : []));
            return;
          }
        } catch {}
      }

      if (this.agentMode) {
        // --- Fallback layer 6: nudge the model to use tools if it didn't ---
        const isLongDump = finalContent.length > 300;
        const hasLargeCodeBlocks = /```[\w]*\n[\s\S]{100,}?```/.test(finalContent);
        const claimsDone = /(?:зробив|замінив|оновив|готово|i've made|i have made|i have updated|summary of the changes)/i.test(finalContent);
        const mentionsChange = /(?:змін|зроби|оновл|replac|chang|updat|modif)/i.test(finalContent);
        
        const shouldNudge = (isLongDump || hasLargeCodeBlocks || claimsDone || mentionsChange) && retryCount < 2;

        if (shouldNudge) {
          messages.push({
            role: 'assistant',
            content: finalContent,
            hiddenFromTranscript: true
          });
          
          let nudgeMessage = '';
          if (isLongDump || hasLargeCodeBlocks) {
            nudgeMessage = 'You returned code or a large file dump without using a tool. If you need to inspect or modify files, call one of the provided tools directly. If no tool is needed, answer briefly without dumping full file contents.';
          } else {
            nudgeMessage = 'You described changes but did not call a tool. If you need to modify files, use one of the provided tools. If no file change is needed, answer normally.';
          }

          messages.push({
            role: 'user',
            content: nudgeMessage,
            hiddenFromTranscript: true
          });
          this.postStatus(`Model did not use tools (attempt ${retryCount + 1}) — retrying...`);
          await this.processOllamaResponse(messages, retryCount + 1);
          return;
        }
      }

      // Final safety: truncate any remaining large output
      finalContent = this.truncateLargeCodeBlocks(finalContent);
      finalContent = this.truncateLongResponse(finalContent);

      if (!finalContent.trim()) {
        finalContent = this.agentMode
          ? 'The model completed the request but returned no final text response. If file changes were expected, try the request again or switch to a model with stronger tool-calling support.'
          : 'No files were changed. Chat mode can only provide a proposed patch or instructions.';
      }
    }

    messages.push({
      role: 'assistant',
      content: finalContent
    });
  }

  private extractMarkerFileWrite(content: string): { fullMatch: string; filepath: string; fileContent: string } | undefined {
    // Detect patterns like: [Begin of LICENSE]...[End of LICENSE]
    // or **[Begin of filename]**...**[End of filename]**
    const pattern = /\*?\*?\[Begin\s+of\s+([^\]]+)\]\*?\*?\s*\n([\s\S]*?)\n\s*\*?\*?\[End\s+of\s+\1\]\*?\*?/i;
    const match = pattern.exec(content);
    if (!match) {
      return undefined;
    }
    const rawName = match[1].trim();

    // Try to resolve the marker name to an attached file path
    let filepath = rawName;
    for (const [fsPath, file] of this.attachedFiles) {
      const baseName = path.basename(fsPath);
      if (baseName.toLowerCase() === rawName.toLowerCase() || file.name.toLowerCase() === rawName.toLowerCase()) {
        filepath = fsPath;
        break;
      }
    }

    // Strip markdown formatting from the extracted content
    let fileContent = match[2];
    // Remove leading/trailing --- (markdown hr)
    fileContent = fileContent.replace(/^\s*---\s*\n?/, '').replace(/\n?\s*---\s*$/, '');
    // Remove **bold** markdown wrappers on section headers (keep the text)
    fileContent = fileContent.replace(/\*\*([^*]+)\*\*/g, '$1');

    return {
      fullMatch: match[0],
      filepath,
      fileContent: fileContent.trim()
    };
  }

  private matchResponseToAttachedFile(content: string): { filepath: string; fileContent: string } | undefined {
    if (this.attachedFiles.size === 0 || content.length < 500) {
      return undefined;
    }

    // Check if the response is mostly a reproduction of an attached file
    for (const [fsPath, file] of this.attachedFiles) {
      // Compare: if >40% of the attached file's lines appear in the response, it's likely a file dump
      const originalLines = file.content.split('\n').filter(l => l.trim().length > 20);
      if (originalLines.length < 5) {
        continue;
      }
      let matchCount = 0;
      for (const line of originalLines) {
        if (content.includes(line.trim())) {
          matchCount++;
        }
      }
      const ratio = matchCount / originalLines.length;
      if (ratio > 0.4) {
        const fileContent = this.extractTrustedFullFileContent(content, file.content);
        if (fileContent) {
          return { filepath: fsPath, fileContent };
        }
      }
    }
    return undefined;
  }

  private matchResponseToActiveFile(content: string): { filepath: string; fileContent: string } | undefined {
    const activeDoc = vscode.window.activeTextEditor?.document;
    if (!activeDoc || activeDoc.isUntitled || content.length < 500) {
      return undefined;
    }

    const originalContent = activeDoc.getText();
    const originalLines = originalContent.split('\n').filter(l => l.trim().length > 20);
    if (originalLines.length < 5) {
      return undefined;
    }

    let matchCount = 0;
    for (const line of originalLines) {
      if (content.includes(line.trim())) {
        matchCount++;
      }
    }

    const ratio = matchCount / originalLines.length;
    if (ratio <= 0.4) {
      return undefined;
    }

    const fileContent = this.extractTrustedFullFileContent(content, originalContent);
    if (!fileContent) {
      return undefined;
    }

    return {
      filepath: activeDoc.uri.fsPath,
      fileContent
    };
  }

  private extractTrustedFullFileContent(content: string, originalContent?: string): string | undefined {
    const extracted = this.sanitizeGeneratedFileContent(this.extractLikelyFileContent(content));
    if (!extracted) {
      return undefined;
    }

    if (this.looksLikeDiffOutput(content) || this.looksLikeDiffOutput(extracted)) {
      return undefined;
    }

    const extractedLineCount = extracted.split('\n').filter(line => line.trim().length > 0).length;
    if (extractedLineCount < 8) {
      return undefined;
    }

    if (!originalContent) {
      return extracted.length >= 200 ? extracted : undefined;
    }

    const originalLength = originalContent.trim().length;
    if (originalLength > 500) {
      const extractedLength = extracted.trim().length;
      const extractedLines = extracted.split('\n').filter(line => line.trim().length > 0).length;
      const originalLines = originalContent.split('\n').filter(line => line.trim().length > 0).length;

      if (extractedLength < originalLength * 0.85 || extractedLength > originalLength * 1.2) {
        return undefined;
      }

      if (originalLines > 20 && (extractedLines < originalLines * 0.85 || extractedLines > originalLines * 1.2)) {
        return undefined;
      }
    }

    if (this.looksLikeChangeSummary(content)) {
      return undefined;
    }

    return extracted;
  }

  private sanitizeGeneratedFileContent(content: string): string {
    if (!content) {
      return content;
    }

    const sanitizedLines = content
      .split('\n')
      .filter(line => {
        const trimmed = line.trim();
        if (!trimmed) {
          return true;
        }

        if (/^\[(?:Active|Attached) File:.*\]$/i.test(trimmed)) {
          return false;
        }

        if (/^\[\/(?:Active|Attached) File\]$/i.test(trimmed)) {
          return false;
        }

        if (/^<\/?manulai_(?:active_editor_context|attached_file)\b.*>$/i.test(trimmed)) {
          return false;
        }

        return true;
      });

    return sanitizedLines.join('\n').trim();
  }

  private looksLikeDiffOutput(content: string): boolean {
    const trimmed = content.trim();
    if (!trimmed) {
      return false;
    }

    if (/```(?:diff|patch)\b/i.test(trimmed)) {
      return true;
    }

    if (/^(?:diff\s+--git|index\s+[0-9a-f]+\.\.[0-9a-f]+|---\s+.+|\+\+\+\s+.+|@@\s+[-+,0-9\s]+@@|@@\s+line\s+\d+\s+@@)/m.test(trimmed)) {
      return true;
    }

    if (/updated\s+\*\*[^*]+\*\*\s+[—-]\s+changed lines:/i.test(trimmed)) {
      return true;
    }

    if (/\.\.\.\s*\(\d+\s+more diff lines\)\s*\.\.\./i.test(trimmed)) {
      return true;
    }

    const lines = trimmed.split('\n').map(line => line.trim()).filter(Boolean);
    if (lines.length === 0) {
      return false;
    }

    const changedLineCount = lines.filter(line => {
      if (/^(?:\+|-)(?![-+]{2}\s)/.test(line)) {
        return true;
      }

      return /^changed\s+lines:?$/i.test(line);
    }).length;

    return changedLineCount >= 3 && changedLineCount / lines.length > 0.15;
  }

  private looksLikeChangeSummary(content: string): boolean {
    const trimmed = content.trim();
    if (!trimmed) {
      return false;
    }

    if (this.looksLikeDiffOutput(trimmed)) {
      return true;
    }

    return /(?:simple\s+find-and-replace|perform\s+a\s+simple\s+find-and-replace|here\s+are\s+the\s+steps|here\s+is\s+the\s+modified\s+content\s+of\s+the\s+`?[^`\n]+`?\s+file:|to\s+change\s+the\s+author\s+name\s+from)/i.test(trimmed);
  }

  private extractLikelyFileContent(content: string): string {
    const fencedBlocks = Array.from(content.matchAll(/```(?:([\w.+-]+))?\n([\s\S]*?)```/g));
    if (fencedBlocks.length > 0) {
      const largestBlock = fencedBlocks.reduce((largest, current) => {
        const largestContent = largest[2] ?? '';
        const currentContent = current[2] ?? '';
        return currentContent.length > largestContent.length ? current : largest;
      });
      const blockLanguage = (largestBlock[1] ?? '').trim().toLowerCase();
      const blockContent = (largestBlock[2] ?? '').trim();
      if (blockContent.length > 0 && blockLanguage !== 'diff' && blockLanguage !== 'patch' && !this.looksLikeDiffOutput(blockContent)) {
        return blockContent;
      }
    }

    let extracted = content.replace(/^[\s\S]*?(?=(?:Copyright|package|import|<!DOCTYPE|<\?xml|#!\/|{))/i, '');
    extracted = extracted.replace(/\n?```\s*$/g, '');

    const lines = extracted.split('\n');
    if (lines.length > 10) {
      while (lines.length > 0 && lines[0].trim().length < 3) { lines.shift(); }
      while (lines.length > 0 && lines[lines.length - 1].trim().length < 3) { lines.pop(); }
    }

    return lines.join('\n').trim();
  }

  private async approveFileWrite(filepaths: string[]): Promise<boolean> {
    const names = filepaths.map(p => path.basename(p)).join(', ');
    if (this.autoApprove) {
      this.postStatus(`Applying detected file write: ${names}.`);
      return true;
    }

    return this.requestApproval({
      kind: 'file-write',
      title: 'File Write Approval Required',
      message: `ManulAI wants to modify: ${names}`,
      details: filepaths.join('\n'),
      approveLabel: 'Approve',
      declineLabel: 'Decline'
    });
  }

  private async requestApproval(state: WebviewPendingApprovalState): Promise<boolean> {
    if (this.autoApprove) {
      return true;
    }

    if (!this.webviewView) {
      const choice = await vscode.window.showInformationMessage(
        state.message,
        { modal: false, detail: state.details },
        state.approveLabel,
        state.declineLabel
      );
      return choice === state.approveLabel;
    }

    if (this.pendingApprovalResolver) {
      this.pendingApprovalResolver(false);
      this.pendingApprovalResolver = undefined;
    }

    this.pendingApproval = state;
    this.postStatus(`${state.message}. Waiting for approval...`);
    this.postStateToWebview();

    return new Promise(resolve => {
      this.pendingApprovalResolver = (approved: boolean) => {
        this.pendingApproval = undefined;
        this.pendingApprovalResolver = undefined;
        this.postStateToWebview();
        resolve(approved);
      };

      void vscode.window.showInformationMessage(
        state.message,
        { modal: false, detail: state.details },
        state.approveLabel,
        state.declineLabel
      ).then(choice => {
        if (!this.pendingApprovalResolver) {
          return;
        }

        if (choice === state.approveLabel) {
          this.resolvePendingApproval(true);
        } else if (choice === state.declineLabel) {
          this.resolvePendingApproval(false);
        }
      });
    });
  }

  private resolvePendingApproval(approved: boolean): void {
    if (!this.pendingApprovalResolver) {
      return;
    }

    const resolver = this.pendingApprovalResolver;
    resolver(approved);
  }

  private truncateLongResponse(content: string): string {
    const lines = content.split('\n');
    if (lines.length <= 25) {
      return content;
    }
    const head = lines.slice(0, 10).join('\n');
    const tail = lines.slice(-5).join('\n');
    const omitted = lines.length - 15;
    return head + '\n\n... (' + String(omitted) + ' lines omitted) ...\n\n' + tail;
  }

  private extractDescribedReplacements(content: string): Array<{ oldText: string; newText: string }> {
    const replacements: Array<{ oldText: string; newText: string }> = [];

    // Normalize all quote variants to straight ASCII quotes for reliable matching
    const normalized = content
      .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')  // smart double quotes → "
      .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")  // smart single quotes → '
      .replace(/[«»]/g, '"');                                     // guillemets → "

    // Pattern 0: broad natural-language rename instructions where many words appear between the verb and quoted values.
    const broadInstructionPattern =
      /(?:replace|replaced|замін\w*|змін\w*|оновл\w*)[^\n]{0,140}?["'`]([^"'`\n]+)["'`][^\n]{0,40}?(?:with|to|на|->|→)[\s:]*["'`]([^"'`\n]+)["'`]/gi;
    let match: RegExpExecArray | null;
    while ((match = broadInstructionPattern.exec(normalized)) !== null) {
      const oldText = match[1].trim();
      const newText = match[2].trim();
      if (oldText && newText && oldText !== newText) {
        replacements.push({ oldText, newText });
      }
    }

    if (replacements.length > 0) {
      return replacements;
    }

    // Pattern 0b: unquoted rename phrases like "change author name from Oleksii Poliakov to alexbeatnik"
    const unquotedRenamePattern =
      /(?:change|replace|rename|update|змін\w*|замін\w*|оновл\w*)[^\n]{0,120}?(?:from|з)\s+([A-Za-zА-Яа-яІіЇїЄєҐґ0-9_. -]{2,80}?)\s+(?:to|на|with)\s+([A-Za-zА-Яа-яІіЇїЄєҐґ0-9_. -]{2,80}?)(?=(?:\s+(?:in|within|inside|у|в)\s+\S+)|[\s.,;!)]|$)/gi;
    while ((match = unquotedRenamePattern.exec(normalized)) !== null) {
      const oldText = match[1].trim().replace(/[.,;:]+$/g, '');
      const newText = match[2].trim().replace(/[.,;:]+$/g, '');
      if (oldText && newText && oldText !== newText) {
        replacements.push({ oldText, newText });
      }
    }

    if (replacements.length > 0) {
      return this.normalizeDescribedReplacements(replacements);
    }

    // Pattern 1: markdown code blocks with old → new separated by "На:" / "To:" / "→"
    const codeBlockPairPattern =
      /```[^\n]*\n([\s\S]*?)```\s*(?:\n\s*)?(?:На|на|To|to|→|->|replaced with|замінено на|changed to)[:\s]*\s*```[^\n]*\n([\s\S]*?)```/gi;
    while ((match = codeBlockPairPattern.exec(normalized)) !== null) {
      const oldText = match[1].trim();
      const newText = match[2].trim();
      if (oldText && newText && oldText !== newText) {
        replacements.push({ oldText, newText });
      }
    }

    if (replacements.length > 0) {
      return replacements;
    }

    // Pattern 2: inline quoted pairs — "old_value" на "new_value" / "old" has been replaced with "new"
    const inlinePattern =
      /["'`]([^"'`\n]+)["'`]\s*(?:has been\s+|was\s+|було\s+)?(?:→|->|на|to|replaced with|changed to|замінено на)[:\s]*\s*["'`]([^"'`\n]+)["'`]/gi;
    while ((match = inlinePattern.exec(normalized)) !== null) {
      const oldText = match[1].trim();
      const newText = match[2].trim();
      if (oldText && newText && oldText !== newText) {
        replacements.push({ oldText, newText });
      }
    }

    if (replacements.length > 0) {
      return replacements;
    }

    // Pattern 3: "з X на Y" pattern common in Ukrainian — з "old" на "new"
    const zNaPattern =
      /(?:з|from)\s+["'`]([^"'`\n]+)["'`]\s+(?:на|to)\s+["'`]([^"'`\n]+)["'`]/gi;
    while ((match = zNaPattern.exec(normalized)) !== null) {
      const oldText = match[1].trim();
      const newText = match[2].trim();
      if (oldText && newText && oldText !== newText) {
        replacements.push({ oldText, newText });
      }
    }

    if (replacements.length > 0) {
      return replacements;
    }

    // Pattern 4: "Заміна назви X на Y" / "Замінити X на Y"
    const zaminaPattern =
      /(?:замін\w*|replac\w*|updat\w*|оновл\w*)\s+(?:\w+\s+)?["'`]([^"'`\n]+)["'`]\s+(?:на|to|with)\s+["'`]([^"'`\n]+)["'`]/gi;
    while ((match = zaminaPattern.exec(normalized)) !== null) {
      const oldText = match[1].trim();
      const newText = match[2].trim();
      if (oldText && newText && oldText !== newText) {
        replacements.push({ oldText, newText });
      }
    }

    if (replacements.length > 0) {
      return replacements;
    }

    // Pattern 5: reversed order — replaced "old" with "new" / замінено "old" на "new"
    const reversedPattern =
      /(?:replaced|замінено|змінено|замінив|заміна|changed|updated|оновлено)\s+(?:the\s+)?(?:name\s+|value\s+|text\s+)?["'`]([^"'`\n]+)["'`]\s+(?:with|to|на|->|→)\s+["'`]([^"'`\n]+)["'`]/gi;
    while ((match = reversedPattern.exec(normalized)) !== null) {
      const oldText = match[1].trim();
      const newText = match[2].trim();
      if (oldText && newText && oldText !== newText) {
        replacements.push({ oldText, newText });
      }
    }

    return this.normalizeDescribedReplacements(replacements);
  }

  private normalizeDescribedReplacements(
    replacements: Array<{ oldText: string; newText: string }>
  ): Array<{ oldText: string; newText: string }> {
    const unique = new Map<string, { oldText: string; newText: string }>();
    for (const replacement of replacements) {
      const key = `${replacement.oldText}\u0000${replacement.newText}`;
      if (!unique.has(key)) {
        unique.set(key, replacement);
      }
    }

    const sorted = Array.from(unique.values()).sort((left, right) => right.oldText.length - left.oldText.length);
    return sorted.filter((replacement, index) => {
      return !sorted.slice(0, index).some(previous => {
        return previous.oldText.includes(replacement.oldText)
          && previous.newText.includes(replacement.newText);
      });
    });
  }

  private isLikelyFileReference(candidate: string): boolean {
    const trimmed = candidate.trim().replace(/^[`"']+|[`"'.,;:!?]+$/g, '');
    if (!trimmed) {
      return false;
    }

    const lower = trimmed.toLowerCase();
    const banned = new Set([
      'directly',
      'file',
      'content',
      'modified',
      'updated',
      'below',
      'above',
      'following',
      'steps',
      'here',
      'there'
    ]);
    if (banned.has(lower)) {
      return false;
    }

    if (/^[A-Z][A-Z0-9_-]*$/.test(trimmed)) {
      return true;
    }

    if (trimmed.includes('/')) {
      return true;
    }

    if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{1,12}$/.test(trimmed)) {
      return true;
    }

    const activeName = vscode.window.activeTextEditor ? path.basename(vscode.window.activeTextEditor.document.fileName) : '';
    if (activeName && trimmed === activeName) {
      return true;
    }

    return Array.from(this.attachedFiles.values()).some(file => trimmed === file.name || trimmed === path.basename(file.uri.fsPath));
  }

  private findAttachedFileForReplacements(replacements: Array<{ oldText: string }>): string | undefined {
    // Find which attached file contains the old_text strings
    for (const [fsPath, file] of this.attachedFiles) {
      const allFound = replacements.every(rep => file.content.includes(rep.oldText));
      if (allFound) {
        return fsPath;
      }
    }
    // Partial match: at least one replacement matches
    for (const [fsPath, file] of this.attachedFiles) {
      const anyFound = replacements.some(rep => file.content.includes(rep.oldText));
      if (anyFound) {
        return fsPath;
      }
    }
    return undefined;
  }

  private async findMentionedFileForReplacements(
    content: string,
    replacements: Array<{ oldText: string }>
  ): Promise<string | undefined> {
    // Try to find a file name mentioned in the response, then verify old_text exists there
    const normalized = content
      .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
      .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'");

    // Look for file name patterns: "файлі LICENSE", "file LICENSE.md", "in README.md" etc.
    const fileNamePattern = /(?:файл[іиеа]?|file|in)\s+["'`]?(\S+\.[\w]+)["'`]?/gi;
    const candidates: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = fileNamePattern.exec(normalized)) !== null) {
      if (this.isLikelyFileReference(match[1])) {
        candidates.push(match[1]);
      }
    }
    // Also try bare filenames like LICENSE, README etc.
    const bareNamePattern = /\b(LICENSE|README|CHANGELOG|Makefile|Dockerfile|package\.json|tsconfig\.json)\b/g;
    while ((match = bareNamePattern.exec(content)) !== null) {
      if (!candidates.includes(match[1])) {
        candidates.push(match[1]);
      }
    }

    for (const candidate of candidates) {
      try {
        const uri = this.resolveWorkspaceUri(candidate);
        const bytes = await vscode.workspace.fs.readFile(uri);
        const fileContent = Buffer.from(bytes).toString('utf8');
        const anyFound = replacements.some(rep => fileContent.includes(rep.oldText));
        if (anyFound) {
          return uri.fsPath;
        }
      } catch {
        // File not found — try next candidate
      }
    }
    return undefined;
  }

  private async findMentionedFileInContent(content: string): Promise<string | undefined> {
    const normalized = content
      .replace(/[`"']/g, ' ')
      .replace(/\s+/g, ' ');

    const candidates: string[] = [];
    const fileNamePattern = /(?:файл[іиеа]?|file|in)\s+([A-Za-z0-9_./-]+(?:\.[A-Za-z0-9_-]+)?)/gi;
    let match: RegExpExecArray | null;
    while ((match = fileNamePattern.exec(normalized)) !== null) {
      if (this.isLikelyFileReference(match[1])) {
        candidates.push(match[1]);
      }
    }

    const bareNamePattern = /\b(LICENSE|README|CHANGELOG|Makefile|Dockerfile|package\.json|tsconfig\.json)\b/g;
    while ((match = bareNamePattern.exec(content)) !== null) {
      if (!candidates.includes(match[1])) {
        candidates.push(match[1]);
      }
    }

    for (const candidate of candidates) {
      try {
        const uri = this.resolveWorkspaceUri(candidate);
        await vscode.workspace.fs.stat(uri);
        return uri.fsPath;
      } catch {
        // Ignore unresolved candidate.
      }
    }

    return undefined;
  }

  private async extractDescribedFileDump(content: string): Promise<{ fullMatch: string; filepath: string; fileContent: string } | undefined> {
    const fencedBlocks = Array.from(content.matchAll(/```(?:([\w.+-]+))?\n([\s\S]*?)```/g));
    if (fencedBlocks.length === 0) {
      return undefined;
    }

    const largestBlock = fencedBlocks.reduce((largest, current) => {
      const largestContent = (largest[2] ?? '').trim();
      const currentContent = (current[2] ?? '').trim();
      return currentContent.length > largestContent.length ? current : largest;
    });

    const blockLanguage = (largestBlock[1] ?? '').trim().toLowerCase();
    const fileContent = (largestBlock[2] ?? '').trim();
    if (fileContent.length < 200) {
      return undefined;
    }

    if (blockLanguage === 'diff' || blockLanguage === 'patch' || this.looksLikeDiffOutput(fileContent)) {
      return undefined;
    }

    const mentionedFile = await this.findMentionedFileInContent(content);
    if (mentionedFile) {
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(mentionedFile));
        const currentContent = Buffer.from(bytes).toString('utf8');
        const trustedContent = this.extractTrustedFullFileContent(content, currentContent);
        if (!trustedContent) {
          return undefined;
        }
        return {
          fullMatch: largestBlock[0],
          filepath: mentionedFile,
          fileContent: trustedContent
        };
      } catch {
        return undefined;
      }
    }

    const activeDoc = vscode.window.activeTextEditor?.document;
    if (activeDoc && !activeDoc.isUntitled) {
      const trustedContent = this.extractTrustedFullFileContent(content, activeDoc.getText());
      if (!trustedContent) {
        return undefined;
      }
      return {
        fullMatch: largestBlock[0],
        filepath: activeDoc.uri.fsPath,
        fileContent: trustedContent
      };
    }

    return undefined;
  }

  private async callOllama(messages: OllamaMessage[]): Promise<OllamaResponse> {
    const config = vscode.workspace.getConfiguration('manulai');
    const baseUrl = String(config.get('ollamaBaseUrl', 'http://localhost:11434')).replace(/\/$/, '');
    const model = this.getSelectedModel();
    const systemPrompt = String(config.get('systemPrompt', '')).trim();

    const requestMessages: OllamaMessage[] = [];

    if (this.agentMode) {
      const workspaceInstructions = await this.getWorkspaceInstructions();

        let agentMandate = 'You are ManulAI, a local VS Code coding agent.\n' +
          'Use the provided tools when you need to inspect files, edit files, or run commands.\n' +
          'If no tool is needed, answer normally and concisely.\n' +
          'Do not claim that a file was changed unless a tool actually changed it.\n' +
          'Avoid dumping full file contents unless the user explicitly asks for them.';

      if (workspaceInstructions) {
        agentMandate += '\n\n<workspace_instructions>\n' + workspaceInstructions + '\n</workspace_instructions>';
      }

      requestMessages.push({
        role: 'system',
        content: agentMandate,
        hiddenFromTranscript: true
      });
    } else {
      requestMessages.push({
        role: 'system',
        content:
          'You are ManulAI in chat-only mode. No tools are available.\n' +
          'You cannot read, modify, or create files.\n' +
          'Never claim you changed a file.\n' +
          'When the user asks for a change, show the EXACT old line(s) and the EXACT new line(s) they should replace.\n' +
          'Format:\n  Old: `<exact old text>`\n  New: `<exact new text>`\n' +
          'Keep it short. No full file dumps.',
        hiddenFromTranscript: true
      });
    }

    if (systemPrompt) {
      requestMessages.push({ role: 'system', content: systemPrompt, hiddenFromTranscript: true });
    }

    requestMessages.push(...messages.map(m => ({ ...m })));

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

    const abortController = new AbortController();
    this.currentRequestAbortController = abortController;

    // Abort after 120 seconds to prevent silent hangs
    const timeoutId = setTimeout(() => abortController.abort(), 120_000);

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: abortController.signal
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama HTTP ${response.status}: ${errorText}`);
    }

    return (await response.json()) as OllamaResponse;
  }

  private stopActiveRequest(): void {
    if (!this.requestInFlight) {
      this.postStatus('No active request to stop.');
      return;
    }

    this.stopRequested = true;
    this.currentRequestAbortController?.abort();
    if (this.pendingApprovalResolver) {
      this.resolvePendingApproval(false);
    }
    this.postStatus('Stopping request...');
  }

  private throwIfRequestStopped(): void {
    if (this.stopRequested) {
      throw new Error('REQUEST_ABORTED');
    }
  }

  private isAbortError(error: unknown): boolean {
    if (error instanceof Error) {
      return error.name === 'AbortError' || error.message === 'REQUEST_ABORTED';
    }

    return false;
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

    // Regex fallback: extract JSON from markdown code blocks, <tool_call> tags, or plain JSON objects.
    const knownToolNames = new Set(this.getToolDefinitions().map(t => t.function.name));
    const candidates: string[] = [];

    const codeBlockPattern = /```(?:json|tool_call|tool)?\s*\n?([\s\S]*?)```/g;
    const tagPattern = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
    // Catch-all for plain JSON objects that define a tool call (Llama / Qwen often hallucinate these directly into content)
    const jsonBlockPattern = /(\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{[\s\S]*?\}\s*\})/g;

    let match: RegExpExecArray | null;
    while ((match = codeBlockPattern.exec(trimmed)) !== null) {
      const inner = match[1].trim();
      if (inner.startsWith('{') || inner.startsWith('[')) candidates.push(inner);
    }
    while ((match = tagPattern.exec(trimmed)) !== null) {
      const inner = match[1].trim();
      if (inner.startsWith('{') || inner.startsWith('[')) candidates.push(inner);
    }
    while ((match = jsonBlockPattern.exec(trimmed)) !== null) {
      candidates.push(match[1].trim());
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
          description: 'Overwrites or creates a file with new content. Mandatory for any file modifications.',
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
            required: ['filepath', 'content']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'replace_in_file',
          description: 'Replace a specific text snippet inside an existing file. Use this for targeted edits instead of rewriting the whole file. Provide enough context lines so the old_text matches uniquely.',
          parameters: {
            type: 'object',
            properties: {
              filepath: {
                type: 'string',
                description: 'Absolute or workspace-relative path to the file.'
              },
              old_text: {
                type: 'string',
                description: 'The exact existing text to find (must match uniquely). Include a few surrounding lines for context.'
              },
              new_text: {
                type: 'string',
                description: 'The replacement text.'
              }
            },
            required: ['filepath', 'old_text', 'new_text'],
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

  private extractCodeBlockFileWrites(content: string): Array<{ fullMatch: string; filepath: string; fileContent: string }> {
    const blocks: Array<{ fullMatch: string; filepath: string; fileContent: string }> = [];
    // Match: ```lang:filepath or ```lang filepath
    // Also: ```lang\n// filepath  or ```lang\n# filepath
    const pattern = /```(\w+)[:\s]+([^\n`]+)\n([\s\S]*?)```/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const filepath = match[2].trim();
      const fileContent = match[3];
      if (filepath && fileContent && !filepath.includes(' ') && this.isLikelyFileReference(filepath)) {
        blocks.push({ fullMatch: match[0], filepath, fileContent });
      }
    }

    // Match: ```lang\n// filepath: path/to/file\n...
    const commentPathPattern = /```(\w+)\s*\n\s*(?:\/\/|#|--|\/\*)\s*(?:filepath|file|path):\s*([^\n]+)\n([\s\S]*?)```/gi;
    while ((match = commentPathPattern.exec(content)) !== null) {
      const filepath = match[2].trim();
      const fileContent = match[3];
      if (filepath && fileContent && this.isLikelyFileReference(filepath) && !blocks.some(b => b.filepath === filepath)) {
        blocks.push({ fullMatch: match[0], filepath, fileContent });
      }
    }

    // Match: mentioning a filename in the text directly preceding the code block.
    const precedingNamePattern = /(?:in|to|file|updated?|modified)\s+[`"']?([a-zA-Z0-9_\-\.\/]+)[`"']?[^`]{0,80}```(\w*)\n([\s\S]*?)```/gi;
    while ((match = precedingNamePattern.exec(content)) !== null) {
      const filepath = match[1].trim();
      const lang = (match[2] || '').toLowerCase();
      const fileContent = match[3];
      if (lang === 'diff') {
        continue;
      }
      if (this.isLikelyFileReference(filepath) && !filepath.includes(' ') && !blocks.some(b => b.filepath === filepath)) {
        const fullMatch = match[0].substring(match[0].indexOf('```'));
        blocks.push({ fullMatch, filepath, fileContent });
      }
    }

    return blocks;
  }

  private async extractUnifiedDiffWrite(content: string): Promise<{ fullMatch: string; filepath: string; fileContent: string } | undefined> {
    if (!this.looksLikeDiffOutput(content)) {
      return undefined;
    }

    const diffMatch = content.match(/(?:^|\n)((?:diff\s+--git[\s\S]*?)?---\s+[^\n]+\n\+\+\+\s+[^\n]+\n(?:@@[^\n]*\n[\s\S]*?)+)(?=\n[^ @+\-\\]|$)/m);
    const fullMatch = diffMatch?.[1]?.trim();
    if (!fullMatch) {
      return undefined;
    }

    const lines = fullMatch.split('\n');
    const plusHeader = lines.find(line => line.startsWith('+++ '));
    if (!plusHeader) {
      return undefined;
    }

    const rawPath = plusHeader.replace(/^\+\+\+\s+/, '').trim().replace(/^[ab]\//, '');
    const filepath = await this.resolveExistingWorkspacePath(rawPath);
    if (!filepath) {
      return undefined;
    }

    const originalContent = await this.readWorkspaceText(vscode.Uri.file(filepath));
    const originalLines = originalContent.split('\n');
    const updatedLines = [...originalLines];

    let lineIndex = 0;
    while (lineIndex < lines.length) {
      const line = lines[lineIndex];
      if (!line.startsWith('@@')) {
        lineIndex += 1;
        continue;
      }

      const headerMatch = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(line);
      if (!headerMatch) {
        return undefined;
      }

      const oldStart = Math.max(0, Number(headerMatch[1]) - 1);
      const oldChunk: string[] = [];
      const newChunk: string[] = [];
      lineIndex += 1;

      while (lineIndex < lines.length && !lines[lineIndex].startsWith('@@')) {
        const diffLine = lines[lineIndex];
        if (diffLine.startsWith(' ')) {
          const value = diffLine.slice(1);
          oldChunk.push(value);
          newChunk.push(value);
        } else if (diffLine.startsWith('-')) {
          oldChunk.push(diffLine.slice(1));
        } else if (diffLine.startsWith('+')) {
          newChunk.push(diffLine.slice(1));
        } else if (!diffLine.startsWith('\\')) {
          return undefined;
        }
        lineIndex += 1;
      }

      const expectedOld = oldChunk.join('\n');
      const replacementNew = newChunk.join('\n');
      const sliceLength = oldChunk.length;
      const actualOld = updatedLines.slice(oldStart, oldStart + sliceLength).join('\n');

      if (this.normalizeTextForComparison(actualOld) !== this.normalizeTextForComparison(expectedOld)) {
        return undefined;
      }

      updatedLines.splice(oldStart, sliceLength, ...newChunk);
    }

    const fileContent = updatedLines.join('\n');
    if (this.normalizeTextForComparison(fileContent) === this.normalizeTextForComparison(originalContent)) {
      return undefined;
    }

    return { fullMatch, filepath, fileContent };
  }

  private truncateLargeCodeBlocks(content: string): string {
    return content.replace(/```(\w*)\n([\s\S]*?)```/g, (_fullMatch, lang: string, code: string) => {
      const lines = code.split('\n');
      if (lines.length <= 15) {
        return _fullMatch;
      }
      const head = lines.slice(0, 6).join('\n');
      const tail = lines.slice(-4).join('\n');
      const omitted = lines.length - 10;
      return '```' + lang + '\n' + head + '\n// ... ' + String(omitted) + ' lines omitted ...\n' + tail + '\n```';
    });
  }

  private extractInlineFileBlocks(content: string): Array<{ fullMatch: string; filepath: string; fileContent: string }> {
    const blocks: Array<{ fullMatch: string; filepath: string; fileContent: string }> = [];
    const pattern = /(?:```[\w]*\s*\n?)?\[FILE:\s*([^\]]+)\]\s*\n?([\s\S]*?)(?:\s*\[\/FILE\]|\n?```|$)/gi;
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
      const summary = await this.writeFileWithDiff(block.filepath, block.fileContent);
      result = result.replace(block.fullMatch, summary.summary);
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
      case 'replace_in_file':
        return this.replaceInFile(String(args.filepath ?? ''), String(args.old_text ?? ''), String(args.new_text ?? ''));
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
      const content = await this.readWorkspaceText(uri);
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

    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) throw new Error("No workspace open");
      
      // Try to safely resolve the path
      let targetUri: vscode.Uri;
      if (path.isAbsolute(filename)) {
          targetUri = vscode.Uri.file(filename);
      } else {
          targetUri = vscode.Uri.joinPath(workspaceFolders[0].uri, filename);
      }
      
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(targetUri.fsPath)));

        await this.writeWorkspaceText(targetUri, content);

      return JSON.stringify({
        path: targetUri.fsPath,
        bytesWritten: Buffer.byteLength(content, 'utf8')
      });
    } catch (error) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : 'Failed to write file.'
      });
    }
  }

  private async writeFileWithDiff(filepath: string, newContent: string): Promise<FileWriteSummary> {
    const target = this.resolveWorkspaceUri(filepath);
    const displayName = path.basename(target.fsPath);
    const sanitizedContent = this.sanitizeGeneratedFileContent(newContent);

    // Read old content for diff (may not exist yet)
    let oldContent: string | undefined;
    try {
      oldContent = await this.readWorkspaceText(target);
    } catch {
      // File doesn't exist yet — new file
    }

    // Write the file
    const writeResult = await this.createOrEditFile(filepath, sanitizedContent);
    const parsed = JSON.parse(writeResult) as Record<string, unknown>;
    if (parsed.error) {
      return { summary: `Failed to write ${displayName}: ${String(parsed.error)}` };
    }

    // Compute diff
    if (oldContent === undefined) {
      // New file created
      const lineCount = sanitizedContent.split('\n').length;
      return { summary: `Created ${displayName} (${lineCount} lines)` };
    }

    if (oldContent === sanitizedContent) {
      return { summary: `${displayName}: no changes detected.` };
    }

    return {
      summary: this.buildDiffSummary(displayName, oldContent, sanitizedContent) ?? `${displayName}: no changes detected.`,
      revertOperationId: this.createRevertSnapshot(target.fsPath, oldContent, sanitizedContent)
    };
  }

  private createAssistantMessage(content: string, revertOperationIds: string[] = []): OllamaMessage {
    const uniqueOperationIds = Array.from(new Set(revertOperationIds.filter(operationId => this.revertSnapshots.has(operationId))));
    if (uniqueOperationIds.length === 0) {
      return { role: 'assistant', content };
    }

    return {
      role: 'assistant',
      content,
      revertOperationIds: uniqueOperationIds
    };
  }

  private createRevertSnapshot(filepath: string, previousContent: string, updatedContent: string): string | undefined {
    if (previousContent === updatedContent) {
      return undefined;
    }

    const target = this.resolveWorkspaceUri(filepath);
    const id = `revert:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
    this.revertSnapshots.set(id, {
      id,
      filepath: target.fsPath,
      displayName: path.basename(target.fsPath),
      previousContent,
      updatedContent,
      reverted: false
    });
    return id;
  }

  private async revertFileChanges(operationIds: string[] | undefined): Promise<void> {
    if (this.requestInFlight) {
      this.postStatus('Cannot revert changes while a request is running. Wait for the current response to finish.');
      return;
    }

    const uniqueOperationIds = Array.from(new Set((operationIds ?? []).filter(Boolean)));
    if (uniqueOperationIds.length === 0) {
      this.postStatus('No revertable changes were provided.');
      return;
    }

    const snapshots: RevertSnapshot[] = [];
    for (const operationId of uniqueOperationIds) {
      const snapshot = this.revertSnapshots.get(operationId);
      if (!snapshot || snapshot.reverted) {
        continue;
      }

      snapshots.push(snapshot);
    }

    if (snapshots.length === 0) {
      this.postStatus('These changes were already reverted or are no longer available.');
      this.postStateToWebview();
      return;
    }

    for (const snapshot of snapshots) {
      const currentContent = await this.readWorkspaceText(vscode.Uri.file(snapshot.filepath));
      if (this.normalizeTextForComparison(currentContent) !== this.normalizeTextForComparison(snapshot.updatedContent)) {
        this.postStatus(`Cannot revert ${snapshot.displayName}: the file changed after this diff was applied.`);
        return;
      }
    }

    const revertSummaries: string[] = [];
    for (const snapshot of [...snapshots].reverse()) {
      await this.writeWorkspaceText(vscode.Uri.file(snapshot.filepath), snapshot.previousContent);
      snapshot.reverted = true;
      const revertSummary = this.buildDiffSummary(snapshot.displayName, snapshot.updatedContent, snapshot.previousContent)
        ?? `${snapshot.displayName}: no changes detected.`;
      revertSummaries.push(`Reverted ${snapshot.displayName}:\n${revertSummary}`);
    }

    this.messages.push({ role: 'assistant', content: revertSummaries.join('\n\n') });
    this.postStateToWebview();
  }

  private buildDiffSummary(displayName: string, oldContent: string, newContent: string): string | undefined {
    const diffLines = this.computeLineDiff(oldContent, newContent);
    if (diffLines.length === 0) {
      return `Updated ${displayName} (whitespace-only changes)`;
    }

    const header = `Updated **${displayName}** — changed lines:`;
    const diffBlock = '```diff\n' + diffLines.join('\n') + '\n```';
    return header + '\n' + diffBlock;
  }

  private getOpenDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());
  }

  private async readWorkspaceText(uri: vscode.Uri): Promise<string> {
    const openDocument = this.getOpenDocument(uri);
    if (openDocument) {
      return openDocument.getText();
    }

    return this.readDiskText(uri);
  }

  private async readDiskText(uri: vscode.Uri): Promise<string> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString('utf8');
  }

  private normalizeTextForComparison(content: string): string {
    return content.replace(/\r\n/g, '\n');
  }

  private async writeWorkspaceText(uri: vscode.Uri, content: string): Promise<void> {
    const openDocument = this.getOpenDocument(uri);
    if (openDocument) {
      const fullRange = new vscode.Range(openDocument.positionAt(0), openDocument.positionAt(openDocument.getText().length));
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, fullRange, content);
      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) {
        throw new Error(`Failed to apply editor edit for ${uri.fsPath}.`);
      }

      const updatedDocument = this.getOpenDocument(uri) ?? await vscode.workspace.openTextDocument(uri);
      const saved = await updatedDocument.save();
      if (!saved) {
        throw new Error(`Failed to save ${uri.fsPath}.`);
      }

      const diskText = await this.readDiskText(uri);
      if (this.normalizeTextForComparison(diskText) !== this.normalizeTextForComparison(content)) {
        throw new Error(`Post-write verification failed for ${uri.fsPath}.`);
      }
      return;
    }

    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));

    const diskText = await this.readDiskText(uri);
    if (this.normalizeTextForComparison(diskText) !== this.normalizeTextForComparison(content)) {
      throw new Error(`Post-write verification failed for ${uri.fsPath}.`);
    }
  }

  private computeLineDiff(oldContent: string, newContent: string): string[] {
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');
    const diffResult: string[] = [];

    // Simple line-by-line diff with context
    const maxLen = Math.max(oldLines.length, newLines.length);
    let inChange = false;
    let contextBuffer: string[] = [];

    for (let i = 0; i < maxLen; i++) {
      const oldLine = i < oldLines.length ? oldLines[i] : undefined;
      const newLine = i < newLines.length ? newLines[i] : undefined;

      if (oldLine === newLine) {
        // Same line — buffer as potential context
        if (inChange) {
          // Show 1 line of trailing context after a change
          diffResult.push(`  ${oldLine ?? ''}`);
          inChange = false;
        }
        contextBuffer = [`  ${oldLine ?? ''}`];
        continue;
      }

      // Lines differ
      if (!inChange && contextBuffer.length > 0) {
        // Show 1 line of leading context before a change
        const lineNum = i;
        diffResult.push(`@@ line ${lineNum} @@`);
        diffResult.push(...contextBuffer);
      } else if (!inChange) {
        const lineNum = i + 1;
        diffResult.push(`@@ line ${lineNum} @@`);
      }
      inChange = true;
      contextBuffer = [];

      if (oldLine !== undefined && newLine !== undefined) {
        diffResult.push(`- ${oldLine}`);
        diffResult.push(`+ ${newLine}`);
      } else if (oldLine !== undefined) {
        diffResult.push(`- ${oldLine}`);
      } else if (newLine !== undefined) {
        diffResult.push(`+ ${newLine}`);
      }
    }

    // Cap output at 30 lines to keep chat reasonable
    if (diffResult.length > 30) {
      const omitted = diffResult.length - 20;
      return [...diffResult.slice(0, 15), `... (${omitted} more diff lines) ...`, ...diffResult.slice(-5)];
    }

    return diffResult;
  }

  private async replaceInFile(filepath: string, oldText: string, newText: string): Promise<string> {
    if (!filepath.trim()) {
      return JSON.stringify({ error: 'filepath is required.' });
    }
    if (!oldText) {
      return JSON.stringify({ error: 'old_text is required.' });
    }

    const target = this.resolveWorkspaceUri(filepath);

    try {
      const original = await this.readWorkspaceText(target);
      const occurrences = original.split(oldText).length - 1;

      if (occurrences === 0) {
        return JSON.stringify({ error: 'old_text not found in file. Make sure it matches exactly, including whitespace.' });
      }
      if (occurrences > 1) {
        return JSON.stringify({ error: `old_text matched ${occurrences} times. Add more surrounding context so it matches exactly once.` });
      }

      const updated = original.replace(oldText, newText);
      await this.writeWorkspaceText(target, updated);

      return JSON.stringify({
        path: target.fsPath,
        replacements: 1,
        bytesWritten: Buffer.byteLength(updated, 'utf8')
      });
    } catch (error) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : 'Failed to replace in file.'
      });
    }
  }

  private async replaceAllInFile(filepath: string, oldText: string, newText: string): Promise<string> {
    if (!filepath.trim()) {
      return JSON.stringify({ error: 'filepath is required.' });
    }
    if (!oldText) {
      return JSON.stringify({ error: 'old_text is required.' });
    }

    const target = this.resolveWorkspaceUri(filepath);

    try {
      const original = await this.readWorkspaceText(target);
      const occurrences = original.split(oldText).length - 1;

      if (occurrences === 0) {
        return JSON.stringify({ error: 'old_text not found in file. Make sure it matches exactly, including whitespace.' });
      }

      const updated = original.split(oldText).join(newText);
      await this.writeWorkspaceText(target, updated);

      return JSON.stringify({
        path: target.fsPath,
        replacements: occurrences,
        bytesWritten: Buffer.byteLength(updated, 'utf8')
      });
    } catch (error) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : 'Failed to replace text in file.'
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
      const uri = this.parseDroppedUri(rawPath);
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
      const uri = this.parseDroppedUri(rawUri);
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

    if (this.autoApprove && this.pendingApprovalResolver) {
      this.resolvePendingApproval(true);
    } else if (!this.autoApprove && this.pendingApproval) {
      this.pendingApproval = undefined;
      this.pendingApprovalResolver = undefined;
    }

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

  private synchronizeActiveEditorContextMessage(): void {
    this.removeActiveEditorContextMessages();

    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
      return;
    }

    const { document } = activeEditor;
    const uri = document.uri;
    const isRealFile = uri.scheme === 'file';
    const isUntitled = uri.scheme === 'untitled';

    if (!isRealFile && !isUntitled) {
      return;
    }

    if (isRealFile && this.attachedFiles.has(uri.fsPath)) {
      return;
    }

    const filePath = isRealFile
      ? uri.fsPath
      : (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
        ? path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, path.basename(document.fileName || 'untitled'))
        : (document.fileName || 'untitled'));

    const fileName = path.basename(document.fileName || filePath || 'untitled');
    const content = document.getText();

    if (!content.trim()) {
      return;
    }

    this.messages.push({
      role: 'user',
      content: [
        'The user currently has the following file open in the active editor. Use it as current working context.',
        'This content reflects the current editor state and may include unsaved changes.',
        '',
        `<manulai_active_editor_context file="${fileName}" path="${filePath}">`,
        content,
        '</manulai_active_editor_context>'
      ].join('\n'),
      hiddenFromTranscript: true,
      activeEditorContext: true
    });
  }

  private removeAttachmentContextMessages(): void {
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      if (this.messages[index].attachmentContext) {
        this.messages.splice(index, 1);
      }
    }
  }

  private removeActiveEditorContextMessages(): void {
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      if (this.messages[index].activeEditorContext) {
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
          `<manulai_attached_file file="${file.name}" path="${filePath}">`,
          file.content,
          '</manulai_attached_file>'
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

  private parseDroppedUri(rawPath: string): vscode.Uri {
    const value = this.normalizeDroppedPath(rawPath);
    return /^[a-z][a-z0-9+.-]*:/i.test(value)
      ? vscode.Uri.parse(value)
      : this.resolveWorkspaceUri(value);
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

  private async resolveExistingWorkspacePath(targetPath: string): Promise<string | undefined> {
    const normalizedTarget = targetPath.trim().replace(/^\.?\//, '').replace(/^[ab]\//, '');
    if (!normalizedTarget) {
      return undefined;
    }

    try {
      const exactUri = this.resolveWorkspaceUri(normalizedTarget);
      await vscode.workspace.fs.stat(exactUri);
      return exactUri.fsPath;
    } catch {
      // Fall through to fuzzy lookup.
    }

    const targetBase = path.basename(normalizedTarget).toLowerCase();
    const workspaceFiles = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 500);

    let bestMatch: { fsPath: string; score: number } | undefined;
    for (const fileUri of workspaceFiles) {
      const candidateBase = path.basename(fileUri.fsPath).toLowerCase();
      const candidateRelative = vscode.workspace.asRelativePath(fileUri, false).replace(/\\/g, '/').toLowerCase();

      if (candidateRelative === normalizedTarget.toLowerCase() || candidateRelative.endsWith('/' + normalizedTarget.toLowerCase())) {
        return fileUri.fsPath;
      }

      const score = this.computeEditDistance(targetBase, candidateBase);
      if (bestMatch === undefined || score < bestMatch.score) {
        bestMatch = { fsPath: fileUri.fsPath, score };
      }
    }

    return bestMatch && bestMatch.score <= 2 ? bestMatch.fsPath : undefined;
  }

  private computeEditDistance(left: string, right: string): number {
    const rows = left.length + 1;
    const cols = right.length + 1;
    const matrix = Array.from({ length: rows }, () => Array<number>(cols).fill(0));

    for (let row = 0; row < rows; row += 1) {
      matrix[row][0] = row;
    }
    for (let col = 0; col < cols; col += 1) {
      matrix[0][col] = col;
    }

    for (let row = 1; row < rows; row += 1) {
      for (let col = 1; col < cols; col += 1) {
        const cost = left[row - 1] === right[col - 1] ? 0 : 1;
        matrix[row][col] = Math.min(
          matrix[row - 1][col] + 1,
          matrix[row][col - 1] + 1,
          matrix[row - 1][col - 1] + cost
        );
      }
    }

    return matrix[rows - 1][cols - 1];
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

  private getActiveFileState(): WebviewActiveFileState | undefined {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
      return undefined;
    }

    const { document } = activeEditor;
    const uri = document.uri;
    const isRealFile = uri.scheme === 'file';
    const isUntitled = uri.scheme === 'untitled';

    if (!isRealFile && !isUntitled) {
      return undefined;
    }

    if (isRealFile && this.attachedFiles.has(uri.fsPath)) {
      return undefined;
    }

    const displayPath = isRealFile
      ? this.getDisplayPath({
          uri,
          name: path.basename(uri.fsPath),
          content: '',
          languageId: document.languageId
        })
      : (document.fileName || 'untitled');

    return {
      path: isRealFile ? uri.fsPath : (document.fileName || 'untitled'),
      name: path.basename(document.fileName || displayPath || 'untitled'),
      displayPath
    };
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

      const availableRevertOperations = (message.revertOperationIds ?? [])
        .map(operationId => this.revertSnapshots.get(operationId))
        .filter((snapshot): snapshot is RevertSnapshot => Boolean(snapshot && !snapshot.reverted));

      result.push({
        role: message.role,
        content: message.content,
        revertAction: availableRevertOperations.length > 0
          ? {
              operationIds: availableRevertOperations.map(snapshot => snapshot.id),
              label: availableRevertOperations.length > 1 ? `Revert ${availableRevertOperations.length} changes` : 'Revert changes',
              details: Array.from(new Set(availableRevertOperations.map(snapshot => snapshot.displayName))).join(', ')
            }
          : undefined
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
      pendingApproval: this.pendingApproval,
      activeFile: this.getActiveFileState(),
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
