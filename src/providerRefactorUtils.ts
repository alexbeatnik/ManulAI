import * as path from 'path';

import { ToolFunctionCall } from './types';

export interface NarratedReadContext {
  filepath: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
}

export interface NarratedCreateContext {
  filepath: string;
  content: string;
  exportNames: string[];
}

export interface NarratedBootstrapOptions {
  content: string;
  isLargeRefactorRequest: boolean;
  hasRecentReadOfLargeRefactorTarget: boolean;
  hasRecentMeaningfulWrite: boolean;
  hasReadButNoWriteOnLargeRefactor: boolean;
  hasPostCreateRefactorNarration: boolean;
  isAnnouncedButNotExecuted: boolean;
  isProgressOnlyResponse: boolean;
  hasIncompletePlan: boolean;
  hasExplicitNextSteps: boolean;
  claimsDone: boolean;
  mentionsChange: boolean;
  largeRefactorTargets: string[];
  suggestedNextSlice?: { filepath: string; startLine: number; endLine: number };
  latestRead?: NarratedReadContext;
  latestCreate?: NarratedCreateContext;
}

export function detectLanguageIdForPath(filepath: string): string {
  const extension = path.extname(filepath).toLowerCase();
  const map: Record<string, string> = {
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
  return map[extension] ?? 'plaintext';
}

export function extractSymbolNamesFromGeneratedContent(content: string, filepath: string): string[] {
  const languageId = detectLanguageIdForPath(filepath);
  const names: string[] = [];
  const add = (value: string | undefined): void => {
    if (!value || names.includes(value)) {
      return;
    }
    names.push(value);
  };

  const patternsByLanguage: Record<string, RegExp[]> = {
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
    python: [/^\s*(?:class|def)\s+([A-Za-z_][\w]*)/gm],
    go: [/^\s*type\s+([A-Za-z_][\w]*)\s+(?:struct|interface)\b/gm, /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)\s*\(/gm],
    rust: [/^\s*(?:pub\s+)?(?:struct|enum|trait|fn|const|mod)\s+([A-Za-z_][\w]*)/gm, /^\s*impl\s+([A-Za-z_][\w]*)/gm],
    java: [/^\s*(?:public\s+)?(?:class|interface|enum|record)\s+([A-Za-z_][\w]*)/gm],
    csharp: [/^\s*(?:public|internal|private|protected)\s+(?:static\s+)?(?:class|interface|enum|record|struct)\s+([A-Za-z_][\w]*)/gm]
  };

  const patterns = patternsByLanguage[languageId] ?? [/^\s*(?:class|interface|enum|record|struct|trait|type|def|fn|function)\s+([A-Za-z_][\w]*)/gm];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      add(match[1]);
    }
  }

  return names.slice(0, 10);
}

export function buildExactModuleReference(createdPath: string, symbolNames: string[]): string | undefined {
  const baseName = path.basename(createdPath, path.extname(createdPath));
  const extension = path.extname(createdPath).toLowerCase();
  const names = symbolNames.filter(Boolean);
  if (names.length === 0) {
    return undefined;
  }
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(extension)) {
    return `import { ${names.join(', ')} } from './${baseName}';`;
  }
  if (extension === '.py') {
    return `from ${baseName} import ${names.join(', ')}`;
  }
  return undefined;
}

