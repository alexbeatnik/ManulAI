#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const RESULT_ROOT = path.join(ROOT, '.manulai', 'test-results', `regression-matrix-${RUN_ID}`);
const CASES_ROOT = path.join(RESULT_ROOT, 'cases');

mkdirSync(CASES_ROOT, { recursive: true });

const packageJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const EXPECTED_EXTENSION_NAME = String(packageJson.name ?? '').trim();
const EXPECTED_EXTENSION_VERSION = String(packageJson.version ?? '').trim();

const BASELINE_MODELS = ['phi4-mini:3.8b', 'llama3.1:8b', 'qwen3-coder:30b', 'gemma4:latest', 'gemma4:31b'];
const REQUESTED_MODELS = (process.env.REGRESSION_MODELS ?? '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);
const MODELS = REQUESTED_MODELS.length > 0 ? REQUESTED_MODELS : BASELINE_MODELS;
const CASE_FILTER = process.env.REGRESSION_CASE_FILTER ? new RegExp(process.env.REGRESSION_CASE_FILTER, 'i') : undefined;
const CASE_LIMIT = Number(process.env.REGRESSION_CASE_LIMIT ?? '0');

function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'case';
}

function normalizeSlashes(value) {
  return String(value ?? '').replace(/\\/g, '/');
}

function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true });
}

function writeText(filePath, content) {
  ensureDir(path.dirname(filePath));
  writeFileSync(filePath, content, 'utf8');
}

