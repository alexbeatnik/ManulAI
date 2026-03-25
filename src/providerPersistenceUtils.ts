import * as vscode from 'vscode';

import { AgentModeValue, AttachedFileContext, ChatSession, ManulAiStoredSettings, OllamaMessage, PersistedAttachedFileContext, PersistedChatSession, PersistedChatState } from './types';

export function getWorkspaceSettingsDirUri(workspaceRoot?: vscode.Uri): vscode.Uri | undefined {
  if (!workspaceRoot) {
    return undefined;
  }
  return vscode.Uri.joinPath(workspaceRoot, '.manulai');
}

export function getWorkspaceSettingsUri(workspaceRoot?: vscode.Uri): vscode.Uri | undefined {
  const settingsDir = getWorkspaceSettingsDirUri(workspaceRoot);
  if (!settingsDir) {
    return undefined;
  }
  return vscode.Uri.joinPath(settingsDir, 'settings.json');
}

export function getChatStorageDirUri(workspaceRoot: vscode.Uri | undefined, globalStorageUri: vscode.Uri): vscode.Uri {
  return getWorkspaceSettingsDirUri(workspaceRoot) ?? globalStorageUri;
}

export function getChatStorageUri(workspaceRoot: vscode.Uri | undefined, globalStorageUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(getChatStorageDirUri(workspaceRoot, globalStorageUri), 'chats.json');
}

export function normalizeStoredSettings(value: unknown): Partial<ManulAiStoredSettings> {
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
  if (typeof candidate.agentMode === 'string' && ['chat', 'agent', 'planner'].includes(candidate.agentMode)) {
    normalized.agentMode = candidate.agentMode as AgentModeValue;
  } else if (typeof candidate.agentMode === 'boolean') {
    normalized.agentMode = candidate.agentMode ? 'agent' : 'chat';
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

export function deserializeChatMessage(value: unknown): OllamaMessage | undefined {
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
      ? candidate.revertOperationIds.filter((id: unknown): id is string => typeof id === 'string')
      : undefined
  };
}

export function deserializeAttachedFileContext(value: unknown, vscodeModule: typeof vscode): AttachedFileContext | undefined {
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
    uri: vscodeModule.Uri.file(fsPath),
    name,
    content: typeof candidate.content === 'string' ? candidate.content : '',
    languageId: typeof candidate.languageId === 'string' ? candidate.languageId : 'plaintext',
    readOnly: candidate.readOnly === true
  };
}

export function deserializeChatSession(value: unknown, vscodeModule: typeof vscode): ChatSession | undefined {
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
        .map(message => deserializeChatMessage(message))
        .filter((message): message is OllamaMessage => Boolean(message))
    : [];
  const attachedFiles = new Map<string, AttachedFileContext>();

  if (Array.isArray(candidate.attachedFiles)) {
    for (const file of candidate.attachedFiles) {
      const attached = deserializeAttachedFileContext(file, vscodeModule);
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
    attachedFiles,
    summaryMemory: Array.isArray(candidate.summaryMemory)
      ? candidate.summaryMemory.filter((entry): entry is string => typeof entry === 'string').slice(-12)
      : []
  };
}

export function normalizePersistedChatSession(
  chat: ChatSession,
  options: {
    removeAttachmentContextMessages: (messages: OllamaMessage[]) => void;
    removeActiveEditorContextMessages: (messages: OllamaMessage[]) => void;
    renderAttachmentContextMessage: (attachedFiles: Map<string, AttachedFileContext>) => string;
  }
): void {
  chat.summaryMemory = Array.isArray(chat.summaryMemory)
    ? chat.summaryMemory.filter(entry => typeof entry === 'string').slice(-12)
    : [];
  options.removeAttachmentContextMessages(chat.messages);
  options.removeActiveEditorContextMessages(chat.messages);

  if (chat.attachedFiles.size > 0) {
    chat.messages.push({
      role: 'user',
      content: options.renderAttachmentContextMessage(chat.attachedFiles),
      hiddenFromTranscript: true,
      attachmentContext: true
    });
  }
}

export function serializeChatState(activeChatId: string, chatCounter: number, chats: ChatSession[]): PersistedChatState {
  return {
    version: 2,
    activeChatId,
    chatCounter,
    chats: chats.map(chat => ({
      id: chat.id,
      title: chat.title,
      messages: chat.messages.filter(message => !message.activeEditorContext),
      summaryMemory: chat.summaryMemory.slice(-12),
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

export function restorePersistedChats(
  value: unknown,
  options: {
    deserializeChatSession: (value: unknown) => ChatSession | undefined;
    normalizePersistedChatSession: (chat: ChatSession) => void;
  }
): {
  chats: ChatSession[];
  activeChatId: string;
  chatCounter: number;
  lastPersistedChatState: string;
} | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const candidate = value as Partial<PersistedChatState>;
  const restoredChats = Array.isArray(candidate.chats)
    ? candidate.chats
        .map(chat => options.deserializeChatSession(chat))
        .filter((chat): chat is ChatSession => Boolean(chat))
    : [];

  if (restoredChats.length === 0) {
    return undefined;
  }

  const activeChatId = restoredChats.some(chat => chat.id === candidate.activeChatId)
    ? String(candidate.activeChatId)
    : restoredChats[0].id;
  const persistedCounter = typeof candidate.chatCounter === 'number' && Number.isFinite(candidate.chatCounter)
    ? candidate.chatCounter
    : restoredChats.length;
  const chatCounter = Math.max(persistedCounter, restoredChats.length);

  for (const chat of restoredChats) {
    options.normalizePersistedChatSession(chat);
  }

  return {
    chats: restoredChats,
    activeChatId,
    chatCounter,
    lastPersistedChatState: JSON.stringify(serializeChatState(activeChatId, chatCounter, restoredChats), null, 2) + '\n'
  };
}