#!/usr/bin/env node
/**
 * ManulAI debug runner — sends requests directly to Ollama and simulates the
 * agent loop without reinstalling the extension.
 *
 * Usage:
 *   node scripts/debug-agent.mjs "your prompt"
 *   node scripts/debug-agent.mjs --target src/debug-lab/SandboxTarget.ts "your prompt"
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

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
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

function getModelSizeInBillions(model) {
  const m = model.toLowerCase().match(/(\d+\.?\d*)b/);
  if (m) return parseFloat(m[1]);
  // Family-specific fallback for models whose default tag has no size suffix
  if (/^gemma4(?:[:]|$)/i.test(model) && /:(latest|instruct|it)$/i.test(model)) return 8;
  return 0;
}

function isPreferredSupportedModel(model) {
  const normalized = model.trim().toLowerCase();
  return /^phi4-mini(?:[:]|$)/.test(normalized)
    || /^llama3\.1(?:[:]|$)/.test(normalized)
    || /^qwen3-coder(?:[:]|$)/.test(normalized)
    || /^gemma4(?:[:]|$)/.test(normalized);
}

function getModelCapabilityProfile(model) {
  const normalizedModel = model.trim().toLowerCase();
  const sizeB = getModelSizeInBillions(model);
  const preferredToolNames = ['read_active_file', 'read_specific_file', 'read_file_slice', 'create_or_edit_file', 'replace_in_file', 'execute_terminal_command', 'launch_in_terminal', 'delete_file', 'list_workspace_files'];

  if (/^phi4-mini(?:[:]|$)/.test(normalizedModel)) {
    return {
      tier: 'medium',
      maxMessages: 14,
      numCtx: 8192,
      maxReadOpsWithoutWrite: 2,
      maxNudgeRetriesCap: 4,
      toolNames: preferredToolNames,
      compactMandate: true,
      preferStepwiseExecution: true,
      repeatPenalty: 1.15,
    };
  }
  if (/^llama3\.1(?:[:]|$)/.test(normalizedModel)) {
    return {
      tier: 'medium',
      maxMessages: 20,
      numCtx: 12288,
      maxReadOpsWithoutWrite: 2,
      maxNudgeRetriesCap: 4,
      toolNames: preferredToolNames,
      compactMandate: false,
      preferStepwiseExecution: true,
    };
  }
  if (/^qwen3-coder(?:[:]|$)/.test(normalizedModel)) {
    return {
      tier: 'large',
      maxMessages: 28,
      numCtx: 16384,
      maxReadOpsWithoutWrite: 2,
      maxNudgeRetriesCap: 5,
      toolNames: preferredToolNames,
      compactMandate: false,
      preferStepwiseExecution: true,
    };
  }
  // gemma4: native tool calling broken in Ollama — uses text-tool fallback mode instead
  if (/^gemma4(?:[:]|$)/.test(normalizedModel)) {
    const isLarge = sizeB > 10; // gemma4:31b
    return {
      tier: isLarge ? 'large' : 'medium',
      maxMessages: isLarge ? 28 : 20,
      numCtx: isLarge ? 16384 : 12288,
      maxReadOpsWithoutWrite: 2,
      maxNudgeRetriesCap: isLarge ? 4 : 3,
      toolNames: preferredToolNames,
      compactMandate: false,
      preferStepwiseExecution: true,
      useTextTools: true, // do not send native tools array; inject text tool format into mandate
    };
  }

  if (sizeB > 0 && sizeB <= 1.5) {
    return {
      tier: 'micro',
      maxMessages: 8,
      numCtx: 4096,
      maxReadOpsWithoutWrite: 2,
      maxNudgeRetriesCap: 1,
      toolNames: ['read_specific_file', 'read_file_slice', 'create_or_edit_file', 'replace_in_file', 'list_workspace_files'],
      compactMandate: true,
      preferStepwiseExecution: true,
    };
  }
  if (sizeB > 1.5 && sizeB <= 3.5) {
    return {
      tier: 'small',
      maxMessages: 10,
      numCtx: 6144,
      maxReadOpsWithoutWrite: 2,
      maxNudgeRetriesCap: 2,
      toolNames: ['read_active_file', 'read_specific_file', 'read_file_slice', 'create_or_edit_file', 'replace_in_file', 'list_workspace_files', 'execute_terminal_command'],
      compactMandate: true,
      preferStepwiseExecution: true,
    };
  }
  if (sizeB > 0 && sizeB <= 9) {
    return {
      tier: 'medium',
      maxMessages: 16,
      numCtx: 8192,
      maxReadOpsWithoutWrite: 3,
      maxNudgeRetriesCap: 3,
      toolNames: null,
      compactMandate: false,
      preferStepwiseExecution: false,
    };
  }
  if (sizeB > 9 && sizeB <= 16) {
    return {
      tier: 'large',
      maxMessages: 24,
      numCtx: 12288,
      maxReadOpsWithoutWrite: 3,
      maxNudgeRetriesCap: 4,
      toolNames: null,
      compactMandate: false,
      preferStepwiseExecution: false,
    };
  }
  if (sizeB > 16 && sizeB <= 34) {
    return {
      tier: 'large',
      maxMessages: 32,
      numCtx: 16384,
      maxReadOpsWithoutWrite: 3,
      maxNudgeRetriesCap: 4,
      toolNames: null,
      compactMandate: false,
      preferStepwiseExecution: false,
    };
  }
  return {
    tier: 'xlarge',
    maxMessages: 48,
    numCtx: 32768,
    maxReadOpsWithoutWrite: 4,
    maxNudgeRetriesCap: 5,
    toolNames: null,
    compactMandate: false,
    preferStepwiseExecution: false,
  };
}
const MODEL_LIMITS = getModelCapabilityProfile(MODEL);

const cliArgs = process.argv.slice(2);

// --planner flag or MANUL_MODE env var selects planner (condensed) mode
const plannerFlagIndex = cliArgs.indexOf('--planner');
if (plannerFlagIndex >= 0) cliArgs.splice(plannerFlagIndex, 1);
const MANUL_MODE = plannerFlagIndex >= 0 ? 'planner' : (process.env.MANUL_MODE ?? 'agent');
let cliTargetFile;
const targetFlagIndex = cliArgs.indexOf('--target');
if (targetFlagIndex >= 0) {
  cliTargetFile = cliArgs[targetFlagIndex + 1];
  cliArgs.splice(targetFlagIndex, 2);
}

// The large file to split. Use --target or TARGET_FILE env var to override.
const TARGET_FILE = cliTargetFile ?? process.env.TARGET_FILE ?? 'src/ManulAiChatProvider.ts';
const TARGET_BASENAME = path.basename(TARGET_FILE, path.extname(TARGET_FILE));
const TARGET_DIR = path.posix.dirname(TARGET_FILE.replace(/\\/g, '/'));
const TARGET_EXTENSION = path.extname(TARGET_FILE) || '.txt';
const TARGET_ABS_FILE = path.normalize(path.join(wsRoot, TARGET_FILE));
const SUGGESTED_TYPES_FILE = TARGET_DIR === '.' ? `types${TARGET_EXTENSION}` : `${TARGET_DIR}/types${TARGET_EXTENSION}`;
const SUGGESTED_INTERFACES_FILE = TARGET_DIR === '.' ? `interfaces${TARGET_EXTENSION}` : `${TARGET_DIR}/interfaces${TARGET_EXTENSION}`;
const TARGET_LANGUAGE_ID = detectLanguageId(TARGET_FILE);
const TARGET_CODE_FENCE = detectCodeFenceLanguage(TARGET_FILE);

const sessionId   = new Date().toISOString().replace(/[:.]/g, '-');
const logDir      = path.join(wsRoot, '.manulai', 'logs');
const LOG_FILE    = process.env.LOG_FILE ?? path.join(logDir, `debug-${sessionId}.jsonl`);

// In-session cache for DRY_RUN "written" files (module-level so executeTool can access it)
const dryRunFiles = new Map();
let preferredGreenfieldSuccessfulWriteCount = 0;

const userPrompt = cliArgs[0];
if (!userPrompt) {
  console.error('Usage: node scripts/debug-agent.mjs [--target path/to/file.ts] [--planner] "your prompt"');
  process.exit(1);
}

// Detect whether this run is a file-splitting task — only then enforce extractionCount gate
const IS_SPLIT_TASK = /розбий|split|refactor.*module|extract.*module/i.test(userPrompt);

function looksLikeWriteIntent(text) {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  const englishWritePattern = /\b(?:create|write|edit|modify|update|add|append|change|rename|delete|remove|refactor|split|move|build|make|generate)\b/i;
  const cyrillicWritePattern = /(?:^|[\s"'`([{])(?:поміняй|зміни|измени|поменяй|онови|обнови|заміни|замени|відредагуй|редагуй|перепиши|додай|добавь|видали|удали|створи|создай|зроби|сделай|напиши|виправ|исправь|згенеруй|сгенерируй|побудуй|собери)(?=$|[\s"'`)\]},.!?:;])/i;
  return englishWritePattern.test(normalized) || cyrillicWritePattern.test(normalized);
}

function isSyntaxRelevantFilePath(filepath) {
  const ext = path.extname(filepath || '').toLowerCase();
  return new Set([
    '.ts', '.tsx', '.mts', '.cts',
    '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.go', '.rs', '.java', '.kt', '.cs', '.php', '.rb', '.swift',
    '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp', '.hh',
    '.html', '.css', '.scss', '.sass', '.less', '.json', '.jsonc', '.yaml', '.yml', '.sh'
  ]).has(ext);
}

function isGreenfieldSourceFilePath(filepath) {
  const ext = path.extname(filepath || '').toLowerCase();
  return isSyntaxRelevantFilePath(filepath) && !['.json', '.jsonc', '.yaml', '.yml'].includes(ext);
}

function looksLikeGreenfieldCreateTask(text) {
  const normalized = text.trim().toLowerCase();
  if (!normalized || !looksLikeWriteIntent(text)) return false;
  if (/\b(?:scan|inspect|analy[sz]e|read)\s+(?:the\s+)?(?:project|workspace|repo|repository|codebase)\b/i.test(normalized)) return false;
  if (/розбий|split|refactor.*module|extract.*module/i.test(normalized)) return false;
  if (extractLikelyRequestFileTargets(text).length > 0) return false;
  return /(?:\bfrom scratch\b|\bconsole\b|\bcli\b|\bgame\b|\bapp\b|\bscript\b|\btool\b|\bprogram\b|\bservice\b|\bбот\b|\bгра\b|\bгру\b|\bскрипт\b|\bдодаток\b|\bутиліт)/i.test(normalized);
}

function looksLikeExplicitCreateOnlyTask(text) {
  const normalized = text.trim().toLowerCase();
  if (!normalized || !looksLikeWriteIntent(text)) return false;
  if (/розбий|split|refactor.*module|extract.*module/i.test(normalized)) return false;

  const explicitTargets = extractLikelyRequestFileTargets(text);
  if (explicitTargets.length === 0) return false;

  const createPattern = /\b(?:create|write|add|generate|make|scaffold)\b|(?:^|[\s"'`([{])(?:створи|создай|згенеруй|сгенерируй|зроби|сделай|напиши|побудуй|собери)(?=$|[\s"'`)\]},.!?:;])/i;
  const editPattern = /\b(?:rename|replace|fix|change|update|edit|modify|rewrite|refactor|split|move|delete|remove)\b|(?:^|[\s"'`([{])(?:поміняй|зміни|измени|поменяй|онови|обнови|заміни|замени|відредагуй|редагуй|перепиши|виправ|исправь|видали|удали)(?=$|[\s"'`)\]},.!?:;])/i;
  return createPattern.test(normalized) && !editPattern.test(normalized);
}

const REQUIRES_FILE_WRITE = looksLikeWriteIntent(userPrompt);
const IS_PREFERRED_GREENFIELD_REQUEST = isPreferredSupportedModel(MODEL)
  && looksLikeGreenfieldCreateTask(userPrompt)
  && !IS_SPLIT_TASK;
const IS_EXPLICIT_CREATE_ONLY_TASK = !IS_SPLIT_TASK && looksLikeExplicitCreateOnlyTask(userPrompt);
const PREFERRED_GREENFIELD_BOOTSTRAP_FILEPATH = IS_PREFERRED_GREENFIELD_REQUEST
  ? inferDegenerateRecoveryStarterFilepath(userPrompt)
  : undefined;
const IS_CODE_PREFERRED_GREENFIELD_REQUEST = !!PREFERRED_GREENFIELD_BOOTSTRAP_FILEPATH
  && isSyntaxRelevantFilePath(PREFERRED_GREENFIELD_BOOTSTRAP_FILEPATH);
const SHOULD_BLOCK_IMMEDIATE_DRY_RUN_TERMINAL = DRY_RUN && IS_PREFERRED_GREENFIELD_REQUEST;

function buildDryRunTerminalBlockResult(command, filePath) {
  const targetPath = filePath ? ` after creating ${filePath}` : '';
  return JSON.stringify({
    command,
    exitCode: 0,
    blocked: true,
    skipped: true,
    note: `execute_terminal_command was skipped in DRY_RUN greenfield smoke${targetPath}. Continue with file creation, another file/tool step, or finalization instead of executing the new file.`
  });
}

function buildEarlyGreenfieldTerminalBlockResult(command) {
  return JSON.stringify({
    command,
    exitCode: 1,
    blocked: true,
    reason: 'prewrite_greenfield_terminal',
    error: `Blocked command: do not use execute_terminal_command before the first real file write for this preferred-model greenfield task. Start by writing ${PREFERRED_GREENFIELD_BOOTSTRAP_FILEPATH ? path.basename(PREFERRED_GREENFIELD_BOOTSTRAP_FILEPATH) : 'the main source file'}.`
  });
}

function isTerminalReadOnlyInspectionCommand(command) {
  const trimmed = String(command ?? '').trim();
  const normalized = trimmed.toLowerCase();
  if (!normalized) return false;
  if (/[;&|<>`\n\r]|\$\(|\b-exec\b/.test(trimmed)) return false;
  if (/\bsed\b[^\n]*\s-i\b/.test(normalized)) return false;
  return /^(?:cat|head|tail|sed|grep|rg|less|more|ls|find)\b/.test(normalized)
    || /(?:\bcat\b|\bhead\b|\btail\b|\bsed\b|\bgrep\b|\brg\b).*\bmanulaichatprovider\.ts\b/.test(normalized)
    || /^ls(?:\b|\b.*-)/.test(normalized);
}

function getDeterministicGreenfieldTargetPath() {
  if (!IS_CODE_PREFERRED_GREENFIELD_REQUEST || !PREFERRED_GREENFIELD_BOOTSTRAP_FILEPATH) return undefined;
  return PREFERRED_GREENFIELD_BOOTSTRAP_FILEPATH;
}

function normalizeComparablePath(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function toolPathMatchesTarget(toolPathValue, targetPath) {
  const toolPath = normalizeComparablePath(toolPathValue);
  const normalizedTarget = normalizeComparablePath(targetPath);
  if (!toolPath || !normalizedTarget) return false;
  return toolPath === normalizedTarget
    || toolPath.endsWith(`/${normalizedTarget}`)
    || path.basename(toolPath) === path.basename(normalizedTarget);
}

function buildPendingVerifyTerminalBlockResult(command, pendingPath) {
  const targetLabel = pendingPath ? ` for ${path.basename(pendingPath)}` : '';
  return JSON.stringify({
    command,
    exitCode: 1,
    blocked: true,
    reason: 'greenfield_verify_before_run',
    error: `Blocked command: do not run arbitrary terminal commands${targetLabel} before syntax verification completes for the latest greenfield file write. Let the automatic verification run first, then continue with fixes if needed.`
  });
}

function buildGlobalInstallBlockResult(command) {
  return JSON.stringify({
    command,
    exitCode: 1,
    blocked: true,
    reason: 'global_install_blocked',
    error: 'Blocked command: do not install packages globally from the agent loop. Use local project dependencies only when the user explicitly asked for them or they are genuinely required inside the current workspace.'
  });
}

function isGlobalPackageInstallCommand(command) {
  const normalized = String(command ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normalized) return false;
  return /(?:^|\b)(?:npm\s+(?:install|i|add)\s+-g\b|pnpm\s+add\s+-g\b|yarn\s+global\s+add\b|bun\s+add\s+-g\b)/.test(normalized);
}

async function runTerminalCommandDirect(command) {
  try {
    const { stdout, stderr } = await execAsync(command, { cwd: wsRoot, timeout: 30_000, maxBuffer: 1024 * 512 });
    return JSON.stringify({ command, exitCode: 0, stdout, stderr });
  } catch (e) {
    let errorMessage = e.message;
    if (e.killed) {
      errorMessage = 'Command timed out after 30 seconds. No stdin available — interactive programs (input(), readline) will always hang.';
    }
    return JSON.stringify({ command, exitCode: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '', error: errorMessage });
  }
}

function isRetryableOllamaFetchError(error) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /fetch failed|networkerror|econnreset|econnrefused|socket hang up|timed out|timeout/i.test(message);
}

async function fetchOllamaChat(body) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (error) {
      lastError = error;
      if (attempt >= 1 || !isRetryableOllamaFetchError(error)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error ?? 'unknown fetch error');
      label(Y, 'OLLAMA RETRY', `Transient fetch failure: ${message}`);
      logEvent('ollama_fetch_retry', { attempt: attempt + 1, error: message });
      await new Promise(resolve => setTimeout(resolve, 700));
    }
  }
  throw lastError ?? new Error('Ollama fetch failed');
}

function detectInsufficientGreenfieldCreateContent(filepath, content) {
  if (!IS_PREFERRED_GREENFIELD_REQUEST) return undefined;

  const nonEmptyLines = content.replace(/\r\n/g, '\n').split('\n').map(line => line.trim()).filter(Boolean);
  const ext = path.extname(filepath).toLowerCase();
  if (!isGreenfieldSourceFilePath(filepath)) {
    const codeLikeLines = nonEmptyLines.filter(line =>
      !/^(?:\/\/|\/\*|\*|#|<!--)/.test(line)
      && (/(?:^|\s)(?:export|import|const|let|var|function|class|interface|type|enum|async|def|struct|impl|package|namespace|using|return)\b/.test(line)
        || /[{}();=]/.test(line))
    );
    if (IS_CODE_PREFERRED_GREENFIELD_REQUEST && codeLikeLines.length > 0) {
      return 'Blocked write: source code for a greenfield task must go into a real source file, not a generic text or data file. Write the implementation to the correct .py, .ts, .js, .go, .rs, .java, .cs, or similar source file path.';
    }
    return undefined;
  }

  if (nonEmptyLines.length === 0) {
    return 'Blocked write: greenfield file content is empty. Write the actual implementation instead of an empty scaffold.';
  }

  const nonCommentLines = nonEmptyLines.filter(line => !/^(?:\/\/|\/\*|\*|#|<!--)/.test(line));
  const placeholderPattern = /(?:your\s+\w+\s+here|your game logic here|game logic here|logic here|implementation here|code here|placeholder|stub|todo|tbd|coming soon|implement me|fill (?:me|this) in|to be implemented)/i;
  const hasPlaceholderLine = nonEmptyLines.some(line => placeholderPattern.test(line));
  const nonImportLines = nonCommentLines.filter(line => !/^(?:import\s+.+|from\s+\S+\s+import\s+.+|using\s+.+;?|package\s+[\w.]+;?|namespace\s+[\w.]+;?|export\s+\{.*\};?)$/.test(line));
  const targetExt = path.extname(PREFERRED_GREENFIELD_BOOTSTRAP_FILEPATH ?? '').toLowerCase();
  const isFirstGreenfieldSourceWrite = preferredGreenfieldSuccessfulWriteCount === 0
    && IS_CODE_PREFERRED_GREENFIELD_REQUEST
    && (!targetExt || ext === targetExt);
  if (isFirstGreenfieldSourceWrite) {
    const implementationSignalPattern = /(?:\bclass\b|\bfunction\b|\bdef\b|\bfunc\b|\bstruct\b|\benum\b|\binterface\b|\btype\b|\bif\b|\bfor\b|\bwhile\b|\bswitch\b|\bmatch\b|\bcase\b|\breturn\b|\btry\b|\bcatch\b|=>|[{}()[\];=])/i;
    const trivialBoilerplatePattern = /^(?:print\s*\(.+\)\s*|console\.log\s*\(.+\)\s*|puts\s+.+|echo\s+.+|pass\b|return\b.*|main\s*\(\s*\)\s*|def\s+main\s*\(\s*\)\s*:|if\s+__name__\s*==\s*['"]__main__['"]\s*:|function\s+main\s*\(|public\s+static\s+void\s+main\s*\(|int\s+main\s*\(|fn\s+main\s*\(|package\s+[\w.]+;?|using\s+[\w.]+;?|import\s+.+|from\s+\S+\s+import\s+.+)$/i;
    const significantLines = nonImportLines.filter(line => implementationSignalPattern.test(line));
    const hasOnlyTrivialBoilerplate = nonEmptyLines.every(line => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (/^(?:#|\/\/|\/\*|\*)/.test(trimmed)) {
        return placeholderPattern.test(trimmed);
      }
      return trivialBoilerplatePattern.test(trimmed);
    });
    if (significantLines.length < 3 && (hasOnlyTrivialBoilerplate || nonImportLines.length <= 6)) {
      return 'Blocked write: the first source file for this greenfield task is too thin to be a real starting implementation. Do not stop at a placeholder, a single print/log line, or a bare wrapper. Write a minimal but working first version with real control flow and implementation logic.';
    }
  }

  if (!hasPlaceholderLine) return undefined;

  const hasImplementationLine = nonImportLines.some(line => /(?:\bdef\b|\bclass\b|\bfunction\b|\bconst\b|\blet\b|\bvar\b|\bif\b|\bfor\b|\bwhile\b|\breturn\b|\bprint\s*\(|\bconsole\.log\s*\(|\bmain\s*\(|=>|[{}();=])/.test(line));
  if (hasImplementationLine) return undefined;

  return 'Blocked write: greenfield file content is still a placeholder scaffold, not a real implementation. Do not write comments like "Your game logic here". Write the actual working code now.';
}

function detectLanguageId(filepath) {
  const ext = path.extname(filepath).toLowerCase();
  const map = {
    '.ts': 'typescript',
    '.tsx': 'typescriptreact',
    '.js': 'javascript',
    '.jsx': 'javascriptreact',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.py': 'python',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java',
    '.kt': 'kotlin',
    '.cs': 'csharp',
    '.php': 'php',
    '.rb': 'ruby',
    '.swift': 'swift',
    '.c': 'c',
    '.h': 'c',
    '.cpp': 'cpp',
    '.cc': 'cpp',
    '.cxx': 'cpp',
    '.hpp': 'cpp',
    '.hh': 'cpp',
    '.json': 'json',
    '.md': 'markdown',
    '.html': 'html',
    '.css': 'css',
    '.yml': 'yaml',
    '.yaml': 'yaml',
    '.xml': 'xml',
    '.sh': 'shell',
    '.bash': 'shell'
  };
  return map[ext] ?? 'plaintext';
}

function detectCodeFenceLanguage(filepath) {
  const languageId = detectLanguageId(filepath);
  if (languageId === 'typescriptreact') return 'tsx';
  if (languageId === 'javascriptreact') return 'jsx';
  if (languageId === 'csharp') return 'csharp';
  if (languageId === 'markdown') return 'markdown';
  if (languageId === 'plaintext') return '';
  return languageId;
}

function extractSymbolNamesFromContent(content, filepath = TARGET_FILE) {
  const languageId = detectLanguageId(filepath);
  const names = [];
  const add = value => {
    if (!value) return;
    if (!names.includes(value)) names.push(value);
  };
  const patternsByLanguage = {
    typescript: [
      /^\s*export\s+(?:(?:type|interface|abstract|declare)\s+)*(?:function\s+|class\s+|const\s+|let\s+|var\s+|enum\s+)?([A-Za-z_][\w]*)/gm,
      /^\s*(?:interface|type|class|enum|function)\s+([A-Za-z_][\w]*)/gm
    ],
    typescriptreact: [
      /^\s*export\s+(?:(?:type|interface|abstract|declare)\s+)*(?:function\s+|class\s+|const\s+|let\s+|var\s+|enum\s+)?([A-Za-z_][\w]*)/gm,
      /^\s*(?:interface|type|class|enum|function)\s+([A-Za-z_][\w]*)/gm
    ],
    javascript: [
      /^\s*export\s+(?:async\s+)?(?:function\s+|class\s+|const\s+|let\s+|var\s+)?([A-Za-z_][\w]*)/gm,
      /^\s*(?:async\s+)?function\s+([A-Za-z_][\w]*)/gm,
      /^\s*class\s+([A-Za-z_][\w]*)/gm
    ],
    javascriptreact: [
      /^\s*export\s+(?:async\s+)?(?:function\s+|class\s+|const\s+|let\s+|var\s+)?([A-Za-z_][\w]*)/gm,
      /^\s*(?:async\s+)?function\s+([A-Za-z_][\w]*)/gm,
      /^\s*class\s+([A-Za-z_][\w]*)/gm
    ],
    python: [
      /^\s*(?:class|def)\s+([A-Za-z_][\w]*)/gm
    ],
    go: [
      /^\s*type\s+([A-Za-z_][\w]*)\s+struct\b/gm,
      /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)\s*\(/gm
    ],
    rust: [
      /^\s*(?:pub\s+)?(?:struct|enum|trait|fn)\s+([A-Za-z_][\w]*)/gm,
      /^\s*impl\s+([A-Za-z_][\w]*)/gm
    ],
    java: [
      /^\s*(?:public\s+)?(?:class|interface|enum|record)\s+([A-Za-z_][\w]*)/gm,
      /^\s*(?:public|private|protected)\s+(?:static\s+)?[A-Za-z_][\w<>\[\], ?]*\s+([A-Za-z_][\w]*)\s*\(/gm
    ],
    csharp: [
      /^\s*(?:public|internal|private|protected)\s+(?:static\s+)?(?:class|interface|enum|record|struct)\s+([A-Za-z_][\w]*)/gm,
      /^\s*(?:public|internal|private|protected)\s+(?:static\s+)?[A-Za-z_][\w<>\[\], ?]*\s+([A-Za-z_][\w]*)\s*\(/gm
    ]
  };
  const patterns = patternsByLanguage[languageId] ?? [
    /^\s*(?:class|interface|enum|record|struct|trait|type|def|fn|function)\s+([A-Za-z_][\w]*)/gm
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      add(match[1]);
    }
  }
  return names.slice(0, 10);
}

function buildExactModuleReference(createdPath, symbolNames) {
  const baseName = path.basename(createdPath, path.extname(createdPath));
  const ext = path.extname(createdPath).toLowerCase();
  const names = symbolNames.filter(Boolean);
  if (names.length === 0) return null;
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    return `import { ${names.join(', ')} } from './${baseName}';`;
  }
  if (ext === '.py') {
    return `from ${baseName} import ${names.join(', ')}`;
  }
  return null;
}

function buildModuleReferenceExample(createdPath, exportNames) {
  return buildExactModuleReference(createdPath, exportNames) ?? 'update the original file so it references or uses the new module file correctly';
}

function resolveFilepathInfo(fp, options = {}) {
  if (!fp) return { path: '', recoveredToTarget: false, originalPath: '' };
  const originalPath = String(fp);
  let resolved = path.normalize(path.isAbsolute(originalPath) ? originalPath : path.join(wsRoot, originalPath));
  // Case-insensitive correction: if resolved path matches wsRoot case-insensitively but not literally,
  // correct the workspace root prefix (models sometimes hallucinate wrong case on case-sensitive FS)
  if (resolved !== wsRoot && !resolved.startsWith(`${wsRoot}${path.sep}`)) {
    const wsRootLower = wsRoot.toLowerCase();
    const resolvedLower = resolved.toLowerCase();
    if (resolvedLower === wsRootLower || resolvedLower.startsWith(`${wsRootLower}${path.sep}`)) {
      resolved = wsRoot + resolved.slice(wsRoot.length);
    }
  }
  const recoverTarget = options.recoverTarget === true;
  if (!recoverTarget) {
    return { path: resolved, recoveredToTarget: false, originalPath };
  }
  const sameBasename = path.basename(resolved) === path.basename(TARGET_ABS_FILE);
  const sameExtension = path.extname(resolved).toLowerCase() === path.extname(TARGET_ABS_FILE).toLowerCase();
  const shouldRecover = resolved !== TARGET_ABS_FILE && !existsSync(resolved) && sameBasename && sameExtension;
  if (shouldRecover) {
    return { path: TARGET_ABS_FILE, recoveredToTarget: true, originalPath };
  }
  return { path: resolved, recoveredToTarget: false, originalPath };
}

function normalizeRequestTargetIntoWorkspace(targetPath) {
  const normalizedTarget = String(targetPath ?? '').trim().replace(/\\/g, '/');
  if (!normalizedTarget) return '';
  if (path.isAbsolute(normalizedTarget)) return path.normalize(normalizedTarget);
  const trimmedTarget = normalizedTarget
    .replace(/^\.\//, '')
    .replace(/^\.[/\\]/, '')
    .replace(/^[/\\]+/, '');
  return path.normalize(path.join(wsRoot, trimmedTarget));
}

function getExplicitWriteRequestTargets() {
  if (!looksLikeWriteIntent(userPrompt)) return [];
  const seen = new Set();
  const targets = [];
  for (const requestTarget of extractLikelyRequestFileTargets(userPrompt)) {
    const absoluteTarget = normalizeRequestTargetIntoWorkspace(requestTarget);
    if (!absoluteTarget) continue;
    const withinWorkspace = absoluteTarget === wsRoot || absoluteTarget.startsWith(`${wsRoot}${path.sep}`);
    if (!withinWorkspace) continue;
    const comparableTarget = path.normalize(absoluteTarget).replace(/\\/g, '/').toLowerCase();
    if (seen.has(comparableTarget)) continue;
    seen.add(comparableTarget);
    targets.push(absoluteTarget);
  }
  return targets;
}

function targetExistsForCreateRecovery(targetPath) {
  return dryRunFiles.has(targetPath) || existsSync(targetPath);
}

function recoverRequestScopedCreatePath(requestedPath) {
  const explicitTargets = getExplicitWriteRequestTargets();
  if (!requestedPath || explicitTargets.length === 0) return {};

  const requestedAbsolute = resolveFilepath(requestedPath);
  if (!requestedAbsolute) return {};

  const comparableRequested = path.normalize(requestedAbsolute).replace(/\\/g, '/').toLowerCase();
  if (explicitTargets.some(target => path.normalize(target).replace(/\\/g, '/').toLowerCase() === comparableRequested)) {
    return { resolvedPath: requestedAbsolute };
  }

  const requestedBasename = path.basename(requestedAbsolute).toLowerCase();
  const basenameMatches = explicitTargets.filter(target => path.basename(target).toLowerCase() === requestedBasename);
  if (basenameMatches.length === 1) {
    return { resolvedPath: basenameMatches[0], recoveredFrom: String(requestedPath) };
  }

  const requestedExtension = path.extname(requestedAbsolute).toLowerCase();
  if (!requestedExtension) {
    if (explicitTargets.length === 1) {
      return { resolvedPath: explicitTargets[0], recoveredFrom: String(requestedPath) };
    }
    return {};
  }

  const sameExtensionTargets = explicitTargets.filter(target => path.extname(target).toLowerCase() === requestedExtension);
  const missingSameExtensionTargets = sameExtensionTargets.filter(target => !targetExistsForCreateRecovery(target));
  if (missingSameExtensionTargets.length === 1) {
    return { resolvedPath: missingSameExtensionTargets[0], recoveredFrom: String(requestedPath) };
  }
  if (sameExtensionTargets.length === 1) {
    return { resolvedPath: sameExtensionTargets[0], recoveredFrom: String(requestedPath) };
  }

  return {};
}

function findNearestProjectRoot(startPath) {
  const startDir = path.dirname(startPath);
  const markers = ['package.json', 'tsconfig.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'gradlew'];
  let current = startDir;
  while (current.startsWith(wsRoot)) {
    const hasStandardMarker = markers.some(marker => existsSync(path.join(current, marker)));
    const hasDotnetMarker = readdirSafe(current).some(name => name.endsWith('.sln') || name.endsWith('.csproj'));
    if (hasStandardMarker || hasDotnetMarker) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return wsRoot;
}

function pickPackageManager(projectRoot) {
  if (existsSync(path.join(projectRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(projectRoot, 'yarn.lock'))) return 'yarn';
  if (existsSync(path.join(projectRoot, 'bun.lockb')) || existsSync(path.join(projectRoot, 'bun.lock'))) return 'bun';
  return 'npm';
}

function scriptCommand(pm, scriptName) {
  if (pm === 'npm') return `npm run ${scriptName} 2>&1 | head -30`;
  if (pm === 'yarn') return `yarn ${scriptName} 2>&1 | head -30`;
  if (pm === 'pnpm') return `pnpm ${scriptName} 2>&1 | head -30`;
  return `bun run ${scriptName} 2>&1 | head -30`;
}

function isProjectVerificationManifestFile(targetPath) {
  const basename = path.basename(targetPath || '').toLowerCase();
  return basename === 'package.json'
    || basename === 'tsconfig.json'
    || basename === 'pyproject.toml'
    || basename === 'requirements.txt'
    || basename === 'setup.py'
    || basename === 'cargo.toml'
    || basename === 'go.mod'
    || basename === 'pom.xml'
    || basename === 'build.gradle'
    || basename === 'build.gradle.kts'
    || basename === 'gradlew'
    || basename.endsWith('.sln')
    || basename.endsWith('.csproj');
}

function pickVerifyCommandForPath(targetPath) {
  const projectRoot = findNearestProjectRoot(targetPath);
  const latestExt = path.extname(targetPath || '').toLowerCase();
  const hasPythonProjectMarkers = existsSync(path.join(projectRoot, 'pyproject.toml')) || existsSync(path.join(projectRoot, 'requirements.txt')) || existsSync(path.join(projectRoot, 'setup.py'));
  const hasJavaProjectMarkers = existsSync(path.join(projectRoot, 'pom.xml')) || existsSync(path.join(projectRoot, 'build.gradle')) || existsSync(path.join(projectRoot, 'build.gradle.kts'));
  const hasDotnetProjectMarkers = existsSync(projectRoot) && readdirSafe(projectRoot).some(name => name.endsWith('.sln') || name.endsWith('.csproj'));
  const shouldPreferStandaloneSyntaxVerification = (IS_PREFERRED_GREENFIELD_REQUEST && isGreenfieldSourceFilePath(targetPath))
    || (latestExt === '.go' && !existsSync(path.join(projectRoot, 'go.mod')) && !isProjectVerificationManifestFile(targetPath));

  const quotedTargetPath = JSON.stringify(targetPath);
  if (IS_PREFERRED_GREENFIELD_REQUEST && !isGreenfieldSourceFilePath(targetPath) && !isProjectVerificationManifestFile(targetPath)) {
    return null;
  }
  if (shouldPreferStandaloneSyntaxVerification) {
    if (latestExt === '.py') return { command: `python -m py_compile ${quotedTargetPath} 2>&1 | head -30`, projectRoot, stack: 'python-file' };
    if (['.js', '.jsx', '.mjs', '.cjs'].includes(latestExt)) return { command: `node --check ${quotedTargetPath} 2>&1 | head -30`, projectRoot, stack: 'javascript-file' };
    if (['.ts', '.tsx', '.mts', '.cts'].includes(latestExt)) return { command: `npx tsc --pretty false --noEmit ${quotedTargetPath} 2>&1 | head -30`, projectRoot, stack: 'typescript-file' };
    if (latestExt === '.go') return { command: `gofmt -d ${quotedTargetPath} 2>&1 | head -30`, projectRoot, stack: 'go-file' };
  }

  // For .go files always prefer gofmt standalone verification over project-level commands
  // (project root may contain package.json/tsconfig.json from a different stack)
  if (latestExt === '.go') return { command: `gofmt -d ${quotedTargetPath} 2>&1 | head -30`, projectRoot, stack: 'go-file' };

  const packageJsonPath = path.join(projectRoot, 'package.json');
  if (existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      const scripts = pkg?.scripts ?? {};
      const pm = pickPackageManager(projectRoot);
      if (typeof scripts.check === 'string') return { command: scriptCommand(pm, 'check'), projectRoot, stack: 'javascript/typescript' };
      if (typeof scripts.verify === 'string') return { command: scriptCommand(pm, 'verify'), projectRoot, stack: 'javascript/typescript' };
      if (typeof scripts.build === 'string') return { command: scriptCommand(pm, 'build'), projectRoot, stack: 'javascript/typescript' };
      if (typeof scripts.compile === 'string') return { command: scriptCommand(pm, 'compile'), projectRoot, stack: 'javascript/typescript' };
      if (typeof scripts.test === 'string') return { command: scriptCommand(pm, 'test'), projectRoot, stack: 'javascript/typescript' };
    } catch { /* ignore */ }
  }
  if (existsSync(path.join(projectRoot, 'tsconfig.json'))) return { command: 'npx tsc --noEmit 2>&1 | head -30', projectRoot, stack: 'typescript' };
  if (existsSync(path.join(projectRoot, 'Cargo.toml'))) return { command: 'cargo check --quiet 2>&1 | head -30', projectRoot, stack: 'rust' };
  if (existsSync(path.join(projectRoot, 'go.mod'))) return { command: 'go test ./... 2>&1 | head -30', projectRoot, stack: 'go' };
  if (hasPythonProjectMarkers) return { command: 'python -m compileall -q . 2>&1 | head -30', projectRoot, stack: 'python' };
  if (existsSync(path.join(projectRoot, 'pom.xml'))) return { command: 'mvn -q -DskipTests compile 2>&1 | head -30', projectRoot, stack: 'java' };
  if (existsSync(path.join(projectRoot, 'build.gradle')) || existsSync(path.join(projectRoot, 'build.gradle.kts'))) {
    return { command: existsSync(path.join(projectRoot, 'gradlew')) ? './gradlew -q build -x test 2>&1 | head -30' : 'gradle -q build -x test 2>&1 | head -30', projectRoot, stack: 'java/gradle' };
  }
  if (hasDotnetProjectMarkers) return { command: 'dotnet build -nologo 2>&1 | head -30', projectRoot, stack: '.net' };
  if (latestExt === '.py') return { command: `python -m py_compile ${quotedTargetPath} 2>&1 | head -30`, projectRoot, stack: 'python-file' };
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(latestExt)) return { command: `node --check ${quotedTargetPath} 2>&1 | head -30`, projectRoot, stack: 'javascript-file' };
  if (['.ts', '.tsx', '.mts', '.cts'].includes(latestExt)) return { command: `npx tsc --pretty false --noEmit ${quotedTargetPath} 2>&1 | head -30`, projectRoot, stack: 'typescript-file' };
  if (latestExt === '.go') return { command: `gofmt -d ${quotedTargetPath} 2>&1 | head -30`, projectRoot, stack: 'go-file' };
  return null;
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

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
  const textToolSection = MODEL_LIMITS.useTextTools ? `
---

[TOOL FORMAT]

Output tool calls as a single JSON object on its own line:
{"tool": "tool_name", "args": {"param": "value"}}

Available tools:
- create_or_edit_file(filename, content) — Create or overwrite a file
- replace_in_file(filepath, old_text, new_text) — Replace text in existing file
- read_specific_file(filepath) — Read full file contents
- read_file_slice(filepath, startLine, endLine) — Read a line range from a file
- list_workspace_files(directory) — List files/folders in a directory
- execute_terminal_command(command) — Run a shell command (no stdin)
- launch_in_terminal(command) — Open integrated terminal for interactive commands
- delete_file(filepath) — Delete a file
- read_active_file() — Read the currently open file
- project_scan() — Get a recursive tree of the entire workspace
- manul_run_step(step) — Run one browser automation step (DSL or natural language)
- manul_run_goal(goal, title?, context?) — Run multi-step browser automation goal
- manul_scan_page() — Scan page for interactive elements after navigation
- manul_read_page_text() — Read all visible text from the current browser page
- manul_get_state() — Get ManulEngine browser session state
- manul_save_hunt(path, content) — Save a .hunt automation file to disk
- manul_run_hunt(dsl) — Execute a full .hunt DSL document
- manul_run_hunt_file(filePath) — Read and run a .hunt file from disk

Output ONE tool call JSON per response. No prose before the JSON.
` : '';

  if (MODEL_LIMITS.compactMandate) {
    return `[IDENTITY]
You are ManulAI, a local VS Code coding agent with browser automation via ManulEngine.
Workspace root: ${wsRoot}

[RULES]
- Execute the next concrete action. No long plan.
- Prefer exactly ONE tool call per response.
- Read before edit. Prefer read_file_slice for large files.
- Use replace_in_file for small edits and create_or_edit_file for new files.
- For browser tasks: use manul_run_step for single steps, manul_run_goal for multi-step flows.
- After EVERY browser action that changes state add a VERIFY step immediately.
- After automation completes: show .hunt preview and offer to save.
- Do not narrate tool calls.${MODEL_LIMITS.useTextTools ? ' Print exactly one JSON tool object, no prose.' : ' Do not print JSON as text.'}
- If a tool fails, adapt once and continue.
- Finish with one short summary when the task is done.
${textToolSection}`;
  }

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
3. Browser or web automation needed → use manul_* tools (ManulEngine integration)
   Start with: manul_run_step for single DSL steps, manul_run_goal for multi-step flows
   Always call manul_scan_page after NAVIGATE to discover element identifiers
   After EVERY action that changes state → add a VERIFY step immediately (see [MANUL DSL REFERENCE])
   After completing automation → show the reconstructed .hunt preview and offer to save it (see [MANUL SESSION COMPLETION])
