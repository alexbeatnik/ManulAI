import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { AgentModeValue, AttachedFileContext, ChatRole, ChatSession, DEFAULT_STORED_SETTINGS, ManulAiStoredSettings, OllamaMessage, OllamaResponse, ParsedToolCall, PersistedChatState, ToolDefinition, ToolFunctionCall, WebviewActiveFileState, WebviewChatSummary, WebviewInboundMessage, WebviewPendingApprovalState, WebviewRenderableMessage } from './types';
import { deserializeAttachedFileContext as deserializePersistedAttachedFileContext, deserializeChatMessage as deserializePersistedChatMessage, deserializeChatSession as deserializePersistedChatSession, getChatStorageDirUri as getPersistedChatStorageDirUri, getChatStorageUri as getPersistedChatStorageUri, getWorkspaceSettingsDirUri as getPersistedWorkspaceSettingsDirUri, getWorkspaceSettingsUri as getPersistedWorkspaceSettingsUri, normalizePersistedChatSession as normalizeRestoredChatSession, normalizeStoredSettings as normalizePersistedSettings, restorePersistedChats as restorePersistedChatState, serializeChatState as serializePersistedChatState } from './providerPersistenceUtils';
import { extractCodeBlockFileWrites as extractCodeBlockFileWritesHelper, extractDescribedFileDump as extractDescribedFileDumpHelper, extractDescribedReplacements as extractDescribedReplacementsHelper, extractInlineFileBlocks as extractInlineFileBlocksHelper, extractMarkerFileWrite as extractMarkerFileWriteHelper, extractNewFileCreation as extractNewFileCreationHelper, extractTrustedFullFileContent as extractTrustedFullFileContentHelper, extractUnifiedDiffWrite as extractUnifiedDiffWriteHelper, findAttachedFileForReplacements as findAttachedFileForReplacementsHelper, findMentionedFileForReplacements as findMentionedFileForReplacementsHelper, findMentionedFileInContent as findMentionedFileInContentHelper, isLikelyFileReference as isLikelyFileReferenceHelper, looksLikeChangeSummary as looksLikeChangeSummaryHelper, looksLikeDiffOutput as looksLikeDiffOutputHelper, matchResponseToActiveFile as matchResponseToActiveFileHelper, matchResponseToAttachedFile as matchResponseToAttachedFileHelper, sanitizeGeneratedFileContent as sanitizeGeneratedFileContentHelper, stripDiffPrefixes as stripDiffPrefixesHelper, truncateLargeCodeBlocks as truncateLargeCodeBlocksHelper } from './providerFileFallbackUtils';
import { extractSymbolNamesFromGeneratedContent, inferRepeatedNarratedBootstrapToolCall, validateGeneratedModuleContent } from './providerRefactorUtils';
import { buildBuildVerifyFailureNudge, buildPreviewSnippet, detectInvalidStructuredCreateContent, inferBuildVerifyStack, isPlaceholderCreateResult, isPlaceholderReplacementText, isTerminalReadOnlyInspectionCommand, toolResultMatchesAnyTargetPath } from './providerSafetyUtils';
import { containsLeakedToolCallPayload as containsLeakedToolCallPayloadHelper, escapeJsonStringValues as escapeJsonStringValuesHelper, extractBalancedJson as extractBalancedJsonHelper, extractToolCallNameHint as extractToolCallNameHintHelper, extractToolCalls as extractToolCallsHelper, looksLikeMalformedToolCallContent as looksLikeMalformedToolCallContentHelper, looksLikeToolCallContent as looksLikeToolCallContentHelper, normalizeToolArguments as normalizeToolArgumentsHelper, parseToolCallsFromContent as parseToolCallsFromContentHelper, remapWeakModelArgumentAliases as remapWeakModelArgumentAliasesHelper, remapWeakModelToolName as remapWeakModelToolNameHelper, repairSingleQuotedJson as repairSingleQuotedJsonHelper, stripToolCallsFromContent as stripToolCallsFromContentHelper } from './providerToolParsingUtils';
import { formatToolMessageForTranscript as formatTranscriptToolMessage, getActiveFileState as getWebviewActiveFileState, getDisplayPath as getWebviewDisplayPath, renderAttachmentContextMessage as renderWebviewAttachmentContextMessage } from './providerWebviewUtils';

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

type ModelCapabilityTier = 'micro' | 'small' | 'medium' | 'large' | 'xlarge';

interface ModelCapabilityProfile {
  tier: ModelCapabilityTier;
  maxMessages: number;
  numCtx: number;
  workspaceTreeMaxDepth: number;
  workspaceTreeFileCap: number;
  summaryContextLimit: number;
  includeWorkspaceInstructions: boolean;
  includeWorkspaceNotes: boolean;
  includeRecentChatSummaries: boolean;
  useCompactMandate: boolean;
  preferStepwiseExecution: boolean;
  maxNudgeRetriesCap: number;
  maxReadOpsWithoutWrite: number;
  toolNames: string[];
}

