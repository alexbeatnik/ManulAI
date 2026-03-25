import * as path from 'path';

import { AttachedFileContext } from './types';

export interface FileWriteCandidate {
  fullMatch: string;
  filepath: string;
  fileContent: string;
}

export function extractMarkerFileWrite(content: string, attachedFiles: Map<string, AttachedFileContext>): FileWriteCandidate | undefined {
  const pattern = /\*?\*?\[Begin\s+of\s+([^\]]+)\]\*?\*?\s*\n([\s\S]*?)\n\s*\*?\*?\[End\s+of\s+\1\]\*?\*?/i;
  const match = pattern.exec(content);
  if (!match) {
    return undefined;
  }
  const rawName = match[1].trim();

  let filepath = rawName;
  for (const [fsPath, file] of attachedFiles) {
    if (file.languageId === '__folder__' || file.readOnly) {
      continue;
    }
    const baseName = path.basename(fsPath);
    if (baseName.toLowerCase() === rawName.toLowerCase() || file.name.toLowerCase() === rawName.toLowerCase()) {
      filepath = fsPath;
      break;
    }
  }

  let fileContent = match[2];
  fileContent = fileContent.replace(/^\s*---\s*\n?/, '').replace(/\n?\s*---\s*$/, '');
  fileContent = fileContent.replace(/\*\*([^*]+)\*\*/g, '$1');

  return {
    fullMatch: match[0],
    filepath,
    fileContent: fileContent.trim()
  };
}

export function matchResponseToAttachedFile(content: string, attachedFiles: Map<string, AttachedFileContext>): { filepath: string; fileContent: string } | undefined {
  if (attachedFiles.size === 0 || content.length < 500) {
    return undefined;
  }

  for (const [fsPath, file] of attachedFiles) {
    if (file.languageId === '__folder__' || file.readOnly) {
      continue;
    }
    const originalLines = file.content.split('\n').filter(line => line.trim().length > 20);
    if (originalLines.length < 5) {
      continue;
    }
    let matchCount = 0;
    for (const line of originalLines) {
      if (content.includes(line.trim())) {
        matchCount += 1;
      }
    }
    const ratio = matchCount / originalLines.length;
    if (ratio > 0.4) {
      const fileContent = extractTrustedFullFileContent(content, file.content);
      if (fileContent) {
        return { filepath: fsPath, fileContent };
      }
    }
  }
  return undefined;
}

export function matchResponseToActiveFile(
  content: string,
  activeFile: { filepath: string; content: string } | undefined
): { filepath: string; fileContent: string } | undefined {
  if (!activeFile || content.length < 500) {
    return undefined;
  }

  const originalLines = activeFile.content.split('\n').filter(line => line.trim().length > 20);
  if (originalLines.length < 5) {
    return undefined;
  }

  let matchCount = 0;
  for (const line of originalLines) {
    if (content.includes(line.trim())) {
      matchCount += 1;
    }
  }

  const ratio = matchCount / originalLines.length;
  if (ratio <= 0.4) {
    return undefined;
  }

  const fileContent = extractTrustedFullFileContent(content, activeFile.content);
  if (!fileContent) {
    return undefined;
  }

  return {
    filepath: activeFile.filepath,
    fileContent
  };
}

export function extractTrustedFullFileContent(content: string, originalContent?: string): string | undefined {
  const extracted = sanitizeGeneratedFileContent(extractLikelyFileContent(content));
  if (!extracted) {
    return undefined;
  }

  if (looksLikeDiffOutput(content) || looksLikeDiffOutput(extracted)) {
    return undefined;
  }

  const extractedLineCount = extracted.split('\n').filter(line => line.trim().length > 0).length;
  if (extractedLineCount < 8) {
    return undefined;
  }

  if (!originalContent) {
    return extracted.length >= 200 ? extracted : undefined;
  }

  const originalLength = originalContent.trim().length;
  if (originalLength > 500) {
    const extractedLength = extracted.trim().length;
    const extractedLines = extracted.split('\n').filter(line => line.trim().length > 0).length;
    const originalLines = originalContent.split('\n').filter(line => line.trim().length > 0).length;
    const hasStrongAnchors = hasStrongFullFileAnchors(extracted, originalContent);
    const minLengthRatio = hasStrongAnchors ? 0.55 : 0.85;
    const maxLengthRatio = hasStrongAnchors ? 1.35 : 1.2;
    const minLineRatio = hasStrongAnchors ? 0.5 : 0.85;
    const maxLineRatio = hasStrongAnchors ? 1.35 : 1.2;

    if (extractedLength < originalLength * minLengthRatio || extractedLength > originalLength * maxLengthRatio) {
      return undefined;
    }

    if (originalLines > 20 && (extractedLines < originalLines * minLineRatio || extractedLines > originalLines * maxLineRatio)) {
      return undefined;
    }
  }

  if (looksLikeChangeSummary(content)) {
    return undefined;
  }

  return extracted;
}

