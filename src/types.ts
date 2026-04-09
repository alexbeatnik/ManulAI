import type * as vscode from 'vscode';

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolFunctionCall {
  type?: 'function';
  function: {
    index?: number;
    name: string;
    arguments?: Record<string, unknown> | string;
  };
}

export interface OllamaMessage {
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

export interface OllamaResponse {
  message?: OllamaMessage;
  done: boolean;
  done_reason?: string;
}

export interface ParsedToolCall {
  name: string;
  arguments?: Record<string, unknown> | string;
}

export interface AttachedFileContext {
  uri: vscode.Uri;
  name: string;
  content: string;
  languageId: string;
  readOnly?: boolean;
}

export type AgentModeValue = 'chat' | 'agent' | 'planner';

export interface ManulAiStoredSettings {
  ollamaModel?: string;
  ollamaBaseUrl?: string;
  agentMode?: AgentModeValue;
  autoApprove?: boolean;
  debugMode?: boolean;
  systemPrompt?: string;
  manulEngineBaseUrl?: string;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: OllamaMessage[];
  attachedFiles: Map<string, AttachedFileContext>;
  summaryMemory: string[];
}

export interface WebviewChatSummary {
  id: string;
  title: string;
  messageCount: number;
  attachmentCount: number;
}

export interface PersistedAttachedFileContext {
  fsPath: string;
  name: string;
  content: string;
  languageId: string;
  readOnly?: boolean;
}

export interface PersistedChatSession {
  id: string;
  title: string;
  messages: OllamaMessage[];
  attachedFiles: PersistedAttachedFileContext[];
  summaryMemory?: string[];
}

export interface PersistedChatState {
  version: number;
  activeChatId: string;
  chatCounter: number;
  chats: PersistedChatSession[];
}

export const DEFAULT_STORED_SETTINGS: Required<ManulAiStoredSettings> = {
  ollamaModel: '',
  ollamaBaseUrl: 'http://localhost:11434',
  agentMode: 'agent',
  autoApprove: false,
  debugMode: false,
  systemPrompt: 'You are ManulAI, a privacy-first local coding assistant running inside VS Code. Work across any programming language. Prefer precise, minimal changes and explain results clearly.',
  manulEngineBaseUrl: 'http://127.0.0.1:8000'
};

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface WebviewInboundMessage {
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
    | 'setAgentMode'
    | 'toggleAutoApprove'
    | 'toggleDebugMode';
  text?: string;
  path?: string;
  paths?: string[];
  model?: string;
  value?: boolean | string;
  autoApprove?: boolean;
  operationIds?: string[];
  filename?: string;
  content?: string;
  attachments?: Array<{ name: string; content: string }>;
  chatId?: string;
}

export interface WebviewRenderableMessage {
  role: Exclude<ChatRole, 'system'> | 'status';
  content: string;
  revertAction?: {
    operationIds: string[];
    label: string;
    details?: string;
  };
}

export interface WebviewActiveFileState {
  path: string;
  name: string;
  displayPath: string;
}

export interface WebviewPendingApprovalState {
  kind: 'tool' | 'file-write';
  title: string;
  message: string;
  details?: string;
  approveLabel: string;
  declineLabel: string;
}