4. Code understanding required → read files first with read_file_slice
5. No tools required → respond concisely

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
  - content MUST be the real extracted code, NOT a comment placeholder.
   - "// Code will be inserted here" is FORBIDDEN. Copy the real code.
4. Call replace_in_file on the original file:
   - old_text = the exact extracted block
   - new_text = an import statement for the new file
   - old_text and new_text MUST differ.
5. Read the next slice and repeat until done.

---

[FILE CREATION RULES]

When creating new files from scratch (greenfield generation):

1. Use create_or_edit_file for EACH file — call it immediately with real content.
2. Do NOT describe the file content in text — call create_or_edit_file with the full code.
3. After creating one file, immediately create the next one. Do NOT stop.
4. Use execute_terminal_command for setup (npm init, install, etc.) when needed.
5. Keep going until ALL files for the task are created.

---

[FILE EDITING RULES]

- MUST read file before editing
- MUST use replace_in_file for targeted edits
- MUST apply minimal change only
- FORBIDDEN: full file overwrite, removing code not seen, batch rewrite

---

[TOOL USAGE RULES]

- ALWAYS use native tool calls${MODEL_LIMITS.useTextTools ? '' : '\n- NEVER output raw JSON as a tool call substitute'}
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

[MANUL DSL REFERENCE]

Hunt file structure (flush-left headers, 4-space indented actions):
  @context: <what this automation verifies>
  @title: <short suite name>
  @var: {key} = value

  STEP 1: Description
      NAVIGATE to 'https://url'
      VERIFY that 'Landmark' is present
      ...

  DONE.

Key DSL commands (element names always in single quotes):
  Navigation:
  - NAVIGATE to 'url'
  - SCROLL DOWN
  - SCROLL DOWN inside the 'container'

  Interaction:
  - Click the 'Label' button|link|element
  - DOUBLE CLICK the 'Label'
  - RIGHT CLICK 'Label'
  - Fill 'Field' field with 'Value'
  - Type 'Value' into the 'Field' field
  - Select 'Option' from the 'Dropdown' dropdown
  - Check the checkbox for 'Label'
  - Uncheck the checkbox for 'Label'
  - HOVER over the 'Label'
  - Drag 'Source' and drop it into 'Target'
  - PRESS ENTER / PRESS Escape / PRESS Control+A
  - UPLOAD 'file_path' to 'Input'

  Waits:
  - WAIT 2
  - Wait for 'Element' to be visible|hidden|disappear
  - WAIT FOR RESPONSE "url_pattern"

  Data:
  - EXTRACT the 'Element' into {var}
  - SET {var} = value
  - CALL PYTHON module.function [into {var}]

  VERIFY commands:
  - VERIFY that 'text' is present
  - VERIFY that 'text' is NOT present
  - VERIFY that 'Element' is ENABLED|DISABLED
  - VERIFY that 'Element' is checked|NOT checked
  - VERIFY SOFTLY that 'text' is present
  - Verify 'Field' field has value 'Expected'
  - Verify 'Field' field has text 'Expected'

  Contextual qualifiers:
  - Click the 'Edit' button NEAR 'John Doe'
  - Click the 'Logo' link ON HEADER
  - Click the 'Terms' link ON FOOTER
  - Click the 'Delete' button INSIDE 'Actions' row with 'John'

VERIFY after every action — mandatory:
  NAVIGATE               → VERIFY that '<landmark>' is present
  Fill / Type            → Verify '<Field>' field has value '<entered value>'
  Click → new page       → VERIFY that '<landmark on new page>' is present
  Click → state change   → VERIFY that '<new state text>' is present
  Select dropdown        → VERIFY that '<selected option>' is present
  Check / Uncheck        → VERIFY that '<label>' is checked|NOT checked

---

[MANUL SESSION COMPLETION]

After completing ANY automation task using manul_* tools:
1. Reconstruct the full .hunt DSL from all steps that were executed.
2. Show the hunt file as a fenced code block (preview) in your response.
3. Ask the user: "Should I save this as a hunt file so it can be replayed later?"
4. If the user agrees → call manul_save_hunt with path 'tests/<descriptive_name>.hunt'.

---

[OUTPUT RULES]

- Plan: short numbered list, then immediately start executing
- During execution: no narration, only tool calls
- After completion: one-line summary
${textToolSection}`;
}

function buildPlannerMandate() {
  const textToolSection = MODEL_LIMITS.useTextTools ? `
---

[TOOL FORMAT]

Output tool calls as a single JSON object on its own line:
{"tool": "tool_name", "args": {"param": "value"}}

Available tools:
- create_or_edit_file(filename, content) — Create or overwrite a file
- replace_in_file(filepath, old_text, new_text) — Replace text in existing file
- read_specific_file(filepath) — Read full file contents
- read_file_slice(filepath, startLine, endLine) — Read a line range from a file
- list_workspace_files(directory) — List files/folders in a directory
- execute_terminal_command(command) — Run a shell command (no stdin)
- launch_in_terminal(command) — Open integrated terminal for interactive commands
- delete_file(filepath) — Delete a file
- read_active_file() — Read the currently open file
- project_scan() — Get a recursive tree of the entire workspace
- manul_run_step(step) — Run one browser automation step (DSL or natural language)
- manul_run_goal(goal, title?, context?) — Run multi-step browser automation goal
- manul_scan_page() — Scan page for interactive elements after navigation
- manul_read_page_text() — Read all visible text from the current browser page
- manul_get_state() — Get ManulEngine browser session state
- manul_save_hunt(path, content) — Save a .hunt automation file to disk
- manul_run_hunt(dsl) — Execute a full .hunt DSL document
- manul_run_hunt_file(filePath) — Read and run a .hunt file from disk

Output ONE tool call JSON per response. No prose before the JSON.
` : '';

  if (MODEL_LIMITS.compactMandate) {
    return `[IDENTITY]
You are ManulAI, a local VS Code coding agent with browser automation via ManulEngine in Planner mode.
Workspace root: ${wsRoot}

[RULES]
- If the user asks a direct question, answer briefly in text.
- For edit or file tasks: do exactly ONE small tool call per response.
- Prefer read_file_slice over large reads.
- For browser automation: use manul_* tools. After every action that changes state add a VERIFY step. After automation: show .hunt preview and offer to save.
- Keep responses short. No multi-step plans. No JSON in text.
- Finish with a one-line summary when done.
${textToolSection}`;
  }

  return `[IDENTITY]
You are ManulAI, a local VS Code coding agent with browser automation via ManulEngine in Planner mode.
Workspace root: ${wsRoot}
All file paths are relative to the workspace root unless absolute.

[RULES]
- If the user asks a question, explains a concept, or requests information — answer directly in text. No tool calls needed.
- For tasks that require code changes or file operations: execute ONE tool call per response. No multi-step plans.
- After each tool result you receive, decide the next single action.
- Use file tools for reads/writes, execute_terminal_command for shell.
- For browser or web automation: use manul_* tools. After EVERY action that changes state add a VERIFY step. After completing automation show the reconstructed .hunt preview and offer to save it.
- Keep text output minimal between tool calls.
- NEVER output raw JSON as a substitute for a tool call.
- File contents are UNKNOWN until read. Never assume. Always verify.
- Task is complete when all required changes are done. Output a one-line summary.

[MANUL DSL REFERENCE]
Hunt file structure (flush-left headers, 4-space indented actions):
  @context: <description>  @title: <name>  STEP 1: Description      NAVIGATE to 'url'      VERIFY that 'Landmark' is present  DONE.

Key commands: NAVIGATE to 'url' | SCROLL DOWN [inside 'container'] | Click the 'L' button|link|element | DOUBLE CLICK 'L' | RIGHT CLICK 'L' | Fill 'F' field with 'V' | Type 'V' into the 'F' field | Select 'O' from the 'D' dropdown | Check/Uncheck the checkbox for 'L' | HOVER over the 'L' | Drag 'S' and drop it into 'T' | PRESS ENTER|Escape|Key | WAIT N | Wait for 'E' to be visible|hidden|disappear | WAIT FOR RESPONSE "pattern" | EXTRACT the 'E' into {v} | SET {v} = value | CALL PYTHON module.fn [into {v}]

VERIFY commands: VERIFY that 'text' is present|NOT present|ENABLED|DISABLED|checked|NOT checked | VERIFY SOFTLY that 'text' is present | Verify 'F' field has value 'V' | Verify 'F' field has text 'T'

Contextual qualifiers: NEAR 'anchor' | ON HEADER | ON FOOTER | INSIDE 'container' row with 'text'

VERIFY after every action:
  NAVIGATE → VERIFY that '<landmark>' is present
  Fill/Type → Verify '<Field>' field has value '<value>'
  Click → new page → VERIFY that '<landmark>' is present
  Click → state change → VERIFY that '<new state>' is present