export function sanitizeGeneratedFileContent(content: string): string {
  if (!content) {
    return content;
  }

  const sanitizedLines = content
    .split('\n')
    .filter(line => {
      const trimmed = line.trim();
      if (!trimmed) {
        return true;
      }
      if (/^\[(?:Active|Attached) File:.*\]$/i.test(trimmed)) {
        return false;
      }
      if (/^\[\/(?:Active|Attached) File\]$/i.test(trimmed)) {
        return false;
      }
      if (/^<\/?manulai_(?:active_editor_context|attached_file|attached_folder)\b.*>$/i.test(trimmed)) {
        return false;
      }
      if (/^@@\s+line\s+\d+\s+@@$/i.test(trimmed)) {
        return false;
      }
      return true;
    });

  return sanitizedLines.join('\n').trim();
}

export function stripDiffPrefixes(content: string): string {
  const lines = content.split('\n');
  const nonEmptyLines = lines.filter(line => line.trim().length > 0);
  if (nonEmptyLines.length < 3) {
    return content;
  }

  const isMetadataLine = (line: string): boolean => {
    const trimmed = line.trim();
    return /^diff --git\s+/.test(trimmed)
      || /^index\s+[0-9a-f]+\.\.[0-9a-f]+/.test(trimmed)
      || /^@@\s+.+\s+@@/.test(trimmed)
      || /^---(\s|$)/.test(trimmed)
      || /^\+\+\+(\s|$)/.test(trimmed)
      || /^\\ No newline at end of file$/.test(trimmed);
  };

  const hasUnifiedDiffMarkers = nonEmptyLines.some(line => isMetadataLine(line));
  if (!hasUnifiedDiffMarkers) {
    return content;
  }

  const prefixedCount = nonEmptyLines.filter(line => /^[+-]\s/.test(line) || /^[+-](?![-+]{2})/.test(line)).length;
  if (prefixedCount / nonEmptyLines.length < 0.4) {
    return content;
  }

  return lines.map(line => {
    if (isMetadataLine(line)) {
      return '';
    }
    if (/^\+(?!\+\+)/.test(line)) {
      return line.substring(1);
    }
    if (/^-(?!--)/.test(line)) {
      return '';
    }
    if (/^ /.test(line)) {
      return line.substring(1);
    }
    return line;
  }).filter((line, index, allLines) => !(line === '' && index > 0 && allLines[index - 1] === '')).join('\n');
}

export function looksLikeDiffOutput(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) {
    return false;
  }
  if (/```(?:diff|patch)\b/i.test(trimmed)) {
    return true;
  }
  if (/^(?:diff\s+--git|index\s+[0-9a-f]+\.\.[0-9a-f]+|---\s+.+|\+\+\+\s+.+|@@\s+[-+,0-9\s]+@@|@@\s+line\s+\d+\s+@@)/m.test(trimmed)) {
    return true;
  }
  if (/updated\s+\*\*[^*]+\*\*\s+[—-]\s+changed lines:/i.test(trimmed)) {
    return true;
  }
  if (/\.\.\.\s*\(\d+\s+more diff lines\)\s*\.\.\./i.test(trimmed)) {
    return true;
  }

  const lines = trimmed.split('\n').map(line => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    return false;
  }
  const changedLineCount = lines.filter(line => /^(?:\+|-)(?![-+]{2}\s)/.test(line) || /^changed\s+lines:?$/i.test(line)).length;
  return changedLineCount >= 3 && changedLineCount / lines.length > 0.15;
}

export function looksLikeChangeSummary(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) {
    return false;
  }
  if (looksLikeDiffOutput(trimmed)) {
    return true;
  }
  return /(?:simple\s+find-and-replace|perform\s+a\s+simple\s+find-and-replace|here\s+are\s+the\s+steps|here\s+is\s+the\s+modified\s+content\s+of\s+the\s+`?[^`\n]+`?\s+file:|to\s+change\s+the\s+author\s+name\s+from)/i.test(trimmed);
}

