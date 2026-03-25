import * as path from 'path';

import type * as vscode from 'vscode';

import { AttachedFileContext, OllamaMessage, WebviewActiveFileState, WebviewRenderableMessage } from './types';

export function getDisplayPath(file: AttachedFileContext, workspaceRoot?: string): string {
  const fsPath = file.uri.fsPath;
  if (workspaceRoot && fsPath.startsWith(workspaceRoot + path.sep)) {
    return fsPath.slice(workspaceRoot.length + 1);
  }
  if (fsPath.startsWith('/dropped/') || fsPath.startsWith('/attached/')) {
    return file.name;
  }
  return fsPath;
}

function escapeXmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderAttachmentContextMessage(
  attachedFiles: Map<string, AttachedFileContext>,
  workspaceRoot?: string
): string {
  const renderedFiles = Array.from(attachedFiles.values())
    .map(file => {
      const filePath = file.readOnly
        ? `reference-only:${file.name}`
        : file.uri.fsPath.startsWith('/dropped/') || file.uri.fsPath.startsWith('/attached/')
          ? (workspaceRoot ? `${workspaceRoot}/${file.name}` : file.name)
          : file.uri.fsPath;

      if (file.languageId === '__folder__') {
        return [
          `<manulai_attached_folder name="${escapeXmlAttr(file.name)}" path="${escapeXmlAttr(filePath)}">`,
          file.content,
          '</manulai_attached_folder>'
        ].join('\n');
      }

      return [
        `<manulai_attached_file file="${escapeXmlAttr(file.name)}" path="${escapeXmlAttr(filePath)}"${file.readOnly ? ' readonly="true"' : ''}>`,
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

export function getActiveFileState(
  activeEditor: vscode.TextEditor | undefined,
  attachedFiles: Map<string, AttachedFileContext>,
  workspaceRoot?: string
): WebviewActiveFileState | undefined {
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

  if (isRealFile && attachedFiles.has(uri.fsPath)) {
    return undefined;
  }

  const displayPath = isRealFile
    ? getDisplayPath({
        uri,
        name: path.basename(uri.fsPath),
        content: '',
        languageId: document.languageId
      }, workspaceRoot)
    : (document.fileName || 'untitled');

  return {
    path: isRealFile ? uri.fsPath : (document.fileName || 'untitled'),
    name: path.basename(document.fileName || displayPath || 'untitled'),
    displayPath
  };
}

export function formatToolTextBlock(value: unknown): string {
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

export function formatToolMessageForTranscript(
  message: OllamaMessage,
  options: {
    truncateLongResponse: (content: string) => string;
    buildRevertAction: (operationIds: string[] | undefined) => WebviewRenderableMessage['revertAction'];
  }
): WebviewRenderableMessage | undefined {
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
      content: `Tool: ${message.tool_name}\n\n${options.truncateLongResponse(message.content)}`,
      revertAction: options.buildRevertAction(message.revertOperationIds)
    };
  }

  switch (message.tool_name) {
    case 'execute_terminal_command': {
      const command = String(parsed?.command ?? '');
      const exitCode = String(parsed?.exitCode ?? '');
      const stdout = formatToolTextBlock(parsed?.stdout);
      const stderr = formatToolTextBlock(parsed?.stderr);
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
        revertAction: options.buildRevertAction(message.revertOperationIds)
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
          revertAction: options.buildRevertAction(message.revertOperationIds)
        };
      }

      const targetPath = String(parsed?.path ?? '');
      const languageId = String(parsed?.languageId ?? 'plaintext');
      const startLine = parsed?.startLine !== undefined ? String(parsed.startLine) : '';
      const endLine = parsed?.endLine !== undefined ? String(parsed.endLine) : '';
      const totalLines = parsed?.totalLines !== undefined ? String(parsed.totalLines) : '';
      const content = formatToolTextBlock(parsed?.content);
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
        revertAction: options.buildRevertAction(message.revertOperationIds)
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
          revertAction: options.buildRevertAction(message.revertOperationIds)
        };
      }

      const targetPath = String(parsed?.path ?? parsed?.deleted ?? '');
      const bytesWritten = parsed?.bytesWritten !== undefined ? String(parsed.bytesWritten) : '';
      const replacements = parsed?.replacements !== undefined ? String(parsed.replacements) : '';
      const diff = formatToolTextBlock(parsed?.diff);
      const preview = formatToolTextBlock(parsed?.preview);
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
        revertAction: options.buildRevertAction(message.revertOperationIds)
      };
    }
    default: {
      const error = parsed?.error ? String(parsed.error) : '';
      if (error) {
        return {
          role: 'tool',
          content: `Tool: ${message.tool_name}\n\n${error}`,
          revertAction: options.buildRevertAction(message.revertOperationIds)
        };
      }

      const summary = formatToolTextBlock(JSON.stringify(parsed, null, 2));
      return {
        role: 'tool',
        content: summary
          ? `Tool: ${message.tool_name}\n\nResult\n\n\`\`\`json\n${summary}\n\`\`\``
          : `Tool: ${message.tool_name}`,
        revertAction: options.buildRevertAction(message.revertOperationIds)
      };
    }
  }
}