[MANUL SESSION COMPLETION]
After completing any automation with manul_* tools: (1) reconstruct the full .hunt DSL from all executed steps, (2) show it as a fenced code block preview, (3) ask "Should I save this as a hunt file?", (4) if yes → call manul_save_hunt with 'tests/<name>.hunt'.
${textToolSection}`;
}

// ─── Tool definitions ────────────────────────────────────────────────────────
function getToolDefinitions() {
  const allTools = [
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
        description: 'Execute a shell command in the workspace root. No stdin — do not run interactive programs.',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'launch_in_terminal',
        description: 'Open an interactive program in a visible terminal. Use for programs that need user input (games, REPLs, interactive scripts). Returns immediately.',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'project_scan',
        description: 'Build a structured project summary with key files, entry points, package manager, project type hints, and important modules.',
        parameters: {
          type: 'object',
          properties: {},
          required: []
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_workspace_notes',
        description: 'Read persistent notes about this project from .manulai/notes.md.',
        parameters: {
          type: 'object',
          properties: {},
          required: []
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'write_workspace_notes',
        description: 'Write persistent notes about this project to .manulai/notes.md.',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            mode: { type: 'string' }
          },
          required: ['content', 'mode']
        }
      }
    }
  ];

  if (!MODEL_LIMITS.toolNames) {
    return allTools;
  }

  const allowed = new Set(MODEL_LIMITS.toolNames);
  return allTools.filter(tool => allowed.has(tool.function.name));
}

// ─── Tool execution ──────────────────────────────────────────────────────────
function resolveFilepath(fp) {
  return resolveFilepathInfo(fp).path;
}

function analyzeReplaceMiss(currentContent, attemptedOldText, filepath) {
  const currentLines = currentContent.replace(/\r\n/g, '\n').split('\n');
  const attemptedLines = attemptedOldText.replace(/\r\n/g, '\n').split('\n');
  const anchorCandidates = attemptedLines
    .map(line => line.trim())
    .filter(line => line.length >= 8);

  let anchorIndex = -1;
  for (const candidate of anchorCandidates) {
    anchorIndex = currentLines.findIndex(line => line.includes(candidate));
    if (anchorIndex >= 0) break;
  }

  const attemptedNonEmptyLineCount = attemptedLines.filter(line => line.trim().length > 0).length;
  const contextSpan = Math.max(28, attemptedNonEmptyLineCount + 16);
  const suggestedSlice = anchorIndex >= 0
    ? {
        filepath,
        startLine: Math.max(1, anchorIndex + 1 - 4),
        endLine: Math.min(currentLines.length, Math.max(1, anchorIndex + 1 - 4) + contextSpan - 1)
      }
    : undefined;

  return {
    neverPresentInTarget: anchorIndex < 0,
    suggestedSlice
  };
}

function validateGeneratedModuleContent(filepath, content) {
  const extension = path.extname(filepath).toLowerCase();
  const normalized = content.replace(/\r\n/g, '\n');
  const nonEmptyLines = normalized.split('\n').map(line => line.trim()).filter(Boolean);
  const codeLines = nonEmptyLines.filter(line => !/^(?:\/\/|\/\*|\*|#)/.test(line));

  if (extension === '.go') {
    if (/\bexport\s+(?:type|interface|class|enum|const|function)\b/.test(normalized)) {
      return 'Generated Go code is invalid: Go declarations must not use the export keyword. Use forms like "type Name interface { ... }" or "func Name(...)".';
    }
    if (/^\s*interface\s+[A-Za-z_][\w]*/m.test(normalized)) {
      return 'Generated Go code is invalid: interfaces must be declared as "type Name interface { ... }", not "interface Name".';
    }
    if (/\bclass\s+[A-Za-z_][\w]*/.test(normalized)) {
      return 'Generated Go code is invalid: Go does not have class declarations.';
    }
    if (!nonEmptyLines.some(line => /^package\s+[A-Za-z_][\w]*/.test(line))) {
      return 'Generated Go module content is incomplete: extracted .go files must start with a package declaration.';
    }
    const hasGoDefinition = codeLines.some(line => /^(?:package\s+\w+|import\s+|type\s+\w+\s+(?:struct|interface)\b|func\s+(?:\([^)]*\)\s*)?\w+\s*\(|const\s+\w+|var\s+\w+)/.test(line));
    if (!hasGoDefinition) {
      return 'Generated Go module content is invalid: the file must contain real Go declarations, not placeholder or cross-language syntax.';
    }
  }

  if (extension === '.rs') {
    if (/\bexport\s+(?:type|interface|class|enum|const|function)\b/.test(normalized) || /\binterface\s+[A-Za-z_][\w]*/.test(normalized) || /\bclass\s+[A-Za-z_][\w]*/.test(normalized)) {
      return 'Generated Rust code is invalid: the file contains non-Rust class/interface/export syntax.';
    }
    if (/^\s*(?:pub\s+)?mod\s+[A-Za-z_][\w]*\s*\{\s*\}\s*$/m.test(normalized) && codeLines.length <= 2) {
      return 'Generated Rust module content is invalid: empty mod wrappers are not a valid extraction.';
    }
    const hasOnlyUseOrModLines = codeLines.length > 0 && codeLines.every(line => /^(?:pub\s+)?use\b/.test(line) || /^(?:pub\s+)?mod\b/.test(line));
    if (hasOnlyUseOrModLines) {
      return 'Generated Rust module content is invalid: the new file must contain real Rust items, not only use/mod re-exports.';
    }
  }

  return null;
}

async function executeTool(name, args) {
  switch (name) {
    case 'list_workspace_files': {
      const dir = resolveFilepath(args.directory ?? '') || wsRoot;
      const maxDepth = typeof args.maxDepth === 'number' ? Math.min(Math.max(1, args.maxDepth), 8) : 4;
      const IGNORED_DIRS = new Set([
        'node_modules', '.git', '.hg', '.svn', 'dist', 'out', 'build', '.next', '.nuxt',
        '__pycache__', '.cache', '.turbo', '.parcel-cache', 'coverage', '.nyc_output',
        '.manulai', 'logs', '.venv', 'venv', '.tox'
      ]);
      const FILE_CAP = 400;
      let fileCount = 0;

      const readDirRec = async (dirPath, depth) => {
        if (depth > maxDepth || fileCount >= FILE_CAP) { return []; }
        let entries;
        try {
          const { readdirSync } = await import('fs');
          entries = readdirSync(dirPath, { withFileTypes: true });
        } catch { return []; }
        entries.sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) { return a.isDirectory() ? -1 : 1; }
          return a.name.localeCompare(b.name);
        });
        const result = [];
        for (const ent of entries) {
          if (fileCount >= FILE_CAP) { break; }
          if (ent.isDirectory()) {
            if (IGNORED_DIRS.has(ent.name) || ent.name.startsWith('.')) { continue; }
            const children = await readDirRec(path.join(dirPath, ent.name), depth + 1);
            result.push({ name: ent.name, type: 'directory', children });
          } else {
            fileCount++;
            result.push({ name: ent.name, type: 'file' });
          }
        }
        return result;
      };

      try {
        const tree = await readDirRec(dir, 1);
        return JSON.stringify({ path: dir, tree, ...(fileCount >= FILE_CAP ? { note: `Results capped at ${FILE_CAP} files.` } : {}) });
      } catch (e) { return JSON.stringify({ error: e.message }); }
    }

    case 'project_scan': {
      try {
        const readTextIfExists = rel => {
          const fp = path.join(wsRoot, rel);
          return existsSync(fp) ? readFileSync(fp, 'utf8') : undefined;
        };
        const extractTomlAssignments = (text, sectionNames) => {
          const sections = new Set(sectionNames.map(name => name.toLowerCase()));
          const results = [];
          let activeSection = '';
          for (const rawLine of text.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line || line.startsWith('#')) continue;
            const sectionMatch = line.match(/^\[(.+?)\]$/);
            if (sectionMatch) {
              activeSection = sectionMatch[1].trim().toLowerCase();
              continue;
            }
            if (!sections.has(activeSection)) continue;
            const assignmentMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*["']?([^"']+)["']?$/);
            if (assignmentMatch) {
              results.push({ key: assignmentMatch[1], value: assignmentMatch[2].trim() });
            }
          }
          return results;
        };
        const notes = [];
        const topLevel = existsSync(wsRoot) ? (await import('fs')).readdirSync(wsRoot, { withFileTypes: true }) : [];
        const topLevelNames = new Set(topLevel.map(ent => ent.name));
        const keyFiles = ['package.json', 'tsconfig.json', 'README.md', 'README-dev.md', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'requirements.txt', 'Gemfile', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json', 'Package.swift', 'CMakeLists.txt']
          .filter(name => topLevelNames.has(name));
        const languages = [];
        const frameworkHints = [];
        let packageManager = 'unknown';
        if (topLevelNames.has('pnpm-lock.yaml')) { packageManager = 'pnpm'; languages.push('javascript', 'typescript'); }
        else if (topLevelNames.has('yarn.lock')) { packageManager = 'yarn'; languages.push('javascript', 'typescript'); }
        else if (topLevelNames.has('package-lock.json')) { packageManager = 'npm'; languages.push('javascript', 'typescript'); }
        else if (topLevelNames.has('bun.lockb') || topLevelNames.has('bun.lock')) { packageManager = 'bun'; languages.push('javascript', 'typescript'); }
        else if (topLevelNames.has('Cargo.toml')) { packageManager = 'cargo'; languages.push('rust'); }
        else if (topLevelNames.has('go.mod')) { packageManager = 'go'; languages.push('go'); }
        else if (topLevelNames.has('pyproject.toml') || topLevelNames.has('requirements.txt')) { packageManager = 'python'; languages.push('python'); }
        else if (topLevelNames.has('composer.json')) { packageManager = 'composer'; languages.push('php'); }
        else if (topLevelNames.has('Gemfile')) { packageManager = 'bundler'; languages.push('ruby'); }
        else if (topLevelNames.has('pom.xml')) { packageManager = 'maven'; languages.push('java'); }
        else if (topLevelNames.has('build.gradle') || topLevelNames.has('build.gradle.kts')) { packageManager = 'gradle'; languages.push('java', 'kotlin'); }
        else if (topLevelNames.has('Package.swift')) { packageManager = 'swiftpm'; languages.push('swift'); }

        const entryPoints = [];
        const importantModules = [];
        const projectTypes = [];
        if (topLevelNames.has('package.json')) {
          try {
            const pkg = JSON.parse(readFileSync(path.join(wsRoot, 'package.json'), 'utf8'));
            const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
            const depNames = Object.keys(deps);
            if (typeof pkg.main === 'string') entryPoints.push(pkg.main);
            if (typeof pkg.module === 'string') entryPoints.push(pkg.module);
            if (typeof pkg.browser === 'string') entryPoints.push(pkg.browser);
            if (typeof pkg.types === 'string') { importantModules.push(pkg.types); languages.push('typescript'); }
            if (pkg.engines?.vscode) projectTypes.push('vscode-extension');
            if (depNames.some(name => ['react', 'next', 'vite', 'vue', 'svelte', 'angular'].includes(name))) projectTypes.push('webapp');
            if (depNames.some(name => ['express', 'fastify', 'koa', 'nest', '@nestjs/core'].includes(name))) projectTypes.push('backend-service');
            if (depNames.includes('react')) frameworkHints.push('react');
            if (depNames.includes('next')) frameworkHints.push('next');
            if (depNames.includes('@nestjs/core')) frameworkHints.push('nestjs');
            if (depNames.includes('vue')) frameworkHints.push('vue');
            if (depNames.includes('svelte')) frameworkHints.push('svelte');
            if (depNames.includes('angular') || depNames.includes('@angular/core')) frameworkHints.push('angular');
            if (pkg.scripts && typeof pkg.scripts === 'object') notes.push(`package.json scripts: ${Object.keys(pkg.scripts).slice(0, 8).join(', ')}`);
          } catch {
            notes.push('package.json exists but could not be parsed');
          }
        }
        if (topLevelNames.has('pyproject.toml')) projectTypes.push('python-project');
        if (topLevelNames.has('Cargo.toml')) projectTypes.push('rust-project');
        if (topLevelNames.has('go.mod')) projectTypes.push('go-project');
        if (topLevelNames.has('pom.xml') || topLevelNames.has('build.gradle') || topLevelNames.has('build.gradle.kts')) projectTypes.push('jvm-project');
        if (topLevelNames.has('composer.json')) projectTypes.push('php-project');
        if (topLevelNames.has('Gemfile')) projectTypes.push('ruby-project');
        if (topLevelNames.has('Package.swift')) projectTypes.push('swift-project');
        if (topLevelNames.has('CMakeLists.txt') || topLevelNames.has('meson.build')) { projectTypes.push('native-project'); languages.push('c/c++'); }
        if ([...topLevelNames].some(name => name.endsWith('.sln') || name.endsWith('.csproj'))) { projectTypes.push('.net-project'); languages.push('c#'); }

        const pyprojectText = readTextIfExists('pyproject.toml');
        if (pyprojectText) {
          if (/\bdjango\b/i.test(pyprojectText)) frameworkHints.push('django');
          if (/\bfastapi\b/i.test(pyprojectText)) frameworkHints.push('fastapi');
          if (/\bflask\b/i.test(pyprojectText)) frameworkHints.push('flask');
          const scriptAssignments = extractTomlAssignments(pyprojectText, ['project.scripts', 'tool.poetry.scripts']);
          for (const item of scriptAssignments) entryPoints.push(`${item.key} -> ${item.value}`);
          const packageNameMatch = pyprojectText.match(/^[ \t]*name\s*=\s*["']([^"']+)["']/m);
          if (packageNameMatch) notes.push(`pyproject package: ${packageNameMatch[1]}`);
        }

        const requirementsText = readTextIfExists('requirements.txt');
        if (requirementsText) {
          const requirementNames = requirementsText.split(/\r?\n/).map(line => line.replace(/#.*/, '').trim()).filter(Boolean).map(line => line.split(/[<>=!~\[]/, 1)[0].trim().toLowerCase());
          if (requirementNames.includes('django')) frameworkHints.push('django');
          if (requirementNames.includes('fastapi')) frameworkHints.push('fastapi');
          if (requirementNames.includes('flask')) frameworkHints.push('flask');
        }

        const pomFiles = (await import('fs')).readdirSync(wsRoot, { withFileTypes: true }).flatMap(ent => ent.isFile() && ent.name === 'pom.xml' ? [path.join(wsRoot, ent.name)] : []);
        for (const pomFile of pomFiles) {
          const pomText = readFileSync(pomFile, 'utf8');
          if (/spring-boot|org\.springframework/i.test(pomText)) frameworkHints.push('spring');
          for (const match of pomText.matchAll(/<(?:start-class|mainClass)>\s*([^<]+)\s*<\//g)) entryPoints.push(match[1].trim());
          for (const match of pomText.matchAll(/<module>\s*([^<]+)\s*<\/module>/g)) importantModules.push(`module:${match[1].trim()}`);
        }

        for (const gradleName of ['build.gradle', 'build.gradle.kts']) {
          const gradleText = readTextIfExists(gradleName);
          if (!gradleText) continue;
          if (/spring-boot|org\.springframework/i.test(gradleText)) frameworkHints.push('spring');
          for (const match of gradleText.matchAll(/mainClass(?:Name)?(?:\.set)?\s*[=\(]\s*["']([^"']+)["']/g)) entryPoints.push(match[1].trim());
        }

        const solutionFiles = topLevel.filter(ent => ent.isFile() && (ent.name.endsWith('.csproj') || ent.name.endsWith('.sln'))).map(ent => path.join(wsRoot, ent.name));
        for (const solutionFile of solutionFiles) {
          const solutionText = readFileSync(solutionFile, 'utf8');
          if (/Microsoft\.NET\.Sdk\.Web|AspNetCore/i.test(solutionText)) frameworkHints.push('aspnet');
          if (solutionFile.endsWith('.csproj')) importantModules.push(path.basename(solutionFile));
        }

        const cargoText = readTextIfExists('Cargo.toml');
        if (cargoText) {
          const packageNameMatch = cargoText.match(/^name\s*=\s*["']([^"']+)["']/m);
          if (packageNameMatch) notes.push(`cargo package: ${packageNameMatch[1]}`);
          for (const match of cargoText.matchAll(/^path\s*=\s*["']([^"']+)["']/gm)) entryPoints.push(match[1].trim());
          const workspaceMembersMatch = cargoText.match(/members\s*=\s*\[([\s\S]*?)\]/m);
          if (workspaceMembersMatch) {
            for (const member of workspaceMembersMatch[1].matchAll(/["']([^"']+)["']/g)) importantModules.push(`crate:${member[1].trim()}`);
          }
          if (/\baxum\b/i.test(cargoText)) frameworkHints.push('axum');
          if (/\bactix-web\b/i.test(cargoText)) frameworkHints.push('actix-web');
          if (/\brocket\b/i.test(cargoText)) frameworkHints.push('rocket');
        }

        const goModText = readTextIfExists('go.mod');
        if (goModText) {
          const moduleMatch = goModText.match(/^module\s+(.+)$/m);
          if (moduleMatch) {
            notes.push(`go module: ${moduleMatch[1].trim()}`);
            importantModules.push(moduleMatch[1].trim());
          }
          if (/github\.com\/gin-gonic\/gin/i.test(goModText)) frameworkHints.push('gin');
          if (/github\.com\/gofiber\/fiber/i.test(goModText)) frameworkHints.push('fiber');
          if (/github\.com\/labstack\/echo/i.test(goModText)) frameworkHints.push('echo');
          if (/github\.com\/go-chi\/chi/i.test(goModText)) frameworkHints.push('chi');
        }

        for (const candidate of ['src/extension.ts', 'src/extension.js', 'src/index.ts', 'src/index.js', 'src/main.ts', 'src/main.js', 'src/App.tsx', 'src/app.ts', 'app.py', 'main.py', 'manage.py', 'wsgi.py', 'asgi.py', 'server.ts', 'server.js', 'main.go', 'cmd/main.go', 'src/main.rs', 'main.rs', 'src/main/java/Main.java', 'src/main/kotlin/Main.kt', 'Program.cs', 'src/Program.cs', 'index.php', 'public/index.php', 'config/routes.rb', 'main.swift', 'Sources/main.swift', 'src/main.c', 'src/main.cpp']) {
          if (existsSync(path.join(wsRoot, candidate))) entryPoints.push(candidate);
        }
        for (const ent of topLevel) {
          if (ent.isDirectory() && !ent.name.startsWith('.') && !['node_modules', 'dist', 'build', 'out', '.manulai'].includes(ent.name)) {
            importantModules.push(`${ent.name}/`);
          }
        }
        const srcDir = path.join(wsRoot, 'src');
        if (existsSync(srcDir)) {
          for (const ent of (await import('fs')).readdirSync(srcDir, { withFileTypes: true }).slice(0, 12)) {
            importantModules.push(ent.isDirectory() ? `src/${ent.name}/` : `src/${ent.name}`);
            const lower = ent.name.toLowerCase();
            if (lower.endsWith('.py')) languages.push('python');
            if (lower.endsWith('.go')) languages.push('go');
            if (lower.endsWith('.rs')) languages.push('rust');
            if (lower.endsWith('.java')) languages.push('java');
            if (lower.endsWith('.kt')) languages.push('kotlin');
            if (lower.endsWith('.cs')) languages.push('c#');
            if (lower.endsWith('.php')) languages.push('php');
            if (lower.endsWith('.rb')) languages.push('ruby');
            if (lower.endsWith('.swift')) languages.push('swift');
            if (lower.endsWith('.c') || lower.endsWith('.cpp') || lower.endsWith('.h') || lower.endsWith('.hpp')) languages.push('c/c++');
            if (lower.endsWith('.ts') || lower.endsWith('.tsx')) languages.push('typescript');
            if (lower.endsWith('.js') || lower.endsWith('.jsx')) languages.push('javascript');
          }
        }
        return JSON.stringify({
          workspaceRoot: wsRoot,
          packageManager,
          languages: [...new Set(languages)],
          frameworkHints: [...new Set(frameworkHints)],
          projectTypes: [...new Set(projectTypes)],
          keyFiles,
          entryPoints: [...new Set(entryPoints)],
          importantModules: [...new Set(importantModules)].slice(0, 20),
          notes,
          summary: [
            languages.length ? `languages: ${[...new Set(languages)].join(', ')}` : '',
            frameworkHints.length ? `frameworks: ${[...new Set(frameworkHints)].join(', ')}` : '',
            projectTypes.length ? `project type hints: ${[...new Set(projectTypes)].join(', ')}` : '',
            packageManager !== 'unknown' ? `package manager: ${packageManager}` : '',
            entryPoints.length ? `entry points: ${[...new Set(entryPoints)].slice(0, 8).join(', ')}` : '',
            importantModules.length ? `important modules: ${[...new Set(importantModules)].slice(0, 12).join(', ')}` : ''
          ].filter(Boolean).join(' | ')
        });
      } catch (e) { return JSON.stringify({ error: e.message }); }
    }

    case 'read_workspace_notes': {
      try {
        const fp = path.join(wsRoot, '.manulai', 'notes.md');
        const content = existsSync(fp) ? readFileSync(fp, 'utf8') : '(no notes yet — use write_workspace_notes to save notes about this project)';
        return JSON.stringify({ content });
      } catch (e) { return JSON.stringify({ error: e.message }); }
    }

    case 'write_workspace_notes': {
      try {
        const dir = path.join(wsRoot, '.manulai');
        mkdirSync(dir, { recursive: true });
        const fp = path.join(dir, 'notes.md');
        const mode = args.mode === 'overwrite' ? 'overwrite' : 'append';
        const existing = existsSync(fp) ? readFileSync(fp, 'utf8') : '';
        const content = mode === 'append' && existing ? `${existing.trimEnd()}\n\n${String(args.content ?? '')}` : String(args.content ?? '');
        writeFileSync(fp, content, 'utf8');
        return JSON.stringify({ success: true, note: 'Notes saved to .manulai/notes.md' });
      } catch (e) { return JSON.stringify({ error: e.message }); }
    }

    case 'read_file_slice': {
      const pathInfo = resolveFilepathInfo(args.filepath ?? args.filename, { recoverTarget: true });
      const fp = pathInfo.path;
      try {
        // In DRY_RUN mode, serve from cache if file was written in this session
        const rawContent = dryRunFiles.has(fp)
          ? dryRunFiles.get(fp)
          : readFileSync(fp, 'utf8');
        const lines = rawContent.split('\n');
        const rawStart = args.startLine === undefined || args.startLine === null || args.startLine === '' ? 1 : Number(args.startLine);
        const rawEnd = args.endLine === undefined || args.endLine === null || args.endLine === '' ? lines.length : Number(args.endLine);
        if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) {
          return JSON.stringify({ error: 'startLine and endLine must be numbers.' });
        }
        const start = Math.max(1, Math.floor(rawStart));
        const requestedEnd = Math.max(1, Math.floor(rawEnd));
        if (requestedEnd < start) {
          return JSON.stringify({ error: 'endLine must be greater than or equal to startLine.' });
        }
        const end = Math.min(lines.length, requestedEnd);
        return JSON.stringify({
          path: fp, languageId: detectLanguageId(fp),
          startLine: start, endLine: end,
          totalLines: lines.length,
          content: lines.slice(start - 1, end).join('\n'),
          ...(pathInfo.recoveredToTarget ? { note: `Recovered requested path ${pathInfo.originalPath} to exact target ${TARGET_FILE}. Use ${TARGET_FILE} for subsequent read and replace calls.` } : {})
        });
      } catch (e) { return JSON.stringify({ error: e.message }); }
    }

    case 'read_specific_file': {
      const pathInfo = resolveFilepathInfo(args.filepath ?? args.filename, { recoverTarget: true });
      const fp = pathInfo.path;
      try {
        // In DRY_RUN mode, serve from cache if file was written in this session
        const rawContent = dryRunFiles.has(fp)
          ? dryRunFiles.get(fp)
          : readFileSync(fp, 'utf8');
        const lines = rawContent.split('\n');
        const capped = lines.length > 200 ? lines.slice(0, 200) : lines;
        const result = {
          path: fp, languageId: detectLanguageId(fp),
          startLine: 1, endLine: capped.length, totalLines: lines.length,
          content: capped.join('\n')
        };
        if (pathInfo.recoveredToTarget) {
          result.note = `Recovered requested path ${pathInfo.originalPath} to exact target ${TARGET_FILE}. Use ${TARGET_FILE} for subsequent read and replace calls.`;
        }
        if (lines.length > 200) {
          result.warning = `File has ${lines.length} lines; only first 200 shown. Use read_file_slice for specific sections.`;
        }
        return JSON.stringify(result);
      } catch (e) { return JSON.stringify({ error: e.message }); }
    }

    case 'create_or_edit_file': {
      const rawPathArg = args.filename ?? args.filepath ?? '';
      // If model omits filename/filepath but a single known target exists, fall back to it
      const recoveredCreateTarget = recoverRequestScopedCreatePath(
        rawPathArg || (TARGET_ABS_FILE && existsSync(TARGET_ABS_FILE) ? TARGET_ABS_FILE : rawPathArg)
      );
      const fp = recoveredCreateTarget.resolvedPath ?? resolveFilepath(
        rawPathArg || (TARGET_ABS_FILE && existsSync(TARGET_ABS_FILE) ? TARGET_ABS_FILE : rawPathArg)
      );
      let content = String(args.content ?? '');
      if (!fp) return JSON.stringify({ error: 'filename is required.' });
      const withinWorkspace = fp === wsRoot || fp.startsWith(`${wsRoot}${path.sep}`);
      if (!withinWorkspace) {
        return JSON.stringify({
          error: `Refusing to write outside the workspace: ${fp}. Use a path under ${wsRoot}.`
        });
      }
      const targetDirAbs = path.normalize(path.join(wsRoot, TARGET_DIR));
      const isUnderTargetDir = fp.startsWith(`${targetDirAbs}${path.sep}`);
      const isTargetLikeCodeFile = path.extname(fp).toLowerCase() === TARGET_EXTENSION.toLowerCase();
      if (IS_SPLIT_TASK && isTargetLikeCodeFile && !isUnderTargetDir) {
        return JSON.stringify({
          error: `For this split flow, create the extracted module under ${TARGET_DIR}, not at ${fp}. Use an exact sibling or child path beneath ${TARGET_DIR}.`
        });
      }

      // Guard: if overwriting a large existing file with much smaller content, force replace_in_file
      if (existsSync(fp)) {
        try {
          const existing = readFileSync(fp, 'utf8');
          if (existing.length > content.length * 3 && existing.split('\n').length > 50) {
            return JSON.stringify({
              error: `File already exists and is ${existing.split('\n').length} lines long. ` +
                `Do NOT overwrite it with create_or_edit_file — use replace_in_file instead. ` +
                `Read the section you want to extract with read_file_slice, create a NEW file for the extracted code, ` +
                `then use replace_in_file on the original to replace that block with the appropriate module reference or equivalent update.`
            });
          }
        } catch { /* file unreadable — let it proceed */ }
      }

      const nonEmptyLines = content.replace(/\r\n/g, '\n').split('\n').map(l => l.trim()).filter(Boolean);
      const isCodeLikeTarget = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|cs|php|rb|swift|c|cpp|h|hpp)$/i.test(fp);
      const invalidGeneratedModuleContent = validateGeneratedModuleContent(fp, content);
      if (invalidGeneratedModuleContent) {
        return JSON.stringify({ error: invalidGeneratedModuleContent });
      }
      const looksLikePlaceholder = nonEmptyLines.length > 0 && nonEmptyLines.every(l =>
        /^(?:\/\/|#|\/\*|\*|<!--)?\s*(?:code will be inserted here|todo|tbd|placeholder|stub|coming soon|implement me|fill me in)/i.test(l));
      // Placeholder guard should apply only to split/code extraction flows, not to markdown/text creation.
      if (isCodeLikeTarget && (IS_SPLIT_TASK || looksLikePlaceholder)) {
        const codeLike = nonEmptyLines.filter(l =>
          !/^(?:\/\/|\/\*|\*|#)/.test(l) &&
          (/(?:^|\s)(?:export|import|const|let|var|function|class|interface|type|enum|async|return)\b/.test(l) || /[{}();=]/.test(l))
        );
        if (codeLike.length === 0) {
          return JSON.stringify({
            error: 'Content is a placeholder or has no actual code — do NOT write placeholder comments. ' +
              'Copy the exact code blocks you want to extract directly into this new file. ' +
              'Then call replace_in_file on the original file to replace that extracted block with the appropriate module reference or equivalent update.'
          });
        }
      }

      const insufficientGreenfieldContent = detectInsufficientGreenfieldCreateContent(fp, content);
      if (insufficientGreenfieldContent) {
        return JSON.stringify({ error: insufficientGreenfieldContent });
      }

      // Import-shell guard: reject files whose only content is import / re-export lines (no actual definitions)
      const nonCommentCodeLines = nonEmptyLines.filter(l => !/^(?:\/\/|\/\*|\*|#)/.test(l));
      const allAreImports = nonCommentCodeLines.length > 0 &&
        nonCommentCodeLines.every(l =>
          /^\s*import\s/.test(l) || /^\s*export\s+(?:type\s+)?\{/.test(l) || /^\s*export\s+\*/.test(l));
      if (allAreImports) {
        return JSON.stringify({
          error: 'Content contains only import or re-export statements with no actual definitions. ' +
            'The new file must contain the ACTUAL definitions, implementations, or declarations you are extracting. ' +
            'Use read_file_slice to read the source section, then copy the exact definition blocks into this new file.'
        });
      }

      // Auto-export fix: add 'export' to interface/type/class/enum declarations missing it
      const autoExportEligibleExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
      if (autoExportEligibleExtensions.has(path.extname(fp).toLowerCase()) && !/\bexport\b/.test(content)) {
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
        return JSON.stringify({
          path: fp,
          bytesWritten: content.length,
          preview: content.substring(0, 80),
          dryRun: true,
          ...(recoveredCreateTarget.recoveredFrom ? { note: `Recovered requested path ${recoveredCreateTarget.recoveredFrom} to exact target ${fp}. Use this exact target path for subsequent reads and edits.` } : {})
        });
      }
      try {
        mkdirSync(path.dirname(fp), { recursive: true });
        writeFileSync(fp, content, 'utf8');
      } catch (writeErr) {
        return JSON.stringify({ error: `Failed to write file: ${writeErr.message}` });
      }
      return JSON.stringify({
        path: fp,
        bytesWritten: content.length,
        preview: content.substring(0, 80),
        ...(recoveredCreateTarget.recoveredFrom ? { note: `Recovered requested path ${recoveredCreateTarget.recoveredFrom} to exact target ${fp}. Use this exact target path for subsequent reads and edits.` } : {})
      });
    }

    case 'replace_in_file': {
      const pathInfo = resolveFilepathInfo(args.filepath ?? '', { recoverTarget: true });
      const fp = pathInfo.path;
      const oldText = String(args.old_text ?? '');
      const newText = String(args.new_text ?? '');
      if (!fp) return JSON.stringify({ error: 'filepath is required.' });

      if (oldText.trim() === newText.trim()) {
        return JSON.stringify({
          error: 'old_text and new_text are identical — this replace would make no change. ' +
            'To split the file, create a new file with the extracted code, then replace the block with the appropriate module reference or equivalent update.'
        });
      }

      // Trivial 1-line rename guard
      const removedLines = oldText.split('\n');
      const addedLines   = newText.split('\n');
      const addedNonEmptyLines = newText.replace(/\r\n/g, '\n').split('\n').map(line => line.trim()).filter(Boolean);
      const newTextLooksPlaceholder = addedNonEmptyLines.length > 0 && addedNonEmptyLines.every(line =>
        /^(?:\/\/|#|\/\*|\*|<!--)?\s*(?:code will be inserted here|todo|tbd|placeholder|stub|coming soon|implement me|fill me in)/i.test(line));
      if (IS_SPLIT_TASK && newTextLooksPlaceholder) {
        return JSON.stringify({
          error: 'new_text is a placeholder comment, not a valid extraction replacement. Replace the original block with the correct module reference or equivalent real code update — never with "Code will be inserted here".'
        });
      }
      if (removedLines.length <= 1 && addedLines.length <= 1 && !/^\s*import\b/.test(newText)) {
        return JSON.stringify({
          error: 'Single-line rename without an import replacement is not a valid extraction step. ' +
            'Extract a self-contained block (multiple lines) and replace it with the appropriate module reference or equivalent update.'
        });
      }

      try {
        const current = readFileSync(fp, 'utf8');
        if (!current.includes(oldText)) {
          const replaceMiss = analyzeReplaceMiss(current, oldText, fp);
          return JSON.stringify({
            error: replaceMiss.neverPresentInTarget
              ? 'old_text not found in file — the block you tried to replace does not appear anywhere in the target file. Do NOT invent a helper block or guessed replacement target. Read the exact target slice again and copy the real block verbatim.'
              : 'old_text not found in file — text does not match exactly (check whitespace/indentation).',
            suggestedSlice: replaceMiss.suggestedSlice,
            neverPresentInTarget: replaceMiss.neverPresentInTarget
          });
        }
        const rmCount = removedLines.length;
        const addCount = addedLines.length;
        const diff = `Updated ${path.basename(fp)} — replaced 1 block (${rmCount} lines → ${addCount} lines):\n` +
          `\`\`\`diff\n${removedLines.slice(0, 4).map(l => `-${l}`).join('\n')}${rmCount > 4 ? '\n...' : ''}\n` +
          `${addedLines.slice(0, 4).map(l => `+${l}`).join('\n')}${addCount > 4 ? '\n...' : ''}\n\`\`\``;

        if (DRY_RUN) {
          label(Y, 'DRY-RUN replace', `${path.basename(fp)}: ${rmCount} lines → ${addCount} lines\n  old: ${oldText.substring(0, 80)}\n  new: ${newText.substring(0, 80)}`);
          return JSON.stringify({ path: fp, replacements: 1, diff, dryRun: true, ...(pathInfo.recoveredToTarget ? { note: `Recovered requested path ${pathInfo.originalPath} to exact target ${TARGET_FILE}.` } : {}) });
        }
        const updated = current.replace(oldText, newText);
        writeFileSync(fp, updated, 'utf8');
        return JSON.stringify({ path: fp, replacements: 1, diff, ...(pathInfo.recoveredToTarget ? { note: `Recovered requested path ${pathInfo.originalPath} to exact target ${TARGET_FILE}.` } : {}) });
      } catch (e) { return JSON.stringify({ error: e.message }); }
    }

    case 'execute_terminal_command': {
      const cmd = String(args.command ?? args.cmd ?? '');
      if (!cmd) return JSON.stringify({ error: 'command is required.' });
      if (IS_CODE_PREFERRED_GREENFIELD_REQUEST && preferredGreenfieldSuccessfulWriteCount === 0 && !isTerminalReadOnlyInspectionCommand(cmd)) {
        return buildEarlyGreenfieldTerminalBlockResult(cmd);
      }
      return await runTerminalCommandDirect(cmd);
    }

    case 'launch_in_terminal': {
      const cmd = String(args.command ?? args.cmd ?? '');
      if (!cmd) return JSON.stringify({ error: 'command is required.' });
      console.log(`[LAUNCH_IN_TERMINAL] ${cmd}`);
      return JSON.stringify({ launched: true, command: cmd, note: 'In debug mode, interactive launch is simulated. In VS Code, this opens a real terminal.' });
    }

    // ── ManulEngine browser automation stubs ─────────────────────────────────
    case 'manul_run_step': {
      const step = String(args.step ?? '');
      if (!step) return JSON.stringify({ error: 'step is required.' });
      console.log(`[MANUL_RUN_STEP] ${step}`);
      return JSON.stringify({ ok: true, step, note: 'Debug stub — ManulEngine not running. In extension mode this executes the DSL step via Playwright.', _nextAction: 'If this was the last step, reconstruct the .hunt DSL from all steps, show it as a preview, and ask the user if they want to save it.' });
    }

    case 'manul_run_goal': {
      const goal = String(args.goal ?? '');
      if (!goal) return JSON.stringify({ error: 'goal is required.' });
      console.log(`[MANUL_RUN_GOAL] ${goal}`);
      return JSON.stringify({ ok: true, goal, note: 'Debug stub — ManulEngine not running.', _nextAction: 'Automation complete. Reconstruct the .hunt DSL from all steps executed (with @context:, @title:, STEP blocks, VERIFY after every action, DONE.), show it as a fenced code block preview, then ask the user if they want to save it as a hunt file.' });
    }

    case 'manul_scan_page': {
      console.log('[MANUL_SCAN_PAGE]');
      return JSON.stringify({ ok: true, elements: [], note: 'Debug stub — ManulEngine not running. In extension mode this scans the live page for interactive elements.' });
    }

    case 'manul_read_page_text': {
      console.log('[MANUL_READ_PAGE_TEXT]');
      return JSON.stringify({ ok: true, text: '', note: 'Debug stub — ManulEngine not running.' });
    }

    case 'manul_get_state': {
      console.log('[MANUL_GET_STATE]');
      return JSON.stringify({ ok: true, browserOpen: false, stepCount: 0, note: 'Debug stub — ManulEngine not running.' });
    }

    case 'manul_save_hunt': {
      const huntPath = String(args.path ?? args.filePath ?? '');
      const content = String(args.content ?? '');
      if (!huntPath) return JSON.stringify({ error: 'path is required.' });
      if (!content) return JSON.stringify({ error: 'content is required.' });
      if (!huntPath.endsWith('.hunt')) return JSON.stringify({ error: 'path must end in .hunt' });
      const absPath = path.isAbsolute(huntPath) ? huntPath : path.join(wsRoot, huntPath);
      try {
        const dir = path.dirname(absPath);
        mkdirSync(dir, { recursive: true });
        writeFileSync(absPath, content, 'utf8');
        console.log(`[MANUL_SAVE_HUNT] Saved to ${absPath}`);
        return JSON.stringify({ ok: true, path: absPath, success: true });
      } catch (e) {
        return JSON.stringify({ error: e.message });
      }
    }

    case 'manul_run_hunt': {
      const dsl = String(args.dsl ?? '');
      if (!dsl) return JSON.stringify({ error: 'dsl is required.' });
      const lines = dsl.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#') && !l.trim().startsWith('@') && !l.trim().startsWith('DONE') && !/^STEP\s+\d+:/i.test(l.trim()));
      console.log(`[MANUL_RUN_HUNT] ${lines.length} runnable steps`);
      return JSON.stringify({ ok: true, stepCount: lines.length, note: 'Debug stub — ManulEngine not running.', _nextAction: 'Automation complete. Show the executed .hunt DSL as a fenced code block preview (with VERIFY after every action), then ask the user if they want to save it as a hunt file.' });
    }

    case 'manul_run_hunt_file': {
      const filePath = String(args.filePath ?? args.path ?? '');
      if (!filePath) return JSON.stringify({ error: 'filePath is required.' });
      if (!filePath.endsWith('.hunt')) return JSON.stringify({ error: 'filePath must end in .hunt' });
      const absPath = path.isAbsolute(filePath) ? filePath : path.join(wsRoot, filePath);
      let dsl = '';
      try { dsl = readFileSync(absPath, 'utf8'); } catch (e) { return JSON.stringify({ error: `Could not read file: ${e.message}` }); }
      const lines = dsl.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#') && !l.trim().startsWith('@') && !l.trim().startsWith('DONE') && !/^STEP\s+\d+:/i.test(l.trim()));
      console.log(`[MANUL_RUN_HUNT_FILE] ${absPath} — ${lines.length} runnable steps`);
      return JSON.stringify({ ok: true, filePath: absPath, stepCount: lines.length, note: 'Debug stub — ManulEngine not running.', _nextAction: 'Hunt file execution complete. Show the executed .hunt DSL as a fenced code block preview (with VERIFY after every action), then ask the user if they want to save or overwrite it.' });
    }
    // ─────────────────────────────────────────────────────────────────────────

    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

