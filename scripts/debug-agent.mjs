#!/usr/bin/env node
/**
 * ManulAI debug runner — sends requests directly to Ollama and simulates the
 * agent loop without reinstalling the extension.
 *
 * Usage:
 *   node scripts/debug-agent.mjs "your prompt"
 *   node scripts/debug-agent.mjs  (uses default split-file prompt)
 *
 * Env vars:
 *   MANUL_MODEL   Ollama model name (default: qwen2.5-coder:7b)
 *   OLLAMA_URL    Ollama base URL   (default: http://localhost:11434)
 *   DRY_RUN       true to simulate writes without touching disk (default: false = real writes)
 *   MAX_TURNS     max agent turns   (default: 30)
 *   LOG_FILE      path to save session JSONL (default: .manulai/logs/debug-<ts>.jsonl)
 *   TARGET_FILE   src-relative path of the file to split (default: src/ManulAiChatProvider.ts)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wsRoot = path.resolve(__dirname, '..');

const OLLAMA_URL  = process.env.OLLAMA_URL  ?? 'http://localhost:11434';
const MODEL       = process.env.MANUL_MODEL ?? 'qwen2.5-coder:7b';
const DRY_RUN     = process.env.DRY_RUN === 'true';
const MAX_TURNS   = parseInt(process.env.MAX_TURNS ?? '30', 10);

// The large file to split. Use TARGET_FILE env var to override.
const TARGET_FILE = process.env.TARGET_FILE ?? 'src/ManulAiChatProvider.ts';
const TARGET_BASENAME = path.basename(TARGET_FILE, '.ts'); // e.g. "ManulAiChatProvider"

const sessionId   = new Date().toISOString().replace(/[:.]/g, '-');
const logDir      = path.join(wsRoot, '.manulai', 'logs');
const LOG_FILE    = process.env.LOG_FILE ?? path.join(logDir, `debug-${sessionId}.jsonl`);

// In-session cache for DRY_RUN "written" files (module-level so executeTool can access it)
const dryRunFiles = new Map();

const userPrompt = process.argv[2];
if (!userPrompt) {
  console.error('Usage: node scripts/debug-agent.mjs "your prompt"');
  process.exit(1);
}

// Detect whether this run is a file-splitting task — only then enforce extractionCount gate
const IS_SPLIT_TASK = /розбий|split|refactor.*module|extract.*module/i.test(userPrompt);

// ─── Colours ───────────────────────────────────────────────────────────────
const R = '\x1b[31m', G = '\x1b[32m', Y = '\x1b[33m', B = '\x1b[34m';
const C = '\x1b[36m', W = '\x1b[37m', BOLD = '\x1b[1m', RESET = '\x1b[0m';
const label = (col, tag, msg) =>
  console.log(`${col}${BOLD}[${tag}]${RESET} ${msg}`);

// ─── JSONL log ──────────────────────────────────────────────────────────────
mkdirSync(logDir, { recursive: true });
function logEvent(event, data = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...data });
  writeFileSync(LOG_FILE, line + '\n', { flag: 'a' });
}

// ─── System prompt (keep in sync with callOllama in ManulAiChatProvider.ts) ─
function buildAgentMandate() {
  return `[IDENTITY]
You are ManulAI, a local VS Code coding agent.
Workspace root: ${wsRoot}
All file paths are relative to the workspace root unless absolute.

---

[PRIMARY DIRECTIVE]

You are an ACTION agent. Execute tasks using tools. Never describe what you intend to do instead of doing it.

---

[DECISION FLOW]

1. File or code modification needed → use file tools
2. Command execution needed → use execute_terminal_command
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

Never assume. Always verify.

---

[FILE SPLITTING RULES]

When splitting a file into smaller modules:

1. Read a bounded section with read_file_slice (e.g. lines 1–120).
2. Identify one self-contained block (interfaces, a class, utility functions).
3. Call create_or_edit_file with the NEW file path and the EXACT copied code.
   - content MUST be the real extracted TypeScript code, NOT a comment placeholder.
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
}

// ─── Tool definitions ────────────────────────────────────────────────────────
function getToolDefinitions() {
  return [
    {
      type: 'function',
      function: {
        name: 'list_workspace_files',
        description: 'List files and directories in a workspace folder.',
        parameters: {
          type: 'object',
          properties: { directory: { type: 'string', description: 'Optional subdirectory path.' } },
          required: []
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_file_slice',
        description: 'Read a bounded line range from a file.',
        parameters: {
          type: 'object',
          properties: {
            filepath: { type: 'string' },
            startLine: { type: 'number' },
            endLine: { type: 'number' }
          },
          required: ['filepath', 'startLine', 'endLine']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_specific_file',
        description: 'Read the full content of a file (capped at 200 lines for large files).',
        parameters: {
          type: 'object',
          properties: { filepath: { type: 'string' } },
          required: ['filepath']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'create_or_edit_file',
        description: 'Create a new file or overwrite an existing one.',
        parameters: {
          type: 'object',
          properties: {
            filename: { type: 'string', description: 'Workspace-relative or absolute path.' },
            content: { type: 'string', description: 'Full file content.' }
          },
          required: ['filename', 'content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'replace_in_file',
        description: 'Replace an exact text block in a file with new content.',
        parameters: {
          type: 'object',
          properties: {
            filepath: { type: 'string' },
            old_text: { type: 'string', description: 'Exact text to find (must match exactly).' },
            new_text: { type: 'string', description: 'Replacement text.' }
          },
          required: ['filepath', 'old_text', 'new_text']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'execute_terminal_command',
        description: 'Execute a shell command in the workspace root.',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command']
        }
      }
    }
  ];
}

// ─── Tool execution ──────────────────────────────────────────────────────────
function resolveFilepath(fp) {
  if (!fp) return '';
  if (path.isAbsolute(fp)) return fp;
  return path.join(wsRoot, fp);
}

async function executeTool(name, args) {
  switch (name) {
    case 'list_workspace_files': {
      const dir = resolveFilepath(args.directory ?? '') || wsRoot;
      try {
        const { stdout } = await execAsync(`ls -la "${dir}"`);
        const items = stdout.trim().split('\n').slice(1).map(line => {
          const parts = line.trim().split(/\s+/);
          const n = parts[parts.length - 1];
          return { name: n, type: line.startsWith('d') ? 'directory' : 'file' };
        }).filter(i => i.name && i.name !== '.' && i.name !== '..');
        return JSON.stringify({ path: dir, items });
      } catch (e) { return JSON.stringify({ error: e.message }); }
    }

    case 'read_file_slice': {
      const fp = resolveFilepath(args.filepath);
      try {
        // In DRY_RUN mode, serve from cache if file was written in this session
        const rawContent = dryRunFiles.has(fp)
          ? dryRunFiles.get(fp)
          : readFileSync(fp, 'utf8');
        const lines = rawContent.split('\n');
        const start = Math.max(1, Number(args.startLine ?? 1));
        const end   = Math.min(lines.length, Number(args.endLine ?? lines.length));
        return JSON.stringify({
          path: fp, languageId: 'typescript',
          startLine: start, endLine: end,
          totalLines: lines.length,
          content: lines.slice(start - 1, end).join('\n')
        });
      } catch (e) { return JSON.stringify({ error: e.message }); }
    }

    case 'read_specific_file': {
      const fp = resolveFilepath(args.filepath);
      try {
        // In DRY_RUN mode, serve from cache if file was written in this session
        const rawContent = dryRunFiles.has(fp)
          ? dryRunFiles.get(fp)
          : readFileSync(fp, 'utf8');
        const lines = rawContent.split('\n');
        const capped = lines.length > 200 ? lines.slice(0, 200) : lines;
        const result = {
          path: fp, languageId: 'typescript',
          startLine: 1, endLine: capped.length, totalLines: lines.length,
          content: capped.join('\n')
        };
        if (lines.length > 200) {
          result.warning = `File has ${lines.length} lines; only first 200 shown. Use read_file_slice for specific sections.`;
        }
        return JSON.stringify(result);
      } catch (e) { return JSON.stringify({ error: e.message }); }
    }

    case 'create_or_edit_file': {
      const fp = resolveFilepath(args.filename ?? args.filepath ?? '');
      let content = String(args.content ?? '');
      if (!fp) return JSON.stringify({ error: 'filename is required.' });

      // Guard: if overwriting a large existing file with much smaller content, force replace_in_file
      if (existsSync(fp)) {
        try {
          const existing = readFileSync(fp, 'utf8');
          if (existing.length > content.length * 3 && existing.split('\n').length > 50) {
            return JSON.stringify({
              error: `File already exists and is ${existing.split('\n').length} lines long. ` +
                `Do NOT overwrite it with create_or_edit_file — use replace_in_file instead. ` +
                `Read the section you want to extract with read_file_slice, create a NEW file for the extracted code, ` +
                `then use replace_in_file on the original to replace that block with an import statement.`
            });
          }
        } catch { /* file unreadable — let it proceed */ }
      }

      // Placeholder guard (same as extension)
      const nonEmptyLines = content.replace(/\r\n/g, '\n').split('\n').map(l => l.trim()).filter(Boolean);
      const codeLike = nonEmptyLines.filter(l =>
        !/^(?:\/\/|\/\*|\*|#)/.test(l) &&
        (/(?:^|\s)(?:export|import|const|let|var|function|class|interface|type|enum|async|return)\b/.test(l) || /[{}();=]/.test(l))
      );
      if (codeLike.length === 0) {
        return JSON.stringify({
          error: 'Content is a placeholder or has no actual code — do NOT write placeholder comments. ' +
            'Copy the exact TypeScript code blocks you want to extract directly into this new file. ' +
            'Then call replace_in_file on the original file to replace that extracted block with an import statement.'
        });
      }

      // Import-shell guard: reject files whose only content is import / re-export lines (no actual definitions)
      const nonCommentCodeLines = nonEmptyLines.filter(l => !/^(?:\/\/|\/\*|\*|#)/.test(l));
      const allAreImports = nonCommentCodeLines.length > 0 &&
        nonCommentCodeLines.every(l =>
          /^\s*import\s/.test(l) || /^\s*export\s+(?:type\s+)?\{/.test(l) || /^\s*export\s+\*/.test(l));
      if (allAreImports) {
        return JSON.stringify({
          error: 'Content contains only import or re-export statements with no actual TypeScript definitions. ' +
            'The new file must contain the ACTUAL definitions (e.g. `interface Foo { ... }`, `type Bar = ...`, `function baz() { ... }`). ' +
            'Use read_file_slice to read the source section, then copy the exact definition blocks into this new file.'
        });
      }

      // Auto-export fix: add 'export' to interface/type/class/enum declarations missing it
      if (!/\bexport\b/.test(content)) {
        const fixedLines = content.split('\n').map(line => {
          const trimmed = line.trimStart();
          if (/^(interface|type|class|enum)\s+\w/.test(trimmed)) {
            return line.replace(/^(\s*)(interface|type|class|enum)(\s+\w)/, '$1export $2$3');
          }
          return line;
        });
        const fixedContent = fixedLines.join('\n');
        if (fixedContent !== content) {
          label(Y, 'AUTO-EXPORT FIX', `Added export keyword to declarations in ${path.basename(fp)}`);
          content = fixedContent;
        }
      }

      if (DRY_RUN) {
        label(Y, 'DRY-RUN write', `${fp}\n  ${content.substring(0, 150).replace(/\n/g, '\n  ')}${content.length > 150 ? '\n  ...' : ''}`);
        dryRunFiles.set(fp, content); // cache for reads
        return JSON.stringify({ path: fp, bytesWritten: content.length, preview: content.substring(0, 80), dryRun: true });
      }
      writeFileSync(fp, content, 'utf8');
      return JSON.stringify({ path: fp, bytesWritten: content.length, preview: content.substring(0, 80) });
    }

    case 'replace_in_file': {
      const fp = resolveFilepath(args.filepath ?? '');
      const oldText = String(args.old_text ?? '');
      const newText = String(args.new_text ?? '');
      if (!fp) return JSON.stringify({ error: 'filepath is required.' });

      if (oldText.trim() === newText.trim()) {
        return JSON.stringify({
          error: 'old_text and new_text are identical — this replace would make no change. ' +
            'To split the file, create a new file with the extracted code, then replace the block with an import statement.'
        });
      }

      // Trivial 1-line rename guard
      const removedLines = oldText.split('\n');
      const addedLines   = newText.split('\n');
      if (removedLines.length <= 1 && addedLines.length <= 1 && !/^\s*import\b/.test(newText)) {
        return JSON.stringify({
          error: 'Single-line rename without an import replacement is not a valid extraction step. ' +
            'Extract a self-contained block (multiple lines) and replace it with an import statement.'
        });
      }

      try {
        const current = readFileSync(fp, 'utf8');
        if (!current.includes(oldText)) {
          const firstLine = oldText.split('\n')[0].trim();
          const approxLine = current.split('\n').findIndex(l => l.includes(firstLine));
          return JSON.stringify({
            error: 'old_text not found in file — text does not match exactly (check whitespace/indentation).',
            suggestedSlice: approxLine >= 0
              ? { filepath: fp, startLine: Math.max(1, approxLine - 3), endLine: approxLine + 25 }
              : undefined
          });
        }
        const rmCount = removedLines.length;
        const addCount = addedLines.length;
        const diff = `Updated ${path.basename(fp)} — replaced 1 block (${rmCount} lines → ${addCount} lines):\n` +
          `\`\`\`diff\n${removedLines.slice(0, 4).map(l => `-${l}`).join('\n')}${rmCount > 4 ? '\n...' : ''}\n` +
          `${addedLines.slice(0, 4).map(l => `+${l}`).join('\n')}${addCount > 4 ? '\n...' : ''}\n\`\`\``;

        if (DRY_RUN) {
          label(Y, 'DRY-RUN replace', `${path.basename(fp)}: ${rmCount} lines → ${addCount} lines\n  old: ${oldText.substring(0, 80)}\n  new: ${newText.substring(0, 80)}`);
          return JSON.stringify({ path: fp, replacements: 1, diff, dryRun: true });
        }
        const updated = current.replace(oldText, newText);
        writeFileSync(fp, updated, 'utf8');
        return JSON.stringify({ path: fp, replacements: 1, diff });
      } catch (e) { return JSON.stringify({ error: e.message }); }
    }

    case 'execute_terminal_command': {
      const cmd = String(args.command ?? '');
      if (!cmd) return JSON.stringify({ error: 'command is required.' });
      try {
        const { stdout, stderr } = await execAsync(cmd, { cwd: wsRoot, timeout: 30_000, maxBuffer: 1024 * 512 });
        return JSON.stringify({ command: cmd, exitCode: 0, stdout, stderr });
      } catch (e) {
        return JSON.stringify({ command: cmd, exitCode: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '', error: e.message });
      }
    }

    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

// Extract exportable TypeScript definitions (interface/type/enum/class) from source code
function extractDefinitionsFromSource(source) {
  const lines = source.split('\n');
  const resultLines = [];
  let depth = 0;
  let capturing = false;

  for (const line of lines) {
    const trimmed = line.trimStart();
    const isDecl = /^(?:export\s+)?(?:type|interface|enum|class)\s+\w/.test(trimmed);
    if (!capturing && isDecl) {
      capturing = true;
      depth = 0;
    }
    if (capturing) {
      for (const ch of line) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
      }
      // Auto-export if declaration line lacks it
      const outLine = (!isDecl || /^export\b/.test(trimmed)) ? line : ('export ' + trimmed);
      resultLines.push(outLine);
      if (depth <= 0 && resultLines.length > 0) {
        capturing = false;
        resultLines.push('');
      }
    }
  }
  return resultLines.join('\n').trim();
}

// ─── Text-based tool call parser (handles leaked JSON tool calls) ────────────
const KNOWN_TOOLS = ['list_workspace_files', 'read_file_slice', 'read_specific_file', 'create_or_edit_file', 'replace_in_file', 'execute_terminal_command'];

// Escape literal control chars (newlines, tabs, etc.) that appear inside JSON string values only.
// Applies only within "..." contexts so structural whitespace in pretty-printed JSON is preserved.
function escapeJsonStringValues(s) {
  let result = '', inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === '\\') { result += ch + (s[++i] ?? ''); continue; }
      if (ch === '\r') { result += (s[i+1] === '\n') ? (i++, '\\n') : '\\r'; continue; }
      if (ch === '\n') { result += '\\n'; continue; }
      if (ch === '\t') { result += '\\t'; continue; }
      if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true;
    }
    result += ch;
  }
  return result;
}

