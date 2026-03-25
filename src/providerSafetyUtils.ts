import * as path from 'path';

export function inferBuildVerifyStack(result: string): string {
  const normalized = result.toLowerCase();
  if (/cargo check|error\[e\d+\]|rustc|borrow checker/.test(normalized)) {
    return 'rust';
  }
  if (/go test|\.go:\d+|undefined:|cannot use .* as type/.test(normalized)) {
    return 'go';
  }
  if (/syntaxerror|indentationerror|modulenotfounderror|traceback|python -m compileall|\.py/.test(normalized)) {
    return 'python';
  }
  if (/dotnet build|error cs\d+|\.csproj|\.sln|msbuild/.test(normalized)) {
    return '.net';
  }
  if (/mvn|pom.xml|gradle|javac|\.java:\d+|cannot find symbol/.test(normalized)) {
    return 'java';
  }
  if (/tsc|typescript|npm run|pnpm |yarn |bun run|\.tsx?:\d+/.test(normalized)) {
    return 'javascript/typescript';
  }
  return 'project';
}

export function buildBuildVerifyFailureNudge(stack: string, result: string): string {
  const excerpt = result.substring(0, 500);
  if (stack === 'python') {
    return `Build verification failed for Python. Fix the Python syntax or import errors shown below by editing the indicated files, then continue until verification passes. Do NOT switch to unrelated files or ask the user to run commands manually.\n\n${excerpt}`;
  }
  if (stack === 'go') {
    return `Build verification failed for Go. Fix the Go compile or test errors shown below in the referenced packages or files, then continue until verification passes. Do NOT describe a plan without editing the real files.\n\n${excerpt}`;
  }
  if (stack === 'rust') {
    return `Build verification failed for Rust. Fix the Rust compiler errors shown below in the referenced modules, then continue until verification passes. Do NOT stop after a summary or ask the user to run cargo manually.\n\n${excerpt}`;
  }
  if (stack === 'java') {
    return `Build verification failed for Java. Fix the Java or build-system errors shown below in the referenced source files or build files, then continue until verification passes. Do NOT switch away from the failing project files.\n\n${excerpt}`;
  }
  if (stack === '.net') {
    return `Build verification failed for .NET. Fix the C# or project-build errors shown below in the referenced files, then continue until verification passes. Do NOT ask the user to run dotnet build manually.\n\n${excerpt}`;
  }
  if (stack === 'javascript/typescript') {
    return `Build verification failed for the JavaScript/TypeScript project. Fix the build errors shown below in the referenced files, then continue until verification passes. Do NOT stop after describing the issue.\n\n${excerpt}`;
  }
  return `Build verification failed. Fix the errors shown below in the referenced files, then continue until verification passes. Do NOT describe a plan without making the required edits.\n\n${excerpt}`;
}