export function extractLikelyFileContent(content: string): string {
  const fencedBlocks = Array.from(content.matchAll(/```(?:([\w.+-]+))?\n([\s\S]*?)```/g));
  if (fencedBlocks.length > 0) {
    const largestBlock = fencedBlocks.reduce((largest, current) => {
      const largestContent = largest[2] ?? '';
      const currentContent = current[2] ?? '';
      return currentContent.length > largestContent.length ? current : largest;
    });
    const blockLanguage = (largestBlock[1] ?? '').trim().toLowerCase();
    const blockContent = (largestBlock[2] ?? '').trim();
    if (blockContent.length > 0 && blockLanguage !== 'diff' && blockLanguage !== 'patch' && !looksLikeDiffOutput(blockContent)) {
      return blockContent;
    }
  }

  let extracted = content.replace(/^[\s\S]*?(?=(?:Copyright|package|import|<!DOCTYPE|<\?xml|#!\/|{))/i, '');
  extracted = extracted.replace(/\n?```\s*$/g, '');
  const lines = extracted.split('\n');
  if (lines.length > 10) {
    while (lines.length > 0 && lines[0].trim().length < 3) {
      lines.shift();
    }
    while (lines.length > 0 && lines[lines.length - 1].trim().length < 3) {
      lines.pop();
    }
  }
  return lines.join('\n').trim();
}

export function extractDescribedReplacements(content: string): Array<{ oldText: string; newText: string }> {
  const replacements: Array<{ oldText: string; newText: string }> = [];
  const normalized = content
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
    .replace(/[«»]/g, '"');

  const broadInstructionPattern = /(?:replace|replaced|замін\w*|змін\w*|оновл\w*)[^\n]{0,140}?["'`]([^"'`\n]+)["'`][^\n]{0,40}?(?:with|to|на|->|→)[\s:]*["'`]([^"'`\n]+)["'`]/gi;
  let match: RegExpExecArray | null;
  while ((match = broadInstructionPattern.exec(normalized)) !== null) {
    const oldText = match[1].trim();
    const newText = match[2].trim();
    if (oldText && newText && oldText !== newText) {
      replacements.push({ oldText, newText });
    }
  }
  if (replacements.length > 0) {
    return replacements;
  }

  const unquotedRenamePattern = /(?:change|replace|rename|update|змін\w*|замін\w*|оновл\w*)[^\n]{0,120}?(?:from|з)\s+([A-Za-zА-Яа-яІіЇїЄєҐґ0-9_. -]{2,80}?)\s+(?:to|на|with)\s+([A-Za-zА-Яа-яІіЇїЄєҐґ0-9_. -]{2,80}?)(?=(?:\s+(?:in|within|inside|у|в)\s+\S+)|[\s.,;!)]|$)/gi;
  while ((match = unquotedRenamePattern.exec(normalized)) !== null) {
    const oldText = match[1].trim().replace(/[.,;:]+$/g, '');
    const newText = match[2].trim().replace(/[.,;:]+$/g, '');
    if (oldText && newText && oldText !== newText) {
      replacements.push({ oldText, newText });
    }
  }
  if (replacements.length > 0) {
    return normalizeDescribedReplacements(replacements);
  }

  const codeBlockPairPattern = /```[^\n]*\n([\s\S]*?)```\s*(?:\n\s*)?(?:На|на|To|to|→|->|replaced with|замінено на|changed to)[:\s]*\s*```[^\n]*\n([\s\S]*?)```/gi;
  while ((match = codeBlockPairPattern.exec(normalized)) !== null) {
    const oldText = match[1].trim();
    const newText = match[2].trim();
    if (oldText && newText && oldText !== newText) {
      replacements.push({ oldText, newText });
    }
  }
  if (replacements.length > 0) {
    return replacements;
  }

  const inlinePattern = /["'`]([^"'`\n]+)["'`]\s*(?:has been\s+|was\s+|було\s+)?(?:→|->|на|to|replaced with|changed to|замінено на)[:\s]*\s*["'`]([^"'`\n]+)["'`]/gi;
  while ((match = inlinePattern.exec(normalized)) !== null) {
    const oldText = match[1].trim();
    const newText = match[2].trim();
    if (oldText && newText && oldText !== newText) {
      replacements.push({ oldText, newText });
    }
  }
  if (replacements.length > 0) {
    return replacements;
  }

  const zNaPattern = /(?:з|from)\s+["'`]([^"'`\n]+)["'`]\s+(?:на|to)\s+["'`]([^"'`\n]+)["'`]/gi;
  while ((match = zNaPattern.exec(normalized)) !== null) {
    const oldText = match[1].trim();
    const newText = match[2].trim();
    if (oldText && newText && oldText !== newText) {
      replacements.push({ oldText, newText });
    }
  }
  if (replacements.length > 0) {
    return replacements;
  }

  const zaminaPattern = /(?:замін\w*|replac\w*|updat\w*|оновл\w*)\s+(?:\w+\s+)?["'`]([^"'`\n]+)["'`]\s+(?:на|to|with)\s+["'`]([^"'`\n]+)["'`]/gi;
  while ((match = zaminaPattern.exec(normalized)) !== null) {
    const oldText = match[1].trim();
    const newText = match[2].trim();
    if (oldText && newText && oldText !== newText) {
      replacements.push({ oldText, newText });
    }
  }
  if (replacements.length > 0) {
    return replacements;
  }

  const reversedPattern = /(?:replaced|замінено|змінено|замінив|заміна|changed|updated|оновлено)\s+(?:the\s+)?(?:name\s+|value\s+|text\s+)?["'`]([^"'`\n]+)["'`]\s+(?:with|to|на|->|→)\s+["'`]([^"'`\n]+)["'`]/gi;
  while ((match = reversedPattern.exec(normalized)) !== null) {
    const oldText = match[1].trim();
    const newText = match[2].trim();
    if (oldText && newText && oldText !== newText) {
      replacements.push({ oldText, newText });
    }
  }

  return normalizeDescribedReplacements(replacements);
}

export function isLikelyFileReference(candidate: string, options: { activeName?: string; attachedFiles?: Map<string, AttachedFileContext> }): boolean {
  const trimmed = candidate.trim().replace(/^[`"']+|[`"'.,;:!?]+$/g, '');
  if (!trimmed) {
    return false;
  }
  if (/[.]$/.test(candidate.trim())) {
    return false;
  }
  if (/^\d+(?:\.\d+)+$/.test(trimmed)) {
    return false;
  }

  const lower = trimmed.toLowerCase();
  const banned = new Set(['directly', 'file', 'content', 'modified', 'updated', 'below', 'above', 'following', 'steps', 'here', 'there']);
  if (banned.has(lower)) {
    return false;
  }
  if (/^[A-Z][A-Z0-9_-]*$/.test(trimmed)) {
    return true;
  }
  if (trimmed.includes('/')) {
    return true;
  }
  if (/^[A-Za-z0-9_-]+\.[A-Za-z][A-Za-z0-9_-]{0,11}$/.test(trimmed)) {
    return true;
  }
  if (options.activeName && trimmed === options.activeName) {
    return true;
  }
  return Array.from(options.attachedFiles?.values() ?? []).some(file => file.languageId !== '__folder__' && !file.readOnly && (trimmed === file.name || trimmed === path.basename(file.uri.fsPath)));
}

export function findAttachedFileForReplacements(replacements: Array<{ oldText: string }>, attachedFiles: Map<string, AttachedFileContext>): string | undefined {
  for (const [fsPath, file] of attachedFiles) {
    if (file.languageId === '__folder__' || file.readOnly) {
      continue;
    }
    const allFound = replacements.every(rep => file.content.includes(rep.oldText));
    if (allFound) {
      return fsPath;
    }
  }
  for (const [fsPath, file] of attachedFiles) {
    if (file.languageId === '__folder__' || file.readOnly) {
      continue;
    }
    const anyFound = replacements.some(rep => file.content.includes(rep.oldText));
    if (anyFound) {
      return fsPath;
    }
  }
  return undefined;
}

export async function findMentionedFileForReplacements(
  content: string,
  replacements: Array<{ oldText: string }>,
  options: {
    isLikelyFileReference: (candidate: string) => boolean;
    resolveAndReadCandidate: (candidate: string) => Promise<{ filepath: string; content: string } | undefined>;
  }
): Promise<string | undefined> {
  const normalized = content
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'");

  const fileNamePattern = /(?:файл[іиеа]?|file|in)\s+["'`]?(\S+\.[\w]+)["'`]?/gi;
  const candidates: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = fileNamePattern.exec(normalized)) !== null) {
    if (options.isLikelyFileReference(match[1])) {
      candidates.push(match[1]);
    }
  }
  const bareNamePattern = /\b(LICENSE|README|CHANGELOG|Makefile|Dockerfile|package\.json|tsconfig\.json)\b/g;
  while ((match = bareNamePattern.exec(content)) !== null) {
    if (!candidates.includes(match[1])) {
      candidates.push(match[1]);
    }
  }

  for (const candidate of candidates) {
    const resolved = await options.resolveAndReadCandidate(candidate);
    if (resolved && replacements.some(rep => resolved.content.includes(rep.oldText))) {
      return resolved.filepath;
    }
  }
  return undefined;
}

export async function findMentionedFileInContent(
  content: string,
  options: {
    isLikelyFileReference: (candidate: string) => boolean;
    candidateExists: (candidate: string) => Promise<string | undefined>;
  }
): Promise<string | undefined> {
  const normalized = content.replace(/[`"']/g, ' ').replace(/\s+/g, ' ');
  const candidates: string[] = [];
  const fileNamePattern = /(?:файл[іиеа]?|file|in)\s+([A-Za-z0-9_./-]+(?:\.[A-Za-z0-9_-]+)?)/gi;
  let match: RegExpExecArray | null;
  while ((match = fileNamePattern.exec(normalized)) !== null) {
    if (options.isLikelyFileReference(match[1])) {
      candidates.push(match[1]);
    }
  }
  const bareNamePattern = /\b(LICENSE|README|CHANGELOG|Makefile|Dockerfile|package\.json|tsconfig\.json)\b/g;
  while ((match = bareNamePattern.exec(content)) !== null) {
    if (!candidates.includes(match[1])) {
      candidates.push(match[1]);
    }
  }
  for (const candidate of candidates) {
    const existing = await options.candidateExists(candidate);
    if (existing) {
      return existing;
    }
  }
  return undefined;
}

export async function extractDescribedFileDump(
  content: string,
  options: {
    findMentionedFileInContent: (content: string) => Promise<string | undefined>;
    readFileAtPath: (filepath: string) => Promise<string | undefined>;
    activeFile?: { filepath: string; content: string };
  }
): Promise<FileWriteCandidate | undefined> {
  const fencedBlocks = Array.from(content.matchAll(/```(?:([\w.+-]+))?\n([\s\S]*?)```/g));
  if (fencedBlocks.length === 0) {
    return undefined;
  }

  const largestBlock = fencedBlocks.reduce((largest, current) => {
    const largestContent = (largest[2] ?? '').trim();
    const currentContent = (current[2] ?? '').trim();
    return currentContent.length > largestContent.length ? current : largest;
  });

  const blockLanguage = (largestBlock[1] ?? '').trim().toLowerCase();
  const fileContent = (largestBlock[2] ?? '').trim();
  if (fileContent.length < 200) {
    return undefined;
  }
  if (blockLanguage === 'diff' || blockLanguage === 'patch' || looksLikeDiffOutput(fileContent)) {
    return undefined;
  }

  const mentionedFile = await options.findMentionedFileInContent(content);
  if (mentionedFile) {
    const currentContent = await options.readFileAtPath(mentionedFile);
    if (!currentContent) {
      return undefined;
    }
    const trustedContent = extractTrustedFullFileContent(content, currentContent);
    if (!trustedContent) {
      return undefined;
    }
    return {
      fullMatch: largestBlock[0],
      filepath: mentionedFile,
      fileContent: trustedContent
    };
  }

  if (options.activeFile) {
    const trustedContent = extractTrustedFullFileContent(content, options.activeFile.content);
    if (!trustedContent) {
      return undefined;
    }
    return {
      fullMatch: largestBlock[0],
      filepath: options.activeFile.filepath,
      fileContent: trustedContent
    };
  }

  return undefined;
}

export function extractNewFileCreation(
  content: string,
  options: {
    isLikelyFileReference: (candidate: string) => boolean;
    latestVisibleUserRequest?: string;
    looksLikeLargeRefactorRequest: (text: string) => boolean;
    activeEditorPath?: string;
    workspaceRoot?: string;
  }
): FileWriteCandidate | undefined {
  const fencedBlocks = Array.from(content.matchAll(/(```(?:[\w.+-]*)\n[\s\S]*?```)/g));
  if (fencedBlocks.length === 0) {
    return undefined;
  }

  const filenamePattern = /[`"']?([a-zA-Z0-9_\-]+\.[a-zA-Z0-9]+)[`"']?/g;
  const codeBlock = fencedBlocks[0];
  const blockStart = codeBlock.index ?? 0;
  const textBeforeBlock = content.substring(Math.max(0, blockStart - 300), blockStart);

  let bestFilename: string | undefined;
  let match: RegExpExecArray | null;
  while ((match = filenamePattern.exec(textBeforeBlock)) !== null) {
    const candidate = match[1];
    if (options.isLikelyFileReference(candidate)) {
      bestFilename = candidate;
    }
  }

  if (!bestFilename) {
    const textAfterBlock = content.substring(blockStart + codeBlock[0].length, blockStart + codeBlock[0].length + 200);
    filenamePattern.lastIndex = 0;
    while ((match = filenamePattern.exec(textAfterBlock)) !== null) {
      const candidate = match[1];
      if (options.isLikelyFileReference(candidate)) {
        bestFilename = candidate;
        break;
      }
    }
  }

  if (!bestFilename) {
    return undefined;
  }

  const blockContent = codeBlock[0].replace(/^```[\w.+-]*\n/, '').replace(/\n?```$/, '');
  if (!blockContent.trim()) {
    return undefined;
  }

  const normalizedFilename = bestFilename.replace(/\\/g, '/');
  const isBareFilename = !normalizedFilename.includes('/');
  const isLargeRefactorRequest = options.latestVisibleUserRequest
    ? options.looksLikeLargeRefactorRequest(options.latestVisibleUserRequest)
    : false;

  if (isLargeRefactorRequest && isBareFilename && options.activeEditorPath) {
    if (path.basename(options.activeEditorPath).toLowerCase() === normalizedFilename.toLowerCase()) {
      return undefined;
    }

    return {
      fullMatch: codeBlock[0],
      filepath: path.join(path.dirname(options.activeEditorPath), normalizedFilename),
      fileContent: blockContent
    };
  }

  const filepath = options.workspaceRoot ? path.join(options.workspaceRoot, normalizedFilename) : normalizedFilename;
  return {
    fullMatch: codeBlock[0],
    filepath,
    fileContent: blockContent
  };
}

export function extractCodeBlockFileWrites(
  content: string,
  options: {
    looksLikeToolCallContent: (content: string) => boolean;
    isLikelyFileReference: (candidate: string) => boolean;
  }
): FileWriteCandidate[] {
  const blocks: FileWriteCandidate[] = [];
  const shellLanguages = new Set(['bash', 'sh', 'shell', 'zsh', 'fish', 'powershell', 'ps1', 'cmd', 'bat']);
  const pattern = /```(\w+)[:\s]+([^\n`]+)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const lang = (match[1] || '').toLowerCase();
    const filepath = match[2].trim();
    const fileContent = match[3];
    if (shellLanguages.has(lang) || lang === 'diff' || lang === 'patch') {
      continue;
    }
    if (options.looksLikeToolCallContent(fileContent)) {
      continue;
    }
    if (filepath && fileContent && !filepath.includes(' ') && options.isLikelyFileReference(filepath) && !looksLikeDiffOutput(fileContent)) {
      blocks.push({ fullMatch: match[0], filepath, fileContent });
    }
  }

  const commentPathPattern = /```(\w+)\s*\n\s*(?:\/\/|#|--|\/\*)\s*(?:filepath|file|path):\s*([^\n]+)\n([\s\S]*?)```/gi;
  while ((match = commentPathPattern.exec(content)) !== null) {
    const lang = (match[1] || '').toLowerCase();
    const filepath = match[2].trim();
    const fileContent = match[3];
    if (shellLanguages.has(lang) || lang === 'diff' || lang === 'patch') {
      continue;
    }
    if (options.looksLikeToolCallContent(fileContent)) {
      continue;
    }
    if (filepath && fileContent && options.isLikelyFileReference(filepath) && !blocks.some(block => block.filepath === filepath) && !looksLikeDiffOutput(fileContent)) {
      blocks.push({ fullMatch: match[0], filepath, fileContent });
    }
  }

  const precedingNamePattern = /(?:in|to|for|file|called|named|updated?|modified|created?|створ\w*|файл)\s+[`"']?([a-zA-Z0-9_\-\.\/]+)[`"']?[^`]{0,80}```(\w*)\n([\s\S]*?)```/gi;
  while ((match = precedingNamePattern.exec(content)) !== null) {
    const filepath = match[1].trim();
    const lang = (match[2] || '').toLowerCase();
    const fileContent = match[3];
    if (shellLanguages.has(lang) || lang === 'diff' || lang === 'patch') {
      continue;
    }
    if (looksLikeDiffOutput(fileContent) || options.looksLikeToolCallContent(fileContent)) {
      continue;
    }
    if (options.isLikelyFileReference(filepath) && !filepath.includes(' ') && !blocks.some(block => block.filepath === filepath)) {
      const fullMatch = match[0].substring(match[0].indexOf('```'));
      blocks.push({ fullMatch, filepath, fileContent });
    }
  }

  return blocks;
}

export async function extractUnifiedDiffWrite(
  content: string,
  options: {
    resolveExistingWorkspacePath: (rawPath: string) => Promise<string | undefined>;
    readWorkspaceText: (filepath: string) => Promise<string>;
    normalizeTextForComparison: (content: string) => string;
  }
): Promise<FileWriteCandidate | undefined> {
  if (!looksLikeDiffOutput(content)) {
    return undefined;
  }

  const diffMatch = content.match(/(?:^|\n)((?:diff\s+--git[\s\S]*?)?---\s+[^\n]+\n\+\+\+\s+[^\n]+\n(?:@@[^\n]*\n[\s\S]*?)+)(?=\n[^ @+\-\\]|$)/m);
  const fullMatch = diffMatch?.[1]?.trim();
  if (!fullMatch) {
    return undefined;
  }

  const lines = fullMatch.split('\n');
  const plusHeader = lines.find(line => line.startsWith('+++ '));
  if (!plusHeader) {
    return undefined;
  }

  const rawPath = plusHeader.replace(/^\+\+\+\s+/, '').trim().replace(/^[ab]\//, '');
  const filepath = await options.resolveExistingWorkspacePath(rawPath);
  if (!filepath) {
    return undefined;
  }

  const originalContent = await options.readWorkspaceText(filepath);
  const originalLines = originalContent.split('\n');
  const updatedLines = [...originalLines];

  let lineIndex = 0;
  while (lineIndex < lines.length) {
    const line = lines[lineIndex];
    if (!line.startsWith('@@')) {
      lineIndex += 1;
      continue;
    }

    const headerMatch = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(line);
    if (!headerMatch) {
      return undefined;
    }

    const oldStart = Math.max(0, Number(headerMatch[1]) - 1);
    const oldChunk: string[] = [];
    const newChunk: string[] = [];
    lineIndex += 1;

    while (lineIndex < lines.length && !lines[lineIndex].startsWith('@@')) {
      const diffLine = lines[lineIndex];
      if (diffLine.startsWith(' ')) {
        const value = diffLine.slice(1);
        oldChunk.push(value);
        newChunk.push(value);
      } else if (diffLine.startsWith('-')) {
        oldChunk.push(diffLine.slice(1));
      } else if (diffLine.startsWith('+')) {
        newChunk.push(diffLine.slice(1));
      } else if (!diffLine.startsWith('\\')) {
        return undefined;
      }
      lineIndex += 1;
    }

    const expectedOld = oldChunk.join('\n');
    const sliceLength = oldChunk.length;
    const actualOld = updatedLines.slice(oldStart, oldStart + sliceLength).join('\n');
    if (options.normalizeTextForComparison(actualOld) !== options.normalizeTextForComparison(expectedOld)) {
      return undefined;
    }

    updatedLines.splice(oldStart, sliceLength, ...newChunk);
  }

  const fileContent = updatedLines.join('\n');
  if (options.normalizeTextForComparison(fileContent) === options.normalizeTextForComparison(originalContent)) {
    return undefined;
  }

  return { fullMatch, filepath, fileContent };
}

export function truncateLargeCodeBlocks(content: string): string {
  return content.replace(/```(\w*)\n([\s\S]*?)```/g, (fullMatch, lang: string, code: string) => {
    const lines = code.split('\n');
    if (lines.length <= 15) {
      return fullMatch;
    }
    const head = lines.slice(0, 6).join('\n');
    const tail = lines.slice(-4).join('\n');
    const omitted = lines.length - 10;
    return '```' + lang + '\n' + head + '\n// ... ' + String(omitted) + ' lines omitted ...\n' + tail + '\n```';
  });
}

export function extractInlineFileBlocks(content: string): FileWriteCandidate[] {
  const blocks: FileWriteCandidate[] = [];
  const pattern = /(?:```[\w]*\s*\n?)?\[FILE:\s*([^\]]+)\]\s*\n?([\s\S]*?)(?:\s*\[\/FILE\]|\n?```|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    blocks.push({
      fullMatch: match[0],
      filepath: match[1].trim(),
      fileContent: match[2]
    });
  }
  return blocks;
}

function hasStrongFullFileAnchors(extractedContent: string, originalContent: string): boolean {
  const normalize = (value: string): string => value.trim();
  const extractedLines = extractedContent.split('\n').map(normalize).filter(Boolean);
  const originalLines = originalContent.split('\n').map(normalize).filter(Boolean);
  if (extractedLines.length < 8 || originalLines.length < 8) {
    return false;
  }
  const headCandidates = originalLines.slice(0, 6).filter(line => line.length > 3);
  const tailCandidates = originalLines.slice(-6).filter(line => line.length > 3);
  const extractedSet = new Set(extractedLines);
  const headMatches = headCandidates.filter(line => extractedSet.has(line)).length;
  const tailMatches = tailCandidates.filter(line => extractedSet.has(line)).length;
  return headMatches >= 3 && tailMatches >= 2;
}

function normalizeDescribedReplacements(replacements: Array<{ oldText: string; newText: string }>): Array<{ oldText: string; newText: string }> {
  const unique = new Map<string, { oldText: string; newText: string }>();
  for (const replacement of replacements) {
    const key = `${replacement.oldText}\u0000${replacement.newText}`;
    if (!unique.has(key)) {
      unique.set(key, replacement);
    }
  }

  const sorted = Array.from(unique.values()).sort((left, right) => right.oldText.length - left.oldText.length);
  return sorted.filter((replacement, index) => !sorted.slice(0, index).some(previous => previous.oldText.includes(replacement.oldText) && previous.newText.includes(replacement.newText)));
}