function parseToolCallsFromText(content) {
  const results = [];

  // Match {"name": "tool_name", "arguments": {...}} — use balanced-brace finder for nested objects
  // Handles both compact {"name":"x"} and indented/pretty-printed JSON from the model
  if (content.includes('"name"')) {
    const startRe = /\{[\s]*"name"/g;
    let startMatch;
    while ((startMatch = startRe.exec(content)) !== null) {
      const start = startMatch.index;
      // Walk balanced braces to find end of object
      let depth = 0, inString = false, escape = false, end = -1;
      for (let j = start; j < content.length; j++) {
        const ch = content[j];
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inString) { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        if (ch === '}') { depth--; if (depth === 0) { end = j; break; } }
      }
      if (end !== -1) {
        let obj = null;
        try {
          obj = JSON.parse(content.substring(start, end + 1));
        } catch {
          // Fallback: escape literal control chars inside string values only (preserves structural whitespace)
          try {
            obj = JSON.parse(escapeJsonStringValues(content.substring(start, end + 1)));
          } catch { /* ignore */ }
        }
        if (obj?.name && obj?.arguments !== undefined) {
          results.push({ function: { name: obj.name, arguments: obj.arguments } });
        }
      }
    }
  }

  // Match fenced code blocks — extract full content and try to parse as JSON
  const fencedPattern = /```(?:json|tool_call)?\s*\n([\s\S]*?)\n```/g;
  let match;
  while ((match = fencedPattern.exec(content)) !== null) {
    try {
      const obj = JSON.parse(match[1].trim());
      if (obj.name && obj.arguments !== undefined) {
        results.push({ function: { name: obj.name, arguments: obj.arguments } });
      }
    } catch { /* ignore */ }
  }

  // Match "Executing step N: tool_name with arguments {...}" — model announces instead of calling
  const announcedPattern = /execut(?:e|ing)\s+step\s+\d+[:/]\s*(\w+)\s+(?:with\s+)?arguments?\s*(\{[\s\S]*?\})(?=\s*(?:```|$|\n\n))/gi;
  while ((match = announcedPattern.exec(content)) !== null) {
    try {
      const toolName = match[1];
      const argsObj = JSON.parse(match[2]);
      results.push({ function: { name: toolName, arguments: argsObj } });
    } catch { /* ignore */ }
  }

  // Match tool_name("single string arg") or tool_name({...}) Python/JS-style calls
  for (const toolName of KNOWN_TOOLS) {
    const callRe = new RegExp(`${toolName}\\s*\\(\\s*("(?:[^"\\\\]|\\\\.)*"|\\{[\\s\\S]*?\\})\\s*\\)`, 'g');
    while ((match = callRe.exec(content)) !== null) {
      try {
        const argStr = match[1].trim();
        let args;
        if (argStr.startsWith('"')) {
          const val = JSON.parse(argStr);
          // Skip double-wrapped calls like execute_terminal_command("execute_terminal_command(...)")
          if (typeof val === 'string' && KNOWN_TOOLS.some(t => val.startsWith(t + '('))) continue;
          if (toolName === 'execute_terminal_command') args = { command: val };
          else if (toolName === 'read_specific_file') args = { filepath: val };
          else if (toolName === 'list_workspace_files') args = { directory: val };
          else args = { filepath: val };
        } else {
          args = JSON.parse(argStr);
        }
        results.push({ function: { name: toolName, arguments: args } });
      } catch { /* ignore */ }
    }
  }

  // Match "**Tool Call:** tool_name with arguments {...}" — markdown-annotated calls
  const toolCallAnnotationPattern = /\*{0,2}tool\s+call\*{0,2}[:\s]+([\w_]+)\s+(?:with\s+)?arguments?\s*(\{[\s\S]*?\})/gi;
  while ((match = toolCallAnnotationPattern.exec(content)) !== null) {
    try {
      const toolName = match[1];
      const argsObj = JSON.parse(match[2]);
      results.push({ function: { name: toolName, arguments: argsObj } });
    } catch { /* ignore */ }
  }

  // Match tool_name with arguments {...} (bare prefix, no markdown)
  const bareWithArgsPattern = /^([\w_]+)\s+with\s+arguments?\s*(\{[\s\S]*?\})/gim;
  while ((match = bareWithArgsPattern.exec(content)) !== null) {
    if (!KNOWN_TOOLS.includes(match[1])) continue;
    try {
      results.push({ function: { name: match[1], arguments: JSON.parse(match[2]) } });
    } catch { /* ignore */ }
  }

  // Match ```sh/bash fenced code as execute_terminal_command
  const shellFencePattern = /```(?:sh|bash|shell|cmd)\s*\n([\s\S]*?)\n```/g;
  while ((match = shellFencePattern.exec(content)) !== null) {
    const cmd = match[1].trim();
    if (cmd && !cmd.startsWith('{')) {
      results.push({ function: { name: 'execute_terminal_command', arguments: { command: cmd } } });
    }
  }

  // Match read_file_slice("filepath", startLine, endLine) positional three-arg format
  const readSlice3Re = /\bread_file_slice\s*\(\s*"([^"]+)"\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g;
  while ((match = readSlice3Re.exec(content)) !== null) {
    results.push({ function: { name: 'read_file_slice', arguments: { filepath: match[1], startLine: parseInt(match[2]), endLine: parseInt(match[3]) } } });
  }

  // Match read_file_slice(filepath, startLine, endLine) — unquoted path (common in plan text)
  const readSlice3UnquotedRe = /\bread_file_slice\s*\(\s*([^\s,()'"`]+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g;
  while ((match = readSlice3UnquotedRe.exec(content)) !== null) {
    results.push({ function: { name: 'read_file_slice', arguments: { filepath: match[1], startLine: parseInt(match[2]), endLine: parseInt(match[3]) } } });
  }

  // Match read_file_slice "filepath" startLine endLine (positional quoted format)
  const readSliceQuoteRe = /\bread_file_slice\s+"([^"]+)"\s+(\d+)\s+(\d+)/g;
  while ((match = readSliceQuoteRe.exec(content)) !== null) {
    results.push({ function: { name: 'read_file_slice', arguments: { filepath: match[1], startLine: parseInt(match[2]), endLine: parseInt(match[3]) } } });
  }

  // Match read_specific_file "filepath" or list_workspace_files "dir"
  const singleQuoteArgRe = /\b(read_specific_file|list_workspace_files)\s+"([^"]+)"/g;
  while ((match = singleQuoteArgRe.exec(content)) !== null) {
    const argKey = match[1] === 'list_workspace_files' ? 'directory' : 'filepath';
    results.push({ function: { name: match[1], arguments: { [argKey]: match[2] } } });
  }

  // Bare read_specific_file with no path argument — default to the primary source file.
  // Handles "Executing step 1: read_specific_file" style (model forgets to specify path).
  if (results.length === 0 &&
      /\bread_specific_file\b/.test(content) &&
      !results.some(r => r.function?.name === 'read_specific_file')) {
    results.push({ function: { name: 'read_specific_file', arguments: { filepath: TARGET_FILE } } });
  }

  // Match ```typescript blocks — model showing code it intends to write.
  // Auto-detect filename from interface/type names when no filename is mentioned.
  if (results.length === 0) {
    const tsFenceRe = /```typescript\n([\s\S]*?)\n```/g;
    while ((match = tsFenceRe.exec(content)) !== null) {
      const codeContent = match[1].trim();
      if (codeContent.length < 50) continue;
      // Must have actual TypeScript definitions (not just imports)
      const hasDefinitions = /(?:export\s+)?(?:interface|type\s+\w+\s*=|class\s|enum\s|function\s|const\s)/.test(codeContent);
      if (!hasDefinitions) continue;
      // Try to find filename from surrounding text (200 chars before the block)
      const textBefore = content.substring(Math.max(0, match.index - 200), match.index);
      const bt = String.fromCharCode(96);
      const filenameMatch =
        textBefore.match(/(?:file|named?|called|path)\s+['"`]?([\w\/.-]+\.ts)['"`]?/i) ||
        textBefore.match(new RegExp(bt + '([\\w\\/.-]+\\.ts)' + bt)) ||
        content.substring(match.index + match[0].length).match(new RegExp(bt + '([\\w\\/.-]+\\.ts)' + bt));
      let filename;
      if (filenameMatch) {
        filename = filenameMatch[1].includes('/') ? filenameMatch[1] : `src/${filenameMatch[1]}`;
      } else {
        // Auto-infer filename from exported symbol names in code
        const symbolNames = [...codeContent.matchAll(/(?:export\s+)?(?:interface|class|enum)\s+(\w+)/g)].map(m => m[1]);
        if (symbolNames.length === 1) filename = `src/${symbolNames[0]}.ts`;
        else if (symbolNames.length > 1) filename = 'src/types.ts';
      }
      if (filename) {
        results.push({ function: { name: 'create_or_edit_file', arguments: { filename, content: codeContent } } });
      }
    }
  }

  return results;
}

// ─── Simple nudge analysis (matches key detectors in processOllamaResponse) ──
function analyzeResponse(content, recentMessages) {
  const hasToolResults = recentMessages.some(m => m.role === 'tool');
  const isLong = content.length > 300;
  const progressLines = content.trim().split('\n').map(l => l.trim()).filter(Boolean);
  const isProgressOnly = content.trim().length < 220 &&
    progressLines.every(l => /^(?:step\s+\d+\s*(?:\/|of)\s*\d+|step\s+\d+\s+completed|execut(?:e|ing)\s+step\s+\d+|reading|i(?:'ll| will)\s+read)/i.test(l));
  const isHallucinatingToolResponse = /<tool_response>/.test(content);
  const isAnnouncedButNotExecuted = /(?:execut(?:e|ing)|proceed(?:ing)?\s+with)\s+(?:with\s+)?step\s+\d+\s*[:/.,!]?/i.test(content) || /step \d+\/\d+:\s*\w/i.test(content);
  const isPassingToUser = /(?:please (?:execute|run|proceed|confirm|provide|read)|would you like me to|shall i (?:proceed|continue)|can you (?:provide|share)|could you (?:provide|share))/i.test(content) && content.length < 800;
  const claimsDone = /(?:step \d+ completed|successfully applied|file (?:created|updated)|has been (?:created|moved|split)|(?<!\w)done\b(?![\s]*[:;{,=(])|(?:all (?:required )?)?tool calls? (?:have )?succeeded|(?:file )?splitting is complete|task(?:s)? (?:is |are )?complete)/i.test(content);  // Mentions a known tool name but parseToolCallsFromText couldn't extract a valid call
  const parsedFromContent = parseToolCallsFromText(content);
  const mentionsToolButNotCalled = parsedFromContent.length === 0 && KNOWN_TOOLS.some(t => content.includes(t));  // looksLikePlan: numbered list. After tool results, also fire when content ends with an execute instruction.
  const endsWithExecute = /execut(?:e|ing)\s+step\s+\d+/i.test(content);
  const looksLikePlan = (
    !hasToolResults || endsWithExecute
  ) &&
    /^\s*\d+\.\s+.{10,}/m.test(content) &&
    content.length > 60 &&
    !isAnnouncedButNotExecuted;

  const requiresContinuation = isProgressOnly || isAnnouncedButNotExecuted || isPassingToUser || isHallucinatingToolResponse ||
    (claimsDone && !hasToolResults) || isLong || mentionsToolButNotCalled;

  return { isLong, isProgressOnly, isAnnouncedButNotExecuted, isPassingToUser, isHallucinatingToolResponse, claimsDone, mentionsToolButNotCalled, looksLikePlan, requiresContinuation };
}

// Builds the reminder message injected after a new extraction file is created.
// Includes actual read content so the model can copy old_text exactly.
function buildReplaceReminder(createdPath, newFileContent, allRecentReads) {
  const baseName = path.basename(createdPath, '.ts');
  const exportNames = [...newFileContent.matchAll(/export\s+(?:(?:type|interface|abstract|declare)\s+)*(?:function\s+|class\s+|const\s+|let\s+|var\s+|enum\s+)?([A-Z][\w]*)/g)]
    .map(m => m[1])
    .filter(n => n && !['from', 'type', 'default', 'as', 'export', 'import', 'declare', 'abstract'].includes(n))
    .slice(0, 10);

  let msg = `File ${path.basename(createdPath)} created. Now call replace_in_file on ${TARGET_FILE} to replace the original ${exportNames[0] ?? 'block'} definition with an import statement.\n`;

  // Find the read that actually contains the exported symbol name
  const allReads = Array.isArray(allRecentReads) ? allRecentReads : (allRecentReads ? [allRecentReads] : []);
  let bestRead = null;
  for (const read of allReads.slice().reverse()) {
    if (read && read.content && exportNames.some(n => read.content.includes(n))) {
      bestRead = read;
      break;
    }
  }
  if (!bestRead && allReads.length > 0) bestRead = allReads[allReads.length - 1];

  if (bestRead && bestRead.content) {
    const lines = bestRead.content.split('\n');
    // Find the start index of each exported symbol, then span from first to last
    const blockStarts = [];
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(?:export\s+)?(?:interface|type\s+\w+\s*(?:=|<)|class\s|enum\s)/.test(lines[i]) &&
          exportNames.some(n => lines[i].includes(n))) {
        blockStarts.push(i);
      }
    }

    let exactBlock = null;
    if (blockStarts.length > 0) {
      const firstIdx = blockStarts[0];
      let depth = 0, lastEndIdx = firstIdx;
      for (let i = firstIdx; i < lines.length; i++) {
        for (const ch of lines[i]) { if (ch === '{') depth++; else if (ch === '}') depth--; }
        if (i > firstIdx && depth === 0) {
          // Check if there's another symbol further in the file
          const remaining = blockStarts.filter(s => s > i);
          if (remaining.length === 0) { lastEndIdx = i; break; }
          // Continue until last symbol's block closes
          lastEndIdx = i;
          if (i >= blockStarts[blockStarts.length - 1]) break;
        }
        lastEndIdx = i;
      }
      exactBlock = lines.slice(firstIdx, lastEndIdx + 1).join('\n');
    }

    if (exactBlock) {
      msg += `\nSet old_text to this EXACT block (copy precisely, do NOT include any import statements above it):\n\`\`\`typescript\n${exactBlock}\n\`\`\`\n`;
    } else {
      msg += `\nContent at lines ${bestRead.startLine}\u2013${bestRead.endLine} of ${TARGET_FILE}:\n\`\`\`typescript\n${bestRead.content.substring(0, 900)}${bestRead.content.length > 900 ? '\n...' : ''}\n\`\`\`\n`;
      msg += `Set old_text = ONLY the block that defines ${exportNames[0] ?? 'the extracted type'} (the type/interface body, NOT the import lines at the top of the file).\n`;
    }
  } else {
    msg += `Use read_file_slice to read the section of ${TARGET_BASENAME}.ts where ${exportNames[0] ?? 'the extracted code'} is defined, then set old_text to that exact block.\n`;
  }

  if (exportNames.length > 0) {
    msg += `Set new_text = \`import { ${exportNames.join(', ')} } from './${baseName}';\`\n`;
  }

  return msg;
}

function buildNudge(analysis, lastToolWasError, ctx = {}) {
  const { pendingReplaceAfterCreate: pReplace, lastSuccessfulRead: lastRead, lastCreatedFileState: lastCreated } = ctx;

  // Context-rich nudge when a new file was created but replace_in_file hasn't succeeded yet
  if (pReplace && lastCreated) {
    let nudge = `You MUST call replace_in_file on ${TARGET_FILE} NOW. You already created ${path.basename(lastCreated.filePath)}.`;
    if (lastRead && lastRead.content) {
      nudge += `\nContent at lines ${lastRead.startLine}–${lastRead.endLine} of ${TARGET_BASENAME}.ts:\n\`\`\`typescript\n${lastRead.content.substring(0, 700)}\n\`\`\``;
      nudge += `\nCopy ONLY the exact block that defines ${lastCreated.exportNames.slice(0, 3).join(', ')} as old_text (do NOT include the import statements at the top).`;
    }
    if (lastCreated.exportNames.length > 0) {
      nudge += `\nnew_text = \`import { ${lastCreated.exportNames.join(', ')} } from './${path.basename(lastCreated.filePath, '.ts')}';\``;
    }
    nudge += `\nCall replace_in_file now — do NOT describe it in text, execute the tool call.`;
    return nudge;
  }

  if (analysis.isHallucinatingToolResponse) {
    const { pendingReplaceAfterCreate, lastCreatedFileState, extractionContinuationPending, lastSuccessfulRead, extractionCount } = ctx;
    if (pendingReplaceAfterCreate && lastCreatedFileState) {
      const names = lastCreatedFileState.exportNames?.join(', ') ?? 'the extracted types';
      return `The tool result is already recorded. Do NOT echo tool results. Call replace_in_file on ${TARGET_FILE} now to replace the original ${names} block with an import statement.`;
    }
    if (extractionContinuationPending) {
      const nextStart = (lastSuccessfulRead?.endLine ?? 120) + 1;
      return `The tool result is already recorded. Do NOT echo tool results. Read the next section — use read_file_slice with lines ${nextStart}–${nextStart + 119} — then extract another block.`;
    }
    return 'The tool result is already recorded. Do NOT echo or repeat tool results in your response. Proceed with the next action.';
  }
  if (analysis.isAnnouncedButNotExecuted) {
    const { pendingReplaceAfterCreate: pReplace, lastCreatedFileState: lastCreated, extractionContinuationPending: contPending, lastSuccessfulRead: lastRead } = ctx;
    if (pReplace && lastCreated) {
      const names = lastCreated.exportNames?.join(', ') ?? 'the extracted types';
      return `Stop writing. Call replace_in_file NOW on ${TARGET_FILE} to replace the original ${names} block with an import statement. Do not describe it — call the tool.`;
    }
    if (contPending && lastRead) {
      const nextStart = lastRead.endLine + 1;
      return `Stop writing. Call read_file_slice NOW: filepath="${TARGET_FILE}", startLine=${nextStart}, endLine=${nextStart + 119}. Then create a new module file and call replace_in_file. No preamble.`;
    }
    if (lastRead) {
      return `Stop writing. You already read lines ${lastRead.startLine}–${lastRead.endLine}. Now call create_or_edit_file to create a new module with the extracted TypeScript definitions. Do not describe it — call the tool.`;
    }
    return `Stop writing plans. Call a tool NOW — use read_file_slice on ${TARGET_FILE} to start.`;
  }
  if (analysis.isPassingToUser) {
    return 'Do not ask the user anything. You have all the tools you need. Use read_file_slice to read the source file, copy the actual TypeScript code, and call create_or_edit_file with that real code.';
  }
  if (lastToolWasError) {
    return 'The last tool call failed. Read the error, then call read_file_slice on the source file to get the actual code, and retry create_or_edit_file with the real extracted TypeScript code (not placeholder comments).';
  }
  if (analysis.isProgressOnly) {
    return 'Do not print progress text. Call a tool now — no preamble.';
  }
  if (analysis.claimsDone) {
    return 'You claimed a step was completed but no tool was called. Call the appropriate tool now.';
  }
  if (analysis.mentionsToolButNotCalled) {
    return 'You described a tool call in plain text but did not actually call it. Use the native tool-calling mechanism to call the tool now.';
  }
  return 'You described changes but did not call a tool. Call the appropriate tool now.';
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  label(B, 'CONFIG', `Model: ${MODEL} | ${OLLAMA_URL} | DryRun: ${DRY_RUN} | MaxTurns: ${MAX_TURNS}`);
  label(B, 'LOG', LOG_FILE);
  label(B, 'PROMPT', userPrompt);
  logEvent('session_start', { model: MODEL, dryRun: DRY_RUN, prompt: userPrompt });

  const messages = [
    {
      role: 'user',
      content: 'You are an expert TypeScript developer. Call tools directly and immediately — do NOT output numbered plans, step lists, or descriptions of what you will do. ' +
        'When asked to split a file: use read_file_slice to read a section, create_or_edit_file to create the new module file, then replace_in_file to replace the original block with an import statement. ' +
        'After each file write, run: execute_terminal_command("npx tsc --noEmit 2>&1 | head -20") to verify nothing broke. Repeat for each extractable block.'
    },
    { role: 'user', content: userPrompt }
  ];

  let turn = 0;
  let retryCount = 0;
  let hadSuccessfulWrite = false; // tracks if any create_or_edit_file / replace_in_file succeeded
  let pendingReplaceAfterCreate = false; // set after new-file create; cleared after successful replace_in_file
  let lastSuccessfulRead = null;   // { filepath, startLine, endLine, content } — last successful read_file_slice result
  let lastCreatedFileState = null; // { filePath, content, exportNames } — last successfully created extraction file
  let extractionCount = 0;         // how many complete extract-and-replace cycles succeeded
  let extractionContinuationPending = false; // true after replace_in_file success; cleared when model starts next tool call
  const recentReads = [];          // all successful read results (capped at 20) for reminder context
  const seenReadSigs = new Map(); // cross-turn dedup: sig -> read count (block after 2 reads)
  dryRunFiles.clear(); // reset for this session

  while (turn < MAX_TURNS) {
    turn++;
    label(C, `TURN ${turn}`, `retry=${retryCount} messages=${messages.length}`);
    logEvent('ollama_request', { turn, retryCount, messageCount: messages.length });

    // Sliding window: prevent context overflow by trimming old tool results
    if (messages.length > 22) {
      const first2 = messages.slice(0, 2); // initial plan + user prompt
      const recent = messages.slice(-14); // most recent 14 messages
      const trimNotice = { role: 'user', content: `Context trimmed to prevent overflow. Continue splitting ${TARGET_FILE}: read the next un-extracted section and extract another module.` };
      messages.splice(0, messages.length, ...first2, trimNotice, ...recent);
      seenReadSigs.clear(); // allow re-reads after context trim
      label(Y, 'CONTEXT TRIM', `Trimmed to ${messages.length} messages`);
    }

    const body = {
      model: MODEL,
      stream: false,
      options: { num_ctx: 16384 },
      messages: [
        { role: 'system', content: buildAgentMandate() },
        ...messages
      ],
      tools: getToolDefinitions()
    };

    let responseData;
    try {
      const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${txt}`);
      }
      responseData = await resp.json();
    } catch (e) {
      label(R, 'OLLAMA ERROR', e.message);
      logEvent('ollama_error', { error: e.message });
      break;
    }

    const msg = responseData?.message ?? {};
    const content = msg.content ?? '';
    const nativeToolCalls = msg.tool_calls ?? [];

    // Also try to detect tool calls leaked into text (qwen2.5-coder: native calls sometimes not fired)
  const rawTextToolCalls = nativeToolCalls.length === 0 ? parseToolCallsFromText(content) : [];
  // Deduplicate text tool calls by (name, JSON-args) — model sometimes emits same call twice
  const seenToolSigs = new Set();
  const textToolCalls = rawTextToolCalls.filter(tc => {
    const sig = tc.function?.name + '|' + JSON.stringify(tc.function?.arguments ?? {});
    if (seenToolSigs.has(sig)) return false;
    seenToolSigs.add(sig);
    return true;
  });
    const resolvedToolCalls = nativeToolCalls.length > 0 ? nativeToolCalls : textToolCalls;
    const wasNative = nativeToolCalls.length > 0;

    logEvent('ollama_response', {
      contentLength: content.length,
      hasNativeToolCalls: nativeToolCalls.length > 0,
      hasTextToolCalls: textToolCalls.length > 0,
      contentPreview: content.substring(0, 200)
    });

    // ── Tool calls (native or parsed from text) ──
    if (resolvedToolCalls.length > 0) {
      extractionContinuationPending = false; // model is actively executing tools — not stuck
      if (!wasNative) {
        label(Y, 'TEXT TOOL CALL', `Detected ${textToolCalls.length} tool call(s) in text (not native) — executing anyway`);
      }
      label(G, 'TOOL CALLS', resolvedToolCalls.map(tc => tc.function?.name).join(', '));
      messages.push({ role: 'assistant', content: wasNative ? content : '', tool_calls: wasNative ? nativeToolCalls : undefined });

      // Collect reminder/continuation user messages to inject AFTER all tool results, not mid-loop
      const postToolMessages = [];

      for (const tc of resolvedToolCalls) {
        const toolName = tc.function?.name ?? 'unknown';
        const rawArgs  = tc.function?.arguments ?? {};
        const args     = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;

        label(B, `  → ${toolName}`, JSON.stringify(args).substring(0, 150));
        logEvent('tool_exec_start', { tool: toolName, args });

        // Cross-turn dedup: skip repeated reads of the same file section (allow each section to be read at most twice)
        if (toolName === 'read_file_slice' || toolName === 'read_specific_file') {
          const readSig = toolName + '|' + JSON.stringify(args);
          const readCount = seenReadSigs.get(readSig) ?? 0;
          if (readCount >= 2) {
            label(Y, `  \u27f3 SKIP DUPE READ`, `${toolName} same args already seen ${readCount}x`);
            messages.push({ role: 'tool', content: JSON.stringify({ warning: `Duplicate read \u2014 you already read this exact section ${readCount} times. You already have this file content in your context. Do NOT re-read it. Create a NEW file (e.g. src/types.ts, NOT ${TARGET_FILE}) for the extracted code using create_or_edit_file, then use replace_in_file on ${TARGET_FILE} to replace that block with an import statement.` }), tool_name: toolName });
            continue;
          }
          seenReadSigs.set(readSig, readCount + 1);
        }

        const result = await executeTool(toolName, args);
        const parsed = JSON.parse(result);

        if (parsed.error) {
          label(R, `  ✗ ${toolName}`, parsed.error);
          // After create_or_edit_file fails (e.g. overwrite guard), allow re-reads so model can get fresh context
          if (toolName === 'create_or_edit_file') {
            seenReadSigs.clear();
          }
          // On replace_in_file failure: auto-read the suggested slice so model gets exact old_text
          if (toolName === 'replace_in_file' && parsed.suggestedSlice) {
            const autoRead = await executeTool('read_file_slice', parsed.suggestedSlice);
            const autoReadParsed = JSON.parse(autoRead);
            if (!autoReadParsed.error && autoReadParsed.content) {
              lastSuccessfulRead = { filepath: String(parsed.suggestedSlice.filepath ?? ''), startLine: parsed.suggestedSlice.startLine, endLine: parsed.suggestedSlice.endLine, content: autoReadParsed.content };
              const autoMsg = `[Auto-read lines ${parsed.suggestedSlice.startLine}–${parsed.suggestedSlice.endLine} to help you fix old_text]:\n\`\`\`typescript\n${autoReadParsed.content.substring(0, 800)}\n\`\`\`\nUse the EXACT text from above as old_text for replace_in_file.`;
              label(Y, '  AUTO-READ', `injected ${autoReadParsed.content.length} chars for old_text context`);
              messages.push({ role: 'tool', content: autoMsg, tool_name: 'read_file_slice' });
            }
          }
        } else {
          label(G, `  ✓ ${toolName}`, result.substring(0, 200));
          // Track successful reads for replace_in_file reminder context
          if (toolName === 'read_file_slice' && parsed.content) {
            lastSuccessfulRead = { filepath: String(args.filepath ?? ''), startLine: args.startLine ?? 1, endLine: args.endLine ?? 1, content: parsed.content };
            recentReads.push(lastSuccessfulRead);
            if (recentReads.length > 20) recentReads.shift();
          }
          if (toolName === 'create_or_edit_file' || toolName === 'replace_in_file') {
            hadSuccessfulWrite = true;
            // After creating a NEW file (not the main refactor target), remind model to replace in original
            if (toolName === 'create_or_edit_file') {
              const createdPath = parsed.path ?? '';
              const isOriginal = createdPath.includes(TARGET_BASENAME);
              if (!isOriginal) {
                const fileContent = args.content ?? '';
                const exportNames = [...fileContent.matchAll(/export\s+(?:(?:type|interface|abstract|declare)\s+)*(?:function\s+|class\s+|const\s+|let\s+|var\s+|enum\s+)?([A-Z][\w]*)/g)]
                  .map(m => m[1])
                  .filter(n => n && !['from', 'type', 'default', 'as', 'export', 'import', 'declare', 'abstract'].includes(n))
                  .slice(0, 10);
                lastCreatedFileState = { filePath: createdPath, content: fileContent, exportNames };
                pendingReplaceAfterCreate = true;
                const reminder = buildReplaceReminder(createdPath, fileContent, recentReads);
                label(Y, '  REMINDER', reminder.substring(0, 400));
                postToolMessages.push({ role: 'user', content: reminder, _type: 'reminder' });
              }
            }
            if (toolName === 'replace_in_file') {
              pendingReplaceAfterCreate = false; // replace succeeded — cycle complete
              extractionCount++;
              extractionContinuationPending = true; // wait for model to start next cycle
              label(G, '  EXTRACTED', `Cycle ${extractionCount} done. Injecting continuation nudge.`);
              const continueMsg = `Module extraction ${extractionCount} complete. Now read the next section of ${TARGET_FILE} (use a NEW line range you haven't read yet, beyond the block you just replaced) and extract another self-contained block (interface group, class, or utility functions). Aim to extract at least 3 modules total.`;
              postToolMessages.push({ role: 'user', content: continueMsg, _type: 'continuation' });
            }
          }
        }
        logEvent('tool_exec_result', { tool: toolName, result: result.substring(0, 300) });

        messages.push({ role: 'tool', content: result, tool_name: toolName });
      }

      // Inject reminder/continuation after all tool results (correct message ordering)
      for (const { _type, ...msg } of postToolMessages) {
        // Skip the reminder if the same batch already handled replace_in_file (pendingReplaceAfterCreate=false)
        if (_type === 'reminder' && !pendingReplaceAfterCreate) continue;
        messages.push(msg);
      }

      retryCount = 0;
      continue;
    }

    // ── Text response ──
    // Detect Qwen token overflow markers as empty response
    const isTokenOverflow = /^<\|im_(?:start|end|sep)\|>/.test(content.trim()) && content.trim().length < 30;
    // Detect echo: model parroted back a recent user message verbatim
    const lastUserMsgs = messages.filter(m => m.role === 'user').slice(-3).map(m => m.content.trim());
    const isEchoOfUserMsg = content.trim().length > 30 && lastUserMsgs.some(um => um.length > 30 && um === content.trim());
    // Empty response — model has nothing to say; treat as done if wrote something, else nudge once more
    if (content.trim().length === 0 || isTokenOverflow || isEchoOfUserMsg) {
      if (isTokenOverflow) label(Y, 'TOKEN OVERFLOW', 'Model returned a raw im_start token — treating as empty');
      if (isEchoOfUserMsg) label(Y, 'ECHO DETECTED', 'Model echoed a user message — treating as empty');
      if (hadSuccessfulWrite && !pendingReplaceAfterCreate && !extractionContinuationPending && extractionCount >= 2) {
        label(G, 'DONE', `Empty response after ${extractionCount} extraction cycles — task complete.`);
        logEvent('session_done', { turn, reason: 'empty_after_write', extractionCount });
        break;
      }
      // If model got a continuation nudge but returned empty repeatedly, accept done if we did at least 2 cycles
      if (extractionContinuationPending && retryCount >= 2) {
        label(G, 'DONE', `${extractionCount} module(s) extracted — model could not continue further.`);
        logEvent('session_done', { turn, reason: 'continuation_exhausted', extractionCount });
        break;
      }
      if (retryCount >= 4) {
        label(R, 'STUCK', `Model returned empty/overflow ${retryCount} times with no tool call — giving up.`);
        logEvent('retry_limit', { turn, retryCount, reason: 'empty_loop' });
        break;
      }
      // Context-aware empty nudge
      let emptyNudge;
      if (pendingReplaceAfterCreate && lastCreatedFileState && lastSuccessfulRead && lastSuccessfulRead.content) {
        emptyNudge = buildNudge({ isAnnouncedButNotExecuted: true, requiresContinuation: true }, false, { pendingReplaceAfterCreate, lastSuccessfulRead, lastCreatedFileState });
      } else if (extractionContinuationPending) {
        const nextStart = (lastSuccessfulRead?.endLine ?? 120) + 1;
        const nextEnd = nextStart + 119;
        emptyNudge = `Extraction ${extractionCount} complete. Read the NEXT section of ${TARGET_FILE} — use read_file_slice with lines ${nextStart}–${nextEnd} — then extract another self-contained block (interface, class, or utility functions).`;
      } else if (lastSuccessfulRead && lastSuccessfulRead.content) {
        emptyNudge = `You already read lines ${lastSuccessfulRead.startLine}–${lastSuccessfulRead.endLine} of ${path.basename(lastSuccessfulRead.filepath ?? '')}. ` +
          `Do NOT re-read those lines. Use that content to create a NEW file (e.g. src/types.ts or src/interfaces.ts) with the extracted TypeScript code — use create_or_edit_file. ` +
          `Do NOT attempt to overwrite ${TARGET_FILE}.`;
      } else {
        emptyNudge = `Your response was empty. Call read_file_slice on ${TARGET_FILE} to read a section, then call create_or_edit_file to create a new module file with the extracted code.`;
      }
      label(Y, 'NUDGE', emptyNudge.substring(0, 300));
      messages.push({ role: 'assistant', content: '' });
      messages.push({ role: 'user', content: emptyNudge });
      retryCount++;
      continue;
    }

    label(W, 'RESPONSE', content.substring(0, 600) + (content.length > 600 ? '\n...' : ''));

    const recentMessages = messages.slice(-20);
    const analysis = analyzeResponse(content, recentMessages);
    label(Y, 'ANALYSIS', JSON.stringify(analysis));
    logEvent('response_analysis', { turn, retryCount, ...analysis });

    // Show plan to console then nudge
    if (analysis.looksLikePlan) {
      label(G, 'PLAN', content);
      messages.push({ role: 'assistant', content });
      const nudge = 'Plan noted. Now execute step 1 immediately with the appropriate tool call. Do not describe what you will do — call the tool.';
      label(Y, 'NUDGE (plan)', nudge);
      messages.push({ role: 'user', content: nudge });
      logEvent('nudge', { kind: 'plan', turn, retryCount });
      retryCount = 0;
      continue;
    }

    // Hallucination recovery: when model fakes a tool result, do the real operation
    if (analysis.isHallucinatingToolResponse) {
      const toolRespMatch = content.match(/<tool_response>([\s\S]*?)<\/tool_response>/s);
      if (toolRespMatch) {
        let fakeResult = null;
        try {
          fakeResult = JSON.parse(toolRespMatch[1].trim());
        } catch {
          // JSON may be truncated — try regex fallback to recover key fields
          const rangeMatch = toolRespMatch[1].match(/"startLine"\s*:\s*(\d+)[^]*?"endLine"\s*:\s*(\d+)/);
          const pathMatch = toolRespMatch[1].match(/"path"\s*:\s*"([^"]+)"/);
          const replMatch = toolRespMatch[1].match(/"replacements"\s*:\s*(\d+)/);
          if (pathMatch) {
            fakeResult = {
              path: pathMatch[1],
              startLine: rangeMatch ? parseInt(rangeMatch[1]) : undefined,
              endLine: rangeMatch ? parseInt(rangeMatch[2]) : undefined,
              replacements: replMatch ? parseInt(replMatch[1]) : undefined
            };
          }
        }
        if (fakeResult) {
          // Case 1: Fake read_file_slice result (has startLine + endLine for the source file)
          // Require retryCount >= 1 to give model one chance to resolve naturally first
          if (typeof fakeResult.startLine === 'number' && typeof fakeResult.endLine === 'number' &&
              (fakeResult.path ?? '').includes(TARGET_BASENAME) && retryCount >= 1) {
            const fp = resolveFilepath(fakeResult.path ?? TARGET_FILE);
            const realResult = await executeTool('read_file_slice', { filepath: fp, startLine: fakeResult.startLine, endLine: fakeResult.endLine });
            const realParsed = JSON.parse(realResult);
            if (!realParsed.error && realParsed.content) {
              label(Y, 'HALLUCINATION RECOVERY', `Model faked read ${fakeResult.startLine}–${fakeResult.endLine}; injecting real result`);
              lastSuccessfulRead = { filepath: fp, startLine: fakeResult.startLine, endLine: fakeResult.endLine, content: realParsed.content };
              recentReads.push(lastSuccessfulRead);
              if (recentReads.length > 20) recentReads.shift();
              messages.push({ role: 'assistant', content: '' });
              messages.push({ role: 'tool', content: realResult, tool_name: 'read_file_slice' });
              const recoveryNudge = `Real read_file_slice result for lines ${fakeResult.startLine}–${fakeResult.endLine} is above. ` +
                `Now create a new module file with the TypeScript definitions from those lines, then call replace_in_file on ${TARGET_FILE}.`;
              messages.push({ role: 'user', content: recoveryNudge });
              retryCount = 0;
              continue;
            }
          }

          // Case 2: Fake create_or_edit_file result (fire immediately — don't wait for retryCount)
          if (fakeResult.path && !(fakeResult.path ?? '').includes(TARGET_BASENAME) &&
              !fakeResult.startLine && !fakeResult.endLine) {
            const rawContent = typeof fakeResult.content === 'string' && fakeResult.content.trim().length > 50
              ? fakeResult.content
              : (lastSuccessfulRead?.content ? extractDefinitionsFromSource(lastSuccessfulRead.content) : null);
            if (rawContent && rawContent.trim().length > 50) {
              const fp = resolveFilepath(fakeResult.path);
              const writeResult = await executeTool('create_or_edit_file', { filename: fp, content: rawContent });
              const writeParsed = JSON.parse(writeResult);
              if (!writeParsed.error) {
                label(Y, 'HALLUCINATION RECOVERY', `Model faked creation of ${path.basename(fp)}; executing real create`);
                hadSuccessfulWrite = true;
                pendingReplaceAfterCreate = true;
                const exportNames = [...rawContent.matchAll(/export\s+(?:(?:type|interface|class|function|abstract|declare)\s+)*([A-Z][\w]*)/g)]
                  .map(m => m[1]).filter(n => n && !['from', 'type', 'default', 'as'].includes(n)).slice(0, 10);
                lastCreatedFileState = { filePath: fp, content: rawContent, exportNames };
                messages.push({ role: 'assistant', content: '' });
                messages.push({ role: 'tool', content: writeResult, tool_name: 'create_or_edit_file' });
                const reminder = buildReplaceReminder(fp, rawContent, recentReads);
                messages.push({ role: 'user', content: reminder });
                retryCount = 0;
                continue;
              }
            }
          }

          // Case 3: Fake replace_in_file result (fire immediately)
          if ((fakeResult.path ?? '').includes(TARGET_BASENAME) && fakeResult.replacements >= 1 &&
              pendingReplaceAfterCreate && lastCreatedFileState) {
            const diffBlock = fakeResult.diff ?? '';
            const removedLines = (diffBlock.match(/^-(.*)$/gm) ?? []).map(l => l.slice(1)).join('\n');
            if (removedLines.trim().length > 0) {
              const newText = `import { ${lastCreatedFileState.exportNames.join(', ')} } from './${path.basename(lastCreatedFileState.filePath, '.ts')}';`;
              const replaceResult = await executeTool('replace_in_file', { filepath: fakeResult.path, old_text: removedLines, new_text: newText });
              const replaceParsed = JSON.parse(replaceResult);
              if (!replaceParsed.error) {
                label(Y, 'HALLUCINATION RECOVERY', `Model faked replace in ${TARGET_BASENAME}.ts; executed real replace`);
                pendingReplaceAfterCreate = false;
                extractionCount++;
                extractionContinuationPending = true;
                messages.push({ role: 'assistant', content: '' });
                messages.push({ role: 'tool', content: replaceResult, tool_name: 'replace_in_file' });
                const nextStart = (lastSuccessfulRead?.endLine ?? 120) + 1;
                const continueMsg = `Module extraction ${extractionCount} complete. Read lines ${nextStart}\u2013${nextStart + 119} of ${TARGET_FILE} and extract another block.`;
                messages.push({ role: 'user', content: continueMsg });
                retryCount = 0;
                continue;
              }
            }
          }
        }
      }
    }

    // Force continuation if last tool result was a placeholder/error from create_or_edit_file
    const lastToolMsg = [...messages].reverse().find(m => m.role === 'tool');
    const lastToolWasError = lastToolMsg && (() => { try { return !!JSON.parse(lastToolMsg.content).error; } catch { return false; } })();
    // If model claims done after actual write succeeded AND no pending tool call in text → accept done
    const textCallsInResponse = parseToolCallsFromText(content);
    const hasPendingTextCall = textCallsInResponse.length > 0;
    const isDoneAfterWrite = hadSuccessfulWrite && !analysis.isPassingToUser &&
      !analysis.isAnnouncedButNotExecuted && !analysis.isHallucinatingToolResponse &&
      !analysis.mentionsToolButNotCalled && !hasPendingTextCall &&
      (analysis.claimsDone || (analysis.isLong && !analysis.looksLikePlan));
    // For non-split tasks: a long, non-plan text response with no tool calls is the final answer
    const isNonSplitFinalAnswer = !IS_SPLIT_TASK && analysis.isLong && !analysis.looksLikePlan &&
      !analysis.mentionsToolButNotCalled && !hasPendingTextCall && !analysis.isHallucinatingToolResponse;
    if ((!analysis.requiresContinuation || isDoneAfterWrite || isNonSplitFinalAnswer) && !lastToolWasError) {
      // Require at least 2 full extraction cycles before accepting a quiet finish — only for split tasks
      if (IS_SPLIT_TASK && extractionCount < 2) {
        const nextStart = (lastSuccessfulRead?.endLine ?? 120) + 1;
        const tooFewNudge = `Only ${extractionCount} module(s) extracted so far — need at least 2. ` +
          `Read the next section of ${TARGET_FILE} (lines ${nextStart}–${nextStart + 119}) and extract another self-contained block.`;
        label(Y, 'NUDGE (too few extractions)', tooFewNudge);
        messages.push({ role: 'assistant', content });
        messages.push({ role: 'user', content: tooFewNudge });
        retryCount = 0;
        continue;
      }
      label(G, 'DONE', 'Final text response, no continuation required.');
      logEvent('session_done', { turn });
      break;
    }

    if (retryCount >= 4) {
      label(R, 'RETRY LIMIT', `Gave up after ${retryCount} retries. Last: ${content.substring(0, 200)}`);
      logEvent('retry_limit', { turn, retryCount, contentPreview: content.substring(0, 200) });
      break;
    }

    const nudge = buildNudge(analysis, lastToolWasError, { pendingReplaceAfterCreate, lastSuccessfulRead, lastCreatedFileState, extractionContinuationPending, extractionCount });
    label(Y, 'NUDGE', nudge);
    logEvent('nudge', { kind: 'tool_continuation', turn, retryCount, nudge });
    messages.push({ role: 'assistant', content });
    messages.push({ role: 'user', content: nudge });
    retryCount++;
  }

  label(B, 'SUMMARY', `Turns: ${turn} | Final message count: ${messages.length} | Log: ${LOG_FILE}`);
}

main().catch(e => { console.error(e); process.exit(1); });