// Extract likely exportable definitions from source code for recovery flows.
function extractDefinitionsFromSource(source, filepath = TARGET_FILE) {
  const normalized = source.replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';
  const languageId = detectLanguageId(filepath);
  const lines = normalized.split('\n');

  const captureBraceBlock = startIndex => {
    const collected = [];
    let depth = 0;
    let seenOpen = false;
    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i];
      collected.push(line);
      for (const ch of line) {
        if (ch === '{') {
          depth++;
          seenOpen = true;
        } else if (ch === '}') {
          depth--;
        }
      }
      if (seenOpen && depth <= 0) {
        return collected.join('\n').trim();
      }
      if (!seenOpen && /;\s*$/.test(line.trim())) {
        return collected.join('\n').trim();
      }
    }
    return collected.join('\n').trim();
  };

  const captureIndentedBlock = startIndex => {
    const collected = [lines[startIndex]];
    const baseIndent = (lines[startIndex].match(/^\s*/) ?? [''])[0].length;
    for (let i = startIndex + 1; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed) {
        collected.push(line);
        continue;
      }
      const indent = (line.match(/^\s*/) ?? [''])[0].length;
      if (indent <= baseIndent && !/^\s*@/.test(line)) break;
      collected.push(line);
    }
    return collected.join('\n').trim();
  };

  const patternsByLanguage = {
    python: [/^\s*(?:class|def)\s+[A-Za-z_][\w]*/],
    go: [/^\s*type\s+[A-Za-z_][\w]*\s+(?:struct|interface)\b/, /^\s*func\s+(?:\([^)]*\)\s*)?[A-Za-z_][\w]*\s*\(/],
    rust: [/^\s*(?:pub\s+)?(?:struct|enum|trait|fn|const|mod)\s+[A-Za-z_][\w]*/, /^\s*impl\s+[A-Za-z_][\w]*/],
    java: [/^\s*(?:public\s+)?(?:class|interface|enum|record)\s+[A-Za-z_][\w]*/, /^\s*(?:public|private|protected)\s+(?:static\s+)?[A-Za-z_][\w<>\[\], ?]*\s+[A-Za-z_][\w]*\s*\(/],
    csharp: [/^\s*(?:public|internal|private|protected)\s+(?:static\s+)?(?:class|interface|enum|record|struct)\s+[A-Za-z_][\w]*/, /^\s*(?:public|internal|private|protected)\s+(?:static\s+)?[A-Za-z_][\w<>\[\], ?]*\s+[A-Za-z_][\w]*\s*\(/],
    typescript: [/^\s*(?:export\s+)?(?:interface|type|enum|class|function)\s+[A-Za-z_][\w]*/, /^\s*export\s+(?:const|let|var)\s+[A-Za-z_][\w]*/],
    typescriptreact: [/^\s*(?:export\s+)?(?:interface|type|enum|class|function)\s+[A-Za-z_][\w]*/, /^\s*export\s+(?:const|let|var)\s+[A-Za-z_][\w]*/],
    javascript: [/^\s*export\s+(?:async\s+)?(?:function|class|const|let|var)\s+[A-Za-z_][\w]*/, /^\s*(?:async\s+)?function\s+[A-Za-z_][\w]*/, /^\s*class\s+[A-Za-z_][\w]*/],
    javascriptreact: [/^\s*export\s+(?:async\s+)?(?:function|class|const|let|var)\s+[A-Za-z_][\w]*/, /^\s*(?:async\s+)?function\s+[A-Za-z_][\w]*/, /^\s*class\s+[A-Za-z_][\w]*/]
  };

  const patterns = patternsByLanguage[languageId] ?? [/^\s*(?:class|interface|enum|record|struct|trait|type|def|fn|function)\s+[A-Za-z_][\w]*/];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!patterns.some(pattern => pattern.test(line))) continue;
    const block = languageId === 'python' ? captureIndentedBlock(i) : captureBraceBlock(i);
    if (languageId === 'go') {
      const packageLine = lines.find(candidate => /^\s*package\s+[A-Za-z_][\w]*/.test(candidate));
      if (packageLine && !/^\s*package\s+/m.test(block)) {
        return `${packageLine}\n\n${block}`;
      }
    }
    return block;
  }

  if (languageId === 'rust' && lines.every(line => /^\s*(?:pub\s+)?use\b/.test(line) || line.trim() === '')) {
    return '';
  }

  return normalized.length <= 1200 ? normalized : lines.slice(0, Math.min(lines.length, 80)).join('\n').trim();
}

// ─── Text-based tool call parser (handles leaked JSON tool calls) ────────────
const KNOWN_TOOLS = ['list_workspace_files', 'project_scan', 'read_workspace_notes', 'write_workspace_notes', 'read_file_slice', 'read_specific_file', 'create_or_edit_file', 'replace_in_file', 'execute_terminal_command', 'launch_in_terminal'];

// Alias map: weak models often use alternative tool names
const TOOL_ALIASES = {
  write_file: 'create_or_edit_file',
  create_file: 'create_or_edit_file',
  create_or_replace: 'create_or_edit_file',
  create_or_overwrite: 'create_or_edit_file',
  edit_file: 'replace_in_file',
  replace_content: 'replace_in_file',
  read_file: 'read_specific_file',
  read_file_range: 'read_file_slice',
  read_file_chunk: 'read_file_slice',
  run_command: 'execute_terminal_command',
  terminal_command: 'execute_terminal_command',
  open_terminal: 'launch_in_terminal',
  run_in_terminal: 'launch_in_terminal'
};
function remapToolName(name) {
  return TOOL_ALIASES[name.trim().toLowerCase()] ?? name.trim();
}

// Alias map: weak models often use alternative argument keys
const ARG_ALIASES = {
  file_path: 'filepath', filePath: 'filepath', file_name: 'filename', file: 'filepath', path: 'filepath',
  old_content: 'old_text', new_content: 'new_text', old_string: 'old_text', new_string: 'new_text',
  old_code: 'old_text', new_code: 'new_text',
  start_line: 'startLine', end_line: 'endLine', from_line: 'startLine', to_line: 'endLine',
  cmd: 'command', dir: 'directory'
};
function remapArgs(args) {
  if (!args || typeof args !== 'object') return args;
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    out[ARG_ALIASES[k] ?? k] = v;
  }
  return out;
}

function extractDeterministicSingleFileCreateRequest(text) {
  const match = text.match(/\b(?:create|write|add)\s+((?:[A-Za-z]:)?[A-Za-z0-9_./\\-]+\.(?:ts|tsx|js|jsx|json|md|css|html|py|yml|yaml|txt|sh))\b/i);
  if (!match || !match[1]) return undefined;
  const filepath = match[1].replace(/\\/g, '/');
  const codeBlockMatch = text.match(/```[\w+-]*\n([\s\S]*?)```/);
  let content = codeBlockMatch?.[1]?.trim() ?? '';
  if (!content) {
    content = text.slice(match.index + match[0].length)
      .replace(/^\s*(?:with\s+(?:content|code)\s*:|containing\s+|that\s+contains\s+)/i, '')
      .replace(/^\s*exporting\s+/i, 'export ')
      .replace(/\bdo\s+not\s+modify\s+any\s+other\s+file\b[.!]?/i, '')
      .trim()
      .replace(/[\s.]+$/, '')
      .trim();
  }
  if (!content) return undefined;
  if (!/(?:\bexport\b|\bfunction\b|=>|\bclass\b|\binterface\b|\bconst\b|\blet\b|\breturn\b|[{};])/m.test(content)) return undefined;
  return { filepath, content: content.endsWith('\n') ? content : `${content}\n` };
}

