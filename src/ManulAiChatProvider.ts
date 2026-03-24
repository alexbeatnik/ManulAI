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
  localOnly?: boolean;
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
  readOnly?: boolean;
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
    | 'createChat'
    | 'deleteChat'
    | 'switchChat'
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
    | 'browseFolder'
    | 'attachProject'
    | 'toggleAgentMode'
    | 'toggleAutoApprove'
    | 'toggleDebugMode';
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
  chatId?: string;
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

interface ManulAiStoredSettings {
  ollamaModel?: string;
  ollamaBaseUrl?: string;
  agentMode?: boolean;
  autoApprove?: boolean;
  debugMode?: boolean;
  systemPrompt?: string;
}

interface ChatSession {
  id: string;
  title: string;
  messages: OllamaMessage[];
  attachedFiles: Map<string, AttachedFileContext>;
}

interface WebviewChatSummary {
  id: string;
  title: string;
  messageCount: number;
  attachmentCount: number;
}

interface PersistedAttachedFileContext {
  fsPath: string;
  name: string;
  content: string;
  languageId: string;
  readOnly?: boolean;
}

interface PersistedChatSession {
  id: string;
  title: string;
  messages: OllamaMessage[];
  attachedFiles: PersistedAttachedFileContext[];
}

interface PersistedChatState {
  version: number;
  activeChatId: string;
  chatCounter: number;
  chats: PersistedChatSession[];
}

const DEFAULT_STORED_SETTINGS: Required<ManulAiStoredSettings> = {
  ollamaModel: '',
  ollamaBaseUrl: 'http://localhost:11434',
  agentMode: true,
  autoApprove: false,
  debugMode: false,
  systemPrompt: 'You are ManulAI, a privacy-first local coding assistant running inside VS Code. Work across any programming language. Prefer precise, minimal changes and explain results clearly.'
};