function looksLikeWriteIntent(text) {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  const englishWritePattern = /\b(?:create|write|edit|modify|update|add|append|change|rename|delete|remove|refactor|split|move|build|make|generate)\b/i;
  const cyrillicWritePattern = /(?:^|[\s"'`([{])(?:поміняй|зміни|измени|поменяй|онови|обнови|заміни|замени|відредагуй|редагуй|перепиши|додай|добавь|видали|удали|створи|создай|зроби|сделай|напиши|виправ|исправь|згенеруй|сгенерируй|побудуй|собери)(?=$|[\s"'`)\]},.!?:;])/i;
  return englishWritePattern.test(normalized) || cyrillicWritePattern.test(normalized);
}

function extractLikelyRequestFileTargets(text) {
  const candidates = [];
  const pushCandidate = value => {
    const trimmed = String(value ?? '').trim().replace(/^[`"']+|[`"'.,;:!?]+$/g, '');
    if (!trimmed) return;
    const normalized = normalizeSlashes(trimmed);
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
  return candidates;
}

function looksLikeLargeRefactorRequest(text) {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  const splitPattern = /\b(split|break\s+up|divide|decompose|modulari[sz]e|extract|separate|refactor)\b|(?:^|\s)(?:розбий|розділи|поділи|рознеси|винеси|декомпоз\w*|рефактор|перероби)(?:\s|$)/i;
  const targetPattern = /\b(file|class|module|component|service|provider)\b|(?:^|\s)(?:файл|клас|модул|компонент|сервіс|провайдер)(?:\s|$)/i;
  const multipartPattern = /\b(smaller|small|multiple|modules?|files?|parts?)\b|(?:^|\s)(?:менш\w*|маленьк\w*|декілька|кілька|частин|модулів|файлів)(?:\s|$)/i;
  return splitPattern.test(normalized) && targetPattern.test(normalized) && multipartPattern.test(normalized);
}

function looksLikeChatCreateRequest(text) {
  const normalized = text.trim().toLowerCase();
  if (!normalized || !looksLikeWriteIntent(text)) return false;
  if (looksLikeLargeRefactorRequest(text)) return false;

  const createPattern = /\b(?:create|generate|build|make|write|scaffold)\b|(?:^|[\s"'`([{])(?:створи|создай|згенеруй|сгенерируй|зроби|сделай|напиши|побудуй|собери)(?=$|[\s"'`)\]},.!?:;])/i;
  if (!createPattern.test(normalized)) return false;

  const explicitTargets = extractLikelyRequestFileTargets(text);
  const editPattern = /\b(?:rename|replace|fix|change|update|edit|modify|rewrite)\b|(?:^|[\s"'`([{])(?:поміняй|зміни|измени|поменяй|онови|обнови|заміни|замени|відредагуй|редагуй|перепиши|виправ|исправь)(?=$|[\s"'`)\]},.!?:;])/i;
  const visibleSnippetPattern = /```|\b(?:function|class|const|let|var|return|import)\b|<[A-Za-z][\w:-]*\b/;

  if (explicitTargets.length > 0) return true;

  return !editPattern.test(normalized)
    && !visibleSnippetPattern.test(text)
    && /\b(?:app|script|tool|program|page|component|project|files?)\b|(?:^|[\s"'`([{])(?:додаток|скрипт|утиліт|сторінк|компонент|проєкт|проект|файл)(?=$|[\s"'`)\]},.!?:;])/i.test(normalized);
}

function extractCodeBlockWrites(content) {
  const matches = [];
  const pattern = /(?:\*\*|`)?([A-Za-z0-9_./-]+\.(?:html|css|js|ts|json|md|py|go|txt))(?:\*\*|`)?\s*\n```[\w.+-]*\n([\s\S]*?)```/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    matches.push({ filepath: match[1], fileContent: match[2].trim() });
  }
  return matches;
}

function extractNewFileCreation(content) {
  const pattern = /(?:create|write|file|path|named?|called)\s+["'`]?([A-Za-z0-9_./-]+\.(?:html|css|js|ts|json|md|py|go|txt))["'`]?[\s\S]{0,120}?```[\w.+-]*\n([\s\S]*?)```/i;
  const match = content.match(pattern);
  if (!match) return undefined;
  return { filepath: match[1], fileContent: match[2].trim() };
}

function sanitizeChatOnlyResponse(content, latestVisibleUserRequest) {
  const trimmed = String(content ?? '').trim();
  if (!trimmed) return trimmed;

  const requestTargets = extractLikelyRequestFileTargets(latestVisibleUserRequest);
  const codeBlockWrites = extractCodeBlockWrites(trimmed);
  const newFileWrite = extractNewFileCreation(trimmed);
  const hasLargeCodeFence = /```[\w.+-]*\n[\s\S]{180,}?```/.test(trimmed);
  const looksLikeExplicitSnippetEdit = /(?:^|\n)Old:\s*`[^`]+`\s*(?:\n|\r\n?)New:\s*`[^`]+`/i.test(trimmed);

  if (looksLikeChatCreateRequest(latestVisibleUserRequest)
    && !looksLikeExplicitSnippetEdit
    && (codeBlockWrites.length > 0 || Boolean(newFileWrite) || hasLargeCodeFence)) {
    const targetList = requestTargets.length > 0
      ? ` Suggested targets: ${requestTargets.slice(0, 4).join(', ')}.`
      : '';
    return `Chat mode cannot create files or return full file dumps.${targetList} Ask for one specific file if you want a minimal starter snippet, or switch to Agent Mode to write the files automatically.`;
  }

  return trimmed;
}

function hasHardHarnessFailure(output, exitCode) {
  return exitCode !== 0
    || /\[(?:RETRY LIMIT|MISSING WRITES|IDENTICAL LOOP|OLLAMA ERROR|STUCK)\]/.test(output)
    || /Command exited with code\s+[1-9]/.test(output)
    || /^Error:/m.test(output);
}

function validateGoFileSyntax(filePath) {
  const result = spawnSync('gofmt', [filePath], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return {
    ok: result.status === 0,
    stderr: String(result.stderr ?? '').trim(),
    stdout: String(result.stdout ?? '').trim()
  };
}

function readText(filePath) {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
}

function relativeToRoot(filePath) {
  return normalizeSlashes(path.relative(ROOT, filePath));
}

const CHAT_SYSTEM_PROMPT = `[IDENTITY]
You are ManulAI in CHAT-ONLY mode.

---

[GOLDEN RULES]

- Never claim edits — you cannot change files.
- Only modify what is visible in the snippet.
- Never invent missing code or unseen lines.
- Use Old → New ONLY for explicit code-change requests.
- If unsure, say so — do not guess.
- Keep changes minimal and precise.

---

[HARD LIMITATIONS]

- NO tools are available
- You CANNOT read files
- You CANNOT modify files
- You CANNOT execute commands
- NEVER claim that you changed anything

---

[CORE BEHAVIOR]

- You are a SUGGESTION engine, not an executor
- Provide exact, minimal changes the user can apply manually
- Keep responses short and precise

---

[REQUEST ROUTING]

- If the user asks to explain, review, summarize, or identify what visible code does:
  - Answer in short plain text
  - You MAY quote short visible snippets
  - Do NOT use Old/New unless the user also explicitly asks for a change
- If the user explicitly asks to change, fix, rename, replace, rewrite, or edit visible code:
  - Respond with Old/New for the exact visible snippet only
- If the user asks to create files, add features, or make edits without tools:
  - Never claim execution
  - Explain the needed manual changes briefly
  - Include a minimal example only when necessary

---

[CODE MODIFICATION RULES]

If the user explicitly asks to change visible code:

- ONLY modify what is visible
- NEVER invent missing code
- NEVER assume unseen lines
- ALWAYS base changes strictly on the provided snippet

Format changes EXACTLY as:

Old: \`<exact old text from user>\`
New: \`<replacement text>\`

Rules:
- Old MUST exist in the provided code
- If you are not sure → DO NOT GUESS
- Do NOT rewrite entire blocks
- Do NOT output full files

---

[IF CODE IS MISSING]

If the user asks for a change but provides NO code:

- DO NOT fabricate "Old" lines
- DO NOT use Old/New format — not even as an example
- Instead: explain in plain text what change needs to be made, without any Old/New code format

---

[ANTI-HALLUCINATION]

- If you cannot see it → you do NOT know it
- If you are unsure → say so
- NEVER generate fake exact matches

---

[MINIMALISM]

- Smallest possible change
- No refactoring
- No unrelated improvements

---

[OUTPUT RULES]

- For explain/review/question requests: short plain-text answer
- For explicit edit requests: Old/New only
- No polite endings
- No full file dumps`;

const TASKS = [
  {
    id: 'chat-explain-js',
    mode: 'chat',
    prompt: 'Explain what this code does and mention one obvious issue: function greet(user) { return "Hello, " + user; }',
    evaluate: ({ visibleOutput }) => {
      const hasOldNew = /(?:^|\n)Old:\s*`[^`]+`/i.test(visibleOutput);
      if (hasOldNew) {
        return { status: 'fail', note: 'Explain case fell into Old/New edit format.' };
      }
      if (visibleOutput.length < 40) {
        return { status: 'warn', note: 'Explain response was unusually short.' };
      }
      return { status: 'pass', note: 'Plain-text explanation returned.' };
    }
  },
  {
    id: 'chat-explicit-edit-js',
    mode: 'chat',
    prompt: 'Rename the parameter from user to name in this snippet: function greet(user) { return "Hello, " + user; }',
    evaluate: ({ visibleOutput }) => {
      const hasUserInOld = /Old:[^\n]*user/i.test(visibleOutput);
      const hasNameInNew = /New:[^\n]*name/i.test(visibleOutput);
      return hasUserInOld && hasNameInNew
        ? { status: 'pass', note: 'Explicit snippet edit stayed in Old/New format.' }
        : { status: 'fail', note: 'Explicit snippet edit did not produce expected Old/New output.' };
    }
  },
  {
    id: 'chat-missing-code-edit',
    mode: 'chat',
    prompt: 'Rename the variable user to name in app.js, but I have not pasted the code.',
    evaluate: ({ visibleOutput }) => {
      if (/(?:^|\n)Old:\s*`/i.test(visibleOutput)) {
        return { status: 'fail', note: 'Missing-code edit fabricated Old/New lines.' };
      }
      if (/changed|updated|created|modified/i.test(visibleOutput)) {
        return { status: 'warn', note: 'Response sounds slightly execution-like.' };
      }
      return { status: 'pass', note: 'Missing-code edit stayed in guidance mode.' };
    }
  },
  {
    id: 'chat-create-request',
    mode: 'chat',
    prompt: 'Create index.html and app.js for a tiny counter app.',
    evaluate: ({ visibleOutput, rawOutput }) => {
      if (/Chat mode cannot create files or return full file dumps\./.test(visibleOutput)) {
        return { status: 'pass', note: 'Create request was reduced to manual guidance.' };
      }
      if (/```/.test(visibleOutput)) {
        return { status: 'fail', note: 'Visible chat output still contains full code fences for create request.' };
      }
      if (/```/.test(rawOutput)) {
        return { status: 'warn', note: 'Raw chat output contained file dumps, but visible output was sanitized.' };
      }
      return { status: 'pass', note: 'Create request avoided full file dumps.' };
    }
  },
  {
    id: 'agent-read-package',
    mode: 'agent',
    maxTurns: 4,
    dryRun: true,
    prompt: 'Read package.json and answer with the extension name and version only. Use tools if needed.',
    evaluate: ({ stdout, exitCode }) => {
      if (hasHardHarnessFailure(stdout, exitCode)) {
        return { status: 'fail', note: 'Agent read-package run hit a hard harness failure.' };
      }
      const hasName = stdout.includes(EXPECTED_EXTENSION_NAME);
      const hasVersion = stdout.includes(EXPECTED_EXTENSION_VERSION);
      return hasName && hasVersion
        ? { status: 'pass', note: 'Agent read-package answered with expected name/version.' }
        : { status: 'fail', note: 'Agent read-package missed expected name/version.' };
    }
  },
  {
    id: 'agent-explain-go',
    mode: 'agent',
    maxTurns: 5,
    dryRun: true,
    target: 'src/debug-lab/polyglot/go-fixture/main.go',
    prompt: 'Explain what this Go file does in 3 short bullets. Use tools if needed.',
    evaluate: ({ stdout, exitCode }) => {
      if (hasHardHarnessFailure(stdout, exitCode)) {
        return { status: 'fail', note: 'Agent explain-go run hit a hard harness failure.' };
      }
      if (!/(?:add|main|sum|prints?)/i.test(stdout)) {
        return { status: 'warn', note: 'Agent explain-go completed but explanation looks weak.' };
      }
      return { status: 'pass', note: 'Agent explain-go completed with plausible summary.' };
    }
  },
  {
    id: 'agent-multifile-create',
    mode: 'agent',
    maxTurns: 8,
    dryRun: false,
    prepare: ({ caseRoot }) => {
      const workDir = path.join(caseRoot, 'work');
      ensureDir(workDir);
      const indexFile = relativeToRoot(path.join(workDir, 'index.html'));
      const stylesFile = relativeToRoot(path.join(workDir, 'styles.css'));
      const appFile = relativeToRoot(path.join(workDir, 'app.js'));
      return {
        workDir,
        prompt: `Create a working static notes app using exactly these files: ${indexFile}, ${stylesFile}, and ${appFile}. Write all three files and finish only after each one has been created.`,
        expectedFiles: [path.join(workDir, 'index.html'), path.join(workDir, 'styles.css'), path.join(workDir, 'app.js')]
      };
    },
    evaluate: ({ stdout, exitCode, prepared }) => {
      if (hasHardHarnessFailure(stdout, exitCode)) {
        return { status: 'fail', note: 'Agent multi-file create run hit a hard harness failure.' };
      }
      const missingFiles = prepared.expectedFiles.filter(filePath => !existsSync(filePath));
      return missingFiles.length === 0
        ? { status: 'pass', note: 'Agent multi-file create wrote all requested files.' }
        : { status: 'fail', note: `Agent multi-file create missed files: ${missingFiles.map(filePath => path.basename(filePath)).join(', ')}` };
    }
  },
  {
    id: 'agent-explicit-path-create',
    mode: 'agent',
    maxTurns: 6,
    dryRun: false,
    prepare: ({ caseRoot }) => {
      const workDir = path.join(caseRoot, 'work');
      const targetFile = path.join(workDir, 'nested', 'client', 'app.js');
      ensureDir(path.dirname(targetFile));
      return {
        targetFile,
        prompt: `Create exactly this file and no other files: ${relativeToRoot(targetFile)}. It should export a renderStatus() function that returns "ok".`
      };
    },
    evaluate: ({ stdout, exitCode, prepared }) => {
      if (hasHardHarnessFailure(stdout, exitCode)) {
        return { status: 'fail', note: 'Agent explicit-path create run hit a hard harness failure.' };
      }
      const targetContent = readText(prepared.targetFile);
      if (!targetContent) {
        return { status: 'fail', note: 'Agent explicit-path create did not write the requested file.' };
      }
      if (!/renderStatus/.test(targetContent) || !/ok/.test(targetContent)) {
        return { status: 'fail', note: 'Agent explicit-path create wrote the file, but content is incomplete.' };
      }
      return { status: 'pass', note: 'Agent explicit-path create wrote the requested nested file.' };
    }
  },
  {
    id: 'agent-edit-go-temp',
    mode: 'agent',
    maxTurns: 8,
    dryRun: false,
    prepare: ({ caseRoot }) => {
      const workDir = path.join(caseRoot, 'work');
      ensureDir(workDir);
      const targetFile = path.join(workDir, 'main.go');
      copyFileSync(path.join(ROOT, 'src', 'debug-lab', 'polyglot', 'go-fixture', 'main.go'), targetFile);
      return {
        target: relativeToRoot(targetFile),
        targetFile,
        prompt: 'Read the Go file and add an iterative fibonacci(n int) int function. Then update main() to print fibonacci(7). Write the updated file.'
      };
    },
    evaluate: ({ stdout, exitCode, prepared }) => {
      const updatedContent = readText(prepared.targetFile);
      const hasFuncDecl = /func\s+fibonacci\s*\(/.test(updatedContent);
      const hasCall = /fibonacci\s*\(\s*7\s*\)/.test(updatedContent);
      const goSyntax = hasFuncDecl && hasCall ? validateGoFileSyntax(prepared.targetFile) : null;
      // Check file content first — even if RETRY LIMIT hit, partial writes should be evaluated
      if (hasFuncDecl && hasCall && goSyntax?.ok) {
        return { status: 'pass', note: 'Agent temp-go edit added fibonacci and updated main().' };
      }
      if (hasHardHarnessFailure(stdout, exitCode)) {
        return { status: 'fail', note: 'Agent temp-go edit run hit a hard harness failure.' };
      }
      if (!hasFuncDecl) return { status: 'fail', note: 'Agent temp-go edit did not add fibonacci().' };
      if (!hasCall) return { status: 'fail', note: 'Agent temp-go edit did not wire fibonacci(7) into main().' };
      if (!goSyntax?.ok) return { status: 'fail', note: `Agent temp-go edit wrote invalid Go syntax.${goSyntax?.stderr ? ` ${goSyntax.stderr}` : ''}`.trim() };
      return { status: 'fail', note: 'Agent temp-go edit produced unexpected failure.' };
    }
  },
  {
    id: 'planner-read-package',
    mode: 'planner',
    maxTurns: 4,
    dryRun: true,
    prompt: 'Read package.json and answer with the extension name and version only. Use tools if needed.',
    evaluate: ({ stdout, exitCode }) => {
      if (hasHardHarnessFailure(stdout, exitCode)) {
        return { status: 'fail', note: 'Planner read-package run hit a hard harness failure.' };
      }
      const hasName = stdout.includes(EXPECTED_EXTENSION_NAME);
      const hasVersion = stdout.includes(EXPECTED_EXTENSION_VERSION);
      return hasName && hasVersion
        ? { status: 'pass', note: 'Planner read-package answered with expected name/version.' }
        : { status: 'fail', note: 'Planner read-package missed expected name/version.' };
    }
  },
  {
    id: 'planner-explain-go',
    mode: 'planner',
    maxTurns: 5,
    dryRun: true,
    target: 'src/debug-lab/polyglot/go-fixture/main.go',
    prompt: 'Explain what this Go file does in 3 short bullets. Use tools if needed.',
    evaluate: ({ stdout, exitCode }) => {
      if (hasHardHarnessFailure(stdout, exitCode)) {
        return { status: 'fail', note: 'Planner explain-go run hit a hard harness failure.' };
      }
      if (!/(?:add|main|sum|prints?)/i.test(stdout)) {
        return { status: 'warn', note: 'Planner explain-go completed but explanation looks weak.' };
      }
      return { status: 'pass', note: 'Planner explain-go completed with plausible summary.' };
    }
  },
  {
    id: 'planner-multifile-create',
    mode: 'planner',
    maxTurns: 8,
    dryRun: false,
    prepare: ({ caseRoot }) => {
      const workDir = path.join(caseRoot, 'work');
      ensureDir(workDir);
      const indexFile = relativeToRoot(path.join(workDir, 'index.html'));
      const stylesFile = relativeToRoot(path.join(workDir, 'styles.css'));
      const appFile = relativeToRoot(path.join(workDir, 'app.js'));
      return {
        workDir,
        prompt: `Create a working static todo app using exactly these files: ${indexFile}, ${stylesFile}, and ${appFile}. Write all three files and finish only after each one has been created.`,
        expectedFiles: [path.join(workDir, 'index.html'), path.join(workDir, 'styles.css'), path.join(workDir, 'app.js')]
      };
    },
    evaluate: ({ stdout, exitCode, prepared }) => {
      if (hasHardHarnessFailure(stdout, exitCode)) {
        return { status: 'fail', note: 'Planner multi-file create run hit a hard harness failure.' };
      }
      const missingFiles = prepared.expectedFiles.filter(filePath => !existsSync(filePath));
      return missingFiles.length === 0
        ? { status: 'pass', note: 'Planner multi-file create wrote all requested files.' }
        : { status: 'fail', note: `Planner multi-file create missed files: ${missingFiles.map(filePath => path.basename(filePath)).join(', ')}` };
    }
  },
  {
    id: 'planner-explicit-path-create',
    mode: 'planner',
    maxTurns: 6,
    dryRun: false,
    prepare: ({ caseRoot }) => {
      const workDir = path.join(caseRoot, 'work');
      const targetFile = path.join(workDir, 'nested', 'client', 'app.js');
      ensureDir(path.dirname(targetFile));
      return {
        targetFile,
        prompt: `Create exactly this file and no other files: ${relativeToRoot(targetFile)}. It should export a renderStatus() function that returns "ok".`
      };
    },
    evaluate: ({ stdout, exitCode, prepared }) => {
      if (hasHardHarnessFailure(stdout, exitCode)) {
        return { status: 'fail', note: 'Planner explicit-path create run hit a hard harness failure.' };
      }
      const targetContent = readText(prepared.targetFile);
      if (!targetContent) {
        return { status: 'fail', note: 'Planner explicit-path create did not write the requested file.' };
      }
      if (!/renderStatus/.test(targetContent) || !/ok/.test(targetContent)) {
        return { status: 'fail', note: 'Planner explicit-path create wrote the file, but content is incomplete.' };
      }
      return { status: 'pass', note: 'Planner explicit-path create wrote the requested nested file.' };
    }
  },
  {
    id: 'planner-edit-go-temp',
    mode: 'planner',
    maxTurns: 8,
    dryRun: false,
    prepare: ({ caseRoot }) => {
      const workDir = path.join(caseRoot, 'work');
      ensureDir(workDir);
      const targetFile = path.join(workDir, 'main.go');
      copyFileSync(path.join(ROOT, 'src', 'debug-lab', 'polyglot', 'go-fixture', 'main.go'), targetFile);
      return {
        target: relativeToRoot(targetFile),
        targetFile,
        prompt: 'Read the Go file and add an iterative fibonacci(n int) int function. Then update main() to print fibonacci(7). Write the updated file.'
      };
    },
    evaluate: ({ stdout, exitCode, prepared }) => {
      const updatedContent = readText(prepared.targetFile);
      const hasFuncDecl = /func\s+fibonacci\s*\(/.test(updatedContent);
      const hasCall = /fibonacci\s*\(\s*7\s*\)/.test(updatedContent);
      const goSyntax = hasFuncDecl && hasCall ? validateGoFileSyntax(prepared.targetFile) : null;
      if (hasFuncDecl && hasCall && goSyntax?.ok) {
        return { status: 'pass', note: 'Planner temp-go edit added fibonacci and updated main().' };
      }
      if (hasHardHarnessFailure(stdout, exitCode)) {
        return { status: 'fail', note: 'Planner temp-go edit run hit a hard harness failure.' };
      }
      if (!hasFuncDecl) return { status: 'fail', note: 'Planner temp-go edit did not add fibonacci().' };
      if (!hasCall) return { status: 'fail', note: 'Planner temp-go edit did not wire fibonacci(7) into main().' };
      if (!goSyntax?.ok) return { status: 'fail', note: `Planner temp-go edit wrote invalid Go syntax.${goSyntax?.stderr ? ` ${goSyntax.stderr}` : ''}`.trim() };
      return { status: 'fail', note: 'Planner temp-go edit produced unexpected failure.' };
    }
  }
];

const selectedTasks = TASKS
  .filter(task => !CASE_FILTER || CASE_FILTER.test(task.id) || CASE_FILTER.test(task.mode))
  .slice(0, CASE_LIMIT > 0 ? CASE_LIMIT : TASKS.length);

async function runChatCase(model, task, caseRoot) {
  const body = {
    model,
    stream: false,
    options: { num_ctx: 8192 },
    messages: [
      { role: 'system', content: CHAT_SYSTEM_PROMPT },
      { role: 'user', content: task.prompt }
    ]
  };

  const startedAt = Date.now();
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const rawText = response.ok ? String((await response.json())?.message?.content ?? '').trim() : await response.text();
  const visibleText = sanitizeChatOnlyResponse(rawText, task.prompt);
  const durationMs = Date.now() - startedAt;

  writeText(path.join(caseRoot, 'prompt.txt'), task.prompt + '\n');
  writeText(path.join(caseRoot, 'chat-raw.txt'), rawText + '\n');
  writeText(path.join(caseRoot, 'chat-visible.txt'), visibleText + '\n');

  const evaluation = response.ok
    ? task.evaluate({ rawOutput: rawText, visibleOutput: visibleText })
    : { status: 'fail', note: `HTTP ${response.status}: ${rawText.slice(0, 200)}` };

  return {
    model,
    mode: task.mode,
    taskId: task.id,
    prompt: task.prompt,
    status: evaluation.status,
    note: evaluation.note,
    durationMs,
    rawOutput: rawText,
    visibleOutput: visibleText,
    caseRoot
  };
}

function runAgentLikeCase(model, task, caseRoot) {
  const prepared = task.prepare ? task.prepare({ caseRoot, model }) : {};
  const prompt = prepared.prompt ?? task.prompt;
  const args = ['scripts/debug-agent.mjs'];
  const target = prepared.target ?? task.target;
  if (target) {
    args.push('--target', target);
  }
  args.push(prompt);

  const env = {
    ...process.env,
    MANUL_MODEL: model,
    MANUL_MODE: task.mode,
    DRY_RUN: task.dryRun ? 'true' : 'false',
    MAX_TURNS: String(task.maxTurns ?? 6),
    LOG_FILE: path.join(caseRoot, 'session.jsonl')
  };

  writeText(path.join(caseRoot, 'prompt.txt'), prompt + '\n');

  const startedAt = Date.now();
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024
  });
  const durationMs = Date.now() - startedAt;
  const stdout = String(result.stdout ?? '');
  const stderr = String(result.stderr ?? '');
  writeText(path.join(caseRoot, 'stdout.txt'), stdout);
  writeText(path.join(caseRoot, 'stderr.txt'), stderr);

  const evaluation = task.evaluate({ stdout, stderr, exitCode: result.status ?? 0, prepared, caseRoot });
  return {
    model,
    mode: task.mode,
    taskId: task.id,
    prompt,
    status: evaluation.status,
    note: evaluation.note,
    durationMs,
    exitCode: result.status ?? 0,
    stdout,
    stderr,
    caseRoot
  };
}

async function main() {
  const results = [];
  console.log(`Regression matrix: ${MODELS.length} models x ${selectedTasks.length} tasks = ${MODELS.length * selectedTasks.length} runs`);
  console.log(`Results: ${relativeToRoot(RESULT_ROOT)}`);

  for (const model of MODELS) {
    console.log(`\n## Model: ${model}`);
    for (const task of selectedTasks) {
      const caseSlug = `${slugify(model)}-${slugify(task.mode)}-${slugify(task.id)}`;
      const caseRoot = path.join(CASES_ROOT, caseSlug);
      rmSync(caseRoot, { recursive: true, force: true });
      ensureDir(caseRoot);

      console.log(`- ${task.mode}/${task.id} ...`);
      const result = task.mode === 'chat'
        ? await runChatCase(model, task, caseRoot)
        : runAgentLikeCase(model, task, caseRoot);
      results.push(result);
      console.log(`  ${result.status.toUpperCase()} ${result.note} (${(result.durationMs / 1000).toFixed(1)}s)`);
    }
  }

  const summary = {
    runId: RUN_ID,
    ollamaUrl: OLLAMA_URL,
    models: MODELS,
    taskCountPerModel: selectedTasks.length,
    totalRuns: results.length,
    results
  };

  writeText(path.join(RESULT_ROOT, 'summary.json'), JSON.stringify(summary, null, 2));

  const byModel = new Map();
  for (const result of results) {
    const bucket = byModel.get(result.model) ?? { pass: 0, warn: 0, fail: 0, results: [] };
    bucket[result.status] += 1;
    bucket.results.push(result);
    byModel.set(result.model, bucket);
  }

  let markdown = '# Regression Matrix\n\n';
  markdown += `- Models: ${MODELS.join(', ')}\n`;
  markdown += `- Tasks per model: ${selectedTasks.length}\n`;
  markdown += `- Total runs: ${results.length}\n`;
  markdown += '- Chat results use provider-like post-sanitization logic so create-request regressions are classified by visible output, not only raw model text.\n\n';

  for (const model of MODELS) {
    const bucket = byModel.get(model);
    markdown += `## ${model}\n\n`;
    markdown += `- Pass: ${bucket.pass}\n`;
    markdown += `- Warn: ${bucket.warn}\n`;
    markdown += `- Fail: ${bucket.fail}\n\n`;
    for (const result of bucket.results) {
      markdown += `- ${result.mode}/${result.taskId}: ${result.status.toUpperCase()} - ${result.note}\n`;
    }
    markdown += '\n';
  }

  const failures = results.filter(result => result.status === 'fail');
  if (failures.length > 0) {
    markdown += '## Failures\n\n';
    for (const result of failures) {
      markdown += `- ${result.model} ${result.mode}/${result.taskId}: ${result.note}\n`;
    }
  }

  writeText(path.join(RESULT_ROOT, 'summary.md'), markdown);

  const passCount = results.filter(result => result.status === 'pass').length;
  const warnCount = results.filter(result => result.status === 'warn').length;
  const failCount = failures.length;
  console.log(`\nSummary: pass=${passCount} warn=${warnCount} fail=${failCount}`);
  console.log(`Markdown: ${relativeToRoot(path.join(RESULT_ROOT, 'summary.md'))}`);

  if (failCount > 0) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});