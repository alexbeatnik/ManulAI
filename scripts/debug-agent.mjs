#!/usr/bin/env node
/**
 * ManulAI Debug Agent v2 — matches the new Copilot Chat Participant architecture.
 *
 * Uses text-based tool calls: {"tool": "name", "args": {...}}
 * Streams responses from Ollama.
 * Simplified agent loop matching copilotChatParticipant.ts.
 *
 * Usage:
 *   MANUL_MODEL=gemma4:31b node scripts/debug-agent.mjs "your prompt"
 *   MANUL_MODEL=llama3.1:8b node scripts/debug-agent.mjs --planner "explain the codebase"
 *
 * Env vars:
 *   MANUL_MODEL   Ollama model (default: qwen2.5-coder:7b)
 *   OLLAMA_URL    Ollama base URL (default: http://localhost:11434)
 *   MAX_TURNS     Max agent turns (default: 15)
 *   MODE          agent|planner|chat (default: agent)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wsRoot = path.resolve(__dirname, '..');

const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const MODEL = process.env.MANUL_MODEL ?? 'qwen2.5-coder:7b';
const MAX_TURNS = parseInt(process.env.MAX_TURNS ?? '15', 10);

const cliArgs = process.argv.slice(2);
const plannerFlag = cliArgs.indexOf('--planner');
if (plannerFlag >= 0) cliArgs.splice(plannerFlag, 1);
const MODE = plannerFlag >= 0 ? 'planner' : (process.env.MODE ?? 'agent');

const userPrompt = cliArgs.join(' ');
if (!userPrompt) {
  console.error('Usage: MANUL_MODEL=gemma4:31b node scripts/debug-agent.mjs [--planner] "your prompt"');
  process.exit(1);
}

// ─── Colours ────────────────────────────────────────────────────────────
const R = '\x1b[31m', G = '\x1b[32m', Y = '\x1b[33m', B = '\x1b[34m';
const C = '\x1b[36m', W = '\x1b[37m', BOLD = '\x1b[1m', RESET = '\x1b[0m';
const label = (col, tag, msg) => console.log(`${col}${BOLD}[${tag}]${RESET} ${msg}`);

// ─── Logging ─────────────────────────────────────────────────────────────
const logDir = path.join(wsRoot, '.manulai', 'logs');
mkdirSync(logDir, { recursive: true });
const sessionId = new Date().toISOString().replace(/[:.]/g, '-');
const LOG_FILE = path.join(logDir, `debug-${sessionId}.jsonl`);
function logEvent(event, data = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, model: MODEL, ...data });
  writeFileSync(LOG_FILE, line + '\n', { flag: 'a' });
}

label(B, 'CONFIG', `Model: ${MODEL} | ${OLLAMA_URL} | Mode: ${MODE} | MaxTurns: ${MAX_TURNS}`);
label(B, 'LOG', LOG_FILE);
label(B, 'PROMPT', userPrompt);
logEvent('session_start', { prompt: userPrompt, mode: MODE });

// ─── Degenerate Output Detection (from old ManulAiChatProvider) ─────────
function isDegenerateOutput(text) {
  if (!text || text.length < 20) return false;
  const normalized = text.trim();

  // Repeated single character or very short pattern
  const uniqueChars = new Set(normalized).size;
  if (uniqueChars <= 3 && normalized.length > 50) return true;

  // High density of brackets (typical of phi4-mini at context limits)
  const bracketChars = (normalized.match(/[\[\]{}()]/g) || []).length;
  if (bracketChars / normalized.length > 0.4 && normalized.length > 100) return true;

  // Repeated em-dash or similar separator characters
  const dashLike = (normalized.match(/[—–-]/g) || []).length;
  if (dashLike / normalized.length > 0.8 && normalized.length > 100) return true;

  // Very low token diversity (same words repeated)
  const words = normalized.split(/\s+/).filter(Boolean);
  const uniqueWords = new Set(words).size;
  if (words.length > 20 && uniqueWords / words.length < 0.15) return true;

  return false;
}

// ─── Context Window Config (mirrors modelContextConfig.ts) ──────────────
const MODEL_CONTEXT_WINDOWS = {
  'gemma4': 256_000,
  'llama3.1': 128_000, 'llama3.2': 128_000, 'llama3.3': 128_000,
  'qwen3': 128_000, 'qwen2.5': 128_000,
  'deepseek': 128_000,
  'phi4': 128_000, 'phi3': 128_000,
};
function getContextWindow(model) {
  const lower = model.toLowerCase().trim();
  for (const [prefix, size] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (lower.startsWith(prefix)) return size;
  }
  return 128_000;
}
function getMaxPromptTokens(model) {
  return Math.floor(getContextWindow(model) * 0.75);
}
function estimateTokens(text) {
  return Math.ceil(text.length / 3.5);
}

// ─── Tool Instructions (mirrors agentExecutor.ts) ───────────────────────
const TOOL_INSTRUCTIONS = `
[AGENT RULES]

1. ALWAYS respond in the SAME LANGUAGE as the user's prompt.
2. NEVER read files unless you genuinely need information to complete the task. Do NOT read package.json "just in case".
3. Use project_scan() or list_workspace_files() to explore the workspace before making changes.
4. NEVER output explanations before tool calls — just call the tool immediately.
5. NEVER wrap tool JSON in markdown code blocks (no \`\`\`json).
6. STOP immediately after completing the user's request. Do NOT verify, check, or read back created/edited files.
7. Do NOT scan the project after completing the task unless explicitly asked.
8. After outputting a tool JSON, STOP. Do not write any additional text, explanations, or thinking.
9. NEVER read the same file more than once. If you already read a file, use the information you already have.
10. NEVER call more than 3 tools in a single turn. If you need more, do them in the next turn.

[TOOL FORMAT]

Output tool calls as a single JSON object on its own line:
{"tool": "tool_name", "args": {"param": "value"}}

Available tools:
- create_or_edit_file(filename, content) — Create or overwrite a file
- replace_in_file(filepath, old_text, new_text) — Replace text in existing file
- read_specific_file(filepath) — Read full file contents
- read_file_slice(filepath, startLine, endLine) — Read a line range from a file
- list_workspace_files(directory?) — List files/folders in a directory
- execute_terminal_command(command) — Run a shell command (no stdin)
- launch_in_terminal(command) — Open integrated terminal for interactive commands
- delete_file(filepath) — Delete a file
- read_active_file() — Read the currently open file
- project_scan() — Get a recursive tree of the entire workspace

Output ONE tool call JSON per response. No prose before the JSON. Do not wrap the JSON in markdown fences.
`;

// ─── System Prompt Builder ──────────────────────────────────────────────
function buildSystemPrompt() {
  let prompt = `You are ManulAI, a local AI coding assistant running inside VS Code. Work across any programming language. Prefer precise, minimal changes and explain results clearly.

Workspace root: ${wsRoot}
All file paths are relative to the workspace root unless absolute.`;

  if (MODE === 'agent') {
    prompt += `\n\nYou are in Agent mode. You may read files, edit code, and run terminal commands using the tools below.\n\n${TOOL_INSTRUCTIONS}`;
  } else if (MODE === 'planner') {
    prompt += `\n\nYou are in Planner mode. Prefer concise, step-by-step responses. Use tools for small deliberate actions.\n\n${TOOL_INSTRUCTIONS}`;
  } else {
    prompt += `\n\nYou are in Chat mode. Answer questions and review code without suggesting file changes or tool calls.`;
  }

  return prompt;
}

// ─── Ollama API ─────────────────────────────────────────────────────────
async function fetchOllamaChat(body) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return res;
}

async function streamOllamaResponse(messages) {
  const body = {
    model: MODEL,
    messages,
    stream: true,
    options: { num_ctx: Math.min(getContextWindow(MODEL), 32768) },
  };

  const res = await fetchOllamaChat(body);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  let content = '';
  let reasoning = '';
  let inThink = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    for (const line of chunk.split('\n').filter(Boolean)) {
      try {
        const parsed = JSON.parse(line);
        const text = parsed.message?.content ?? '';

        // Extract <think> reasoning
        let processed = text;
        while (processed.includes('<think>')) {
          const start = processed.indexOf('<think>');
          const end = processed.indexOf('</think>');
          if (end > start) {
            reasoning += processed.slice(start + 7, end);
            processed = processed.slice(0, start) + processed.slice(end + 8);
          } else {
            reasoning += processed.slice(start + 7);
            processed = processed.slice(0, start);
            inThink = true;
            break;
          }
        }
        if (inThink && !text.includes('<think>')) {
          if (text.includes('</think>')) {
            reasoning += text.split('</think>')[0];
            processed = text.split('</think>')[1] ?? '';
            inThink = false;
          } else {
            reasoning += text;
            processed = '';
          }
        }

        content += processed;
        process.stdout.write(processed);
      } catch {
        // Ignore malformed lines
      }
    }
  }

  return { content, reasoning };
}

// ─── Tool Call Parsing (robust — handles malformed model output) ─────────
// Brace-balanced JSON extractor (mirrors providerToolParsingUtils.extractBalancedJson).
// Tracks string state so braces inside string values do not affect depth.
function extractBalancedJson(text, startIndex) {
  let depth = 0;
  let inString = false;
  let stringChar = '';
  let escape = false;
  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (escape) { escape = false; continue; }
    if (char === '\\' && inString) { escape = true; continue; }
    if ((char === '"' || char === "'") && (!inString || char === stringChar)) {
      if (inString) { inString = false; stringChar = ''; }
      else { inString = true; stringChar = char; }
      continue;
    }
    if (inString) continue;
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return { json: text.slice(startIndex, index + 1), endIndex: index + 1 };
    }
  }
  return undefined;
}

const KNOWN_TOOL_NAMES = new Set([
  'create_or_edit_file', 'replace_in_file', 'read_specific_file', 'read_file_slice',
  'read_active_file', 'list_workspace_files', 'execute_terminal_command', 'launch_in_terminal',
]);

function findToolStarts(text) {
  const starts = [];
  // Canonical {"tool": "name", ...}
  const reCanonical = /\{\s*"tool"\s*:/g;
  let m;
  while ((m = reCanonical.exec(text)) !== null) starts.push(m.index);
  // Alt shape used by weak models: {"tool_name": { ... }} where the key is the tool itself.
  const reAlt = /\{\s*"([a-z_]+)"\s*:\s*\{/g;
  while ((m = reAlt.exec(text)) !== null) {
    if (KNOWN_TOOL_NAMES.has(m[1])) starts.push(m.index);
  }
  return [...new Set(starts)].sort((a, b) => a - b);
}

function extractToolCalls(text) {
  const results = [];
  const seen = new Set();
  for (const start of findToolStarts(text)) {
    const balanced = extractBalancedJson(text, start);
    if (!balanced) continue;
    let parsed;
    try { parsed = JSON.parse(balanced.json); } catch { continue; }
    if (!parsed || typeof parsed !== 'object') continue;

    let entry;
    if (typeof parsed.tool === 'string') {
      const toolName = parsed.tool.replace(/\(\)\s*$/, ''); // strip trailing ()
      if (parsed.args && typeof parsed.args === 'object') {
        entry = { name: toolName, args: parsed.args };
      } else {
        const { tool, ...rest } = parsed;
        entry = { name: toolName, args: rest };
      }
    } else {
      // Alt shape: {"<tool_name>": {<args>}}
      const keys = Object.keys(parsed);
      const toolKey = keys.find(k => KNOWN_TOOL_NAMES.has(k));
      if (!toolKey) continue;
      const inner = parsed[toolKey];
      if (!inner || typeof inner !== 'object') continue;
      entry = { name: toolKey, args: inner };
    }

    const key = JSON.stringify(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(entry);
  }
  return results;
}

function stripToolCalls(text) {
  let result = '';
  let cursor = 0;
  for (const start of findToolStarts(text)) {
    if (start < cursor) continue;
    const balanced = extractBalancedJson(text, start);
    if (!balanced) continue;
    result += text.slice(cursor, start);
    cursor = balanced.endIndex;
  }
  result += text.slice(cursor);
  // Strip surrounding markdown fences left over after removing the JSON inside them.
  return result.replace(/```(?:json|tool|tool_call)?\s*```/gi, '').trim();
}

// ─── Tool Execution (mirrors agentExecutor.ts) ──────────────────────────
function resolveUri(targetPath) {
  const normalized = targetPath.trim();
  if (!normalized) throw new Error('Path is required');
  if (path.isAbsolute(normalized)) return normalized;
  return path.join(wsRoot, normalized);
}

function isBlockedCommand(command) {
  const lower = command.toLowerCase();
  const dangerous = [
    'rm -rf /', 'rm -rf ~', 'rm -rf $home', 'sudo',
    'shutdown', 'reboot', 'mkfs', 'dd if=',
    ':(){:|:&};:', 'chmod -r 777 /', 'chmod -r 777 ~',
  ];
  for (const d of dangerous) if (lower.includes(d)) return true;
  if (/\b(curl|wget)\b.*\|.*\b(sh|bash)\b/.test(lower)) return true;
  return false;
}

async function executeTool(name, args) {
  try {
    switch (name) {
      case 'read_active_file': {
        // In debug mode, read the first TypeScript file we find
        const entries = readdirSync(wsRoot);
        const firstFile = entries.find(f => f.endsWith('.ts')) || 'package.json';
        const content = readFileSync(path.join(wsRoot, firstFile), 'utf8');
        return { content: JSON.stringify({ path: firstFile, content }) };
      }
      case 'read_specific_file': {
        const fp = resolveUri(String(args.filepath ?? ''));
        const content = readFileSync(fp, 'utf8');
        return { content: JSON.stringify({ path: fp, content }) };
      }
      case 'read_file_slice': {
        const fp = resolveUri(String(args.filepath ?? ''));
        const content = readFileSync(fp, 'utf8');
        const lines = content.split('\n');
        const start = Math.max(0, (args.startLine ?? 1) - 1);
        const end = Math.min(lines.length, args.endLine ?? lines.length);
        return { content: JSON.stringify({ path: fp, startLine: start + 1, endLine: end, content: lines.slice(start, end).join('\n') }) };
      }
      case 'create_or_edit_file': {
        const fp = resolveUri(String(args.filename ?? args.filepath ?? ''));
        // Reject if content key is missing entirely — silently writing an empty file
        // when the model just forgot to include content corrupts the file and lets the
        // model claim success on a destroyed target.
        if (!('content' in args)) {
          return { content: '', error: `create_or_edit_file requires a 'content' field. To create an empty file pass content: "" explicitly. Re-issue the call with the file's full content.` };
        }
        if (typeof args.content !== 'string') {
          return { content: '', error: `create_or_edit_file 'content' must be a string, got ${typeof args.content}.` };
        }
        const existed = existsSync(fp);
        if (!isBlockedCommand(fp)) {
          // Auto-create parent directories so the model can write nested greenfield paths
          // (e.g. `src/index.ts` in a fresh project) without first calling a separate "mkdir" step.
          mkdirSync(path.dirname(fp), { recursive: true });
          writeFileSync(fp, args.content, 'utf8');
        }
        return { content: JSON.stringify({ path: fp, action: existed ? 'overwritten' : 'created', bytes: args.content.length, existed }) };
      }
      case 'replace_in_file': {
        const fp = resolveUri(String(args.filepath ?? ''));
        const content = readFileSync(fp, 'utf8');
        const oldText = String(args.old_text ?? '');
        const newText = String(args.new_text ?? '');
        if (!oldText) return { content: '', error: 'old_text is required' };
        if (oldText === newText) {
          return { content: '', error: 'old_text and new_text are identical — this would make no change to the file.' };
        }
        // Count occurrences without regex (avoids escaping headaches).
        let occurrences = 0;
        let cursor = 0;
        while ((cursor = content.indexOf(oldText, cursor)) !== -1) { occurrences += 1; cursor += oldText.length; }
        if (occurrences === 0) return { content: '', error: `old_text not found in ${fp}. Make sure it matches exactly, including whitespace and indentation.` };
        const replaceAll = args.all === true || args.replace_all === true;
        // Match production semantics: refuse multi-match unless replace_all is explicit.
        // Multiple matches with a non-explicit replace lets a wrong choice of old_text
        // silently corrupt unrelated code (e.g. matching `return 1` in both branches of an if/else).
        if (occurrences > 1 && !replaceAll) {
          return {
            content: '',
            error: `old_text matched ${occurrences} times in ${fp}. Add more surrounding context so it matches exactly once, or pass "all": true if you genuinely want to replace every occurrence.`,
          };
        }
        const updated = replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText);
        writeFileSync(fp, updated, 'utf8');
        const replaced = replaceAll ? occurrences : 1;
        return {
          content: JSON.stringify({ path: fp, action: 'replaced', replaced }),
        };
      }
      case 'execute_terminal_command': {
        const cmd = String(args.command ?? args.cmd ?? '').trim();
        if (!cmd) return { content: '', error: 'command is required' };
        if (isBlockedCommand(cmd)) return { content: '', error: `Blocked: ${cmd}` };
        const { stdout, stderr } = await execAsync(cmd, { cwd: wsRoot, timeout: 30_000 });
        return { content: JSON.stringify({ command: cmd, output: stdout + (stderr ? `\nSTDERR:\n${stderr}` : '') }) };
      }
      case 'launch_in_terminal': {
        return { content: JSON.stringify({ command: args.command, status: '(launch_in_terminal is not available in debug mode)' }) };
      }
      case 'delete_file': {
        const fp = resolveUri(String(args.filepath ?? ''));
        const { rmSync } = await import('fs');
        rmSync(fp, { force: true });
        return { content: JSON.stringify({ path: fp, action: 'deleted' }) };
      }
      case 'list_workspace_files': {
        const dir = args.directory ? resolveUri(args.directory) : wsRoot;
        const entries = readdirSync(dir, { withFileTypes: true })
          .map(e => `${e.isDirectory() ? 'dir' : 'file'}: ${e.name}`)
          .sort();
        return { content: JSON.stringify({ directory: dir, files: entries }) };
      }
      case 'project_scan': {
        const IGNORED = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.manulai']);
        function scan(dir, depth = 0) {
          if (depth > 3) return [{ name: '...', type: 'truncated' }];
          try {
            return readdirSync(dir, { withFileTypes: true })
              .filter(e => !e.name.startsWith('.') && !IGNORED.has(e.name))
              .sort((a, b) => a.name.localeCompare(b.name))
              .map(e => e.isDirectory()
                ? { name: e.name, type: 'directory', children: scan(path.join(dir, e.name), depth + 1) }
                : { name: e.name, type: 'file' }
              );
          } catch { return []; }
        }
        return { content: JSON.stringify({ root: wsRoot, tree: scan(wsRoot) }) };
      }
      default:
        return { content: '', error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { content: '', error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Context Truncation (mirrors modelContextConfig.ts) ─────────────────
function truncateMessages(messages) {
  const maxTokens = getMaxPromptTokens(MODEL);
  const total = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  if (total <= maxTokens || messages.length <= 2) return messages;

  const system = messages[0];
  const last = messages[messages.length - 1];
  let history = messages.slice(1, -1);

  while (history.length > 0) {
    const trimmed = [system, ...history, last];
    const tokens = trimmed.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    if (tokens <= maxTokens) {
      label(Y, 'CONTEXT', `truncated ${messages.length - trimmed.length} messages; ${tokens}/${maxTokens} tokens`);
      return trimmed;
    }
    history.shift();
  }
  return [system, last];
}

// ─── Main Agent Loop (mirrors copilotChatParticipant.ts) ────────────────
async function runAgent() {
  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: userPrompt },
  ];

  const isAgentLike = MODE === 'agent' || MODE === 'planner';
  let consecutiveMalformed = 0;
  const MAX_CONSECUTIVE_MALFORMED = 3;
  const toolCallCounts = new Map(); // signature -> count
  const MAX_DUPLICATE_TOOL_CALLS = 2; // bail when the same call repeats this many times after the first
  let lastTurnFullyCompleted = false;
  let completedTurns = 0;
  let refusalNudgeFired = false;
  const readFilesThisSession = new Set();
  let hasProjectScanned = false;
  let consecutiveReadOrListTurns = 0;

  // Extract likely target filename from user prompt
  const extractTargetFilename = (prompt) => {
    const patterns = [
      /\b(?:create|write|make|generate|build)\s+(?:a\s+|the\s+)?(?:file\s+)?[`"']?(\S+\.(?:md|txt|ts|js|py|json|yml|yaml|html|css|scss|go|rs|java|kt|cs|cpp|c|h|sh|bash|sql|xml))[`"']?/i,
      /\b(?:edit|modify|update|fix|change)\s+(?:file\s+)?[`"']?(\S+\.(?:md|txt|ts|js|py|json|yml|yaml|html|css|scss|go|rs|java|kt|cs|cpp|c|h|sh|bash|sql|xml))[`"']?/i,
      /[`"'](\S+\.(?:md|txt|ts|js|py|json|yml|yaml|html|css|scss|go|rs|java|kt|cs|cpp|c|h|sh|bash|sql|xml))[`"']/i,
    ];
    for (const p of patterns) {
      const m = prompt.match(p);
      if (m) return m[1];
    }
    return undefined;
  };
  const targetFilename = extractTargetFilename(userPrompt);

  // Heuristic: does the user prompt expect file/tool actions?
  // Trigger words at word boundaries — keep this conservative to avoid misfiring on questions.
  const promptExpectsAction = /\b(create|write|add|edit|modify|change|rename|fix|delete|remove|replace|update|implement|generate|build|set up|move|extract|split|refactor|run)\b/i.test(userPrompt);

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    completedTurns = turn;
    lastTurnFullyCompleted = false;
    label(C, `TURN ${turn}/${MAX_TURNS}`, 'Calling Ollama...');
    logEvent('turn_start', { turn, messageCount: messages.length });

    const trimmed = truncateMessages(messages);
    const { content: assistantText, reasoning } = await streamOllamaResponse(trimmed);

    logEvent('turn_response', { turn, contentLength: assistantText.length, reasoningLength: reasoning.length });

    if (reasoning) {
      label(C, 'REASONING', reasoning.slice(0, 200).replace(/\n/g, ' ') + (reasoning.length > 200 ? '...' : ''));
    }

    // Check for degenerate output and retry with a nudge
    if (isDegenerateOutput(assistantText)) {
      label(R, 'DEGENERATE', `Model produced incoherent output (${assistantText.length} chars)`);
      logEvent('degenerate_output', { turn, content: assistantText.slice(0, 200) });
      messages.push({
        role: 'user',
        content: 'Your last response was incoherent or repetitive. Reset completely. Do NOT explain or plan. Either answer briefly in plain text now, or call exactly ONE read tool if you truly need file context first.'
      });
      continue;
    }

    // In chat mode, just output and stop
    if (!isAgentLike) {
      label(G, 'DONE', 'Chat mode — no tool execution');
      break;
    }

    // Check for tool calls
    const toolCalls = extractToolCalls(assistantText);
    const cleanText = stripToolCalls(assistantText);

    if (toolCalls.length === 0) {
      // Detect malformed tool-call JSON (model tried to call a tool but the JSON is invalid).
      // Per CLAUDE.md: reject leaked/malformed tool-call payloads and nudge instead of treating them as a final answer.
      const toolStarts = findToolStarts(assistantText);
      const looksLikeMalformedTool =
        toolStarts.length > 0 ||
        /```\s*(json|tool|tool_call)/i.test(assistantText) ||
        /"tool"\s*:\s*"/.test(assistantText);
      if (looksLikeMalformedTool) {
        consecutiveMalformed += 1;
        label(R, 'MALFORMED', `Model emitted tool-shaped text that did not parse (${toolStarts.length} starts, ${assistantText.length} chars, streak=${consecutiveMalformed})`);
        logEvent('malformed_tool_call', { turn, streak: consecutiveMalformed, content: assistantText.slice(0, 400) });
        if (consecutiveMalformed >= MAX_CONSECUTIVE_MALFORMED) {
          label(R, 'BAIL', `Aborting: ${consecutiveMalformed} consecutive malformed tool calls — model cannot recover`);
          logEvent('bail_malformed', { turn });
          break;
        }
        messages.push({ role: 'assistant', content: cleanText || '(malformed tool call)' });
        messages.push({
          role: 'user',
          content:
            'Your last response contained tool-call-shaped text but the JSON was invalid (bad escapes, mismatched quotes, or missing colons). Emit exactly ONE valid tool call now. Do NOT wrap it in markdown fences. Do NOT include extra prose. Use the format {"tool": "name", "args": {"key": "value"}}. Strings inside "content" must use \\n for newlines, escape every " inside the string as \\", and never embed an unescaped { or } that breaks JSON.'
        });
        continue;
      }

      // Refusal-style response: the user asked for an action and the model produced narrative
      // without a single tool call. Nudge once before accepting the response as a final answer.
      const noToolsExecutedYet = toolCallCounts.size === 0;
      if (promptExpectsAction && noToolsExecutedYet && !refusalNudgeFired) {
        refusalNudgeFired = true;
        label(R, 'REFUSAL', `Model returned narrative for an action-required prompt without calling any tool (turn ${turn}). Nudging once.`);
        logEvent('refusal_nudge', { turn, content: assistantText.slice(0, 400) });
        messages.push({ role: 'assistant', content: cleanText || '(no tool call)' });
        messages.push({
          role: 'user',
          content:
            'You answered with prose, but this task requires you to actually call tools to read or modify files in this workspace. The files exist and the tools work — you have access. Do not describe hypothetical changes. Call the appropriate tool now (e.g. read_specific_file, replace_in_file, create_or_edit_file). Output only the tool call JSON.'
        });
        continue;
      }
      label(G, 'DONE', 'No tool calls — task complete');
      break;
    }
    consecutiveMalformed = 0;

    // De-duplicate tool calls WITHIN this turn — some models emit the same call twice
    // back-to-back when they enter a "list everything" mode. We only need to run it once
    // before the duplicate-loop guard counts it across turns.
    const seenInTurn = new Set();
    const dedupedToolCalls = [];
    for (const tool of toolCalls) {
      const sig = `${tool.name}::${JSON.stringify(tool.args)}`;
      if (seenInTurn.has(sig)) continue;
      seenInTurn.add(sig);
      dedupedToolCalls.push(tool);
    }

    // Cap tools per turn so a single response that emits 20+ read calls (observed with
    // qwen3-coder:30b on broad "scan and explain" prompts) does not blow up context. Mirrors the
    // live agent loop's MAX_TOOLS_PER_TURN guard. Prioritise writes/terminal over reads.
    const MAX_TOOLS_PER_TURN = 3;
    let prioritisedToolCalls = dedupedToolCalls;
    if (dedupedToolCalls.length > MAX_TOOLS_PER_TURN) {
      const writes = dedupedToolCalls.filter(t => /create_or_edit_file|write_to_file|replace_in_file|delete_file/.test(t.name));
      const terminal = dedupedToolCalls.filter(t => /execute_terminal_command|launch_in_terminal/.test(t.name));
      const reads = dedupedToolCalls.filter(t => !writes.includes(t) && !terminal.includes(t));
      prioritisedToolCalls = [...writes, ...terminal, ...reads].slice(0, MAX_TOOLS_PER_TURN);
      const dropped = dedupedToolCalls.length - prioritisedToolCalls.length;
      label(Y, 'CAP', `Capping ${dedupedToolCalls.length} tool calls to ${MAX_TOOLS_PER_TURN}; dropped ${dropped} (writes prioritised, then terminal, then reads).`);
      logEvent('tool_cap_applied', { turn, requested: dedupedToolCalls.length, executed: prioritisedToolCalls.length });
    }

    // Detect duplicate-write loops: same tool + identical args called repeatedly across turns.
    // Common with mid/large models that "redo" a successful write instead of producing a final answer.
    const duplicateSignatures = [];
    for (const tool of prioritisedToolCalls) {
      const sig = `${tool.name}::${JSON.stringify(tool.args)}`;
      const count = (toolCallCounts.get(sig) ?? 0) + 1;
      toolCallCounts.set(sig, count);
      if (count > MAX_DUPLICATE_TOOL_CALLS) duplicateSignatures.push({ sig, count });
    }
    if (duplicateSignatures.length > 0) {
      const { sig, count } = duplicateSignatures[0];
      label(R, 'BAIL', `Aborting: identical tool call repeated ${count}× — duplicate-write loop (${sig.slice(0, 60)}...)`);
      logEvent('bail_duplicate_tool_call', { turn, signature: sig, count });
      break;
    }

    // Add assistant message to history
    messages.push({ role: 'assistant', content: cleanText || '(tool call)' });

    const toolCallsToRun = prioritisedToolCalls;
    label(Y, 'TOOLS', toolCallsToRun.map(t => t.name).join(', '));

    // Execute tools (post-cap, post-dedup)
    let lastToolWasWrite = false;
    let lastToolWasTerminal = false;
    for (const tool of toolCallsToRun) {
      label(B, 'EXECUTE', `${tool.name}(${JSON.stringify(tool.args).slice(0, 80)}...)`);
      logEvent('tool_start', { tool: tool.name, args: tool.args });

      const result = await executeTool(tool.name, tool.args);
      logEvent('tool_result', { tool: tool.name, hasError: !!result.error });

      if (result.error) {
        label(R, 'ERROR', `${tool.name}: ${result.error}`);
      } else {
        label(G, 'OK', `${tool.name}`);
      }

      messages.push({
        role: 'tool',
        content: result.error ? JSON.stringify({ error: result.error }) : result.content,
      });

      if ((tool.name === 'create_or_edit_file' || tool.name === 'replace_in_file') && !result.error) {
        lastToolWasWrite = true;
      }
      if (tool.name === 'execute_terminal_command' && !result.error) {
        lastToolWasTerminal = true;
      }
      if (tool.name === 'read_specific_file' || tool.name === 'read_file_slice') {
        const fp = String(tool.args.filepath ?? tool.args.path ?? '');
        if (fp) readFilesThisSession.add(fp);
      }
      if (tool.name === 'project_scan') {
        hasProjectScanned = true;
      }
    }

    // Feed back dropped tools as errors so the model knows they were skipped
    if (dedupedToolCalls.length > MAX_TOOLS_PER_TURN) {
      const dropped = dedupedToolCalls.slice(MAX_TOOLS_PER_TURN);
      for (const tool of dropped) {
        const errorMsg = `Tool "${tool.name}" was NOT executed because you output too many tools at once. Maximum is ${MAX_TOOLS_PER_TURN} per turn. Call it in the next turn if still needed.`;
        messages.push({
          role: 'tool',
          content: JSON.stringify({ error: errorMsg, args: tool.args }),
        });
      }
    }

    // Track consecutive read/list turns for auto-bootstrap
    const allReadsOrLists = toolCalls.every((tc) =>
      tc.name === 'read_specific_file' ||
      tc.name === 'read_file_slice' ||
      tc.name === 'list_workspace_files' ||
      tc.name === 'project_scan'
    );
    if (allReadsOrLists) {
      consecutiveReadOrListTurns++;
    } else {
      consecutiveReadOrListTurns = 0;
    }

    // General exploration limit: after 3 consecutive read-only turns, force an answer
    if (consecutiveReadOrListTurns >= 3) {
      const readFilesList = Array.from(readFilesThisSession).map(f => `- ${f}`).join('\n');
      const answerNudge =
        `STOP. You have been exploring the workspace for ${consecutiveReadOrListTurns} turns without making progress.` +
        `\n\nYou have already seen:\n${readFilesList || '- project structure via project_scan'}` +
        `\n\nDO NOT read any more files. DO NOT list files. You already have enough information.` +
        `\n\nThe user did NOT ask you to create or edit files. They asked a QUESTION.` +
        `\n\nAnswer the user's question in plain text NOW, using only the information you already have. No tool calls.`;
      messages.push({ role: 'user', content: answerNudge });
      label(Y, 'FORCE ANSWER', 'stopping exploration after 3+ read-only turns');
      logEvent('force_answer', { turn, consecutiveReadOrListTurns, readFiles: Array.from(readFilesThisSession) });
    }
    // Auto-bootstrap: if stuck in read-only loop for 2+ turns, force a create instruction.
    // ONLY fire when we know the target filename from the user's prompt.
    else if (consecutiveReadOrListTurns >= 2 && targetFilename) {
      const readFilesList = Array.from(readFilesThisSession).map(f => `- ${f}`).join('\n');
      const bootstrapNudge =
        `STOP. You are stuck in a read loop. You have already read these files:\n${readFilesList || '- (project scanned)'}` +
        `\n\nDO NOT read any more files. DO NOT list files. You already have all the information you need.` +
        `\n\nThe user asked you to CREATE a file. The target file is \`${targetFilename}\`.` +
        `\n\nOutput ONLY a create_or_edit_file tool call NOW with filename "${targetFilename}".` +
        `\nNo text, no explanation — just the tool JSON.` +
        `\n\nCRITICAL: You MUST use filename "${targetFilename}". Any other filename is wrong. Do NOT create any other file.`;
      messages.push({ role: 'user', content: bootstrapNudge });
      label(Y, 'BOOTSTRAP', 'forcing create after read-only loop');
      logEvent('auto_bootstrap_read_loop', { turn, consecutiveReadOrListTurns, readFiles: Array.from(readFilesThisSession) });
    }

    // Stop after writes or terminal commands
    if (lastToolWasWrite) {
      label(G, 'DONE', 'Write operation completed — stopping');
      logEvent('agent_stop', { turn, reason: 'write_operation' });
      break;
    }
    if (lastToolWasTerminal) {
      label(G, 'DONE', 'Terminal command executed — stopping');
      logEvent('agent_stop', { turn, reason: 'terminal_command' });
      break;
    }

    lastTurnFullyCompleted = true;
  }

  if (lastTurnFullyCompleted && completedTurns === MAX_TURNS) {
    label(R, 'STOP', `Max turns (${MAX_TURNS}) reached`);
  }

  logEvent('session_end', { totalMessages: messages.length, completedTurns });
  label(B, 'SUMMARY', `Turns: ${completedTurns} | Log: ${LOG_FILE}`);
}

runAgent().catch(err => {
  label(R, 'FATAL', err.message);
  logEvent('fatal_error', { error: err.message });
  process.exit(1);
});
