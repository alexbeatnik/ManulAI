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
 *   DRY_RUN       false to allow real file writes (default: true = dry-run writes)
 *   MAX_TURNS     max agent turns   (default: 30)
 *   LOG_FILE      path to save session JSONL (default: .manulai/logs/debug-<ts>.jsonl)
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
const DRY_RUN     = process.env.DRY_RUN !== 'false';
const MAX_TURNS   = parseInt(process.env.MAX_TURNS ?? '30', 10);

const sessionId   = new Date().toISOString().replace(/[:.]/g, '-');
const logDir      = path.join(wsRoot, '.manulai', 'logs');
const LOG_FILE    = process.env.LOG_FILE ?? path.join(logDir, `debug-${sessionId}.jsonl`);

const userPrompt  = process.argv[2] ?? 'розбий файл ManulAiChatProvider.ts на декілька менших';

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
        const lines = readFileSync(fp, 'utf8').split('\n');
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
        const lines = readFileSync(fp, 'utf8').split('\n');
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
      const content = String(args.content ?? '');
      if (!fp) return JSON.stringify({ error: 'filename is required.' });

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

      if (DRY_RUN) {
        label(Y, 'DRY-RUN write', `${fp}\n  ${content.substring(0, 150).replace(/\n/g, '\n  ')}${content.length > 150 ? '\n  ...' : ''}`);
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

// ─── Text-based tool call parser (handles leaked JSON tool calls) ────────────
function parseToolCallsFromText(content) {
  const results = [];
  if (!content.includes('"name"') && !content.includes('function_calls')) return results;

  // Match {"name": "tool_name", "arguments": {...}} patterns
  const objectPattern = /\{[^{}]*"name"\s*:\s*"([^"]+)"[^{}]*"arguments"\s*:[^{}]*(\{[^{}]*(?:\{[^{}]*\}[^{}]*)?\})[^{}]*\}/gs;
  let match;
  while ((match = objectPattern.exec(content)) !== null) {
    try {
      const full = match[0];
      const obj = JSON.parse(full);
      if (obj.name && obj.arguments !== undefined) {
        results.push({ function: { name: obj.name, arguments: obj.arguments } });
      }
    } catch { /* ignore */ }
  }

  // Match ```json\n{"name": ...}\n``` fenced blocks
  const fencedPattern = /```(?:json|tool_call)?\s*\n(\{[\s\S]*?\})\s*\n```/g;
  while ((match = fencedPattern.exec(content)) !== null) {
    try {
      const obj = JSON.parse(match[1]);
      if (obj.name && obj.arguments !== undefined) {
        results.push({ function: { name: obj.name, arguments: obj.arguments } });
      }
    } catch { /* ignore */ }
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
  const isAnnouncedButNotExecuted = /executing step \d+[:/]/i.test(content) || /step \d+\/\d+:\s*\w/i.test(content);
  const isPassingToUser = /(?:please (?:execute|run|proceed|confirm)|would you like me to|shall i (?:proceed|continue))/i.test(content) && content.length < 800;
  const claimsDone = /(?:step \d+ completed|successfully applied|file (?:created|updated)|has been (?:created|moved)|done)/i.test(content);
  const looksLikePlan = !hasToolResults &&
    /^\s*\d+\.\s+.{10,}/m.test(content) &&
    content.length > 80;

  const requiresContinuation = isProgressOnly || isAnnouncedButNotExecuted || isPassingToUser ||
    (claimsDone && !hasToolResults) || isLong;

  return { isLong, isProgressOnly, isAnnouncedButNotExecuted, isPassingToUser, claimsDone, looksLikePlan, requiresContinuation };
}

function buildNudge(analysis) {
  if (analysis.isAnnouncedButNotExecuted) {
    return 'You described a tool call in text ("Executing step N: ...") instead of actually calling the tool. NEVER write that text. Call the actual tool now using the native tool-calling mechanism.';
  }
  if (analysis.isPassingToUser) {
    return 'Do not ask the user to run commands. You have tools. Use execute_terminal_command or the appropriate file tool yourself now.';
  }
  if (analysis.isProgressOnly) {
    return 'Do not print progress text. Call a tool now — no preamble.';
  }
  if (analysis.claimsDone) {
    return 'You claimed a step was completed but no tool was called. Call the appropriate tool now.';
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
      content: 'Before taking any action, output a brief numbered plan (3–8 steps). ' +
        'After the plan, immediately call the tool for step 1. ' +
        'After each file modification, run: execute_terminal_command("npx tsc --noEmit 2>&1 | head -20") to verify nothing broke.'
    },
    { role: 'user', content: userPrompt }
  ];

  let turn = 0;
  let retryCount = 0;

  while (turn < MAX_TURNS) {
    turn++;
    label(C, `TURN ${turn}`, `retry=${retryCount} messages=${messages.length}`);
    logEvent('ollama_request', { turn, retryCount, messageCount: messages.length });

    const body = {
      model: MODEL,
      stream: false,
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
    const textToolCalls = nativeToolCalls.length === 0 ? parseToolCallsFromText(content) : [];
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
      if (!wasNative) {
        label(Y, 'TEXT TOOL CALL', `Detected ${textToolCalls.length} tool call(s) in text (not native) — executing anyway`);
      }
      label(G, 'TOOL CALLS', resolvedToolCalls.map(tc => tc.function?.name).join(', '));
      messages.push({ role: 'assistant', content: wasNative ? content : '', tool_calls: wasNative ? nativeToolCalls : undefined });

      for (const tc of resolvedToolCalls) {
        const toolName = tc.function?.name ?? 'unknown';
        const rawArgs  = tc.function?.arguments ?? {};
        const args     = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;

        label(B, `  → ${toolName}`, JSON.stringify(args).substring(0, 150));
        logEvent('tool_exec_start', { tool: toolName, args });

        const result = await executeTool(toolName, args);
        const parsed = JSON.parse(result);

        if (parsed.error) {
          label(R, `  ✗ ${toolName}`, parsed.error);
        } else {
          label(G, `  ✓ ${toolName}`, result.substring(0, 200));
        }
        logEvent('tool_exec_result', { tool: toolName, result: result.substring(0, 300) });

        messages.push({ role: 'tool', content: result, tool_name: toolName });
      }

      retryCount = 0;
      continue;
    }

    // ── Text response ──
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

    if (!analysis.requiresContinuation) {
      label(G, 'DONE', 'Final text response, no continuation required.');
      logEvent('session_done', { turn });
      break;
    }

    if (retryCount >= 4) {
      label(R, 'RETRY LIMIT', `Gave up after ${retryCount} retries. Last: ${content.substring(0, 200)}`);
      logEvent('retry_limit', { turn, retryCount, contentPreview: content.substring(0, 200) });
      break;
    }

    const nudge = buildNudge(analysis);
    label(Y, 'NUDGE', nudge);
    logEvent('nudge', { kind: 'tool_continuation', turn, retryCount, nudge });
    messages.push({ role: 'assistant', content });
    messages.push({ role: 'user', content: nudge });
    retryCount++;
  }

  label(B, 'SUMMARY', `Turns: ${turn} | Final message count: ${messages.length} | Log: ${LOG_FILE}`);
}

main().catch(e => { console.error(e); process.exit(1); });
