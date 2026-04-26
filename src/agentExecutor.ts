/**
 * Simplified agent tool execution for Copilot Chat Participant.
 * Uses text-based tool calls (JSON in assistant response).
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { OllamaStreamParser } from './ollamaStreamParser';
import type { OllamaStreamChunk } from './ollamaStreamParser';

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{
    type: 'function';
    function: { name: string; arguments: Record<string, unknown> };
  }>;
  tool_name?: string;
}

export interface AgentToolResult {
  content: string;
  error?: string;
}

const TOOL_DESCRIPTIONS = `
[TOOL FORMAT]

Output tool calls as a single JSON object on its own line:
{"tool": "tool_name", "args": {"param": "value"}}

Available tools:
- create_or_edit_file(filename, content) — Create or overwrite a file
- replace_in_file(filepath, old_text, new_text) — Replace text in existing file
- read_specific_file(filepath) — Read full file contents
- read_file_slice(filepath, startLine, endLine) — Read a line range from a file
- list_workspace_files(directory?) — List files/folders in a directory (default: workspace root)
- execute_terminal_command(command) — Run a shell command (no stdin)
- launch_in_terminal(command) — Open integrated terminal for interactive commands
- delete_file(filepath) — Delete a file
- read_active_file() — Read the currently open file
- project_scan() — Get a recursive tree of the entire workspace

Output ONE tool call JSON per response. No prose before the JSON. Do not wrap the JSON in markdown fences.
`;

export function getAgentToolInstructions(): string {
  return TOOL_DESCRIPTIONS;
}

/**
 * Parses tool calls from assistant text.
 * Supports two formats:
 * 1. Native Ollama tool_calls (already parsed)
 * 2. Text-based: {"tool": "name", "args": {...}}
 */
export function extractToolCallsFromText(text: string): Array<{
  type: 'function';
  function: { name: string; arguments: Record<string, unknown> };
}> {
  const results: ReturnType<typeof extractToolCallsFromText> = [];

  // Look for {"tool": "...", "args": {...}} pattern
  const toolRegex = /\{\s*"tool"\s*:\s*"([^"]+)"\s*,\s*"args"\s*:\s*(\{[\s\S]*?\})\s*\}/g;
  let match: RegExpExecArray | null;

  while ((match = toolRegex.exec(text)) !== null) {
    try {
      const name = match[1];
      const args = JSON.parse(match[2]) as Record<string, unknown>;
      results.push({
        type: 'function',
        function: { name, arguments: args },
      });
    } catch {
      // Invalid JSON, skip
    }
  }

  return results;
}

/**
 * Strips tool call JSON from assistant text to get clean content.
 */
export function stripToolCallsFromText(text: string): string {
  return text
    .replace(/\{\s*"tool"\s*:\s*"[^"]+"\s*,\s*"args"\s*:\s*\{[\s\S]*?\}\s*\}/g, '')
    .trim();
}

/**
 * Execute a single tool call.
 */
export async function executeTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<AgentToolResult> {
  try {
    switch (toolName) {
      case 'read_active_file':
        return await toolReadActiveFile();
      case 'read_specific_file':
        return await toolReadSpecificFile(String(args.filepath ?? ''));
      case 'read_file_slice':
        return await toolReadFileSlice(
          String(args.filepath ?? ''),
          args.startLine as number | undefined,
          args.endLine as number | undefined
        );
      case 'create_or_edit_file':
        return await toolCreateOrEditFile(
          String(args.filename ?? args.filepath ?? ''),
          String(args.content ?? '')
        );
      case 'replace_in_file':
        return await toolReplaceInFile(
          String(args.filepath ?? ''),
          String(args.old_text ?? ''),
          String(args.new_text ?? '')
        );
      case 'execute_terminal_command':
        return await toolExecuteTerminal(String(args.command ?? args.cmd ?? ''));
      case 'launch_in_terminal':
        return await toolLaunchInTerminal(String(args.command ?? args.cmd ?? ''));
      case 'delete_file':
        return await toolDeleteFile(String(args.filepath ?? ''));
      case 'list_workspace_files':
        return await toolListWorkspaceFiles(String(args.directory ?? ''));
      case 'project_scan':
        return await toolProjectScan();
      default:
        return { content: '', error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Tool execution failed';
    return { content: '', error: message };
  }
}

// ─── Tool Implementations ───────────────────────────────────────────────

async function toolReadActiveFile(): Promise<AgentToolResult> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return { content: '', error: 'No active text editor found.' };
  }
  const { document } = editor;
  return {
    content: JSON.stringify({
      path: document.uri.fsPath,
      languageId: document.languageId,
      content: document.getText(),
    }),
  };
}

async function toolReadSpecificFile(filepath: string): Promise<AgentToolResult> {
  if (!filepath.trim()) {
    return { content: '', error: 'filepath is required.' };
  }
  const uri = resolveWorkspaceUri(filepath);
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const content = Buffer.from(bytes).toString('utf8');
    return {
      content: JSON.stringify({ path: uri.fsPath, content }),
    };
  } catch (err) {
    return { content: '', error: `Could not read file: ${filepath} — ${err}` };
  }
}