export function extractDefinitionsFromSource(source: string, filepath: string): string {
  const normalized = source.replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return '';
  }

  const languageId = detectLanguageIdForPath(filepath);
  const lines = normalized.split('\n');
  const packageLine = languageId === 'go' ? lines.find(line => /^\s*package\s+[A-Za-z_][\w]*/.test(line)) : undefined;

  const captureBraceBlock = (startIndex: number): string => {
    const collected: string[] = [];
    let depth = 0;
    let seenOpen = false;
    for (let index = startIndex; index < lines.length; index += 1) {
      const line = lines[index];
      collected.push(line);
      for (const char of line) {
        if (char === '{') {
          depth += 1;
          seenOpen = true;
        } else if (char === '}') {
          depth -= 1;
        }
      }
      if (seenOpen && depth <= 0) {
        const block = collected.join('\n').trim();
        return languageId === 'go' && packageLine && !/^\s*package\s+/m.test(block)
          ? `${packageLine}\n\n${block}`
          : block;
      }
      if (!seenOpen && /;\s*$/.test(line.trim())) {
        const block = collected.join('\n').trim();
        return languageId === 'go' && packageLine && !/^\s*package\s+/m.test(block)
          ? `${packageLine}\n\n${block}`
          : block;
      }
    }
    const block = collected.join('\n').trim();
    return languageId === 'go' && packageLine && !/^\s*package\s+/m.test(block)
      ? `${packageLine}\n\n${block}`
      : block;
  };

  const captureIndentedBlock = (startIndex: number): string => {
    const collected = [lines[startIndex]];
    const baseIndent = (lines[startIndex].match(/^\s*/) ?? [''])[0].length;
    for (let index = startIndex + 1; index < lines.length; index += 1) {
      const line = lines[index];
      const trimmed = line.trim();
      if (!trimmed) {
        collected.push(line);
        continue;
      }
      const indent = (line.match(/^\s*/) ?? [''])[0].length;
      if (indent <= baseIndent && !/^\s*@/.test(line)) {
        break;
      }
      collected.push(line);
    }
    return collected.join('\n').trim();
  };

  const patternsByLanguage: Record<string, RegExp[]> = {
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
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!patterns.some(pattern => pattern.test(line))) {
      continue;
    }
    return languageId === 'python' ? captureIndentedBlock(index) : captureBraceBlock(index);
  }

  if (languageId === 'rust' && lines.every(line => /^\s*(?:pub\s+)?use\b/.test(line) || line.trim() === '')) {
    return '';
  }

  return normalized.length <= 1200 ? normalized : lines.slice(0, Math.min(lines.length, 80)).join('\n').trim();
}