export class ManulAiChatProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'manulai.chatView';

  private webviewView?: vscode.WebviewView;
  private readonly chats: ChatSession[] = [];
  private activeChatId = '';
  private chatCounter = 0;
  private availableModels: string[] = [];
  private agentMode = true;
  private autoApprove = false;
  private debugMode = false;
  private requestInFlight = false;
  private stopRequested = false;
  private currentRequestAbortController?: AbortController;
  private pendingApproval?: WebviewPendingApprovalState;
  private pendingApprovalResolver?: (approved: boolean) => void;
  private readonly revertSnapshots = new Map<string, RevertSnapshot>();
  private debugLogFilePath?: string;
  private debugSessionId = '';
  private progressStepCounter = 0;
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
      this.agentMode = Boolean(config.get('agentMode', DEFAULT_STORED_SETTINGS.agentMode));
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
      title: title?.trim() || `Chat ${chatNumber}`,
      messages: [],
      attachedFiles: new Map<string, AttachedFileContext>()
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
    } catch (error) {
      this.availableModels = Array.from(new Set([currentModel, ...this.availableModels].filter(Boolean)));

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
    this.agentMode = this.getBooleanSetting('agentMode', DEFAULT_STORED_SETTINGS.agentMode);
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
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceRoot) {
      return undefined;
    }
    return vscode.Uri.joinPath(workspaceRoot, '.manulai');
  }

  private getWorkspaceSettingsUri(): vscode.Uri | undefined {
    const settingsDir = this.getWorkspaceSettingsDirUri();
    if (!settingsDir) {
      return undefined;
    }
    return vscode.Uri.joinPath(settingsDir, 'settings.json');
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
        this.workspaceSettings = this.normalizeStoredSettings(parsed);
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
    return this.getWorkspaceSettingsDirUri() ?? this.extensionContext.globalStorageUri;
  }

  private getChatStorageUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.getChatStorageDirUri(), 'chats.json');
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
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      this.chatStorageLoaded = true;
      return;
    }

    const candidate = value as Partial<PersistedChatState>;
    const restoredChats = Array.isArray(candidate.chats)
      ? candidate.chats
          .map(chat => this.deserializeChatSession(chat))
          .filter((chat): chat is ChatSession => Boolean(chat))
      : [];

    if (restoredChats.length > 0) {
      this.chats.length = 0;
      this.chats.push(...restoredChats);
      this.activeChatId = restoredChats.some(chat => chat.id === candidate.activeChatId)
        ? String(candidate.activeChatId)
        : restoredChats[0].id;
      const persistedCounter = typeof candidate.chatCounter === 'number' && Number.isFinite(candidate.chatCounter)
        ? candidate.chatCounter
        : restoredChats.length;
      this.chatCounter = Math.max(persistedCounter, restoredChats.length);
      for (const chat of this.chats) {
        this.normalizePersistedChatSession(chat);
      }
      this.lastPersistedChatState = JSON.stringify(this.serializeChatState(), null, 2) + '\n';
    }

    this.chatStorageLoaded = true;
  }

  private deserializeChatSession(value: unknown): ChatSession | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }

    const candidate = value as Partial<PersistedChatSession>;
    const id = String(candidate.id ?? '').trim();
    if (!id) {
      return undefined;
    }

    const title = String(candidate.title ?? '').trim() || 'Chat';
    const messages = Array.isArray(candidate.messages)
      ? candidate.messages
          .map(message => this.deserializeChatMessage(message))
          .filter((message): message is OllamaMessage => Boolean(message))
      : [];
    const attachedFiles = new Map<string, AttachedFileContext>();

    if (Array.isArray(candidate.attachedFiles)) {
      for (const file of candidate.attachedFiles) {
        const attached = this.deserializeAttachedFileContext(file);
        if (!attached) {
          continue;
        }
        attachedFiles.set(attached.uri.fsPath, attached);
      }
    }

    return {
      id,
      title,
      messages,
      attachedFiles
    };
  }

  private deserializeChatMessage(value: unknown): OllamaMessage | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }

    const candidate = value as Partial<OllamaMessage>;
    const role = candidate.role;
    if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') {
      return undefined;
    }

    return {
      role,
      content: typeof candidate.content === 'string' ? candidate.content : '',
      tool_calls: Array.isArray(candidate.tool_calls) ? candidate.tool_calls : undefined,
      tool_name: typeof candidate.tool_name === 'string' ? candidate.tool_name : undefined,
      localOnly: candidate.localOnly === true,
      hiddenFromTranscript: candidate.hiddenFromTranscript === true,
      attachmentContext: candidate.attachmentContext === true,
      activeEditorContext: candidate.activeEditorContext === true,
      revertOperationIds: Array.isArray(candidate.revertOperationIds)
        ? candidate.revertOperationIds.filter((id): id is string => typeof id === 'string')
        : undefined
    };
  }

  private deserializeAttachedFileContext(value: unknown): AttachedFileContext | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }

    const candidate = value as Partial<PersistedAttachedFileContext>;
    const fsPath = String(candidate.fsPath ?? '').trim();
    const name = String(candidate.name ?? '').trim();
    if (!fsPath || !name) {
      return undefined;
    }

    return {
      uri: vscode.Uri.file(fsPath),
      name,
      content: typeof candidate.content === 'string' ? candidate.content : '',
      languageId: typeof candidate.languageId === 'string' ? candidate.languageId : 'plaintext',
      readOnly: candidate.readOnly === true
    };
  }

  private normalizePersistedChatSession(chat: ChatSession): void {
    this.removeAttachmentContextMessages(chat.messages);
    this.removeActiveEditorContextMessages(chat.messages);

    if (chat.attachedFiles.size > 0) {
      chat.messages.push({
        role: 'user',
        content: this.renderAttachmentContextMessage(chat.attachedFiles),
        hiddenFromTranscript: true,
        attachmentContext: true
      });
    }
  }

  private serializeChatState(): PersistedChatState {
    return {
      version: 1,
      activeChatId: this.activeChatId,
      chatCounter: this.chatCounter,
      chats: this.chats.map(chat => ({
        id: chat.id,
        title: chat.title,
        messages: chat.messages.filter(message => !message.activeEditorContext),
        attachedFiles: Array.from(chat.attachedFiles.values()).map(file => ({
          fsPath: file.uri.fsPath,
          name: file.name,
          content: file.content,
          languageId: file.languageId,
          readOnly: file.readOnly
        }))
      }))
    };
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
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }

    const candidate = value as Record<string, unknown>;
    const normalized: Partial<ManulAiStoredSettings> = {};
    if (typeof candidate.ollamaModel === 'string') {
      normalized.ollamaModel = candidate.ollamaModel;
    }
    if (typeof candidate.ollamaBaseUrl === 'string') {
      normalized.ollamaBaseUrl = candidate.ollamaBaseUrl;
    }
    if (typeof candidate.agentMode === 'boolean') {
      normalized.agentMode = candidate.agentMode;
    }
    if (typeof candidate.autoApprove === 'boolean') {
      normalized.autoApprove = candidate.autoApprove;
    }
    if (typeof candidate.debugMode === 'boolean') {
      normalized.debugMode = candidate.debugMode;
    }
    if (typeof candidate.systemPrompt === 'string') {
      normalized.systemPrompt = candidate.systemPrompt;
    }
    return normalized;
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
      case 'toggleAgentMode':
        await this.setAgentMode(message.value);
        return;
      case 'toggleAutoApprove':
        await this.setAutoApprove(message.value);
        return;
      case 'toggleDebugMode':
        await this.setDebugMode(message.value);
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

    if (this.agentMode && this.looksLikeProjectScanRequest(text)) {
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

    if (this.agentMode && this.looksLikeFileMutationRequest(text)) {
      await this.autoAttachLikelyRequestFiles(text);
    }

    this.synchronizeAttachmentContextMessage();

    if (this.agentMode && this.looksLikeLargeRefactorRequest(text)) {
      this.messages.push({
        role: 'user',
        content: 'This is a large refactor request. Do NOT try to rewrite or summarize the whole file in one pass. First inspect structure with list_workspace_files and read_file_slice for bounded sections when the file is large. Then create a short module/file split plan with 2-5 concrete steps and immediately execute only the first concrete step using tools. Continue iteratively one file or bounded slice at a time.',
        hiddenFromTranscript: true
      });
    }

    if (this.agentMode) {
      const directSummary = await this.tryHandleDirectLicenseAuthorRename(text)
        || await this.tryHandleDirectTitleRename(text);
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

  private async runAgentLoop(): Promise<void> {
    this.requestInFlight = true;
    this.stopRequested = false;
    this.postBusyState(true);

    try {
      await this.processOllamaResponse(this.messages);
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
      this.currentRequestAbortController = undefined;
      this.stopRequested = false;
      this.requestInFlight = false;
      this.postBusyState(false);
      this.postStateToWebview();
    }
  }

  private async processOllamaResponse(messages: OllamaMessage[], retryCount = 0): Promise<void> {
    this.throwIfRequestStopped();
    this.postStatus(retryCount > 0 ? `Retry ${retryCount}: calling Ollama...` : 'Calling Ollama...');
    this.debugLog('ollama_request', { retryCount, messageCount: messages.length, model: this.getSelectedModel() });
    const responseData = await this.callOllama(messages);
    this.throwIfRequestStopped();
    const assistantMessage = responseData.message;

    if (!assistantMessage) {
      throw new Error('Ollama returned no message payload.');
    }

    const resolvedToolCalls = this.agentMode ? this.extractToolCalls(assistantMessage) : [];

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
      }

      await this.processOllamaResponse(messages, 0);
      return;
    }

    let finalContent = assistantMessage.content ?? '';
    this.debugLog('ollama_response', { contentLength: finalContent.length, hasToolCalls: resolvedToolCalls.length > 0, contentPreview: finalContent.substring(0, 300) });

    if (!this.agentMode) {
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

      if (this.agentMode) {
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

        // --- Fallback layer 6b: nudge the model to use tools if it didn't ---
        // If tools were already used in the CURRENT exchange (after the last user message),
        // the model's text response is a legitimate summary — don't nudge it.
        // We only check messages after the last user message to avoid stale tool results
        // from previous exchanges disabling the nudge.
        const lastUserIdx = (() => {
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'user') { return i; }
          }
          return -1;
        })();
        const recentMessages = lastUserIdx >= 0 ? messages.slice(lastUserIdx) : messages;
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
          if (message.tool_name === 'replace_in_file' || message.tool_name === 'write_to_file' || message.tool_name === 'delete_file') {
            return true;
          }
          if (message.tool_name !== 'create_or_edit_file') {
            return false;
          }
          return !this.isPlaceholderCreateResult(parsed);
        });
        const lastSuccessfulActionIndex = (() => {
          for (let index = recentToolResults.length - 1; index >= 0; index -= 1) {
            const { message, parsed } = recentToolResults[index];
            if (parsed.error) {
              continue;
            }
            if (message.tool_name === 'execute_terminal_command') {
              if (Number(parsed.exitCode ?? 0) === 0) {
                return index;
              }
              continue;
            }
            if (message.tool_name === 'write_to_file'
              || message.tool_name === 'replace_in_file'
              || message.tool_name === 'delete_file') {
              return index;
            }
            if (message.tool_name === 'create_or_edit_file' && !this.isPlaceholderCreateResult(parsed)) {
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
            return Number(parsed.exitCode ?? 0) === 0;
          }
          if (message.tool_name === 'create_or_edit_file') {
            return !this.isPlaceholderCreateResult(parsed);
          }
          return message.tool_name === 'write_to_file'
            || message.tool_name === 'replace_in_file'
            || message.tool_name === 'delete_file';
        });
        const recentToolErrors = recentToolResults
          .filter(({ index }) => index > lastSuccessfulActionIndex)
          .map(({ message, parsed }) => ({ toolName: message.tool_name ?? '', error: typeof parsed.error === 'string' ? parsed.error : '' }))
          .filter(item => item.error);
        const hasRecentToolErrors = recentToolErrors.length > 0;
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
          return this.toolResultMatchesAnyTargetPath(parsed.path, largeRefactorTargets);
        });
        const isLargeRefactorRequest = this.looksLikeLargeRefactorRequest(latestVisibleUserRequest);
        const replaceNotFoundContext = this.getLatestReplaceNotFoundContext(messages);
        const hasRecentReplaceNotFound = Boolean(replaceNotFoundContext);
        const replaceNotFoundFilepath = replaceNotFoundContext?.filepath;
        const replaceNotFoundStartLine = replaceNotFoundContext?.startLine;
        const replaceNotFoundEndLine = replaceNotFoundContext?.endLine;

        const isLongDump = finalContent.length > 300;
        const hasLargeCodeBlocks = /```[\w]*\n[\s\S]{100,}?```/.test(finalContent);
        const claimsDone = /(?:зробив|замінив|оновив|готово|i've made|i have made|i have updated|i updated|i fixed|i removed|i verified|i confirmed|i corrected|i aligned|successfully applied|successfully saved|has been removed|has been moved|addressed the|fixed the|removed the|updated the|verified the|confirmed the|corrected the|aligned the|summary of the changes|summary:)/i.test(finalContent);
        const mentionsChange = /(?:змін|зроби|оновл|replac|chang|updat|modif|address|fix(?:ed)?|remov(?:e|ed)|verif(?:y|ied)|confirm(?:ed)?|correct(?:ed)?|align(?:ed)?)/i.test(finalContent);
        const isLazyAcknowledgment = (/^(?:understood|sure|ok|okay|got it|i will|let me know|i can help|i'll make sure)\b/i.test(finalContent.trim())
          || /no (?:immediate|obvious) (?:file changes|issues|errors|problems)/i.test(finalContent)
          || /further debugging (?:would be|is) needed/i.test(finalContent))
          && finalContent.trim().length < 500;
        // Detect model asking user to do things manually or announcing actions without executing them
        // NOTE: "let me know" is excluded — it's always a polite closing, not passing work to the user.
        const isPassingToUser = (/(?:please (?:execute|run|proceed|specify|provide|make sure|save)|you (?:may|can|should|need to) (?:run|execute|save|choose|pick)|choose one of the (?:options|approaches)|if the .{0,30} persists|let'?s (?:execute|run|try|start)|let me (?:execute|run|try|start))/i.test(finalContent))
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
          .map(match => parseInt(match[1], 10))
          .filter(Number.isFinite);
        const hasSequentialStepNarration = announcedStepNumbers.length >= 2
          && Math.max(...announcedStepNumbers) > Math.min(...announcedStepNumbers);
        const hasIncompletePlan = (stepMatch && parseInt(stepMatch[1], 10) < parseInt(stepMatch[2], 10))
          || (hasCompletedStepAnnouncement && hasSequentialStepNarration);
        const hasExplicitNextSteps = /next steps?:/i.test(finalContent) && /\n\s*(?:2|3|4|5)\.\s+/i.test(finalContent);
        const progressLines = finalContent
          .split('\n')
          .map(line => line.trim())
          .filter(Boolean);
        const isProgressOnlyResponse = progressLines.length > 0
          && finalContent.trim().length < 220
          && progressLines.every(line => /^(?:step\s+\d+\s*(?:\/|of)\s*\d+[:\s-].*|step\s+\d+\s+completed[:\s-].*|execut(?:e|ing)\s+step\s+\d+[:\s-].*|reading (?:the )?file first\.{0,3}|reading and modifying .+|i(?:'| a)?ll read the file.*|i apologize for the oversight\.?|sorry for the oversight\.?)$/i.test(line));

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
        const claimedCommands = Array.from(finalContent.matchAll(/`([^`]+)`/g)).map(match => match[1].trim().toLowerCase());
        const claimedButUnexecutedCommand = claimedCommands.some(command => {
          if (!/(?:^|\s)(?:npm|pnpm|yarn|bun|node|npx|python|pytest|pip|cargo|go|dotnet|gradle|mvn)\b/i.test(command)) {
            return false;
          }
          return !recentExecutedCommands.some(executed => executed.includes(command) || command.includes(executed));
        });

        const maxNudgeRetries = hasRecentReplaceNotFound ? 3 : 2;
        const requiresToolContinuation = (
          isPassingToUser
          || isAnnouncedButNotExecuted
          || !!hasIncompletePlan
          || hasExplicitNextSteps
          || isProgressOnlyResponse
          || claimedButUnexecutedCommand
          || (isLargeRefactorRequest && hasRecentToolResults && (!hasRecentSuccessfulAction || !hasRecentReadOfLargeRefactorTarget || !hasRecentMeaningfulWrite))
          || (hasRecentReplaceNotFound && (mentionsChange || claimsDone || isLazyAcknowledgment || hasIncompletePlan || hasExplicitNextSteps))
          || (hasRecentToolErrors && (claimsDone || mentionsChange || isLazyAcknowledgment))
          || (!hasRecentSuccessfulAction && (isLongDump || hasLargeCodeBlocks || claimsDone || mentionsChange || isLazyAcknowledgment))
        );
        const shouldNudge = requiresToolContinuation && retryCount < maxNudgeRetries;

        if (shouldNudge) {
          this.debugLog('nudge', { retryCount, hasRecentToolResults, hasRecentSuccessfulAction, hasRecentMeaningfulWrite, hasRecentReadOfLargeRefactorTarget, hasRecentToolErrors, hasRecentReplaceNotFound, replaceNotFoundFilepath, replaceNotFoundStartLine, replaceNotFoundEndLine, lastSuccessfulActionIndex, isLongDump, hasLargeCodeBlocks, claimsDone, mentionsChange, isLazyAcknowledgment, hasIncompletePlan: !!hasIncompletePlan, hasExplicitNextSteps, isProgressOnlyResponse, claimedButUnexecutedCommand, isPassingToUser, isAnnouncedButNotExecuted, isLargeRefactorRequest, contentPreview: finalContent.substring(0, 200) });
          // Show plan/progress text to the user before nudging
          if (!isProgressOnlyResponse && (hasIncompletePlan || hasExplicitNextSteps || claimedButUnexecutedCommand || claimsDone || mentionsChange || isPassingToUser || isAnnouncedButNotExecuted)) {
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
          if (hasIncompletePlan) {
            nudgeMessage = stepMatch
              ? `You are on step ${stepMatch[1]} of ${stepMatch[2]} but stopped. Continue executing your plan. Proceed to the next step now — use the provided tools.`
              : 'You reported that one step was completed and announced the next step, but you stopped before executing it. Continue now by calling the next tool instead of narrating the plan.';
          } else if (isLargeRefactorRequest) {
            const primaryTarget = largeRefactorTargets[0];
            if (primaryTarget && !hasRecentReadOfLargeRefactorTarget) {
              nudgeMessage = `This is a large refactor request. You have not read the main target file yet. First call read_file_slice for ${primaryTarget} to inspect a bounded section of the real file content. Do NOT create placeholder files or stop at a plan. After reading the target file, execute one concrete extraction or replace step with tools.`;
            } else if (!hasRecentMeaningfulWrite) {
              nudgeMessage = 'This is a large refactor request. A placeholder file or plan is not enough progress. Do not stop after scaffolding. Read the real source file, then perform one concrete extraction or replace step with tools before responding.';
            } else {
              nudgeMessage = 'This is a large refactor request. Do not summarize the whole file or stop after inspection. First define a concise module/file split plan, then execute step 1 immediately with tools. Prefer read_file_slice for bounded reads on large files, and continue iteratively one file or one slice at a time.';
            }
          } else if (hasExplicitNextSteps) {
            nudgeMessage = 'You listed next steps but stopped before executing them. Continue now. Do not stop after the first step or the first issue — keep using tools until the scan is complete.';
          } else if (hasRecentReplaceNotFound) {
            nudgeMessage = replaceNotFoundFilepath && replaceNotFoundStartLine && replaceNotFoundEndLine
              ? `Your replace_in_file call failed because old_text did not match the real file content. First call read_file_slice for ${replaceNotFoundFilepath} with startLine=${replaceNotFoundStartLine} and endLine=${replaceNotFoundEndLine}. Do NOT guess. Then call replace_in_file again using the exact current text including whitespace.`
              : `Your replace_in_file call failed because old_text did not match the real file content.${replaceNotFoundFilepath ? ` First call read_specific_file for ${replaceNotFoundFilepath}.` : ' First call read_specific_file for that file.'} Do NOT guess. Then call replace_in_file again using the exact current text including whitespace.`;
          } else if (isProgressOnlyResponse) {
            nudgeMessage = 'Do not print progress updates like "Step 3/3" without taking action. Call a tool now. If you need the current file content, use read_specific_file first, then continue with replace_in_file or another appropriate tool.';
          } else if (claimedButUnexecutedCommand) {
            nudgeMessage = 'You claimed that a command or action was completed, but there is no matching tool execution in this exchange. Do not claim completion without actually running the command. Execute it now with execute_terminal_command or continue the remaining scan steps.';
          } else if (isAnnouncedButNotExecuted) {
            nudgeMessage = 'You announced an action but did not execute it. Do not describe what you will do — actually do it now by calling the appropriate tool. Use execute_terminal_command for commands or replace_in_file for edits.';
          } else if (isPassingToUser) {
            nudgeMessage = 'Do not ask the user to run commands or make changes manually. You have tools available. Use execute_terminal_command to run commands and replace_in_file or create_or_edit_file to edit files. Do it yourself now.';
          } else if (isLazyAcknowledgment) {
            nudgeMessage = 'Do not just acknowledge the request. Actually perform the task now. Read the relevant files and make the changes the user asked for. Use the provided tools.';
          } else if (isLongDump || hasLargeCodeBlocks) {
            nudgeMessage = 'You returned code or a large file dump without using a tool. If you need to inspect or modify files, call one of the provided tools directly. If no tool is needed, answer briefly without dumping full file contents.';
          } else {
            nudgeMessage = 'You described changes but did not call a tool. If you need to modify files, use one of the provided tools. If no file change is needed, answer normally.';
          }

          messages.push({
            role: 'user',
            content: nudgeMessage,
            hiddenFromTranscript: true
          });
          this.postStatus(`Model did not use tools (attempt ${retryCount + 1}) — continuing...`);
          await this.processOllamaResponse(messages, retryCount + 1);
          return;
        }

        if (requiresToolContinuation && retryCount >= maxNudgeRetries) {
          this.debugLog('forced_tool_retry_stop', {
            retryCount,
            maxNudgeRetries,
            hasRecentToolResults,
            hasRecentSuccessfulAction,
            hasRecentMeaningfulWrite,
            hasRecentReadOfLargeRefactorTarget,
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
          finalContent = isLargeRefactorRequest
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
      if (file.languageId === '__folder__' || file.readOnly) {
        continue;
      }
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

  private getLatestReplaceNotFoundContext(messages: OllamaMessage[]): { filepath?: string; startLine?: number; endLine?: number } | undefined {
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
          endLine: typeof slice?.endLine === 'number' ? slice.endLine : undefined
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
    if (this.attachedFiles.size === 0 || content.length < 500) {
      return undefined;
    }

    // Check if the response is mostly a reproduction of an attached file
    for (const [fsPath, file] of this.attachedFiles) {
      if (file.languageId === '__folder__' || file.readOnly) {
        continue;
      }
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
      const hasStrongAnchors = this.hasStrongFullFileAnchors(extracted, originalContent);
      const minLengthRatio = hasStrongAnchors ? 0.55 : 0.85;
      const maxLengthRatio = hasStrongAnchors ? 1.35 : 1.2;
      const minLineRatio = hasStrongAnchors ? 0.5 : 0.85;
      const maxLineRatio = hasStrongAnchors ? 1.35 : 1.2;

      if (extractedLength < originalLength * minLengthRatio || extractedLength > originalLength * maxLengthRatio) {
        return undefined;
      }

      if (originalLines > 20 && (extractedLines < originalLines * minLineRatio || extractedLines > originalLines * maxLineRatio)) {
        return undefined;
      }
    }

    if (this.looksLikeChangeSummary(content)) {
      return undefined;
    }

    return extracted;
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

        if (/^<\/?manulai_(?:active_editor_context|attached_file|attached_folder)\b.*>$/i.test(trimmed)) {
          return false;
        }

        // Strip diff @@ line markers that leaked into content
        if (/^@@\s+line\s+\d+\s+@@$/i.test(trimmed)) {
          return false;
        }

        return true;
      });

    return sanitizedLines.join('\n').trim();
  }

  private stripDiffPrefixes(content: string): string {
    // Only strip unified diff content. This avoids corrupting normal text such as Markdown lists.
    const lines = content.split('\n');
    const nonEmptyLines = lines.filter(l => l.trim().length > 0);
    if (nonEmptyLines.length < 3) {
      return content;
    }

    const isMetadataLine = (line: string): boolean => {
      const trimmed = line.trim();
      return /^diff --git\s+/.test(trimmed)
        || /^index\s+[0-9a-f]+\.\.[0-9a-f]+/.test(trimmed)
        || /^@@\s+.+\s+@@/.test(trimmed)
        || /^---(\s|$)/.test(trimmed)
        || /^\+\+\+(\s|$)/.test(trimmed)
        || /^\\ No newline at end of file$/.test(trimmed);
    };

    const hasUnifiedDiffMarkers = nonEmptyLines.some(line => isMetadataLine(line));
    if (!hasUnifiedDiffMarkers) {
      return content;
    }

    const prefixedCount = nonEmptyLines.filter(l => /^[+-]\s/.test(l) || /^[+-](?![-+]{2})/.test(l)).length;
    if (prefixedCount / nonEmptyLines.length < 0.4) {
      return content;
    }

    return lines.map(line => {
      if (isMetadataLine(line)) {
        return '';
      }
      if (/^\+(?!\+\+)/.test(line)) {
        return line.substring(1);
      }
      if (/^-(?!--)/.test(line)) {
        return '';
      }
      if (/^ /.test(line)) {
        return line.substring(1);
      }
      return line;
    }).filter((line, i, arr) => {
      if (line === '' && i > 0 && arr[i - 1] === '') {
        return false;
      }
      return true;
    }).join('\n');
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

    if (/[.]$/.test(candidate.trim())) {
      return false;
    }

    if (/^\d+(?:\.\d+)+$/.test(trimmed)) {
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

    if (/^[A-Za-z0-9_-]+\.[A-Za-z][A-Za-z0-9_-]{0,11}$/.test(trimmed)) {
      return true;
    }

    const activeName = vscode.window.activeTextEditor ? path.basename(vscode.window.activeTextEditor.document.fileName) : '';
    if (activeName && trimmed === activeName) {
      return true;
    }

    return Array.from(this.attachedFiles.values()).some(file => file.languageId !== '__folder__' && !file.readOnly && (trimmed === file.name || trimmed === path.basename(file.uri.fsPath)));
  }

  private findAttachedFileForReplacements(replacements: Array<{ oldText: string }>): string | undefined {
    // Find which attached file contains the old_text strings
    for (const [fsPath, file] of this.attachedFiles) {
      if (file.languageId === '__folder__' || file.readOnly) {
        continue;
      }
      const allFound = replacements.every(rep => file.content.includes(rep.oldText));
      if (allFound) {
        return fsPath;
      }
    }
    // Partial match: at least one replacement matches
    for (const [fsPath, file] of this.attachedFiles) {
      if (file.languageId === '__folder__' || file.readOnly) {
        continue;
      }
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

  private extractNewFileCreation(content: string): { fullMatch: string; filepath: string; fileContent: string } | undefined {
    // Detect patterns where the model mentions creating/writing a file and provides a code block
    // e.g. "Here's `1.py`:\n```python\nprint('hello')\n```"
    // e.g. "Створюю файл 1.py:\n```python\nprint('hello')\n```"
    const fencedBlocks = Array.from(content.matchAll(/(```(?:[\w.+-]*)\n[\s\S]*?```)/g));
    if (fencedBlocks.length === 0) {
      return undefined;
    }

    // Look for a filename mentioned near a code block
    const filenamePattern = /[`"']?([a-zA-Z0-9_\-]+\.[a-zA-Z0-9]+)[`"']?/g;
    const codeBlock = fencedBlocks[0];
    const blockStart = codeBlock.index ?? 0;
    const textBeforeBlock = content.substring(Math.max(0, blockStart - 300), blockStart);

    let bestFilename: string | undefined;
    let fnMatch: RegExpExecArray | null;
    while ((fnMatch = filenamePattern.exec(textBeforeBlock)) !== null) {
      const candidate = fnMatch[1];
      if (this.isLikelyFileReference(candidate)) {
        bestFilename = candidate;
      }
    }

    if (!bestFilename) {
      // Also check for filename in the text after the code block
      const textAfterBlock = content.substring(blockStart + codeBlock[0].length, blockStart + codeBlock[0].length + 200);
      filenamePattern.lastIndex = 0;
      while ((fnMatch = filenamePattern.exec(textAfterBlock)) !== null) {
        const candidate = fnMatch[1];
        if (this.isLikelyFileReference(candidate)) {
          bestFilename = candidate;
          break;
        }
      }
    }

    if (!bestFilename) {
      return undefined;
    }

    const blockContent = codeBlock[0].replace(/^```[\w.+-]*\n/, '').replace(/\n?```$/, '');
    if (!blockContent.trim()) {
      return undefined;
    }

    // Resolve to workspace path
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const wsRoot = workspaceFolders?.[0]?.uri.fsPath;
    const filepath = wsRoot ? path.join(wsRoot, bestFilename) : bestFilename;

    return {
      fullMatch: codeBlock[0],
      filepath,
      fileContent: blockContent
    };
  }

  private async callOllama(messages: OllamaMessage[]): Promise<OllamaResponse> {
    const baseUrl = this.getOllamaBaseUrl();
    const model = this.getSelectedModel();
    if (!model) {
      throw new Error('No Ollama model selected. Select a local model first.');
    }
    const systemPrompt = this.getSystemPrompt();

    const requestMessages: OllamaMessage[] = [];

    if (this.agentMode) {
      const workspaceInstructions = await this.getWorkspaceInstructions();

      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    let agentMandate = `[IDENTITY]
You are ManulAI, a local VS Code coding agent.
${wsRoot ? `Workspace root: ${wsRoot}\n` : ''}
All file paths are relative to the workspace root unless absolute.

---
[GOLDEN RULES]

- Always read before write.
- Never guess — verify with tools.
- Use minimal edits, preserve structure.
- Do not claim success unless tool confirms.
- After each change, re-check the file or output.
- Stop after 3 failed retries and report the reason.

---

[CORE BEHAVIOR]

- You are an ACTION agent, not a chat assistant.
- If a task requires file edits or commands, you MUST use tools.
- Do not describe fixes — APPLY them.
- Do not ask the user to run commands — run them yourself.
- If no tools are needed, respond concisely.
- NEVER claim a file was modified unless a tool succeeded.
- Avoid dumping full file contents unless explicitly requested.

---

[PRIORITIES]

1. Correctness over speed
2. Safety over completeness
3. Tool usage over assumptions
4. Minimal change over refactoring

---

[FLOW CONTROL]

For SIMPLE tasks:
→ Act immediately using tools.

For NON-TRIVIAL tasks:
1. Output a short numbered plan
2. Execute step-by-step using tools
3. Announce progress before each step
4. End with a short factual summary

Example:
Step 1/3: Reading project structure...

Do NOT:
- stop after planning
- output partial plans
- end with polite phrases

---

[TOOL USAGE RULES]

- ALWAYS use native tool-calling (never raw JSON text)
- NEVER simulate edits in chat
- Use:
  - replace_in_file → for small changes
  - create_or_edit_file → only if full rewrite is required

When fixing code:
1. Read file
2. Identify real issue
3. Apply minimal fix

If unsure:
→ read more files, do NOT guess

If a command is needed:
→ use execute_terminal_command

---

[WHEN NOT TO USE TOOLS]

Do NOT use tools when:
- answering conceptual questions
- explaining behavior
- no file or command interaction is required

In those cases:
→ respond concisely in plain text

---

[REALITY CHECK]

- You do NOT know file contents unless you read them
- You do NOT know project structure unless you list it
- You do NOT know if a fix worked unless a tool confirms it
- Never assume — always verify

---

[MANDATORY READ BEFORE WRITE]

- You MUST read a file before modifying it
- If you did not read it, you MUST NOT edit it

---

[FILE EDITING RULES]

- Make ONLY the requested change
- NEVER remove unrelated content
- NEVER rewrite entire file unless explicitly required
- ALWAYS preserve structure

MULTI-STEP EDITS:
- One tool call per change
- Wait for result before next change

---

[ANTI-HALLUCINATION]

- If unsure:
  → read more files
- NEVER guess

---

[ANTI-LOOP GUARD]

- Do NOT repeat the same failed action more than twice
- If repeated failure:
  → change approach OR gather more context

---

[RETRY POLICY]

- Maximum 3 retries per failed action
- After that:
  → adjust strategy (do NOT blindly retry)

---

[FAILURE HANDLING]

If a tool fails:
1. Read error
2. Adjust approach
3. Retry

If still failing:
→ gather more context using tools

---

[ITERATIVE EXECUTION]

- Never solve everything in one step
- Break tasks into smaller steps
- Execute sequentially

Bad:
→ one massive change

Good:
→ read → fix → verify → continue

---

[MINIMALISM RULE]

- Make the smallest correct change
- Do not modify unrelated code
- Avoid unnecessary improvements

---

[TASK COMPLETION]

A task is COMPLETE only if:
- The requested change is applied
- All tool calls succeeded
- No remaining errors are visible

Before finishing:
- Verify:
  - Did I use tools if required?
  - Did they succeed?
  - Did I complete all steps?

If all checks pass:
→ output a short factual summary and STOP

---

[OUTPUT RULES]

- Keep responses minimal
- No unnecessary explanations
- No polite endings
- Only facts and progress
`;

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

    requestMessages.push(...messages.filter(m => !m.localOnly).map(m => ({ ...m })));

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
    if (message.tool_calls?.length) {
      return message.tool_calls;
    }

    return this.parseToolCallsFromContent(message.content);
  }

  private stripToolCallsFromContent(content: string): string {
    let stripped = content;
    stripped = stripped.replace(/```(?:json|tool_call|tool)?\s*\n?[\s\S]*?```/g, '');
    stripped = stripped.replace(/<tool_call>\s*[\s\S]*?\s*<\/tool_call>/g, '');
    stripped = stripped.replace(/<function=[^>]+>\s*[\s\S]*?<\/function>/g, '');
    stripped = stripped.replace(/<\/?tool_call>/g, '');
    // Strip plain JSON tool call objects from the text
    const toolNamePattern = /\{\s*"(?:name|function_name|function)"\s*:\s*"/g;
    let match: RegExpExecArray | null;
    while ((match = toolNamePattern.exec(stripped)) !== null) {
      const jsonStr = this.extractBalancedJson(stripped, match.index);
      if (jsonStr) {
        stripped = stripped.slice(0, match.index) + stripped.slice(match.index + jsonStr.length);
        toolNamePattern.lastIndex = match.index;
      }
    }
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

    const taggedCalls = this.parseTaggedToolCalls(trimmed);
    if (taggedCalls.length > 0) {
      return taggedCalls;
    }

    // Regex fallback: extract JSON from markdown code blocks, <tool_call> tags, or plain JSON objects.
    const knownToolNames = new Set(this.getToolDefinitions().map(t => t.function.name));
    const candidates: string[] = [];

    const codeBlockPattern = /```(?:json|tool_call|tool)?\s*\n?([\s\S]*?)```/g;
    const tagPattern = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

    let match: RegExpExecArray | null;
    while ((match = codeBlockPattern.exec(trimmed)) !== null) {
      const inner = match[1].trim();
      if (inner.startsWith('{') || inner.startsWith('[')) candidates.push(inner);
    }
    while ((match = tagPattern.exec(trimmed)) !== null) {
      const inner = match[1].trim();
      if (inner.startsWith('{') || inner.startsWith('[')) candidates.push(inner);
    }

    // Catch-all: extract balanced JSON objects that look like tool calls from plain text.
    // Models like Llama/Qwen/Gemma often output raw JSON tool calls directly.
    const toolNamePattern = /\{\s*["'](?:name|function_name|function)["']\s*:\s*["']/g;
    while ((match = toolNamePattern.exec(trimmed)) !== null) {
      const jsonStr = this.extractBalancedJson(trimmed, match.index);
      if (jsonStr) { candidates.push(jsonStr); }
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
        // JSON.parse failed — try repairing single-quoted JSON (common with weak models)
        const repaired = this.repairSingleQuotedJson(candidate);
        if (repaired) {
          try {
            const parsed = JSON.parse(repaired) as unknown;
            const calls = this.normalizeParsedToolCalls(parsed);
            if (calls.length > 0 && calls.every(c => knownToolNames.has(c.function.name))) {
              return calls;
            }
          } catch {
            // Give up on this candidate
          }
        }
      }
    }

    return [];
  }

  private parseTaggedToolCalls(content: string): ToolFunctionCall[] {
    const knownToolNames = new Set(this.getToolDefinitions().map(t => t.function.name));
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
    const trimmed = content.trim();
    if (!trimmed.startsWith('{')) { return false; }

    let parsed: unknown;
    let parseFailed = false;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      const repaired = this.repairSingleQuotedJson(trimmed);
      if (!repaired) {
        parseFailed = true;
      } else {
        try {
          parsed = JSON.parse(repaired);
        } catch {
          parseFailed = true;
        }
      }
    }

    if (parseFailed) {
      return this.looksLikeMalformedToolCallContent(trimmed);
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return false;
    }

    const toolNames = new Set(this.getToolDefinitions().map(t => t.function.name));
    const obj = parsed as {
      type?: unknown;
      function?: { name?: unknown; arguments?: unknown };
      functionName?: unknown;
      name?: unknown;
      function_name?: unknown;
      arguments?: unknown;
      parameters?: unknown;
    };

    if (obj.type === 'function' && obj.function && typeof obj.function === 'object') {
      const functionName = obj.function.name;
      const functionArguments = obj.function.arguments;
      return typeof functionName === 'string'
        && toolNames.has(functionName)
        && (functionArguments === undefined || typeof functionArguments === 'string' || (functionArguments !== null && typeof functionArguments === 'object'));
    }

    if (typeof obj.function === 'string') {
      const topLevelArgs = this.inferImplicitToolArguments(this.remapWeakModelToolName(obj.function), obj.arguments ?? obj.parameters, obj as Record<string, unknown>);
      return toolNames.has(this.remapWeakModelToolName(obj.function))
        && (typeof topLevelArgs === 'string' || (topLevelArgs !== null && typeof topLevelArgs === 'object'));
    }

    const topLevelName = obj.name ?? obj.function_name;
    const normalizedTopLevelName = typeof topLevelName === 'string' ? this.remapWeakModelToolName(topLevelName) : undefined;
    const topLevelArgs = normalizedTopLevelName
      ? this.inferImplicitToolArguments(normalizedTopLevelName, obj.arguments ?? obj.parameters, obj as Record<string, unknown>)
      : (obj.arguments ?? obj.parameters);
    const parsedMatch = typeof topLevelName === 'string'
      && toolNames.has(this.remapWeakModelToolName(topLevelName))
      && (typeof topLevelArgs === 'string' || (topLevelArgs !== null && typeof topLevelArgs === 'object'));

    if (parsedMatch) {
      return true;
    }

    return this.looksLikeMalformedToolCallContent(trimmed);
  }

  private looksLikeMalformedToolCallContent(content: string): boolean {
    const trimmed = content.trim();
    if (!trimmed.startsWith('{')) {
      return false;
    }

    const hintedToolName = this.extractToolCallNameHint(trimmed);
    if (!hintedToolName) {
      return false;
    }

    if (!/["'](?:arguments|parameters)["']\s*:/.test(trimmed)) {
      return false;
    }

    return /["'](?:filepath|filename|path|content|old_text|new_text|command|directory|text|model)["']\s*:/.test(trimmed);
  }

  private extractToolCallNameHint(content: string): string | undefined {
    const toolNames = new Set(this.getToolDefinitions().map(t => t.function.name));
    const directMatch = content.match(/["'](?:name|function_name|function)["']\s*:\s*["']([a-zA-Z0-9_:-]+)["']/);
    const nestedMatch = content.match(/["']function["']\s*:\s*\{[\s\S]*?["']name["']\s*:\s*["']([a-zA-Z0-9_:-]+)["']/);
    const candidate = nestedMatch?.[1] ?? directMatch?.[1];
    if (!candidate) {
      return undefined;
    }

    const normalized = this.remapWeakModelToolName(candidate.trim());
    return toolNames.has(normalized) ? normalized : undefined;
  }

  private containsLeakedToolCallPayload(content: string): boolean {
    const trimmed = content.trim();
    if (!trimmed) {
      return false;
    }

    if (this.looksLikeToolCallContent(trimmed)) {
      return true;
    }

    const codeBlockPattern = /```(?:json|tool_call|tool)?\s*\n?([\s\S]*?)```/g;
    let match: RegExpExecArray | null;
    while ((match = codeBlockPattern.exec(trimmed)) !== null) {
      if (this.looksLikeToolCallContent(match[1] ?? '')) {
        return true;
      }
    }

    const toolCallObjectPattern = /\{\s*["'](?:name|function_name|function)["']\s*:/g;
    while ((match = toolCallObjectPattern.exec(trimmed)) !== null) {
      const jsonStr = this.extractBalancedJson(trimmed, match.index);
      if (jsonStr && this.looksLikeToolCallContent(jsonStr)) {
        return true;
      }
    }

    return false;
  }

  /** Extract a balanced JSON object starting at `startIndex` in `text`. */
  private extractBalancedJson(text: string, startIndex: number): string | undefined {
    let depth = 0;
    let inString = false;
    let stringChar = '';
    let escape = false;
    for (let i = startIndex; i < text.length; i++) {
      const ch = text[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if ((ch === '"' || ch === "'") && (!inString || ch === stringChar)) {
        if (inString) { inString = false; stringChar = ''; } else { inString = true; stringChar = ch; }
        continue;
      }
      if (inString) { continue; }
      if (ch === '{') { depth++; }
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          return text.slice(startIndex, i + 1);
        }
      }
    }
    return undefined;
  }

  /**
   * Attempt to repair JSON that uses single quotes instead of double quotes.
   * Handles cases like: {"name": "tool", "arguments": {"old_text": 'value with "quotes"'}}
   */
  private repairSingleQuotedJson(text: string): string | undefined {
    // Replace single-quoted string values with double-quoted ones,
    // escaping any inner double quotes.
    let result = '';
    let i = 0;
    while (i < text.length) {
      if (text[i] === "'") {
        // Collect the single-quoted string
        let value = '';
        i++; // skip opening '
        while (i < text.length && text[i] !== "'") {
          if (text[i] === '\\' && i + 1 < text.length) {
            value += text[i] + text[i + 1];
            i += 2;
          } else {
            value += text[i];
            i++;
          }
        }
        i++; // skip closing '
        // Escape inner double quotes and wrap in double quotes
        result += '"' + value.replace(/"/g, '\\"') + '"';
      } else {
        result += text[i];
        i++;
      }
    }
    // Quick sanity check: is the result parseable?
    try {
      JSON.parse(result);
      return result;
    } catch {
      return undefined;
    }
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
          description: 'List files and folders in the workspace or in a specific subdirectory.',
          parameters: {
            type: 'object',
            properties: {
              directory: {
                type: 'string',
                description: 'Optional subdirectory path relative to workspace root. Omit or use empty string for root.'
              }
            },
            additionalProperties: false
          }
        }
      }
    ];
  }

  private extractCodeBlockFileWrites(content: string): Array<{ fullMatch: string; filepath: string; fileContent: string }> {
    const blocks: Array<{ fullMatch: string; filepath: string; fileContent: string }> = [];
    const shellLanguages = new Set(['bash', 'sh', 'shell', 'zsh', 'fish', 'powershell', 'ps1', 'cmd', 'bat']);
    // Match: ```lang:filepath or ```lang filepath
    // Also: ```lang\n// filepath  or ```lang\n# filepath
    const pattern = /```(\w+)[:\s]+([^\n`]+)\n([\s\S]*?)```/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const lang = (match[1] || '').toLowerCase();
      const filepath = match[2].trim();
      const fileContent = match[3];
      if (shellLanguages.has(lang)) { continue; }
      if (lang === 'diff' || lang === 'patch') { continue; }
      if (this.looksLikeToolCallContent(fileContent)) { continue; }
      if (filepath && fileContent && !filepath.includes(' ') && this.isLikelyFileReference(filepath) && !this.looksLikeDiffOutput(fileContent)) {
        blocks.push({ fullMatch: match[0], filepath, fileContent });
      }
    }

    // Match: ```lang\n// filepath: path/to/file\n...
    const commentPathPattern = /```(\w+)\s*\n\s*(?:\/\/|#|--|\/\*)\s*(?:filepath|file|path):\s*([^\n]+)\n([\s\S]*?)```/gi;
    while ((match = commentPathPattern.exec(content)) !== null) {
      const lang = (match[1] || '').toLowerCase();
      const filepath = match[2].trim();
      const fileContent = match[3];
      if (shellLanguages.has(lang)) { continue; }
      if (lang === 'diff' || lang === 'patch') { continue; }
      if (this.looksLikeToolCallContent(fileContent)) { continue; }
      if (filepath && fileContent && this.isLikelyFileReference(filepath) && !blocks.some(b => b.filepath === filepath) && !this.looksLikeDiffOutput(fileContent)) {
        blocks.push({ fullMatch: match[0], filepath, fileContent });
      }
    }

    // Match: mentioning a filename in the text directly preceding the code block.
    const precedingNamePattern = /(?:in|to|for|file|called|named|updated?|modified|created?|створ\w*|файл)\s+[`"']?([a-zA-Z0-9_\-\.\/]+)[`"']?[^`]{0,80}```(\w*)\n([\s\S]*?)```/gi;
    while ((match = precedingNamePattern.exec(content)) !== null) {
      const filepath = match[1].trim();
      const lang = (match[2] || '').toLowerCase();
      const fileContent = match[3];
      if (shellLanguages.has(lang)) {
        continue;
      }
      if (lang === 'diff' || lang === 'patch') {
        continue;
      }
      if (this.looksLikeDiffOutput(fileContent)) {
        continue;
      }
      if (this.looksLikeToolCallContent(fileContent)) {
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
    const name = this.remapWeakModelToolName(toolCall.function?.name ?? '');
    const args = this.normalizeToolArguments(toolCall.function?.arguments);

    try {
      switch (name) {
        case 'read_active_file':
          if (String(args.filepath ?? '').trim()) {
            return await this.readSpecificFile(String(args.filepath ?? ''));
          }
          return await this.readActiveFile();
        case 'read_specific_file':
          if (args.startLine !== undefined || args.endLine !== undefined) {
            return await this.readFileSlice(String(args.filepath ?? ''), args.startLine, args.endLine);
          }
          return await this.readSpecificFile(String(args.filepath ?? ''));
        case 'read_file_slice':
          return await this.readFileSlice(String(args.filepath ?? ''), args.startLine, args.endLine);
        case 'create_or_edit_file':
          return await this.createOrEditFile(String(args.filename ?? args.filepath ?? ''), String(args.content ?? ''));
        case 'write_to_file':
          return await this.createOrEditFile(String(args.filepath ?? ''), String(args.content ?? ''));
        case 'replace_in_file':
          return await this.replaceInFile(String(args.filepath ?? ''), String(args.old_text ?? ''), String(args.new_text ?? ''));
        case 'execute_terminal_command':
          return await this.executeTerminalCommand(String(args.command ?? ''));
        case 'delete_file':
          return await this.deleteFile(String(args.filepath ?? ''));
        case 'list_workspace_files':
          return await this.listWorkspaceFiles(String(args.directory ?? ''));
        default:
          return JSON.stringify({ error: `Unknown tool: ${name}` });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Tool execution failed.';
      return JSON.stringify({ error: message });
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
          return this.remapWeakModelArgumentAliases(parsed as Record<string, unknown>);
        }
      } catch {
        return {};
      }

      return {};
    }

    return this.remapWeakModelArgumentAliases(rawArguments);
  }

  private remapWeakModelToolName(name: string): string {
    const normalized = name.trim();
    const aliases: Record<string, string> = {
      write_file: 'write_to_file',
      create_file: 'create_or_edit_file',
      create_or_replace: 'create_or_edit_file',
      create_or_overwrite: 'create_or_edit_file',
      edit_file: 'replace_in_file',
      replace_content: 'replace_in_file',
      read_file: 'read_specific_file',
      read_file_range: 'read_file_slice',
      read_file_chunk: 'read_file_slice',
      run_command: 'execute_terminal_command',
      terminal_command: 'execute_terminal_command'
    };
    return aliases[normalized.toLowerCase()] ?? normalized;
  }

  private remapWeakModelArgumentAliases(args: Record<string, unknown>): Record<string, unknown> {
    const aliasMap: Record<string, string> = {
      file_path: 'filepath',
      filePath: 'filepath',
      file_name: 'filename',
      file: 'filepath',
      path: 'filepath',
      old_content: 'old_text',
      new_content: 'new_text',
      old_string: 'old_text',
      new_string: 'new_text',
      old_code: 'old_text',
      new_code: 'new_text',
      start_line: 'startLine',
      end_line: 'endLine',
      from_line: 'startLine',
      to_line: 'endLine',
      cmd: 'command',
      dir: 'directory'
    };

    const normalized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      normalized[aliasMap[key] ?? key] = value;
    }
    return normalized;
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
      return directUri;
    }

    const existingPath = await this.resolveExistingWorkspacePath(normalizedTarget);
    if (existingPath) {
      return vscode.Uri.file(existingPath);
    }

    return directUri;
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
      const uri = await this.resolveWorkspaceUriForOperation(filepath);
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

  private async readFileSlice(filepath: string, startLine: unknown, endLine: unknown): Promise<string> {
    if (!filepath.trim()) {
      return JSON.stringify({ error: 'filepath is required.' });
    }

    const normalizedStartLine = Number(startLine);
    const normalizedEndLine = Number(endLine);
    if (!Number.isFinite(normalizedStartLine) || !Number.isFinite(normalizedEndLine)) {
      return JSON.stringify({ error: 'startLine and endLine must be numbers.' });
    }

    const start = Math.max(1, Math.floor(normalizedStartLine));
    const end = Math.max(1, Math.floor(normalizedEndLine));
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
        return JSON.stringify({ error: `startLine ${start} exceeds total line count ${totalLines}.` });
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
      return JSON.stringify({
        error: error instanceof Error ? error.message : 'Failed to read file slice.'
      });
    }
  }

  private async createOrEditFile(filename: string, content: string): Promise<string> {
    if (!filename.trim()) {
      return JSON.stringify({ error: 'filename is required.' });
    }

    try {
      const targetUri = await this.resolveWorkspaceUriForOperation(filename, true);

      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(targetUri.fsPath)));

      let sanitizedContent = this.sanitizeGeneratedFileContent(content);
      if (this.looksLikeDiffOutput(sanitizedContent)) {
        sanitizedContent = this.stripDiffPrefixes(sanitizedContent);
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

      const revertOperationId = oldContent !== undefined && oldContent !== sanitizedContent
        ? this.createRevertSnapshot(targetUri.fsPath, oldContent, sanitizedContent)
        : undefined;
      const diff = oldContent !== undefined && oldContent !== sanitizedContent
        ? this.buildDiffSummary(displayName, oldContent, sanitizedContent)
        : undefined;

      return JSON.stringify({
        path: targetUri.fsPath,
        bytesWritten: Buffer.byteLength(sanitizedContent, 'utf8'),
        preview: oldContent === undefined || !oldContent.trim() ? this.buildPreviewSnippet(sanitizedContent) : undefined,
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
      return JSON.stringify({ deleted: uri.fsPath });
    } catch (error) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : 'Failed to delete file.'
      });
    }
  }

  private async listWorkspaceFiles(directory: string): Promise<string> {
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

      const entries = await vscode.workspace.fs.readDirectory(baseUri);
      const items = entries.map(([name, type]) => ({
        name,
        type: type === vscode.FileType.Directory ? 'directory' : 'file'
      }));

      return JSON.stringify({ path: baseUri.fsPath, items });
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
      const preview = this.buildPreviewSnippet(sanitizedContent);
      return { summary: `Created ${displayName} (${lineCount} lines)${preview ? `\n\n\`\`\`text\n${preview}\n\`\`\`` : ''}` };
    }

    if (!oldContent.trim() && sanitizedContent.trim()) {
      const lineCount = sanitizedContent.split('\n').length;
      const preview = this.buildPreviewSnippet(sanitizedContent);
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
    const oldPreview = this.buildPreviewSnippet(oldText);
    const newPreview = this.buildPreviewSnippet(newText);
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

    try {
      const target = await this.resolveWorkspaceUriForOperation(filepath);
      const original = await this.readWorkspaceText(target);
      const occurrences = original.split(oldText).length - 1;

      if (occurrences === 0) {
        return JSON.stringify({
          error: 'old_text not found in file. Make sure it matches exactly, including whitespace.',
          suggestedReadSlice: this.suggestReadSliceForReplaceFailure(original, oldText)
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
        revertOperationId
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

  private buildPreviewSnippet(content: string): string {
    const normalized = content.replace(/\r\n/g, '\n').trimEnd();
    if (!normalized.trim()) {
      return '';
    }

    const lines = normalized.split('\n');
    const previewLines = lines.length > 40
      ? [...lines.slice(0, 30), `... (${lines.length - 35} more lines omitted) ...`, ...lines.slice(-5)]
      : lines;
    const preview = previewLines.join('\n');
    return preview.length > 5000 ? `${preview.slice(0, 4800)}\n... preview truncated ...` : preview;
  }

  private isPlaceholderCreateResult(parsed: Record<string, unknown>): boolean {
    const preview = typeof parsed.preview === 'string' ? parsed.preview : '';
    const bytesWritten = Number(parsed.bytesWritten ?? 0);
    const normalizedLines = preview
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);

    if (normalizedLines.length === 0) {
      return true;
    }

    const codeLikeLineCount = normalizedLines.filter(line => {
      if (/^(?:\/\/|\/\*|\*|#)/.test(line)) {
        return false;
      }
      return /(?:^|\s)(?:export|import|const|let|var|function|class|interface|type|enum|async|return)\b/.test(line)
        || /[{}();=]/.test(line);
    }).length;

    return codeLikeLineCount === 0 && bytesWritten <= 240;
  }

  private toolResultMatchesAnyTargetPath(toolPathValue: unknown, targets: string[]): boolean {
    const toolPath = String(toolPathValue ?? '').replace(/\\/g, '/').toLowerCase();
    if (!toolPath) {
      return false;
    }

    return targets.some(target => {
      const normalizedTarget = target.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
      if (!normalizedTarget) {
        return false;
      }
      return toolPath.endsWith(`/${normalizedTarget}`)
        || toolPath === normalizedTarget
        || path.basename(toolPath) === path.basename(normalizedTarget);
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

  private async setAgentMode(value: boolean | undefined): Promise<void> {
    this.agentMode = value !== undefined ? value : !this.agentMode;
    await this.persistStoredSetting('agentMode', this.agentMode);
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
    const renderedFiles = Array.from(attachedFiles.values())
      .map(file => {
        const filePath = file.readOnly
          ? `reference-only:${file.name}`
          : file.uri.fsPath.startsWith('/dropped/') || file.uri.fsPath.startsWith('/attached/')
            ? (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
              ? `${vscode.workspace.workspaceFolders[0].uri.fsPath}/${file.name}`
              : file.name)
          : file.uri.fsPath;

        if (file.languageId === '__folder__') {
          return [
            `<manulai_attached_folder name="${file.name}" path="${filePath}">`,
            file.content,
            '</manulai_attached_folder>'
          ].join('\n');
        }

        return [
          `<manulai_attached_file file="${file.name}" path="${filePath}"${file.readOnly ? ' readonly="true"' : ''}>`,
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
        const formattedToolMessage = this.formatToolMessageForTranscript(message);
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
      agentMode: this.agentMode,
      autoApprove: this.autoApprove,
      debugMode: this.debugMode,
      pendingApproval: this.pendingApproval,
      activeFile: this.getActiveFileState(),
      extensionVersion,
      attachments: Array.from(this.attachedFiles.values()).map(file => ({
        path: file.uri.fsPath,
        displayPath: this.getDisplayPath(file),
        name: file.name,
        isFolder: file.languageId === '__folder__'
      }))
    });
  }

  private formatToolMessageForTranscript(message: OllamaMessage): WebviewRenderableMessage | undefined {
    if (message.role !== 'tool' || !message.tool_name) {
      return undefined;
    }

    let parsed: Record<string, unknown> | undefined;
    try {
      const json = JSON.parse(message.content) as unknown;
      if (json && typeof json === 'object' && !Array.isArray(json)) {
        parsed = json as Record<string, unknown>;
      }
    } catch {
        return {
        role: 'tool',
          content: `Tool: ${message.tool_name}\n\n${this.truncateLongResponse(message.content)}`,
          revertAction: this.buildRevertAction(message.revertOperationIds)
      };
    }

    switch (message.tool_name) {
      case 'execute_terminal_command': {
        const command = String(parsed?.command ?? '');
        const exitCode = String(parsed?.exitCode ?? '');
        const stdout = this.formatToolTextBlock(parsed?.stdout);
        const stderr = this.formatToolTextBlock(parsed?.stderr);
        const error = parsed?.error ? String(parsed.error) : '';
        const parts = [
          `Command: ${command || '(unknown command)'}`,
          `Exit code: ${exitCode || '0'}`
        ];
        if (stdout) {
          parts.push(`stdout\n\n\`\`\`text\n${stdout}\n\`\`\``);
        }
        if (stderr) {
          parts.push(`stderr\n\n\`\`\`text\n${stderr}\n\`\`\``);
        }
        if (error) {
          parts.push(`error\n\n\`\`\`text\n${error}\n\`\`\``);
        }
        return {
          role: 'tool',
          content: parts.join('\n\n'),
          revertAction: this.buildRevertAction(message.revertOperationIds)
        };
      }
      case 'read_active_file':
      case 'read_specific_file':
      case 'read_file_slice': {
        const error = parsed?.error ? String(parsed.error) : '';
        if (error) {
          return {
            role: 'tool',
            content: `Read tool: ${message.tool_name}\n\n${error}`,
            revertAction: this.buildRevertAction(message.revertOperationIds)
          };
        }

        const targetPath = String(parsed?.path ?? '');
        const languageId = String(parsed?.languageId ?? 'plaintext');
        const startLine = parsed?.startLine !== undefined ? String(parsed.startLine) : '';
        const endLine = parsed?.endLine !== undefined ? String(parsed.endLine) : '';
        const totalLines = parsed?.totalLines !== undefined ? String(parsed.totalLines) : '';
        const content = this.formatToolTextBlock(parsed?.content);
        const parts = [
          `Path: ${targetPath || '(unknown path)'}`,
          `Language: ${languageId || 'plaintext'}`
        ];
        if (startLine || endLine) {
          parts.push(`Lines: ${startLine || '?'}-${endLine || '?'}${totalLines ? ` of ${totalLines}` : ''}`);
        }
        if (content) {
          parts.push(`Content\n\n\`\`\`text\n${content}\n\`\`\``);
        }
        return {
          role: 'tool',
          content: parts.join('\n\n'),
          revertAction: this.buildRevertAction(message.revertOperationIds)
        };
      }
      case 'create_or_edit_file':
      case 'write_to_file':
      case 'replace_in_file': {
        const error = parsed?.error ? String(parsed.error) : '';
        if (error) {
          return {
            role: 'tool',
            content: `File tool: ${message.tool_name}\n\n${error}`,
            revertAction: this.buildRevertAction(message.revertOperationIds)
          };
        }

        const targetPath = String(parsed?.path ?? parsed?.deleted ?? '');
        const bytesWritten = parsed?.bytesWritten !== undefined ? String(parsed.bytesWritten) : '';
        const replacements = parsed?.replacements !== undefined ? String(parsed.replacements) : '';
        const diff = this.formatToolTextBlock(parsed?.diff);
        const preview = this.formatToolTextBlock(parsed?.preview);
        const parts = [`Path: ${targetPath || '(unknown path)'}`];
        if (bytesWritten) {
          parts.push(`Bytes written: ${bytesWritten}`);
        }
        if (replacements) {
          parts.push(`Replacements: ${replacements}`);
        }
        if (diff) {
          parts.push(diff);
        } else if (preview) {
          parts.push(`Preview\n\n\`\`\`text\n${preview}\n\`\`\``);
        }
        return {
          role: 'tool',
          content: parts.join('\n\n'),
          revertAction: this.buildRevertAction(message.revertOperationIds)
        };
      }
      default: {
        const error = parsed?.error ? String(parsed.error) : '';
        if (error) {
          return {
            role: 'tool',
            content: `Tool: ${message.tool_name}\n\n${error}`,
            revertAction: this.buildRevertAction(message.revertOperationIds)
          };
        }

        const summary = this.formatToolTextBlock(JSON.stringify(parsed, null, 2));
        return {
          role: 'tool',
          content: summary
            ? `Tool: ${message.tool_name}\n\nResult\n\n\`\`\`json\n${summary}\n\`\`\``
            : `Tool: ${message.tool_name}`,
          revertAction: this.buildRevertAction(message.revertOperationIds)
        };
      }
    }
  }

  private formatToolTextBlock(value: unknown): string {
    if (typeof value !== 'string') {
      return '';
    }

    const normalized = value.replace(/\r\n/g, '\n').trim();
    if (!normalized) {
      return '';
    }

    const lines = normalized.split('\n');
    const limited = lines.length > 80
      ? [...lines.slice(0, 60), `... (${lines.length - 70} more lines omitted) ...`, ...lines.slice(-10)]
      : lines;
    const joined = limited.join('\n');
    return joined.length > 8000 ? `${joined.slice(0, 7800)}\n... output truncated ...` : joined;
  }

  private getLatestVisibleUserRequest(messages: OllamaMessage[]): string {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== 'user' || message.hiddenFromTranscript) {
        continue;
      }

      return message.content;
    }

    return '';
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