export function isTerminalReadOnlyInspectionCommand(command: string): boolean {
  const trimmed = command.trim();
  const normalized = trimmed.toLowerCase();
  if (!normalized) {
    return false;
  }

  // Reject commands with shell control operators, redirections, or dangerous patterns
  if (/[;&|<>`]|\$\(|\b-exec\b/.test(trimmed)) {
    return false;
  }
  if (/\bsed\b[^\n]*\s-i\b/.test(normalized)) {
    return false;
  }

  return /^(?:cat|head|tail|sed|awk|grep|rg|less|more|ls|find)\b/.test(normalized)
    || /(?:\bcat\b|\bhead\b|\btail\b|\bsed\b|\bawk\b|\bgrep\b|\brg\b).*\bmanulaichatprovider\.ts\b/.test(normalized)
    || /^ls(?:\b|\b.*-)/.test(normalized);
}

export function buildPreviewSnippet(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n').trimEnd();
  if (!normalized.trim()) {
    return '';
  }

  const lines = normalized.split('\n');
  const previewLines = lines.length > 40
    ? [...lines.slice(0, 30), `... (${lines.length - 35} more lines omitted) ...`, ...lines.slice(-5)]
    : lines;
  const preview = previewLines.join('\n');
  return preview.length > 5000 ? `${preview.slice(0, 4800)}\n... preview truncated ...` : preview;
}

export function detectInvalidStructuredCreateContent(filepath: string, content: string): string | undefined {
  const extension = path.extname(filepath).toLowerCase();
  if (!['.ts', '.tsx', '.js', '.jsx', '.json'].includes(extension)) {
    return undefined;
  }

  if (['.ts', '.tsx'].includes(extension)
    && /\bvscode\./.test(content)
    && !/(?:from\s+['"]vscode['"]|import\s+\*\s+as\s+vscode\s+from\s+['"]vscode['"])/.test(content)) {
    return 'Blocked write: file references vscode.* but does not import vscode.';
  }

  const imbalanceReason = detectDelimiterImbalance(content);
  if (imbalanceReason) {
    return `Blocked write: content appears incomplete (${imbalanceReason}).`;
  }

  return undefined;
}

export function detectDelimiterImbalance(content: string): string | undefined {
  const stack: string[] = [];
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (inSingleQuote || inDoubleQuote || inTemplate) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (inSingleQuote && char === "'") {
        inSingleQuote = false;
      } else if (inDoubleQuote && char === '"') {
        inDoubleQuote = false;
      } else if (inTemplate && char === '`') {
        inTemplate = false;
      }
      continue;
    }

    if (char === '/' && next === '/') {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (char === '/' && next === '*') {
      inBlockComment = true;
      index += 1;
      continue;
    }

    if (char === "'") {
      inSingleQuote = true;
      continue;
    }
    if (char === '"') {
      inDoubleQuote = true;
      continue;
    }
    if (char === '`') {
      inTemplate = true;
      continue;
    }

    if (char === '{' || char === '[' || char === '(') {
      stack.push(char);
      continue;
    }

    if (char === '}' || char === ']' || char === ')') {
      const open = stack.pop();
      if (!open) {
        return `unexpected closing ${char}`;
      }
      if ((open === '{' && char !== '}')
        || (open === '[' && char !== ']')
        || (open === '(' && char !== ')')) {
        return `mismatched ${open} and ${char}`;
      }
    }
  }

  if (inSingleQuote || inDoubleQuote || inTemplate) {
    return 'unterminated string literal';
  }
  if (inBlockComment) {
    return 'unterminated block comment';
  }
  if (stack.length > 0) {
    const open = stack[stack.length - 1];
    return `missing closing delimiter for ${open}`;
  }

  return undefined;
}

export function isPlaceholderCreateResult(parsed: Record<string, unknown>): boolean {
  const preview = typeof parsed.preview === 'string' ? parsed.preview : '';
  const bytesWritten = Number(parsed.bytesWritten ?? 0);
  const normalizedLines = preview
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  if (normalizedLines.length === 0) {
    return true;
  }

  const codeLikeLineCount = normalizedLines.filter(line => {
    if (/^(?:\/\/|\/\*|\*|#)/.test(line)) {
      return false;
    }
    return /(?:^|\s)(?:export|import|const|let|var|function|class|interface|type|enum|async|return)\b/.test(line)
      || /[{}();=]/.test(line);
  }).length;

  return codeLikeLineCount === 0 && bytesWritten <= 240;
}

export function isPlaceholderReplacementText(content: string): boolean {
  const normalizedLines = content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  return normalizedLines.length > 0 && normalizedLines.every(line =>
    /^(?:\/\/|#|\/\*|\*|<!--)?\s*(?:code will be inserted here|todo|tbd|placeholder|stub|coming soon|implement me|fill me in)/i.test(line));
}

export function toolResultMatchesAnyTargetPath(toolPathValue: unknown, targets: string[]): boolean {
  const toolPath = String(toolPathValue ?? '').replace(/\\/g, '/').toLowerCase();
  if (!toolPath) {
    return false;
  }

  return targets.some(target => {
    const normalizedTarget = target.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
    if (!normalizedTarget) {
      return false;
    }
    return toolPath.endsWith(`/${normalizedTarget}`)
      || toolPath === normalizedTarget
      || path.basename(toolPath) === path.basename(normalizedTarget);
  });
}