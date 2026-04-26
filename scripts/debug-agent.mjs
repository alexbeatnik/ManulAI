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
function extractToolCalls(text) {
  const results = [];

  // Pattern 1: Correct format {"tool": "name", "args": {...}}
  const correctRegex = /\{\s*"tool"\s*:\s*"([^"]+)"\s*,\s*"args"\s*:\s*(\{[\s\S]*?\})\s*\}/g;
  let match;
  while ((match = correctRegex.exec(text)) !== null) {
    try {
      results.push({ name: match[1], args: JSON.parse(match[2]) });
    } catch { /* ignore invalid JSON */ }
  }

  // Pattern 2: Malformed flat format {"tool": "name", "filepath": "...", ...}
  // (models like gemma4 sometimes put args directly in the object)
  const flatRegex = /\{\s*"tool"\s*:\s*"([^"]+)"\s*,\s*"([^"]+)"\s*:/g;
  let flatMatch;
  const seen = new Set(results.map(r => JSON.stringify(r)));
  while ((flatMatch = flatRegex.exec(text)) !== null) {
    if (flatMatch[2] === 'args') continue; // Already handled by pattern 1
    try {
      const fullMatch = text.slice(flatMatch.index).match(/^\{[\s\S]*?\}/);
      if (!fullMatch) continue;
      const parsed = JSON.parse(fullMatch[0]);
      const { tool, ...args } = parsed;
      const entry = { name: tool, args };
      const key = JSON.stringify(entry);
      if (!seen.has(key)) {
        seen.add(key);
        results.push(entry);
      }
    } catch { /* ignore invalid JSON */ }
  }

  return results;
}

function stripToolCalls(text) {
  return text.replace(/\{\s*"tool"\s*:\s*"[^"]+"\s*,\s*"args"\s*:\s*\{[\s\S]*?\}\s*\}/g, '').trim();
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
        if (!isBlockedCommand(fp)) {
          writeFileSync(fp, String(args.content ?? ''), 'utf8');
        }
        return { content: JSON.stringify({ path: fp, action: 'created_or_overwritten' }) };
      }
      case 'replace_in_file': {
        const fp = resolveUri(String(args.filepath ?? ''));
        const content = readFileSync(fp, 'utf8');
        const oldText = String(args.old_text ?? '');
        if (!content.includes(oldText)) {
          return { content: '', error: `old_text not found in ${fp}` };
        }
        writeFileSync(fp, content.replace(oldText, String(args.new_text ?? '')), 'utf8');
        return { content: JSON.stringify({ path: fp, action: 'replaced' }) };
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

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
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
      label(G, 'DONE', 'No tool calls — task complete');
      break;
    }

    // Add assistant message to history
    messages.push({ role: 'assistant', content: cleanText || '(tool call)' });

    label(Y, 'TOOLS', toolCalls.map(t => t.name).join(', '));

    // Execute tools
    for (const tool of toolCalls) {
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
    }
  }

  if (messages.length > MAX_TURNS) {
    label(R, 'STOP', `Max turns (${MAX_TURNS}) reached`);
  }

  logEvent('session_end', { totalMessages: messages.length });
  label(B, 'SUMMARY', `Turns: ${Math.min(MAX_TURNS, messages.length)} | Log: ${LOG_FILE}`);
}

runAgent().catch(err => {
  label(R, 'FATAL', err.message);
  logEvent('fatal_error', { error: err.message });
  process.exit(1);
});
