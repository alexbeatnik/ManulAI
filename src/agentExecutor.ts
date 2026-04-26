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

/** Maps common hallucinated tool names to valid ones. */
const TOOL_NAME_ALIASES: Record<string, string> = {
  'create_file': 'create_or_edit_file',
  'write_file': 'create_or_edit_file',
  'edit_file': 'create_or_edit_file',
  'update_file': 'create_or_edit_file',
  'modify_file': 'replace_in_file',
  'run_command': 'execute_terminal_command',
  'run_terminal': 'execute_terminal_command',
  'shell': 'execute_terminal_command',
  'open_terminal': 'launch_in_terminal',
  'read_file': 'read_specific_file',
  'get_file': 'read_specific_file',
  'view_file': 'read_specific_file',
  'list_files': 'list_workspace_files',
  'ls': 'list_workspace_files',
  'scan_project': 'project_scan',
  'workspace_scan': 'project_scan',
  'tree': 'project_scan',
  'delete': 'delete_file',
  'remove_file': 'delete_file',
};

function normalizeToolName(name: string): string {
  return TOOL_NAME_ALIASES[name.toLowerCase().trim()] ?? name;
}

export function getAgentToolInstructions(): string {
  return TOOL_DESCRIPTIONS;
}

/**
 * Parses tool calls from assistant text.
 * Supports multiple formats:
 * 1. {"tool": "name", "args": {...}}
 * 2. {"tool": "name", "parameters": {...}}
 * 3. Flat format: {"tool": "name", "filepath": "...", ...}
 */
export function extractToolCallsFromText(text: string): Array<{
  type: 'function';
  function: { name: string; arguments: Record<string, unknown> };
}> {
  const results: ReturnType<typeof extractToolCallsFromText> = [];
  const seen = new Set<string>();

  // Pattern 1: {"tool": "...", "args": {...}}
  const argsRegex = /\{\s*"tool"\s*:\s*"([^"]+)"\s*,\s*"args"\s*:\s*(\{[\s\S]*?\})\s*\}/g;
  let match: RegExpExecArray | null;
  while ((match = argsRegex.exec(text)) !== null) {
    try {
      const name = normalizeToolName(match[1]);
      const args = JSON.parse(match[2]) as Record<string, unknown>;
      const entry = { type: 'function' as const, function: { name, arguments: args } };
      const key = JSON.stringify(entry);
      if (!seen.has(key)) { seen.add(key); results.push(entry); }
    } catch { /* ignore invalid JSON */ }
  }

  // Pattern 2: {"tool": "...", "parameters": {...}}
  const paramsRegex = /\{\s*"tool"\s*:\s*"([^"]+)"\s*,\s*"parameters"\s*:\s*(\{[\s\S]*?\})\s*\}/g;
  while ((match = paramsRegex.exec(text)) !== null) {
    try {
      const name = normalizeToolName(match[1]);
      const args = JSON.parse(match[2]) as Record<string, unknown>;
      const entry = { type: 'function' as const, function: { name, arguments: args } };
      const key = JSON.stringify(entry);
      if (!seen.has(key)) { seen.add(key); results.push(entry); }
    } catch { /* ignore invalid JSON */ }
  }

  // Pattern 3: Flat format {"tool": "name", "filepath": "...", ...}
  const flatRegex = /\{\s*"tool"\s*:\s*"([^"]+)"(?:\s*,\s*"(args|parameters)"\s*:\s*\{|\s*,\s*"([^"]+)"\s*:)/g;
  while ((match = flatRegex.exec(text)) !== null) {
    if (match[2] === 'args' || match[2] === 'parameters') continue; // Already handled
    try {
      const fullMatch = text.slice(match.index).match(/^\{[\s\S]*?\}/);
      if (!fullMatch) continue;
      const parsed = JSON.parse(fullMatch[0]) as Record<string, unknown>;
      const { tool, args, parameters, ...rest } = parsed;
      const name = normalizeToolName(String(tool ?? ''));
      const argObj = (args ?? parameters ?? rest) as Record<string, unknown>;
      const entry = { type: 'function' as const, function: { name, arguments: argObj } };
      const key = JSON.stringify(entry);
      if (!seen.has(key)) { seen.add(key); results.push(entry); }
    } catch { /* ignore invalid JSON */ }
  }

  return results;
}

/**
 * Strips tool call JSON from assistant text to get clean content.
 * Handles multiple formats and markdown-wrapped JSON.
 */
export function stripToolCallsFromText(text: string): string {
  return text
    // Remove markdown code blocks containing tool JSON
    .replace(/```(?:json)?\s*\n?\s*\{\s*"tool"\s*:\s*"[^"]+"[\s\S]*?\}\s*\n?\s*```/gi, '')
    // Remove inline JSON with args
    .replace(/\{\s*"tool"\s*:\s*"[^"]+"\s*,\s*"args"\s*:\s*\{[\s\S]*?\}\s*\}/g, '')
    // Remove inline JSON with parameters
    .replace(/\{\s*"tool"\s*:\s*"[^"]+"\s*,\s*"parameters"\s*:\s*\{[\s\S]*?\}\s*\}/g, '')
    // Remove flat format JSON
    .replace(/\{\s*"tool"\s*:\s*"[^"]+"\s*,\s*"[^"]+"\s*:\s*"[^"]*"[\s\S]*?\}\s*\}/g, '')
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