export function inferReadRangeFromNarration(content: string, fallbackStart: number, fallbackEnd: number): { startLine: number; endLine: number } {
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

export function inferRepeatedNarratedBootstrapToolCall(options: NarratedBootstrapOptions): { toolCall: ToolFunctionCall; signature: string; reason: string } | undefined {
  const {
    content,
    isLargeRefactorRequest,
    hasRecentReadOfLargeRefactorTarget,
    hasRecentMeaningfulWrite,
    hasReadButNoWriteOnLargeRefactor,
    hasPostCreateRefactorNarration,
    isAnnouncedButNotExecuted,
    isProgressOnlyResponse,
    hasIncompletePlan,
    hasExplicitNextSteps,
    claimsDone,
    mentionsChange,
    largeRefactorTargets,
    suggestedNextSlice,
    latestRead,
    latestCreate
  } = options;

  if (!isLargeRefactorRequest) {
    return undefined;
  }

  const normalizedContent = content.trim();
  if (!normalizedContent) {
    return undefined;
  }

  const primaryTarget = largeRefactorTargets[0] ?? latestRead?.filepath;
  const lower = normalizedContent.toLowerCase();
  const mentionsRead = /\bread_file_slice\b/.test(lower) || /\bread_specific_file\b/.test(lower) || /\bread\b.*(?:section|slice|file|lines?|bounded)/i.test(normalizedContent);
  const mentionsCreate = /\bcreate_or_edit_file\b/.test(lower) || /\bcreate\b.*\b(?:file|module)\b/i.test(normalizedContent) || /\bextract\b.*\b(?:file|module|helper)\b/i.test(normalizedContent);
  const mentionsReplace = /\breplace_in_file\b/.test(lower) || /\breplace\b.*\b(?:block|original|definition|file)\b/i.test(normalizedContent) || /\bupdate\b.*\boriginal\b/i.test(normalizedContent);

  if (!hasRecentReadOfLargeRefactorTarget && primaryTarget && (mentionsRead || isAnnouncedButNotExecuted || isProgressOnlyResponse || hasIncompletePlan)) {
    const range = suggestedNextSlice && suggestedNextSlice.filepath
      ? { startLine: suggestedNextSlice.startLine, endLine: suggestedNextSlice.endLine, filepath: suggestedNextSlice.filepath }
      : { ...inferReadRangeFromNarration(normalizedContent, 1, 120), filepath: primaryTarget };
    return {
      toolCall: {
        type: 'function',
        function: {
          name: 'read_file_slice',
          arguments: { filepath: range.filepath, startLine: range.startLine, endLine: range.endLine }
        }
      },
      signature: `read_file_slice|${range.filepath}|${range.startLine}|${range.endLine}`,
      reason: 'bootstrap narrated read_file_slice for large refactor target'
    };
  }

  if (hasReadButNoWriteOnLargeRefactor && latestRead?.content && primaryTarget && (mentionsCreate || isProgressOnlyResponse || hasExplicitNextSteps || claimsDone || mentionsChange)) {
    const extractedContent = extractDefinitionsFromSource(latestRead.content, latestRead.filepath || primaryTarget);
    if (extractedContent) {
      const targetExtension = path.extname(primaryTarget);
      const symbolNames = extractSymbolNamesFromGeneratedContent(extractedContent, primaryTarget);
      const candidateFilename = latestCreate?.filepath
        ?? (symbolNames.length === 1
          ? path.join(path.dirname(primaryTarget), `${symbolNames[0]}${targetExtension}`)
          : path.join(path.dirname(primaryTarget), `types${targetExtension}`));
      return {
        toolCall: {
          type: 'function',
          function: {
            name: 'create_or_edit_file',
            arguments: {
              filename: candidateFilename.replace(/\\/g, '/'),
              content: extractedContent
            }
          }
        },
        signature: `create_or_edit_file|${candidateFilename.replace(/\\/g, '/')}`,
        reason: 'bootstrap narrated create_or_edit_file from last successful bounded read'
      };
    }
  }

  if (hasPostCreateRefactorNarration && latestRead?.content && latestCreate?.filepath && primaryTarget && (mentionsReplace || isAnnouncedButNotExecuted || claimsDone || mentionsChange)) {
    const oldText = extractDefinitionsFromSource(latestRead.content, primaryTarget);
    const newText = buildExactModuleReference(latestCreate.filepath, latestCreate.exportNames);
    if (oldText && newText) {
      return {
        toolCall: {
          type: 'function',
          function: {
            name: 'replace_in_file',
            arguments: { filepath: primaryTarget, old_text: oldText, new_text: newText }
          }
        },
        signature: `replace_in_file|${primaryTarget}|${latestCreate.filepath}`,
        reason: 'bootstrap narrated replace_in_file after successful create'
      };
    }
  }

  if (hasRecentMeaningfulWrite && primaryTarget && latestRead) {
    const fallbackStart = latestRead.endLine > 0 ? latestRead.endLine + 1 : 1;
    const fallbackEnd = fallbackStart + 119;
    if (mentionsRead || isAnnouncedButNotExecuted || isProgressOnlyResponse || hasExplicitNextSteps) {
      const range = suggestedNextSlice && suggestedNextSlice.filepath
        ? suggestedNextSlice
        : { filepath: primaryTarget, ...inferReadRangeFromNarration(normalizedContent, fallbackStart, fallbackEnd) };
      return {
        toolCall: {
          type: 'function',
          function: {
            name: 'read_file_slice',
            arguments: { filepath: range.filepath, startLine: range.startLine, endLine: range.endLine }
          }
        },
        signature: `read_file_slice|${range.filepath}|${range.startLine}|${range.endLine}`,
        reason: 'bootstrap narrated continuation read_file_slice after extraction'
      };
    }
  }

  return undefined;
}

export function validateGeneratedModuleContent(filepath: string, content: string): string | undefined {
  const extension = path.extname(filepath).toLowerCase();
  const normalized = content.replace(/\r\n/g, '\n');
  const nonEmptyLines = normalized
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
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

  return undefined;
}