async function toolReadFileSlice(
  filepath: string,
  startLine?: number,
  endLine?: number
): Promise<AgentToolResult> {
  if (!filepath.trim()) {
    return { content: '', error: 'filepath is required.' };
  }
  const uri = resolveWorkspaceUri(filepath);
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const content = Buffer.from(bytes).toString('utf8');
    const lines = content.split('\n');
    const start = Math.max(0, (startLine ?? 1) - 1);
    const end = Math.min(lines.length, (endLine ?? lines.length));
    const slice = lines.slice(start, end).join('\n');
    return {
      content: JSON.stringify({
        path: uri.fsPath,
        startLine: start + 1,
        endLine: end,
        content: slice,
      }),
    };
  } catch (err) {
    return { content: '', error: `Could not read file slice: ${filepath} — ${err}` };
  }
}

async function toolCreateOrEditFile(filename: string, content: string): Promise<AgentToolResult> {
  if (!filename.trim()) {
    return { content: '', error: 'filename is required.' };
  }
  const uri = resolveWorkspaceUri(filename, true);
  try {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    return {
      content: JSON.stringify({
        path: uri.fsPath,
        action: 'created_or_overwritten',
        length: content.length,
      }),
    };
  } catch (err) {
    return { content: '', error: `Could not write file: ${filename} — ${err}` };
  }
}

async function toolReplaceInFile(
  filepath: string,
  oldText: string,
  newText: string
): Promise<AgentToolResult> {
  if (!filepath.trim()) {
    return { content: '', error: 'filepath is required.' };
  }
  if (!oldText) {
    return { content: '', error: 'old_text is required.' };
  }
  const uri = resolveWorkspaceUri(filepath);
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const content = Buffer.from(bytes).toString('utf8');
    if (!content.includes(oldText)) {
      return { content: '', error: `old_text not found in file: ${filepath}` };
    }
    const updated = content.replace(oldText, newText);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(updated, 'utf8'));
    return {
      content: JSON.stringify({
        path: uri.fsPath,
        action: 'replaced',
        replacements: 1,
      }),
    };
  } catch (err) {
    return { content: '', error: `Could not replace in file: ${filepath} — ${err}` };
  }
}

async function toolExecuteTerminal(command: string): Promise<AgentToolResult> {
  const trimmed = command.trim();
  if (!trimmed) {
    return { content: '', error: 'command is required.' };
  }

  if (isBlockedCommand(trimmed)) {
    return { content: '', error: `Command blocked for safety: ${trimmed}` };
  }

  return new Promise((resolve) => {
    const cp = require('child_process');
    cp.exec(trimmed, { cwd: getWorkspaceRoot() }, (error: Error | null, stdout: string, stderr: string) => {
      const output = stdout + (stderr ? `\nSTDERR:\n${stderr}` : '');
      if (error) {
        resolve({ content: '', error: `Exit code ${error.message}\n${output}` });
      } else {
        resolve({ content: JSON.stringify({ command: trimmed, output }), });
      }
    });
  });
}