export class ManulAiChatProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'manulai.chatView';

  private webviewView?: vscode.WebviewView;
  private readonly chats: ChatSession[] = [];
  private activeChatId = '';
  private chatCounter = 0;
  private availableModels: string[] = [];
  private ollamaReachable = false;
  private agentMode: AgentModeValue = 'agent';

  /** True when tools are available (agent or planner mode). */
  private get isAgentLike(): boolean {
    return this.agentMode !== 'chat';
  }

  private autoApprove = false;
  private debugMode = false;
  private requestInFlight = false;
  private stopRequested = false;
  private currentRequestAbortController?: AbortController;
  private pendingApproval?: WebviewPendingApprovalState;
  private pendingApprovalResolver?: (approved: boolean) => void;
  private readonly revertSnapshots = new Map<string, RevertSnapshot>();
  private workspaceSnapshotCache: string | null = null;
  private debugLogFilePath?: string;
  private debugSessionId = '';
  private progressStepCounter = 0;
  private totalReadOps = 0;
  private currentRequestRequiresWrite = true;
  private failedCommandCounts = new Map<string, number>();
  private lastNudgedResponseContent = '';
  private consecutiveIdenticalResponses = 0;
  private repeatedNarratedToolSignature: string | null = null;
  private repeatedNarratedToolCount = 0;
  private workspaceSettings: Partial<ManulAiStoredSettings> = {};
  private workspaceSettingsLoaded = false;
  private workspaceSettingsLoadPromise?: Promise<void>;
  private migratingWorkspaceConfiguration = false;
  private chatStorageLoaded = false;
  private chatStorageLoadPromise?: Promise<void>;
  private persistChatsTimeout?: NodeJS.Timeout;
  private lastPersistedChatState = '';

  public constructor(private readonly extensionContext: vscode.ExtensionContext) {
    this.createChatSession();

    if (vscode.workspace.workspaceFolders?.length) {
      this.agentMode = DEFAULT_STORED_SETTINGS.agentMode;
      this.autoApprove = DEFAULT_STORED_SETTINGS.autoApprove;
      this.debugMode = DEFAULT_STORED_SETTINGS.debugMode;
    } else {
      const config = vscode.workspace.getConfiguration('manulai');
      const rawAgentMode = config.get('agentMode', DEFAULT_STORED_SETTINGS.agentMode);
      this.agentMode = (typeof rawAgentMode === 'boolean') ? (rawAgentMode ? 'agent' : 'chat') : (rawAgentMode as AgentModeValue) || 'agent';
      this.autoApprove = Boolean(config.get('autoApprove', DEFAULT_STORED_SETTINGS.autoApprove));
      this.debugMode = Boolean(config.get('debugMode', DEFAULT_STORED_SETTINGS.debugMode));
    }
  }

  private get activeChat(): ChatSession {
    const existingChat = this.chats.find(chat => chat.id === this.activeChatId);
    if (existingChat) {
      return existingChat;
    }

    return this.createChatSession();
  }

  private get messages(): OllamaMessage[] {
    return this.activeChat.messages;
  }

  private get attachedFiles(): Map<string, AttachedFileContext> {
    return this.activeChat.attachedFiles;
  }

  private createChatSession(title?: string): ChatSession {
    const chatNumber = ++this.chatCounter;
    const chat: ChatSession = {
      id: `chat-${Date.now()}-${chatNumber}`,
      title: title?.trim() || 'Chat',
      messages: [],
      attachedFiles: new Map<string, AttachedFileContext>(),
      summaryMemory: []
    };

    this.chats.push(chat);
    this.activeChatId = chat.id;
    return chat;
  }

  private getChatSummary(chat: ChatSession): WebviewChatSummary {
    return {
      id: chat.id,
      title: chat.title,
      messageCount: chat.messages.filter(message => !message.hiddenFromTranscript && message.role !== 'system').length,
      attachmentCount: chat.attachedFiles.size
    };
  }

  private maybeUpdateActiveChatTitleFromPrompt(text: string): void {
    const chat = this.activeChat;
    const visibleMessageCount = chat.messages.filter(message => !message.hiddenFromTranscript && message.role !== 'system').length;
    if (visibleMessageCount > 0) {
      return;
    }

    const normalized = text.trim().replace(/\s+/g, ' ');
    if (!normalized) {
      return;
    }

    chat.title = normalized.length > 40 ? `${normalized.slice(0, 37)}...` : normalized;
  }

  private createNewChat(): void {
    if (this.requestInFlight) {
      this.postStatus('Cannot create a new chat while a request is running. Wait for the current response to finish.');
      return;
    }

    const chat = this.createChatSession();
    this.progressStepCounter = 0;
    this.debugLog('chat_created', { chatId: chat.id, title: chat.title, chatCount: this.chats.length });
    this.postStateToWebview();
    this.postStatus(`Created ${chat.title}.`);
  }

  private switchChat(chatId: string | undefined): void {
    const normalizedChatId = String(chatId ?? '').trim();
    if (!normalizedChatId || normalizedChatId === this.activeChatId) {
      return;
    }

    if (this.requestInFlight) {
      this.postStatus('Cannot switch chats while a request is running. Wait for the current response to finish.');
      return;
    }

    const targetChat = this.chats.find(chat => chat.id === normalizedChatId);
    if (!targetChat) {
      return;
    }

    this.activeChatId = targetChat.id;
    this.progressStepCounter = 0;
    this.debugLog('chat_switched', { chatId: targetChat.id, title: targetChat.title });
    this.postStateToWebview();
    this.postStatus(`Switched to ${targetChat.title}.`);
  }

  private deleteActiveChat(): void {
    if (this.requestInFlight) {
      this.postStatus('Cannot delete a chat while a request is running. Wait for the current response to finish.');
      return;
    }

    const currentIndex = this.chats.findIndex(chat => chat.id === this.activeChatId);
    if (currentIndex < 0) {
      return;
    }

    const deletedChat = this.chats[currentIndex];
    this.chats.splice(currentIndex, 1);

    // Delete per-chat notes file
    const notesUri = this.getChatNotesUri(deletedChat.id);
    if (notesUri) {
      void vscode.workspace.fs.delete(notesUri).then(
        undefined,
        (err) => {
          if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
            return;
          }
          this.debugLog('chat_notes_delete_failed', {
            chatId: deletedChat.id,
            error: err instanceof Error ? err.message : String(err),
          });
        },
      );
    }

    if (this.chats.length === 0) {
      this.createChatSession();
    } else {
      const nextIndex = Math.max(0, currentIndex - 1);
      this.activeChatId = this.chats[Math.min(nextIndex, this.chats.length - 1)].id;
    }

    this.progressStepCounter = 0;
    this.debugLog('chat_deleted', { chatId: deletedChat.id, title: deletedChat.title, remainingChatCount: this.chats.length });
    this.postStateToWebview();
    this.postStatus(`Deleted ${deletedChat.title}.`);
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

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.postStateToWebview();
      }
    });

    void this.initializeSettingsState();

    // Push initial state once the webview is ready
    setTimeout(() => {
      void this.initializeSettingsState();
    }, 100);
  }

  public reveal(preserveFocus = false): void {
    this.webviewView?.show(preserveFocus);
  }

  public async refreshModelCatalog(postStatusOnError = false): Promise<void> {
    const currentModel = this.getSelectedModel();

    try {
      const baseUrl = this.getOllamaBaseUrl();
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
      this.ollamaReachable = true;

      // Auto-select the only available model when none is currently chosen
      if (!currentModel && names.length === 1) {
        await this.setSelectedModel(names[0]);
      }
    } catch (error) {
      this.availableModels = Array.from(new Set([currentModel, ...this.availableModels].filter(Boolean)));
      this.ollamaReachable = false;

      if (postStatusOnError) {
        const message = error instanceof Error ? error.message : 'Failed to load Ollama models.';
        this.postStatus(`Unable to refresh Ollama models: ${message}`);
      }
    }
  }

  public getSelectedModel(): string {
    return this.getStringSetting('ollamaModel', DEFAULT_STORED_SETTINGS.ollamaModel).trim();
  }

  public async setSelectedModel(model: string): Promise<void> {
    const previousModel = this.getSelectedModel();
    const normalizedModel = model.trim();
    if (!normalizedModel) {
      return;
    }

    await this.persistStoredSetting('ollamaModel', normalizedModel);
    this.workspaceSnapshotCache = null;
    await this.refreshModelCatalog(false);
    if (previousModel !== normalizedModel) {
      this.debugLog('model_changed', { previousModel: previousModel || null, model: normalizedModel });
    }
    this.postStateToWebview();
    this.postStatus(`Ollama model set to ${normalizedModel}.`);
  }

  public getAvailableModels(): string[] {
    return [...this.availableModels];
  }

  public async handleConfigurationChange(): Promise<void> {
    await this.initializeSettingsState();
  }

  private async initializeSettingsState(): Promise<void> {
    await this.migrateWorkspaceConfigurationToStorage();
    await this.ensureWorkspaceSettingsLoaded();
    await this.ensureChatStorageLoaded();

    const previousDebugMode = this.debugMode;
    const rawAgentMode = this.workspaceSettings.agentMode;
    this.agentMode = rawAgentMode && ['chat', 'agent', 'planner'].includes(rawAgentMode) ? rawAgentMode : DEFAULT_STORED_SETTINGS.agentMode;
    this.autoApprove = this.getBooleanSetting('autoApprove', DEFAULT_STORED_SETTINGS.autoApprove);
    this.debugMode = this.getBooleanSetting('debugMode', DEFAULT_STORED_SETTINGS.debugMode);

    if (this.debugMode && (!previousDebugMode || !this.debugLogFilePath)) {
      this.startDebugSession();
    } else if (!this.debugMode && previousDebugMode) {
      this.stopDebugSession();
    }

    await this.refreshModelCatalog(false);
    this.postStateToWebview();
  }

  private getWorkspaceSettingsDirUri(): vscode.Uri | undefined {
    return getPersistedWorkspaceSettingsDirUri(vscode.workspace.workspaceFolders?.[0]?.uri);
  }

  private getWorkspaceSettingsUri(): vscode.Uri | undefined {
    return getPersistedWorkspaceSettingsUri(vscode.workspace.workspaceFolders?.[0]?.uri);
  }

  private async ensureWorkspaceSettingsLoaded(): Promise<void> {
    if (this.workspaceSettingsLoaded) {
      return;
    }
    if (this.workspaceSettingsLoadPromise) {
      await this.workspaceSettingsLoadPromise;
      return;
    }

    this.workspaceSettingsLoadPromise = (async () => {
      const settingsUri = this.getWorkspaceSettingsUri();
      if (!settingsUri) {
        this.workspaceSettings = {};
        this.workspaceSettingsLoaded = true;
        return;
      }

      try {
        const bytes = await vscode.workspace.fs.readFile(settingsUri);
        const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
        this.workspaceSettings = normalizePersistedSettings(parsed);
      } catch {
        this.workspaceSettings = {};
      }
      this.workspaceSettingsLoaded = true;
    })();

    try {
      await this.workspaceSettingsLoadPromise;
    } finally {
      this.workspaceSettingsLoadPromise = undefined;
    }
  }

  private getChatStorageDirUri(): vscode.Uri {
    return getPersistedChatStorageDirUri(vscode.workspace.workspaceFolders?.[0]?.uri, this.extensionContext.globalStorageUri);
  }

  private getChatStorageUri(): vscode.Uri {
    return getPersistedChatStorageUri(vscode.workspace.workspaceFolders?.[0]?.uri, this.extensionContext.globalStorageUri);
  }

  private async ensureChatStorageLoaded(): Promise<void> {
    if (this.chatStorageLoaded) {
      return;
    }
    if (this.chatStorageLoadPromise) {
      await this.chatStorageLoadPromise;
      return;
    }

    this.chatStorageLoadPromise = (async () => {
      const storageUri = this.getChatStorageUri();

      try {
        const bytes = await vscode.workspace.fs.readFile(storageUri);
        const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
        this.restorePersistedChats(parsed);
      } catch {
        this.chatStorageLoaded = true;
      }
    })();

    try {
      await this.chatStorageLoadPromise;
    } finally {
      this.chatStorageLoadPromise = undefined;
    }
  }

  private restorePersistedChats(value: unknown): void {
    const restored = restorePersistedChatState(value, {
      deserializeChatSession: candidate => this.deserializeChatSession(candidate),
      normalizePersistedChatSession: chat => this.normalizePersistedChatSession(chat)
    });
    if (restored) {
      this.chats.length = 0;
      this.chats.push(...restored.chats);
      this.activeChatId = restored.activeChatId;
      this.chatCounter = restored.chatCounter;
      this.lastPersistedChatState = restored.lastPersistedChatState;
    }
    this.chatStorageLoaded = true;
  }

  private deserializeChatSession(value: unknown): ChatSession | undefined {
    return deserializePersistedChatSession(value, vscode);
  }

  private deserializeChatMessage(value: unknown): OllamaMessage | undefined {
    return deserializePersistedChatMessage(value);
  }

  private deserializeAttachedFileContext(value: unknown): AttachedFileContext | undefined {
    return deserializePersistedAttachedFileContext(value, vscode);
  }

  private normalizePersistedChatSession(chat: ChatSession): void {
    normalizeRestoredChatSession(chat, {
      removeAttachmentContextMessages: messages => this.removeAttachmentContextMessages(messages),
      removeActiveEditorContextMessages: messages => this.removeActiveEditorContextMessages(messages),
      renderAttachmentContextMessage: attachedFiles => renderWebviewAttachmentContextMessage(attachedFiles, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath)
    });
  }

  private serializeChatState(): PersistedChatState {
    return serializePersistedChatState(this.activeChatId, this.chatCounter, this.chats);
  }

  private schedulePersistedChats(): void {
    clearTimeout(this.persistChatsTimeout);
    this.persistChatsTimeout = setTimeout(() => {
      void this.persistChatState();
    }, 200);
  }

  private async persistChatState(): Promise<void> {
    const storageUri = this.getChatStorageUri();
    const storageDir = this.getChatStorageDirUri();
    const serialized = JSON.stringify(this.serializeChatState(), null, 2) + '\n';

    if (serialized === this.lastPersistedChatState) {
      return;
    }

    try {
      await vscode.workspace.fs.createDirectory(storageDir);
      await vscode.workspace.fs.writeFile(storageUri, Buffer.from(serialized, 'utf8'));
      this.lastPersistedChatState = serialized;
    } catch {
      // Silently fail if chat state cannot be persisted.
    }
  }

  private normalizeStoredSettings(value: unknown): Partial<ManulAiStoredSettings> {
    return normalizePersistedSettings(value);
  }

  private getStringSetting(key: keyof ManulAiStoredSettings, fallback: string): string {
    const storedValue = this.workspaceSettings[key];
    if (typeof storedValue === 'string') {
      return storedValue;
    }
    if (vscode.workspace.workspaceFolders?.length) {
      return String(DEFAULT_STORED_SETTINGS[key] ?? fallback);
    }
    const config = vscode.workspace.getConfiguration('manulai');
    return String(config.get(String(key), fallback));
  }

  private getBooleanSetting(key: keyof ManulAiStoredSettings, fallback: boolean): boolean {
    const storedValue = this.workspaceSettings[key];
    if (typeof storedValue === 'boolean') {
      return storedValue;
    }
    if (vscode.workspace.workspaceFolders?.length) {
      return Boolean(DEFAULT_STORED_SETTINGS[key] ?? fallback);
    }
    const config = vscode.workspace.getConfiguration('manulai');
    return Boolean(config.get(String(key), fallback));
  }

  private getOllamaBaseUrl(): string {
    return this.getStringSetting('ollamaBaseUrl', DEFAULT_STORED_SETTINGS.ollamaBaseUrl).replace(/\/$/, '');
  }

  private getSystemPrompt(): string {
    return this.getStringSetting('systemPrompt', DEFAULT_STORED_SETTINGS.systemPrompt).trim();
  }

  private async persistStoredSetting<K extends keyof ManulAiStoredSettings>(key: K, value: NonNullable<ManulAiStoredSettings[K]>): Promise<void> {
    const settingsUri = this.getWorkspaceSettingsUri();
    if (!settingsUri) {
      await vscode.workspace.getConfiguration('manulai').update(String(key), value, vscode.ConfigurationTarget.Global);
      return;
    }

    await this.ensureWorkspaceSettingsLoaded();
    this.workspaceSettings = {
      ...this.workspaceSettings,
      [key]: value
    };

    const settingsDir = this.getWorkspaceSettingsDirUri();
    if (!settingsDir) {
      return;
    }
    await vscode.workspace.fs.createDirectory(settingsDir);
    await vscode.workspace.fs.writeFile(settingsUri, Buffer.from(JSON.stringify(this.workspaceSettings, null, 2) + '\n', 'utf8'));
  }

  private async migrateWorkspaceConfigurationToStorage(): Promise<void> {
    if (this.migratingWorkspaceConfiguration || !vscode.workspace.workspaceFolders?.length) {
      return;
    }

    const config = vscode.workspace.getConfiguration('manulai');
    const keys: Array<keyof ManulAiStoredSettings> = ['ollamaModel', 'ollamaBaseUrl', 'agentMode', 'autoApprove', 'debugMode', 'systemPrompt'];
    let migratedAny = false;

    this.migratingWorkspaceConfiguration = true;
    try {
      for (const key of keys) {
        const inspected = config.inspect<unknown>(String(key));
        if (!inspected || inspected.workspaceValue === undefined) {
          continue;
        }
        await this.persistStoredSetting(key, inspected.workspaceValue as NonNullable<ManulAiStoredSettings[typeof key]>);
        await config.update(String(key), undefined, vscode.ConfigurationTarget.Workspace);
        migratedAny = true;
      }
    } finally {
      this.migratingWorkspaceConfiguration = false;
    }

    if (migratedAny) {
      this.postStatus('Moved ManulAI workspace settings from .vscode/settings.json to .manulai/settings.json.');
    }
  }

  public handleActiveEditorChange(): void {
    this.postStateToWebview();
  }

  public async attachFilesByUri(uris: vscode.Uri[]): Promise<void> {
    for (const uri of uris) {
      await this.addFileContext(uri.toString());
    }
  }

  public async attachFolderByUri(uri: vscode.Uri): Promise<void> {
    await this.addFolderContext(uri);
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
        await this.initializeSettingsState();
        return;
      case 'clearChat':
        this.clearChat();
        return;
      case 'createChat':
        this.createNewChat();
        return;
      case 'deleteChat':
        this.deleteActiveChat();
        return;
      case 'switchChat':
        this.switchChat(message.chatId);
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
      case 'browseFolder':
        await this.browseAndAttachFolder();
        return;
      case 'attachProject':
        await this.attachWorkspaceAsContext();
        return;
      case 'toggleAgentMode': {
        // Backward compat: boolean from old webview
        const v = message.value;
        if (typeof v === 'boolean') {
          await this.setAgentMode(v ? 'agent' : 'chat');
        } else if (typeof v === 'string') {
          await this.setAgentMode(v as AgentModeValue);
        }
        return;
      }
      case 'setAgentMode':
        if (typeof message.value === 'string' && ['chat', 'agent', 'planner'].includes(message.value)) {
          await this.setAgentMode(message.value as AgentModeValue);
        }
        return;
      case 'toggleAutoApprove':
        await this.setAutoApprove(typeof message.value === 'boolean' ? message.value : undefined);
        return;
      case 'toggleDebugMode':
        await this.setDebugMode(typeof message.value === 'boolean' ? message.value : undefined);
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

    this.synchronizeActiveEditorContextMessage(text);

    if (this.isAgentLike && this.looksLikeProjectScanRequest(text)) {
      await this.attachWorkspaceAsContext();
      this.messages.push({
        role: 'user',
        content: 'This is a full project scan request. Do NOT stop after reading only the root directory or after fixing one issue. Continue reading relevant files across the project, use tools repeatedly, and either fix all concrete issues you can find or explicitly state that no further actionable issues were found after scanning.',
        hiddenFromTranscript: true
      });
    }

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

    this.progressStepCounter = 0;
    this.maybeUpdateActiveChatTitleFromPrompt(text);
    this.debugLog('user_request', {
      text,
      chatId: this.activeChat.id,
      chatTitle: this.activeChat.title,
      agentMode: this.agentMode,
      autoApprove: this.autoApprove,
      attachedContextCount: this.attachedFiles.size,
      frontendAttachmentCount: frontendAttachments?.length ?? 0,
      activeEditorPath: vscode.window.activeTextEditor?.document.isUntitled
        ? undefined
        : vscode.window.activeTextEditor?.document.uri.fsPath
    });
    this.messages.push({ role: 'user', content: text });

    // If the user re-sent the exact same prompt (e.g. after switching models),
    // trim the stale assistant/tool messages from the previous failed exchange
    // so the new model starts from a clean slate.
    {
      const visibleUserMessages = this.messages
        .map((m, i) => ({ m, i }))
        .filter(({ m }) => m.role === 'user' && !m.hiddenFromTranscript && typeof m.content === 'string');
      const thisIdx = visibleUserMessages.length - 1;
      const prevIdx = thisIdx - 1;
      if (prevIdx >= 0) {
        const prevMsg = visibleUserMessages[prevIdx];
        if (prevMsg.m.content === text) {
          // Find the range of messages between the previous user message and this one
          const startTrim = prevMsg.i + 1;
          const endTrim = visibleUserMessages[thisIdx].i;
          const staleCount = endTrim - startTrim;
          if (staleCount > 0) {
            this.debugLog('stale_exchange_trim', {
              trimmedCount: staleCount,
              reason: 'duplicate_user_prompt_after_model_switch'
            });
            this.messages.splice(startTrim, staleCount);
          }
        }
      }
    }

    const exchangeStartIndex = this.getLastVisibleUserMessageIndex(this.messages);

    if (this.isAgentLike && this.looksLikeFileMutationRequest(text)) {
      await this.autoAttachLikelyRequestFiles(text);
    }

    this.synchronizeAttachmentContextMessage();

    if (this.isAgentLike && this.looksLikeLargeRefactorRequest(text)) {
      this.messages.push({
        role: 'user',
        content: 'This is a large refactor request. Do NOT try to rewrite or summarize the whole file in one pass. First inspect structure with list_workspace_files and read_file_slice for bounded sections when the file is large. Then refactor in many small consecutive steps if needed: function-by-function, type-by-type, or one small self-contained block at a time. A long plan is acceptable, but do not stop after planning or after the first step. Keep using tools and continue the refactor across multiple consecutive small edits until the whole task is done or you are genuinely blocked by missing exact file context.',
        hiddenFromTranscript: true
      });
        const preferredLargeRefactorTarget = await this.findPreferredLargeRefactorTargetPath(text);
        if (preferredLargeRefactorTarget) {
          this.messages.push({
            role: 'user',
            content: `Primary target file for this large refactor is ${preferredLargeRefactorTarget}. Use this exact file path or the same basename only. Do NOT invent alternate directories such as src/webview/chat or other nonexistent paths for this file.`,
            hiddenFromTranscript: true
          });
        }
    }

    if (this.isAgentLike) {
      const directSummary = await this.tryHandleDirectLicenseAuthorRename(text)
        || await this.tryHandleDirectTitleRename(text)
        || await this.tryHandleUltraSmallDeterministicTask(text);
      if (directSummary) {
        this.messages.push(this.createAssistantMessage(directSummary.summary, directSummary.revertOperationId ? [directSummary.revertOperationId] : []));
        await this.persistCompletedExchangeMemory(exchangeStartIndex);
        this.postStateToWebview();
        return;
      }
    }

    const capabilityProfile = this.getModelCapabilityProfile();

    if (this.agentMode === 'agent') {
      this.messages.push({
        role: 'user',
        content: capabilityProfile.preferStepwiseExecution
          ? 'Use ONE concrete action at a time. Do NOT output a long plan. If a tool is needed, call exactly ONE tool now, then decide the next action from the tool result. Keep each step small and immediate.'
          : 'Before taking any action, output a brief numbered plan (3–8 steps) describing what you will do. Keep it concise. After the plan, immediately start executing step 1 with the appropriate tool call — do NOT wait for confirmation. After each file modification, make sure the project verification/build check passes. Prefer the project\'s own verification command for the detected stack. If the system injects a build_verify tool result with errors, fix those errors before moving to the next step.',
        hiddenFromTranscript: true
      });
    } else if (this.agentMode === 'planner') {
      this.messages.push({
        role: 'user',
        content: 'You are in Planner mode. If the user asks a question or wants an explanation, answer directly — no tool calls needed. For tasks requiring code changes: focus on ONE action at a time. Call exactly ONE tool per response. After each tool result, decide the single next tool call. Do NOT output multi-step plans — just execute the next action immediately.',
        hiddenFromTranscript: true
      });
    }

    this.postStateToWebview();
    this.totalReadOps = 0;
    this.currentRequestRequiresWrite = /\b(?:create|write|edit|modify|update|add|append|change|rename|delete|remove|refactor|split|move)\b/i.test(text);
    this.failedCommandCounts.clear();
    this.lastNudgedResponseContent = '';
    this.consecutiveIdenticalResponses = 0;
    await this.runAgentLoop(exchangeStartIndex);
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

  private looksLikeProjectScanRequest(text: string): boolean {
    const normalized = text.trim().toLowerCase();
    if (!normalized) {
      return false;
    }

    return /(?:\b(?:scan|inspect|read|analy[sz]e|understand|index|explore)\s+(?:the\s+|this\s+)?(?:project|workspace|repo|repository|codebase)\b|\b(?:scan|inspect|read|analy[sz]e|understand|index|explore)\s+(?:my\s+)?(?:repo|repository|codebase)\b|\b(?:scan repo|read repo|inspect repo|remember (?:this |the )?(?:project|repo|repository|workspace|codebase)|remember project|remember repo)\b|(?:^|\s)(?:проскануй|скануй|просканировать|просканируй|сканируй|проаналізуй|аналізуй|проанализируй|анализируй|прочитай|зчитай|изучи|запомни|запам'ятай|запамятай)\s+(?:проект|проєкт|репо|репозиторій|репозиторий|воркспейс|workspace|кодовую\s+базу|кодову\s+базу)(?:\s|$)|(?:^|\s)(?:scan|inspect)\s+project(?:\s|$))/i.test(normalized);
  }

  private looksLikeLargeRefactorRequest(text: string): boolean {
    const normalized = text.trim().toLowerCase();
    if (!normalized) {
      return false;
    }

    const explicitTargets = this.extractLikelyRequestFileTargets(text);
    const activeEditorPath = vscode.window.activeTextEditor?.document.uri.scheme === 'file'
      ? vscode.window.activeTextEditor.document.uri.fsPath
      : undefined;
    const activeEditorExt = activeEditorPath ? path.extname(activeEditorPath).toLowerCase() : '';
    const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.java', '.cs', '.go', '.rs']);
    const activeEditorIsSourceFile = Boolean(
      activeEditorPath
      && sourceExtensions.has(activeEditorExt)
      && !activeEditorPath.includes(`${path.sep}.manulai${path.sep}`)
      && !activeEditorPath.includes('/.manulai/')
    );
    const looksLikeGreenfieldGeneration = /(?:\b(?:write|build|create|generate)\b[\s\S]{0,160}\b(?:complete|full|fully functional|ready to run)\b|\bfrom scratch\b|\bcomplete code\b|\bsingle file\b|\bcleanly separated components\b|\bturn-based game\b|\busing tailwind(?:css)?\b)/i.test(normalized);
    if (looksLikeGreenfieldGeneration && explicitTargets.length === 0 && !activeEditorIsSourceFile) {
      return false;
    }

    const splitPattern = /\b(split|break\s+up|divide|decompose|modulari[sz]e|extract|separate|refactor)\b|(?:^|\s)(?:розбий|розділи|поділи|рознеси|винеси|декомпоз\w*|рефактор|перероби)(?:\s|$)/i;
    const targetPattern = /\b(file|class|module|component|service|provider)\b|(?:^|\s)(?:файл|клас|модул|компонент|сервіс|провайдер)(?:\s|$)/i;
    const multipartPattern = /\b(smaller|small|multiple|modules?|files?|parts?)\b|(?:^|\s)(?:менш\w*|маленьк\w*|декілька|кілька|частин|модулів|файлів)(?:\s|$)/i;

    return splitPattern.test(normalized)
      && targetPattern.test(normalized)
      && (multipartPattern.test(normalized) || /\.(?:ts|tsx|js|jsx|py|java|cs|go|rs)\b/i.test(normalized));
  }

  private async autoAttachLikelyRequestFiles(text: string): Promise<void> {
    const targets = this.extractLikelyRequestFileTargets(text);
    if (targets.length === 0) {
      return;
    }

    const autoAttached: string[] = [];
    for (const target of targets.slice(0, 3)) {
      const resolvedPath = await this.findBestWorkspaceMatchForRequestTarget(target);
      if (!resolvedPath || this.attachedFiles.has(resolvedPath)) {
        continue;
      }

      const activePath = vscode.window.activeTextEditor?.document.uri.scheme === 'file'
        ? vscode.window.activeTextEditor.document.uri.fsPath
        : undefined;
      if (activePath && activePath === resolvedPath) {
        continue;
      }

      const attached = await this.attachFileContextUri(vscode.Uri.file(resolvedPath), true);
      if (!attached) {
        continue;
      }

      const displayPath = this.getDisplayPath(attached);
      autoAttached.push(displayPath);
      this.postProgressStep(`Found ${attached.name} at ${displayPath}; using it as context for this request`);
    }

    if (autoAttached.length > 0) {
      this.messages.push({
        role: 'user',
        content: `Auto-discovered likely target file(s) for this request: ${autoAttached.join(', ')}. Use these exact workspace paths when reading or editing files for this request.`,
        hiddenFromTranscript: true
      });
    }
  }

  private extractLikelyRequestFileTargets(text: string): string[] {
    const candidates: string[] = [];
    const pushCandidate = (value: string | undefined): void => {
      const trimmed = String(value ?? '').trim().replace(/^[`"']+|[`"'.,;:!?]+$/g, '');
      if (!trimmed) {
        return;
      }

      const key = trimmed.toLowerCase();
      if (!candidates.some(candidate => candidate.toLowerCase() === key)) {
        candidates.push(trimmed);
      }
    };

    let match: RegExpExecArray | null;
    const explicitPathPattern = /(?:^|\s)((?:[A-Za-z]:)?[A-Za-z0-9_./\\-]+\.(?:ts|tsx|js|jsx|json|md|css|scss|html|py|yml|yaml|xml|txt|sh|toml|ini))(?:\s|$)/gi;
    while ((match = explicitPathPattern.exec(text)) !== null) {
      pushCandidate(match[1]);
    }

    const bareNamePattern = /\b(package\.json|tsconfig\.json|README(?:\.md)?|LICENSE(?:\.txt|\.md)?|CHANGELOG(?:\.md)?|Dockerfile|Makefile|\.env(?:\.[A-Za-z0-9_-]+)?)\b/gi;
    while ((match = bareNamePattern.exec(text)) !== null) {
      pushCandidate(match[1]);
    }

    const normalized = text.toLowerCase();
    if (/(?:\breadme\b|рідмі|ридми)/i.test(normalized)) {
      pushCandidate('README.md');
      pushCandidate('README');
    }
    if (/(?:\blicense\b|ліцензі|лиценз)/i.test(normalized)) {
      pushCandidate('LICENSE');
    }
    if (/(?:package\s*json|package\.json)/i.test(normalized)) {
      pushCandidate('package.json');
    }
    if (/(?:tsconfig|tsconfig\.json)/i.test(normalized)) {
      pushCandidate('tsconfig.json');
    }
    if (/(?:changelog|історі[яї]\s+змін|список\s+змін|список\s+изменений)/i.test(normalized)) {
      pushCandidate('CHANGELOG.md');
    }
    if (/\bdockerfile\b/i.test(normalized)) {
      pushCandidate('Dockerfile');
    }
    if (/\bmakefile\b/i.test(normalized)) {
      pushCandidate('Makefile');
    }

    return candidates;
  }

  private async findBestWorkspaceMatchForRequestTarget(target: string): Promise<string | undefined> {
    let normalizedTarget = target.trim().replace(/\\/g, '/');
    if (!path.isAbsolute(normalizedTarget)) {
      normalizedTarget = normalizedTarget.replace(/^\.\//, '');
      normalizedTarget = normalizedTarget.replace(/^\.[/\\]/, '');
      normalizedTarget = normalizedTarget.replace(/^[/\\]+/, '');
    }
    if (!normalizedTarget) {
      return undefined;
    }

    const activeEditorPath = vscode.window.activeTextEditor?.document.uri.scheme === 'file'
      ? vscode.window.activeTextEditor.document.uri.fsPath
      : undefined;
    if (activeEditorPath && path.basename(activeEditorPath).toLowerCase() === path.basename(normalizedTarget).toLowerCase()) {
      return activeEditorPath;
    }

    const exactMatch = await this.resolveExistingWorkspacePath(normalizedTarget);
    if (exactMatch) {
      return exactMatch;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      return undefined;
    }

    const aliasGlobs: string[] = [];
    const lower = normalizedTarget.toLowerCase();
    if (lower === 'readme' || lower === 'readme.md') {
      aliasGlobs.push('**/README.md', '**/README');
    } else if (lower === 'license' || lower === 'license.txt' || lower === 'license.md') {
      aliasGlobs.push('**/LICENSE', '**/LICENSE.txt', '**/LICENSE.md');
    } else if (lower === 'changelog' || lower === 'changelog.md') {
      aliasGlobs.push('**/CHANGELOG.md', '**/CHANGELOG');
    } else {
      aliasGlobs.push(`**/${path.basename(normalizedTarget)}`);
    }

    let bestMatch: { fsPath: string; score: number } | undefined;
    for (const pattern of aliasGlobs) {
      const fileUris = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 50);
      for (const fileUri of fileUris) {
        const relativePath = vscode.workspace.asRelativePath(fileUri, false).replace(/\\/g, '/');
        const depth = relativePath.split('/').length - 1;
        const basename = path.basename(relativePath).toLowerCase();
        const basenameTarget = path.basename(normalizedTarget).toLowerCase();
        const exactBaseBonus = basename === basenameTarget ? 0 : 25;
        const readmeBonus = relativePath.toLowerCase() === 'readme.md' ? -20 : 0;
        const score = depth * 10 + exactBaseBonus + readmeBonus;

        if (!bestMatch || score < bestMatch.score) {
          bestMatch = { fsPath: fileUri.fsPath, score };
        }
      }
    }

    return bestMatch?.fsPath;
  }

  private async findPreferredLargeRefactorTargetPath(text: string): Promise<string | undefined> {
    const requestTargets = this.extractLikelyRequestFileTargets(text);
    for (const requestTarget of requestTargets) {
      const resolvedTarget = await this.findBestWorkspaceMatchForRequestTarget(requestTarget);
      if (resolvedTarget) {
        return resolvedTarget;
      }
    }

    const activeEditorPath = vscode.window.activeTextEditor?.document.uri.scheme === 'file'
      ? vscode.window.activeTextEditor.document.uri.fsPath
      : undefined;
    // Do not treat log files, config files, or .manulai/ internal files as large-refactor targets
    if (activeEditorPath) {
      const sourceExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.java', '.cs', '.go', '.rb', '.rs', '.cpp', '.c', '.h'];
      const ext = path.extname(activeEditorPath).toLowerCase();
      const isInsideManulai = activeEditorPath.includes(`${path.sep}.manulai${path.sep}`) || activeEditorPath.includes('/.manulai/');
      if (sourceExtensions.includes(ext) && !isInsideManulai) {
        return activeEditorPath;
      }
    }
    return undefined;
  }

  private async getPrimaryLargeRefactorTargetPath(): Promise<string | undefined> {
    const latestVisibleUserRequest = this.getLatestVisibleUserRequest(this.messages);
    if (!latestVisibleUserRequest || !this.looksLikeLargeRefactorRequest(latestVisibleUserRequest)) {
      return undefined;
    }
    return await this.findPreferredLargeRefactorTargetPath(latestVisibleUserRequest);
  }

  private isPathInsideWorkspace(fsPath: string): boolean {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      return true;
    }

    const normalizedRoot = path.normalize(workspaceRoot);
    const normalizedTarget = path.normalize(fsPath);
    return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
  }

  private async recoverRequestScopedTargetPath(targetPath: string): Promise<{ resolvedPath?: string; recoveredFrom?: string }> {
    const normalizedTarget = targetPath.trim();
    if (!normalizedTarget || !this.isLargeRefactorScenario()) {
      return {};
    }

    const primaryTarget = await this.getPrimaryLargeRefactorTargetPath();
    if (!primaryTarget) {
      return {};
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? path.dirname(primaryTarget);
    const requestedAbsolute = path.normalize(path.isAbsolute(normalizedTarget)
      ? normalizedTarget
      : path.join(workspaceRoot, normalizedTarget));
    const normalizedPrimaryTarget = path.normalize(primaryTarget);
    if (requestedAbsolute === normalizedPrimaryTarget) {
      return { resolvedPath: normalizedPrimaryTarget };
    }

    const sameBasename = path.basename(requestedAbsolute).toLowerCase() === path.basename(normalizedPrimaryTarget).toLowerCase();
    const sameExtension = path.extname(requestedAbsolute).toLowerCase() === path.extname(normalizedPrimaryTarget).toLowerCase();
    if (!sameBasename || !sameExtension) {
      return {};
    }

    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(requestedAbsolute));
      return {};
    } catch {
      return {
        resolvedPath: normalizedPrimaryTarget,
        recoveredFrom: normalizedTarget
      };
    }
  }

  private async validateRequestScopedCreatePath(requestedPath: string, resolvedFsPath: string): Promise<string | undefined> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot && !this.isPathInsideWorkspace(resolvedFsPath)) {
      return `Refusing to write outside the workspace: ${resolvedFsPath}. Use a path under ${workspaceRoot}.`;
    }

    if (!this.isLargeRefactorScenario()) {
      return undefined;
    }

    const primaryTarget = await this.getPrimaryLargeRefactorTargetPath();
    if (!primaryTarget) {
      return undefined;
    }

    const sameExtension = path.extname(resolvedFsPath).toLowerCase() === path.extname(primaryTarget).toLowerCase();
    if (!sameExtension) {
      return undefined;
    }

    const targetDir = path.normalize(path.dirname(primaryTarget));
    const normalizedResolvedPath = path.normalize(resolvedFsPath);
    const isUnderTargetDir = normalizedResolvedPath.startsWith(`${targetDir}${path.sep}`);
    if (!isUnderTargetDir) {
      return `For this large refactor, create the extracted module under ${path.dirname(primaryTarget)}, not at ${requestedPath || resolvedFsPath}. Use an exact sibling or child path beneath the primary target directory.`;
    }

    return undefined;
  }

  private requestExplicitlyAllowsPlaceholderWrites(): boolean {
    const latestVisibleUserRequest = this.getLatestVisibleUserRequest(this.messages).toLowerCase();
    if (!latestVisibleUserRequest) {
      return false;
    }

    return /(?:placeholder|stub|scaffold|skeleton|template|boilerplate|todo|tbd|empty component|blank component)/i.test(latestVisibleUserRequest);
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

  private async tryHandleDirectTitleRename(text: string): Promise<FileWriteSummary | undefined> {
    // Match patterns like:
    //   "Зміни тайтл на X" / "Заміни тайтл в README.md на X" / "Change title to X"
    const titleMatch = text.match(
      /(?:зміни|поміняй|змінити|замін\w*|change|set|update)\s+(?:тайтл|заголовок|title|header|хедер)\s+(?:(?:в|in|у)\s+(\S+)\s+)?(?:на|to|:)\s+(.+)/i
    );
    if (!titleMatch) {
      return undefined;
    }

    const explicitFile = titleMatch[1]?.trim();
    const newTitle = titleMatch[2].trim();
    if (!newTitle) {
      return undefined;
    }

    // Look for a markdown file: prefer explicit mention, then attached, then active editor, then README.md
    let targetPath: string | undefined;

    if (explicitFile) {
      const resolvedUri = this.resolveWorkspaceUri(explicitFile);
      try {
        await vscode.workspace.fs.stat(resolvedUri);
        targetPath = resolvedUri.fsPath;
      } catch {
        // Explicit file not found, continue with other sources
      }
    }

    if (!targetPath) {
      for (const [fsPath] of this.attachedFiles) {
        if (fsPath.endsWith('.md')) {
          targetPath = fsPath;
          break;
        }
      }
    }

    if (!targetPath) {
      const activeDoc = vscode.window.activeTextEditor?.document;
      if (activeDoc && !activeDoc.isUntitled && activeDoc.fileName.endsWith('.md')) {
        targetPath = activeDoc.uri.fsPath;
      }
    }

    if (!targetPath) {
      const readmeUri = this.resolveWorkspaceUri('README.md');
      try {
        await vscode.workspace.fs.stat(readmeUri);
        targetPath = readmeUri.fsPath;
      } catch {
        return undefined;
      }
    }

    const content = await this.readWorkspaceText(vscode.Uri.file(targetPath));
    // Replace the first H1 heading
    const updated = content.replace(/^#\s+.+$/m, `# ${newTitle}`);
    if (updated === content) {
      return { summary: `No H1 heading found in ${path.basename(targetPath)} to replace.` };
    }

    const approved = await this.approveFileWrite([targetPath]);
    if (!approved) {
      return { summary: `[File write denied by user: ${path.basename(targetPath)}]` };
    }

    return this.writeFileWithDiff(targetPath, updated);
  }

  private async tryHandleUltraSmallDeterministicTask(text: string): Promise<FileWriteSummary | undefined> {
    if (this.getModelCapabilityProfile().tier !== 'micro') {
      return undefined;
    }

    return await this.tryHandleUltraSmallPackageJsonRead(text)
      || await this.tryHandleUltraSmallReadmeTitleRead(text)
      || await this.tryHandleUltraSmallExactLineReplace(text)
      || await this.tryHandleUltraSmallSingleFileCreate(text);
  }

  private async tryHandleUltraSmallPackageJsonRead(text: string): Promise<FileWriteSummary | undefined> {
    const normalized = text.trim().toLowerCase();
    if (!normalized.includes('package.json')) {
      return undefined;
    }
    if (!/(?:\bread\b|\bshow\b|\banswer\b|\bскажи\b|\bпокажи\b|\bпрочитай\b)/i.test(text)) {
      return undefined;
    }
    if (!/\bname\b/i.test(text) || !/\bversion\b/i.test(text)) {
      return undefined;
    }

    try {
      const packageJsonText = await this.readWorkspaceText(this.resolveWorkspaceUri('package.json'));
      const packageJson = JSON.parse(packageJsonText) as { name?: string; version?: string };
      const name = String(packageJson.name ?? '').trim();
      const version = String(packageJson.version ?? '').trim();
      if (!name && !version) {
        return { summary: 'package.json is missing both name and version.' };
      }
      return { summary: [name, version].filter(Boolean).join(' ').trim() };
    } catch (error) {
      return { summary: `Unable to read package.json: ${error instanceof Error ? error.message : 'unknown error'}` };
    }
  }

  private async tryHandleUltraSmallSingleFileCreate(text: string): Promise<FileWriteSummary | undefined> {
    const request = this.extractDeterministicSingleFileCreateRequest(text);
    if (!request) {
      return undefined;
    }

    const approved = this.autoApprove || await this.approveFileWrite([request.filepath]);
    if (!approved) {
      return { summary: `[File write denied by user: ${path.basename(request.filepath)}]` };
    }

    const targetUri = await this.resolveWorkspaceUriForOperation(request.filepath, true);
    const pathGuardError = await this.validateRequestScopedCreatePath(request.filepath, targetUri.fsPath);
    if (pathGuardError) {
      return { summary: pathGuardError };
    }

    let sanitizedContent = this.sanitizeGeneratedFileContent(request.content);
    if (this.looksLikeDiffOutput(sanitizedContent)) {
      sanitizedContent = this.stripDiffPrefixes(sanitizedContent);
    }

    return this.writeFileWithDiff(targetUri.fsPath, sanitizedContent);
  }

  private async tryRecoverFromDegenerateOutput(messages: OllamaMessage[], finalContent: string, retryCount: number): Promise<boolean> {
    if (!this.isAgentLike) {
      return false;
    }

    const capabilityProfile = this.getModelCapabilityProfile();
    if (capabilityProfile.tier === 'large' || capabilityProfile.tier === 'xlarge') {
      return false;
    }

    const degenerateNudgeCount = messages.filter(
      message => message.role === 'user'
        && message.hiddenFromTranscript
        && typeof message.content === 'string'
        && message.content.includes('Your last response was incoherent or repetitive')
    ).length;
    if (degenerateNudgeCount >= 1) {
      return false;
    }

    const latestVisibleUserRequest = this.getLatestVisibleUserRequest(messages);
    const starterFilepath = this.inferDegenerateRecoveryStarterFilepath(latestVisibleUserRequest);
    const writeRecovery = this.currentRequestRequiresWrite;
    const nudgeMessage = writeRecovery
      ? `Your last response was incoherent or repetitive. Reset completely. Do NOT explain, summarize, or plan. Call exactly ONE tool now.${starterFilepath ? ` For this greenfield create task, start by calling create_or_edit_file for ${starterFilepath} with the complete working implementation.` : ' For a create request, your next response should usually be create_or_edit_file with a concrete file path and the full implementation.'} Do not output prose before the tool call.`
      : 'Your last response was incoherent or repetitive. Reset completely. Do NOT explain or plan. Either answer briefly in plain text now, or call exactly ONE read tool if you truly need file context first.';

    this.debugLog('degenerate_output_retry', {
      retryCount,
      tier: capabilityProfile.tier,
      starterFilepath: starterFilepath ?? null,
      requiresWrite: writeRecovery
    });

    messages.push({
      role: 'assistant',
      content: finalContent,
      hiddenFromTranscript: true
    });
    messages.push({
      role: 'user',
      content: nudgeMessage,
      hiddenFromTranscript: true
    });

    this.postStatus('Model produced incoherent output — retrying once with a stricter one-step recovery...');
    await this.processOllamaResponse(messages, retryCount + 1);
    return true;
  }

  private inferDegenerateRecoveryStarterFilepath(text: string): string | undefined {
    const explicitTargets = this.extractLikelyRequestFileTargets(text);
    if (explicitTargets.length > 0) {
      return explicitTargets[0];
    }

    const normalized = text.trim().toLowerCase();
    if (!this.looksLikeFileMutationRequest(text) && !/\b(?:create|write|add|build|make|створи|создай|зроби|сделай)\b/i.test(normalized)) {
      return undefined;
    }

    if (/\bpython\b|\bpy\b|\bпайтон\b|\bпіто?н\b/i.test(normalized)) {
      return 'main.py';
    }
    if (/\btypescript\b|\btype script\b|\bts\b/i.test(normalized)) {
      return 'main.ts';
    }
    if (/\bjavascript\b|\bnode\b|\bjs\b/i.test(normalized)) {
      return 'main.js';
    }
    if (/\bhtml\b|\bweb\s*page\b|\blanding\b/i.test(normalized)) {
      return 'index.html';
    }

    return 'main.txt';
  }

  private async tryAutoRecoverDeterministicReadFailure(messages: OllamaMessage[], toolName: string, toolResult: string): Promise<boolean> {
    if (toolName !== 'read_file_slice' && toolName !== 'read_specific_file') {
      return false;
    }

    let parsedResult: Record<string, unknown>;
    try {
      parsedResult = JSON.parse(toolResult) as Record<string, unknown>;
    } catch {
      return false;
    }

    if (!parsedResult.error) {
      return false;
    }

    const tier = this.getModelCapabilityProfile().tier;
    if (tier !== 'micro' && tier !== 'small' && tier !== 'medium') {
      return false;
    }

    const latestVisibleUserRequest = this.getLatestVisibleUserRequest(messages);
    const recoveryTarget = this.getDeterministicReadRecoveryTarget(latestVisibleUserRequest);
    if (!recoveryTarget) {
      return false;
    }

    const attemptedPath = String(parsedResult.path ?? parsedResult.filepath ?? '').trim();
    if (attemptedPath && attemptedPath.toLowerCase().endsWith(recoveryTarget.filepath.toLowerCase())) {
      return false;
    }

    const recoveredResult = await this.readSpecificFile(recoveryTarget.filepath);
    this.debugLog('deterministic_read_recovery', {
      failedTool: toolName,
      failedPath: attemptedPath || null,
      recoveredPath: recoveryTarget.filepath,
      reason: recoveryTarget.reason
    });

    messages.push({
      role: 'tool',
      content: recoveredResult,
      tool_name: 'read_specific_file',
      hiddenFromTranscript: true,
      revertOperationIds: this.extractToolResultRevertOperationIds(recoveredResult)
    });
    messages.push({
      role: 'user',
      content: `The previous read used the wrong target. Continue from ${recoveryTarget.filepath}, which was read for you. ${recoveryTarget.reason}`,
      hiddenFromTranscript: true
    });

    await this.processOllamaResponse(messages, 0);
    return true;
  }

  private getDeterministicReadRecoveryTarget(text: string): { filepath: string; reason: string } | undefined {
    const normalized = text.trim().toLowerCase();

    if (normalized.includes('package.json')
      && /\bname\b/i.test(text)
      && /\bversion\b/i.test(text)
      && /(?:\bread\b|\bshow\b|\banswer\b|\bпокажи\b|\bпрочитай\b|\bскажи\b)/i.test(text)) {
      return {
        filepath: 'package.json',
        reason: 'The user asked for package.json name/version, so do not fall back to an unrelated file.'
      };
    }

    if (/(?:\breadme\b|readme\.md)/i.test(normalized)
      && /(?:\btitle\b|\bheading\b|\bheadline\b|\bзаголовок\b|\bтайтл\b)/i.test(text)
      && /(?:\bread\b|\bshow\b|\bwhat\b|\banswer\b|\bпокажи\b|\bпрочитай\b|\bскажи\b)/i.test(text)) {
      return {
        filepath: 'README.md',
        reason: 'The user asked for the README title, so retry against README.md directly.'
      };
    }

    return undefined;
  }

  private async tryHandleUltraSmallReadmeTitleRead(text: string): Promise<FileWriteSummary | undefined> {
    const normalized = text.trim().toLowerCase();
    if (!/(?:\bread\b|\bshow\b|\bwhat\b|\banswer\b|\bскажи\b|\bпокажи\b|\bпрочитай\b)/i.test(text)) {
      return undefined;
    }
    if (!/(?:\btitle\b|\bheading\b|\bheadline\b|\bзаголовок\b|\bтайтл\b)/i.test(text)) {
      return undefined;
    }
    if (!/(?:\breadme\b|readme\.md)/i.test(normalized)) {
      return undefined;
    }

    try {
      const readmeText = await this.readWorkspaceText(this.resolveWorkspaceUri('README.md'));
      const titleMatch = readmeText.match(/^#\s+(.+)$/m);
      return { summary: titleMatch ? titleMatch[1].trim() : 'README.md has no H1 title.' };
    } catch (error) {
      return { summary: `Unable to read README.md: ${error instanceof Error ? error.message : 'unknown error'}` };
    }
  }

  private async tryHandleUltraSmallExactLineReplace(text: string): Promise<FileWriteSummary | undefined> {
    const match = text.match(/replace\s+(?:the\s+)?exact\s+line\s+["'`](.+?)["'`]\s+with\s+["'`](.+?)["'`](?:\s+in\s+(\S+))?/i);
    if (!match) {
      return undefined;
    }

    const oldLine = match[1]?.trim();
    const newLine = match[2]?.trim();
    const explicitFile = match[3]?.trim();
    if (!oldLine || !newLine) {
      return undefined;
    }

    const candidateTargets = explicitFile ? [explicitFile] : this.extractLikelyRequestFileTargets(text);
    const targetPath = await this.resolveDeterministicKnownFilePath(candidateTargets);
    if (!targetPath) {
      return { summary: 'Unable to resolve the target file for exact-line replacement.' };
    }

    const content = await this.readWorkspaceText(vscode.Uri.file(targetPath));
    const oldLinePattern = new RegExp(`^${this.escapeRegexForRegExp(oldLine)}$`, 'm');
    if (!oldLinePattern.test(content)) {
      return { summary: `Exact line not found in ${path.basename(targetPath)}.` };
    }

    const updated = content.replace(oldLinePattern, newLine);
    if (updated === content) {
      return { summary: `${path.basename(targetPath)} already matches the requested line.` };
    }

    const approved = this.autoApprove || await this.approveFileWrite([targetPath]);
    if (!approved) {
      return { summary: `[File write denied by user: ${path.basename(targetPath)}]` };
    }

    return this.writeFileWithDiff(targetPath, updated);
  }

  private async resolveDeterministicKnownFilePath(candidates: string[]): Promise<string | undefined> {
    for (const candidate of candidates) {
      const resolved = await this.findBestWorkspaceMatchForRequestTarget(candidate);
      if (resolved) {
        return resolved;
      }
    }

    const commonKnownFiles = ['README.md', 'README', 'LICENSE', 'package.json', 'tsconfig.json'];
    for (const candidate of commonKnownFiles) {
      const resolved = await this.findBestWorkspaceMatchForRequestTarget(candidate);
      if (resolved) {
        return resolved;
      }
    }

    return undefined;
  }

  private escapeRegexForRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private extractDeterministicSingleFileCreateRequest(text: string): { filepath: string; content: string } | undefined {
    const match = text.match(/\b(?:create|write|add)\s+((?:[A-Za-z]:)?[A-Za-z0-9_./\\-]+\.(?:ts|tsx|js|jsx|json|md|css|html|py|yml|yaml|txt|sh))\b/i);
    if (!match || !match[1]) {
      return undefined;
    }

    const filepath = match[1].replace(/\\/g, '/');
    const codeBlockMatch = text.match(/```[\w+-]*\n([\s\S]*?)```/);
    let content = codeBlockMatch?.[1]?.trim() ?? '';

    if (!content) {
      const matchStart = match.index ?? 0;
      const remainder = text.slice(matchStart + match[0].length)
        .replace(/^\s*(?:with\s+(?:content|code)\s*:|containing\s+|that\s+contains\s+)/i, '')
        .replace(/^\s*exporting\s+/i, 'export ')
        .replace(/\bdo\s+not\s+modify\s+any\s+other\s+file\b[.!]?/i, '')
        .trim();
      content = remainder.replace(/[\s.]+$/, '').trim();
    }

    if (!content) {
      return undefined;
    }

    const normalizedContent = content.startsWith('export ') || content.startsWith('import ') || content.startsWith('const ') || content.startsWith('function ') || content.startsWith('class ')
      ? content
      : content;
    const looksLikeCode = /(?:\bexport\b|\bfunction\b|=>|\bclass\b|\binterface\b|\bconst\b|\blet\b|\breturn\b|[{};])/m.test(normalizedContent);
    if (!looksLikeCode) {
      return undefined;
    }

    return {
      filepath,
      content: normalizedContent.endsWith('\n') ? normalizedContent : `${normalizedContent}\n`
    };
  }

  private clearChat(): void {
    if (this.requestInFlight) {
      this.postStatus('Cannot clear chat while a request is running. Wait for the current response to finish.');
      return;
    }

    this.messages.length = 0;
    this.attachedFiles.clear();
    this.progressStepCounter = 0;
    this.debugLog('chat_cleared', { chatId: this.activeChat.id, title: this.activeChat.title });
    this.postStateToWebview();
    this.postStatus('Chat history and attached context cleared.');
  }

  private async runAgentLoop(exchangeStartIndex = this.getLastVisibleUserMessageIndex(this.messages)): Promise<void> {
    this.requestInFlight = true;
    this.stopRequested = false;
    this.resetNarratedBootstrapState();
    this.postBusyState(true);

    try {
      await this.processOllamaResponse(this.messages);
      await this.persistCompletedExchangeMemory(exchangeStartIndex);
      this.postStateToWebview();
    } catch (error) {
      if (this.isAbortError(error)) {
        this.messages.push({ role: 'assistant', content: 'Request was stopped.' });
        this.postStateToWebview();
        return;
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.messages.push({ role: 'assistant', content: `Request failed: ${message}` });
      this.postStateToWebview();
    } finally {
      this.resetNarratedBootstrapState();
      this.currentRequestAbortController = undefined;
      this.stopRequested = false;
      this.requestInFlight = false;
      this.postBusyState(false);
      this.postStateToWebview();
    }
  }

  private async processOllamaResponse(messages: OllamaMessage[], retryCount = 0): Promise<void> {
    this.throwIfRequestStopped();

    // Context trimming: prevent overflow by keeping only recent model-visible messages.
    // localOnly progress messages don't go to Ollama (filtered in callOllama) so exclude them from the count.
    if (this.isAgentLike) {
      const { maxMessages } = this.getModelContextLimits();
      const modelMessages = messages.filter(m => !m.localOnly);
      if (modelMessages.length > maxMessages) {
        // Strip all localOnly progress messages first — they are UI-only
        const stripped = messages.filter(m => !m.localOnly);
        // Keep first 2 messages (user prompt + plan nudge) and most recent ones
        const headCount = 2;
        const tailCount = maxMessages - headCount - 1; // -1 for the trim notice
        const first = stripped.slice(0, headCount);
        const recent = stripped.slice(-tailCount);
        const trimNotice: OllamaMessage = {
          role: 'user',
          content: 'Context trimmed to prevent overflow. Continue with the task — execute the next required action.',
          hiddenFromTranscript: true
        };
        messages.splice(0, messages.length, ...first, trimNotice, ...recent);
        this.debugLog('context_trim', { maxMessages, trimmedTo: messages.length, model: this.getSelectedModel() });
      }
    }

    this.postStatus(retryCount > 0 ? `Retry ${retryCount}: calling Ollama...` : 'Calling Ollama...');
    this.debugLog('ollama_request', { retryCount, messageCount: messages.filter(m => !m.localOnly).length, model: this.getSelectedModel() });
    const responseData = await this.callOllama(messages);
    this.throwIfRequestStopped();
    const assistantMessage = responseData.message;

    if (!assistantMessage) {
      throw new Error('Ollama returned no message payload.');
    }

    const resolvedToolCalls = this.isAgentLike ? this.extractToolCalls(assistantMessage) : [];

    if (resolvedToolCalls.length > 0) {
      const wasNative = (assistantMessage.tool_calls?.length ?? 0) > 0;
      this.debugLog('tool_calls_detected', { count: resolvedToolCalls.length, native: wasNative, tools: resolvedToolCalls.map(tc => tc.function?.name) });
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

        // Short-circuit repeated read_workspace_notes calls — notes don't change within a single exchange.
        if (toolName === 'read_workspace_notes') {
          const alreadyRead = messages.some(m => m.role === 'tool' && m.tool_name === 'read_workspace_notes');
          if (alreadyRead) {
            const shortCircuit = JSON.stringify({ content: '(notes already read — stop reading and proceed with create_or_edit_file to write actual code now)' });
            this.debugLog('tool_exec_result', { tool: toolName, result: shortCircuit, shortCircuited: true });
            messages.push({ role: 'tool', content: shortCircuit, tool_name: toolName, hiddenFromTranscript: true });
            continue;
          }
        }

        this.postProgressStep(this.describeToolExecution(toolCall));
        this.debugLog('tool_exec_start', { tool: toolName, args: toolCall.function?.arguments });
        const toolResult = await this.executeToolCall(toolCall);
        this.debugLog('tool_exec_result', { tool: toolName, result: toolResult.substring(0, 500) });
        this.throwIfRequestStopped();
        messages.push({
          role: 'tool',
          content: toolResult,
          tool_name: toolName,
          hiddenFromTranscript: true,
          revertOperationIds: this.extractToolResultRevertOperationIds(toolResult)
        });

        if (await this.tryAutoRecoverDeterministicReadFailure(messages, toolName, toolResult)) {
          return;
        }

        // Count read operations for read-loop nudge
        if (toolName === 'read_file_slice' || toolName === 'read_specific_file') {
          this.totalReadOps++;
        }

        // Track repeated failing terminal commands
        if (toolName === 'execute_terminal_command') {
          try {
            const cmdResult = JSON.parse(toolResult) as Record<string, unknown>;
            const exitCode = Number(cmdResult.exitCode ?? 0);
            if (exitCode !== 0) {
              const cmdStr = String(cmdResult.command ?? '');
              // Normalize: strip leading cd ... && to get the core command signature
              const coreSig = cmdStr.replace(/^cd\s+\S+\s*&&\s*/, '').trim();
              const count = (this.failedCommandCounts.get(coreSig) ?? 0) + 1;
              this.failedCommandCounts.set(coreSig, count);
              if (count >= 2) {
                const stderr = String(cmdResult.stderr ?? cmdResult.error ?? '');
                this.debugLog('repeated_command_failure', { command: coreSig, count, exitCode });

                if (this.autoApprove) {
                  // Auto-approve: inject nudge telling model to try a different approach
                  const nudge = `The command "${coreSig}" has failed ${count} times with the same error (exit code ${exitCode}${stderr ? `: ${stderr.substring(0, 200)}` : ''}). This command is not going to work. STOP retrying it. Try a completely different approach — use a different tool, library, or write the config file manually instead.`;
                  this.postProgressStep(`Command failed ${count}x — nudging model to try alternative`);
                  messages.push({ role: 'user', content: nudge, hiddenFromTranscript: true });
                } else {
                  // Manual mode: ask user whether to continue or abort
                  const approved = await this.requestApproval({
                    kind: 'tool',
                    title: 'Repeated Command Failure',
                    message: `"${coreSig}" has failed ${count} times. Continue or let the model try a different approach?`,
                    details: stderr.substring(0, 500) || `Exit code ${exitCode}`,
                    approveLabel: 'Continue',
                    declineLabel: 'Try different approach'
                  });
                  if (!approved) {
                    const redirectNudge = `The user says this command is not working. STOP retrying "${coreSig}". Use a completely different approach — write the file manually with create_or_edit_file, or use a different tool/library.`;
                    messages.push({ role: 'user', content: redirectNudge, hiddenFromTranscript: true });
                  }
                }
              }
            } else {
              // Successful execution — clear failure count for this command
              const cmdStr = String(cmdResult.command ?? '');
              const coreSig = cmdStr.replace(/^cd\s+\S+\s*&&\s*/, '').trim();
              this.failedCommandCounts.delete(coreSig);
            }
          } catch {
            // Ignore JSON parse errors on tool results
          }
        }
      }

      // --- Post-write build verification ---
      // After any round that included a successful write tool, run a compile check.
      // If the check passes, log progress. If it fails, inject errors into model context.
      const writeToolNames = new Set(['replace_in_file', 'create_or_edit_file', 'write_to_file', 'delete_file']);
      const hadSuccessfulWrite = resolvedToolCalls.some(tc => {
        const n = tc.function?.name ?? '';
        if (!writeToolNames.has(n)) {
          return false;
        }
        // Check the corresponding tool result for absence of error
        const result = [...messages].reverse().find((m): m is OllamaMessage & { tool_name: string } => m.role === 'tool' && m.tool_name === n);
        if (!result) {
          return false;
        }
        try {
          const p = JSON.parse(result.content) as Record<string, unknown>;
          return !p.error;
        } catch {
          return false;
        }
      });

      if (hadSuccessfulWrite) {
        const verifyResult = await this.tryRunBuildVerify(messages);
        if (verifyResult !== null) {
          if (verifyResult.ok) {
            this.postProgressStep('Build check: OK');
          } else {
            this.postProgressStep('Build errors detected — sending to model...');
            const verifyContent = `Build verification (compile check) after edit failed:\n${verifyResult.output || '(no output)'}\n\nFix all errors shown above before continuing. Then re-run the build check to confirm.`;
            messages.push({
              role: 'tool',
              content: JSON.stringify({ tool: 'build_verify', result: verifyContent }),
              tool_name: 'build_verify',
              hiddenFromTranscript: false
            });
          }
        }
      }

      // For non-write tasks (summarize, explain, review), nudge the model to stop reading and produce output
      if (!this.currentRequestRequiresWrite && this.totalReadOps >= this.getModelCapabilityProfile().maxReadOpsWithoutWrite && !hadSuccessfulWrite) {
        const readNudge = `You have already read ${this.totalReadOps} sections of the file(s). You now have enough context. STOP reading additional sections and produce your summary/analysis/answer as a text response NOW. Do NOT call any more tools.`;
        this.debugLog('read_loop_nudge', { totalReadOps: this.totalReadOps });
        messages.push({ role: 'user', content: readNudge, hiddenFromTranscript: true });
      }

      // If all executed tools were inspection-only (no writes), preserve retryCount
      // so nudge counter isn't reset by useless read-only tool calls.
      const inspectionOnlyToolSet = new Set([
        'read_workspace_notes', 'list_workspace_files', 'project_scan',
        'read_active_file', 'read_specific_file', 'read_file_slice'
      ]);
      const allToolsWereInspectionOnly = resolvedToolCalls.every(tc => {
        const n = tc.function?.name ?? '';
        if (inspectionOnlyToolSet.has(n)) { return true; }
        if (n === 'execute_terminal_command') {
          const args = tc.function?.arguments;
          const cmd = typeof args === 'object' && args !== null ? String((args as Record<string, unknown>).command ?? '') : '';
          return isTerminalReadOnlyInspectionCommand(cmd);
        }
        return false;
      });

      this.resetNarratedBootstrapState();
      await this.processOllamaResponse(messages, allToolsWereInspectionOnly && !hadSuccessfulWrite ? retryCount : 0);
      return;
    }

    let finalContent = assistantMessage.content ?? '';
    this.debugLog('ollama_response', { contentLength: finalContent.length, hasToolCalls: resolvedToolCalls.length > 0, contentPreview: finalContent.substring(0, 300) });

    // Detect degenerate/repetitive output (e.g., "node node node" loops from overwhelmed models)
    if (this.isDegenerateOutput(finalContent)) {
      this.debugLog('degenerate_output', { contentLength: finalContent.length, retryCount, contentPreview: finalContent.substring(0, 200) });
      // Do NOT push the garbage to message history — it poisons future context.
      // Also trim any recently pushed degenerate hidden messages from the current exchange.
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === 'user' && !m.hiddenFromTranscript) { break; }
        if (m.role === 'assistant' && m.hiddenFromTranscript && typeof m.content === 'string' && this.isDegenerateOutput(m.content)) {
          messages.splice(i, 1);
        }
      }
      if (await this.tryRecoverFromDegenerateOutput(messages, finalContent, retryCount)) {
        return;
      }
      messages.push({
        role: 'assistant',
        content: 'The model produced incoherent/repetitive output. This usually means the prompt is too complex for this model size. Try a larger model or simplify the request.'
      });
      return;
    }

    if (!this.isAgentLike) {
      // Chat mode: display the model response as-is, no file-write fallback processing.
      finalContent = this.truncateLargeCodeBlocks(finalContent);
      if (!finalContent.trim()) {
        finalContent = 'The model returned an empty response. Try rephrasing your question.';
      }
      messages.push({ role: 'assistant', content: finalContent });
      return;
    }

    const leakedToolCallNudgeCount = messages.filter(
      message => message.role === 'user'
        && typeof message.content === 'string'
        && message.content.includes('Your last response printed a raw tool call')
    ).length;

    if (this.containsLeakedToolCallPayload(finalContent) && leakedToolCallNudgeCount < 2) {
      this.debugLog('tool_call_leak_retry', { retryCount, contentPreview: finalContent.substring(0, 300) });
      messages.push({ role: 'assistant', content: finalContent, hiddenFromTranscript: true });
      messages.push({
        role: 'user',
        content: 'Your last response printed a raw tool call instead of executing it. Do NOT output JSON or fenced code blocks for tool calls. Call the appropriate tool now using the native tool-calling mechanism. If you need current file content first, call read_specific_file, then continue with replace_in_file or another tool.',
        hiddenFromTranscript: true
      });
      this.postStatus('Raw tool call leaked into the response — nudging model to execute the tool...');
      await this.processOllamaResponse(messages, retryCount);
      return;
    }

    {
      // --- Fallback layer 1: detect [Begin of FILE]...[End of FILE] markers ---
      const markerWrite = this.extractMarkerFileWrite(finalContent);
      if (markerWrite) {
        this.debugLog('fallback_layer', { layer: 1, type: 'marker_write', filepath: markerWrite.filepath });
        const writeApproved = await this.approveFileWrite([markerWrite.filepath]);
        if (!writeApproved) {
          messages.push({ role: 'assistant', content: `[File write denied by user: ${markerWrite.filepath}]` });
          return;
        }
        const summary = await this.writeFileWithDiff(markerWrite.filepath, markerWrite.fileContent);
        if (!summary.summary.startsWith('Blocked write to ')) {
          const remaining = finalContent.replace(markerWrite.fullMatch, '').trim();
          finalContent = summary.summary + (remaining ? '\n\n' + this.truncateLongResponse(remaining) : '');
          messages.push(this.createAssistantMessage(finalContent, summary.revertOperationId ? [summary.revertOperationId] : []));
          return;
        }
        // Blocked — fall through to nudge layer
      }

      // --- Fallback layer 2: detect code blocks with filepath hints ---
      const codeBlockWrites = this.extractCodeBlockFileWrites(finalContent);
      if (codeBlockWrites.length > 0) {
        this.debugLog('fallback_layer', { layer: 2, type: 'code_block_write', files: codeBlockWrites.map(b => b.filepath) });
        const fileNames = codeBlockWrites.map(w => w.filepath);
        const writeApproved = await this.approveFileWrite(fileNames);
        if (!writeApproved) {
          messages.push({ role: 'assistant', content: `[File write denied by user: ${fileNames.join(', ')}]` });
          return;
        }

        const appliedSummaries: string[] = [];
        const revertOperationIds: string[] = [];
        let allBlocked = true;
        for (const block of codeBlockWrites) {
          const summary = await this.writeFileWithDiff(block.filepath, block.fileContent);
          appliedSummaries.push(summary.summary);
          if (summary.revertOperationId) {
            revertOperationIds.push(summary.revertOperationId);
          }
          if (!summary.summary.startsWith('Blocked write to ')) {
            allBlocked = false;
          }
          finalContent = finalContent.replace(block.fullMatch, '');
        }

        // If ALL writes were blocked by destructive write guard, nudge model to use tools properly
        const blockedWriteNudges = messages.filter(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('Your file write was blocked')).length;
        if (allBlocked && blockedWriteNudges < 2) {
          this.debugLog('blocked_write_retry', { retryCount, source: 'code_block_extraction', summaries: appliedSummaries });
          messages.push({ role: 'assistant', content: appliedSummaries.join('\n'), hiddenFromTranscript: true });
          messages.push({
            role: 'user',
            content: 'Your file write was blocked because you tried to rewrite the entire file with partial content. ' +
              'Do NOT output the full file in a code block. Instead, use the replace_in_file tool to change ONLY the specific lines that need to change. ' +
              'First call read_specific_file to see the current content, then call replace_in_file with the exact old_text and new_text.',
            hiddenFromTranscript: true
          });
          this.postStatus('Blocked partial write — nudging model to use replace_in_file...');
          // Don't increment retryCount — blocked-write nudge is structural, not behavioral,
          // so the downstream nudge layer should still have its full retry budget.
          await this.processOllamaResponse(messages, retryCount);
          return;
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
        if (!summary.summary.startsWith('Blocked write to ')) {
          const remaining = finalContent.replace(unifiedDiffWrite.fullMatch, '').trim();
          messages.push(this.createAssistantMessage(summary.summary + (remaining ? '\n\n' + this.truncateLongResponse(remaining) : ''), summary.revertOperationId ? [summary.revertOperationId] : []));
          return;
        }
        // Blocked — fall through to nudge layer
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
        let allBlocked3 = true;
        let remaining = finalContent;
        for (const block of inlineFileBlocks) {
          const summary = await this.writeFileWithDiff(block.filepath, block.fileContent);
          appliedSummaries.push(summary.summary);
          if (summary.revertOperationId) {
            revertOperationIds.push(summary.revertOperationId);
          }
          if (!summary.summary.startsWith('Blocked write to ')) {
            allBlocked3 = false;
          }
          remaining = remaining.replace(block.fullMatch, '');
        }
        if (!allBlocked3) {
          remaining = remaining.trim();
          finalContent = appliedSummaries.join('\n\n') + (remaining ? '\n\n' + this.truncateLongResponse(remaining) : '');
          messages.push(this.createAssistantMessage(finalContent, revertOperationIds));
          return;
        }
        // All blocked — fall through to nudge layer
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
        if (!summary.summary.startsWith('Blocked write to ')) {
          const remaining = finalContent.replace(describedFileDump.fullMatch, '').trim();
          messages.push(this.createAssistantMessage(summary.summary + (remaining ? '\n\n' + this.truncateLongResponse(remaining) : ''), summary.revertOperationId ? [summary.revertOperationId] : []));
          return;
        }
        // Blocked — fall through to nudge layer
      }

      // --- Fallback layer 4c: detect new file creation from code block + filename mention ---
      const newFileWrite = this.extractNewFileCreation(finalContent);
      if (newFileWrite) {
        const writeApproved = await this.approveFileWrite([newFileWrite.filepath]);
        if (!writeApproved) {
          messages.push({ role: 'assistant', content: `[File write denied by user: ${newFileWrite.filepath}]` });
          return;
        }
        const summary = await this.writeFileWithDiff(newFileWrite.filepath, newFileWrite.fileContent);
        if (!summary.summary.startsWith('Blocked write to ')) {
          const remaining = finalContent.replace(newFileWrite.fullMatch, '').trim();
          messages.push(this.createAssistantMessage(summary.summary + (remaining ? '\n\n' + this.truncateLongResponse(remaining) : ''), summary.revertOperationId ? [summary.revertOperationId] : []));
          return;
        }
        // Blocked — fall through to nudge layer
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
        if (!summary.summary.startsWith('Blocked write to ')) {
          messages.push(this.createAssistantMessage(summary.summary, summary.revertOperationId ? [summary.revertOperationId] : []));
          return;
        }
        // Blocked — fall through to nudge layer
      }

      const matchedActiveFile = this.matchResponseToActiveFile(finalContent);
      if (matchedActiveFile) {
        const writeApproved = await this.approveFileWrite([matchedActiveFile.filepath]);
        if (!writeApproved) {
          messages.push({ role: 'assistant', content: `[File write denied by user: ${matchedActiveFile.filepath}]` });
          return;
        }
        const summary = await this.writeFileWithDiff(matchedActiveFile.filepath, matchedActiveFile.fileContent);
        if (!summary.summary.startsWith('Blocked write to ')) {
          messages.push(this.createAssistantMessage(summary.summary, summary.revertOperationId ? [summary.revertOperationId] : []));
          return;
        }
        // Blocked — fall through to nudge layer
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

      if (this.isAgentLike) {
        // --- Fallback layer 6a: retry blocked writes ---
        // If a fallback layer tried to write a file but detectDestructiveWrite blocked it,
        // nudge the model to use replace_in_file instead of rewriting the whole file.
        const wasBlocked = /^Blocked write to /i.test(finalContent.trim());
        const blockedWriteNudgeCount = messages.filter(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('Your file write was blocked')).length;
        if (wasBlocked && blockedWriteNudgeCount < 2) {
          this.debugLog('blocked_write_retry', { retryCount, content: finalContent.substring(0, 200) });
          messages.push({ role: 'assistant', content: finalContent, hiddenFromTranscript: true });
          messages.push({
            role: 'user',
            content: 'Your file write was blocked because it would overwrite the file with partial content. ' +
              'Do NOT rewrite the entire file. Instead, use the replace_in_file tool to change ONLY the specific lines that need to change. ' +
              'First call read_specific_file to see the current content, then call replace_in_file with the exact old_text and new_text.',
            hiddenFromTranscript: true
          });
          this.postStatus('Blocked partial write — nudging model to use replace_in_file...');
          await this.processOllamaResponse(messages, retryCount);
          return;
        }

        // --- Fallback layer 6c: first-response plan display ---
        // If the model produces a structured plan as its very first response (no tools called yet
        // in this exchange), show it to the user then nudge it to start executing immediately.
        {
          const capabilityProfile = this.getModelCapabilityProfile();
          const lastVisibleUserIdxPlan = this.getLastVisibleUserMessageIndex(messages);
          const recentMsgsPlan = lastVisibleUserIdxPlan >= 0 ? messages.slice(lastVisibleUserIdxPlan) : messages;
          const hasAnyToolResultYet = recentMsgsPlan.some(m => m.role === 'tool');
          const looksLikePlan = !capabilityProfile.preferStepwiseExecution
            && !hasAnyToolResultYet
            && retryCount === 0
            && finalContent.length > 60
            && (
              /^\s*\d+\.\s+.{10,}/m.test(finalContent)         // numbered list item
              || /^\s*[-*]\s+.{10,}/m.test(finalContent)       // bullet list item
              || /(?:plan:|steps?:|крок\s*\d+|^step\s+\d+)/im.test(finalContent)
            );
          if (looksLikePlan) {
            // Show the plan to the user as a visible assistant message
            messages.push({ role: 'assistant', content: finalContent });
            this.postStateToWebview();
            messages.push({
              role: 'user',
              content: 'Plan noted. Now execute step 1 immediately with the appropriate tool call. Do not describe what you will do — actually call the tool.',
              hiddenFromTranscript: true
            });
            this.postStatus('Plan received — starting execution...');
            await this.processOllamaResponse(messages, 0);
            return;
          }
        }

        // --- Fallback layer 6b: nudge the model to use tools if it didn't ---
        // If tools were already used in the CURRENT exchange (after the last user message),
        // the model's text response is a legitimate summary — don't nudge it.
        // We only check messages after the last user message to avoid stale tool results
        // from previous exchanges disabling the nudge.
        const lastVisibleUserIdx = this.getLastVisibleUserMessageIndex(messages);
        const recentMessages = lastVisibleUserIdx >= 0 ? messages.slice(lastVisibleUserIdx) : messages;
        const hasRecentToolResults = recentMessages.some(m => m.role === 'tool');
        const recentToolMessages = recentMessages.filter((m): m is OllamaMessage & { role: 'tool' } => m.role === 'tool');
        const recentToolResults = recentToolMessages.map((message, index) => {
          try {
            const parsed = JSON.parse(message.content) as Record<string, unknown>;
            return { message, parsed, index };
          } catch {
            return { message, parsed: {} as Record<string, unknown>, index };
          }
        });
        const hasRecentMeaningfulWrite = recentToolResults.some(({ message, parsed }) => {
          if (parsed.error) {
            return false;
          }
          if (message.tool_name === 'replace_in_file') {
            // A replace where old and new are identical is a no-op; do not count it as meaningful.
            const diff = typeof parsed.diff === 'string' ? parsed.diff : '';
            const removedLines = Array.from(diff.matchAll(/^-(.+)$/gm)).map(m => m[1].trim());
            const addedLines = Array.from(diff.matchAll(/^\+(.+)$/gm)).map(m => m[1].trim());
            if (removedLines.length > 0 && removedLines.length === addedLines.length
              && removedLines.every((line, i) => line === addedLines[i])) {
              return false;
            }
            // In a large-refactor scenario, a trivial single-line rename without an import
            // replacement is not a meaningful extraction step — only real block extractions
            // (multi-line replaced by import, or import added) count.
            if (this.isLargeRefactorScenario()
              && removedLines.length <= 1 && addedLines.length <= 1
              && !addedLines.some(l => /^\s*import\b/.test(l))) {
              return false;
            }
            return true;
          }
          if (message.tool_name === 'write_to_file' || message.tool_name === 'delete_file') {
            return true;
          }
          if (message.tool_name !== 'create_or_edit_file') {
            return false;
          }
          return !isPlaceholderCreateResult(parsed);
        });
        const latestCreatedFilePath = (() => {
          for (let index = recentToolResults.length - 1; index >= 0; index -= 1) {
            const { message, parsed } = recentToolResults[index];
            if (parsed.error || message.tool_name !== 'create_or_edit_file' || isPlaceholderCreateResult(parsed)) {
              continue;
            }
            return typeof parsed.path === 'string' ? parsed.path : undefined;
          }
          return undefined;
        })();
        const lastSuccessfulActionIndex = (() => {
          for (let index = recentToolResults.length - 1; index >= 0; index -= 1) {
            const { message, parsed } = recentToolResults[index];
            if (parsed.error) {
              continue;
            }
            if (message.tool_name === 'execute_terminal_command') {
              const command = String(parsed.command ?? '');
              if (Number(parsed.exitCode ?? 0) === 0 && !isTerminalReadOnlyInspectionCommand(command)) {
                return index;
              }
              continue;
            }
            if (message.tool_name === 'write_to_file'
              || message.tool_name === 'replace_in_file'
              || message.tool_name === 'delete_file') {
              return index;
            }
            if (message.tool_name === 'create_or_edit_file' && !isPlaceholderCreateResult(parsed)) {
              return index;
            }
          }
          return -1;
        })();
        const hasRecentSuccessfulAction = recentToolResults.some(({ message, parsed }) => {
          if (parsed.error) {
            return false;
          }
          if (message.tool_name === 'execute_terminal_command') {
            return Number(parsed.exitCode ?? 0) === 0 && !isTerminalReadOnlyInspectionCommand(String(parsed.command ?? ''));
          }
          if (message.tool_name === 'create_or_edit_file') {
            return !isPlaceholderCreateResult(parsed);
          }
          return message.tool_name === 'write_to_file'
            || message.tool_name === 'replace_in_file'
            || message.tool_name === 'delete_file';
        });
        const recentToolErrors = recentToolResults
          .filter(({ index }) => index > lastSuccessfulActionIndex)
          .map(({ message, parsed }) => ({ toolName: message.tool_name ?? '', error: typeof parsed.error === 'string' ? parsed.error : '' }))
          .filter(item => item.error)
          // Don't count harmless "no active editor" as a real tool error
          .filter(item => !(item.toolName === 'read_active_file' && /no active/i.test(item.error)));
        const hasRecentToolErrors = recentToolErrors.length > 0;
        const latestBuildVerifyFailure = this.getLatestBuildVerifyFailure(recentToolResults);
        const hasRecentBuildVerifyFailure = Boolean(latestBuildVerifyFailure);
        const latestVisibleUserRequest = this.getLatestVisibleUserRequest(messages);
        const largeRefactorTargets = this.extractLikelyRequestFileTargets(latestVisibleUserRequest);
        const hasRecentReadOfLargeRefactorTarget = largeRefactorTargets.length > 0 && recentToolResults.some(({ message, parsed }) => {
          if (parsed.error) {
            return false;
          }
          if (message.tool_name !== 'read_active_file'
            && message.tool_name !== 'read_specific_file'
            && message.tool_name !== 'read_file_slice') {
            return false;
          }
          return toolResultMatchesAnyTargetPath(parsed.path, largeRefactorTargets);
        });
        const isLargeRefactorRequest = this.looksLikeLargeRefactorRequest(latestVisibleUserRequest);
        const latestLargeRefactorTargetRead = largeRefactorTargets.length > 0
          ? [...recentToolResults].reverse().find(({ message, parsed }) => {
            if (parsed.error) {
              return false;
            }
            if (message.tool_name !== 'read_active_file'
              && message.tool_name !== 'read_specific_file'
              && message.tool_name !== 'read_file_slice') {
              return false;
            }
            return toolResultMatchesAnyTargetPath(parsed.path, largeRefactorTargets);
          })
          : undefined;
        const latestLargeRefactorTargetTotalLines = Number(latestLargeRefactorTargetRead?.parsed.totalLines ?? 0);
        const latestLargeRefactorTargetEndLine = Number(latestLargeRefactorTargetRead?.parsed.endLine ?? 0);
        const latestLargeRefactorTargetStartLine = Number(latestLargeRefactorTargetRead?.parsed.startLine ?? 0);
        const latestLargeRefactorTargetRemainingLines = latestLargeRefactorTargetTotalLines > 0
          ? Math.max(0, latestLargeRefactorTargetTotalLines - latestLargeRefactorTargetEndLine)
          : Number.POSITIVE_INFINITY;
        const latestLargeRefactorTargetReachedEof = Boolean(
          latestLargeRefactorTargetRead
          && latestLargeRefactorTargetTotalLines > 0
          && latestLargeRefactorTargetStartLine > latestLargeRefactorTargetTotalLines
          && String(latestLargeRefactorTargetRead.parsed.content ?? '') === ''
        );
        const canStopAfterTinyLargeRefactor = Boolean(
          isLargeRefactorRequest
          && hasRecentMeaningfulWrite
          && hasRecentReadOfLargeRefactorTarget
          && latestLargeRefactorTargetTotalLines > 0
          && (latestLargeRefactorTargetTotalLines <= 40 || latestLargeRefactorTargetRemainingLines <= 8)
        );
        const replaceNotFoundContext = this.getLatestReplaceNotFoundContext(messages);
        const hasRecentReplaceNotFound = Boolean(replaceNotFoundContext);
        const replaceNotFoundFilepath = replaceNotFoundContext?.filepath;
        const replaceNotFoundStartLine = replaceNotFoundContext?.startLine;
        const replaceNotFoundEndLine = replaceNotFoundContext?.endLine;
        const replaceNeverPresentInTarget = replaceNotFoundContext?.neverPresentInTarget === true;

        // Detect when the latest user message is a greeting or short conversational text
        // that does not require tool execution — suppress action-forcing nudges in this case.
        const userMsgTrimmed = latestVisibleUserRequest.trim();
        const isConversationalUserMessage = (
          /^(?:привіт|вітаю|здоров|доброго дня|добрий день|добрий ранок|добрий вечір|як справи|як ти|що нового|hello|hi|hey|howdy|yo|hola|good morning|good evening|good afternoon|how are you|what'?s up|sup|greetings|thanks|thank you|дякую|спасибі)\b/i.test(userMsgTrimmed)
          || (userMsgTrimmed.length > 0 && userMsgTrimmed.length < 60
            && !/(?:[.\\/](?:ts|js|py|rs|go|c|cpp|h|java|rb|sh|json|yaml|yml|toml|md|html|css|vue|jsx|tsx)\b|\b(?:creat|edit|fix|refactor|chang|modif|updat|replac|delet|remov|build|compil|run|execut|install|implement|add|write|read|scan|check|review|debug|test|move|renam|split|merge|зроби|створи|виправ|зміни|додай|напиши|видали|перейменуй))/i.test(userMsgTrimmed)
            && !/```/.test(userMsgTrimmed))
        );

        const isLongDump = finalContent.length > 300;
        const hasLargeCodeBlocks = /```[\w]*\n[\s\S]{100,}?```/.test(finalContent);
        const claimsDone = /(?:зробив|замінив|оновив|готово|i've made|i have made|i have updated|i updated|i fixed|i removed|i verified|i confirmed|i corrected|i aligned|successfully applied|successfully saved|has been removed|has been moved|addressed the|fixed the|removed the|updated the|verified the|confirmed the|corrected the|aligned the|summary of the changes|summary:)/i.test(finalContent);
        const mentionsChange = /(?:змін|зроби|оновл|replac|chang|updat|modif|address|fix(?:ed)?|remov(?:e|ed)|verif(?:y|ied)|confirm(?:ed)?|correct(?:ed)?|align(?:ed)?)/i.test(finalContent);
        const isLazyAcknowledgment = !isConversationalUserMessage
          && (/^(?:understood|sure|ok|okay|got it|i will|let me know|i can help|i'll make sure)\b/i.test(finalContent.trim())
          || /no (?:immediate|obvious) (?:file changes|issues|errors|problems)/i.test(finalContent)
          || /further debugging (?:would be|is) needed/i.test(finalContent))
          && finalContent.trim().length < 500;
        // Detect model asking user to do things manually or announcing actions without executing them
        // NOTE: "let me know" is excluded — it's always a polite closing, not passing work to the user.
        const isPassingToUser = (/(?:please (?:execute|run|proceed|specify|provide|make sure|save|confirm)|you (?:may|can|should|need to) (?:run|execute|save|choose|pick)|choose one of the (?:options|approaches)|if the .{0,30} persists|let'?s (?:execute|run|try|start)|let me (?:execute|run|try|start)|do you have a specific (?:section|function|module)|which (?:section|function|module) (?:should|would) .{0,40}(?:focus|start)|please confirm if you would like|would you like me to (?:read|display|show|proceed)|shall i (?:read|display|proceed|continue))/i.test(finalContent))
          && finalContent.trim().length < 800;

        // Detect model announcing a step/action but not executing it (ends with colon or ellipsis)
        const endsWithoutAction = /(?::\s*|\.\.\.)\s*$/.test(finalContent.trim());
        const announcesToolAction = /(?:execute|run|start|install|create|update|modify|read|check|verify).*(?:command|script|file|terminal|npm|server)/i.test(finalContent);
        const hasExecutingStepAnnouncement = /\bexecut(?:e|ing)\s+step\s+\d+\b/i.test(finalContent);
        const hasCompletedStepAnnouncement = /\bstep\s+\d+\s+completed\b/i.test(finalContent);
        const mentionsConcreteNextFile = /(?:moving|extracting|splitting|writing|editing|creating)\s+.+\s+(?:to|into)\s+`?[\w./-]+`?/i.test(finalContent);
        const isAnnouncedButNotExecuted = (endsWithoutAction && announcesToolAction)
          || hasExecutingStepAnnouncement
          || (hasCompletedStepAnnouncement && mentionsConcreteNextFile);

        // Detect incomplete plan execution: model mentions "Step N/M" but hasn't reached the final step
        const stepMatch = finalContent.match(/step\s+(\d+)\s*[\/of]+\s*(\d+)/i);
        const announcedStepNumbers = Array.from(finalContent.matchAll(/\bstep\s+(\d+)\b/gi))
          .map((match: RegExpMatchArray) => parseInt(match[1], 10))
          .filter(Number.isFinite);
        const hasSequentialStepNarration = announcedStepNumbers.length >= 2
          && Math.max(...announcedStepNumbers) > Math.min(...announcedStepNumbers);
        const hasIncompletePlan = (stepMatch && parseInt(stepMatch[1], 10) < parseInt(stepMatch[2], 10))
          || (hasCompletedStepAnnouncement && hasSequentialStepNarration);
        const hasExplicitNextSteps = /next steps?:/i.test(finalContent) && /\n\s*(?:2|3|4|5)\.\s+/i.test(finalContent);
        const progressLines = finalContent
          .split('\n')
          .map((line: string) => line.trim())
          .filter(Boolean);
        const isProgressOnlyResponse = progressLines.length > 0
          && finalContent.trim().length < 220
          && progressLines.every((line: string) => /^(?:step\s+\d+\s*(?:\/|of)\s*\d+[:\s-].*|step\s+\d+\s+completed[:\s-].*|execut(?:e|ing)\s+step\s+\d+[:\s-].*|reading (?:the )?file first\.{0,3}|reading and modifying .+|i(?:'| a)?ll read the file.*|i apologize for the oversight\.?|sorry for the oversight\.?)$/i.test(line));
        const isTinyStepPlan = progressLines.length > 0
          && finalContent.trim().length < 120
          && progressLines.every((line: string) => /^(?:\d+\.\s+|[-*]\s+)?(?:create|set\s*up|setup|write|implement|generate|build|start|begin)\b/i.test(line));
        // Detect longer plan-only responses ("### Plan\n1. **Read**..." with no actual tool work)
        const isPlanOnlyResponse = !isTinyStepPlan
          && /^#{1,4}\s*plan\b/im.test(finalContent)
          && /^\s*\d+\.\s+\*\*/m.test(finalContent)
          && !hasRecentMeaningfulWrite;
        const hasInspectionOnlyToolLoop = hasRecentToolResults
          && !hasRecentSuccessfulAction
          && recentToolResults.every(({ message, parsed }) => {
            if (parsed.error) {
              return false;
            }

            if (message.tool_name === 'execute_terminal_command') {
              return isTerminalReadOnlyInspectionCommand(String(parsed.command ?? ''));
            }

            return message.tool_name === 'list_workspace_files'
              || message.tool_name === 'project_scan'
              || message.tool_name === 'read_active_file'
              || message.tool_name === 'read_specific_file'
              || message.tool_name === 'read_file_slice'
              || message.tool_name === 'read_workspace_notes';
          });

        const recentExecutedCommands = recentToolMessages
          .filter(message => message.tool_name === 'execute_terminal_command')
          .map(message => {
            try {
              const parsed = JSON.parse(message.content) as Record<string, unknown>;
              return String(parsed.command ?? '').toLowerCase();
            } catch {
              return '';
            }
          })
          .filter(Boolean);
        const claimedCommands = Array.from(finalContent.matchAll(/`([^`]+)`/g)).map((match: RegExpMatchArray) => match[1].trim().toLowerCase());
        const claimedButUnexecutedCommand = claimedCommands.some(command => {
          if (!/(?:^|\s)(?:npm|pnpm|yarn|bun|node|npx|python|pytest|pip|cargo|go|dotnet|gradle|mvn)\b/i.test(command)) {
            return false;
          }
          return !recentExecutedCommands.some(executed => executed.includes(command) || command.includes(executed));
        });

        const announcedNewFilePath = this.extractAnnouncedNewFilePath(finalContent);
        const suggestedNextSlice = this.suggestNextLargeRefactorSlice(recentToolResults, largeRefactorTargets);
        const latestSuccessfulReadContext = this.getLatestSuccessfulReadContext(recentToolResults, largeRefactorTargets);
        const latestSuccessfulCreateContext = this.getLatestSuccessfulCreateContext(messages, recentToolResults);
        const hasLargeRefactorShellReadBypass = Boolean(
          isLargeRefactorRequest
          && recentToolResults.some(({ message, parsed }) => message.tool_name === 'execute_terminal_command' && isTerminalReadOnlyInspectionCommand(String(parsed.command ?? '')))
        );
        const hasPreReadLargeRefactorNarration = Boolean(
          isLargeRefactorRequest
          && !hasRecentReadOfLargeRefactorTarget
          && /(?:specific section|specific function|focus on initially|please wait while i read|reading [`'\w./-]+ file|reading first slice of [`'\w./-]+|reading [`'\w./-]+\.{0,3}|analyzing [`'\w./-]+ file|inspect(?:ing)? the structure of [`'\w./-]+|reading project structure|listing workspace files in [`'\w./-]+|i will start by breaking down [`'\w./-]+|before proceeding with the refactor)/i.test(finalContent)
        );
        const hasFakePreReadCodeDump = Boolean(
          isLargeRefactorRequest
          && !hasRecentReadOfLargeRefactorTarget
          && (hasLargeCodeBlocks || isLongDump)
          && /(?:bounded lines|reading bounded lines|first\s+\d+\s+lines|content of [`'\w./-]+|here(?: is| are) the lines|analyzing [`'\w./-]+ file|placeholder for the actual code content|replace this with the actual content|"items"\s*:\s*\[|"content"\s*:\s*"|reading project structure|reading [`'\w./-]+\.{0,3})/i.test(finalContent)
        );
        const hasReadButNoWriteOnLargeRefactor = isLargeRefactorRequest
          && hasRecentReadOfLargeRefactorTarget
          && !hasRecentMeaningfulWrite;
        const hasModelRefusalResponse = Boolean(
          isLargeRefactorRequest
          && hasRecentReadOfLargeRefactorTarget
          && !hasRecentMeaningfulWrite
          && /(?:i(?:'m|\s+am) sorry,? but i (?:can(?:'t|not)|am unable to) (?:assist|help)|i(?:'m|\s+am) unable to (?:assist|help|proceed)|i (?:cannot|can't) (?:assist|help|process|complete) (?:with )?(?:that|this)|this (?:request|task) (?:violates?|contains?)|```json\s*\{[^}]*"response"\s*:\s*"[^"]*(?:sorry|unable|cannot|can't)[^"]*")/i.test(finalContent)
        );
        const hasFakePostReadAnalysisDump = Boolean(
          hasReadButNoWriteOnLargeRefactor
          && (isLongDump || hasLargeCodeBlocks)
          && /(?:```json\s*\{\s*"response"|"function_name"\s*:\s*"extract_code_snippet"|<tool_response>|\[tool_response\]|successfully processed the request|this code snippet appears to be|class, named `?(?:ollamaextension|ollamaassistant)`?|"class_name"\s*:\s*"(?:OllamaAssistant|OllamaExtension)"|here(?:'|’)s a breakdown of some key functionalities)/i.test(finalContent)
        );
        const hasAnnouncedExtractionWithoutWrite = Boolean(
          hasReadButNoWriteOnLargeRefactor
          && !hasRecentMeaningfulWrite
          && (announcedNewFilePath || /(?:extracting the identified bounded unit into a new module|now, replacing the extracted content|replacing the extracted content in [`'\w./-]+|create\s+(?:a\s+)?new\s+module)/i.test(finalContent))
        );
        const hasPostReadToolStall = Boolean(
          hasReadButNoWriteOnLargeRefactor
          && (isProgressOnlyResponse || isAnnouncedButNotExecuted || !!hasIncompletePlan || hasExplicitNextSteps || hasAnnouncedExtractionWithoutWrite)
        );
        const hasLazyRefusalOnLargeRefactor = Boolean(
          isLargeRefactorRequest
          && hasRecentReadOfLargeRefactorTarget
          && !hasRecentMeaningfulWrite
          && /(?:no changes? (?:are )?needed|no modification(?:s)? (?:are )?needed|already correctly formatted|looks? good as[ -]is|no adjustment(?:s)? needed|no updates? (?:are )?needed|this (?:looks|is) correct|nothing to change|does not require any modifications?|no (?:further )?(?:changes?|modifications?) (?:are )?(?:required|necessary))/i.test(finalContent)
        );
        // Model summarized or analyzed the read content without making any tool call.
        // This is distinct from hasPostReadToolStall (which detects progress text / step narration).
        const hasPostReadSummaryOnLargeRefactor = Boolean(
          hasReadButNoWriteOnLargeRefactor
          && !hasPostReadToolStall
          && !hasFakePostReadAnalysisDump
          && !hasLazyRefusalOnLargeRefactor
          && !hasModelRefusalResponse
          && (isLongDump || isLazyAcknowledgment || (claimsDone && !mentionsChange))
        );
        const isAskingUserForExactSlice = Boolean(
          isLargeRefactorRequest
          && /(?:please provide|provide) (?:the )?(?:exact startline and endline|first\s+\d+\s+lines|next\s+\d+\s+lines|lines?\s+\d+\s*(?:to|-)+\s*\d+|bounded slice)|exact startline and endline|bounded slice you would like to extract|replace this with the actual content/i.test(finalContent)
        );
        const hasPostCreateRefactorNarration = Boolean(
          isLargeRefactorRequest
          && latestCreatedFilePath
          && hasRecentMeaningfulWrite
          && /(?:update|import|moving more|move more|refactor(?:ing)? methods|use imported types|created and populated)/i.test(finalContent)
        );
        const maxNudgeRetries = Math.min(
          this.getModelCapabilityProfile().maxNudgeRetriesCap,
          hasRecentReplaceNotFound
            ? 3
            : (hasPreReadLargeRefactorNarration || hasFakePreReadCodeDump || hasLargeRefactorShellReadBypass || (isLargeRefactorRequest && !hasRecentReadOfLargeRefactorTarget))
              ? 4
              : isAskingUserForExactSlice
                ? 5
                : hasFakePostReadAnalysisDump || hasAnnouncedExtractionWithoutWrite || hasReadButNoWriteOnLargeRefactor || hasLazyRefusalOnLargeRefactor || hasModelRefusalResponse || hasPostReadSummaryOnLargeRefactor
                  ? 4
                  : (!hasRecentSuccessfulAction && !hasRecentMeaningfulWrite && hasRecentToolResults)
                    ? 4
                    : 2
        );
        const requiresToolContinuation = (
          isPassingToUser
          || isAnnouncedButNotExecuted
          || !!hasIncompletePlan
          || hasExplicitNextSteps
          || isProgressOnlyResponse
          || (hasInspectionOnlyToolLoop && isTinyStepPlan)
          || (hasInspectionOnlyToolLoop && isPlanOnlyResponse)
          || claimedButUnexecutedCommand
          || hasLargeRefactorShellReadBypass
          || hasPreReadLargeRefactorNarration
          || hasFakePreReadCodeDump
          || isAskingUserForExactSlice
          || hasFakePostReadAnalysisDump
          || hasAnnouncedExtractionWithoutWrite
          || hasPostReadSummaryOnLargeRefactor
          || hasModelRefusalResponse
          || hasLazyRefusalOnLargeRefactor
          || (hasPostCreateRefactorNarration && !canStopAfterTinyLargeRefactor)
          || (hasRecentBuildVerifyFailure && (claimsDone || mentionsChange || isLazyAcknowledgment || hasIncompletePlan || hasExplicitNextSteps || isProgressOnlyResponse || isPassingToUser))
          || (isLargeRefactorRequest && hasRecentToolResults && (!hasRecentSuccessfulAction || !hasRecentReadOfLargeRefactorTarget || !hasRecentMeaningfulWrite))
          || (hasRecentReplaceNotFound && (mentionsChange || claimsDone || isLazyAcknowledgment || hasIncompletePlan || hasExplicitNextSteps || isPassingToUser || isProgressOnlyResponse))
          || (hasRecentToolErrors && (claimsDone || mentionsChange || isLazyAcknowledgment || hasIncompletePlan || hasExplicitNextSteps || isProgressOnlyResponse))
          || (!hasRecentSuccessfulAction && (isLongDump || hasLargeCodeBlocks || claimsDone || mentionsChange || isLazyAcknowledgment))
        );

        // Detect identical verbatim responses — model is stuck in a loop
        const contentTrimmed = finalContent.trim();
        if (contentTrimmed && contentTrimmed === this.lastNudgedResponseContent) {
          this.consecutiveIdenticalResponses++;
        } else {
          this.consecutiveIdenticalResponses = 0;
        }
        this.lastNudgedResponseContent = contentTrimmed;

        // If model has repeated the exact same response 2+ times, cap retries to break the loop
        const effectiveMaxNudgeRetries = this.consecutiveIdenticalResponses >= 2
          ? Math.min(maxNudgeRetries, retryCount) // immediately stop
          : this.consecutiveIdenticalResponses >= 1
            ? Math.min(maxNudgeRetries, retryCount + 1) // one more chance with escalated nudge
            : maxNudgeRetries;

        const shouldNudge = requiresToolContinuation
          && !canStopAfterTinyLargeRefactor
          // When the user's latest message is conversational (greeting, small talk)
          // and no tools were called in this exchange, accept the model's text response
          // as-is — do not push it to execute stale tasks from earlier context.
          && !(isConversationalUserMessage && !hasRecentToolResults)
          && retryCount < effectiveMaxNudgeRetries;
        if (isConversationalUserMessage && requiresToolContinuation && !shouldNudge) {
          this.debugLog('conversational_nudge_bypass', {
            userMessage: userMsgTrimmed.substring(0, 80),
            requiresToolContinuation,
            hasRecentToolResults,
            isLazyAcknowledgment,
            contentPreview: finalContent.substring(0, 200)
          });
        }
        const shouldAutoBootstrapLargeRefactorRead = Boolean(
          shouldNudge
          && retryCount >= 1
          && isLargeRefactorRequest
          && !hasRecentReadOfLargeRefactorTarget
          && (hasPreReadLargeRefactorNarration || isProgressOnlyResponse || isAnnouncedButNotExecuted || !!hasIncompletePlan)
        );

        if (shouldAutoBootstrapLargeRefactorRead) {
          const preferredTargetPath = await this.findPreferredLargeRefactorTargetPath(latestVisibleUserRequest);
          if (preferredTargetPath) {
            this.debugLog('auto_bootstrap_large_refactor_read', {
              retryCount,
              targetPath: preferredTargetPath,
              reason: {
                hasPreReadLargeRefactorNarration,
                isProgressOnlyResponse,
                isAnnouncedButNotExecuted,
                hasIncompletePlan: !!hasIncompletePlan
              }
            });
            this.postProgressStep(`Reading lines 1-120 of ${path.basename(preferredTargetPath)}`);
            const toolResult = await this.readFileSlice(preferredTargetPath, 1, 120);
            this.debugLog('tool_exec_result', { tool: 'read_file_slice', result: toolResult.substring(0, 500), synthetic: true });
            messages.push({
              role: 'assistant',
              content: finalContent,
              hiddenFromTranscript: true
            });
            messages.push({
              role: 'tool',
              content: toolResult,
              tool_name: 'read_file_slice',
              hiddenFromTranscript: true,
              revertOperationIds: this.extractToolResultRevertOperationIds(toolResult)
            });
            await this.processOllamaResponse(messages, 0);
            return;
          }
        }

        const bootstrapCandidate = inferRepeatedNarratedBootstrapToolCall({
          content: finalContent,
          isLargeRefactorRequest,
          hasRecentReadOfLargeRefactorTarget,
          hasRecentMeaningfulWrite,
          hasReadButNoWriteOnLargeRefactor,
          hasPostCreateRefactorNarration,
          isAnnouncedButNotExecuted,
          isProgressOnlyResponse,
          hasIncompletePlan: !!hasIncompletePlan,
          hasExplicitNextSteps,
          claimsDone,
          mentionsChange,
          largeRefactorTargets,
          suggestedNextSlice,
          latestRead: latestSuccessfulReadContext,
          latestCreate: latestSuccessfulCreateContext
        });
        const bootstrapCandidateCount = this.recordNarratedBootstrapSignature(bootstrapCandidate?.signature);

        if (bootstrapCandidate) {
          this.debugLog('bootstrap_candidate', {
            retryCount,
            reason: bootstrapCandidate.reason,
            signature: bootstrapCandidate.signature,
            count: bootstrapCandidateCount,
            tool: bootstrapCandidate.toolCall.function?.name
          });
        }

        if (bootstrapCandidate && bootstrapCandidateCount >= 2) {
          this.debugLog('bootstrap_tool_call', {
            retryCount,
            reason: bootstrapCandidate.reason,
            signature: bootstrapCandidate.signature,
            tool: bootstrapCandidate.toolCall.function?.name
          });
          const didExecuteBootstrap = await this.executeSyntheticBootstrapToolCall(messages, finalContent, bootstrapCandidate.toolCall);
          if (didExecuteBootstrap) {
            return;
          }
        }

        if (shouldNudge) {
          this.debugLog('nudge', { retryCount, isConversationalUserMessage, hasRecentToolResults, hasRecentSuccessfulAction, hasRecentMeaningfulWrite, latestCreatedFilePath, hasRecentReadOfLargeRefactorTarget, latestLargeRefactorTargetTotalLines, latestLargeRefactorTargetRemainingLines, canStopAfterTinyLargeRefactor, hasLargeRefactorShellReadBypass, hasPreReadLargeRefactorNarration, hasFakePreReadCodeDump, hasFakePostReadAnalysisDump, hasPostReadSummaryOnLargeRefactor, hasModelRefusalResponse, hasAnnouncedExtractionWithoutWrite, hasLazyRefusalOnLargeRefactor, isAskingUserForExactSlice, suggestedNextSlice, hasReadButNoWriteOnLargeRefactor, hasPostReadToolStall, hasPostCreateRefactorNarration, announcedNewFilePath, hasRecentToolErrors, hasRecentBuildVerifyFailure, hasRecentReplaceNotFound, replaceNotFoundFilepath, replaceNotFoundStartLine, replaceNotFoundEndLine, lastSuccessfulActionIndex, isLongDump, hasLargeCodeBlocks, claimsDone, mentionsChange, isLazyAcknowledgment, hasIncompletePlan: !!hasIncompletePlan, hasExplicitNextSteps, isProgressOnlyResponse, claimedButUnexecutedCommand, isPassingToUser, isAnnouncedButNotExecuted, isPlanOnlyResponse, isLargeRefactorRequest, contentPreview: finalContent.substring(0, 200) });
          // Show plan/progress text to the user before nudging
          if (!isProgressOnlyResponse
            && !hasFakePreReadCodeDump
            && !hasPreReadLargeRefactorNarration
            && !isAskingUserForExactSlice
            && !(isLargeRefactorRequest && !hasRecentSuccessfulAction && (isLongDump || hasLargeCodeBlocks))
            && (hasIncompletePlan || hasExplicitNextSteps || isTinyStepPlan || claimedButUnexecutedCommand || claimsDone || mentionsChange || isPassingToUser || isAnnouncedButNotExecuted)) {
            const planText = finalContent.trim();
            if (planText) {
              messages.push({ role: 'assistant', content: planText });
              this.postStateToWebview();
            }
          }

          messages.push({
            role: 'assistant',
            content: finalContent,
            hiddenFromTranscript: true
          });
          
          let nudgeMessage = '';
          if (hasLargeRefactorShellReadBypass) {
            const primaryTarget = largeRefactorTargets[0] ?? 'the target file';
            nudgeMessage = `This is a large refactor request for ${primaryTarget}. Do NOT use execute_terminal_command for file inspection commands like cat, head, tail, sed, or ls. Use file tools only. Your next response must call read_file_slice for ${primaryTarget} with startLine=1 and endLine=120, or use the next suggested bounded slice if you already have one.`;
          } else if (isAskingUserForExactSlice) {
            const primaryTarget = largeRefactorTargets[0] ?? 'the target file';
            if (suggestedNextSlice?.filepath && suggestedNextSlice.startLine && suggestedNextSlice.endLine) {
              nudgeMessage = `This is a large refactor request for ${primaryTarget}. Do NOT ask the user to provide file lines, content, or exact startLine and endLine. Choose the next bounded slice yourself. Your next response must call read_file_slice for ${suggestedNextSlice.filepath} with startLine=${suggestedNextSlice.startLine} and endLine=${suggestedNextSlice.endLine}. After that, continue with one small extraction step from that slice.`;
            } else {
              nudgeMessage = `This is a large refactor request for ${primaryTarget}. Do NOT ask the user to provide file lines, content, or exact startLine and endLine. Choose the next bounded slice yourself and call read_file_slice now. Start with startLine=1 and endLine=120 if you have no better slice yet.`;
            }
          } else if (hasFakePreReadCodeDump) {
            const primaryTarget = largeRefactorTargets[0] ?? 'the target file';
            nudgeMessage = `This is a large refactor request for ${primaryTarget}. Do NOT paste guessed or remembered code blocks, JSON project structure dumps, or placeholder snippets, and do NOT claim that you already read bounded lines without a tool call. Your next response must call read_file_slice immediately for ${primaryTarget} with startLine=1 and endLine=120. Use the actual tool result, not a pasted snippet.`;
          } else if (hasPreReadLargeRefactorNarration) {
            const primaryTarget = largeRefactorTargets[0] ?? 'the target file';
            nudgeMessage = `This is a large refactor request for ${primaryTarget}. Do NOT ask the user which section to start with, and do NOT say that you will read the file later. Your next response must call read_file_slice immediately for ${primaryTarget} with startLine=1 and endLine=120. After that, continue with the next bounded slice or the next small extraction step.`;
          } else if (hasPostReadSummaryOnLargeRefactor) {
            const primaryTarget = largeRefactorTargets[0] ?? 'the target file';
            const suggestedNewFile = path.join(path.dirname(primaryTarget), 'types.ts').replace(/\\/g, '/');
            nudgeMessage = suggestedNextSlice?.filepath && suggestedNextSlice.startLine && suggestedNextSlice.endLine
              ? `STOP summarizing. You are performing file-splitting: extracting code from ${primaryTarget} into NEW separate files. Summarizing what you read is WRONG. You must NOW call create_or_edit_file. Example: create a new sibling file at ${suggestedNewFile} (or similar) containing the interfaces and types from the slice you just read. Then call replace_in_file on ${primaryTarget} with old_text=the exact extracted block and new_text=an import statement like "import { InterfaceName } from './types';". IMPORTANT: old_text and new_text must be DIFFERENT — never pass the same text to both. If you need more of the file first, call read_file_slice for ${suggestedNextSlice.filepath} with startLine=${suggestedNextSlice.startLine} and endLine=${suggestedNextSlice.endLine}. No prose. Tool calls only.`
              : `STOP summarizing. You are performing file-splitting: extracting code from ${primaryTarget} into NEW separate files. Summarizing what you read is WRONG. You must NOW call create_or_edit_file. Create a new sibling file at ${suggestedNewFile} containing the interfaces and types from the slice you just read. Then call replace_in_file on ${primaryTarget} with old_text=the exact extracted code block and new_text=an import statement. IMPORTANT: old_text and new_text must be DIFFERENT. No prose. Tool calls only.`;
          } else if (hasModelRefusalResponse) {
            const primaryTarget = largeRefactorTargets[0] ?? 'the target file';
            nudgeMessage = suggestedNextSlice?.filepath && suggestedNextSlice.startLine && suggestedNextSlice.endLine
              ? `You are performing a REFACTOR task: splitting ${primaryTarget} into smaller modules. You responded with a refusal ("I'm sorry, but I can't assist") which is incorrect — this is a legitimate code refactoring request. Do NOT read the entire file at once. ONLY read small bounded sections using read_file_slice. Your next response must call read_file_slice for ${suggestedNextSlice.filepath} with startLine=${suggestedNextSlice.startLine} and endLine=${suggestedNextSlice.endLine}. Then immediately call create_or_edit_file to extract one self-contained group into a new module, and call replace_in_file on ${primaryTarget} to remove it. No prose. Tool calls only.`
              : `You are performing a REFACTOR task: splitting ${primaryTarget} into smaller modules. You responded with a refusal ("I'm sorry, but I can't assist") which is incorrect — this is a legitimate code refactoring request. Do NOT read the entire file at once. ONLY use read_file_slice with bounded line ranges. Your next response must call read_file_slice for ${primaryTarget} with startLine=1 and endLine=120. Then call create_or_edit_file to extract one self-contained group and call replace_in_file on ${primaryTarget}. No prose. Tool calls only.`;
          } else if (hasFakePostReadAnalysisDump) {
            const primaryTarget = largeRefactorTargets[0] ?? 'the target file';
            nudgeMessage = announcedNewFilePath
              ? `This is a large refactor request for ${primaryTarget}. You already read the real file. Do NOT output generic summaries, fake JSON tool responses, invented class descriptions, or code-analysis dumps. Your next response must be tool calls only. First call create_or_edit_file for ${announcedNewFilePath} with one real self-contained type, interface group, or function from the bounded slices you actually read. Then call replace_in_file on ${primaryTarget} to remove the moved block and add any needed import. No prose before the tool calls.`
              : `This is a large refactor request for ${primaryTarget}. You already read the real file. Do NOT output generic summaries, fake JSON tool responses, invented class descriptions, or code-analysis dumps. Your next response must be tool calls only. Either call create_or_edit_file now for one concrete self-contained type, interface group, or function from the slices you already read and then call replace_in_file on ${primaryTarget}, or call read_file_slice for the next suggested bounded slice. No prose before the tool calls.`;
          } else if (hasLazyRefusalOnLargeRefactor) {
            const primaryTarget = largeRefactorTargets[0] ?? 'the target file';
            nudgeMessage = suggestedNextSlice?.filepath && suggestedNextSlice.startLine && suggestedNextSlice.endLine
              ? `You are performing a REFACTOR task: splitting ${primaryTarget} into smaller modules. You are NOT reviewing code quality or checking whether the file needs formatting fixes. "No changes needed" is the wrong answer for a refactor task. The code you just read is the SOURCE to EXTRACT content from. You MUST call create_or_edit_file to create a new file containing one self-contained group of types, interfaces, or functions from the source. Then call replace_in_file on ${primaryTarget} to remove the extracted block and add an import. If you need more context first, call read_file_slice for ${suggestedNextSlice.filepath} with startLine=${suggestedNextSlice.startLine} and endLine=${suggestedNextSlice.endLine}. Do NOT call list_workspace_files. No prose before the tool calls.`
              : `You are performing a REFACTOR task: splitting ${primaryTarget} into smaller modules. You are NOT reviewing code quality or checking whether the file needs formatting fixes. "No changes needed" is the wrong answer for a refactor task. The code you just read is the SOURCE to EXTRACT content from. You MUST call create_or_edit_file to create a new file containing one self-contained group of types, interfaces, or functions from the source. Then call replace_in_file on ${primaryTarget} to remove the extracted block and add an import. Do NOT call list_workspace_files. No prose before the tool calls.`;
          } else if (hasAnnouncedExtractionWithoutWrite) {
            const primaryTarget = largeRefactorTargets[0] ?? 'the target file';
            nudgeMessage = announcedNewFilePath
              ? `This is a large refactor request for ${primaryTarget}. You already announced an extraction to ${announcedNewFilePath} but did not execute any file tool. Do NOT narrate the extraction. Your next response must be tool calls only: first call create_or_edit_file for ${announcedNewFilePath} with the exact bounded block you are moving, then call replace_in_file on ${primaryTarget} to remove that block and add any import. No prose before the tool calls.`
              : `This is a large refactor request for ${primaryTarget}. You announced an extraction but did not execute any file tool. Do NOT narrate the extraction. Your next response must be tool calls only: first call create_or_edit_file for the new module path you identified, then call replace_in_file on ${primaryTarget} to remove the moved block and add any import. No prose before the tool calls.`;
          } else if (hasPostReadToolStall) {
            const primaryTarget = largeRefactorTargets[0] ?? 'the target file';
            if (suggestedNextSlice?.filepath && suggestedNextSlice.startLine && suggestedNextSlice.endLine) {
              nudgeMessage = announcedNewFilePath
                ? `This is a large refactor request for ${primaryTarget}. You already read a bounded slice and then stalled in progress text. Do NOT print another step summary. Your next response must be tool calls only. First call create_or_edit_file for ${announcedNewFilePath} using only the next self-contained function, type group, or interface block supported by the slices you already read. Then call replace_in_file on ${primaryTarget} to remove that moved block and add any needed import. If the current slice is still insufficient, call read_file_slice for ${suggestedNextSlice.filepath} with startLine=${suggestedNextSlice.startLine} and endLine=${suggestedNextSlice.endLine}. No prose before the tool call.`
                : `This is a large refactor request for ${primaryTarget}. You already read a bounded slice and then stalled in progress text. Do NOT print another step summary. Your next response must be a tool call, not prose. If you can already extract a self-contained function, type group, or interface block from the current slice, call create_or_edit_file now and then call replace_in_file on ${primaryTarget}. Otherwise call read_file_slice for ${suggestedNextSlice.filepath} with startLine=${suggestedNextSlice.startLine} and endLine=${suggestedNextSlice.endLine}. No prose before the tool call.`;
            } else {
              nudgeMessage = announcedNewFilePath
                ? `This is a large refactor request for ${primaryTarget}. You already read a bounded slice and then stalled in progress text. Do NOT print another step summary. Your next response must be tool calls only. First call create_or_edit_file for ${announcedNewFilePath} using only the next self-contained function, type group, or interface block from the slice you already read. Then call replace_in_file on ${primaryTarget} to remove that moved block and add any needed import. No prose before the tool call.`
                : `This is a large refactor request for ${primaryTarget}. You already read a bounded slice and then stalled in progress text. Do NOT print another step summary. Your next response must be a tool call, not prose. Either call create_or_edit_file now for one concrete self-contained extraction from the current slice and then call replace_in_file on ${primaryTarget}, or call read_file_slice for the next bounded slice with explicit startLine and endLine. No prose before the tool call.`;
            }
          } else if (hasReadButNoWriteOnLargeRefactor) {
            const primaryTarget = largeRefactorTargets[0] ?? 'the target file';
            nudgeMessage = announcedNewFilePath
              ? `This is a large refactor request for ${primaryTarget}. You already identified a concrete extraction target. Do NOT summarize again. Work in very small consecutive edits. Your next response must call tools now: first call create_or_edit_file for ${announcedNewFilePath} with only the next self-contained function, type group, or interface block from the current bounded slice. Do NOT include incomplete blocks or references like vscode.Uri unless you also add the required import. Then call replace_in_file on ${primaryTarget} to remove the moved block and add the import if needed. After that, continue with the next small extraction step in the same task instead of stopping. If you truly need more context before writing, ${suggestedNextSlice?.filepath && suggestedNextSlice.startLine && suggestedNextSlice.endLine ? `call read_file_slice for ${suggestedNextSlice.filepath} with startLine=${suggestedNextSlice.startLine} and endLine=${suggestedNextSlice.endLine}` : `call read_file_slice on ${primaryTarget} with explicit startLine and endLine for just the next bounded slice`}.`
              : `This is a large refactor request for ${primaryTarget}. You already read part of the target file. Do NOT summarize it again, do NOT ask the user for a bounded section, and do NOT ask to read the full file without a tool call. Your next response must call a tool. Either: (1) call create_or_edit_file to extract one concrete bounded unit you already identified into a new module, using only the next self-contained function, type group, or interface block from the current slice; then call replace_in_file on ${primaryTarget}; or (2) if you truly need more context, ${suggestedNextSlice?.filepath && suggestedNextSlice.startLine && suggestedNextSlice.endLine ? `call read_file_slice for ${suggestedNextSlice.filepath} with startLine=${suggestedNextSlice.startLine} and endLine=${suggestedNextSlice.endLine}` : `call read_file_slice on ${primaryTarget} with explicit startLine and endLine for the next bounded slice`}. Keep going in small consecutive steps until the task is complete.`;
          } else if (hasPostCreateRefactorNarration) {
            const primaryTarget = largeRefactorTargets[0] ?? 'the target file';
            const createdFileLabel = latestCreatedFilePath ? path.basename(latestCreatedFilePath) : 'the new file';
            nudgeMessage = `You already created ${createdFileLabel}. Do NOT keep planning or narrating the next steps. Your next response must call a tool. First fix ${createdFileLabel} with create_or_edit_file if its content is incomplete or references unknown imports. Otherwise call replace_in_file on ${primaryTarget} now to remove only the moved block and add the import from ${createdFileLabel}. After that, continue with the next small function-level or block-level extraction in the same task. Do not try to move the whole file at once.`;
          } else if (hasIncompletePlan) {
            nudgeMessage = stepMatch
              ? `You are on step ${stepMatch[1]} of ${stepMatch[2]} but stopped. Continue executing your plan in small consecutive edits. Proceed to the next step now with tools, and keep going function-by-function or block-by-block instead of stopping after a single step.`
              : 'You reported that one step was completed and announced the next step, but you stopped before executing it. Continue now by calling the next tool instead of narrating the plan. Keep the next change small and self-contained.';
          } else if (hasInspectionOnlyToolLoop && (isTinyStepPlan || isPlanOnlyResponse)) {
            nudgeMessage = 'You already inspected the workspace and read notes. STOP PLANNING. Do NOT call read_workspace_notes or list_workspace_files again. Your next response MUST be a create_or_edit_file tool call with a concrete file path and the complete implementation code. No prose, no plan, no step list — only a tool call.';
          } else if (isLargeRefactorRequest) {
            const primaryTarget = largeRefactorTargets[0];
            if (primaryTarget && !hasRecentReadOfLargeRefactorTarget) {
              nudgeMessage = `This is a large refactor request for ${primaryTarget}. You have not read the main target file yet. First call read_file_slice for ${primaryTarget} to inspect a bounded section of the real file content. Do NOT create placeholder files, do NOT switch to README.md or any other unrelated file, and do NOT stop at a plan. After reading ${primaryTarget}, execute one concrete small extraction or replace step with tools, then continue with the next small step.`;
            } else if (!hasRecentMeaningfulWrite) {
              nudgeMessage = primaryTarget
                ? `This is a large refactor request for ${primaryTarget}. A placeholder file or plan is not enough progress. Do not stop after scaffolding and do not inspect or edit unrelated files such as README.md. Keep working on ${primaryTarget}: read the real source file and then perform one concrete small extraction or replace step with tools before responding. Continue function-by-function or block-by-block.`
                : 'This is a large refactor request. A placeholder file or plan is not enough progress. Do not stop after scaffolding. Read the real source file, then perform one concrete small extraction or replace step with tools before responding. Continue in small blocks.';
            } else {
              nudgeMessage = primaryTarget
                ? `This is a large refactor request for ${primaryTarget}. Do not summarize the whole file or stop after inspection. Do not switch to unrelated files like README.md. A long plan is acceptable, but execute the refactor in many small consecutive tool calls: function-by-function, type-by-type, or one small block at a time. Prefer read_file_slice for bounded reads on large files, and keep going until the whole task is done or you are genuinely blocked.`
                : 'This is a large refactor request. Do not summarize the whole file or stop after inspection. A long plan is acceptable, but execute the refactor in many small consecutive tool calls. Prefer read_file_slice for bounded reads on large files, and keep going until the whole task is done or you are genuinely blocked.';
            }
          } else if (hasExplicitNextSteps) {
            nudgeMessage = 'You listed next steps but stopped before executing them. Continue now. Do not stop after the first step or the first issue — keep using tools until the scan is complete.';
          } else if (hasRecentReplaceNotFound) {
            nudgeMessage = replaceNeverPresentInTarget
              ? (replaceNotFoundFilepath && replaceNotFoundStartLine && replaceNotFoundEndLine
                ? `Your replace_in_file call failed because the block you tried to replace does not appear anywhere in ${replaceNotFoundFilepath}. Do NOT invent old_text and do NOT copy code from the new helper/module file. First call read_file_slice for ${replaceNotFoundFilepath} with startLine=${replaceNotFoundStartLine} and endLine=${replaceNotFoundEndLine}. Then call replace_in_file again using only exact text that currently exists in the target file.`
                : `Your replace_in_file call failed because the block you tried to replace does not appear anywhere in the real target file.${replaceNotFoundFilepath ? ` First call read_file_slice for ${replaceNotFoundFilepath} with a bounded line range containing the real target block.` : ' First call read_file_slice for the target file with a bounded line range.'} Do NOT invent old_text and do NOT copy code from a newly created file. Re-read the real file, then retry replace_in_file using only exact current text from that file.`)
              : (replaceNotFoundFilepath && replaceNotFoundStartLine && replaceNotFoundEndLine
                ? `Your replace_in_file call failed because old_text did not match the real file content. First call read_file_slice for ${replaceNotFoundFilepath} with startLine=${replaceNotFoundStartLine} and endLine=${replaceNotFoundEndLine}. Do NOT guess. Then call replace_in_file again using the exact current text including whitespace.`
                : `Your replace_in_file call failed because old_text did not match the real file content.${replaceNotFoundFilepath ? ` First call read_file_slice for ${replaceNotFoundFilepath} with startLine=1 and endLine=120 (or the section containing your target text).` : ' First call read_file_slice for that file with a bounded line range containing the section you want to edit.'} Do NOT guess. Do NOT ask the user to confirm. Read the slice now, then call replace_in_file again using the exact current text including whitespace and indentation.`);
          } else if (hasRecentBuildVerifyFailure && latestBuildVerifyFailure) {
            nudgeMessage = buildBuildVerifyFailureNudge(latestBuildVerifyFailure.stack, latestBuildVerifyFailure.result);
          } else if (hasRecentToolErrors) {
            const lastErr = recentToolErrors[recentToolErrors.length - 1];
            nudgeMessage = lastErr?.error
              ? `Your last tool call (${lastErr.toolName}) failed with: "${lastErr.error.substring(0, 300)}". Do NOT repeat the same call or describe a plan. Adapt: if a file was not found, call list_workspace_files first to locate it; if a path is wrong, verify with list_workspace_files. Then retry with corrected parameters.`
              : 'Your last tool call failed. Do NOT describe a plan or repeat the same call. Adapt your approach: use list_workspace_files to verify the file structure, then retry with correct parameters.';
          } else if (isProgressOnlyResponse) {
            nudgeMessage = 'Do not print progress updates like "Step 3/3" without taking action. Call a tool now. If you need the current file content, use read_specific_file first, then continue with replace_in_file or another appropriate tool.';
          } else if (claimedButUnexecutedCommand) {
            nudgeMessage = 'You claimed that a command or action was completed, but there is no matching tool execution in this exchange. Do not claim completion without actually running the command. Execute it now with execute_terminal_command or continue the remaining scan steps.';
          } else if (isAnnouncedButNotExecuted) {
            nudgeMessage = hasRecentMeaningfulWrite
              ? 'You announced an action but did not execute it. Do not describe what you will do — actually do it now by calling the appropriate tool. Use execute_terminal_command for commands or replace_in_file for edits.'
              : 'You announced an action but did not execute it. Do NOT plan or describe — call create_or_edit_file now with a concrete file path and the complete implementation code. Do not call read_workspace_notes again.';
          } else if (isPassingToUser) {
            nudgeMessage = 'Do not ask the user to run commands or make changes manually. You have tools available. Use execute_terminal_command to run commands and replace_in_file or create_or_edit_file to edit files. Do it yourself now.';
          } else if (isLazyAcknowledgment) {
            nudgeMessage = 'Do not just acknowledge the request. Actually perform the task now. Read the relevant files and make the changes the user asked for. Use the provided tools.';
          } else if (isLongDump || hasLargeCodeBlocks) {
            nudgeMessage = 'You returned code or a large file dump without using a tool. If you need to inspect or modify files, call one of the provided tools directly. If no tool is needed, answer briefly without dumping full file contents.';
          } else {
            nudgeMessage = 'You described changes but did not call a tool. If you need to modify files, use one of the provided tools. If no file change is needed, answer normally.';
          }

          const narratedBootstrapWarning = bootstrapCandidate && bootstrapCandidateCount === 1
            ? `\nIf you describe the same tool call in plain text again instead of executing it, the system will auto-bootstrap ${bootstrapCandidate.toolCall.function?.name}.`
            : '';

          // Escalate nudge when model is repeating the exact same response verbatim
          if (this.consecutiveIdenticalResponses >= 1) {
            nudgeMessage = `CRITICAL: You have produced the EXACT SAME response ${this.consecutiveIdenticalResponses + 1} times in a row. Your current approach is not working. You MUST change strategy completely. Do NOT repeat this response again. ` + nudgeMessage;
            this.debugLog('identical_response_escalation', { consecutiveIdenticalResponses: this.consecutiveIdenticalResponses, retryCount });
          }

          messages.push({
            role: 'user',
            content: `${nudgeMessage}${narratedBootstrapWarning}`,
            hiddenFromTranscript: true
          });
          this.postStatus(`Model did not use tools (attempt ${retryCount + 1}) — continuing...`);
          await this.processOllamaResponse(messages, retryCount + 1);
          return;
        }

        // --- Last-ditch code block extraction before giving up ---
        // If all nudges failed but the model dumped code blocks in any recent assistant response,
        // try extracting and creating files from those blocks synthetically.
        if (requiresToolContinuation && retryCount >= effectiveMaxNudgeRetries && !hasRecentMeaningfulWrite) {
          // Scan all recent assistant messages (including hidden ones) for extractable code blocks
          const recentAssistantContents = recentMessages
            .filter(m => m.role === 'assistant' && typeof m.content === 'string')
            .map(m => m.content as string);
          let didExtract = false;
          for (const assistantContent of recentAssistantContents) {
            // Try code block file writes (layer 2 patterns)
            const codeBlockWrites = this.extractCodeBlockFileWrites(assistantContent);
            if (codeBlockWrites.length > 0) {
              this.debugLog('last_ditch_code_block_extraction', { files: codeBlockWrites.map(b => b.filepath), source: 'code_block_file_writes' });
              for (const block of codeBlockWrites) {
                const writeApproved = this.autoApprove || await this.approveFileWrite([block.filepath]);
                if (writeApproved) {
                  const summary = await this.writeFileWithDiff(block.filepath, block.fileContent);
                  if (!summary.summary.startsWith('Blocked write to ')) {
                    this.postProgressStep(`Created ${path.basename(block.filepath)} (extracted from model response)`);
                    messages.push(this.createAssistantMessage(summary.summary, summary.revertOperationId ? [summary.revertOperationId] : []));
                    didExtract = true;
                  }
                }
              }
            }
            if (didExtract) { break; }

            // Try new file creation (layer 4c pattern)
            const newFileWrite = this.extractNewFileCreation(assistantContent);
            if (newFileWrite) {
              this.debugLog('last_ditch_code_block_extraction', { file: newFileWrite.filepath, source: 'new_file_creation' });
              const writeApproved = this.autoApprove || await this.approveFileWrite([newFileWrite.filepath]);
              if (writeApproved) {
                const summary = await this.writeFileWithDiff(newFileWrite.filepath, newFileWrite.fileContent);
                if (!summary.summary.startsWith('Blocked write to ')) {
                  this.postProgressStep(`Created ${path.basename(newFileWrite.filepath)} (extracted from model response)`);
                  messages.push(this.createAssistantMessage(summary.summary, summary.revertOperationId ? [summary.revertOperationId] : []));
                  didExtract = true;
                }
              }
            }
            if (didExtract) { break; }
          }
          if (didExtract) {
            // Extraction succeeded — nudge model to continue with next file
            messages.push({
              role: 'user',
              content: 'File created from your code block. Continue immediately with the next file. Call create_or_edit_file for each remaining file with the complete implementation code. Do NOT output a plan or describe steps — only tool calls.',
              hiddenFromTranscript: true
            });
            this.postStatus('Extracted file from code block — continuing...');
            await this.processOllamaResponse(messages, 0);
            return;
          }
        }

        if (requiresToolContinuation && retryCount >= effectiveMaxNudgeRetries) {
          this.debugLog('forced_tool_retry_stop', {
            retryCount,
            maxNudgeRetries: effectiveMaxNudgeRetries,
            consecutiveIdenticalResponses: this.consecutiveIdenticalResponses,
            hasRecentToolResults,
            hasRecentSuccessfulAction,
            hasRecentMeaningfulWrite,
            latestCreatedFilePath,
            hasRecentReadOfLargeRefactorTarget,
            latestLargeRefactorTargetTotalLines,
            latestLargeRefactorTargetRemainingLines,
            latestLargeRefactorTargetReachedEof,
            canStopAfterTinyLargeRefactor,
            hasLargeRefactorShellReadBypass,
            hasPreReadLargeRefactorNarration,
            hasFakePreReadCodeDump,
            hasFakePostReadAnalysisDump,
            hasAnnouncedExtractionWithoutWrite,
            hasPostReadSummaryOnLargeRefactor,
            hasModelRefusalResponse,
            hasLazyRefusalOnLargeRefactor,
            isAskingUserForExactSlice,
            suggestedNextSlice,
            hasReadButNoWriteOnLargeRefactor,
            hasPostReadToolStall,
            hasPostCreateRefactorNarration,
            hasRecentToolErrors,
            hasRecentReplaceNotFound,
            replaceNotFoundFilepath,
            isLargeRefactorRequest,
            claimedButUnexecutedCommand,
            isPassingToUser,
            isAnnouncedButNotExecuted,
            hasIncompletePlan: !!hasIncompletePlan,
            hasExplicitNextSteps,
            isProgressOnlyResponse,
            contentPreview: finalContent.substring(0, 200)
          });
          finalContent = hasFakePostReadAnalysisDump
            ? 'The model read the real file but then produced a fake analysis dump or synthetic tool-response JSON instead of making a concrete file edit. Retry the request or use a stronger tool-calling model for iterative refactors.'
            : hasAnnouncedExtractionWithoutWrite
            ? `The model announced an extraction${announcedNewFilePath ? ` to ${announcedNewFilePath}` : ''} but never executed the required file tools. It must call create_or_edit_file and replace_in_file instead of narrating the extraction.`
            : hasLazyRefusalOnLargeRefactor
            ? 'The model responded with "no changes needed" to a refactoring request. It is treating the task as a code review instead of a file-splitting task. Retry the request with a more explicit prompt, or use a stronger tool-calling model.'
            : hasModelRefusalResponse
            ? 'The model produced a safety refusal ("I\'m sorry, but I can\'t assist") when asked to refactor the file, likely because too much file content was loaded into context at once. Use read_file_slice with small bounded ranges instead of read_specific_file on large files. Retry the request.'
            : hasPostReadSummaryOnLargeRefactor
            ? 'The model read a bounded slice of the target file but responded with a summary or analysis instead of making a file-creation tool call. It must call create_or_edit_file to extract code into new modules. Retry the request or use a stronger tool-calling model.'
            : (canStopAfterTinyLargeRefactor && latestLargeRefactorTargetReachedEof)
            ? 'The model reached the end of a tiny refactor target after a real extraction/write and then read past EOF, so there was no further bounded block to extract. The loop stopped because the file appears exhausted, not because of an unrelated failure.'
            : hasPostReadToolStall
            ? suggestedNextSlice?.filepath && suggestedNextSlice.startLine && suggestedNextSlice.endLine
              ? `The model read a bounded section of the target file but then stalled in progress-only text instead of making the next tool call. The next bounded slice was ${suggestedNextSlice.filepath}:${suggestedNextSlice.startLine}-${suggestedNextSlice.endLine}, but it still did not continue. Retry the request or use a stronger tool-calling model for iterative refactors.`
              : 'The model read a bounded section of the target file but then stalled in progress-only text instead of making the next tool call. Retry the request or use a stronger tool-calling model for iterative refactors.'
            : hasReadButNoWriteOnLargeRefactor
            ? 'The model read a bounded section of the target file but still failed to perform a concrete extraction or edit step. It kept summarizing instead of calling tools. Retry the request or use a stronger tool-calling model for iterative refactors.'
            : isLargeRefactorRequest
            ? 'The model inspected the code but did not carry out the large refactor step-by-step. Retry the request or use a stronger tool-calling model. For large files, prefer bounded reads and iterative extraction instead of whole-file summaries.'
            : hasRecentReplaceNotFound
            ? `The model stopped after a failed replace_in_file attempt and did not recover.${replaceNotFoundFilepath ? ` The last blocked file was ${replaceNotFoundFilepath}.` : ''} It must re-read the exact current file content before trying the edit again.`
            : hasRecentToolErrors
              ? 'The model stopped after tool errors and then switched to descriptive text instead of completing the task. Retry the request or use a stronger tool-calling model.'
              : 'The model stopped at a plan/progress response without completing the tool actions. Retry the request or use a stronger tool-calling model.';
        }
      }

      // Final safety: truncate any remaining large output
      finalContent = this.truncateLargeCodeBlocks(finalContent);
      finalContent = this.truncateLongResponse(finalContent);

      if (!finalContent.trim()) {
        finalContent = this.isAgentLike
          ? 'The model completed the request but returned no final text response. If file changes were expected, try the request again or switch to a model with stronger tool-calling support.'
          : 'No files were changed. Chat mode can only provide a proposed patch or instructions.';
      }
    }

    messages.push({
      role: 'assistant',
      content: finalContent
    });
  }

  /**
   * Estimate context limits based on the model name/tag.
   * Parses size hints like :7b, :14b, :30b, :70b from the model string.
   * Returns { maxMessages, numCtx } tuned for the model's capacity.
   */
  private getModelSizeInBillions(): number {
    const model = this.getSelectedModel().toLowerCase();
    const sizeMatch = model.match(/(\d+\.?\d*)b/);
    return sizeMatch ? parseFloat(sizeMatch[1]) : 0;
  }

  private getModelCapabilityProfile(): ModelCapabilityProfile {
    const sizeB = this.getModelSizeInBillions();

    if (sizeB > 0 && sizeB <= 1.5) {
      return {
        tier: 'micro',
        maxMessages: 8,
        numCtx: 4096,
        workspaceTreeMaxDepth: 2,
        workspaceTreeFileCap: 60,
        summaryContextLimit: 2,
        includeWorkspaceInstructions: false,
        includeWorkspaceNotes: false,
        includeRecentChatSummaries: false,
        useCompactMandate: true,
        preferStepwiseExecution: true,
        maxNudgeRetriesCap: 1,
        maxReadOpsWithoutWrite: 2,
        toolNames: ['read_specific_file', 'read_file_slice', 'create_or_edit_file', 'replace_in_file', 'list_workspace_files']
      };
    }

    if (sizeB > 1.5 && sizeB <= 3.5) {
      return {
        tier: 'small',
        maxMessages: 10,
        numCtx: 6144,
        workspaceTreeMaxDepth: 2,
        workspaceTreeFileCap: 100,
        summaryContextLimit: 4,
        includeWorkspaceInstructions: true,
        includeWorkspaceNotes: false,
        includeRecentChatSummaries: true,
        useCompactMandate: true,
        preferStepwiseExecution: true,
        maxNudgeRetriesCap: 2,
        maxReadOpsWithoutWrite: 2,
        toolNames: ['read_active_file', 'read_specific_file', 'read_file_slice', 'create_or_edit_file', 'replace_in_file', 'list_workspace_files', 'execute_terminal_command']
      };
    }

    if (sizeB > 0 && sizeB <= 9) {
      return {
        tier: 'medium',
        maxMessages: 16,
        numCtx: 8192,
        workspaceTreeMaxDepth: 3,
        workspaceTreeFileCap: 160,
        summaryContextLimit: 6,
        includeWorkspaceInstructions: true,
        includeWorkspaceNotes: true,
        includeRecentChatSummaries: true,
        useCompactMandate: false,
        preferStepwiseExecution: false,
        maxNudgeRetriesCap: 3,
        maxReadOpsWithoutWrite: 3,
        toolNames: this.getToolDefinitions().map(tool => tool.function.name)
      };
    }

    if (sizeB > 9 && sizeB <= 34) {
      return {
        tier: 'large',
        maxMessages: sizeB <= 16 ? 24 : 32,
        numCtx: sizeB <= 16 ? 12288 : 16384,
        workspaceTreeMaxDepth: 3,
        workspaceTreeFileCap: 220,
        summaryContextLimit: 8,
        includeWorkspaceInstructions: true,
        includeWorkspaceNotes: true,
        includeRecentChatSummaries: true,
        useCompactMandate: false,
        preferStepwiseExecution: false,
        maxNudgeRetriesCap: 4,
        maxReadOpsWithoutWrite: 3,
        toolNames: this.getToolDefinitions().map(tool => tool.function.name)
      };
    }

    return {
      tier: 'xlarge',
      maxMessages: 48,
      numCtx: 32768,
      workspaceTreeMaxDepth: 4,
      workspaceTreeFileCap: 260,
      summaryContextLimit: 10,
      includeWorkspaceInstructions: true,
      includeWorkspaceNotes: true,
      includeRecentChatSummaries: true,
      useCompactMandate: false,
      preferStepwiseExecution: false,
      maxNudgeRetriesCap: 5,
      maxReadOpsWithoutWrite: 4,
      toolNames: this.getToolDefinitions().map(tool => tool.function.name)
    };
  }

  private getModelContextLimits(): { maxMessages: number; numCtx: number } {
    const { maxMessages, numCtx } = this.getModelCapabilityProfile();
    return { maxMessages, numCtx };
  }

  private getActiveToolDefinitions(): ToolDefinition[] {
    const allowed = new Set(this.getModelCapabilityProfile().toolNames);
    return this.getToolDefinitions().filter(tool => allowed.has(tool.function.name));
  }

  private isDegenerateOutput(content: string): boolean {
    const trimmed = content.trim();
    if (trimmed.length < 80) { return false; }
    // Strip markdown formatting and punctuation, then tokenize
    const cleaned = trimmed.replace(/[*_~`#>|\-—=\[\](){}]/g, ' ');
    const words = cleaned.split(/\s+/).map(w => w.toLowerCase().replace(/[^a-z0-9]/g, '')).filter(w => w.length > 0);
    if (words.length < 20) { return false; }
    // Count word frequencies
    const freq = new Map<string, number>();
    for (const w of words) {
      freq.set(w, (freq.get(w) ?? 0) + 1);
    }
    // If any single word dominates (>50% of all tokens and appears 15+ times)
    for (const [, count] of freq) {
      if (count >= 15 && count / words.length > 0.5) {
        return true;
      }
    }
    // Ultra-low vocabulary: <5% unique words among 50+ words
    if (words.length >= 50 && freq.size / words.length < 0.05) {
      return true;
    }
    return false;
  }

  private extractMarkerFileWrite(content: string): { fullMatch: string; filepath: string; fileContent: string } | undefined {
    return extractMarkerFileWriteHelper(content, this.attachedFiles);
  }

  private getLatestReplaceNotFoundContext(messages: OllamaMessage[]): { filepath?: string; startLine?: number; endLine?: number; neverPresentInTarget?: boolean } | undefined {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== 'tool') {
        continue;
      }

      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(message.content) as Record<string, unknown>;
      } catch {
        parsed = {};
      }

      if (!parsed.error) {
        if (message.tool_name === 'execute_terminal_command') {
          if (Number(parsed.exitCode ?? 0) === 0) {
            return undefined;
          }
          continue;
        }

        if (message.tool_name === 'create_or_edit_file'
          || message.tool_name === 'write_to_file'
          || message.tool_name === 'replace_in_file'
          || message.tool_name === 'delete_file') {
          return undefined;
        }
        continue;
      }

      if (message.tool_name === 'replace_in_file' && /old_text not found/i.test(String(parsed.error))) {
        const suggestedReadSlice = parsed.suggestedReadSlice;
        const slice = suggestedReadSlice && typeof suggestedReadSlice === 'object' && !Array.isArray(suggestedReadSlice)
          ? suggestedReadSlice as Record<string, unknown>
          : undefined;
        return {
          filepath: this.getReplaceInFilePathForToolMessage(messages, index),
          startLine: typeof slice?.startLine === 'number' ? slice.startLine : undefined,
          endLine: typeof slice?.endLine === 'number' ? slice.endLine : undefined,
          neverPresentInTarget: parsed.neverPresentInTarget === true
        };
      }
    }

    return undefined;
  }

  private getReplaceInFilePathForToolMessage(messages: OllamaMessage[], toolMessageIndex: number): string | undefined {
    for (let index = toolMessageIndex - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== 'assistant' || !message.tool_calls?.length) {
        continue;
      }

      for (let toolIndex = message.tool_calls.length - 1; toolIndex >= 0; toolIndex -= 1) {
        const toolCall = message.tool_calls[toolIndex];
        if (this.remapWeakModelToolName(toolCall.function?.name ?? '') !== 'replace_in_file') {
          continue;
        }

        const args = this.normalizeToolArguments(toolCall.function?.arguments);
        const filepath = String(args.filepath ?? '').trim();
        if (filepath) {
          return filepath;
        }
      }
    }

    return undefined;
  }

  private matchResponseToAttachedFile(content: string): { filepath: string; fileContent: string } | undefined {
    return matchResponseToAttachedFileHelper(content, this.attachedFiles);
  }

  private matchResponseToActiveFile(content: string): { filepath: string; fileContent: string } | undefined {
    const activeDoc = vscode.window.activeTextEditor?.document;
    return matchResponseToActiveFileHelper(content, activeDoc && !activeDoc.isUntitled ? {
      filepath: activeDoc.uri.fsPath,
      content: activeDoc.getText()
    } : undefined);
  }

  private extractTrustedFullFileContent(content: string, originalContent?: string): string | undefined {
    return extractTrustedFullFileContentHelper(content, originalContent);
  }

  private hasStrongFullFileAnchors(extractedContent: string, originalContent: string): boolean {
    const normalize = (value: string): string => value.trim();
    const extractedLines = extractedContent.split('\n').map(normalize).filter(Boolean);
    const originalLines = originalContent.split('\n').map(normalize).filter(Boolean);

    if (extractedLines.length < 8 || originalLines.length < 8) {
      return false;
    }

    const headCandidates = originalLines.slice(0, 6).filter(line => line.length > 3);
    const tailCandidates = originalLines.slice(-6).filter(line => line.length > 3);
    const extractedSet = new Set(extractedLines);

    const headMatches = headCandidates.filter(line => extractedSet.has(line)).length;
    const tailMatches = tailCandidates.filter(line => extractedSet.has(line)).length;

    return headMatches >= 3 && tailMatches >= 2;
  }

  private sanitizeGeneratedFileContent(content: string): string {
    return sanitizeGeneratedFileContentHelper(content);
  }

  private stripDiffPrefixes(content: string): string {
    return stripDiffPrefixesHelper(content);
  }

  private detectDestructiveWrite(displayName: string, content: string, oldContent?: string): string | undefined {
    const trimmed = content.trim();
    const ext = displayName.split('.').pop()?.toLowerCase();

    // Block writing non-JSON content to .json files
    if (ext === 'json') {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        // package.json must have a "name" field — partial JSON dumps are destructive
        if (displayName.toLowerCase() === 'package.json' && typeof parsed === 'object' && parsed !== null && !('name' in parsed)) {
          return 'Content is missing required "name" field for package.json. This looks like a partial write.';
        }
      } catch {
        return 'Content is not valid JSON.';
      }
    }

    // Block writing broken HTML files — must contain basic HTML structure
    if (ext === 'html' || ext === 'htm') {
      if (!/<html[\s>]/i.test(trimmed) || !/<head[\s>]/i.test(trimmed) || !/<body[\s>]/i.test(trimmed)) {
        return 'Content is missing basic HTML structure (html/head/body tags). This looks like a partial snippet, not a complete file.';
      }
    }

    // Block writing very short content to known structured files
    const criticalFiles = ['package.json', 'tsconfig.json', 'package-lock.json'];
    if (criticalFiles.includes(displayName.toLowerCase()) && trimmed.length < 20) {
      return 'Content is suspiciously short for a structured project file.';
    }

    // Block writes that lose >60% of the original file's content (likely partial/truncated)
    if (oldContent && oldContent.length > 100 && trimmed.length < oldContent.length * 0.4) {
      return `Content is ${trimmed.length} bytes vs original ${oldContent.length} bytes — too much content lost. This looks like a partial write.`;
    }

    // Block writing content that looks like a shell command rather than file content
    if (trimmed.split('\n').length <= 2 && /^(?:npm|npx|yarn|pnpm|node|python|pip|cargo|go)\s/i.test(trimmed)) {
      return 'Content looks like a shell command, not file content.';
    }

    return undefined;
  }

  private looksLikeDiffOutput(content: string): boolean {
    return looksLikeDiffOutputHelper(content);
  }

  private looksLikeChangeSummary(content: string): boolean {
    return looksLikeChangeSummaryHelper(content);
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
    return extractDescribedReplacementsHelper(content);
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
    const activeName = vscode.window.activeTextEditor ? path.basename(vscode.window.activeTextEditor.document.fileName) : '';
    return isLikelyFileReferenceHelper(candidate, { activeName, attachedFiles: this.attachedFiles });
  }

  private findAttachedFileForReplacements(replacements: Array<{ oldText: string }>): string | undefined {
    return findAttachedFileForReplacementsHelper(replacements, this.attachedFiles);
  }

  private async findMentionedFileForReplacements(
    content: string,
    replacements: Array<{ oldText: string }>
  ): Promise<string | undefined> {
    return findMentionedFileForReplacementsHelper(content, replacements, {
      isLikelyFileReference: candidate => this.isLikelyFileReference(candidate),
      resolveAndReadCandidate: async candidate => {
        try {
          const uri = this.resolveWorkspaceUri(candidate);
          const bytes = await vscode.workspace.fs.readFile(uri);
          return { filepath: uri.fsPath, content: Buffer.from(bytes).toString('utf8') };
        } catch {
          return undefined;
        }
      }
    });
  }

  private async findMentionedFileInContent(content: string): Promise<string | undefined> {
    return findMentionedFileInContentHelper(content, {
      isLikelyFileReference: candidate => this.isLikelyFileReference(candidate),
      candidateExists: async candidate => {
        try {
          const uri = this.resolveWorkspaceUri(candidate);
          await vscode.workspace.fs.stat(uri);
          return uri.fsPath;
        } catch {
          return undefined;
        }
      }
    });
  }

  private async extractDescribedFileDump(content: string): Promise<{ fullMatch: string; filepath: string; fileContent: string } | undefined> {
    const activeDoc = vscode.window.activeTextEditor?.document;
    return extractDescribedFileDumpHelper(content, {
      findMentionedFileInContent: candidateContent => this.findMentionedFileInContent(candidateContent),
      readFileAtPath: async filepath => {
        try {
          const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filepath));
          return Buffer.from(bytes).toString('utf8');
        } catch {
          return undefined;
        }
      },
      activeFile: activeDoc && !activeDoc.isUntitled ? { filepath: activeDoc.uri.fsPath, content: activeDoc.getText() } : undefined
    });
  }

  private extractNewFileCreation(content: string): { fullMatch: string; filepath: string; fileContent: string } | undefined {
    const activeEditorPath = vscode.window.activeTextEditor?.document.uri.scheme === 'file'
      ? vscode.window.activeTextEditor.document.uri.fsPath
      : undefined;
    return extractNewFileCreationHelper(content, {
      isLikelyFileReference: candidate => this.isLikelyFileReference(candidate),
      latestVisibleUserRequest: this.getLatestVisibleUserRequest(this.messages),
      looksLikeLargeRefactorRequest: text => this.looksLikeLargeRefactorRequest(text),
      activeEditorPath,
      workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    });
  }

  private async callOllama(messages: OllamaMessage[]): Promise<OllamaResponse> {
    const baseUrl = this.getOllamaBaseUrl();
    const model = this.getSelectedModel();
    if (!model) {
      throw new Error('No Ollama model selected. Select a local model first.');
    }
    const systemPrompt = this.getSystemPrompt();

    const requestMessages: OllamaMessage[] = [];

    if (this.isAgentLike) {
      const capabilityProfile = this.getModelCapabilityProfile();
      const workspaceInstructions = capabilityProfile.includeWorkspaceInstructions ? await this.getWorkspaceInstructions() : '';
      const recentChatSummaries = capabilityProfile.includeRecentChatSummaries ? this.buildRecentChatSummaryContext() : '';

      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

    if (this.agentMode === 'planner') {
      // Planner mode: condensed system prompt to reduce token overhead for weaker models
      let plannerMandate = capabilityProfile.useCompactMandate ? `[IDENTITY]
You are ManulAI, a local VS Code coding agent in Planner mode.
${wsRoot ? `Workspace root: ${wsRoot}\n` : ''}
[RULES]
- If the user asks a direct question, answer briefly in text.
- For edit or file tasks: do exactly ONE small tool call per response.
- Prefer read_file_slice over large reads.
- Keep responses short. No multi-step plans. No JSON in text.
- Finish with a one-line summary when done.
` : `[IDENTITY]
You are ManulAI, a local VS Code coding agent in Planner mode.
${wsRoot ? `Workspace root: ${wsRoot}\n` : ''}
[RULES]
- If the user asks a question, explains a concept, or requests information — answer directly in text. No tool calls needed.
- For tasks that require code changes or file operations: execute ONE tool call per response. No multi-step plans.
- After each tool result you receive, decide the next single action.
- Use file tools for reads/writes, execute_terminal_command for shell.
- execute_terminal_command has no stdin. Never run interactive programs (input(), readline, read) — they will hang.
- For interactive programs (games, REPLs, scripts that need user input), use launch_in_terminal instead.
- Keep text output minimal between tool calls.
- NEVER output raw JSON as a substitute for a tool call.
- Task is complete when all required changes are done. Output a one-line summary.
`;

      const workspaceTree = await this.buildCompactWorkspaceTree();
      if (workspaceTree) {
        plannerMandate += '\n[WORKSPACE STRUCTURE]\n' + workspaceTree;
      }

      if (capabilityProfile.includeWorkspaceNotes) {
        const notesResult = await this.readWorkspaceNotes();
        try {
          const { content: notesContent } = JSON.parse(notesResult) as { content: string };
          if (notesContent && !notesContent.startsWith('(no notes') && !notesContent.startsWith('(empty)') && !notesContent.startsWith('(no workspace')) {
            plannerMandate += '\n[WORKSPACE NOTES]\n' + this.compactMemoryText(notesContent, capabilityProfile.tier === 'medium' ? 900 : 1400);
          }
        } catch { /* ignore parse errors */ }
      }

      requestMessages.push({
        role: 'system',
        content: plannerMandate,
        hiddenFromTranscript: true
      });
    } else {
    let agentMandate = capabilityProfile.useCompactMandate ? `[IDENTITY]
  You are ManulAI, a local VS Code coding agent.
  ${wsRoot ? `Workspace root: ${wsRoot}\n` : ''}

  [RULES]
  - Execute the next concrete action. No long plan.
  - Prefer exactly ONE tool call per response.
  - Read before edit. Prefer read_file_slice for large files.
  - Use replace_in_file for small edits and create_or_edit_file for new files.
  - Do not narrate tool calls. Do not print JSON as text.
  - If a tool fails, adapt once and continue.
  - Finish with one short summary when the task is done.
  ` : `[IDENTITY]
You are ManulAI, a local VS Code coding agent.
${wsRoot ? `Workspace root: ${wsRoot}\n` : ''}
All file paths are relative to the workspace root unless absolute.

---

[PRIMARY DIRECTIVE]

You are an ACTION agent. Execute tasks using tools. Never describe what you intend to do instead of doing it.

---

[DECISION FLOW]

1. File or code modification needed → use file tools
2. Command execution needed → use execute_terminal_command (no stdin — never run interactive programs)
   For interactive programs (games, REPLs, scripts with user input) → use launch_in_terminal
3. Code understanding required → read files first with read_file_slice
4. No tools required → respond concisely

---

[EXECUTION MODES]

SIMPLE TASK:
→ Call the appropriate tool immediately. No preamble.

NON-TRIVIAL TASK:
→ Output a short numbered plan ONCE (3–8 steps).
→ After the plan, immediately call the tool for step 1.
→ After each tool result, call the next tool without printing
   "Executing step N" or similar announcements.
→ After ALL steps are done, output a one-line summary.

CRITICAL:
- NEVER write "Executing step N: tool_name with arguments {...}" in text.
  That is a simulation. Call the actual tool instead.
- NEVER output JSON or code blocks as a substitute for a tool call.
- After the plan is written, every subsequent response must be a tool call
  (or the final summary if all steps are complete).
- Do NOT stop after the plan. Do NOT stop after step 1.

---

[REALITY MODEL]

- File contents are UNKNOWN until read
- Project structure is UNKNOWN until listed
- Results are UNKNOWN until tool confirms
- Previous project knowledge may exist in workspace notes; use it first before re-reading many files

Never assume. Always verify.

---

[WORKSPACE MEMORY]

- At the start of a task, use the injected workspace structure and saved workspace notes as prior context
- If notes are missing or insufficient, inspect only the minimum files needed
- After finishing meaningful work, save concise notes with write_workspace_notes so future requests preserve context across sessions
- Notes should capture architecture facts, file roles, recurring patterns, and important decisions

---

[FILE SPLITTING RULES]

When splitting a file into smaller modules:

1. Read a bounded section with read_file_slice (e.g. lines 1–120).
2. Identify one self-contained block (interfaces, a class, utility functions).
3. Call create_or_edit_file with the NEW file path and the EXACT copied code.
  - content MUST be the real extracted code, NOT a comment placeholder.
   - "// Code will be inserted here" is FORBIDDEN. Copy the real code.
4. Call replace_in_file on the original file:
   - old_text = the exact extracted block
   - new_text = an import statement for the new file
   - old_text and new_text MUST differ.
5. Read the next slice and repeat until done.

---

[FILE EDITING RULES]

- MUST read file before editing
- MUST use replace_in_file for targeted edits
- MUST apply minimal change only
- FORBIDDEN: full file overwrite, removing code not seen, batch rewrite

---

[TOOL USAGE RULES]

- ALWAYS use native tool calls
- NEVER output raw JSON as a tool call substitute
- NEVER write "Executing step N:" in text — call the tool instead
- If fix is known → call the tool immediately

---

[FAILURE HANDLING]

If a tool fails:
1. Read the error
2. Adjust input
3. Retry with corrected arguments

Do NOT stop after failure.

---

[ANTI-HALLUCINATION]

If uncertain → read more files. DO NOT guess content.

---

[COMPLETION RULE]

Task is complete ONLY when all required tool calls have succeeded.
If steps remain → continue with the next tool call.

---

[OUTPUT RULES]

- Plan: short numbered list, then immediately start executing
- During execution: no narration, only tool calls
- After completion: one-line summary
`;

      if (workspaceInstructions) {
        agentMandate += '\n\n<workspace_instructions>\n' + (capabilityProfile.useCompactMandate ? this.compactMemoryText(workspaceInstructions, 1200) : workspaceInstructions) + '\n</workspace_instructions>';
      }

      if (recentChatSummaries) {
        agentMandate += '\n\n[RECENT CHAT SUMMARIES]\n' + (capabilityProfile.useCompactMandate ? this.compactMemoryText(recentChatSummaries, 600) : recentChatSummaries) + '\n\nUse these summaries as short-term memory of prior dialog outcomes before re-reading files.';
      }

      // Inject the compact workspace tree so the model knows the project structure up front
      const workspaceTree = await this.buildCompactWorkspaceTree();
      if (workspaceTree) {
        agentMandate += '\n\n[WORKSPACE STRUCTURE]\n' + workspaceTree;
      }

      // Inject persisted notes from previous sessions if they exist
      if (capabilityProfile.includeWorkspaceNotes) {
        const notesResult = await this.readWorkspaceNotes();
        try {
          const { content: notesContent } = JSON.parse(notesResult) as { content: string };
          if (notesContent && !notesContent.startsWith('(no notes') && !notesContent.startsWith('(empty)') && !notesContent.startsWith('(no workspace')) {
            agentMandate += '\n\n[WORKSPACE NOTES FROM PREVIOUS SESSIONS]\n' + this.compactMemoryText(notesContent, capabilityProfile.tier === 'medium' ? 900 : 1400) + '\n\nUse these notes to avoid re-reading files you already know about. Update them after completing a task.';
          }
        } catch { /* ignore parse errors */ }
      }

      requestMessages.push({
        role: 'system',
        content: agentMandate,
        hiddenFromTranscript: true
      });
    } // end agent mandate else block
    } else {
      requestMessages.push({
  role: 'system',
  content:
`[IDENTITY]
You are ManulAI in CHAT-ONLY mode.

---

[GOLDEN RULES]

- Never claim edits — you cannot change files.
- Only modify what is visible in the snippet.
- Never invent missing code or unseen lines.
- Format strictly as Old → New.
- If unsure, say so — do not guess.
- Keep changes minimal and precise.

---

[HARD LIMITATIONS]

- NO tools are available
- You CANNOT read files
- You CANNOT modify files
- You CANNOT execute commands
- NEVER claim that you changed anything

---

[CORE BEHAVIOR]

- You are a SUGGESTION engine, not an executor
- Provide exact, minimal changes the user can apply manually
- Keep responses short and precise

---

[CODE MODIFICATION RULES]

If the user provides code:

- ONLY modify what is visible
- NEVER invent missing code
- NEVER assume unseen lines
- ALWAYS base changes strictly on the provided snippet

Format changes EXACTLY as:

Old: \`<exact old text from user>\`
New: \`<replacement text>\`

Rules:
- Old MUST exist in the provided code
- If you are not sure → DO NOT GUESS
- Do NOT rewrite entire blocks
- Do NOT output full files

---

[IF CODE IS MISSING]

If the user asks for a change but provides NO code:

- DO NOT fabricate "Old" lines
- Instead:
  - Explain what needs to be changed
  - Provide a minimal example snippet

---

[ANTI-HALLUCINATION]

- If you cannot see it → you do NOT know it
- If you are unsure → say so
- NEVER generate fake exact matches

---

[MINIMALISM]

- Smallest possible change
- No refactoring
- No unrelated improvements

---

[OUTPUT RULES]

- No explanations unless necessary
- No polite endings
- No full file dumps
`,
  hiddenFromTranscript: true
});
    }

    if (systemPrompt) {
      requestMessages.push({ role: 'system', content: systemPrompt, hiddenFromTranscript: true });
    }

    requestMessages.push(...messages.filter(m => !m.localOnly).map(m => {
      // Sanitize any degenerate assistant content that leaked into history (prevents context poisoning)
      if (m.role === 'assistant' && typeof m.content === 'string' && this.isDegenerateOutput(m.content)) {
        return { ...m, content: '[incoherent output removed]' };
      }
      return { ...m };
    }));

    const { numCtx } = this.getModelContextLimits();

    const body: {
      model: string;
      stream: false;
      messages: OllamaMessage[];
      tools?: ToolDefinition[];
      options?: { num_ctx: number };
    } = {
      model,
      stream: false,
      messages: requestMessages,
      options: { num_ctx: numCtx }
    };

    if (this.isAgentLike) {
      body.tools = this.getActiveToolDefinitions();
    }

    const abortController = new AbortController();
    this.currentRequestAbortController = abortController;

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: abortController.signal
    });

    if (!response.ok) {
      const errorText = await response.text();
      // If the model does not support tools, retry without tools
      if (response.status === 400 && /does not support tools/i.test(errorText) && body.tools) {
        delete body.tools;
        this.postStatus('Model does not support tools — retrying as plain chat...');
        const retryController = new AbortController();
        this.currentRequestAbortController = retryController;
        const retryResponse = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: retryController.signal
        });
        if (!retryResponse.ok) {
          const retryError = await retryResponse.text();
          throw new Error(`Ollama HTTP ${retryResponse.status}: ${retryError}`);
        }
        return (await retryResponse.json()) as OllamaResponse;
      }
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
    const allowedToolNames = new Set(this.getActiveToolDefinitions().map(tool => tool.function.name));
    return extractToolCallsHelper(message, this.getActiveToolDefinitions()).filter(toolCall => {
      const name = this.remapWeakModelToolName(toolCall.function?.name ?? '');
      return allowedToolNames.has(name);
    });
  }

  private stripToolCallsFromContent(content: string): string {
    return stripToolCallsFromContentHelper(content);
  }

  private parseToolCallsFromContent(content: string): ToolFunctionCall[] {
    return parseToolCallsFromContentHelper(content, this.getActiveToolDefinitions());
  }

  /**
   * Escape literal control characters (newlines, tabs, carriage returns) that appear
   * inside JSON string values. Structural whitespace outside strings is preserved.
   * Fixes truncated/malformed JSON from models that output raw newlines in content fields.
   */
  private escapeJsonStringValues(s: string): string {
    return escapeJsonStringValuesHelper(s);
  }

  private parseTaggedToolCalls(content: string): ToolFunctionCall[] {
    const knownToolNames = new Set(this.getActiveToolDefinitions().map(t => t.function.name));
    const calls: ToolFunctionCall[] = [];
    const functionPattern = /<function=([a-zA-Z0-9_]+)>\s*([\s\S]*?)<\/function>/g;
    let match: RegExpExecArray | null;

    while ((match = functionPattern.exec(content)) !== null) {
      const toolName = this.remapWeakModelToolName(match[1].trim());
      if (!knownToolNames.has(toolName)) {
        continue;
      }

      const args: Record<string, unknown> = {};
      const parameterPattern = /<parameter=([a-zA-Z0-9_]+)>\s*([\s\S]*?)\s*<\/parameter>/g;
      let parameterMatch: RegExpExecArray | null;
      while ((parameterMatch = parameterPattern.exec(match[2] ?? '')) !== null) {
        args[parameterMatch[1].trim()] = parameterMatch[2];
      }

      calls.push({
        type: 'function',
        function: {
          name: toolName,
          arguments: this.remapWeakModelArgumentAliases(args)
        }
      });
    }

    return calls;
  }

  /**
   * Detect content that looks like a raw tool-call JSON definition
   * (even with malformed quotes). Prevents fallback layers from writing
   * tool-call JSON as file content.
   */
  private looksLikeToolCallContent(content: string): boolean {
    return looksLikeToolCallContentHelper(content, this.getActiveToolDefinitions());
  }

  private looksLikeMalformedToolCallContent(content: string): boolean {
    return looksLikeMalformedToolCallContentHelper(content, this.getActiveToolDefinitions());
  }

  private extractToolCallNameHint(content: string): string | undefined {
    return extractToolCallNameHintHelper(content, this.getActiveToolDefinitions());
  }

  private containsLeakedToolCallPayload(content: string): boolean {
    return containsLeakedToolCallPayloadHelper(content, this.getActiveToolDefinitions());
  }

  /** Extract a balanced JSON object starting at `startIndex` in `text`. */
  private extractBalancedJson(text: string, startIndex: number): string | undefined {
    return extractBalancedJsonHelper(text, startIndex);
  }

  /**
   * Attempt to repair JSON that uses single quotes instead of double quotes.
   * Handles cases like: {"name": "tool", "arguments": {"old_text": 'value with "quotes"'}}
   */
  private repairSingleQuotedJson(text: string): string | undefined {
    return repairSingleQuotedJsonHelper(text);
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
    const directName = typeof record.name === 'string' ? record.name.trim()
      : typeof record.function_name === 'string' ? record.function_name.trim()
      : typeof record.function === 'string' ? record.function.trim()
      : '';
    const normalizedToolName = this.remapWeakModelToolName(typeof record.function === 'string' ? record.function.trim() : directName);
    const directArguments = this.inferImplicitToolArguments(normalizedToolName, record.arguments ?? record.parameters, record);
    const functionRecord = this.toObjectRecord(record.function);
    const normalizedArguments = this.normalizeParsedToolArguments(functionRecord?.arguments ?? directArguments);

    const parsedToolCall: ParsedToolCall = {
      name: this.remapWeakModelToolName(typeof functionRecord?.name === 'string' ? functionRecord.name.trim() : directName),
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
      return this.remapWeakModelArgumentAliases(value as Record<string, unknown>);
    }

    return undefined;
  }

  private inferImplicitToolArguments(
    toolName: string,
    explicitArguments: unknown,
    record: Record<string, unknown>
  ): unknown {
    if (explicitArguments !== undefined) {
      return explicitArguments;
    }

    const rest = { ...record };
    delete rest.type;
    delete rest.name;
    delete rest.function_name;
    delete rest.function;
    delete rest.arguments;
    delete rest.parameters;

    if (Object.keys(rest).length === 0) {
      return undefined;
    }

    if (toolName === 'create_or_edit_file') {
      const filename = rest.filename ?? rest.filepath ?? rest.path;
      const content = rest.content;
      if (typeof filename === 'string' && typeof content === 'string') {
        return { filename, content };
      }
    }

    if (toolName === 'write_to_file') {
      const filepath = rest.filepath ?? rest.filename ?? rest.path;
      const content = rest.content;
      if (typeof filepath === 'string' && typeof content === 'string') {
        return { filepath, content };
      }
    }

    if (toolName === 'replace_in_file') {
      const filepath = rest.filepath ?? rest.filename ?? rest.path;
      const oldText = rest.old_text ?? rest.old_content ?? rest.old_string ?? rest.old_code;
      const newText = rest.new_text ?? rest.new_content ?? rest.new_string ?? rest.new_code;
      if (typeof filepath === 'string' && typeof oldText === 'string' && typeof newText === 'string') {
        return { filepath, old_text: oldText, new_text: newText };
      }
    }

    if (toolName === 'read_specific_file') {
      const filepath = rest.filepath ?? rest.filename ?? rest.path;
      if (typeof filepath === 'string') {
        return { filepath };
      }
    }

    return rest;
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
          name: 'read_file_slice',
          description: 'Read only a bounded line range from a file. Prefer this over full-file reads when the file is large.',
          parameters: {
            type: 'object',
            properties: {
              filepath: {
                type: 'string',
                description: 'Absolute or workspace-relative path to read.'
              },
              startLine: {
                type: 'number',
                description: '1-based inclusive start line.'
              },
              endLine: {
                type: 'number',
                description: '1-based inclusive end line.'
              }
            },
            required: ['filepath', 'startLine', 'endLine'],
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
          description: 'Execute a shell command in the workspace and return stdout/stderr. No stdin — do not run interactive programs (input(), readline, etc.) as they will hang and time out.',
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
      },
      {
        type: 'function',
        function: {
          name: 'launch_in_terminal',
          description: 'Open an interactive program in a visible VS Code terminal. Use this for programs that need user input (games, REPLs, interactive scripts). Returns immediately — the user interacts with the program directly.',
          parameters: {
            type: 'object',
            properties: {
              command: {
                type: 'string',
                description: 'The command to run in the interactive terminal.'
              }
            },
            required: ['command'],
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'delete_file',
          description: 'Delete a file from the workspace.',
          parameters: {
            type: 'object',
            properties: {
              filepath: {
                type: 'string',
                description: 'Workspace-relative or absolute path to the file to delete.'
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
          name: 'list_workspace_files',
          description: 'Recursively list files and folders in the workspace or a specific subdirectory. Skips node_modules, .git, and other build artifacts. Use this to discover project structure before reading or editing files.',
          parameters: {
            type: 'object',
            properties: {
              directory: {
                type: 'string',
                description: 'Optional subdirectory path relative to workspace root. Omit or use empty string for root.'
              },
              maxDepth: {
                type: 'number',
                description: 'Maximum recursion depth. Default is 4. Use 1 for a shallow one-level listing.'
              }
            },
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'project_scan',
          description: 'Build a structured project summary with key files, entry points, package manager, project type hints, and important modules. Use this for high-level context before targeted reads.',
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
          name: 'read_workspace_notes',
          description: 'Read persistent notes for this chat saved by the model in a previous session. Always call this at the start of a new task to recall prior discoveries, decisions, and project context.',
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
          name: 'write_workspace_notes',
          description: 'Save notes for this chat to persistent memory. Notes are scoped to the current chat and deleted when the chat is deleted. Use mode="append" to add new facts without erasing previous notes. Use mode="overwrite" only to fully replace notes. Call this after completing a task to record key facts: file roles, architecture decisions, repeated patterns, or anything needed to avoid re-reading files next time.',
          parameters: {
            type: 'object',
            properties: {
              content: {
                type: 'string',
                description: 'The notes to save. Use markdown for structure.'
              },
              mode: {
                type: 'string',
                enum: ['append', 'overwrite'],
                description: 'append: adds to existing notes. overwrite: replaces all notes.'
              }
            },
            required: ['content', 'mode'],
            additionalProperties: false
          }
        }
      }
    ];
  }

  private extractCodeBlockFileWrites(content: string): Array<{ fullMatch: string; filepath: string; fileContent: string }> {
    return extractCodeBlockFileWritesHelper(content, {
      looksLikeToolCallContent: candidate => this.looksLikeToolCallContent(candidate),
      isLikelyFileReference: candidate => this.isLikelyFileReference(candidate)
    });
  }

  private async extractUnifiedDiffWrite(content: string): Promise<{ fullMatch: string; filepath: string; fileContent: string } | undefined> {
    return extractUnifiedDiffWriteHelper(content, {
      resolveExistingWorkspacePath: rawPath => this.resolveExistingWorkspacePath(rawPath),
      readWorkspaceText: filepath => this.readWorkspaceText(vscode.Uri.file(filepath)),
      normalizeTextForComparison: value => this.normalizeTextForComparison(value)
    });
  }

  private truncateLargeCodeBlocks(content: string): string {
    return truncateLargeCodeBlocksHelper(content);
  }

  private extractInlineFileBlocks(content: string): Array<{ fullMatch: string; filepath: string; fileContent: string }> {
    return extractInlineFileBlocksHelper(content);
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
    const name = this.remapWeakModelToolName(toolCall.function?.name ?? '');
    const args = this.normalizeToolArguments(toolCall.function?.arguments);

    try {
      switch (name) {
        case 'read_active_file':
          if (String(args.filepath ?? '').trim()) {
            return await this.readSpecificFile(String(args.filepath ?? ''));
          }
          return await this.readActiveFile();
        case 'read_specific_file': {
          if (args.startLine !== undefined || args.endLine !== undefined) {
            return await this.readFileSlice(String(args.filepath ?? ''), args.startLine, args.endLine);
          }
          // During a large refactor, cap full-file reads to 200 lines to avoid flooding context
          // and triggering model safety refusals on large source files.
          const readFilepath = String(args.filepath ?? '');
          if (this.isLargeRefactorScenario()) {
            const cappedResult = await this.readSpecificFileCapped(readFilepath, 200);
            if (cappedResult !== null) {
              return cappedResult;
            }
          }
          return await this.readSpecificFile(readFilepath);
        }
        case 'read_file_slice':
          return await this.readFileSlice(String(args.filepath ?? ''), args.startLine, args.endLine);
        case 'create_or_edit_file': {
          const createFilename = String(args.filename ?? args.filepath ?? '');
          const createContent = String(args.content ?? '');
          if (this.isLargeRefactorScenario()) {
            const contentLines = createContent.replace(/\r\n/g, '\n').split('\n').map(l => l.trim()).filter(Boolean);
            const codeLikeLines = contentLines.filter(l =>
              !/^(?:\/\/|\/\*|\*|#)/.test(l)
              && (/(?:^|\s)(?:export|import|const|let|var|function|class|interface|type|enum|async|return)\b/.test(l) || /[{}();=]/.test(l))
            );
            if (codeLikeLines.length === 0) {
              return JSON.stringify({ error: 'Content is a placeholder or has no actual code — do NOT write placeholder comments. You must copy the exact real code blocks you want to extract (the definitions, constants, functions, methods, or classes you just read from read_file_slice) directly into this new file. Then call replace_in_file on the original file to replace that extracted block with an import statement or equivalent reference.' });
            }
          }
          return await this.createOrEditFile(createFilename, createContent);
        }
        case 'write_to_file':
          return await this.createOrEditFile(String(args.filepath ?? ''), String(args.content ?? ''));
        case 'replace_in_file':
          return await this.replaceInFile(String(args.filepath ?? ''), String(args.old_text ?? ''), String(args.new_text ?? ''));
        case 'execute_terminal_command':
          return await this.executeTerminalCommand(String(args.command ?? ''));
        case 'launch_in_terminal':
          return this.launchInTerminal(String(args.command ?? ''));
        case 'delete_file':
          return await this.deleteFile(String(args.filepath ?? ''));
        case 'list_workspace_files': {
          const depth = typeof args.maxDepth === 'number' ? Math.min(Math.max(1, args.maxDepth), 8) : 4;
          return await this.listWorkspaceFiles(String(args.directory ?? ''), depth);
        }
        case 'project_scan':
          return await this.projectScan();
        case 'read_workspace_notes':
          return await this.readWorkspaceNotes();
        case 'write_workspace_notes':
          this.workspaceSnapshotCache = null; // notes changed — invalidate structure cache too
          return await this.writeWorkspaceNotes(String(args.content ?? ''), String(args.mode ?? 'append'));
        default:
          return JSON.stringify({ error: `Unknown tool: ${name}` });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Tool execution failed.';
      return JSON.stringify({ error: message });
    }
  }

  private normalizeToolArguments(rawArguments: Record<string, unknown> | string | undefined): Record<string, unknown> {
    return normalizeToolArgumentsHelper(rawArguments);
  }

  private remapWeakModelToolName(name: string): string {
    return remapWeakModelToolNameHelper(name);
  }

  private remapWeakModelArgumentAliases(args: Record<string, unknown>): Record<string, unknown> {
    return remapWeakModelArgumentAliasesHelper(args);
  }

  private async resolveWorkspaceUriForOperation(targetPath: string, allowCreate = false): Promise<vscode.Uri> {
    const normalizedTarget = targetPath.trim();
    if (!normalizedTarget) {
      throw new Error('Path is required.');
    }

    if (path.isAbsolute(normalizedTarget)) {
      return vscode.Uri.file(normalizedTarget);
    }

    const directUri = this.resolveWorkspaceUri(normalizedTarget);
    try {
      await vscode.workspace.fs.stat(directUri);
      return directUri;
    } catch {
      // Fall through to existing-file resolution.
    }

    if (allowCreate) {
      const requestScopedCreateUri = await this.resolveRequestScopedCreateUri(normalizedTarget);
      return requestScopedCreateUri ?? directUri;
    }

    const existingPath = await this.resolveExistingWorkspacePath(normalizedTarget);
    if (existingPath) {
      return vscode.Uri.file(existingPath);
    }

    return directUri;
  }

  private async resolveRequestScopedCreateUri(targetPath: string): Promise<vscode.Uri | undefined> {
    const normalizedTarget = targetPath.trim().replace(/\\/g, '/');
    if (!normalizedTarget || normalizedTarget.includes('/')) {
      return undefined;
    }

    const latestVisibleUserRequest = this.getLatestVisibleUserRequest(this.messages);
    if (!latestVisibleUserRequest || !this.looksLikeLargeRefactorRequest(latestVisibleUserRequest)) {
      return undefined;
    }

    const requestTargets = this.extractLikelyRequestFileTargets(latestVisibleUserRequest);
    for (const requestTarget of requestTargets) {
      const resolvedTarget = await this.resolveExistingWorkspacePath(requestTarget);
      if (!resolvedTarget) {
        continue;
      }

      const preferredDir = path.dirname(resolvedTarget);
      return vscode.Uri.file(path.join(preferredDir, normalizedTarget));
    }

    const activeEditorPath = vscode.window.activeTextEditor?.document.uri.scheme === 'file'
      ? vscode.window.activeTextEditor.document.uri.fsPath
      : undefined;
    if (activeEditorPath) {
      return vscode.Uri.file(path.join(path.dirname(activeEditorPath), normalizedTarget));
    }

    return undefined;
  }

  private async readActiveFile(): Promise<string> {
    const editor = vscode.window.activeTextEditor;

    if (!editor) {
      return JSON.stringify({ error: 'No active text editor found.' });
    }

    const { document } = editor;
    const fsPath = document.uri.fsPath;
    const ext = path.extname(fsPath).toLowerCase();
    // Non-source files (logs, JSONL, generated JSON, lock files) should not be
    // treated as the user's project source. Warn the model so it uses list_workspace_files
    // to find the real source files instead.
    const isNonSource = /\.(?:jsonl|log|lock|map)$/.test(ext)
      || /(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.manulai[\/\\])/.test(fsPath);
    const base = JSON.stringify({
      path: fsPath,
      languageId: document.languageId,
      content: document.getText()
    });
    if (isNonSource) {
      const warning = `WARNING: The active file is "${path.basename(fsPath)}" which is a system/log file, not a project source file. Do NOT try to edit or split this file. Call list_workspace_files to find the actual project source files and work on those instead.`;
      try {
        const parsed = JSON.parse(base) as Record<string, unknown>;
        parsed.warning = warning;
        return JSON.stringify(parsed);
      } catch {
        return base;
      }
    }
    return base;
  }

  private isLargeRefactorScenario(): boolean {
    const latestUserRequest = this.getLatestVisibleUserRequest(this.messages);
    if (!latestUserRequest) {
      return false;
    }
    return this.looksLikeLargeRefactorRequest(latestUserRequest);
  }

  // Runs a compile/build check after a write tool succeeds.
  // Returns { ok, output } if a check was performed, null if the workspace has no build config
  // or the per-request verify cap (3) is reached.
  private async tryRunBuildVerify(messages: OllamaMessage[]): Promise<{ ok: boolean; output: string } | null> {
    const cap = 3;
    const verifyCount = messages.filter(m => m.tool_name === 'build_verify').length;
    if (verifyCount >= cap) {
      return null;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceRoot) {
      return null;
    }

    const exists = async (relativePath: string): Promise<boolean> => {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.joinPath(workspaceRoot, relativePath));
        return true;
      } catch {
        return false;
      }
    };

    const pickPackageManager = async (): Promise<'npm' | 'pnpm' | 'yarn' | 'bun'> => {
      if (await exists('pnpm-lock.yaml')) {
        return 'pnpm';
      }
      if (await exists('yarn.lock')) {
        return 'yarn';
      }
      if (await exists('bun.lockb') || await exists('bun.lock')) {
        return 'bun';
      }
      return 'npm';
    };

    const scriptCommand = (pm: 'npm' | 'pnpm' | 'yarn' | 'bun', scriptName: string): string => {
      if (pm === 'npm') {
        return `npm run ${scriptName} 2>&1 | head -30`;
      }
      if (pm === 'yarn') {
        return `yarn ${scriptName} 2>&1 | head -30`;
      }
      if (pm === 'pnpm') {
        return `pnpm ${scriptName} 2>&1 | head -30`;
      }
      return `bun run ${scriptName} 2>&1 | head -30`;
    };

    // Detect the best available verification command for the current stack.
    let command: string | undefined;
    try {
      const pkgBytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(workspaceRoot, 'package.json'));
      const pkg = JSON.parse(Buffer.from(pkgBytes).toString('utf8')) as Record<string, unknown>;
      const scripts = pkg.scripts as Record<string, string> | undefined;
      const packageManager = await pickPackageManager();
      if (scripts?.check) {
        command = scriptCommand(packageManager, 'check');
      } else if (scripts?.verify) {
        command = scriptCommand(packageManager, 'verify');
      } else if (scripts?.build) {
        command = scriptCommand(packageManager, 'build');
      } else if (scripts?.compile) {
        command = scriptCommand(packageManager, 'compile');
      } else if (scripts?.test) {
        command = scriptCommand(packageManager, 'test');
      }
    } catch {
      // no package.json or unreadable package.json
    }

    if (!command && await exists('tsconfig.json')) {
      command = 'npx tsc --noEmit 2>&1 | head -30';
    }
    if (!command && await exists('Cargo.toml')) {
      command = 'cargo check --quiet 2>&1 | head -30';
    }
    if (!command && await exists('go.mod')) {
      command = 'go test ./... 2>&1 | head -30';
    }
    if (!command && (await exists('pyproject.toml') || await exists('requirements.txt') || await exists('setup.py'))) {
      command = 'python -m compileall -q . 2>&1 | head -30';
    }
    if (!command && await exists('pom.xml')) {
      command = 'mvn -q -DskipTests compile 2>&1 | head -30';
    }
    if (!command && (await exists('build.gradle') || await exists('build.gradle.kts'))) {
      command = await exists('gradlew')
        ? './gradlew -q build -x test 2>&1 | head -30'
        : 'gradle -q build -x test 2>&1 | head -30';
    }
    if (!command) {
      const dotnetProjects = await vscode.workspace.findFiles('**/*.{sln,csproj}', '**/{node_modules,dist,build,out,.git,.manulai}/**', 1);
      if (dotnetProjects.length > 0) {
        command = 'dotnet build -nologo 2>&1 | head -30';
      }
    }

    if (!command) {
      return null;
    }

    try {
      const raw = await this.executeTerminalCommand(command);
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const stdout = String(parsed.stdout ?? '').trim();
      const stderr = String(parsed.stderr ?? '').trim();
      const output = [stdout, stderr].filter(Boolean).join('\n').trim();
      const exitCode = Number(parsed.exitCode ?? 1);
      return { ok: exitCode === 0, output };
    } catch {
      return null;
    }
  }

  // Returns a capped read result if the file exceeds maxLines, null otherwise (caller should do full read).
  private async readSpecificFileCapped(filepath: string, maxLines: number): Promise<string | null> {
    if (!filepath.trim()) {
      return null;
    }
    try {
      const uri = await this.resolveWorkspaceUriForOperation(filepath);
      const content = await this.readWorkspaceText(uri);
      const normalized = content.replace(/\r\n/g, '\n');
      const lines = normalized.length > 0 ? normalized.split('\n') : [];
      if (lines.length <= maxLines) {
        return null; // small enough, let the normal handler do it
      }
      const languageId = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString())?.languageId ?? 'plaintext';
      const cappedContent = lines.slice(0, maxLines).join('\n');
      this.debugLog('read_specific_file_capped', { path: uri.fsPath, totalLines: lines.length, cappedTo: maxLines });
      return JSON.stringify({
        path: uri.fsPath,
        languageId,
        startLine: 1,
        endLine: maxLines,
        totalLines: lines.length,
        content: cappedContent,
        warning: `File has ${lines.length} lines. Only lines 1-${maxLines} are shown. Use read_file_slice with explicit startLine and endLine to read the rest in bounded sections.`
      });
    } catch {
      return null;
    }
  }

  private async readSpecificFile(filepath: string): Promise<string> {
    if (!filepath.trim()) {
      return JSON.stringify({ error: 'filepath is required.' });
    }

    try {
      const uri = await this.resolveWorkspaceUriForOperation(filepath);
      const content = await this.readWorkspaceText(uri);
      const languageId = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString())?.languageId ?? 'plaintext';

      return JSON.stringify({
        path: uri.fsPath,
        languageId,
        content
      });
    } catch (error) {
      const recovered = await this.tryRecoverReadTargetUri(filepath);
      if (recovered) {
        try {
          const content = await this.readWorkspaceText(recovered);
          const languageId = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === recovered.toString())?.languageId ?? 'plaintext';
          this.debugLog('read_target_recovered', { requestedPath: filepath, recoveredPath: recovered.fsPath, tool: 'read_specific_file' });
          return JSON.stringify({
            path: recovered.fsPath,
            languageId,
            content,
            recoveredFromPath: filepath,
            note: this.buildRecoveredTargetNote(filepath, recovered.fsPath)
          });
        } catch {
          // Fall through to the original error below.
        }
      }

      return JSON.stringify({
        error: error instanceof Error ? error.message : 'Failed to read file.'
      });
    }
  }

  private async readFileSlice(filepath: string, startLine: unknown, endLine: unknown): Promise<string> {
    if (!filepath.trim()) {
      return JSON.stringify({ error: 'filepath is required.' });
    }

    // Default startLine to 1 and endLine to start+199 when the model omits them.
    // Treat undefined|null|'' as "omitted" so we never generate NaN for missing params.
    // Any other non-numeric value becomes NaN and is treated as invalid, returning an error.
    const rawStart = startLine === undefined || startLine === null || startLine === '' ? undefined : Number(startLine);
    const rawEnd = endLine === undefined || endLine === null || endLine === '' ? undefined : Number(endLine);
    const hasStart = rawStart !== undefined && Number.isFinite(rawStart);
    const hasEnd = rawEnd !== undefined && Number.isFinite(rawEnd);
    const startIsInvalid = rawStart !== undefined && !Number.isFinite(rawStart);
    const endIsInvalid = rawEnd !== undefined && !Number.isFinite(rawEnd);
    if (startIsInvalid || endIsInvalid) {
      return JSON.stringify({ error: 'startLine and endLine must be numbers.' });
    }

    const start = Math.max(1, Math.floor(hasStart ? rawStart : 1));
    const end = Math.max(1, Math.floor(hasEnd ? rawEnd : start + 199));
    if (end < start) {
      return JSON.stringify({ error: 'endLine must be greater than or equal to startLine.' });
    }

    try {
      const uri = await this.resolveWorkspaceUriForOperation(filepath);
      const content = await this.readWorkspaceText(uri);
      const languageId = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString())?.languageId ?? 'plaintext';
      const normalizedContent = content.replace(/\r\n/g, '\n');
      const lines = normalizedContent.length > 0 ? normalizedContent.split('\n') : [];
      const totalLines = lines.length;

      if (totalLines === 0) {
        return JSON.stringify({
          path: uri.fsPath,
          languageId,
          startLine: 1,
          endLine: 0,
          totalLines: 0,
          content: ''
        });
      }

      if (start > totalLines) {
        return JSON.stringify({
          path: uri.fsPath,
          languageId,
          startLine: start,
          endLine: totalLines,
          totalLines,
          content: '',
          note: `startLine ${start} is beyond the end of the file. Treat this as EOF for ${uri.fsPath}. Use the exact target path above for any follow-up reads or edits.`
        });
      }

      const clampedEnd = Math.min(end, totalLines);
      const slice = lines.slice(start - 1, clampedEnd).join('\n');

      return JSON.stringify({
        path: uri.fsPath,
        languageId,
        startLine: start,
        endLine: clampedEnd,
        totalLines,
        content: slice
      });
    } catch (error) {
      const recovered = await this.tryRecoverReadTargetUri(filepath);
      if (recovered) {
        try {
          const content = await this.readWorkspaceText(recovered);
          const languageId = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === recovered.toString())?.languageId ?? 'plaintext';
          const normalizedContent = content.replace(/\r\n/g, '\n');
          const lines = normalizedContent.length > 0 ? normalizedContent.split('\n') : [];
          const totalLines = lines.length;

          if (totalLines === 0) {
            this.debugLog('read_target_recovered', { requestedPath: filepath, recoveredPath: recovered.fsPath, tool: 'read_file_slice', startLine: start, endLine: end });
            return JSON.stringify({
              path: recovered.fsPath,
              languageId,
              startLine: 1,
              endLine: 0,
              totalLines: 0,
              content: '',
              recoveredFromPath: filepath,
              note: this.buildRecoveredTargetNote(filepath, recovered.fsPath)
            });
          }

          if (start > totalLines) {
            this.debugLog('read_target_recovered', { requestedPath: filepath, recoveredPath: recovered.fsPath, tool: 'read_file_slice', startLine: start, endLine: totalLines, eof: true });
            return JSON.stringify({
              path: recovered.fsPath,
              languageId,
              startLine: start,
              endLine: totalLines,
              totalLines,
              content: '',
              recoveredFromPath: filepath,
              note: `${this.buildRecoveredTargetNote(filepath, recovered.fsPath)} startLine ${start} is beyond the end of the file, so this is an EOF-style empty slice.`
            });
          }

          const clampedEnd = Math.min(end, totalLines);
          this.debugLog('read_target_recovered', { requestedPath: filepath, recoveredPath: recovered.fsPath, tool: 'read_file_slice', startLine: start, endLine: clampedEnd });
          return JSON.stringify({
            path: recovered.fsPath,
            languageId,
            startLine: start,
            endLine: clampedEnd,
            totalLines,
            content: lines.slice(start - 1, clampedEnd).join('\n'),
            recoveredFromPath: filepath,
            note: this.buildRecoveredTargetNote(filepath, recovered.fsPath)
          });
        } catch {
          // Fall through to the original error below.
        }
      }

      return JSON.stringify({
        error: error instanceof Error ? error.message : 'Failed to read file slice.'
      });
    }
  }

  private async tryRecoverReadTargetUri(filepath: string): Promise<vscode.Uri | undefined> {
    const normalizedPath = filepath.trim().replace(/\\/g, '/');
    if (!normalizedPath) {
      return undefined;
    }

    const basename = path.basename(normalizedPath);
    if (!basename) {
      return undefined;
    }

    const activeEditorPath = vscode.window.activeTextEditor?.document.uri.scheme === 'file'
      ? vscode.window.activeTextEditor.document.uri.fsPath
      : undefined;
    if (activeEditorPath && path.basename(activeEditorPath).toLowerCase() === basename.toLowerCase()) {
      return vscode.Uri.file(activeEditorPath);
    }

    const latestVisibleUserRequest = this.getLatestVisibleUserRequest(this.messages);
    const requestTargets = latestVisibleUserRequest ? this.extractLikelyRequestFileTargets(latestVisibleUserRequest) : [];
    for (const requestTarget of requestTargets) {
      const resolvedTarget = await this.findBestWorkspaceMatchForRequestTarget(requestTarget);
      if (resolvedTarget && path.basename(resolvedTarget).toLowerCase() === basename.toLowerCase()) {
        return vscode.Uri.file(resolvedTarget);
      }
    }

    const resolvedByBasename = await this.resolveExistingWorkspacePath(basename);
    if (resolvedByBasename && path.basename(resolvedByBasename).toLowerCase() === basename.toLowerCase()) {
      return vscode.Uri.file(resolvedByBasename);
    }

    return undefined;
  }

  private buildRecoveredTargetNote(requestedPath: string, resolvedPath: string): string {
    return `Recovered requested path ${requestedPath} to exact target ${resolvedPath}. Use this exact target path for subsequent read and edit calls.`;
  }

  private async createOrEditFile(filename: string, content: string): Promise<string> {
    if (!filename.trim()) {
      return JSON.stringify({ error: 'filename is required.' });
    }

    try {
      const targetUri = await this.resolveWorkspaceUriForOperation(filename, true);
      const pathGuardError = await this.validateRequestScopedCreatePath(filename, targetUri.fsPath);
      if (pathGuardError) {
        return JSON.stringify({ error: pathGuardError });
      }

      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(targetUri.fsPath)));

      let sanitizedContent = this.sanitizeGeneratedFileContent(content);
      if (this.looksLikeDiffOutput(sanitizedContent)) {
        sanitizedContent = this.stripDiffPrefixes(sanitizedContent);
      }
      if (isPlaceholderReplacementText(sanitizedContent) && !this.requestExplicitlyAllowsPlaceholderWrites()) {
        return JSON.stringify({
          error: 'Blocked write: content is only a placeholder or stub comment, not real file content. Write the actual implementation instead.'
        });
      }
      const invalidStructuredContent = detectInvalidStructuredCreateContent(targetUri.fsPath, sanitizedContent);
      if (invalidStructuredContent) {
        return JSON.stringify({ error: invalidStructuredContent });
      }
      const invalidGeneratedModuleContent = validateGeneratedModuleContent(targetUri.fsPath, sanitizedContent);
      if (invalidGeneratedModuleContent) {
        return JSON.stringify({ error: invalidGeneratedModuleContent });
      }

      // Guard against destructive writes from tool calls
      const displayName = path.basename(targetUri.fsPath);
      let oldContent: string | undefined;
      try { oldContent = await this.readWorkspaceText(targetUri); } catch { /* new file */ }
      if (this.looksLikeToolCallContent(sanitizedContent)) {
        return JSON.stringify({ error: `Blocked: content is a tool-call definition, not file content.` });
      }
      const destructiveGuard = this.detectDestructiveWrite(displayName, sanitizedContent, oldContent);
      if (destructiveGuard) {
        return JSON.stringify({ error: `Blocked write to ${displayName}: ${destructiveGuard}` });
      }

      await this.writeWorkspaceText(targetUri, sanitizedContent);
      this.workspaceSnapshotCache = null; // file structure may have changed

      const revertOperationId = oldContent !== undefined && oldContent !== sanitizedContent
        ? this.createRevertSnapshot(targetUri.fsPath, oldContent, sanitizedContent)
        : undefined;
      const diff = oldContent !== undefined && oldContent !== sanitizedContent
        ? this.buildDiffSummary(displayName, oldContent, sanitizedContent)
        : undefined;

      return JSON.stringify({
        path: targetUri.fsPath,
        bytesWritten: Buffer.byteLength(sanitizedContent, 'utf8'),
        preview: oldContent === undefined || !oldContent.trim() ? buildPreviewSnippet(sanitizedContent) : undefined,
        diff,
        revertOperationId
      });
    } catch (error) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : 'Failed to write file.'
      });
    }
  }

  private async deleteFile(filepath: string): Promise<string> {
    if (!filepath.trim()) {
      return JSON.stringify({ error: 'filepath is required.' });
    }

    try {
      const uri = await this.resolveWorkspaceUriForOperation(filepath);
      await vscode.workspace.fs.delete(uri);
      this.workspaceSnapshotCache = null;
      return JSON.stringify({ deleted: uri.fsPath });
    } catch (error) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : 'Failed to delete file.'
      });
    }
  }

  private async buildCompactWorkspaceTree(): Promise<string> {
    if (this.workspaceSnapshotCache !== null) { return this.workspaceSnapshotCache; }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) { return ''; }

    const capabilityProfile = this.getModelCapabilityProfile();

    const IGNORED = new Set([
      'node_modules', '.git', '.hg', '.svn', 'dist', 'out', 'build', '.next', '.nuxt',
      '__pycache__', '.cache', '.turbo', '.parcel-cache', 'coverage', '.nyc_output',
      '.manulai', 'logs', '.venv', 'venv', '.tox'
    ]);
    const MAX_DEPTH = capabilityProfile.workspaceTreeMaxDepth;
    const FILE_CAP = capabilityProfile.workspaceTreeFileCap;
    let count = 0;
    const lines: string[] = [];

    const walk = async (uri: vscode.Uri, indent: string, depth: number): Promise<void> => {
      if (count >= FILE_CAP || depth > MAX_DEPTH) { return; }
      let entries: [string, vscode.FileType][];
      try { entries = await vscode.workspace.fs.readDirectory(uri); } catch { return; }
      entries.sort(([a, at], [b, bt]) =>
        at === bt ? a.localeCompare(b) : at === vscode.FileType.Directory ? -1 : 1
      );
      for (const [name, type] of entries) {
        if (count >= FILE_CAP) { lines.push(`${indent}...`); break; }
        if (type === vscode.FileType.Directory) {
          if (IGNORED.has(name) || name.startsWith('.')) { continue; }
          lines.push(`${indent}${name}/`);
          await walk(vscode.Uri.joinPath(uri, name), indent + '  ', depth + 1);
        } else {
          lines.push(`${indent}${name}`);
          count++;
        }
      }
    };

    await walk(root, '', 1);
    this.workspaceSnapshotCache = lines.join('\n');
    return this.workspaceSnapshotCache;
  }

  private getChatNotesUri(chatId?: string): vscode.Uri | undefined {
    const dir = this.getWorkspaceSettingsDirUri();
    if (!dir) { return undefined; }
    const id = chatId ?? this.activeChatId;
    return vscode.Uri.joinPath(dir, 'notes', `${id}.md`);
  }

  private async readWorkspaceNotes(): Promise<string> {
    const uri = this.getChatNotesUri();
    if (!uri) { return JSON.stringify({ content: '(no workspace open)' }); }
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const content = Buffer.from(bytes).toString('utf8');
      return JSON.stringify({ content: content || '(empty)' });
    } catch {
      return JSON.stringify({ content: '(no notes yet — use write_workspace_notes to save notes for this chat)' });
    }
  }

  private async writeWorkspaceNotes(content: string, mode: string): Promise<string> {
    const dir = this.getWorkspaceSettingsDirUri();
    const uri = this.getChatNotesUri();
    if (!dir || !uri) { return JSON.stringify({ error: 'No workspace open.' }); }
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(dir, 'notes'));
      let finalContent = content;
      if (mode === 'append') {
        let existing = '';
        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          existing = Buffer.from(bytes).toString('utf8');
        } catch { /* no existing file yet */ }
        finalContent = existing ? existing.trimEnd() + '\n\n' + content : content;
      }
      await vscode.workspace.fs.writeFile(uri, Buffer.from(finalContent, 'utf8'));
      return JSON.stringify({ success: true, note: 'Notes saved for this chat.' });
    } catch (error) {
      return JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to write notes.' });
    }
  }

  private async projectScan(): Promise<string> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceRoot) {
      return JSON.stringify({ error: 'No workspace open.' });
    }

    const readTextIfExists = async (relativePath: string): Promise<string | undefined> => {
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(workspaceRoot, relativePath));
        return Buffer.from(bytes).toString('utf8');
      } catch {
        return undefined;
      }
    };

    const extractTomlAssignments = (text: string, sectionNames: string[]): Array<{ key: string; value: string }> => {
      const sections = new Set(sectionNames.map(name => name.toLowerCase()));
      const results: Array<{ key: string; value: string }> = [];
      let activeSection = '';
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) {
          continue;
        }
        const sectionMatch = line.match(/^\[(.+?)\]$/);
        if (sectionMatch) {
          activeSection = sectionMatch[1].trim().toLowerCase();
          continue;
        }
        if (!sections.has(activeSection)) {
          continue;
        }
        const assignmentMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*["']?([^"']+)["']?$/);
        if (assignmentMatch) {
          results.push({ key: assignmentMatch[1], value: assignmentMatch[2].trim() });
        }
      }
      return results;
    };

    const addUniqueMatches = (target: Set<string>, values: Iterable<string>): void => {
      for (const value of values) {
        const trimmed = value.trim();
        if (trimmed) {
          target.add(trimmed);
        }
      }
    };

    const topLevelEntries = await vscode.workspace.fs.readDirectory(workspaceRoot);
    const topLevelNames = new Set(topLevelEntries.map(([name]) => name));
    const projectTypes = new Set<string>();
    const languageHints = new Set<string>();
    const frameworkHints = new Set<string>();
    const keyFiles: string[] = [];
    const entryPoints = new Set<string>();
    const importantModules = new Set<string>();
    const notes: string[] = [];
    let packageManager = 'unknown';

    const knownKeyFiles = [
      'package.json', 'tsconfig.json', 'README.md', 'README-dev.md', 'Cargo.toml', 'go.mod',
      'pyproject.toml', 'requirements.txt', 'Gemfile', 'pom.xml', 'build.gradle', 'build.gradle.kts',
      'settings.gradle', 'settings.gradle.kts', 'composer.json', 'Package.swift', 'CMakeLists.txt',
      'Makefile', 'meson.build', '.csproj', '.sln', 'global.json'
    ];
    for (const file of knownKeyFiles) {
      if (topLevelNames.has(file)) {
        keyFiles.push(file);
      }
    }

    if (topLevelNames.has('pnpm-lock.yaml')) {
      packageManager = 'pnpm';
      languageHints.add('javascript');
      languageHints.add('typescript');
    } else if (topLevelNames.has('yarn.lock')) {
      packageManager = 'yarn';
      languageHints.add('javascript');
      languageHints.add('typescript');
    } else if (topLevelNames.has('package-lock.json')) {
      packageManager = 'npm';
      languageHints.add('javascript');
      languageHints.add('typescript');
    } else if (topLevelNames.has('bun.lockb') || topLevelNames.has('bun.lock')) {
      packageManager = 'bun';
      languageHints.add('javascript');
      languageHints.add('typescript');
    } else if (topLevelNames.has('Cargo.toml')) {
      packageManager = 'cargo';
      languageHints.add('rust');
    } else if (topLevelNames.has('go.mod')) {
      packageManager = 'go';
      languageHints.add('go');
    } else if (topLevelNames.has('pyproject.toml') || topLevelNames.has('requirements.txt')) {
      packageManager = 'python';
      languageHints.add('python');
    } else if (topLevelNames.has('composer.json')) {
      packageManager = 'composer';
      languageHints.add('php');
    } else if (topLevelNames.has('Gemfile')) {
      packageManager = 'bundler';
      languageHints.add('ruby');
    } else if (topLevelNames.has('pom.xml')) {
      packageManager = 'maven';
      languageHints.add('java');
    } else if (topLevelNames.has('build.gradle') || topLevelNames.has('build.gradle.kts')) {
      packageManager = 'gradle';
      languageHints.add('java');
      languageHints.add('kotlin');
    } else if (topLevelNames.has('Package.swift')) {
      packageManager = 'swiftpm';
      languageHints.add('swift');
    }

    if (topLevelNames.has('package.json')) {
      try {
        const packageBytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(workspaceRoot, 'package.json'));
        const pkg = JSON.parse(Buffer.from(packageBytes).toString('utf8')) as Record<string, unknown>;
        const dependencies = {
          ...((pkg.dependencies && typeof pkg.dependencies === 'object' && !Array.isArray(pkg.dependencies)) ? pkg.dependencies as Record<string, unknown> : {}),
          ...((pkg.devDependencies && typeof pkg.devDependencies === 'object' && !Array.isArray(pkg.devDependencies)) ? pkg.devDependencies as Record<string, unknown> : {})
        };
        const dependencyNames = Object.keys(dependencies);
        if (typeof pkg.main === 'string') {
          entryPoints.add(pkg.main);
        }
        if (typeof pkg.module === 'string') {
          entryPoints.add(pkg.module);
        }
        if (typeof pkg.browser === 'string') {
          entryPoints.add(pkg.browser);
        }
        if (typeof pkg.types === 'string') {
          importantModules.add(pkg.types);
          languageHints.add('typescript');
        }
        if (pkg.engines && typeof pkg.engines === 'object' && !Array.isArray(pkg.engines) && typeof (pkg.engines as Record<string, unknown>).vscode === 'string') {
          projectTypes.add('vscode-extension');
        }
        if (Array.isArray(pkg.activationEvents)) {
          projectTypes.add('tool-driven-extension');
        }
        if (dependencyNames.some(name => ['react', 'next', 'vite', 'vue', 'svelte', 'angular'].includes(name))) {
          projectTypes.add('webapp');
        }
        if (dependencyNames.some(name => ['express', 'fastify', 'koa', 'nest', '@nestjs/core'].includes(name))) {
          projectTypes.add('backend-service');
        }
        if (dependencyNames.includes('react')) {
          frameworkHints.add('react');
        }
        if (dependencyNames.includes('next')) {
          frameworkHints.add('next');
        }
        if (dependencyNames.includes('@nestjs/core')) {
          frameworkHints.add('nestjs');
        }
        if (dependencyNames.includes('vue')) {
          frameworkHints.add('vue');
        }
        if (dependencyNames.includes('svelte')) {
          frameworkHints.add('svelte');
        }
        if (dependencyNames.includes('angular') || dependencyNames.includes('@angular/core')) {
          frameworkHints.add('angular');
        }
        if (pkg.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts)) {
          const scriptNames = Object.keys(pkg.scripts as Record<string, unknown>);
          if (scriptNames.length > 0) {
            notes.push(`package.json scripts: ${scriptNames.slice(0, 8).join(', ')}`);
          }
        }
      } catch {
        notes.push('package.json exists but could not be parsed');
      }
    }

    if (topLevelNames.has('pyproject.toml')) {
      projectTypes.add('python-project');
      languageHints.add('python');
    }
    if (topLevelNames.has('requirements.txt')) {
      languageHints.add('python');
    }
    if (topLevelNames.has('Cargo.toml')) {
      projectTypes.add('rust-project');
    }
    if (topLevelNames.has('go.mod')) {
      projectTypes.add('go-project');
    }
    if (topLevelNames.has('pom.xml') || topLevelNames.has('build.gradle') || topLevelNames.has('build.gradle.kts')) {
      projectTypes.add('jvm-project');
    }
    if (topLevelNames.has('composer.json')) {
      projectTypes.add('php-project');
    }
    if (topLevelNames.has('Gemfile')) {
      projectTypes.add('ruby-project');
    }
    if (topLevelNames.has('Package.swift')) {
      projectTypes.add('swift-project');
    }
    if (topLevelNames.has('CMakeLists.txt') || topLevelNames.has('meson.build')) {
      projectTypes.add('native-project');
      languageHints.add('c/c++');
    }
    if (Array.from(topLevelNames).some(name => name.endsWith('.sln') || name.endsWith('.csproj'))) {
      projectTypes.add('.net-project');
      languageHints.add('c#');
    }

    const pyprojectText = await readTextIfExists('pyproject.toml');
    if (pyprojectText) {
      if (/\bdjango\b/i.test(pyprojectText)) {
        frameworkHints.add('django');
      }
      if (/\bfastapi\b/i.test(pyprojectText)) {
        frameworkHints.add('fastapi');
      }
      if (/\bflask\b/i.test(pyprojectText)) {
        frameworkHints.add('flask');
      }
      const scriptAssignments = extractTomlAssignments(pyprojectText, ['project.scripts', 'tool.poetry.scripts']);
      addUniqueMatches(entryPoints, scriptAssignments.map(item => `${item.key} -> ${item.value}`));
      const packageNameMatch = pyprojectText.match(/^[ \t]*name\s*=\s*["']([^"']+)["']/m);
      if (packageNameMatch) {
        notes.push(`pyproject package: ${packageNameMatch[1]}`);
      }
    }

    const requirementsText = await readTextIfExists('requirements.txt');
    if (requirementsText) {
      const requirementNames = requirementsText
        .split(/\r?\n/)
        .map(line => line.replace(/#.*/, '').trim())
        .filter(Boolean)
        .map(line => line.split(/[<>=!~\[]/, 1)[0].trim().toLowerCase());
      if (requirementNames.includes('django')) {
        frameworkHints.add('django');
      }
      if (requirementNames.includes('fastapi')) {
        frameworkHints.add('fastapi');
      }
      if (requirementNames.includes('flask')) {
        frameworkHints.add('flask');
      }
    }

    const pomFiles = await vscode.workspace.findFiles('**/pom.xml', '**/{node_modules,dist,build,out,.git,.manulai}/**', 6);
    for (const pomFile of pomFiles) {
      try {
        const pomText = Buffer.from(await vscode.workspace.fs.readFile(pomFile)).toString('utf8');
        if (/spring-boot|org\.springframework/i.test(pomText)) {
          frameworkHints.add('spring');
        }
        const mainClassMatches = Array.from(pomText.matchAll(/<(?:start-class|mainClass)>\s*([^<]+)\s*<\//g)).map(match => match[1].trim());
        addUniqueMatches(entryPoints, mainClassMatches);
        const moduleMatches = Array.from(pomText.matchAll(/<module>\s*([^<]+)\s*<\/module>/g)).map(match => match[1].trim());
        addUniqueMatches(importantModules, moduleMatches.map(module => `module:${module}`));
      } catch {
        // ignore unreadable pom.xml
      }
    }

    const gradleFiles = await vscode.workspace.findFiles('**/build.gradle*', '**/{node_modules,dist,build,out,.git,.manulai}/**', 8);
    for (const gradleFile of gradleFiles) {
      try {
        const gradleText = Buffer.from(await vscode.workspace.fs.readFile(gradleFile)).toString('utf8');
        if (/spring-boot|org\.springframework/i.test(gradleText)) {
          frameworkHints.add('spring');
        }
        const mainClassMatches = Array.from(gradleText.matchAll(/mainClass(?:Name)?(?:\.set)?\s*[=\(]\s*["']([^"']+)["']/g)).map(match => match[1].trim());
        addUniqueMatches(entryPoints, mainClassMatches);
      } catch {
        // ignore unreadable build.gradle
      }
    }

    const solutionFiles = await vscode.workspace.findFiles('**/*.{csproj,sln}', '**/{node_modules,dist,build,out,.git,.manulai}/**', 10);
    for (const solutionFile of solutionFiles) {
      try {
        const solutionText = Buffer.from(await vscode.workspace.fs.readFile(solutionFile)).toString('utf8');
        if (/Microsoft\.NET\.Sdk\.Web|AspNetCore/i.test(solutionText)) {
          frameworkHints.add('aspnet');
        }
        if (solutionFile.fsPath.endsWith('.csproj')) {
          const relative = path.relative(workspaceRoot.fsPath, solutionFile.fsPath).replace(/\\/g, '/');
          importantModules.add(relative);
        }
      } catch {
        // ignore unreadable solution files
      }
    }

    const cargoText = await readTextIfExists('Cargo.toml');
    if (cargoText) {
      const packageNameMatch = cargoText.match(/^name\s*=\s*["']([^"']+)["']/m);
      if (packageNameMatch) {
        notes.push(`cargo package: ${packageNameMatch[1]}`);
      }
      const binPathMatches = Array.from(cargoText.matchAll(/^path\s*=\s*["']([^"']+)["']/gm)).map(match => match[1].trim());
      addUniqueMatches(entryPoints, binPathMatches);
      const workspaceMembersMatch = cargoText.match(/members\s*=\s*\[([\s\S]*?)\]/m);
      if (workspaceMembersMatch) {
        const members = Array.from(workspaceMembersMatch[1].matchAll(/["']([^"']+)["']/g)).map(match => match[1].trim());
        addUniqueMatches(importantModules, members.map(member => `crate:${member}`));
      }
      if (/\baxum\b/i.test(cargoText)) {
        frameworkHints.add('axum');
      }
      if (/\bactix-web\b/i.test(cargoText)) {
        frameworkHints.add('actix-web');
      }
      if (/\brocket\b/i.test(cargoText)) {
        frameworkHints.add('rocket');
      }
    }

    const goModText = await readTextIfExists('go.mod');
    if (goModText) {
      const moduleMatch = goModText.match(/^module\s+(.+)$/m);
      if (moduleMatch) {
        notes.push(`go module: ${moduleMatch[1].trim()}`);
        importantModules.add(moduleMatch[1].trim());
      }
      if (/github\.com\/gin-gonic\/gin/i.test(goModText)) {
        frameworkHints.add('gin');
      }
      if (/github\.com\/gofiber\/fiber/i.test(goModText)) {
        frameworkHints.add('fiber');
      }
      if (/github\.com\/labstack\/echo/i.test(goModText)) {
        frameworkHints.add('echo');
      }
      if (/github\.com\/go-chi\/chi/i.test(goModText)) {
        frameworkHints.add('chi');
      }
    }

    const candidateEntries = [
      'src/extension.ts', 'src/extension.js', 'src/index.ts', 'src/index.js', 'src/main.ts', 'src/main.js',
      'src/App.tsx', 'src/app.ts', 'app.py', 'main.py', 'manage.py', 'wsgi.py', 'asgi.py',
      'server.js', 'server.ts', 'main.go', 'cmd/main.go', 'src/main.rs', 'main.rs',
      'src/main/java/Main.java', 'src/main/kotlin/Main.kt', 'Program.cs', 'src/Program.cs',
      'index.php', 'public/index.php', 'config/routes.rb', 'main.swift', 'Sources/main.swift',
      'src/main.c', 'src/main.cpp'
    ];
    for (const candidate of candidateEntries) {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.joinPath(workspaceRoot, candidate));
        entryPoints.add(candidate);
      } catch {
        // ignore missing candidates
      }
    }

    for (const [name, type] of topLevelEntries) {
      if (type === vscode.FileType.Directory && !name.startsWith('.') && !['node_modules', 'dist', 'build', 'out', 'coverage', '.manulai'].includes(name)) {
        importantModules.add(`${name}/`);
      }
    }

    if (topLevelNames.has('src')) {
      try {
        const srcEntries = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(workspaceRoot, 'src'));
        for (const [name, type] of srcEntries.slice(0, 12)) {
          importantModules.add(type === vscode.FileType.Directory ? `src/${name}/` : `src/${name}`);
          const lower = name.toLowerCase();
          if (lower.endsWith('.py')) { languageHints.add('python'); }
          if (lower.endsWith('.go')) { languageHints.add('go'); }
          if (lower.endsWith('.rs')) { languageHints.add('rust'); }
          if (lower.endsWith('.java')) { languageHints.add('java'); }
          if (lower.endsWith('.kt')) { languageHints.add('kotlin'); }
          if (lower.endsWith('.cs')) { languageHints.add('c#'); }
          if (lower.endsWith('.php')) { languageHints.add('php'); }
          if (lower.endsWith('.rb')) { languageHints.add('ruby'); }
          if (lower.endsWith('.swift')) { languageHints.add('swift'); }
          if (lower.endsWith('.c') || lower.endsWith('.cpp') || lower.endsWith('.h') || lower.endsWith('.hpp')) { languageHints.add('c/c++'); }
          if (lower.endsWith('.ts') || lower.endsWith('.tsx')) { languageHints.add('typescript'); }
          if (lower.endsWith('.js') || lower.endsWith('.jsx')) { languageHints.add('javascript'); }
        }
      } catch {
        // ignore unreadable src
      }
    }

    if (topLevelNames.has('media')) {
      importantModules.add('media/');
    }

    const tree = await this.buildCompactWorkspaceTree();
    const summary = [
      languageHints.size > 0 ? `languages: ${Array.from(languageHints).join(', ')}` : undefined,
      frameworkHints.size > 0 ? `frameworks: ${Array.from(frameworkHints).join(', ')}` : undefined,
      projectTypes.size > 0 ? `project type hints: ${Array.from(projectTypes).join(', ')}` : undefined,
      packageManager !== 'unknown' ? `package manager: ${packageManager}` : undefined,
      entryPoints.size > 0 ? `entry points: ${Array.from(entryPoints).slice(0, 8).join(', ')}` : undefined,
      importantModules.size > 0 ? `important modules: ${Array.from(importantModules).slice(0, 12).join(', ')}` : undefined
    ].filter((value): value is string => Boolean(value)).join(' | ');

    return JSON.stringify({
      workspaceRoot: workspaceRoot.fsPath,
      packageManager,
      languages: Array.from(languageHints),
      frameworkHints: Array.from(frameworkHints),
      projectTypes: Array.from(projectTypes),
      keyFiles,
      entryPoints: Array.from(entryPoints),
      importantModules: Array.from(importantModules).slice(0, 20),
      notes,
      summary,
      tree
    });
  }

  private async listWorkspaceFiles(directory: string, maxDepth = 4): Promise<string> {
    const IGNORED_DIRS = new Set([
      'node_modules', '.git', '.hg', '.svn', 'dist', 'out', 'build', '.next', '.nuxt',
      '__pycache__', '.cache', '.turbo', '.parcel-cache', 'coverage', '.nyc_output',
      '.manulai', 'logs', '.venv', 'venv', '.tox'
    ]);
    const FILE_CAP = 400;
    let fileCount = 0;

    interface TreeEntry { name: string; type: 'file' | 'directory'; children?: TreeEntry[] }

    const readDir = async (uri: vscode.Uri, depth: number): Promise<TreeEntry[]> => {
      if (depth > maxDepth) { return []; }
      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(uri);
      } catch {
        return [];
      }
      entries.sort(([a, at], [b, bt]) => {
        // directories first, then alphabetical
        if (at === bt) { return a.localeCompare(b); }
        return at === vscode.FileType.Directory ? -1 : 1;
      });
      const result: TreeEntry[] = [];
      for (const [name, type] of entries) {
        if (fileCount >= FILE_CAP) { break; }
        if (type === vscode.FileType.Directory) {
          if (IGNORED_DIRS.has(name) || name.startsWith('.')) { continue; }
          const children = await readDir(vscode.Uri.joinPath(uri, name), depth + 1);
          result.push({ name, type: 'directory', children });
        } else {
          fileCount++;
          result.push({ name, type: 'file' });
        }
      }
      return result;
    };

    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        return JSON.stringify({ error: 'No workspace open.' });
      }

      const normalizedDirectory = directory.trim();
      const baseUri = !normalizedDirectory
        ? workspaceFolders[0].uri
        : path.isAbsolute(normalizedDirectory)
          ? vscode.Uri.file(normalizedDirectory)
          : vscode.Uri.joinPath(workspaceFolders[0].uri, normalizedDirectory);

      let rawEntryCount = 0;
      try {
        rawEntryCount = (await vscode.workspace.fs.readDirectory(baseUri)).length;
      } catch {
        rawEntryCount = 0;
      }

      fileCount = 0;
      const tree = await readDir(baseUri, 1);
      const capped = fileCount >= FILE_CAP;
      const hiddenOnlyNote = tree.length === 0 && rawEntryCount > 0
        ? 'Directory contains only hidden or ignored entries. It may still be valid to create a new source file here.'
        : undefined;

      return JSON.stringify({ path: baseUri.fsPath, tree, ...(capped ? { note: `Results capped at ${FILE_CAP} files. Use a subdirectory to narrow the listing.` } : {}), ...(hiddenOnlyNote ? { note: hiddenOnlyNote } : {}) });
    } catch (error) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : 'Failed to list directory.'
      });
    }
  }

  private async writeFileWithDiff(filepath: string, newContent: string): Promise<FileWriteSummary> {
    // Last-resort guard: never write raw tool-call JSON as file content
    if (this.looksLikeToolCallContent(newContent)) {
      return { summary: `Blocked write to ${path.basename(filepath)}: content is a tool-call definition, not file content.` };
    }

    const target = await this.resolveWorkspaceUriForOperation(filepath, true);
    const displayName = path.basename(target.fsPath);
    let sanitizedContent = this.sanitizeGeneratedFileContent(newContent);

    // Strip diff prefixes that leaked from model output
    if (this.looksLikeDiffOutput(sanitizedContent)) {
      sanitizedContent = this.stripDiffPrefixes(sanitizedContent);
    }

    // Read old content early so we can compare sizes for destructive write detection
    let oldContent: string | undefined;
    try {
      oldContent = await this.readWorkspaceText(target);
    } catch {
      // File doesn't exist yet — new file
    }

    // Block obviously destructive writes to structured files
    const destructiveGuard = this.detectDestructiveWrite(displayName, sanitizedContent, oldContent);
    if (destructiveGuard) {
      this.debugLog('destructive_write_blocked', { filepath, reason: destructiveGuard, contentLength: sanitizedContent.length, oldContentLength: oldContent?.length });
      return { summary: `Blocked write to ${displayName}: ${destructiveGuard}` };
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
      const preview = buildPreviewSnippet(sanitizedContent);
      return { summary: `Created ${displayName} (${lineCount} lines)${preview ? `\n\n\`\`\`text\n${preview}\n\`\`\`` : ''}` };
    }

    if (!oldContent.trim() && sanitizedContent.trim()) {
      const lineCount = sanitizedContent.split('\n').length;
      const preview = buildPreviewSnippet(sanitizedContent);
      return {
        summary: `Filled empty ${displayName} (${lineCount} lines)${preview ? `\n\n\`\`\`text\n${preview}\n\`\`\`` : ''}`,
        revertOperationId: this.createRevertSnapshot(target.fsPath, oldContent, sanitizedContent)
      };
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

  private extractToolResultRevertOperationIds(toolResult: string): string[] {
    try {
      const parsed = JSON.parse(toolResult) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return [];
      }

      const result = parsed as Record<string, unknown>;
      const operationIds = [
        ...(typeof result.revertOperationId === 'string' ? [result.revertOperationId] : []),
        ...(Array.isArray(result.revertOperationIds) ? result.revertOperationIds.filter((value): value is string => typeof value === 'string') : [])
      ];
      return Array.from(new Set(operationIds.filter(operationId => this.revertSnapshots.has(operationId))));
    } catch {
      return [];
    }
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

  private buildReplacementDiffSummary(displayName: string, oldText: string, newText: string): string {
    const oldPreview = buildPreviewSnippet(oldText);
    const newPreview = buildPreviewSnippet(newText);
    const oldLineCount = oldText.replace(/\r\n/g, '\n').split('\n').length;
    const newLineCount = newText.replace(/\r\n/g, '\n').split('\n').length;

    return [
      `Updated **${displayName}** — replaced 1 matched block (${oldLineCount} lines -> ${newLineCount} lines):`,
      '```diff',
      ...oldPreview.split('\n').filter(Boolean).map(line => `-${line}`),
      ...newPreview.split('\n').filter(Boolean).map(line => `+${line}`),
      '```'
    ].join('\n');
  }

  private buildRevertAction(operationIds: string[] | undefined): WebviewRenderableMessage['revertAction'] {
    const availableRevertOperations = (operationIds ?? [])
      .map(operationId => this.revertSnapshots.get(operationId))
      .filter((snapshot): snapshot is RevertSnapshot => Boolean(snapshot && !snapshot.reverted));

    if (availableRevertOperations.length === 0) {
      return undefined;
    }

    return {
      operationIds: availableRevertOperations.map(snapshot => snapshot.id),
      label: availableRevertOperations.length > 1 ? `Revert ${availableRevertOperations.length} changes` : 'Revert changes',
      details: Array.from(new Set(availableRevertOperations.map(snapshot => snapshot.displayName))).join(', ')
    };
  }

  private getOpenDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());
  }

  private async readWorkspaceText(uri: vscode.Uri): Promise<string> {
    // Guard against reading directories — they cause EISDIR
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type & vscode.FileType.Directory) {
        throw new Error(`Cannot read directory as text: ${uri.fsPath}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Cannot read directory')) {
        throw error;
      }
      // stat failed — let readFile below produce the real error
    }

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
    // Block no-op replaces — identical old and new text means nothing was actually changed.
    // For large refactors this commonly happens when the model confuses "extract" with "edit".
    if (oldText.trim() === newText.trim()) {
      return JSON.stringify({
        error: 'old_text and new_text are identical — this replace would make no change to the file. This is wrong for a refactor task. To split the file into smaller modules, you must: (1) call create_or_edit_file with a new sibling file path such as types.ts next to the target file and the exact code block you are extracting; (2) call replace_in_file with old_text set to that extracted block and new_text set to an import statement. Never pass the same text as both old_text and new_text.'
      });
    }
    if (this.isLargeRefactorScenario() && isPlaceholderReplacementText(newText)) {
      return JSON.stringify({
        error: 'new_text is a placeholder comment, not a valid extraction replacement. Replace the original block with the correct module reference or equivalent real code update — never with "Code will be inserted here".'
      });
    }

    try {
      const recoveredTarget = await this.recoverRequestScopedTargetPath(filepath);
      const target = recoveredTarget.resolvedPath
        ? vscode.Uri.file(recoveredTarget.resolvedPath)
        : await this.resolveWorkspaceUriForOperation(filepath);
      const original = await this.readWorkspaceText(target);
      const occurrences = original.split(oldText).length - 1;

      if (occurrences === 0) {
        const replaceFailure = this.analyzeReplaceNotFound(original, oldText);
        return JSON.stringify({
          error: replaceFailure.neverPresentInTarget
            ? 'old_text not found in file. The block you tried to replace does not appear anywhere in the target file. Do NOT guess or copy code from the extracted module as old_text.'
            : 'old_text not found in file. Make sure it matches exactly, including whitespace.',
          suggestedReadSlice: replaceFailure.suggestedReadSlice,
          neverPresentInTarget: replaceFailure.neverPresentInTarget,
          ...(recoveredTarget.recoveredFrom
            ? { note: `Recovered requested path ${recoveredTarget.recoveredFrom} to exact target ${target.fsPath}. Use this exact target path for subsequent replace_in_file calls.` }
            : {})
        });
      }
      if (occurrences > 1) {
        return JSON.stringify({ error: `old_text matched ${occurrences} times. Add more surrounding context so it matches exactly once.` });
      }

      const updated = original.replace(oldText, newText);
      await this.writeWorkspaceText(target, updated);
      const revertOperationId = this.createRevertSnapshot(target.fsPath, original, updated);
      const diff = this.buildReplacementDiffSummary(path.basename(target.fsPath), oldText, newText);

      return JSON.stringify({
        path: target.fsPath,
        replacements: 1,
        bytesWritten: Buffer.byteLength(updated, 'utf8'),
        diff,
        revertOperationId,
        ...(recoveredTarget.recoveredFrom
          ? { note: `Recovered requested path ${recoveredTarget.recoveredFrom} to exact target ${target.fsPath}.` }
          : {})
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
      const diff = this.buildDiffSummary(path.basename(target.fsPath), original, updated);

      return JSON.stringify({
        path: target.fsPath,
        replacements: occurrences,
        bytesWritten: Buffer.byteLength(updated, 'utf8'),
        diff
      });
    } catch (error) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : 'Failed to replace text in file.'
      });
    }
  }

  private analyzeReplaceNotFound(
    originalContent: string,
    attemptedOldText: string
  ): { suggestedReadSlice?: { startLine: number; endLine: number }; neverPresentInTarget: boolean } {
    const originalLines = originalContent.replace(/\r\n/g, '\n').split('\n');
    const attemptedLines = attemptedOldText.replace(/\r\n/g, '\n').split('\n');
    const anchorCandidates = attemptedLines
      .map(line => line.trim())
      .filter(line => line.length >= 8);
    const neverPresentInTarget = !anchorCandidates.some(candidate => originalLines.some(line => line.includes(candidate)));

    return {
      suggestedReadSlice: this.suggestReadSliceForReplaceFailure(originalContent, attemptedOldText),
      neverPresentInTarget
    };
  }

  private suggestReadSliceForReplaceFailure(originalContent: string, attemptedOldText: string): { startLine: number; endLine: number } | undefined {
    const originalLines = originalContent.replace(/\r\n/g, '\n').split('\n');
    const attemptedLines = attemptedOldText.replace(/\r\n/g, '\n').split('\n');
    const anchorCandidates = attemptedLines
      .map(line => line.trim())
      .filter(line => line.length >= 8);

    if (originalLines.length === 0 || anchorCandidates.length === 0) {
      return undefined;
    }

    let anchorIndex = -1;
    for (const candidate of anchorCandidates) {
      anchorIndex = originalLines.findIndex(line => line.includes(candidate));
      if (anchorIndex >= 0) {
        break;
      }
    }

    if (anchorIndex < 0) {
      return undefined;
    }

    const attemptedNonEmptyLineCount = attemptedLines.filter(line => line.trim().length > 0).length;
    const contextSpan = Math.max(40, attemptedNonEmptyLineCount + 16);
    const startLine = Math.max(1, anchorIndex + 1 - 4);
    const endLine = Math.min(originalLines.length, startLine + contextSpan - 1);
    return { startLine, endLine };
  }

  private suggestNextLargeRefactorSlice(
    recentToolResults: Array<{ message: OllamaMessage & { role: 'tool' }; parsed: Record<string, unknown>; index: number }>,
    targetPaths: string[]
  ): { filepath: string; startLine: number; endLine: number } | undefined {
    let fallbackRead: { filepath: string; startLine: number; endLine: number } | undefined;

    for (let index = recentToolResults.length - 1; index >= 0; index -= 1) {
      const { message, parsed } = recentToolResults[index];
      if (parsed.error) {
        continue;
      }

      const filepath = typeof parsed.path === 'string' ? parsed.path : '';
      if (!filepath || (targetPaths.length > 0 && !toolResultMatchesAnyTargetPath(filepath, targetPaths))) {
        continue;
      }

      if (message.tool_name === 'read_file_slice') {
        const endLine = Number(parsed.endLine ?? 0);
        const totalLines = Number(parsed.totalLines ?? 0);
        if (Number.isFinite(endLine) && endLine > 0 && Number.isFinite(totalLines) && totalLines > 0) {
          const startLine = Math.min(totalLines, endLine + 1);
          const suggestedEndLine = Math.min(totalLines, startLine + 119);
          if (startLine <= suggestedEndLine) {
            return { filepath, startLine, endLine: suggestedEndLine };
          }
        }
      }

      if ((message.tool_name === 'read_specific_file' || message.tool_name === 'read_active_file') && !fallbackRead) {
        fallbackRead = { filepath, startLine: 1, endLine: 120 };
      }
    }

    return fallbackRead;
  }

  private resetNarratedBootstrapState(): void {
    this.repeatedNarratedToolSignature = null;
    this.repeatedNarratedToolCount = 0;
  }

  private recordNarratedBootstrapSignature(signature: string | undefined): number {
    if (!signature) {
      this.resetNarratedBootstrapState();
      return 0;
    }

    if (this.repeatedNarratedToolSignature === signature) {
      this.repeatedNarratedToolCount += 1;
    } else {
      this.repeatedNarratedToolSignature = signature;
      this.repeatedNarratedToolCount = 1;
    }

    return this.repeatedNarratedToolCount;
  }

  private getLatestSuccessfulReadContext(
    recentToolResults: Array<{ message: OllamaMessage & { role: 'tool' }; parsed: Record<string, unknown>; index: number }>,
    targetPaths: string[]
  ): { filepath: string; startLine: number; endLine: number; totalLines: number; content: string } | undefined {
    for (let index = recentToolResults.length - 1; index >= 0; index -= 1) {
      const { message, parsed } = recentToolResults[index];
      if (parsed.error) {
        continue;
      }
      if (message.tool_name !== 'read_active_file' && message.tool_name !== 'read_specific_file' && message.tool_name !== 'read_file_slice') {
        continue;
      }
      const filepath = typeof parsed.path === 'string' ? parsed.path : '';
      if (!filepath || (targetPaths.length > 0 && !toolResultMatchesAnyTargetPath(filepath, targetPaths))) {
        continue;
      }
      return {
        filepath,
        startLine: Number(parsed.startLine ?? 1),
        endLine: Number(parsed.endLine ?? 1),
        totalLines: Number(parsed.totalLines ?? 0),
        content: String(parsed.content ?? '')
      };
    }
    return undefined;
  }

  private getCreateArgsForToolMessage(messages: OllamaMessage[], toolMessageIndex: number, expectedPath?: string): { filepath: string; content: string } | undefined {
    for (let index = toolMessageIndex - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== 'assistant' || !message.tool_calls?.length) {
        continue;
      }
      for (let toolIndex = message.tool_calls.length - 1; toolIndex >= 0; toolIndex -= 1) {
        const toolCall = message.tool_calls[toolIndex];
        if (this.remapWeakModelToolName(toolCall.function?.name ?? '') !== 'create_or_edit_file') {
          continue;
        }
        const args = this.normalizeToolArguments(toolCall.function?.arguments);
        const filepath = String(args.filename ?? args.filepath ?? '').trim();
        const content = String(args.content ?? '');
        if (!filepath || !content) {
          continue;
        }
        if (expectedPath) {
          const normalizedExpected = expectedPath.replace(/\\/g, '/').toLowerCase();
          const normalizedActual = filepath.replace(/\\/g, '/').toLowerCase();
          if (normalizedActual !== normalizedExpected && !normalizedExpected.endsWith(`/${path.basename(normalizedActual)}`)) {
            continue;
          }
        }
        return { filepath, content };
      }
    }
    return undefined;
  }

  private getLatestSuccessfulCreateContext(
    messages: OllamaMessage[],
    recentToolResults: Array<{ message: OllamaMessage & { role: 'tool' }; parsed: Record<string, unknown>; index: number }>
  ): { filepath: string; content: string; exportNames: string[] } | undefined {
    for (let index = recentToolResults.length - 1; index >= 0; index -= 1) {
      const { message, parsed, index: toolMessageIndex } = recentToolResults[index];
      if (parsed.error || message.tool_name !== 'create_or_edit_file' || isPlaceholderCreateResult(parsed)) {
        continue;
      }
      const resultPath = typeof parsed.path === 'string' ? parsed.path : '';
      const createArgs = this.getCreateArgsForToolMessage(messages, toolMessageIndex, resultPath);
      const filepath = resultPath || createArgs?.filepath || '';
      const content = createArgs?.content ?? '';
      if (!filepath || !content) {
        continue;
      }
      return {
        filepath,
        content,
        exportNames: extractSymbolNamesFromGeneratedContent(content, filepath)
      };
    }
    return undefined;
  }

  private async executeSyntheticBootstrapToolCall(messages: OllamaMessage[], assistantContent: string, toolCall: ToolFunctionCall): Promise<boolean> {
    const toolName = toolCall.function?.name ?? 'unknown_tool';

    if (!this.autoApprove) {
      const approved = await this.requestApproval({
        kind: 'tool',
        title: 'Tool Approval Required',
        message: `ManulAI wants to auto-bootstrap: ${toolName}`,
        details: assistantContent || undefined,
        approveLabel: 'Approve',
        declineLabel: 'Decline'
      });
      if (!approved) {
        messages.push({ role: 'assistant', content: `[Auto-bootstrap denied by user: ${toolName}]` });
        return true;
      }
    }

    messages.push({
      role: 'assistant',
      content: assistantContent,
      tool_calls: [toolCall],
      hiddenFromTranscript: true
    });

    this.postProgressStep(this.describeToolExecution(toolCall));
    this.debugLog('tool_exec_start', { tool: toolName, args: toolCall.function?.arguments, synthetic: true });
    const toolResult = await this.executeToolCall(toolCall);
    this.debugLog('tool_exec_result', { tool: toolName, result: toolResult.substring(0, 500), synthetic: true });
    messages.push({
      role: 'tool',
      content: toolResult,
      tool_name: toolName,
      hiddenFromTranscript: true,
      revertOperationIds: this.extractToolResultRevertOperationIds(toolResult)
    });

    const writeToolNames = new Set(['replace_in_file', 'create_or_edit_file', 'write_to_file', 'delete_file']);
    if (writeToolNames.has(toolName)) {
      try {
        const parsed = JSON.parse(toolResult) as Record<string, unknown>;
        if (!parsed.error) {
          const verifyResult = await this.tryRunBuildVerify(messages);
          if (verifyResult !== null) {
            if (verifyResult.ok) {
              this.postProgressStep('Build check: OK');
            } else {
              this.postProgressStep('Build errors detected — sending to model...');
              const verifyContent = `Build verification (compile check) after edit failed:\n${verifyResult.output || '(no output)'}\n\nFix all errors shown above before continuing. Then re-run the build check to confirm.`;
              messages.push({
                role: 'tool',
                content: JSON.stringify({ tool: 'build_verify', result: verifyContent }),
                tool_name: 'build_verify',
                hiddenFromTranscript: false
              });
            }
          }
        }
      } catch {
        // Ignore parse/verify bootstrap failures and let the loop continue naturally.
      }
    }

    this.resetNarratedBootstrapState();
    await this.processOllamaResponse(messages, 0);
    return true;
  }

  private getLatestBuildVerifyFailure(
    recentToolResults: Array<{ message: OllamaMessage & { role: 'tool' }; parsed: Record<string, unknown>; index: number }>
  ): { stack: string; result: string } | undefined {
    for (let index = recentToolResults.length - 1; index >= 0; index -= 1) {
      const { message, parsed } = recentToolResults[index];
      if (message.tool_name !== 'build_verify') {
        continue;
      }
      const result = typeof parsed.result === 'string' ? parsed.result : '';
      if (!/failed/i.test(result)) {
        continue;
      }
      return {
        stack: inferBuildVerifyStack(result),
        result
      };
    }
    return undefined;
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
          : (error ? 1 : 0);

        let errorMessage = error ? error.message : undefined;
        // Detect timeout (process killed by signal after timeout)
        if (error && (error as NodeJS.ErrnoException & { killed?: boolean }).killed) {
          errorMessage = 'Command timed out after 60 seconds. This terminal has no stdin — if the program expects interactive user input (e.g. input(), readline, scanf), it will always hang and time out. Do not retry interactive programs.';
        }

        resolve(JSON.stringify({
          command: trimmed,
          exitCode,
          stdout,
          stderr,
          error: errorMessage
        }));
      });
    });
  }

  private launchInTerminal(command: string): string {
    const trimmed = command.trim();

    if (!trimmed) {
      return JSON.stringify({ error: 'command is required.' });
    }

    const forbiddenFragments = ['rm -rf /', 'sudo ', 'shutdown', 'reboot', 'mkfs', ':(){:|:&};:'];
    if (forbiddenFragments.some(fragment => trimmed.includes(fragment))) {
      return JSON.stringify({ error: 'Command rejected by basic safety policy.' });
    }

    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const terminal = vscode.window.createTerminal({
      name: `ManulAI: ${trimmed.length > 40 ? trimmed.substring(0, 37) + '...' : trimmed}`,
      cwd
    });
    terminal.show();
    terminal.sendText(trimmed);

    return JSON.stringify({
      launched: true,
      command: trimmed,
      note: 'Program launched in a visible VS Code terminal. The user can interact with it directly.'
    });
  }

  private async addFileContext(rawPath: string): Promise<void> {
    try {
      const uri = this.parseDroppedUri(rawPath);
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type === vscode.FileType.Directory || stat.type === (vscode.FileType.Directory | vscode.FileType.SymbolicLink)) {
        await this.addFolderContext(uri);
        return;
      }
      const attached = await this.attachFileContextUri(uri);
      if (!attached) {
        throw new Error('Failed to attach file.');
      }
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
      languageId,
      readOnly: true
    });

    this.removeAttachmentContextMessages();
    this.postStateToWebview();
    this.postStatus(`Attached ${filename} to the next requests.`);
  }

  private async addFilePathContext(rawUri: string): Promise<void> {
    try {
      const uri = this.parseDroppedUri(rawUri);
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type === vscode.FileType.Directory || stat.type === (vscode.FileType.Directory | vscode.FileType.SymbolicLink)) {
        await this.addFolderContext(uri);
        return;
      }
      const attached = await this.attachFileContextUri(uri);
      if (!attached) {
        throw new Error('Failed to attach file.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to attach file.';
      this.postStatus(`Unable to attach file: ${message}`);
    }
  }

  private async attachFileContextUri(uri: vscode.Uri, silent = false): Promise<AttachedFileContext | undefined> {
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

    const attached: AttachedFileContext = {
      uri,
      name,
      content,
      languageId
    };

    this.attachedFiles.set(uri.fsPath, attached);
    this.removeAttachmentContextMessages();

    if (!silent) {
      this.postStateToWebview();
      this.postStatus(`Attached ${name} to the next requests.`);
    }

    return attached;
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

  private async browseAndAttachFolder(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      canSelectFiles: false,
      canSelectFolders: true,
      openLabel: 'Attach Folder',
      title: 'Attach folder to ManulAI context'
    });

    if (!uris?.length) {
      return;
    }

    await this.addFolderContext(uris[0]);
  }

  private async attachWorkspaceAsContext(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      this.postStatus('No workspace folder open.');
      return;
    }
    await this.addFolderContext(workspaceFolder.uri);
  }

  private async addFolderContext(folderUri: vscode.Uri): Promise<void> {
    const maxFilesWithContent = 80;
    const maxListedFiles = 2000;
    const maxFileSize = 80_000;
    const maxContentChars = 220_000;
    const skipDirs = new Set(['.git', 'node_modules', '.next', 'dist', 'out', 'build', '__pycache__', '.venv', 'venv', '.tox', 'coverage', '.nyc_output', '.cache']);
    const skipExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.mp4', '.zip', '.tar', '.gz', '.lock', '.vsix']);
    const allowedHiddenDirs = new Set(['.github', '.vscode']);
    const skipFileNames = new Set(['.env', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519']);
    const skipFilePatterns = [/^\.env\./i, /\.(?:pem|key|p12|pfx|crt|cer|der)$/i];

    const collected: string[] = [];
    const listedFiles: string[] = [];
    const folderName = path.basename(folderUri.fsPath);
    let totalContentChars = 0;
    let eligibleFileCount = 0;

    const walk = async (dir: vscode.Uri, depth: number): Promise<void> => {
      if (depth > 8 || listedFiles.length >= maxListedFiles) { return; }
      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(dir);
      } catch { return; }

      entries.sort((a, b) => a[0].localeCompare(b[0]));

      for (const [name, type] of entries) {
        if (listedFiles.length >= maxListedFiles) { break; }
        const childUri = vscode.Uri.joinPath(dir, name);

        if (type & vscode.FileType.Directory) {
          if (!skipDirs.has(name) && (!name.startsWith('.') || allowedHiddenDirs.has(name))) {
            await walk(childUri, depth + 1);
          }
          continue;
        }

        if (!(type & vscode.FileType.File)) { continue; }
        if (skipFileNames.has(name) || skipFilePatterns.some(pattern => pattern.test(name))) { continue; }
        const ext = path.extname(name).toLowerCase();
        if (skipExtensions.has(ext)) { continue; }

        const relativePath = path.relative(folderUri.fsPath, childUri.fsPath).replace(/\\/g, '/');
        listedFiles.push(relativePath);
        eligibleFileCount += 1;

        try {
          const stat = await vscode.workspace.fs.stat(childUri);
          if (stat.type & vscode.FileType.Directory) { continue; }
          if (stat.size > maxFileSize) { continue; }
          if (collected.length >= maxFilesWithContent) { continue; }
          const bytes = await vscode.workspace.fs.readFile(childUri);
          const text = Buffer.from(bytes).toString('utf8');
          if (totalContentChars + text.length > maxContentChars) { continue; }
          collected.push(`--- ${relativePath} ---\n${text}`);
          totalContentChars += text.length;
        } catch { /* skip unreadable files */ }
      }
    };

    this.postStatus(`Scanning folder ${folderName}...`);
    await walk(folderUri, 0);

    if (listedFiles.length === 0) {
      this.postStatus(`No readable files found in ${folderName}.`);
      return;
    }

    const treeText = listedFiles.join('\n');
    const omittedContentFiles = Math.max(eligibleFileCount - collected.length, 0);
    const combinedContent = [
      `Workspace root: ${folderUri.fsPath}`,
      '',
      `Project file tree (${listedFiles.length} files):`,
      treeText,
      '',
      `Included full contents for ${collected.length} file(s).${omittedContentFiles > 0 ? ` Omitted ${omittedContentFiles} file(s) from full content to stay within context budget; use read_specific_file for any omitted file.` : ''}`,
      '',
      collected.join('\n\n')
    ].join('\n');
    const truncated = omittedContentFiles > 0 || listedFiles.length >= maxListedFiles ? ' (snapshot)' : '';

    this.attachedFiles.set(folderUri.fsPath, {
      uri: folderUri,
      name: `${folderName}${truncated}`,
      content: combinedContent,
      languageId: '__folder__'
    });

    this.removeAttachmentContextMessages();
    this.postStateToWebview();
    this.postStatus(`Scanned ${listedFiles.length} project files and attached ${collected.length} full file contents from ${folderName} as persistent context.`);
  }

  private async setAgentMode(value: AgentModeValue): Promise<void> {
    this.agentMode = value;
    await this.persistStoredSetting('agentMode', this.agentMode);
    this.postStateToWebview();
    const labels: Record<AgentModeValue, string> = {
      chat: 'Chat Mode: Requests run as plain chat without any tools.',
      agent: 'Agent Mode: Ollama can call local tools and continue the loop automatically.',
      planner: 'Planner Mode: Extension orchestrates step-by-step execution with reduced tool context per step.'
    };
    this.postStatus(labels[this.agentMode]);
  }

  private async setAutoApprove(value: boolean | undefined): Promise<void> {
    this.autoApprove = value !== undefined ? value : !this.autoApprove;

    if (this.autoApprove && this.pendingApprovalResolver) {
      this.resolvePendingApproval(true);
    } else if (!this.autoApprove && this.pendingApproval) {
      this.pendingApproval = undefined;
      this.pendingApprovalResolver = undefined;
    }

    await this.persistStoredSetting('autoApprove', this.autoApprove);
    this.postStateToWebview();
    this.postStatus(
      this.autoApprove
        ? 'Auto-Approve enabled. Tools will execute without asking.'
        : 'Auto-Approve disabled. You will be asked before each tool execution.'
    );
  }

  private async setDebugMode(value: boolean | undefined): Promise<void> {
    this.debugMode = value !== undefined ? value : !this.debugMode;
    await this.persistStoredSetting('debugMode', this.debugMode);

    if (this.debugMode) {
      this.startDebugSession();
      const folders = vscode.workspace.workspaceFolders;
      const usingWorkspaceLogs = Boolean(folders?.length && folders[0].uri.scheme === 'file');
      this.postStatus(usingWorkspaceLogs
        ? 'Debug Mode enabled. Logs are saved to .manulai/ folder.'
        : 'Debug Mode enabled. Logs are saved to extension storage for this workspace.');
    } else {
      this.stopDebugSession();
      this.postStatus('Debug Mode disabled.');
    }
    this.postStateToWebview();
  }

  private getDebugLogDir(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (folders?.length && folders[0].uri.scheme === 'file') {
      return path.join(folders[0].uri.fsPath, '.manulai', 'logs');
    }
    return path.join(this.extensionContext.globalStorageUri.fsPath, 'logs');
  }

  private getExtensionVersion(): string {
    return this.extensionContext.extension.packageJSON?.version ?? 'dev';
  }

  private startDebugSession(): void {
    const logDir = this.getDebugLogDir();
    if (!logDir) { return; }
    try {
      if (this.debugLogFilePath) {
        this.stopDebugSession();
      }
      fs.mkdirSync(logDir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      this.debugSessionId = timestamp;
      const logFile = path.join(logDir, `session-${timestamp}.jsonl`);
      this.debugLogFilePath = logFile;
      this.debugLog('session_start', { model: this.getSelectedModel(), agentMode: this.agentMode, autoApprove: this.autoApprove });
    } catch {
      // Silently fail if we can't write logs
    }
  }

  private stopDebugSession(): void {
    if (this.debugLogFilePath) {
      this.writeDebugEntry('session_end', {});
      this.debugLogFilePath = undefined;
    }
    this.debugSessionId = '';
  }

  private writeDebugEntry(event: string, data: Record<string, unknown>): void {
    if (!this.debugLogFilePath) {
      return;
    }

    try {
      fs.mkdirSync(path.dirname(this.debugLogFilePath), { recursive: true });
      const entry = {
        ts: new Date().toISOString(),
        event,
        version: this.getExtensionVersion(),
        sessionId: this.debugSessionId || undefined,
        ...data
      };
      fs.appendFileSync(this.debugLogFilePath, JSON.stringify(entry) + '\n', 'utf8');
    } catch {
      // Silently fail
    }
  }

  private debugLog(event: string, data: Record<string, unknown>): void {
    if (!this.debugMode || !this.debugLogFilePath) { return; }
    this.writeDebugEntry(event, data);
  }

  public dispose(): void {
    clearTimeout(this.persistChatsTimeout);
    void this.persistChatState();
    this.stopDebugSession();
  }

  private synchronizeAttachmentContextMessage(chat: ChatSession = this.activeChat): void {
    this.removeAttachmentContextMessages(chat.messages);

    if (chat.attachedFiles.size === 0) {
      return;
    }

    chat.messages.push({
      role: 'user',
      content: this.renderAttachmentContextMessage(chat.attachedFiles),
      hiddenFromTranscript: true,
      attachmentContext: true
    });
  }

  private synchronizeActiveEditorContextMessage(userText?: string): void {
    this.removeActiveEditorContextMessages(this.messages);

    if (!this.shouldIncludeActiveEditorContext(userText)) {
      return;
    }

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

  private shouldIncludeActiveEditorContext(userText?: string): boolean {
    const normalized = String(userText ?? '').trim();
    if (!normalized) {
      return true;
    }

    if (this.looksLikeProjectScanRequest(normalized)) {
      return false;
    }

    if (this.extractLikelyRequestFileTargets(normalized).length > 0) {
      return false;
    }

    return true;
  }

  private removeAttachmentContextMessages(messages: OllamaMessage[] = this.messages): void {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].attachmentContext) {
        messages.splice(index, 1);
      }
    }
  }

  private removeActiveEditorContextMessages(messages: OllamaMessage[] = this.messages): void {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].activeEditorContext) {
        messages.splice(index, 1);
      }
    }
  }

  private renderAttachmentContextMessage(attachedFiles: Map<string, AttachedFileContext> = this.attachedFiles): string {
    return renderWebviewAttachmentContextMessage(attachedFiles, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
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

    const activeEditorPath = vscode.window.activeTextEditor?.document.uri.scheme === 'file'
      ? vscode.window.activeTextEditor.document.uri.fsPath
      : undefined;
    if (activeEditorPath && path.basename(activeEditorPath).toLowerCase() === path.basename(normalizedTarget).toLowerCase()) {
      return activeEditorPath;
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

  private extractAnnouncedNewFilePath(content: string): string | undefined {
    const normalized = content.replace(/\r\n/g, '\n');
    const explicitSrcMatch = normalized.match(/`((?:src|media)\/[^`]+\.(?:ts|tsx|js|jsx|json|md|css|html))`/i);
    if (explicitSrcMatch) {
      return explicitSrcMatch[1];
    }

    const commentPathMatch = normalized.match(/^[ \t]*\/\/\s*((?:src|media)\/[^\s]+\.(?:ts|tsx|js|jsx|json|md|css|html))$/im);
    if (commentPathMatch) {
      return commentPathMatch[1];
    }

    const namedFileMatch = normalized.match(/create\s+(?:a\s+)?new\s+file\s+(?:named\s+)?`?([A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx))`?.{0,120}?\b(?:in|under)\s+the\s+`?(src|media)`?\s+directory/i);
    if (namedFileMatch) {
      return `${namedFileMatch[2]}/${namedFileMatch[1]}`;
    }

    return undefined;
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
    return getWebviewDisplayPath(file, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
  }

  private getActiveFileState(): WebviewActiveFileState | undefined {
    return getWebviewActiveFileState(vscode.window.activeTextEditor, this.attachedFiles, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
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
    if (this.chatStorageLoaded) {
      this.schedulePersistedChats();
    }

    if (!this.webviewView) {
      return;
    }

    const renderableMessages: WebviewRenderableMessage[] = this.messages.reduce<WebviewRenderableMessage[]>((result, message) => {
      if (message.role === 'system') {
        return result;
      }

      if (message.role === 'tool') {
        const formattedToolMessage = formatTranscriptToolMessage(message, {
          truncateLongResponse: content => this.truncateLongResponse(content),
          buildRevertAction: operationIds => this.buildRevertAction(operationIds)
        });
        if (formattedToolMessage) {
          result.push(formattedToolMessage);
        }
        return result;
      }

      if (message.hiddenFromTranscript) {
        return result;
      }

      result.push({
        role: message.role,
        content: message.content,
        revertAction: this.buildRevertAction(message.revertOperationIds)
      });
      return result;
    }, []);

    const extensionVersion = this.getExtensionVersion();

    void this.webviewView.webview.postMessage({
      command: 'state',
      messages: renderableMessages,
      chats: this.chats.map(chat => this.getChatSummary(chat)),
      activeChatId: this.activeChatId,
      currentModel: this.getSelectedModel() || null,
      availableModels: this.availableModels,
      ollamaReachable: this.ollamaReachable,
      agentMode: this.agentMode,
      autoApprove: this.autoApprove,
      debugMode: this.debugMode,
      pendingApproval: this.pendingApproval,
      activeFile: getWebviewActiveFileState(vscode.window.activeTextEditor, this.attachedFiles, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath),
      extensionVersion,
      attachments: Array.from(this.attachedFiles.values()).map(file => ({
        path: file.uri.fsPath,
        displayPath: getWebviewDisplayPath(file, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath),
        name: file.name,
        isFolder: file.languageId === '__folder__'
      }))
    });
  }

  private getLatestVisibleUserRequest(messages: OllamaMessage[]): string {
    const index = this.getLastVisibleUserMessageIndex(messages);
    if (index < 0) {
      return '';
    }

    return messages[index]?.content ?? '';
  }

  private compactMemoryText(value: string, maxLength: number): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) {
      return normalized;
    }

    return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
  }

  private buildRecentChatSummaryContext(limit = this.getModelCapabilityProfile().summaryContextLimit): string {
    const collected: string[] = [];
    for (const chat of this.chats) {
      for (const summary of chat.summaryMemory.slice(-2)) {
        collected.push(`[${chat.title}] ${summary}`);
      }
    }
    return collected.slice(-limit).join('\n');
  }

  private extractTouchedPathsFromToolResults(messages: OllamaMessage[]): string[] {
    const touched = new Set<string>();
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    for (const message of messages) {
      if (message.role !== 'tool') {
        continue;
      }

      try {
        const parsed = JSON.parse(message.content) as Record<string, unknown>;
        const candidates = [parsed.path, parsed.deleted, parsed.filepath];
        for (const candidate of candidates) {
          if (typeof candidate !== 'string' || !candidate.trim()) {
            continue;
          }

          const normalized = workspaceRoot && candidate.startsWith(workspaceRoot)
            ? path.relative(workspaceRoot, candidate).replace(/\\/g, '/')
            : candidate.replace(/\\/g, '/');
          touched.add(normalized);
        }
      } catch {
        // Ignore non-JSON tool results.
      }
    }

    return Array.from(touched).slice(0, 8);
  }

  private normalizePersistedNotesContent(content: string): string {
    if (!content || /^\((?:no notes yet|empty|no workspace open)/i.test(content.trim())) {
      return '';
    }

    return content.trim();
  }

  private async appendWorkspaceAutoNoteEntry(entry: string): Promise<void> {
    const existingResult = await this.readWorkspaceNotes();
    let existingContent = '';
    try {
      existingContent = this.normalizePersistedNotesContent(String((JSON.parse(existingResult) as { content?: string }).content ?? ''));
    } catch {
      existingContent = '';
    }

    const trimmedEntry = entry.trim();
    if (!trimmedEntry || existingContent.includes(trimmedEntry)) {
      return;
    }

    const combined = existingContent ? `${existingContent}\n\n${trimmedEntry}` : trimmedEntry;
    const sections = combined.split(/\n(?=### )/g);
    const limited = sections.length > 20 ? sections.slice(-20).join('\n') : combined;
    await this.writeWorkspaceNotes(limited, 'overwrite');
  }

  private async persistCompletedExchangeMemory(startIndex: number): Promise<void> {
    const exchangeMessages = this.messages.slice(Math.max(0, startIndex));
    const userMessage = exchangeMessages.find(message => message.role === 'user' && !message.hiddenFromTranscript && !message.localOnly);
    const assistantMessage = [...exchangeMessages].reverse().find(
      message => message.role === 'assistant' && !message.hiddenFromTranscript && !message.localOnly && message.content.trim()
    );
    if (!userMessage || !assistantMessage) {
      return;
    }

    if (/^Request (?:failed|was stopped)\b/i.test(assistantMessage.content.trim())) {
      return;
    }

    const toolMessages = exchangeMessages.filter((message): message is OllamaMessage & { role: 'tool' } => message.role === 'tool');
    const touchedPaths = this.extractTouchedPathsFromToolResults(toolMessages);
    const toolNames = Array.from(new Set(toolMessages.map(message => message.tool_name).filter((name): name is string => Boolean(name))));
    const chatSummary = `${this.compactMemoryText(userMessage.content, 140)} -> ${this.compactMemoryText(assistantMessage.content, 180)}${touchedPaths.length > 0 ? ` | files: ${touchedPaths.join(', ')}` : ''}`;
    if (chatSummary && this.activeChat.summaryMemory[this.activeChat.summaryMemory.length - 1] !== chatSummary) {
      this.activeChat.summaryMemory.push(chatSummary);
      this.activeChat.summaryMemory = this.activeChat.summaryMemory.slice(-12);
    }

    const latestProjectScan = [...toolMessages].reverse().find(message => message.tool_name === 'project_scan');
    let projectScanSummary = '';
    if (latestProjectScan) {
      try {
        projectScanSummary = String((JSON.parse(latestProjectScan.content) as { summary?: string }).summary ?? '').trim();
      } catch {
        projectScanSummary = '';
      }
    }

    const hasMeaningfulToolWork = toolNames.some(name => [
      'project_scan',
      'create_or_edit_file',
      'write_to_file',
      'replace_in_file',
      'delete_file',
      'read_workspace_notes',
      'write_workspace_notes'
    ].includes(name)) || Boolean(assistantMessage.revertOperationIds?.length);
    if (!hasMeaningfulToolWork) {
      return;
    }

    const noteLines = [
      `### ${new Date().toISOString()} - ${this.compactMemoryText(userMessage.content, 100)}`,
      `- Outcome: ${this.compactMemoryText(assistantMessage.content, 220)}`,
      ...(touchedPaths.length > 0 ? [`- Files: ${touchedPaths.join(', ')}`] : []),
      ...(projectScanSummary ? [`- Project scan: ${projectScanSummary}`] : []),
      ...(toolNames.length > 0 ? [`- Tools: ${toolNames.join(', ')}`] : [])
    ];
    await this.appendWorkspaceAutoNoteEntry(noteLines.join('\n'));
  }

  private getLastVisibleUserMessageIndex(messages: OllamaMessage[]): number {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== 'user' || message.hiddenFromTranscript) {
        continue;
      }

      return index;
    }

    return -1;
  }

  private postProgressStep(text: string): void {
    const normalized = text.trim();
    if (!normalized) {
      return;
    }

    const content = `Step ${++this.progressStepCounter}: ${normalized}`;
    const lastMessage = this.messages[this.messages.length - 1];
    if (lastMessage?.localOnly && lastMessage.content === content) {
      return;
    }

    this.messages.push({
      role: 'assistant',
      content,
      localOnly: true
    });
    this.postStateToWebview();
  }

  private describeToolExecution(toolCall: ToolFunctionCall): string {
    const toolName = toolCall.function?.name || 'unknown_tool';
    const args = this.normalizeToolArguments(toolCall.function?.arguments);
    const formatPath = (value: unknown): string => {
      const text = String(value ?? '').trim();
      if (!text) {
        return 'target file';
      }

      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (workspaceRoot && text.startsWith(workspaceRoot + path.sep)) {
        return text.slice(workspaceRoot.length + 1).replace(/\\/g, '/');
      }

      return text.replace(/\\/g, '/');
    };

    switch (toolName) {
      case 'read_specific_file':
        return `Reading ${formatPath(args.filepath)}`;
      case 'read_file_slice': {
        const startLine = Number(args.startLine);
        const endLine = Number(args.endLine);
        const lineSuffix = Number.isFinite(startLine) && Number.isFinite(endLine)
          ? ` (lines ${Math.floor(startLine)}-${Math.floor(endLine)})`
          : '';
        return `Reading ${formatPath(args.filepath)}${lineSuffix}`;
      }
      case 'read_active_file':
        return 'Reading the active file';
      case 'list_workspace_files':
        return args.directory ? `Scanning project structure in ${formatPath(args.directory)}` : 'Scanning project structure';
      case 'project_scan':
        return 'Scanning project summary';
      case 'read_workspace_notes':
        return 'Reading workspace notes';
      case 'write_workspace_notes':
        return 'Saving workspace notes';
      case 'replace_in_file':
        return `Editing ${formatPath(args.filepath)}`;
      case 'create_or_edit_file':
        return `Writing ${formatPath(args.filename)}`;
      case 'write_to_file':
        return `Writing ${formatPath(args.filepath)}`;
      case 'delete_file':
        return `Deleting ${formatPath(args.filepath)}`;
      case 'execute_terminal_command':
        return `Running ${String(args.command ?? '').trim() || 'terminal command'}`;
      case 'launch_in_terminal':
        return `Launching in terminal: ${String(args.command ?? '').trim() || 'interactive program'}`;
      default:
        return `Executing ${toolName}`;
    }
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
