import * as vscode from 'vscode';
import * as path from 'path';

export interface SkillResult {
  name: string;
  description: string;
  content: string;
  source: string;
}

/**
 * Default glob patterns for skill directories.
 */
const DEFAULT_SKILL_PATTERNS = [
  '.claude/skills/**/*.md',
  'skills/**/*.md',
  '.github/skills/**/*.md',
  '.ai/skills/**/*.md',
];

/**
 * Parses YAML frontmatter from markdown content.
 * Looks for --- ... --- block at the start.
 */
function parseFrontmatter(raw: string): { name: string; description: string; body: string } {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith('---')) {
    return { name: '', description: '', body: raw };
  }

  const end = trimmed.indexOf('---', 3);
  if (end === -1) {
    return { name: '', description: '', body: raw };
  }

  const front = trimmed.slice(3, end).trim();
  const body = trimmed.slice(end + 3).trimStart();

  const nameMatch = front.match(/^name:\s*(.+)$/m);
  const descMatch = front.match(/^description:\s*(.+)$/m);

  return {
    name: nameMatch ? nameMatch[1].trim() : '',
    description: descMatch ? descMatch[1].trim() : '',
    body,
  };
}

/**
 * Reads all skill files from the workspace matching the given patterns.
 */
export async function readWorkspaceSkills(
  patterns: string[] = DEFAULT_SKILL_PATTERNS
): Promise<SkillResult[]> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return [];
  }

  const results: SkillResult[] = [];
  const seen = new Set<string>();

  for (const folder of workspaceFolders) {
    for (const pattern of patterns) {
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, pattern),
        '**/node_modules/**'
      );
      for (const uri of uris) {
        const key = uri.toString();
        if (seen.has(key)) continue;
        seen.add(key);

        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          const raw = Buffer.from(bytes).toString('utf8');
          if (!raw.trim()) continue;

          const meta = parseFrontmatter(raw);
          results.push({
            name: meta.name || path.basename(path.dirname(uri.fsPath)),
            description: meta.description,
            content: meta.body,
            source: path.relative(folder.uri.fsPath, uri.fsPath),
          });
        } catch {
          continue;
        }
      }
    }
  }

  return results;
}

/**
 * Formats skills for injection into a system prompt.
 */
export function formatSkillsForPrompt(skills: SkillResult[]): string {
  if (skills.length === 0) {
    return '';
  }

  const sections = skills.map(
    (s) =>
      `## Skill: ${s.name}${s.description ? ` — ${s.description}` : ''}\n[Source: ${s.source}]\n\n${s.content}`
  );

  return `---\n# Workspace Skills\n\n${sections.join('\n\n---\n\n')}`;
}