function extractLikelyRequestFileTargets(text) {
  const candidates = [];
  const pushCandidate = value => {
    const trimmed = String(value ?? '').trim().replace(/^[`"']+|[`"'.,;:!?]+$/g, '');
    if (!trimmed) return;
    const normalized = trimmed.replace(/\\/g, '/');
    if (!candidates.some(candidate => candidate.toLowerCase() === normalized.toLowerCase())) {
      candidates.push(normalized);
    }
  };

  let match;
  const explicitPathPattern = /(?:^|\s)((?:[A-Za-z]:)?[A-Za-z0-9_./\\-]+\.(?:ts|tsx|js|jsx|json|md|css|scss|html|py|yml|yaml|xml|txt|sh|toml|ini|go))(?:\s|$|[,.;:!?])/gi;
  while ((match = explicitPathPattern.exec(text)) !== null) {
    pushCandidate(match[1]);
  }

  const bareNamePattern = /\b(package\.json|tsconfig\.json|README(?:\.md)?|LICENSE(?:\.txt|\.md)?|CHANGELOG(?:\.md)?|Dockerfile|Makefile|\.env(?:\.[A-Za-z0-9_-]+)?)\b/gi;
  while ((match = bareNamePattern.exec(text)) !== null) {
    pushCandidate(match[1]);
  }

  const normalized = text.toLowerCase();
  if (/(?:\breadme\b|рідмі|ридми)/i.test(normalized)) {
    pushCandidate('README.md');
    pushCandidate('README');
  }
  if (/(?:\blicense\b|ліцензі|лиценз)/i.test(normalized)) {
    pushCandidate('LICENSE');
  }
  if (/(?:package\s*json|package\.json)/i.test(normalized)) {
    pushCandidate('package.json');
  }
  if (/(?:tsconfig|tsconfig\.json)/i.test(normalized)) {
    pushCandidate('tsconfig.json');
  }
  if (/(?:changelog|історі[яї]\s+змін|список\s+змін|список\s+изменений)/i.test(normalized)) {
    pushCandidate('CHANGELOG.md');
  }
  if (/\bdockerfile\b/i.test(normalized)) {
    pushCandidate('Dockerfile');
  }
  if (/\bmakefile\b/i.test(normalized)) {
    pushCandidate('Makefile');
  }

  return candidates;
}

function resolveDeterministicKnownFilePath(candidates = []) {
  for (const candidate of candidates) {
    const resolved = resolveFilepath(candidate);
    if (resolved && existsSync(resolved)) return resolved;
  }
  for (const candidate of ['README.md', 'README', 'LICENSE', 'package.json', 'tsconfig.json']) {
    const resolved = resolveFilepath(candidate);
    if (resolved && existsSync(resolved)) return resolved;
  }
  return undefined;
}

function getDeterministicReadRecoveryTargetFromPrompt(text) {
  const normalized = text.trim().toLowerCase();
  if (normalized.includes('package.json') && /\bname\b/i.test(text) && /\bversion\b/i.test(text) && /(?:\bread\b|\bshow\b|\banswer\b|\bпокажи\b|\bпрочитай\b|\bскажи\b)/i.test(text)) {
    return { filepath: 'package.json', reason: 'package.json name/version request' };
  }
  if (/(?:\breadme\b|readme\.md)/i.test(normalized) && /(?:\btitle\b|\bheading\b|\bheadline\b|\bзаголовок\b|\bтайтл\b)/i.test(text) && /(?:\bread\b|\bshow\b|\bwhat\b|\banswer\b|\bпокажи\b|\bпрочитай\b|\bскажи\b)/i.test(text)) {
    return { filepath: 'README.md', reason: 'README title request' };
  }
  return undefined;
}

function inferDegenerateRecoveryStarterFilepath(text) {
  const explicitTargets = extractLikelyRequestFileTargets(text);
  if (explicitTargets.length > 0) return explicitTargets[0];

  const normalized = text.trim().toLowerCase();
  if (!looksLikeWriteIntent(text)) return undefined;
  if (/\bpython\b|\bpy\b/i.test(normalized) || normalized.includes('пайтон') || normalized.includes('питон') || normalized.includes('піто')) return 'main.py';
  if (/\bgo\b|\bgolang\b/i.test(normalized)) return 'main.go';
  if (/\brust\b|\brs\b/i.test(normalized)) return 'main.rs';
  if (/\bjava\b/i.test(normalized)) return 'Main.java';
  if (/\bkotlin\b|\bkt\b/i.test(normalized)) return 'Main.kt';
  if (/\bc#\b|\bcsharp\b|\bdotnet\b|\.net\b|\bcs\b/i.test(normalized)) return 'Program.cs';
  if (/\btypescript\b|\btype script\b|\bts\b/i.test(normalized)) return 'main.ts';
  if (/\bjavascript\b|\bnode\b|\bjs\b/i.test(normalized)) return 'main.js';
  if (/\bphp\b/i.test(normalized)) return 'index.php';
  if (/\bruby\b|\brb\b/i.test(normalized)) return 'main.rb';
  if (/\bswift\b/i.test(normalized)) return 'main.swift';
  if (/\bc\+\+\b|\bcpp\b|\bcxx\b/i.test(normalized)) return 'main.cpp';
  if (/\bc\b/i.test(normalized)) return 'main.c';
  if (/\bhtml\b|\bweb\s*page\b|\blanding\b/i.test(normalized)) return 'index.html';
  if (/\bcss\b|\bscss\b|\bsass\b|\bless\b/i.test(normalized)) return 'styles.css';
  if (/\bjson\b/i.test(normalized)) return 'data.json';
  if (/\byaml\b|\byml\b/i.test(normalized)) return 'config.yaml';
  if (/\bshell\b|\bbash\b|\bsh\b|\bscript\b/i.test(normalized)) return 'main.sh';
  return 'main.txt';
}

function extractRawToolPayloadFromOllamaError(errorText) {
  const match = String(errorText ?? '').match(/error parsing tool call:\s*raw='([\s\S]*?)',\s*err=/i);
  return match?.[1]?.trim() || undefined;
}

function getPreferredGreenfieldCodeDumpSpec(targetFilepath) {
  const ext = path.extname(targetFilepath || '').toLowerCase();
  if (ext === '.py') {
    return {
      firstCodeLinePattern: /^(?:import\s+\w|from\s+\w+\s+import\s+.+|def\s+\w+\(|class\s+\w+)/,
      codeSignalPattern: /(?:\bdef\b|\bclass\b|\binput\s*\(|\brandom\b|\bwhile\b|\bfor\b|\bif\b|\belif\b|\breturn\b|\broll\b|\bdice\b)/g,
      minLength: 120,
      minSignalCount: 4
    };
  }
  if (['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    return {
      firstCodeLinePattern: /^(?:import\s+.+|export\s+.+|const\s+\w+|let\s+\w+|var\s+\w+|function\s+\w+|async\s+function\s+\w+|class\s+\w+|interface\s+\w+|type\s+\w+|enum\s+\w+)/,
      codeSignalPattern: /(?:\bimport\b|\bexport\b|\bconst\b|\blet\b|\bvar\b|\bfunction\b|\bclass\b|=>|[{}();])/g,
      minLength: 120,
      minSignalCount: 4
    };
  }
  if (ext === '.go') {
    return {
      firstCodeLinePattern: /^(?:package\s+\w+|import\s*\(|import\s+".+"|func\s+\w+|type\s+\w+)/,
      codeSignalPattern: /(?:\bpackage\b|\bimport\b|\bfunc\b|\btype\b|\bstruct\b|\bif\b|\bfor\b|:=|[{}()])/g,
      minLength: 120,
      minSignalCount: 4
    };
  }
  if (ext === '.rs') {
    return {
      firstCodeLinePattern: /^(?:use\s+\w+|fn\s+\w+|struct\s+\w+|enum\s+\w+|impl\s+\w+|mod\s+\w+)/,
      codeSignalPattern: /(?:\buse\b|\bfn\b|\bstruct\b|\benum\b|\bimpl\b|\blet\b|\bmatch\b|[{}();])/g,
      minLength: 120,
      minSignalCount: 4
    };
  }
  if (ext === '.java' || ext === '.kt' || ext === '.cs') {
    return {
      firstCodeLinePattern: /^(?:package\s+[\w.]+;?|import\s+[\w.*]+;?|using\s+[\w.]+;?|namespace\s+[\w.]+|public\s+class\s+\w+|class\s+\w+|object\s+\w+)/,
      codeSignalPattern: /(?:\bpackage\b|\bimport\b|\busing\b|\bnamespace\b|\bclass\b|\bpublic\b|\bprivate\b|\bfun\b|\bstatic\b|[{}();])/g,
      minLength: 140,
      minSignalCount: 4
    };
  }
  if (['.php', '.rb', '.swift', '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp', '.hh'].includes(ext)) {
    return {
      firstCodeLinePattern: /^(?:<\?php|#include\s+[<"].+[>"]|require\s+['"].+['"]|func\s+\w+|def\s+\w+|class\s+\w+|struct\s+\w+|int\s+main\s*\(|void\s+\w+\s*\()/,
      codeSignalPattern: /(?:<\?php|#include\b|\brequire\b|\bdef\b|\bclass\b|\bfunc\b|\bstruct\b|\breturn\b|[{}();])/g,
      minLength: 120,
      minSignalCount: 4
    };
  }
  if (['.html', '.css', '.scss', '.sass', '.less'].includes(ext)) {
    return {
      firstCodeLinePattern: /^(?:<!doctype\s+html>|<html\b|<head\b|<body\b|<main\b|<div\b|<section\b|<style\b|[.#][\w-]+\s*\{)/i,
      codeSignalPattern: /(?:<html\b|<body\b|<main\b|<div\b|<section\b|<script\b|<style\b|\{[^}]*\}|\bdisplay\s*:|\bcolor\s*:)/gi,
      minLength: 120,
      minSignalCount: 3
    };
  }
  if (['.json', '.jsonc', '.yaml', '.yml', '.sh'].includes(ext)) {
    return {
      firstCodeLinePattern: /^(?:\{|\[|\w+\s*:|#!\/bin\/(?:bash|sh)|set\s+-[a-z]+|[A-Za-z_][A-Za-z0-9_]*=)/,
      codeSignalPattern: /(?:\{|\[|\]|\}|:\s|#!\/bin\/(?:bash|sh)|\bif\b|\bfi\b|\bthen\b|\bexport\b|\=)/g,
      minLength: 80,
      minSignalCount: 3
    };
  }
  return undefined;
}

function extractPreferredGreenfieldCodeDump(content) {
  if (!IS_CODE_PREFERRED_GREENFIELD_REQUEST || preferredGreenfieldSuccessfulWriteCount > 0 || !PREFERRED_GREENFIELD_BOOTSTRAP_FILEPATH) return undefined;

  const spec = getPreferredGreenfieldCodeDumpSpec(PREFERRED_GREENFIELD_BOOTSTRAP_FILEPATH);
  if (!spec) return undefined;

  const normalized = content.replace(/\r\n/g, '\n').trim();
  if (!normalized) return undefined;

  const fencedCandidates = Array.from(normalized.matchAll(/```(?:[\w+-]+)?\n([\s\S]*?)```/g), match => match[1].trim()).filter(Boolean);
  for (const block of [normalized, ...fencedCandidates]) {
    const lines = block.split('\n');
    const firstCodeIndex = lines.findIndex(line => spec.firstCodeLinePattern.test(line.trim()));
    if (firstCodeIndex < 0) continue;

    const candidate = lines.slice(firstCodeIndex).join('\n').trim();
    if (candidate.length < spec.minLength) continue;
    const codeSignalCount = (candidate.match(spec.codeSignalPattern) ?? []).length;
    if (codeSignalCount < spec.minSignalCount) continue;
    if (detectInsufficientGreenfieldCreateContent(PREFERRED_GREENFIELD_BOOTSTRAP_FILEPATH, candidate)) continue;
    return { filepath: PREFERRED_GREENFIELD_BOOTSTRAP_FILEPATH, content: candidate };
  }

  return undefined;
}

async function tryUltraSmallDeterministicFastPath() {
  if (/package\.json/i.test(userPrompt) && /\bname\b/i.test(userPrompt) && /\bversion\b/i.test(userPrompt) && /(?:\bread\b|\bshow\b|\banswer\b)/i.test(userPrompt)) {
    try {
      const packageJson = JSON.parse(readFileSync(path.join(wsRoot, 'package.json'), 'utf8'));
      const summary = [String(packageJson.name ?? '').trim(), String(packageJson.version ?? '').trim()].filter(Boolean).join(' ').trim();
      label(G, 'FAST-PATH', `package.json -> ${summary || '(missing name/version)'}`);
      logEvent('session_done', { reason: 'deterministic_fast_path_package_json', summary });
      return true;
    } catch (error) {
      label(R, 'FAST-PATH ERROR', error instanceof Error ? error.message : String(error));
      logEvent('fast_path_error', { reason: 'package_json', error: error instanceof Error ? error.message : String(error) });
      return true;
    }
  }

  if (/(?:\breadme\b|readme\.md)/i.test(userPrompt) && /(?:\btitle\b|\bheading\b|\bheadline\b|\bзаголовок\b|\bтайтл\b)/i.test(userPrompt) && /(?:\bread\b|\bshow\b|\bwhat\b|\banswer\b|\bпокажи\b|\bпрочитай\b|\bскажи\b)/i.test(userPrompt)) {
    try {
      const readmeText = readFileSync(path.join(wsRoot, 'README.md'), 'utf8');
      const title = readmeText.match(/^#\s+(.+)$/m)?.[1]?.trim() || 'README.md has no H1 title.';
      label(G, 'FAST-PATH', `README title -> ${title}`);
      logEvent('session_done', { reason: 'deterministic_fast_path_readme_title', title });
      return true;
    } catch (error) {
      label(R, 'FAST-PATH ERROR', error instanceof Error ? error.message : String(error));
      logEvent('fast_path_error', { reason: 'readme_title', error: error instanceof Error ? error.message : String(error) });
      return true;
    }
  }

  if (MODEL_LIMITS.tier !== 'micro') return false;

  const exactLineReplaceMatch = userPrompt.match(/replace\s+(?:the\s+)?exact\s+line\s+["'`](.+?)["'`]\s+with\s+["'`](.+?)["'`](?:\s+in\s+(\S+))?/i);
  if (exactLineReplaceMatch) {
    const oldLine = String(exactLineReplaceMatch[1] ?? '').trim();
    const newLine = String(exactLineReplaceMatch[2] ?? '').trim();
    const explicitFile = String(exactLineReplaceMatch[3] ?? '').trim();
    const targetPath = resolveDeterministicKnownFilePath(explicitFile ? [explicitFile] : extractLikelyRequestFileTargets(userPrompt));

    if (!targetPath) {
      label(R, 'FAST-PATH ERROR', 'Unable to resolve target file for exact-line replace');
      logEvent('fast_path_error', { reason: 'exact_line_replace', error: 'resolve_target_failed' });
      return true;
    }

    try {
      const current = readFileSync(targetPath, 'utf8');
      const oldLinePattern = new RegExp(`^${escapeRegex(oldLine)}$`, 'm');
      if (!oldLinePattern.test(current)) {
        label(R, 'FAST-PATH ERROR', `Exact line not found in ${path.basename(targetPath)}`);
        logEvent('fast_path_error', { reason: 'exact_line_replace', error: 'line_not_found', filepath: targetPath });
        return true;
      }

      const result = await executeTool('replace_in_file', {
        filepath: targetPath,
        old_text: oldLine,
        new_text: newLine
      });
      const parsed = JSON.parse(result);
      if (parsed.error) {
        label(R, 'FAST-PATH ERROR', parsed.error);
        logEvent('fast_path_error', { reason: 'exact_line_replace', error: parsed.error, filepath: targetPath });
      } else {
        label(G, 'FAST-PATH', `Replaced exact line in ${path.basename(targetPath)}`);
        logEvent('session_done', { reason: 'ultra_small_fast_path_exact_line_replace', filepath: targetPath });
      }
      return true;
    } catch (error) {
      label(R, 'FAST-PATH ERROR', error instanceof Error ? error.message : String(error));
      logEvent('fast_path_error', { reason: 'exact_line_replace', error: error instanceof Error ? error.message : String(error), filepath: targetPath });
      return true;
    }
  }

  const createRequest = extractDeterministicSingleFileCreateRequest(userPrompt);
  if (createRequest) {
    const result = await executeTool('create_or_edit_file', { filename: createRequest.filepath, content: createRequest.content });
    const parsed = JSON.parse(result);
    if (parsed.error) {
      label(R, 'FAST-PATH ERROR', parsed.error);
      logEvent('fast_path_error', { reason: 'single_file_create', error: parsed.error, filepath: createRequest.filepath });
    } else {
      label(G, 'FAST-PATH', `Created ${createRequest.filepath}`);
      logEvent('session_done', { reason: 'ultra_small_fast_path_single_file_create', filepath: createRequest.filepath });
    }
    return true;
  }

  return false;
}

// All names (canonical + aliases) that we should try to detect in text
const ALL_TOOL_NAMES = [...KNOWN_TOOLS, ...Object.keys(TOOL_ALIASES)];

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

// Relaxed JSON parser: handles unquoted object keys like {command: "value"}
function relaxedJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    try {
      return JSON.parse(escapeJsonStringValues(str));
    } catch { /* ignore */ }
    // Try quoting unquoted keys: {key: "value"} → {"key": "value"}
    try {
      const fixed = str.replace(/([{,])\s*([A-Za-z_]\w*)\s*:/g, '$1"$2":');
      return JSON.parse(fixed);
    } catch {
      try {
        const fixed = str.replace(/([{,])\s*([A-Za-z_]\w*)\s*:/g, '$1"$2":');
        return JSON.parse(escapeJsonStringValues(fixed));
      } catch { return null; }
    }
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseQuotedString(value) {
  if (value.length < 2) return undefined;
  const quote = value[0];
  if (!['"', '\'', '`'].includes(quote) || value[value.length - 1] !== quote) return undefined;
  if (quote === '"') {
    try { return JSON.parse(value); } catch { return undefined; }
  }
  return value.slice(1, -1)
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\')
    .replace(new RegExp(`\\\\${escapeRegex(quote)}`, 'g'), quote);
}

function splitTopLevelArguments(value) {
  const parts = [];
  let current = '';
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let quote = null;
  let escaped = false;

  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (quote) {
      current += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === '\'' || char === '`') {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(') parenDepth++;
    else if (char === ')') parenDepth = Math.max(0, parenDepth - 1);
    else if (char === '{') braceDepth++;
    else if (char === '}') braceDepth = Math.max(0, braceDepth - 1);
    else if (char === '[') bracketDepth++;
    else if (char === ']') bracketDepth = Math.max(0, bracketDepth - 1);

    if (char === ',' && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
      const trimmed = current.trim();
      if (trimmed) parts.push(trimmed);
      current = '';
      continue;
    }
    current += char;
  }

  const tail = current.trim();
  if (tail) parts.push(tail);
  return parts;
}

function extractBalancedParentheses(value, startIndex) {
  if (value[startIndex] !== '(') return undefined;
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = startIndex; index < value.length; index++) {
    const char = value[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === '\'' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') depth++;
    else if (char === ')') {
      depth--;
      if (depth === 0) return value.slice(startIndex, index + 1);
    }
  }
  return undefined;
}

function parseParenthesizedArgValue(token) {
  const trimmed = token.trim();
  const quoted = parseQuotedString(trimmed);
  if (quoted !== undefined) return quoted;
  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed);
  if (/^(?:true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
  if (/^null$/i.test(trimmed)) return null;
  return trimmed;
}

function inferParenthesizedArgs(toolName, argsBody) {
  if (!argsBody) {
    if (['list_workspace_files', 'project_scan', 'read_workspace_notes', 'read_active_file'].includes(toolName)) return {};
    return undefined;
  }
  if (argsBody.startsWith('{') && argsBody.endsWith('}')) {
    const parsed = relaxedJsonParse(argsBody);
    if (parsed) return remapArgs(parsed);
  }
  const values = splitTopLevelArguments(argsBody).map(parseParenthesizedArgValue);
  if (toolName === 'execute_terminal_command' || toolName === 'launch_in_terminal') return typeof values[0] === 'string' ? { command: values[0] } : undefined;
  if (toolName === 'read_specific_file') return typeof values[0] === 'string' ? { filepath: values[0] } : undefined;
  if (toolName === 'list_workspace_files') return values.length === 0 ? {} : (typeof values[0] === 'string' ? { directory: values[0] } : undefined);
  if (toolName === 'delete_file') return typeof values[0] === 'string' ? { filepath: values[0] } : undefined;
  if (toolName === 'read_file_slice') return typeof values[0] === 'string' && typeof values[1] === 'number' && typeof values[2] === 'number' ? { filepath: values[0], startLine: values[1], endLine: values[2] } : undefined;
  if (toolName === 'create_or_edit_file' || toolName === 'write_to_file') return typeof values[0] === 'string' && typeof values[1] === 'string' ? { filename: values[0], filepath: values[0], content: values[1] } : undefined;
  if (toolName === 'replace_in_file') return typeof values[0] === 'string' && typeof values[1] === 'string' && typeof values[2] === 'string' ? { filepath: values[0], old_text: values[1], new_text: values[2] } : undefined;
  if (toolName === 'write_workspace_notes') return typeof values[0] === 'string' && typeof values[1] === 'string' ? { content: values[0], mode: values[1] } : undefined;
  return undefined;
}

function parseToolCallsFromText(content) {
  const results = [];

  for (const toolName of ALL_TOOL_NAMES) {
    const callRe = new RegExp(`\\b${escapeRegex(toolName)}\\s*\\(`, 'gi');
    let callMatch;
    while ((callMatch = callRe.exec(content)) !== null) {
      const argsSource = extractBalancedParentheses(content, callMatch.index + callMatch[0].length - 1);
      if (!argsSource) continue;
      const mappedName = remapToolName(toolName);
      const args = inferParenthesizedArgs(mappedName, argsSource.slice(1, -1).trim());
      if (args) results.push({ function: { name: mappedName, arguments: args } });
    }
  }

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
          results.push({ function: { name: remapToolName(obj.name), arguments: remapArgs(typeof obj.arguments === 'string' ? relaxedJsonParse(obj.arguments) ?? {} : obj.arguments) } });
        }
      }
    }
  }

  // Match fenced code blocks — extract full content and try to parse as JSON
  const fencedPattern = /```([a-zA-Z_][\w-]*)?\s*\n([\s\S]*?)\n```/g;
  let match;
  while ((match = fencedPattern.exec(content)) !== null) {
    const infoString = String(match[1] ?? '').trim();
    const inner = String(match[2] ?? '').trim();
    if (infoString) {
      const mappedName = remapToolName(infoString);
      if (ALL_TOOL_NAMES.includes(infoString) || KNOWN_TOOLS.includes(mappedName)) {
        const args = relaxedJsonParse(inner);
        if (args) {
          results.push({ function: { name: mappedName, arguments: remapArgs(args) } });
          continue;
        }
      }
    }
    try {
      const obj = relaxedJsonParse(inner);
      if (obj?.name && obj?.arguments !== undefined) {
        results.push({ function: { name: remapToolName(obj.name), arguments: remapArgs(typeof obj.arguments === 'string' ? relaxedJsonParse(obj.arguments) ?? {} : obj.arguments) } });
      }
    } catch { /* ignore */ }
  }

  // Match "Executing step N: tool_name with arguments {...}" — model announces instead of calling
  const announcedPattern = /execut(?:e|ing)\s+step\s+\d+[:/]\s*(\w+)\s+(?:with\s+)?arguments?:?\s*(\{[\s\S]*?\})(?=\s*(?:```|$|\n\n))/gi;
  while ((match = announcedPattern.exec(content)) !== null) {
    const toolName = remapToolName(match[1]);
    const argsObj = relaxedJsonParse(match[2]);
    if (argsObj) results.push({ function: { name: toolName, arguments: remapArgs(argsObj) } });
  }

  // Match <function=tool_name><parameter=key>value</parameter></function> tagged calls
  const functionTagRe = /<function=([a-zA-Z0-9_]+)>\s*([\s\S]*?)<\/function>/g;
  while ((match = functionTagRe.exec(content)) !== null) {
    const toolName = remapToolName(match[1]);
    const args = {};
    const paramRe = /<parameter=([a-zA-Z0-9_]+)>\s*([\s\S]*?)\s*<\/parameter>/g;
    let pm;
    while ((pm = paramRe.exec(match[2])) !== null) {
      args[pm[1].trim()] = pm[2];
    }
    results.push({ function: { name: toolName, arguments: remapArgs(args) } });
  }

  // Match tool_name("single string arg") or tool_name({...}) Python/JS-style calls
  for (const toolName of ALL_TOOL_NAMES) {
    const callRe = new RegExp(`${toolName}\\s*\\(\\s*("(?:[^"\\\\]|\\\\.)*"|\\{[\\s\\S]*?\\})\\s*\\)`, 'g');
    while ((match = callRe.exec(content)) !== null) {
      try {
        const argStr = match[1].trim();
        const mappedName = remapToolName(toolName);
        let args;
        if (argStr.startsWith('"')) {
          const val = JSON.parse(argStr);
          // Skip double-wrapped calls like execute_terminal_command("execute_terminal_command(...)")
          if (typeof val === 'string' && ALL_TOOL_NAMES.some(t => val.startsWith(t + '('))) continue;
          if (mappedName === 'execute_terminal_command') args = { command: val };
          else if (mappedName === 'read_specific_file') args = { filepath: val };
          else if (mappedName === 'list_workspace_files') args = { directory: val };
          else args = { filepath: val };
        } else {
          args = relaxedJsonParse(argStr) ?? JSON.parse(argStr);
        }
        results.push({ function: { name: mappedName, arguments: remapArgs(args) } });
      } catch { /* ignore */ }
    }
  }

  // Match "**Tool Call:** tool_name with arguments {...}" — markdown-annotated calls
  const toolCallAnnotationPattern = /\*{0,2}tool\s+call\*{0,2}[:\s]+([\w_]+)\s+(?:with\s+)?arguments?:?\s*(\{[\s\S]*?\})/gi;
  while ((match = toolCallAnnotationPattern.exec(content)) !== null) {
    const toolName = remapToolName(match[1]);
    const argsObj = relaxedJsonParse(match[2]);
    if (argsObj) results.push({ function: { name: toolName, arguments: remapArgs(argsObj) } });
  }

  // Match tool_name with arguments {...} (bare prefix, no markdown) — balanced brace + relaxed JSON
  for (const toolName of ALL_TOOL_NAMES) {
    const re = new RegExp(`\\b${toolName}\\s+with\\s+arguments?:?\\s*(\\{)`, 'gi');
    let bm;
    while ((bm = re.exec(content)) !== null) {
      const start = bm.index + bm[0].length - 1;
      let depth = 0, inStr = false, esc = false, end = -1;
      for (let j = start; j < content.length; j++) {
        const ch = content[j];
        if (esc) { esc = false; continue; }
        if (ch === '\\' && inStr) { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === '{') depth++;
        if (ch === '}') { depth--; if (depth === 0) { end = j; break; } }
      }
      if (end !== -1) {
        const args = relaxedJsonParse(content.substring(start, end + 1));
        if (args) results.push({ function: { name: remapToolName(toolName), arguments: remapArgs(args) } });
      }
    }
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

  // Match read_file_slice filepath="path" startLine=N endLine=N (key=value format)
  const readSliceKVRe = /\bread_file_slice\s+filepath="([^"]+)"\s+startLine=(\d+)\s+endLine=(\d+)/g;
  while ((match = readSliceKVRe.exec(content)) !== null) {
    results.push({ function: { name: 'read_file_slice', arguments: { filepath: match[1], startLine: parseInt(match[2]), endLine: parseInt(match[3]) } } });
  }

  // Match read_specific_file "filepath"/path or list_workspace_files "dir"/dir
  const singleArgRe = /\b(read_specific_file|list_workspace_files)\s+(?:"([^"]+)"|([^\s,(){}[\]"'`]+))/g;
  while ((match = singleArgRe.exec(content)) !== null) {
    const argKey = match[1] === 'list_workspace_files' ? 'directory' : 'filepath';
    const argVal = match[2] || match[3];
    // Skip if value looks like a keyword rather than a path (e.g. "with", "and", "then")
    if (/^(?:with|and|then|to|for|the|is|of|at|in|on|as|if|so)$/i.test(argVal)) continue;
    results.push({ function: { name: match[1], arguments: { [argKey]: argVal } } });
  }

  // Match tool_name {json_args} — tool name followed directly by JSON args (no "with arguments" keyword).
  // This handles models that output e.g. create_or_edit_file {"filename":"path","content":"..."}.
  for (const toolName of ALL_TOOL_NAMES) {
    const directJsonRe = new RegExp(`\\b${toolName}\\s+(\\{)`, 'gi');
    let djm;
    while ((djm = directJsonRe.exec(content)) !== null) {
      const start = djm.index + djm[0].length - 1;
      let depth = 0, inStr = false, esc = false, end = -1;
      for (let j = start; j < content.length; j++) {
        const ch = content[j];
        if (esc) { esc = false; continue; }
        if (ch === '\\' && inStr) { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === '{') depth++;
        if (ch === '}') { depth--; if (depth === 0) { end = j; break; } }
      }
      if (end !== -1) {
        const blob = content.substring(start, end + 1);
        const args = relaxedJsonParse(blob);
        if (args && typeof args === 'object') {
          // Skip if it looks like a {name, arguments} wrapper — those are handled by the blob parser
          if (args.name && args.arguments !== undefined) continue;
          results.push({ function: { name: remapToolName(toolName), arguments: remapArgs(args) } });
        }
      }
    }
  }

  // Match create_or_edit_file "filepath" "content" or create_or_edit_file path "content" positional format.
  const createOrEditPositionalRe = /\bcreate_or_edit_file\s+(?:"([^"\n]+)"|(\S+))\s+("(?:[^"\\]|\\[\s\S])*?")/g;
  while ((match = createOrEditPositionalRe.exec(content)) !== null) {
    try {
      const filepath = match[1] || match[2];
      results.push({
        function: {
          name: 'create_or_edit_file',
          arguments: {
            filename: filepath,
            content: JSON.parse(match[3])
          }
        }
      });
    } catch { /* ignore */ }
  }

  // Match replace_in_file "filepath" "old_text" "new_text" or replace_in_file path "old_text" "new_text" positional format.
  const replacePositionalRe = /\breplace_in_file\s+(?:"([^"\n]+)"|(\S+))\s+("(?:[^"\\]|\\[\s\S])*?")\s+("(?:[^"\\]|\\[\s\S])*?")/g;
  while ((match = replacePositionalRe.exec(content)) !== null) {
    try {
      const filepath = match[1] || match[2];
      results.push({
        function: {
          name: 'replace_in_file',
          arguments: {
            filepath: filepath,
            old_text: JSON.parse(match[3]),
            new_text: JSON.parse(match[4])
          }
        }
      });
    } catch { /* ignore */ }
  }

  // Bare read_specific_file with no path argument — default to the primary source file.
  // Handles "Executing step 1: read_specific_file" style (model forgets to specify path).
  if (results.length === 0 &&
      /\bread_specific_file\b/.test(content) &&
      !results.some(r => r.function?.name === 'read_specific_file')) {
    results.push({ function: { name: 'read_specific_file', arguments: { filepath: TARGET_FILE } } });
  }

  // Match fenced code blocks — model showing code it intends to write.
  // Auto-detect filename from symbol names when no filename is mentioned.
  if (results.length === 0) {
    const genericFenceRe = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)\n```/g;
    while ((match = genericFenceRe.exec(content)) !== null) {
      const fenceLanguage = String(match[1] ?? '').trim().toLowerCase();
      const codeContent = match[2].trim();
      if (codeContent.length < 50) continue;
      const looksLikeCode = /(?:\b(?:class|interface|enum|struct|trait|impl|func|def|fn|function|const|let|var|type|export|import|package|public|private|protected|namespace|module)\b|[{}();=])/m.test(codeContent);
      const looksLikeKnownFence = !fenceLanguage || ['typescript', 'tsx', 'javascript', 'jsx', 'python', 'go', 'rust', 'java', 'kotlin', 'csharp', 'php', 'ruby', 'swift', 'c', 'cpp'].includes(fenceLanguage);
      const hasDefinitions = looksLikeCode && looksLikeKnownFence;
      if (!hasDefinitions) continue;
      // Try to find filename from surrounding text (200 chars before the block)
      const textBefore = content.substring(Math.max(0, match.index - 200), match.index);
      const bt = String.fromCharCode(96);
      const filenameMatch =
        textBefore.match(/(?:file|named?|called|path)\s+['"`]?([\w\/.-]+\.[\w]+)['"`]?/i) ||
        textBefore.match(new RegExp(bt + '([\\w\\/.-]+\\.[\\w]+)' + bt)) ||
        content.substring(match.index + match[0].length).match(new RegExp(bt + '([\\w\\/.-]+\\.[\\w]+)' + bt));
      let filename;
      if (filenameMatch) {
        filename = filenameMatch[1].includes('/') ? filenameMatch[1] : `src/${filenameMatch[1]}`;
      } else {
        const symbolNames = [...codeContent.matchAll(/(?:export\s+)?(?:interface|class|enum|type|struct|trait|impl|func|def)\s+(\w+)/g)].map(m => m[1]);
        const extension = path.extname(TARGET_FILE) || '.txt';
        if (symbolNames.length === 1) filename = (TARGET_DIR === '.' ? `${symbolNames[0]}${extension}` : `${TARGET_DIR}/${symbolNames[0]}${extension}`);
        else if (symbolNames.length > 1) filename = SUGGESTED_TYPES_FILE;
      }
      if (filename) {
        results.push({ function: { name: 'create_or_edit_file', arguments: { filename, content: codeContent } } });
      }
    }
  }

  // Match {"tool": "tool_name", "args": {...}} — text-tool format used by gemma4 and similar models
  // that receive tool descriptions in the system prompt rather than native Ollama tools.
  if (content.includes('"tool"') || content.includes('"tool_name"')) {
    const toolKeyRe = /\{[\s]*"(?:tool|tool_name)"/g;
    let tkm;
    while ((tkm = toolKeyRe.exec(content)) !== null) {
      const start = tkm.index;
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
        try { obj = JSON.parse(content.substring(start, end + 1)); } catch {
          try { obj = JSON.parse(escapeJsonStringValues(content.substring(start, end + 1))); } catch { /* ignore */ }
        }
        const toolName = obj?.tool ?? obj?.tool_name;
        const args = obj?.args ?? obj?.arguments ?? obj?.parameters;
        if (toolName && typeof toolName === 'string' && args !== undefined && typeof args === 'object') {
          results.push({ function: { name: remapToolName(toolName), arguments: remapArgs(args) } });
        }
      }
    }
  }

  return results;
}

// ─── Degenerate output detection (repetitive garbage like "node node node") ──
function isDegenerateOutput(content) {
  const trimmed = content.trim();
  if (trimmed.length < 80) return false;
  // Strip markdown formatting and punctuation, then tokenize
  const cleaned = trimmed.replace(/[*_~`#>|\-\u2014=[\](){}]/g, ' ');
  const words = cleaned.split(/\s+/).map(w => w.toLowerCase().replace(/[^a-z0-9]/g, '')).filter(w => w.length > 0);
  if (words.length < 20) return false;
  // Count word frequencies
  const freq = new Map();
  for (const w of words) {
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  // If any single word dominates (>50% of all tokens and appears 15+ times)
  for (const [, count] of freq) {
    if (count >= 15 && count / words.length > 0.5) {
      return true;
    }
  }
  // Ultra-low vocabulary: <5% unique words among 50+ words
  if (words.length >= 50 && freq.size / words.length < 0.05) {
    return true;
  }
  // Identifier soup: random proper names / bracket tokens, no coherent code structure
  // (phi4-mini style: "Mark Bob Kevin teacher X[] [ sequential ...")
  const rawWords = trimmed.split(/\s+/);
  if (rawWords.length >= 40) {
    const upperOrBracket = rawWords.filter(w => /^[A-Z][a-z]+$/.test(w) || /^[\[\](){}<>]+$/.test(w));
    const hasCodeLikeContent = /(?:function|const|let|var|return|import|export|package|func |class |interface |def |\bif\b|\bfor\b|\bwhile\b)/.test(trimmed);
    if (!hasCodeLikeContent && upperOrBracket.length / rawWords.length > 0.35) {
      return true;
    }
  }
  // High bracket density with many tokens: token soup regardless of capitalization pattern
  // (phi4-mini emits long strings with lots of [ ] brackets scattered throughout)
  if (trimmed.length > 500 && rawWords.length >= 40) {
    const bracketChars = (trimmed.match(/[\[\]{}]/g) ?? []).length;
    const hasCodeFences = trimmed.includes('```');
    if (!hasCodeFences && bracketChars / trimmed.length > 0.08) {
      return true;
    }
  }
  return false;
}

async function tryRecoverFromDegenerateOutput(messages, content, retryCount, turn) {
  if (MANUL_MODE === 'chat') return false;
  if (MODEL_LIMITS.tier === 'large' || MODEL_LIMITS.tier === 'xlarge') return false;

  const degenerateNudgeCount = messages.filter(
    message => message.role === 'user'
      && typeof message.content === 'string'
      && message.content.includes('Your last response was incoherent or repetitive')
  ).length;
  if (degenerateNudgeCount >= 1) return false;

  const starterFilepath = inferDegenerateRecoveryStarterFilepath(userPrompt);
  const writeRecovery = REQUIRES_FILE_WRITE;
  const nudge = writeRecovery
    ? `Your last response was incoherent or repetitive. Reset completely. Do NOT explain, summarize, or plan. Call exactly ONE tool now.${starterFilepath ? ` For this greenfield create task, start by calling create_or_edit_file for ${starterFilepath} with the complete working implementation.` : ' For a create request, your next response should usually be create_or_edit_file with a concrete file path and the full implementation.'} Do not output prose before the tool call.`
    : 'Your last response was incoherent or repetitive. Reset completely. Do NOT explain or plan. Either answer briefly in plain text now, or call exactly ONE read tool if you truly need file context first.';

  label(Y, 'DEGENERATE RETRY', nudge.substring(0, 220));
  logEvent('degenerate_output_retry', { turn, retryCount, tier: MODEL_LIMITS.tier, starterFilepath: starterFilepath ?? null, requiresWrite: writeRecovery });
  messages.push({ role: 'assistant', content, hiddenFromTranscript: true });
  messages.push({ role: 'user', content: nudge });
  return true;
}

function isSyntheticToolResultText(content) {
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (/(?:<tool_response>|\[tool_response\])/i.test(trimmed)) return true;

  const jsonLikeContent = (trimmed.match(/```json\s*([\s\S]*?)```/i)?.[1] ?? trimmed).trim();
  if (!/"(?:tool|tool_name)"\s*:\s*"/i.test(jsonLikeContent)) {
    return false;
  }

  const hasKnownToolName = /"(?:tool|tool_name)"\s*:\s*"(?:build_verify|create_or_edit_file|replace_in_file|read_file_slice|read_specific_file|read_active_file|execute_terminal_command|launch_in_terminal|delete_file|list_workspace_files|project_scan|read_workspace_notes)"/i.test(jsonLikeContent);
  const hasToolResultKeys = /"(?:ok|result|exitCode|stdout|stderr|path|startLine|endLine|replacements|command|projectRoot|stack)"\s*:/i.test(jsonLikeContent);
  return hasKnownToolName && hasToolResultKeys;
}

// ─── Simple nudge analysis (matches key detectors in processOllamaResponse) ──
function analyzeResponse(content, recentMessages) {
  const hasToolResults = recentMessages.some(m => m.role === 'tool');
  const isLong = content.length > 300;
  const progressLines = content.trim().split('\n').map(l => l.trim()).filter(Boolean);
  const isProgressOnly = content.trim().length < 220 &&
    progressLines.every(l => /^(?:step\s+\d+\s*(?:\/|of)\s*\d+|step\s+\d+\s+completed|execut(?:e|ing)\s+step\s+\d+|reading|i(?:'ll| will)\s+read)/i.test(l));
  const isHallucinatingToolResponse = /<tool_response>/.test(content) || (hasToolResults && isSyntheticToolResultText(content));
  const isAnnouncedButNotExecuted = /(?:execut(?:e|ing)|proceed(?:ing)?\s+with)\s+(?:with\s+)?step\s+\d+\s*[:/.,!]?/i.test(content) || /step \d+\/\d+:\s*\w/i.test(content);
  const isPassingToUser = /(?:please (?:execute|run|proceed|confirm|provide|read)|would you like me to|shall i (?:proceed|continue)|can you (?:provide|share)|could you (?:provide|share))/i.test(content) && content.length < 800;
  const claimsDone = /(?:step \d+ completed|successfully applied|file (?:created|updated)|has been (?:created|moved|split)|(?<!\w)done\b(?![\s]*[:;{,=(])|(?:all (?:required )?)?tool calls? (?:have )?succeeded|(?:file )?splitting is complete|task(?:s)? (?:is |are )?complete)/i.test(content);  // Mentions a known tool name but parseToolCallsFromText couldn't extract a valid call
  const claimsFailure = /(?:failed to|unable to|could(?: not|n't)|did not|was not|were not|not created|not updated|creation failed|update failed|tool call failed|error occurred|encountered (?:an|a) (?:problem|issue|error)|не удалось|не вдалось|не получилось|не вдалося|не смог(?:ла|ли)?|не створ(?:ив|ено)|не онов(?:ив|лено)|не змог(?:ла|ли)?|помилка|ошибка)/i.test(content)
    && !/(?:no (?:errors?|issues?|problems?)|without errors?|verified successfully|verification passed|build verification passed)/i.test(content);
  const parsedFromContent = parseToolCallsFromText(content);
  const lowerContent = content.toLowerCase();
  const mentionsToolButNotCalled = parsedFromContent.length === 0 && ALL_TOOL_NAMES.some(t => lowerContent.includes(t.toLowerCase()));  // looksLikePlan: numbered list. After tool results, also fire when content ends with an execute instruction.
  const endsWithExecute = /execut(?:e|ing)\s+step\s+\d+/i.test(content);
  const looksLikePlan = (
    !hasToolResults || endsWithExecute
  ) &&
    /^\s*\d+\.\s+.{10,}/m.test(content) &&
    content.length > 60 &&
    !isAnnouncedButNotExecuted;

  // Broader plan detection: markdown heading + numbered bold items (matches provider's isPlanOnlyResponse)
  const isPlanOnlyResponse = /^#{1,3}\s+(?:Plan|Steps?|Implementation|Approach)/mi.test(content) &&
    /\d+\.\s+\*\*/.test(content);

  const requiresContinuation = isProgressOnly || isAnnouncedButNotExecuted || isPassingToUser || isHallucinatingToolResponse || claimsFailure ||
    (claimsDone && !hasToolResults) || isLong || mentionsToolButNotCalled || isPlanOnlyResponse;

  return { isLong, isProgressOnly, isAnnouncedButNotExecuted, isPassingToUser, isHallucinatingToolResponse, claimsDone, claimsFailure, mentionsToolButNotCalled, looksLikePlan: looksLikePlan || isPlanOnlyResponse, requiresContinuation };
}

// Builds the reminder message injected after a new extraction file is created.
// Includes actual read content so the model can copy old_text exactly.
function buildReplaceReminder(createdPath, newFileContent, allRecentReads) {
  const exportNames = extractSymbolNamesFromContent(newFileContent, createdPath);

  let msg = `File ${path.basename(createdPath)} created. Now call replace_in_file on ${TARGET_FILE} to replace the original ${exportNames[0] ?? 'block'} definition with the appropriate module reference or equivalent update.\n`;

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
      msg += `\nSet old_text to this EXACT block (copy precisely, do NOT include any unrelated lines above it):\n\`\`\`${TARGET_CODE_FENCE}\n${exactBlock}\n\`\`\`\n`;
    } else {
      msg += `\nContent at lines ${bestRead.startLine}\u2013${bestRead.endLine} of ${TARGET_FILE}:\n\`\`\`${TARGET_CODE_FENCE}\n${bestRead.content.substring(0, 900)}${bestRead.content.length > 900 ? '\n...' : ''}\n\`\`\`\n`;
      msg += `Set old_text = ONLY the block that defines ${exportNames[0] ?? 'the extracted code'} (the definition or implementation body, NOT unrelated imports or headers).\n`;
    }
  } else {
    msg += `Use read_file_slice to read the section of ${path.basename(TARGET_FILE)} where ${exportNames[0] ?? 'the extracted code'} is defined, then set old_text to that exact block.\n`;
  }

  if (exportNames.length > 0) {
    msg += `Set new_text to the appropriate module reference, for example: \`${buildModuleReferenceExample(createdPath, exportNames)}\`\n`;
  }

  return msg;
}

function buildNudge(analysis, lastToolWasError, ctx = {}) {
  const { pendingReplaceAfterCreate: pReplace, lastSuccessfulRead: lastRead, lastCreatedFileState: lastCreated, hadSuccessfulWrite } = ctx;

  // Context-rich nudge when a new file was created but replace_in_file hasn't succeeded yet
  if (pReplace && lastCreated) {
    let nudge = `You MUST call replace_in_file on ${TARGET_FILE} NOW. You already created ${path.basename(lastCreated.filePath)}.`;
    if (lastRead && lastRead.content) {
      nudge += `\nContent at lines ${lastRead.startLine}–${lastRead.endLine} of ${path.basename(TARGET_FILE)}:\n\`\`\`${TARGET_CODE_FENCE}\n${lastRead.content.substring(0, 700)}\n\`\`\``;
      nudge += `\nCopy ONLY the exact block that defines ${lastCreated.exportNames.slice(0, 3).join(', ')} as old_text (do NOT include the import statements at the top).`;
    }
    if (lastCreated.exportNames.length > 0) {
      nudge += `\nnew_text should be the appropriate module reference, for example: \`${buildModuleReferenceExample(lastCreated.filePath, lastCreated.exportNames)}\``;
    }
    nudge += `\nCall replace_in_file now — do NOT describe it in text, execute the tool call.`;
    return nudge;
  }

  if (analysis.isHallucinatingToolResponse) {
    const { pendingReplaceAfterCreate, lastCreatedFileState, extractionContinuationPending, lastSuccessfulRead, extractionCount } = ctx;
    if (pendingReplaceAfterCreate && lastCreatedFileState) {
      const names = lastCreatedFileState.exportNames?.join(', ') ?? 'the extracted types';
      return `The tool result is already recorded. Do NOT echo tool results. Call replace_in_file on ${TARGET_FILE} now to replace the original ${names} block with the appropriate module reference or equivalent update.`;
    }
    if (extractionContinuationPending) {
      const nextStart = (lastSuccessfulRead?.endLine ?? 120) + 1;
      return `The tool result is already recorded. Do NOT echo tool results. Read the next section — use read_file_slice with lines ${nextStart}–${nextStart + 119} — then extract another block.`;
    }
    if (!IS_SPLIT_TASK && hadSuccessfulWrite) {
      return 'The real tool result is already recorded. Do NOT echo or invent JSON tool results. Reply with a short plain-text completion summary only.';
    }
    return 'The tool result is already recorded. Do NOT echo or repeat tool results in your response. Proceed with the next action.';
  }
  if (analysis.isAnnouncedButNotExecuted) {
    const { pendingReplaceAfterCreate: pReplace, lastCreatedFileState: lastCreated, extractionContinuationPending: contPending, lastSuccessfulRead: lastRead } = ctx;
    if (pReplace && lastCreated) {
      const names = lastCreated.exportNames?.join(', ') ?? 'the extracted types';
      return `Stop writing. Call replace_in_file NOW on ${TARGET_FILE} to replace the original ${names} block with the appropriate module reference or equivalent update. Do not describe it — call the tool.`;
    }
    if (contPending && lastRead) {
      const nextStart = lastRead.endLine + 1;
      return `Stop writing. Call read_file_slice NOW: filepath="${TARGET_FILE}", startLine=${nextStart}, endLine=${nextStart + 119}. Then create a new module file and call replace_in_file. No preamble.`;
    }
    if (lastRead) {
      return `Stop writing. You already read lines ${lastRead.startLine}–${lastRead.endLine}. Now call create_or_edit_file to create a new file with the extracted real code. Do not describe it — call the tool.`;
    }
    return IS_SPLIT_TASK
      ? `Stop writing plans. Call a tool NOW — use read_file_slice on ${TARGET_FILE} to start.`
      : 'Stop writing plans. Call create_or_edit_file NOW with the file path and content. Do not describe what you will do — call the tool.';
  }
  if (analysis.isPassingToUser) {
    return IS_SPLIT_TASK
      ? 'Do not ask the user anything. You have all the tools you need. Use read_file_slice to read the source file, copy the actual code, and call create_or_edit_file with that real code.'
      : 'Do not ask the user anything. You have all the tools you need. Call create_or_edit_file to create files, or execute_terminal_command to run setup commands.';
  }
  if (analysis.claimsFailure) {
    if (hadSuccessfulWrite) {
      return 'The previous real tool result already shows a successful file write. Do NOT claim that the file was not created or updated. Either continue with the next real tool step, or reply with a short plain-text completion summary only.';
    }
    return 'You claimed that the task or tool call failed. Check the actual tool results in context, then either retry with corrected parameters or continue from the real successful state. Do not contradict the recorded tool output.';
  }
  if (lastToolWasError) {
    return IS_SPLIT_TASK
      ? 'The last tool call failed. Read the error, then call read_file_slice on the source file to get the actual code, and retry create_or_edit_file with the real extracted code (not placeholder comments).'
      : 'The last tool call failed. Read the error, adjust the arguments, and retry the tool call.';
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
  if (REQUIRES_FILE_WRITE && !ctx.hadSuccessfulWrite) {
    return IS_SPLIT_TASK
      ? 'This task requires a real file change, but no file write has succeeded yet. Call create_or_edit_file or replace_in_file now instead of describing the result in text.'
      : 'This task requires creating files, but no file has been written yet. Call create_or_edit_file now with the actual file content — do not describe what you will write, just call the tool.';
  }
  return IS_SPLIT_TASK
    ? 'You described changes but did not call a tool. Call the appropriate tool now.'
    : 'You described what to do but did not call a tool. Call create_or_edit_file, execute_terminal_command, or the appropriate tool now.';
}

function inferReadRangeFromNarration(content, fallbackStart, fallbackEnd) {
  const explicitRangeMatch = content.match(/lines?\s+(\d+)\s*(?:[-–—]|to)\s*(\d+)/i);
  if (explicitRangeMatch) {
    const startLine = Number(explicitRangeMatch[1]);
    const endLine = Number(explicitRangeMatch[2]);
    if (Number.isFinite(startLine) && Number.isFinite(endLine) && startLine >= 1 && endLine >= startLine) {
      return { startLine, endLine };
    }
  }
  return { startLine: fallbackStart, endLine: fallbackEnd };
}

function inferCreateFileArgsFromContext(lastRead, lastCreated) {
  if (!lastRead?.content) return null;
  const extractedContent = extractDefinitionsFromSource(lastRead.content, lastRead.filepath || TARGET_FILE);
  if (!extractedContent || extractedContent.trim().length < 20) return null;
  const symbolNames = extractSymbolNamesFromContent(extractedContent, lastRead.filepath || TARGET_FILE);
  const extension = path.extname(lastRead.filepath || TARGET_FILE) || TARGET_EXTENSION;
  const filename = lastCreated?.filePath
    ? path.relative(wsRoot, lastCreated.filePath)
    : (symbolNames.length === 1
      ? (TARGET_DIR === '.' ? `${symbolNames[0]}${extension}` : `${TARGET_DIR}/${symbolNames[0]}${extension}`)
      : SUGGESTED_TYPES_FILE);
  return { filename, content: extractedContent };
}

function inferReplaceArgsFromContext(lastRead, lastCreated) {
  if (!lastRead?.content || !lastCreated?.filePath) return null;
  const oldText = extractDefinitionsFromSource(lastRead.content, TARGET_FILE);
  const newText = buildExactModuleReference(lastCreated.filePath, lastCreated.exportNames);
  if (!oldText || !newText) return null;
  return { filepath: TARGET_FILE, old_text: oldText, new_text: newText };
}

function inferBootstrapToolCall(content, ctx = {}) {
  const text = String(content ?? '').trim();
  if (!text) return null;

  const lower = text.toLowerCase();
  const mentionsReadSlice = /\bread_file_slice\b/.test(lower) || /\bread\b.*(?:bounded|next|target|section|slice|line range|lines?)/i.test(text);
  const mentionsReadSpecific = /\bread_specific_file\b/.test(lower) || /\bread\b.*\bfile\b/i.test(text);
  const mentionsCreate = /\bcreate_or_edit_file\b/.test(lower) || /\bcreate\b.*\b(?:file|module)\b/i.test(text) || /\bextract\b.*\b(?:file|module)\b/i.test(text);
  const mentionsReplace = /\breplace_in_file\b/.test(lower) || /\breplace\b.*\b(?:block|file|definition|original)\b/i.test(text) || /\bupdate\b.*\boriginal\b/i.test(text);
  const mentionsList = /\blist_workspace_files\b/.test(lower) || /\blist\b.*\bworkspace\b/i.test(text) || /\binspect\b.*\bdirectory\b/i.test(text);

  if (ctx.pendingReplaceAfterCreate && ctx.lastCreatedFileState && (mentionsReplace || ctx.analysis?.isAnnouncedButNotExecuted || ctx.analysis?.mentionsToolButNotCalled)) {
    const replaceArgs = inferReplaceArgsFromContext(ctx.lastSuccessfulRead, ctx.lastCreatedFileState);
    if (replaceArgs) {
      return {
        toolCall: { function: { name: 'replace_in_file', arguments: replaceArgs } },
        reason: 'bootstrap narrated replace_in_file from split-flow state',
        signature: `replace_in_file|${replaceArgs.filepath}|${ctx.lastCreatedFileState.filePath}`
      };
    }
  }

  if (ctx.extractionContinuationPending && (mentionsReadSlice || mentionsReadSpecific || ctx.analysis?.isAnnouncedButNotExecuted)) {
    const fallbackStart = (ctx.lastSuccessfulRead?.endLine ?? 0) + 1 || 1;
    const fallbackEnd = fallbackStart + 119;
    const range = inferReadRangeFromNarration(text, fallbackStart, fallbackEnd);
    return {
      toolCall: { function: { name: 'read_file_slice', arguments: { filepath: TARGET_FILE, startLine: range.startLine, endLine: range.endLine } } },
      reason: 'bootstrap narrated continuation read_file_slice',
      signature: `read_file_slice|${TARGET_FILE}|${range.startLine}|${range.endLine}`
    };
  }

  if (!ctx.pendingReplaceAfterCreate && !ctx.hadSuccessfulWrite && ctx.lastSuccessfulRead?.content && (mentionsCreate || ctx.analysis?.mentionsToolButNotCalled)) {
    const createArgs = inferCreateFileArgsFromContext(ctx.lastSuccessfulRead, ctx.lastCreatedFileState);
    if (createArgs) {
      return {
        toolCall: { function: { name: 'create_or_edit_file', arguments: createArgs } },
        reason: 'bootstrap narrated create_or_edit_file from last successful read',
        signature: `create_or_edit_file|${createArgs.filename}`
      };
    }
  }

  if (mentionsList && !ctx.lastSuccessfulRead && !ctx.hadSuccessfulWrite) {
    return {
      toolCall: { function: { name: 'list_workspace_files', arguments: { directory: '.' } } },
      reason: 'bootstrap narrated list_workspace_files',
      signature: 'list_workspace_files|.'
    };
  }

  if (mentionsReadSlice || mentionsReadSpecific || ctx.analysis?.isAnnouncedButNotExecuted) {
    const fallbackStart = ctx.lastSuccessfulRead ? ctx.lastSuccessfulRead.endLine + 1 : 1;
    const fallbackEnd = fallbackStart + 119;
    const range = inferReadRangeFromNarration(text, fallbackStart, fallbackEnd);
    return {
      toolCall: { function: { name: 'read_file_slice', arguments: { filepath: TARGET_FILE, startLine: range.startLine, endLine: range.endLine } } },
      reason: 'bootstrap narrated read_file_slice',
      signature: `read_file_slice|${TARGET_FILE}|${range.startLine}|${range.endLine}`
    };
  }

  return null;
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  label(B, 'CONFIG', `Model: ${MODEL} | ${OLLAMA_URL} | DryRun: ${DRY_RUN} | MaxTurns: ${MAX_TURNS}`);
  label(B, 'LOG', LOG_FILE);
  label(B, 'PROMPT', userPrompt);
  logEvent('session_start', { model: MODEL, dryRun: DRY_RUN, prompt: userPrompt });

  if (await tryUltraSmallDeterministicFastPath()) {
    label(B, 'SUMMARY', `Fast path completed | Log: ${LOG_FILE}`);
    return;
  }

  const messages = [
    {
      role: 'user',
      content: IS_SPLIT_TASK
        ? 'You are an expert software developer. Call tools directly and immediately — do NOT output numbered plans, step lists, or descriptions of what you will do. ' +
          'When asked to split a file: use read_file_slice to read a section, create_or_edit_file to create the new module file, then replace_in_file to replace the original block with the appropriate module reference or equivalent update. ' +
          'After each successful file write, verify the project using the most appropriate command for the detected stack instead of assuming TypeScript.'
        : 'You are an expert software developer. Call tools directly and immediately — do NOT output numbered plans, step lists, or descriptions of what you will do. ' +
          'When asked to create files: use create_or_edit_file to write each file. When asked to modify existing files: use read_file_slice to read first, then replace_in_file or create_or_edit_file. ' +
          'Use execute_terminal_command for setup commands (npm init, install dependencies, etc.). ' +
          'After creating files, continue with the next file immediately. Do NOT stop after one file — keep going until the task is fully complete.'
    },
    ...(IS_SPLIT_TASK ? [{
      role: 'user',
      content: `Primary target file for this run is ${TARGET_FILE}. Prefer this exact path, or exact sibling paths under ${TARGET_DIR === '.' ? wsRoot : TARGET_DIR}. Do NOT invent shortened or alternate directories for the target file.`
    }] : [{
      role: 'user',
      content: `Workspace root is ${wsRoot}.` +
        (cliTargetFile || process.env.TARGET_FILE
          ? ` The target file for this task is ${TARGET_FILE} (absolute: ${TARGET_ABS_FILE}). Use read_file_slice or read_specific_file to read it.`
          : '') +
        ` Create all project files relative to this workspace root. Use list_workspace_files or project_scan first if you need to understand the existing project structure.`
    }]),
    { role: 'user', content: userPrompt }
  ];

  if (isPreferredSupportedModel(MODEL) && looksLikeGreenfieldCreateTask(userPrompt)) {
    const starterFilepath = inferDegenerateRecoveryStarterFilepath(userPrompt);
    messages.splice(messages.length - 1, 0, {
      role: 'user',
      content: `This is a greenfield creation task. Do NOT call project_scan, list_workspace_files, read_workspace_notes, or write_workspace_notes unless the user explicitly asked about the existing project structure.${starterFilepath ? ` Start by creating one concrete file immediately, preferably ${starterFilepath}, with the complete first working implementation.` : ' Start by creating one concrete file immediately with the first working implementation.'} After that, continue with only the next required file or verification step.`
    });
  }

  let turn = 0;
  let retryCount = 0;
  let hadSuccessfulWrite = false; // tracks if any create_or_edit_file / replace_in_file succeeded
  let lastSuccessfulWritePath = null;
  let pendingReplaceAfterCreate = false; // set after new-file create; cleared after successful replace_in_file
  let lastSuccessfulRead = null;   // { filepath, startLine, endLine, content } — last successful read_file_slice result
  let lastCreatedFileState = null; // { filePath, content, exportNames } — last successfully created extraction file
  let extractionCount = 0;         // how many complete extract-and-replace cycles succeeded
  let extractionContinuationPending = false; // true after replace_in_file success; cleared when model starts next tool call
  const successfulWritePaths = new Set();
  const explicitRequestedWriteTargets = REQUIRES_FILE_WRITE ? extractLikelyRequestFileTargets(userPrompt) : [];
  let targetTotalLinesObserved = 0;
  let targetAppearsExhausted = false;
  let repeatedNarratedCallSignature = null;
  let repeatedNarratedCallCount = 0;
  const recentReads = [];          // all successful read results (capped at 20) for reminder context
  const seenReadSigs = new Map(); // cross-turn dedup: sig -> read count (block after 2 reads)
  let totalReadOps = 0;           // total read operations across the session (for summarize nudge)
  let hadReadWorkspaceNotes = false; // short-circuit repeated reads
  const failedCommandCounts = new Map(); // command signature -> failure count
  let lastNudgedResponseContent = '';  // track identical responses
  let consecutiveIdenticalResponses = 0;
  let blockImmediateTerminalAfterWrite = false;
  let pendingGreenfieldVerificationPath = '';
  let lastGreenfieldVerifiedPath = '';
  let lastWriteVerifyPassed = true; // persists across turns: false if last verify failed and model hasn't fixed yet
  let sessionCompleted = false;
  preferredGreenfieldSuccessfulWriteCount = 0;
  dryRunFiles.clear(); // reset for this session

  const hasMetExtractionGoal = () => {
    if (extractionCount >= 2) return true;
    if (!IS_SPLIT_TASK || extractionCount < 1) return false;
    if (targetAppearsExhausted) return true;
    if (targetTotalLinesObserved <= 0) return false;
    const lastReadEnd = lastSuccessfulRead?.endLine ?? 0;
    const remainingUnreadLines = Math.max(0, targetTotalLinesObserved - lastReadEnd);
    return targetTotalLinesObserved <= 40 || remainingUnreadLines <= 8;
  };

  const getMissingExplicitRequestedWriteTargets = () => {
    if (explicitRequestedWriteTargets.length <= 1) return [];
    return explicitRequestedWriteTargets.filter(target => ![...successfulWritePaths].some(writePath => toolPathMatchesTarget(writePath, target)));
  };

  const hasSatisfiedExplicitWriteRequest = () => explicitRequestedWriteTargets.length > 0 && getMissingExplicitRequestedWriteTargets().length === 0;

  const executeResolvedToolCalls = async (toolCalls, options = {}) => {
    const { assistantContent = '', toolCallsPayload = undefined, recoveryLabel = 'BOOTSTRAP TOOL CALL' } = options;
    let hadToolErrorThisRound = false;
    let buildVerifyFailedThisRound = false;

    extractionContinuationPending = false;
    label(Y, recoveryLabel, `Executing ${toolCalls.length} recovered tool call(s)`);
    label(G, 'TOOL CALLS', toolCalls.map(tc => tc.function?.name).join(', '));
    messages.push({ role: 'assistant', content: assistantContent, tool_calls: toolCallsPayload });

    const postToolMessages = [];

    for (const tc of toolCalls) {
      const toolName = tc.function?.name ?? 'unknown';
      const rawArgs = tc.function?.arguments ?? {};
let args = rawArgs;
        if (typeof rawArgs === 'string') {
          try { args = JSON.parse(rawArgs); }
          catch { label(Y, 'TOOL ARG PARSE ERROR', `Tool "${toolName}" received non-JSON arguments; falling back to {}. Raw: ${String(rawArgs).substring(0, 200)}`); args = {}; }
        }

      label(B, `  → ${toolName}`, JSON.stringify(args).substring(0, 150));
      logEvent('tool_exec_start', { tool: toolName, args });

      if (toolName !== 'execute_terminal_command' && toolName !== 'launch_in_terminal' && toolName !== 'create_or_edit_file') {
        blockImmediateTerminalAfterWrite = false;
      }

      if ((toolName === 'execute_terminal_command' || toolName === 'launch_in_terminal') && isGlobalPackageInstallCommand(String(args.command ?? args.cmd ?? ''))) {
        const blockedResult = buildGlobalInstallBlockResult(String(args.command ?? args.cmd ?? ''));
        label(Y, '  BLOCK GLOBAL INSTALL', String(args.command ?? args.cmd ?? ''));
        logEvent('tool_exec_blocked', { tool: toolName, args, reason: 'global_install_blocked' });
        messages.push({ role: 'tool', content: blockedResult, tool_name: toolName });
        messages.push({ role: 'user', content: 'Do not install packages globally. Use local workspace dependencies only when they are genuinely required for this task.' });
        continue;
      }

      if (toolName === 'execute_terminal_command' && SHOULD_BLOCK_IMMEDIATE_DRY_RUN_TERMINAL && blockImmediateTerminalAfterWrite) {
        const blockedResult = buildDryRunTerminalBlockResult(String(args.command ?? ''), lastSuccessfulWritePath);
        label(Y, '  SKIP TERMINAL', 'Blocked immediate execute_terminal_command after create_or_edit_file in DRY_RUN greenfield smoke');
        logEvent('tool_exec_blocked', { tool: toolName, args, reason: 'dry_run_greenfield_post_create_guard', path: lastSuccessfulWritePath });
        messages.push({ role: 'tool', content: blockedResult, tool_name: toolName });
        messages.push({ role: 'user', content: 'Do not run terminal commands immediately after creating a file in this DRY_RUN greenfield smoke. Continue with the next file/tool step or finish the task based on the code you already wrote.' });
        continue;
      }

      if ((toolName === 'execute_terminal_command' || toolName === 'launch_in_terminal')
        && pendingGreenfieldVerificationPath
        && !isTerminalReadOnlyInspectionCommand(String(args.command ?? args.cmd ?? ''))) {
        const blockedResult = buildPendingVerifyTerminalBlockResult(String(args.command ?? args.cmd ?? ''), pendingGreenfieldVerificationPath);
        label(Y, '  BLOCK VERIFY-FIRST', path.basename(pendingGreenfieldVerificationPath));
        logEvent('tool_exec_blocked', { tool: toolName, args, reason: 'greenfield_verify_before_run', path: pendingGreenfieldVerificationPath });
        messages.push({ role: 'tool', content: blockedResult, tool_name: toolName });
        messages.push({ role: 'user', content: `Do not run terminal tools yet. The latest file write to ${path.basename(pendingGreenfieldVerificationPath)} must pass syntax verification first.` });
        continue;
      }

      if (toolName === 'read_file_slice' || toolName === 'read_specific_file') {
        const readSig = toolName + '|' + JSON.stringify(args);
        const readCount = seenReadSigs.get(readSig) ?? 0;
        if (readCount >= 2) {
          label(Y, '  ⟳ SKIP DUPE READ', `${toolName} same args already seen ${readCount}x`);
          messages.push({ role: 'tool', content: JSON.stringify({ warning: `Duplicate read — you already read this exact section ${readCount} times. You already have this file content in your context. Do NOT re-read it. Create a NEW sibling file (e.g. ${SUGGESTED_TYPES_FILE}, NOT ${TARGET_FILE}) for the extracted code using create_or_edit_file, then use replace_in_file on ${TARGET_FILE} to replace that block with the correct module reference or equivalent update.` }), tool_name: toolName });
          continue;
        }
        seenReadSigs.set(readSig, readCount + 1);
        totalReadOps++;
      }

      const result = await executeTool(toolName, args);
      const parsed = JSON.parse(result);

      if (parsed.error) {
        hadToolErrorThisRound = true;
        label(R, `  ✗ ${toolName}`, parsed.error);
        if (toolName === 'read_file_slice' || toolName === 'read_specific_file') {
          const recoveryTarget = getDeterministicReadRecoveryTargetFromPrompt(userPrompt);
          const attemptedPath = String(parsed.path ?? parsed.filepath ?? args.filepath ?? '').trim();
          if (recoveryTarget && (!attemptedPath || path.basename(attemptedPath).toLowerCase() !== path.basename(recoveryTarget.filepath).toLowerCase())) {
            const recoveredResult = await executeTool('read_specific_file', { filepath: recoveryTarget.filepath });
            const recoveredParsed = JSON.parse(recoveredResult);
            if (!recoveredParsed.error) {
              label(Y, '  RECOVERY', `Deterministic retry -> ${recoveryTarget.filepath}`);
              logEvent('deterministic_read_recovery', { failedTool: toolName, failedPath: attemptedPath || null, recoveredPath: recoveryTarget.filepath, reason: recoveryTarget.reason });
              messages.push({ role: 'tool', content: recoveredResult, tool_name: 'read_specific_file' });
              messages.push({ role: 'user', content: `The previous read used the wrong target. Continue from ${recoveryTarget.filepath}, which was read for you. ${recoveryTarget.reason}` });
              continue;
            }
          }
        }
        if (toolName === 'create_or_edit_file') {
          seenReadSigs.clear();
        }
        if (toolName === 'replace_in_file' && parsed.neverPresentInTarget && pendingReplaceAfterCreate && lastCreatedFileState) {
          const exactBlockMsg = lastSuccessfulRead?.content
            ? `The block you tried to replace does not exist anywhere in ${TARGET_FILE}. Do NOT try to replace code from ${path.basename(lastCreatedFileState.filePath)} or any invented helper block. Use ONLY code that already exists in ${TARGET_FILE} as old_text. Re-read the exact target slice and copy that original block verbatim before calling replace_in_file again.`
            : `The block you tried to replace does not exist anywhere in ${TARGET_FILE}. Do NOT invent a replacement target. Read the exact target slice from ${TARGET_FILE}, then call replace_in_file again using only code that currently exists there as old_text.`;
          messages.push({ role: 'tool', content: JSON.stringify({ warning: exactBlockMsg }), tool_name: 'replace_in_file' });
        }
        if (toolName === 'replace_in_file' && parsed.suggestedSlice) {
          const autoRead = await executeTool('read_file_slice', parsed.suggestedSlice);
          const autoReadParsed = JSON.parse(autoRead);
          if (!autoReadParsed.error && autoReadParsed.content) {
            lastSuccessfulRead = { filepath: String(parsed.suggestedSlice.filepath ?? ''), startLine: parsed.suggestedSlice.startLine, endLine: parsed.suggestedSlice.endLine, content: autoReadParsed.content };
            const autoMsg = `[Auto-read lines ${parsed.suggestedSlice.startLine}–${parsed.suggestedSlice.endLine} to help you fix old_text]:\n\`\`\`${TARGET_CODE_FENCE}\n${autoReadParsed.content.substring(0, 800)}\n\`\`\`\nUse the EXACT text from above as old_text for replace_in_file.`;
            label(Y, '  AUTO-READ', `injected ${autoReadParsed.content.length} chars for old_text context`);
            messages.push({ role: 'tool', content: autoMsg, tool_name: 'read_file_slice' });
          }
        }
      } else {
        label(G, `  ✓ ${toolName}`, result.substring(0, 200));
        if ((toolName === 'read_file_slice' || toolName === 'read_specific_file') && path.normalize(String(parsed.path ?? '')) === TARGET_ABS_FILE) {
          const totalLines = Number(parsed.totalLines ?? 0);
          if (Number.isFinite(totalLines) && totalLines > 0) {
            targetTotalLinesObserved = totalLines;
          }
          const startLine = Number(parsed.startLine ?? args.startLine ?? 1);
          const hasVisibleContent = typeof parsed.content === 'string' && parsed.content.length > 0;
          if (!hasVisibleContent && targetTotalLinesObserved > 0 && startLine > targetTotalLinesObserved) {
            targetAppearsExhausted = true;
          } else if (hasVisibleContent) {
            targetAppearsExhausted = false;
          }
        }
        if ((toolName === 'read_file_slice' || toolName === 'read_specific_file')
          && preferredGreenfieldSuccessfulWriteCount === 0) {
          const greenfieldTargetPath = getDeterministicGreenfieldTargetPath();
          if (greenfieldTargetPath && !toolPathMatchesTarget(parsed.path ?? args.filepath, greenfieldTargetPath)) {
            label(Y, '  WRONG TARGET', `${String(parsed.path ?? args.filepath ?? '')} -> ${greenfieldTargetPath}`);
            logEvent('greenfield_wrong_read_target_recovery', { failedTool: toolName, attemptedPath: String(parsed.path ?? args.filepath ?? ''), recoveredPath: greenfieldTargetPath });
            messages.push({ role: 'user', content: `Wrong file target. For this greenfield task, the primary source file is ${greenfieldTargetPath}. Do not read unrelated files first. Create or update ${greenfieldTargetPath} now unless you truly need a bounded read of that same file.` });
          }
        }
        if (toolName === 'read_file_slice' && parsed.content) {
          lastSuccessfulRead = { filepath: String(args.filepath ?? ''), startLine: args.startLine ?? 1, endLine: args.endLine ?? 1, content: parsed.content };
          recentReads.push(lastSuccessfulRead);
          if (recentReads.length > 20) recentReads.shift();
        }
        if (toolName === 'create_or_edit_file' || toolName === 'replace_in_file') {
          hadSuccessfulWrite = true;
          lastSuccessfulWritePath = String(parsed.path ?? args.filename ?? args.filepath ?? lastSuccessfulWritePath ?? '');
          if (lastSuccessfulWritePath) {
            successfulWritePaths.add(lastSuccessfulWritePath);
          }
          if (toolName === 'create_or_edit_file' && IS_CODE_PREFERRED_GREENFIELD_REQUEST) {
            preferredGreenfieldSuccessfulWriteCount++;
            blockImmediateTerminalAfterWrite = true;
          }
          if (toolName === 'create_or_edit_file' && IS_CODE_PREFERRED_GREENFIELD_REQUEST) {
            pendingGreenfieldVerificationPath = lastSuccessfulWritePath;
            lastGreenfieldVerifiedPath = '';
          }
          if (IS_SPLIT_TASK && toolName === 'create_or_edit_file') {
            const createdPath = parsed.path ?? '';
            const isOriginal = createdPath.includes(TARGET_BASENAME);
            if (!isOriginal) {
              const fileContent = args.content ?? '';
              const exportNames = extractSymbolNamesFromContent(fileContent, createdPath);
              lastCreatedFileState = { filePath: createdPath, content: fileContent, exportNames };
              pendingReplaceAfterCreate = true;
              const reminder = buildReplaceReminder(createdPath, fileContent, recentReads);
              label(Y, '  REMINDER', reminder.substring(0, 400));
              postToolMessages.push({ role: 'user', content: reminder, _type: 'reminder' });
            }
          }
          if (IS_SPLIT_TASK && toolName === 'replace_in_file') {
            pendingReplaceAfterCreate = false;
            extractionCount++;
            extractionContinuationPending = true;
            label(G, '  EXTRACTED', `Cycle ${extractionCount} done. Injecting continuation nudge.`);
            const continueMsg = `Module extraction ${extractionCount} complete. Now read the next section of ${TARGET_FILE} (use a NEW line range you haven't read yet, beyond the block you just replaced) and extract another self-contained block (types, functions, classes, methods, utilities, or similar). Aim to extract at least 3 modules total.`;
            postToolMessages.push({ role: 'user', content: continueMsg, _type: 'continuation' });
          }
        }
      }

      logEvent('tool_exec_result', { tool: toolName, result: result.substring(0, 300) });
      messages.push({ role: 'tool', content: result, tool_name: toolName });
    }

    if (hadSuccessfulWrite) {
      const verifyTargetPath = lastSuccessfulWritePath || lastCreatedFileState?.filePath || resolveFilepath(TARGET_FILE);
      const verifyConfig = pickVerifyCommandForPath(verifyTargetPath);
      if (verifyConfig) {
        if (SHOULD_BLOCK_IMMEDIATE_DRY_RUN_TERMINAL && blockImmediateTerminalAfterWrite) {
          label(Y, 'VERIFY SKIP', 'Skipped immediate auto-verify after create_or_edit_file in DRY_RUN greenfield smoke');
          logEvent('verify_skipped', { reason: 'dry_run_greenfield_post_create_guard', stack: verifyConfig.stack, command: verifyConfig.command, projectRoot: verifyConfig.projectRoot });
        } else {
        label(B, 'VERIFY', `${verifyConfig.stack}: ${verifyConfig.command}`);
        const verifyResult = await runTerminalCommandDirect(`cd ${JSON.stringify(verifyConfig.projectRoot)} && ${verifyConfig.command}`);
        const parsedVerify = JSON.parse(verifyResult);
        const verifyOutput = [String(parsedVerify.stdout ?? ''), String(parsedVerify.stderr ?? '')].filter(Boolean).join('\n').trim();
        buildVerifyFailedThisRound = Number(parsedVerify.exitCode ?? 1) !== 0;
        const verifyOk1 = !buildVerifyFailedThisRound;
        lastWriteVerifyPassed = verifyOk1;
        if (verifyOk1 && pendingGreenfieldVerificationPath) {
          lastGreenfieldVerifiedPath = pendingGreenfieldVerificationPath;
          pendingGreenfieldVerificationPath = '';
          blockImmediateTerminalAfterWrite = false;
        }
        messages.push({
          role: 'tool',
          content: JSON.stringify({
            tool: 'build_verify',
            stack: verifyConfig.stack,
            command: verifyConfig.command,
            projectRoot: verifyConfig.projectRoot,
            ok: verifyOk1,
            result: verifyOk1
              ? `Build verification passed for ${verifyConfig.stack}.`
              : `Build verification failed for ${verifyConfig.stack}:\n${verifyOutput || '(no output)'}`
          }),
          tool_name: 'build_verify'
        });
        if (!verifyOk1) {
          messages.push({ role: 'user', content: `Syntax verification FAILED. Fix all errors shown above, then rewrite the entire file using create_or_edit_file with correct syntax. Do NOT say the task is complete until verification passes.` });
        }
        }
      }
    }

    for (const { _type, ...msg } of postToolMessages) {
      if (_type === 'reminder' && !pendingReplaceAfterCreate) continue;
      messages.push(msg);
    }

    if (IS_EXPLICIT_CREATE_ONLY_TASK
      && hadSuccessfulWrite
      && !hadToolErrorThisRound
      && !buildVerifyFailedThisRound
      && !pendingReplaceAfterCreate
      && hasSatisfiedExplicitWriteRequest()) {
      sessionCompleted = true;
      label(G, 'DONE', 'All explicitly requested files were written and verified — task complete.');
      logEvent('session_done', { turn, reason: 'explicit_create_auto_completion', targets: explicitRequestedWriteTargets });
      return;
    }

    // For non-write tasks, nudge after 3+ reads
    if (!REQUIRES_FILE_WRITE && totalReadOps >= MODEL_LIMITS.maxReadOpsWithoutWrite && !hadSuccessfulWrite) {
      const linesRead = recentReads.length > 0
        ? `lines ${recentReads[0].startLine || 1}–${recentReads[recentReads.length - 1].endLine || '?'}`
        : `${totalReadOps} sections`;
      const readNudge = `You have already read ${linesRead} of the file. You now have enough context. STOP reading additional sections and produce your summary/analysis/answer as a text response NOW. Do NOT call any more tools.`;
      label(Y, 'READ-LOOP NUDGE', readNudge.substring(0, 200));
      messages.push({ role: 'user', content: readNudge });
    }

    retryCount = 0;
    repeatedNarratedCallSignature = null;
    repeatedNarratedCallCount = 0;
  };

  const tryBootstrapPreferredGreenfieldCodeDump = async content => {
    const candidate = extractPreferredGreenfieldCodeDump(content);
    if (!candidate) return false;

    label(Y, 'GREENFIELD CODE BOOTSTRAP', `Recovered a plain-text code dump into create_or_edit_file(${candidate.filepath})`);
    logEvent('preferred_greenfield_code_bootstrap', { turn, model: MODEL, filepath: candidate.filepath, contentPreview: candidate.content.substring(0, 200) });
    await executeResolvedToolCalls([
      { function: { name: 'create_or_edit_file', arguments: { filename: candidate.filepath, content: candidate.content } } }
    ], {
      assistantContent: content,
      recoveryLabel: 'GREENFIELD CODE BOOTSTRAP'
    });
    return true;
  };

  while (turn < MAX_TURNS) {
    if (sessionCompleted) {
      break;
    }
    turn++;
    label(C, `TURN ${turn}`, `retry=${retryCount} messages=${messages.length}`);

    // Sliding window: prevent context overflow based on model size
    if (messages.length > MODEL_LIMITS.maxMessages) {
      const first2 = messages.slice(0, 2); // initial plan + user prompt
      const tailCount = MODEL_LIMITS.maxMessages - 3; // 2 head + 1 trim notice
      const recent = messages.slice(-tailCount);
      const trimNotice = { role: 'user', content: `Context trimmed to prevent overflow. Continue with the task — execute the next required action.` };
      messages.splice(0, messages.length, ...first2, trimNotice, ...recent);
      seenReadSigs.clear(); // allow re-reads after context trim
      label(Y, 'CONTEXT TRIM', `Trimmed to ${messages.length} messages (limit ${MODEL_LIMITS.maxMessages} for model ${MODEL})`);
    }

    logEvent('ollama_request', { turn, retryCount, messageCount: messages.length });

    // useTextTools models (e.g. gemma4) do not support native tool calling in this Ollama version;
    // they receive tool descriptions in the system mandate and emit {"tool":…} JSON in content instead.
    const useTextTools = MODEL_LIMITS.useTextTools === true;
    // For useTextTools models, convert role:'tool' messages to role:'user' so the model understands them.
    const messagesForModel = useTextTools
      ? messages.map(m => m.role === 'tool'
          ? { role: 'user', content: `Tool result (${m.tool_name ?? 'tool'}): ${m.content}` }
          : m)
      : messages;
    const body = {
      model: MODEL,
      stream: false,
      options: { num_ctx: MODEL_LIMITS.numCtx, ...(MODEL_LIMITS.repeatPenalty ? { repeat_penalty: MODEL_LIMITS.repeatPenalty } : {}) },
      messages: [
        { role: 'system', content: MANUL_MODE === 'planner' ? buildPlannerMandate() : buildAgentMandate() },
        ...messagesForModel
      ],
      ...(useTextTools ? {} : { tools: getToolDefinitions() })
    };

    let responseData;
    try {
      const resp = await fetchOllamaChat(body);
      if (!resp.ok) {
        const txt = await resp.text();
        let recoveredFromParseError = false;
        if (resp.status === 500) {
          const rawToolPayload = extractRawToolPayloadFromOllamaError(txt);
          if (rawToolPayload) {
            const recoveredToolCalls = parseToolCallsFromText(rawToolPayload);
            if (recoveredToolCalls.length > 0) {
              label(Y, 'OLLAMA RECOVERY', `Recovered ${recoveredToolCalls.length} tool call(s) from HTTP 500 parse error`);
              logEvent('ollama_parse_error_tool_recovery', {
                recoveredToolCalls: recoveredToolCalls.map(toolCall => toolCall.function?.name ?? 'unknown')
              });
              responseData = { message: { content: rawToolPayload } };
              recoveredFromParseError = true;
            }
          }
        }
        if (!recoveredFromParseError) {
          throw new Error(`HTTP ${resp.status}: ${txt}`);
        }
      }
      if (!responseData) {
        responseData = await resp.json();
      }
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
    const allowedToolNames = new Set(getToolDefinitions().map(tool => tool.function.name));
    const resolvedToolCalls = (nativeToolCalls.length > 0 ? nativeToolCalls : textToolCalls).filter(tc => allowedToolNames.has(String(tc.function?.name ?? '').trim()));
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
      messages.push({ role: 'assistant', content: wasNative ? content : (useTextTools ? content : ''), tool_calls: wasNative ? nativeToolCalls : undefined });

      // Collect reminder/continuation user messages to inject AFTER all tool results, not mid-loop
      const postToolMessages = [];
      const INSPECTION_ONLY_TOOLS = new Set(['read_file_slice', 'read_specific_file', 'list_workspace_files', 'project_scan', 'read_workspace_notes']);
      const toolNamesInBatch = [];
      let hadToolErrorThisRound = false;
      let buildVerifyFailedThisRound = false;

      for (const tc of resolvedToolCalls) {
        const toolName = tc.function?.name ?? 'unknown';
        const rawArgs  = tc.function?.arguments ?? {};
        const args     = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;

        label(B, `  → ${toolName}`, JSON.stringify(args).substring(0, 150));
        logEvent('tool_exec_start', { tool: toolName, args });
        toolNamesInBatch.push(toolName);

        if (toolName !== 'execute_terminal_command' && toolName !== 'launch_in_terminal' && toolName !== 'create_or_edit_file') {
          blockImmediateTerminalAfterWrite = false;
        }

        if ((toolName === 'execute_terminal_command' || toolName === 'launch_in_terminal') && isGlobalPackageInstallCommand(String(args.command ?? args.cmd ?? ''))) {
          const blockedResult = buildGlobalInstallBlockResult(String(args.command ?? args.cmd ?? ''));
          label(Y, '  BLOCK GLOBAL INSTALL', String(args.command ?? args.cmd ?? ''));
          logEvent('tool_exec_blocked', { tool: toolName, args, reason: 'global_install_blocked' });
          messages.push({ role: 'tool', content: blockedResult, tool_name: toolName });
          messages.push({ role: 'user', content: 'Do not install packages globally. Use local workspace dependencies only when they are genuinely required for this task.' });
          continue;
        }

        if (toolName === 'execute_terminal_command' && SHOULD_BLOCK_IMMEDIATE_DRY_RUN_TERMINAL && blockImmediateTerminalAfterWrite) {
          const blockedResult = buildDryRunTerminalBlockResult(String(args.command ?? ''), lastSuccessfulWritePath);
          label(Y, '  SKIP TERMINAL', 'Blocked immediate execute_terminal_command after create_or_edit_file in DRY_RUN greenfield smoke');
          logEvent('tool_exec_blocked', { tool: toolName, args, reason: 'dry_run_greenfield_post_create_guard', path: lastSuccessfulWritePath });
          messages.push({ role: 'tool', content: blockedResult, tool_name: toolName });
          messages.push({ role: 'user', content: 'Do not run terminal commands immediately after creating a file in this DRY_RUN greenfield smoke. Continue with the next file/tool step or finish the task based on the code you already wrote.' });
          continue;
        }

        if ((toolName === 'execute_terminal_command' || toolName === 'launch_in_terminal')
          && pendingGreenfieldVerificationPath
          && !isTerminalReadOnlyInspectionCommand(String(args.command ?? args.cmd ?? ''))) {
          const blockedResult = buildPendingVerifyTerminalBlockResult(String(args.command ?? args.cmd ?? ''), pendingGreenfieldVerificationPath);
          label(Y, '  BLOCK VERIFY-FIRST', path.basename(pendingGreenfieldVerificationPath));
          logEvent('tool_exec_blocked', { tool: toolName, args, reason: 'greenfield_verify_before_run', path: pendingGreenfieldVerificationPath });
          messages.push({ role: 'tool', content: blockedResult, tool_name: toolName });
          messages.push({ role: 'user', content: `Do not run terminal tools yet. The latest file write to ${path.basename(pendingGreenfieldVerificationPath)} must pass syntax verification first.` });
          continue;
        }

        // Cross-turn dedup: skip repeated reads of the same file section (allow each section to be read at most twice)
        if (toolName === 'read_file_slice' || toolName === 'read_specific_file') {
          const readSig = toolName + '|' + JSON.stringify(args);
          const readCount = seenReadSigs.get(readSig) ?? 0;
          if (readCount >= 2) {
            label(Y, `  \u27f3 SKIP DUPE READ`, `${toolName} same args already seen ${readCount}x`);
                messages.push({ role: 'tool', content: JSON.stringify({ warning: `Duplicate read \u2014 you already read this exact section ${readCount} times. You already have this file content in your context. Do NOT re-read it. Create a NEW sibling file (e.g. ${SUGGESTED_TYPES_FILE}, NOT ${TARGET_FILE}) for the extracted code using create_or_edit_file, then use replace_in_file on ${TARGET_FILE} to replace that block with the correct module reference or equivalent update.` }), tool_name: toolName });
            continue;
          }
          seenReadSigs.set(readSig, readCount + 1);
          totalReadOps++;
        }

        // Short-circuit repeated read_workspace_notes calls
        if (toolName === 'read_workspace_notes' && hadReadWorkspaceNotes) {
          label(Y, '  ⟳ SKIP', 'read_workspace_notes already called this session');
          messages.push({ role: 'tool', content: JSON.stringify({ content: '(notes already read — proceed with your task using the tools)' }), tool_name: toolName });
          continue;
        }
        if (toolName === 'read_workspace_notes') hadReadWorkspaceNotes = true;

        const result = await executeTool(toolName, args);
        const parsed = JSON.parse(result);

        if (parsed.error) {
          hadToolErrorThisRound = true;
          label(R, `  ✗ ${toolName}`, parsed.error);
          // After create_or_edit_file fails (e.g. overwrite guard), allow re-reads so model can get fresh context
          if (toolName === 'create_or_edit_file') {
            seenReadSigs.clear();
          }
          if (toolName === 'replace_in_file' && parsed.neverPresentInTarget && pendingReplaceAfterCreate && lastCreatedFileState) {
            const exactBlockMsg = lastSuccessfulRead?.content
              ? `The block you tried to replace does not exist anywhere in ${TARGET_FILE}. Do NOT try to replace code from ${path.basename(lastCreatedFileState.filePath)} or any invented helper block. Use ONLY code that already exists in ${TARGET_FILE} as old_text. Re-read the exact target slice and copy that original block verbatim before calling replace_in_file again.`
              : `The block you tried to replace does not exist anywhere in ${TARGET_FILE}. Do NOT invent a replacement target. Read the exact target slice from ${TARGET_FILE}, then call replace_in_file again using only code that currently exists there as old_text.`;
            messages.push({ role: 'tool', content: JSON.stringify({ warning: exactBlockMsg }), tool_name: 'replace_in_file' });
          }
          // On replace_in_file failure: auto-read the suggested slice so model gets exact old_text
          if (toolName === 'replace_in_file' && parsed.suggestedSlice) {
            const autoRead = await executeTool('read_file_slice', parsed.suggestedSlice);
            const autoReadParsed = JSON.parse(autoRead);
            if (!autoReadParsed.error && autoReadParsed.content) {
              lastSuccessfulRead = { filepath: String(parsed.suggestedSlice.filepath ?? ''), startLine: parsed.suggestedSlice.startLine, endLine: parsed.suggestedSlice.endLine, content: autoReadParsed.content };
              const autoMsg = `[Auto-read lines ${parsed.suggestedSlice.startLine}–${parsed.suggestedSlice.endLine} to help you fix old_text]:\n\`\`\`${TARGET_CODE_FENCE}\n${autoReadParsed.content.substring(0, 800)}\n\`\`\`\nUse the EXACT text from above as old_text for replace_in_file.`;
              label(Y, '  AUTO-READ', `injected ${autoReadParsed.content.length} chars for old_text context`);
              messages.push({ role: 'tool', content: autoMsg, tool_name: 'read_file_slice' });
            }
          }
        } else {
          label(G, `  ✓ ${toolName}`, result.substring(0, 200));
          if ((toolName === 'read_file_slice' || toolName === 'read_specific_file') && path.normalize(String(parsed.path ?? '')) === TARGET_ABS_FILE) {
            const totalLines = Number(parsed.totalLines ?? 0);
            if (Number.isFinite(totalLines) && totalLines > 0) {
              targetTotalLinesObserved = totalLines;
            }
            const startLine = Number(parsed.startLine ?? args.startLine ?? 1);
            const hasVisibleContent = typeof parsed.content === 'string' && parsed.content.length > 0;
            if (!hasVisibleContent && targetTotalLinesObserved > 0 && startLine > targetTotalLinesObserved) {
              targetAppearsExhausted = true;
            } else if (hasVisibleContent) {
              targetAppearsExhausted = false;
            }
          }
          if ((toolName === 'read_file_slice' || toolName === 'read_specific_file')
            && preferredGreenfieldSuccessfulWriteCount === 0) {
            const greenfieldTargetPath = getDeterministicGreenfieldTargetPath();
            if (greenfieldTargetPath && !toolPathMatchesTarget(parsed.path ?? args.filepath, greenfieldTargetPath)) {
              label(Y, '  WRONG TARGET', `${String(parsed.path ?? args.filepath ?? '')} -> ${greenfieldTargetPath}`);
              logEvent('greenfield_wrong_read_target_recovery', { failedTool: toolName, attemptedPath: String(parsed.path ?? args.filepath ?? ''), recoveredPath: greenfieldTargetPath });
              messages.push({ role: 'user', content: `Wrong file target. For this greenfield task, the primary source file is ${greenfieldTargetPath}. Do not read unrelated files first. Create or update ${greenfieldTargetPath} now unless you truly need a bounded read of that same file.` });
            }
          }
          // Track successful reads for replace_in_file reminder context
          if (toolName === 'read_file_slice' && parsed.content) {
            lastSuccessfulRead = { filepath: String(args.filepath ?? ''), startLine: args.startLine ?? 1, endLine: args.endLine ?? 1, content: parsed.content };
            recentReads.push(lastSuccessfulRead);
            if (recentReads.length > 20) recentReads.shift();
          }
          if (toolName === 'create_or_edit_file' || toolName === 'replace_in_file') {
            hadSuccessfulWrite = true;
            lastSuccessfulWritePath = String(parsed.path ?? args.filename ?? args.filepath ?? lastSuccessfulWritePath ?? '');
            if (lastSuccessfulWritePath) {
              successfulWritePaths.add(lastSuccessfulWritePath);
            }
            if (toolName === 'create_or_edit_file' && IS_CODE_PREFERRED_GREENFIELD_REQUEST) {
              preferredGreenfieldSuccessfulWriteCount++;
              blockImmediateTerminalAfterWrite = true;
            }
            if (toolName === 'create_or_edit_file' && IS_CODE_PREFERRED_GREENFIELD_REQUEST) {
              pendingGreenfieldVerificationPath = lastSuccessfulWritePath;
              lastGreenfieldVerifiedPath = '';
            }
            // After creating a NEW file (not the main refactor target), remind model to replace in original — SPLIT TASKS ONLY
            if (IS_SPLIT_TASK && toolName === 'create_or_edit_file') {
              const createdPath = parsed.path ?? '';
              const isOriginal = createdPath.includes(TARGET_BASENAME);
              if (!isOriginal) {
                const fileContent = args.content ?? '';
                const exportNames = extractSymbolNamesFromContent(fileContent, createdPath);
                lastCreatedFileState = { filePath: createdPath, content: fileContent, exportNames };
                pendingReplaceAfterCreate = true;
                const reminder = buildReplaceReminder(createdPath, fileContent, recentReads);
                label(Y, '  REMINDER', reminder.substring(0, 400));
                postToolMessages.push({ role: 'user', content: reminder, _type: 'reminder' });
              }
            }
            if (IS_SPLIT_TASK && toolName === 'replace_in_file') {
              pendingReplaceAfterCreate = false; // replace succeeded — cycle complete
              extractionCount++;
              extractionContinuationPending = true; // wait for model to start next cycle
              label(G, '  EXTRACTED', `Cycle ${extractionCount} done. Injecting continuation nudge.`);
              const continueMsg = `Module extraction ${extractionCount} complete. Now read the next section of ${TARGET_FILE} (use a NEW line range you haven't read yet, beyond the block you just replaced) and extract another self-contained block (types, functions, classes, methods, utilities, or similar). Aim to extract at least 3 modules total.`;
              postToolMessages.push({ role: 'user', content: continueMsg, _type: 'continuation' });
            }
          }
        }
        logEvent('tool_exec_result', { tool: toolName, result: result.substring(0, 300) });

        messages.push({ role: 'tool', content: result, tool_name: toolName });

        // ── Repeated failing command detection ──
        if (toolName === 'execute_terminal_command') {
          try {
            const cmdParsed = JSON.parse(result);
            const exitCode = Number(cmdParsed.exitCode ?? 0);
            const coreSig = String(cmdParsed.command ?? '').replace(/^cd\s+\S+\s*&&\s*/, '').trim();
            if (exitCode !== 0 && coreSig) {
              const count = (failedCommandCounts.get(coreSig) ?? 0) + 1;
              failedCommandCounts.set(coreSig, count);
              if (count >= 2) {
                const nudge = `The command "${coreSig}" has failed ${count} times with the same error (exit code ${exitCode}). STOP retrying it. Try a completely different approach — for example, write the config file manually instead of relying on a CLI tool, or use a different package/tool.`;
                label(Y, 'FAILING-CMD NUDGE', nudge.substring(0, 200));
                messages.push({ role: 'user', content: nudge });
              }
            } else if (exitCode === 0 && coreSig) {
              failedCommandCounts.delete(coreSig);
            }
          } catch (_) { /* non-JSON result — skip */ }
        }
      }

      if (hadSuccessfulWrite) {
        const verifyTargetPath = lastSuccessfulWritePath || lastCreatedFileState?.filePath || resolveFilepath(TARGET_FILE);
        const verifyConfig = pickVerifyCommandForPath(verifyTargetPath);
        if (verifyConfig) {
          if (SHOULD_BLOCK_IMMEDIATE_DRY_RUN_TERMINAL && blockImmediateTerminalAfterWrite) {
            label(Y, 'VERIFY SKIP', 'Skipped immediate auto-verify after create_or_edit_file in DRY_RUN greenfield smoke');
            logEvent('verify_skipped', { reason: 'dry_run_greenfield_post_create_guard', stack: verifyConfig.stack, command: verifyConfig.command, projectRoot: verifyConfig.projectRoot });
          } else {
          label(B, 'VERIFY', `${verifyConfig.stack}: ${verifyConfig.command}`);
          const verifyResult = await runTerminalCommandDirect(`cd ${JSON.stringify(verifyConfig.projectRoot)} && ${verifyConfig.command}`);
          const parsedVerify = JSON.parse(verifyResult);
          const verifyOutput = [String(parsedVerify.stdout ?? ''), String(parsedVerify.stderr ?? '')].filter(Boolean).join('\n').trim();
          buildVerifyFailedThisRound = Number(parsedVerify.exitCode ?? 1) !== 0;
          const verifyOk2 = !buildVerifyFailedThisRound;
          lastWriteVerifyPassed = verifyOk2;
          if (verifyOk2 && pendingGreenfieldVerificationPath) {
            lastGreenfieldVerifiedPath = pendingGreenfieldVerificationPath;
            pendingGreenfieldVerificationPath = '';
            blockImmediateTerminalAfterWrite = false;
          }
          messages.push({
            role: 'tool',
            content: JSON.stringify({
              tool: 'build_verify',
              stack: verifyConfig.stack,
              command: verifyConfig.command,
              projectRoot: verifyConfig.projectRoot,
              ok: verifyOk2,
              result: verifyOk2
                ? `Build verification passed for ${verifyConfig.stack}.`
                : `Build verification failed for ${verifyConfig.stack}:\n${verifyOutput || '(no output)'}`
            }),
            tool_name: 'build_verify'
          });
          if (!verifyOk2) {
            messages.push({ role: 'user', content: `Syntax verification FAILED. Fix all errors shown above, then rewrite the entire file using create_or_edit_file with correct syntax. Do NOT say the task is complete until verification passes.` });
          }
          }
        }
      }

      // Inject reminder/continuation after all tool results (correct message ordering)
      for (const { _type, ...msg } of postToolMessages) {
        // Skip the reminder if the same batch already handled replace_in_file (pendingReplaceAfterCreate=false)
        if (_type === 'reminder' && !pendingReplaceAfterCreate) continue;
        messages.push(msg);
      }

      if (IS_EXPLICIT_CREATE_ONLY_TASK
        && hadSuccessfulWrite
        && !hadToolErrorThisRound
        && !buildVerifyFailedThisRound
        && !pendingReplaceAfterCreate
        && hasSatisfiedExplicitWriteRequest()) {
        label(G, 'DONE', 'All explicitly requested files were written and verified — task complete.');
        logEvent('session_done', { turn, reason: 'explicit_create_auto_completion', targets: explicitRequestedWriteTargets });
        sessionCompleted = true;
      }

      // For non-write tasks (summarize, explain, review), nudge the model to stop reading and produce output
      if (!REQUIRES_FILE_WRITE && totalReadOps >= MODEL_LIMITS.maxReadOpsWithoutWrite && !hadSuccessfulWrite) {
        const linesRead = recentReads.length > 0
          ? `lines ${recentReads[0].startLine || 1}–${recentReads[recentReads.length - 1].endLine || '?'}`
          : `${totalReadOps} sections`;
        const readNudge = `You have already read ${linesRead} of the file. You now have enough context. STOP reading additional sections and produce your summary/analysis/answer as a text response NOW. Do NOT call any more tools.`;
        label(Y, 'READ-LOOP NUDGE', readNudge.substring(0, 200));
        messages.push({ role: 'user', content: readNudge });
      }

      // Preserve retryCount when all tools were inspection-only (model isn't making progress)
      const allInspectionOnly = toolNamesInBatch.length > 0 && toolNamesInBatch.every(t => INSPECTION_ONLY_TOOLS.has(t));
      if (!allInspectionOnly) {
        retryCount = 0;
      }
      repeatedNarratedCallSignature = null;
      repeatedNarratedCallCount = 0;
      continue;
    }

    // ── Text response ──
    // Detect Qwen token overflow markers as empty response
    const isTokenOverflow = /^<\|im_(?:start|end|sep)\|>/.test(content.trim()) && content.trim().length < 30;
    // Detect echo: model parroted back a recent user message verbatim
    const lastUserMsgs = messages.filter(m => m.role === 'user').slice(-3).map(m => m.content.trim());
    const isEchoOfUserMsg = content.trim().length > 30 && lastUserMsgs.some(um => um.length > 30 && um === content.trim());

    // Detect degenerate/repetitive output (e.g., "node node node" loops from overwhelmed models)
    if (isDegenerateOutput(content)) {
      label(R, 'DEGENERATE OUTPUT', `Model produced incoherent repetitive output (${content.length} chars).`);
      logEvent('degenerate_output', { turn, retryCount, contentLength: content.length, contentPreview: content.substring(0, 200) });
      // Trim any recently pushed degenerate hidden messages to keep history clean
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user' && !messages[i].hiddenFromTranscript) break;
        if (messages[i].role === 'assistant' && typeof messages[i].content === 'string' && isDegenerateOutput(messages[i].content)) {
          messages.splice(i, 1);
        }
      }
      if (await tryRecoverFromDegenerateOutput(messages, content, retryCount, turn)) {
        retryCount++;
        continue;
      }
      break;
    }

    // Empty response — model has nothing to say; treat as done if wrote something, else nudge once more
    if (content.trim().length === 0 || isTokenOverflow || isEchoOfUserMsg) {
      if (isTokenOverflow) label(Y, 'TOKEN OVERFLOW', 'Model returned a raw im_start token — treating as empty');
      if (isEchoOfUserMsg) label(Y, 'ECHO DETECTED', 'Model echoed a user message — treating as empty');
      const missingExplicitRequestedWriteTargets = getMissingExplicitRequestedWriteTargets();
      const hasMissingExplicitWrites = missingExplicitRequestedWriteTargets.length > 0;
      const hasSatisfiedExplicitWriteRequest = explicitRequestedWriteTargets.length > 0 && !hasMissingExplicitWrites;
      // For greenfield: empty after write = done only if nudged at least once
      if (!IS_SPLIT_TASK && hadSuccessfulWrite && retryCount >= 1 && !hasMissingExplicitWrites) {
        label(G, 'DONE', 'Empty response after successful file write(s) — task complete.');
        logEvent('session_done', { turn, reason: 'empty_after_greenfield_write' });
        break;
      }
      if (hadSuccessfulWrite && !pendingReplaceAfterCreate && !extractionContinuationPending && hasMetExtractionGoal() && !hasMissingExplicitWrites) {
        label(G, 'DONE', `Empty response after ${extractionCount} extraction cycles — task complete.`);
        logEvent('session_done', { turn, reason: 'empty_after_write', extractionCount });
        break;
      }
      // If model got a continuation nudge but returned empty repeatedly, accept done if we did at least 2 cycles
      if (extractionContinuationPending && retryCount >= 2 && hasMetExtractionGoal() && !hasMissingExplicitWrites) {
        label(G, 'DONE', `${extractionCount} module(s) extracted — model could not continue further.`);
        logEvent('session_done', { turn, reason: 'continuation_exhausted', extractionCount });
        break;
      }
      if (hasSatisfiedExplicitWriteRequest && hadSuccessfulWrite && retryCount >= 1) {
        label(G, 'DONE', 'All explicitly requested files were written and the model went empty afterward — task complete.');
        logEvent('session_done', { turn, reason: 'empty_after_explicit_write_completion' });
        break;
      }
      if (retryCount >= MODEL_LIMITS.maxNudgeRetriesCap) {
        label(R, 'STUCK', `Model returned empty/overflow ${retryCount} times with no tool call — giving up.`);
        logEvent('retry_limit', { turn, retryCount, reason: 'empty_loop' });
        break;
      }
      // Context-aware empty nudge
      let emptyNudge;
      if (hasMissingExplicitWrites) {
        emptyNudge = `You have not actually written all explicitly requested files yet. Missing successful writes for: ${missingExplicitRequestedWriteTargets.join(', ')}. Call create_or_edit_file or replace_in_file for the missing file now. Do NOT claim completion until every requested file has a real successful tool result.`;
      } else if (pendingReplaceAfterCreate && lastCreatedFileState && lastSuccessfulRead && lastSuccessfulRead.content) {
        emptyNudge = buildNudge({ isAnnouncedButNotExecuted: true, requiresContinuation: true }, false, { pendingReplaceAfterCreate, lastSuccessfulRead, lastCreatedFileState });
      } else if (extractionContinuationPending) {
        const nextStart = (lastSuccessfulRead?.endLine ?? 120) + 1;
        const nextEnd = nextStart + 119;
        emptyNudge = `Extraction ${extractionCount} complete. Read the NEXT section of ${TARGET_FILE} — use read_file_slice with lines ${nextStart}–${nextEnd} — then extract another self-contained block (interface, class, or utility functions).`;
      } else if (lastSuccessfulRead && lastSuccessfulRead.content) {
        emptyNudge = `You already read lines ${lastSuccessfulRead.startLine}–${lastSuccessfulRead.endLine} of ${path.basename(lastSuccessfulRead.filepath ?? '')}. ` +
          `Do NOT re-read those lines. Use that content to create a NEW sibling file (e.g. ${SUGGESTED_TYPES_FILE} or ${SUGGESTED_INTERFACES_FILE}) with the extracted real code — use create_or_edit_file. ` +
          `Do NOT attempt to overwrite ${TARGET_FILE}.`;
      } else if (hasSatisfiedExplicitWriteRequest && hadSuccessfulWrite) {
        emptyNudge = 'All explicitly requested files already have successful write results. If the task is complete, reply with one short completion summary only. Do NOT call create_or_edit_file again unless a requested target is still missing.';
      } else {
        emptyNudge = IS_SPLIT_TASK
          ? `Your response was empty. Call read_file_slice on ${TARGET_FILE} to read a section, then call create_or_edit_file to create a new module file with the extracted code.`
          : REQUIRES_FILE_WRITE
            ? 'Your response was empty. Call create_or_edit_file to create the next file for this task, or execute_terminal_command if a setup command is needed. Do not output text — call a tool.'
            : 'Your response was empty. Use read_file_slice or read_specific_file to read the requested file, then provide your analysis. Call a tool now.';
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

    if (await tryBootstrapPreferredGreenfieldCodeDump(content)) {
      continue;
    }

    const bootstrapCandidate = inferBootstrapToolCall(content, {
      analysis,
      pendingReplaceAfterCreate,
      lastSuccessfulRead,
      lastCreatedFileState,
      extractionContinuationPending,
      hadSuccessfulWrite
    });
    if (bootstrapCandidate) {
      if (bootstrapCandidate.signature === repeatedNarratedCallSignature) {
        repeatedNarratedCallCount++;
      } else {
        repeatedNarratedCallSignature = bootstrapCandidate.signature;
        repeatedNarratedCallCount = 1;
      }
      label(Y, 'BOOTSTRAP CANDIDATE', `${bootstrapCandidate.reason} [${repeatedNarratedCallCount}x]: ${bootstrapCandidate.signature}`);
      if (repeatedNarratedCallCount >= 2) {
        logEvent('bootstrap_tool_call', {
          turn,
          reason: bootstrapCandidate.reason,
          signature: bootstrapCandidate.signature,
          tool: bootstrapCandidate.toolCall.function?.name
        });
        await executeResolvedToolCalls([bootstrapCandidate.toolCall], {
          wasNativeCall: false,
          assistantContent: '',
          recoveryLabel: 'BOOTSTRAP TOOL CALL'
        });
        continue;
      }
    } else {
      repeatedNarratedCallSignature = null;
      repeatedNarratedCallCount = 0;
    }

    // Show plan to console then nudge
    if (analysis.looksLikePlan) {
      if (MODEL_LIMITS.compactMandate) {
        const nudge = 'Do NOT output a plan. Call exactly one tool now.';
        label(Y, 'NUDGE (no-plan)', nudge);
        messages.push({ role: 'assistant', content });
        messages.push({ role: 'user', content: nudge });
        retryCount = 0;
        continue;
      }
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
                `Now create a new module file with the real extracted code from those lines, then call replace_in_file on ${TARGET_FILE}.`;
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
              : (lastSuccessfulRead?.content ? extractDefinitionsFromSource(lastSuccessfulRead.content, lastSuccessfulRead.filepath || TARGET_FILE) : null);
            if (rawContent && rawContent.trim().length > 50) {
              const fp = resolveFilepath(fakeResult.path);
              const writeResult = await executeTool('create_or_edit_file', { filename: fp, content: rawContent });
              const writeParsed = JSON.parse(writeResult);
              if (!writeParsed.error) {
                label(Y, 'HALLUCINATION RECOVERY', `Model faked creation of ${path.basename(fp)}; executing real create`);
                hadSuccessfulWrite = true;
                pendingReplaceAfterCreate = true;
                const exportNames = extractSymbolNamesFromContent(rawContent, fp);
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
              const newText = buildExactModuleReference(lastCreatedFileState.filePath, lastCreatedFileState.exportNames);
              if (!newText) {
                const fallbackNudge = `A replace step is still required for ${TARGET_FILE}. The new module file already exists at ${lastCreatedFileState.filePath}. Now call replace_in_file with the exact original block as old_text and the correct module reference or equivalent update as new_text.`;
                messages.push({ role: 'user', content: fallbackNudge });
                retryCount = 0;
                continue;
              }
              const replaceResult = await executeTool('replace_in_file', { filepath: fakeResult.path, old_text: removedLines, new_text: newText });
              const replaceParsed = JSON.parse(replaceResult);
              if (!replaceParsed.error) {
                label(Y, 'HALLUCINATION RECOVERY', `Model faked replace in ${TARGET_BASENAME}${TARGET_EXTENSION}; executed real replace`);
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
    const recentToolMessages = [...messages].filter(m => m.role === 'tool').slice(-3);
    const lastToolWasError = recentToolMessages.some(toolMessage => {
      try {
        const parsed = JSON.parse(toolMessage.content);
        if (parsed.error) return true;
        return parsed.tool === 'build_verify' && parsed.ok === false;
      } catch {
        return false;
      }
    }) || (lastToolMsg && (() => {
      try {
        const parsed = JSON.parse(lastToolMsg.content);
        if (parsed.error) return true;
        return parsed.tool === 'build_verify' && parsed.ok === false;
      } catch {
        return false;
      }
    })());
    // If model claims done after actual write succeeded AND no pending tool call in text → accept done
    const textCallsInResponse = parseToolCallsFromText(content);
    const hasPendingTextCall = textCallsInResponse.length > 0;
    const writeStillPending = REQUIRES_FILE_WRITE && !hadSuccessfulWrite;
    const missingExplicitRequestedWriteTargets = getMissingExplicitRequestedWriteTargets();
    const hasMissingExplicitWrites = missingExplicitRequestedWriteTargets.length > 0;
    const isDoneAfterWrite = hadSuccessfulWrite && !analysis.isPassingToUser &&
      !analysis.isAnnouncedButNotExecuted && !analysis.isHallucinatingToolResponse && !analysis.claimsFailure &&
      !analysis.mentionsToolButNotCalled && !hasPendingTextCall &&
      (analysis.claimsDone || (analysis.isLong && !analysis.looksLikePlan));
    // For non-split tasks: a long, non-plan text response with no tool calls is the final answer
    const isNonSplitFinalAnswer = !IS_SPLIT_TASK && analysis.isLong && !analysis.looksLikePlan &&
      !analysis.mentionsToolButNotCalled && !hasPendingTextCall && !analysis.isHallucinatingToolResponse && !analysis.claimsFailure &&
      (!REQUIRES_FILE_WRITE || hadSuccessfulWrite);
    if ((!writeStillPending && (!analysis.requiresContinuation || isDoneAfterWrite || isNonSplitFinalAnswer)) && !lastToolWasError && (!hadSuccessfulWrite || lastWriteVerifyPassed)) {
      if (hasMissingExplicitWrites) {
        const missingWriteNudge = `You have not actually written all explicitly requested files yet. Missing successful writes for: ${missingExplicitRequestedWriteTargets.join(', ')}. Call create_or_edit_file or replace_in_file for the missing file now. Do NOT claim completion until every requested target has been written.`;
        label(Y, 'NUDGE (missing explicit writes)', missingWriteNudge);
        messages.push({ role: 'assistant', content });
        messages.push({ role: 'user', content: missingWriteNudge });
        retryCount++;
        continue;
      }
      // For split tasks, require 2 cycles normally, but relax for tiny/exhausted targets.
      if (IS_SPLIT_TASK && !hasMetExtractionGoal()) {
        const nextStart = (lastSuccessfulRead?.endLine ?? 120) + 1;
        const tooFewNudge = `Only ${extractionCount} module(s) extracted so far — need another extraction unless the target is already exhausted. ` +
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

    if (retryCount >= MODEL_LIMITS.maxNudgeRetriesCap || consecutiveIdenticalResponses >= 2) {
      if (hasMissingExplicitWrites) {
        label(R, 'MISSING WRITES', `Model stopped before writing all explicitly requested files: ${missingExplicitRequestedWriteTargets.join(', ')}`);
        logEvent('retry_limit', { turn, retryCount, reason: 'missing_explicit_requested_writes', missingTargets: missingExplicitRequestedWriteTargets });
        break;
      }
      if (consecutiveIdenticalResponses >= 2) {
        label(R, 'IDENTICAL LOOP', `Model produced identical response ${consecutiveIdenticalResponses + 1} times — aborting.`);
        logEvent('retry_limit', { turn, retryCount, reason: 'identical_response_loop', consecutiveIdenticalResponses });
        break;
      }
      // Last-ditch: scan all recent assistant messages for extractable code blocks
      const recentAssistantMsgs = messages.filter(m => m.role === 'assistant' && m.content && m.content.trim().length > 0).slice(-5);
      const allCodeBlocks = [];
      for (const msg of recentAssistantMsgs) {
        const fenceRe = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)\n```/g;
        let fm;
        while ((fm = fenceRe.exec(msg.content)) !== null) {
          const lang = String(fm[1] ?? '').trim().toLowerCase();
          const code = fm[2].trim();
          if (code.length < 50) continue;
          if (['sh', 'bash', 'shell', 'cmd', 'json', 'diff'].includes(lang)) continue;
          // Try to find filename from text near the block
          const before = msg.content.substring(Math.max(0, fm.index - 300), fm.index);
          const bt = String.fromCharCode(96);
          const fnMatch =
            before.match(/(?:file|path|named?|called|create|creating)\s+['"\`]?([\w\/.-]+\.[\w]+)['"\`]?/i) ||
            before.match(new RegExp(bt + '([\\w\\/.-]+\\.[\\w]+)' + bt)) ||
            code.match(/^\/\/\s+([\w\/.-]+\.[\w]+)\s*$/m);
          if (fnMatch) {
            allCodeBlocks.push({ filename: fnMatch[1].includes('/') ? fnMatch[1] : `src/${fnMatch[1]}`, content: code });
          }
        }
      }
      if (allCodeBlocks.length > 0) {
        label(Y, 'LAST-DITCH EXTRACTION', `Found ${allCodeBlocks.length} code block(s) in recent messages — writing files`);
        for (const block of allCodeBlocks) {
          const fp = path.isAbsolute(block.filename) ? block.filename : path.join(wsRoot, block.filename);
          const writeResult = await executeTool('create_or_edit_file', { filename: fp, content: block.content });
          const parsedW = JSON.parse(writeResult);
          if (!parsedW.error) {
            hadSuccessfulWrite = true;
            successfulWritePaths.add(fp);
            label(G, '  ✓ LAST-DITCH WRITE', `${path.basename(fp)} (${block.content.length} chars)`);
            messages.push({ role: 'tool', content: writeResult, tool_name: 'create_or_edit_file' });
          } else {
            label(R, '  ✗ LAST-DITCH WRITE', parsedW.error);
          }
        }
        if (hadSuccessfulWrite) {
          retryCount = 0;
          messages.push({ role: 'user', content: 'Files extracted from your code blocks have been written. Continue creating the remaining files for this task.' });
          continue;
        }
      }
      label(R, 'RETRY LIMIT', `Gave up after ${retryCount} retries. Last: ${content.substring(0, 200)}`);
      logEvent('retry_limit', { turn, retryCount, contentPreview: content.substring(0, 200) });
      break;
    }

    const nudge = hasMissingExplicitWrites
      ? `You have not actually written all explicitly requested files yet. Missing successful writes for: ${missingExplicitRequestedWriteTargets.join(', ')}. Call create_or_edit_file or replace_in_file for the missing file now. Do NOT claim completion until every requested target has been written.`
      : buildNudge(analysis, lastToolWasError, { pendingReplaceAfterCreate, lastSuccessfulRead, lastCreatedFileState, extractionContinuationPending, extractionCount, hadSuccessfulWrite });
    const narratedBootstrapWarning = bootstrapCandidate && repeatedNarratedCallCount === 1
      ? `\nIf you describe the same tool call in plain text again instead of executing it, the harness will bootstrap ${bootstrapCandidate.toolCall.function?.name} automatically.`
      : '';

    // Track identical responses for escalation
    const contentTrimmed = content.trim();
    if (contentTrimmed && contentTrimmed === lastNudgedResponseContent) {
      consecutiveIdenticalResponses++;
    } else {
      consecutiveIdenticalResponses = 0;
    }
    lastNudgedResponseContent = contentTrimmed;

    const identicalPrefix = consecutiveIdenticalResponses >= 1
      ? `CRITICAL: You have produced the EXACT SAME response ${consecutiveIdenticalResponses + 1} times in a row. Your current approach is not working. You MUST change strategy completely. `
      : '';

    label(Y, 'NUDGE', `${identicalPrefix}${nudge}${narratedBootstrapWarning}`);
    logEvent('nudge', { kind: 'tool_continuation', turn, retryCount, consecutiveIdenticalResponses, nudge: `${identicalPrefix}${nudge}${narratedBootstrapWarning}` });
    messages.push({ role: 'assistant', content });
    messages.push({ role: 'user', content: `${identicalPrefix}${nudge}${narratedBootstrapWarning}` });
    retryCount++;
  }

  label(B, 'SUMMARY', `Turns: ${turn} | Final message count: ${messages.length} | Log: ${LOG_FILE}`);
}

main().catch(e => { console.error(e); process.exit(1); });
