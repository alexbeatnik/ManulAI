import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Default search paths for agent instruction files, relative to workspace root.
 * Ordered by priority — first match wins.
 */
const DEFAULT_SEARCH_PATHS = [
  'AGENTS.md',
  'CLAUDE.md',
  '.claude/AGENTS.md',
  '.claude/CLAUDE.md',
  '.github/copilot-instructions.md',
  '.cursorrules',
  '.ai/agents.md',
  'docs/AGENTS.md',
  'docs/CLAUDE.md',
];

export interface AgentInstructionsResult {
  content: string;
  source: string; // file path that was found
}

/**
 * Reads agent instructions from the first existing file in the search paths.
 * Checks all workspace folders in order.
 * Returns undefined if no file is found.
 */
export async function readAgentInstructions(
  searchPaths: string[] = DEFAULT_SEARCH_PATHS
): Promise<AgentInstructionsResult | undefined> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return undefined;
  }

  for (const folder of workspaceFolders) {
    for (const relativePath of searchPaths) {
      const fileUri = vscode.Uri.joinPath(folder.uri, relativePath);
      try {
        const bytes = await vscode.workspace.fs.readFile(fileUri);
        const content = Buffer.from(bytes).toString('utf8');
        if (content.trim()) {
          return {
            content,
            source: path.join(folder.name, relativePath),
          };
        }
      } catch {
        // File doesn't exist or isn't readable — try next path
        continue;
      }
    }
  }

  return undefined;
}

/**
 * Reads all agent instruction files found across all workspace folders.
 * Useful when multiple instruction files exist (e.g. monorepo with per-package AGENTS.md).
 */
export async function readAllAgentInstructions(
  searchPaths: string[] = DEFAULT_SEARCH_PATHS
): Promise<AgentInstructionsResult[]> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return [];
  }

  const results: AgentInstructionsResult[] = [];
  const seenPaths = new Set<string>();

  for (const folder of workspaceFolders) {
    for (const relativePath of searchPaths) {
      const fileUri = vscode.Uri.joinPath(folder.uri, relativePath);
      const key = fileUri.toString();
      if (seenPaths.has(key)) {
        continue;
      }
      seenPaths.add(key);

      try {
        const bytes = await vscode.workspace.fs.readFile(fileUri);
        const content = Buffer.from(bytes).toString('utf8');
        if (content.trim()) {
          results.push({
            content,
            source: path.join(folder.name, relativePath),
          });
        }
      } catch {
        continue;
      }
    }
  }

  return results;
}

/**
 * Formats agent instructions for injection into a system prompt.
 * Prepends a source header so the model knows where the instructions came from.
 */
export function formatInstructionsForPrompt(
  instructions: AgentInstructionsResult | AgentInstructionsResult[]
): string {
  const items = Array.isArray(instructions) ? instructions : [instructions];
  if (items.length === 0) {
    return '';
  }

  return items
    .map((item) => `---\n[Instructions from ${item.source}]\n\n${item.content}`)
    .join('\n\n');
}