async function toolLaunchInTerminal(command: string): Promise<AgentToolResult> {
  const trimmed = command.trim();
  if (!trimmed) {
    return { content: '', error: 'command is required.' };
  }

  if (isBlockedCommand(trimmed)) {
    return { content: '', error: `Command blocked for safety: ${trimmed}` };
  }

  const terminal = vscode.window.createTerminal('ManulAI');
  terminal.sendText(trimmed);
  terminal.show();
  return {
    content: JSON.stringify({ command: trimmed, status: 'launched in integrated terminal' }),
  };
}

async function toolDeleteFile(filepath: string): Promise<AgentToolResult> {
  if (!filepath.trim()) {
    return { content: '', error: 'filepath is required.' };
  }
  const uri = resolveWorkspaceUri(filepath);
  try {
    await vscode.workspace.fs.delete(uri, { useTrash: true });
    return {
      content: JSON.stringify({ path: uri.fsPath, action: 'deleted' }),
    };
  } catch (err) {
    return { content: '', error: `Could not delete file: ${filepath} — ${err}` };
  }
}

async function toolListWorkspaceFiles(directory: string): Promise<AgentToolResult> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) {
    return { content: '', error: 'No workspace folder open.' };
  }
  const targetDir = directory.trim()
    ? vscode.Uri.joinPath(root, directory)
    : root;

  try {
    const entries = await vscode.workspace.fs.readDirectory(targetDir);
    const files = entries
      .map(([name, type]) => {
        const t = type === vscode.FileType.Directory ? 'dir' : 'file';
        return `${t}: ${name}`;
      })
      .sort();
    return {
      content: JSON.stringify({ directory: targetDir.fsPath, files }),
    };
  } catch (err) {
    return { content: '', error: `Could not list directory: ${directory} — ${err}` };
  }
}

async function toolProjectScan(): Promise<AgentToolResult> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) {
    return { content: '', error: 'No workspace folder open.' };
  }

  async function scan(dir: vscode.Uri, depth = 0): Promise<Array<{ name: string; type: string; children?: unknown }>> {
    if (depth > 4) {
      return [{ name: '...', type: 'truncated' }];
    }
    try {
      const entries = await vscode.workspace.fs.readDirectory(dir);
      const result: Array<{ name: string; type: string; children?: unknown }> = [];
      for (const [name, type] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
        if (name.startsWith('.') || name === 'node_modules') {
          continue;
        }
        const isDir = type === vscode.FileType.Directory;
        if (isDir) {
          const children = await scan(vscode.Uri.joinPath(dir, name), depth + 1);
          result.push({ name, type: 'directory', children });
        } else {
          result.push({ name, type: 'file' });
        }
      }
      return result;
    } catch {
      return [];
    }
  }

  const tree = await scan(root);
  return {
    content: JSON.stringify({ root: root.fsPath, tree }),
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function getWorkspaceRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}

function resolveWorkspaceUri(targetPath: string, allowCreate = false): vscode.Uri {
  const normalized = targetPath.trim();
  if (!normalized) {
    throw new Error('Path is required.');
  }
  if (path.isAbsolute(normalized)) {
    return vscode.Uri.file(normalized);
  }
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) {
    throw new Error('No workspace folder open.');
  }
  return vscode.Uri.joinPath(root, normalized);
}

function isBlockedCommand(command: string): boolean {
  const lower = command.toLowerCase();
  const dangerous = [
    'rm -rf /',
    'rm -rf ~',
    'rm -rf $home',
    'sudo',
    'shutdown',
    'reboot',
    'mkfs',
    'dd if=',
    ':(){:|:&};:',
    'chmod -r 777 /',
    'chmod -r 777 ~',
  ];
  for (const d of dangerous) {
    if (lower.includes(d)) {
      return true;
    }
  }
  // curl/wget piped to shell
  if (/\b(curl|wget)\b.*\|.*\b(sh|bash)\b/.test(lower)) {
    return true;
  }
  return false;
}
