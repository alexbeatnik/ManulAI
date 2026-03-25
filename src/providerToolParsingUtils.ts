import { ParsedToolCall, ToolDefinition, ToolFunctionCall } from './types';

export function remapWeakModelToolName(name: string): string {
  const normalized = name.trim();
  const aliases: Record<string, string> = {
    write_file: 'write_to_file',
    create_file: 'create_or_edit_file',
    create_or_replace: 'create_or_edit_file',
    create_or_overwrite: 'create_or_edit_file',
    edit_file: 'replace_in_file',
    replace_content: 'replace_in_file',
    read_file: 'read_specific_file',
    read_file_range: 'read_file_slice',
    read_file_chunk: 'read_file_slice',
    run_command: 'execute_terminal_command',
    terminal_command: 'execute_terminal_command'
  };
  return aliases[normalized.toLowerCase()] ?? normalized;
}

export function remapWeakModelArgumentAliases(args: Record<string, unknown>): Record<string, unknown> {
  const aliasMap: Record<string, string> = {
    file_path: 'filepath',
    filePath: 'filepath',
    file_name: 'filename',
    file: 'filepath',
    path: 'filepath',
    old_content: 'old_text',
    new_content: 'new_text',
    old_string: 'old_text',
    new_string: 'new_text',
    old_code: 'old_text',
    new_code: 'new_text',
    start_line: 'startLine',
    end_line: 'endLine',
    from_line: 'startLine',
    to_line: 'endLine',
    cmd: 'command',
    dir: 'directory'
  };

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    normalized[aliasMap[key] ?? key] = value;
  }
  return normalized;
}

export function normalizeToolArguments(rawArguments: Record<string, unknown> | string | undefined): Record<string, unknown> {
  if (!rawArguments) {
    return {};
  }

  if (typeof rawArguments === 'string') {
    try {
      const parsed = JSON.parse(rawArguments) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return remapWeakModelArgumentAliases(parsed as Record<string, unknown>);
      }
    } catch {
      return {};
    }

    return {};
  }

  return remapWeakModelArgumentAliases(rawArguments);
}

export function extractToolCalls(message: { content: string; tool_calls?: ToolFunctionCall[] }, toolDefinitions: ToolDefinition[]): ToolFunctionCall[] {
  if (message.tool_calls?.length) {
    return message.tool_calls;
  }

  return parseToolCallsFromContent(message.content, toolDefinitions);
}

export function stripToolCallsFromContent(content: string): string {
  let stripped = content;
  stripped = stripped.replace(/```(?:json|tool_call|tool)\s*\n?[\s\S]*?```/g, '');
  stripped = stripped.replace(/<tool_call>\s*[\s\S]*?\s*<\/tool_call>/g, '');
  stripped = stripped.replace(/<function=[^>]+>\s*[\s\S]*?<\/function>/g, '');
  stripped = stripped.replace(/<\/?tool_call>/g, '');
  const toolNamePattern = /\{\s*"(?:name|function_name|function)"\s*:\s*"/g;
  let match: RegExpExecArray | null;
  while ((match = toolNamePattern.exec(stripped)) !== null) {
    const jsonStr = extractBalancedJson(stripped, match.index);
    if (jsonStr) {
      stripped = stripped.slice(0, match.index) + stripped.slice(match.index + jsonStr.length);
      toolNamePattern.lastIndex = match.index;
    }
  }
  return stripped.trim();
}

export function parseToolCallsFromContent(content: string, toolDefinitions: ToolDefinition[]): ToolFunctionCall[] {
  const trimmed = content.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const calls = normalizeParsedToolCalls(parsed);
      if (calls.length > 0) {
        return calls;
      }
    } catch {
      // Fall through to regex extraction.
    }
  }

  const taggedCalls = parseTaggedToolCalls(trimmed, toolDefinitions);
  if (taggedCalls.length > 0) {
    return taggedCalls;
  }

  const knownToolNames = new Set(toolDefinitions.map(t => t.function.name));
  const candidates: string[] = [];
  const codeBlockPattern = /```(?:json|tool_call|tool)?\s*\n?([\s\S]*?)```/g;
  const tagPattern = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

  let match: RegExpExecArray | null;
  while ((match = codeBlockPattern.exec(trimmed)) !== null) {
    const inner = match[1].trim();
    if (inner.startsWith('{') || inner.startsWith('[')) {
      candidates.push(inner);
    }
  }
  while ((match = tagPattern.exec(trimmed)) !== null) {
    const inner = match[1].trim();
    if (inner.startsWith('{') || inner.startsWith('[')) {
      candidates.push(inner);
    }
  }

  const toolNamePattern = /\{\s*["'](?:name|function_name|function)["']\s*:\s*["']/g;
  while ((match = toolNamePattern.exec(trimmed)) !== null) {
    const jsonStr = extractBalancedJson(trimmed, match.index);
    if (jsonStr) {
      candidates.push(jsonStr);
    }
  }

  // Direct JSON parser: tool_name {json_args} — handles multiple occurrences and mid-text positions.
  // Iterates known tool names (including aliases) to find `toolName {…}` anywhere in text.
  const directJsonResults: ToolFunctionCall[] = [];
  const allToolNamesForDirectJson = new Set([...knownToolNames]);
  // Also include common aliases so we catch e.g. `create_file {…}`
  const aliasKeys = ['write_file', 'create_file', 'create_or_replace', 'create_or_overwrite',
    'edit_file', 'replace_content', 'read_file', 'read_file_range', 'read_file_chunk',
    'run_command', 'terminal_command'];
  for (const alias of aliasKeys) { allToolNamesForDirectJson.add(alias); }

  for (const toolName of allToolNamesForDirectJson) {
    const directJsonRe = new RegExp(`\\b${toolName}\\s+(\\{)`, 'gi');
    let djm: RegExpExecArray | null;
    while ((djm = directJsonRe.exec(trimmed)) !== null) {
      const start = djm.index + djm[0].length - 1;
      const argsStr = extractBalancedJson(trimmed, start);
      if (argsStr) {
        const args = relaxedJsonParse(argsStr);
        if (args && typeof args === 'object') {
          // Skip {name, arguments} wrappers — those are handled by the blob parser above
          if (args.name && args.arguments !== undefined) { continue; }
          directJsonResults.push({
            type: 'function',
            function: { name: remapWeakModelToolName(toolName), arguments: remapWeakModelArgumentAliases(args as Record<string, unknown>) }
          });
        }
      }
    }
  }
  if (directJsonResults.length > 0) {
    return directJsonResults;
  }

  // Match read_file_slice filepath="path" startLine=N endLine=N (key=value format)
  const readSliceKVRe = /\bread_file_slice\s+filepath="([^"]+)"\s+startLine=(\d+)\s+endLine=(\d+)/g;
  let readSliceKVMatch: RegExpExecArray | null;
  while ((readSliceKVMatch = readSliceKVRe.exec(trimmed)) !== null) {
    directJsonResults.push({
      type: 'function',
      function: {
        name: 'read_file_slice',
        arguments: { filepath: readSliceKVMatch[1], startLine: parseInt(readSliceKVMatch[2], 10), endLine: parseInt(readSliceKVMatch[3], 10) }
      }
    });
  }
  if (directJsonResults.length > 0) {
    return directJsonResults;
  }

  // Detect positional tool calls like: create_or_edit_file src/app.ts "content here"
  // or: create_or_edit_file src/app.ts 'content here'
  const positionalWriteTools = new Set(['create_or_edit_file', 'write_to_file', 'create_file', 'write_file']);
  const positionalPattern = /^(create_or_edit_file|write_to_file|create_file|write_file)\s+([\w.\/-]+)\s+["'`]([\s\S]+)["'`]\s*$/m;
  const positionalMatch = positionalPattern.exec(trimmed);
  if (positionalMatch && positionalWriteTools.has(positionalMatch[1])) {
    const toolName = remapWeakModelToolName(positionalMatch[1]);
    const filepath = positionalMatch[2];
    // Unescape common escapes from the content string
    const rawContent = positionalMatch[3].replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    if (rawContent.trim().length > 10) {
      return [{ type: 'function', function: { name: toolName, arguments: { filepath, content: rawContent } } }];
    }
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const calls = normalizeParsedToolCalls(parsed);
      if (calls.length > 0 && calls.every(c => knownToolNames.has(c.function.name))) {
        return calls;
      }
    } catch {
      const escaped = escapeJsonStringValues(candidate);
      if (escaped !== candidate) {
        try {
          const parsed = JSON.parse(escaped) as unknown;
          const calls = normalizeParsedToolCalls(parsed);
          if (calls.length > 0 && calls.every(c => knownToolNames.has(c.function.name))) {
            return calls;
          }
        } catch {
          // Fall through.
        }
      }

      const repaired = repairSingleQuotedJson(candidate);
      if (repaired) {
        try {
          const parsed = JSON.parse(repaired) as unknown;
          const calls = normalizeParsedToolCalls(parsed);
          if (calls.length > 0 && calls.every(c => knownToolNames.has(c.function.name))) {
            return calls;
          }
        } catch {
          // Fall through.
        }
      }

      // Try quoting unquoted keys: {command: "value"} → {"command": "value"}
      const relaxed = relaxedJsonParse(candidate);
      if (relaxed) {
        const calls = normalizeParsedToolCalls(relaxed);
        if (calls.length > 0 && calls.every(c => knownToolNames.has(c.function.name))) {
          return calls;
        }
      }
    }
  }

  return [];
}

export function escapeJsonStringValues(value: string): string {
  let result = '';
  let inStr = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (inStr) {
      if (char === '\\') {
        result += char + (value[++index] ?? '');
        continue;
      }
      if (char === '\r') {
        result += (value[index + 1] === '\n') ? (index += 1, '\\n') : '\\r';
        continue;
      }
      if (char === '\n') {
        result += '\\n';
        continue;
      }
      if (char === '\t') {
        result += '\\t';
        continue;
      }
      if (char === '"') {
        inStr = false;
      }
    } else if (char === '"') {
      inStr = true;
    }
    result += char;
  }
  return result;
}

/** Try parsing JSON with cascading fallbacks: plain → escaped string values → unquoted keys → both. */
export function relaxedJsonParse(str: string): Record<string, unknown> | null {
  try { return JSON.parse(str) as Record<string, unknown>; } catch { /* fall through */ }
  try { return JSON.parse(escapeJsonStringValues(str)) as Record<string, unknown>; } catch { /* fall through */ }
  try {
    const fixed = str.replace(/([{,])\s*([A-Za-z_]\w*)\s*:/g, '$1"$2":');
    return JSON.parse(fixed) as Record<string, unknown>;
  } catch { /* fall through */ }
  try {
    const fixed = str.replace(/([{,])\s*([A-Za-z_]\w*)\s*:/g, '$1"$2":');
    return JSON.parse(escapeJsonStringValues(fixed)) as Record<string, unknown>;
  } catch { return null; }
}

export function looksLikeToolCallContent(content: string, toolDefinitions: ToolDefinition[]): boolean {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{')) {
    return false;
  }

  let parsed: unknown;
  let parseFailed = false;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const repaired = repairSingleQuotedJson(trimmed);
    if (!repaired) {
      parseFailed = true;
    } else {
      try {
        parsed = JSON.parse(repaired);
      } catch {
        parseFailed = true;
      }
    }
  }

  if (parseFailed) {
    return looksLikeMalformedToolCallContent(trimmed, toolDefinitions);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return false;
  }

  const toolNames = new Set(toolDefinitions.map(t => t.function.name));
  const obj = parsed as {
    type?: unknown;
    function?: { name?: unknown; arguments?: unknown } | string;
    name?: unknown;
    function_name?: unknown;
    arguments?: unknown;
    parameters?: unknown;
  };

  if (obj.type === 'function' && obj.function && typeof obj.function === 'object') {
    const functionName = obj.function.name;
    const functionArguments = obj.function.arguments;
    return typeof functionName === 'string'
      && toolNames.has(functionName)
      && (functionArguments === undefined || typeof functionArguments === 'string' || (functionArguments !== null && typeof functionArguments === 'object'));
  }

  if (typeof obj.function === 'string') {
    const topLevelArgs = inferImplicitToolArguments(remapWeakModelToolName(obj.function), obj.arguments ?? obj.parameters, obj as Record<string, unknown>);
    return toolNames.has(remapWeakModelToolName(obj.function))
      && (typeof topLevelArgs === 'string' || (topLevelArgs !== null && typeof topLevelArgs === 'object'));
  }

  const topLevelName = obj.name ?? obj.function_name;
  const normalizedTopLevelName = typeof topLevelName === 'string' ? remapWeakModelToolName(topLevelName) : undefined;
  const topLevelArgs = normalizedTopLevelName
    ? inferImplicitToolArguments(normalizedTopLevelName, obj.arguments ?? obj.parameters, obj as Record<string, unknown>)
    : (obj.arguments ?? obj.parameters);
  const parsedMatch = typeof topLevelName === 'string'
    && toolNames.has(remapWeakModelToolName(topLevelName))
    && (typeof topLevelArgs === 'string' || (topLevelArgs !== null && typeof topLevelArgs === 'object'));

  if (parsedMatch) {
    return true;
  }

  return looksLikeMalformedToolCallContent(trimmed, toolDefinitions);
}

export function looksLikeMalformedToolCallContent(content: string, toolDefinitions: ToolDefinition[]): boolean {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{')) {
    return false;
  }

  const hintedToolName = extractToolCallNameHint(trimmed, toolDefinitions);
  if (!hintedToolName) {
    return false;
  }

  if (!/["'](?:arguments|parameters)["']\s*:/.test(trimmed)) {
    return false;
  }

  return /["'](?:filepath|filename|path|content|old_text|new_text|command|directory|text|model)["']\s*:/.test(trimmed);
}

export function extractToolCallNameHint(content: string, toolDefinitions: ToolDefinition[]): string | undefined {
  const toolNames = new Set(toolDefinitions.map(t => t.function.name));
  const directMatch = content.match(/["'](?:name|function_name|function)["']\s*:\s*["']([a-zA-Z0-9_:-]+)["']/);
  const nestedMatch = content.match(/["']function["']\s*:\s*\{[\s\S]*?["']name["']\s*:\s*["']([a-zA-Z0-9_:-]+)["']/);
  const candidate = nestedMatch?.[1] ?? directMatch?.[1];
  if (!candidate) {
    return undefined;
  }

  const normalized = remapWeakModelToolName(candidate.trim());
  return toolNames.has(normalized) ? normalized : undefined;
}

export function containsLeakedToolCallPayload(content: string, toolDefinitions: ToolDefinition[]): boolean {
  const trimmed = content.trim();
  if (!trimmed) {
    return false;
  }

  if (looksLikeToolCallContent(trimmed, toolDefinitions)) {
    return true;
  }

  const codeBlockPattern = /```(?:json|tool_call|tool)?\s*\n?([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = codeBlockPattern.exec(trimmed)) !== null) {
    if (looksLikeToolCallContent(match[1] ?? '', toolDefinitions)) {
      return true;
    }
  }

  const toolCallObjectPattern = /\{\s*["'](?:name|function_name|function)["']\s*:/g;
  while ((match = toolCallObjectPattern.exec(trimmed)) !== null) {
    const jsonStr = extractBalancedJson(trimmed, match.index);
    if (jsonStr && looksLikeToolCallContent(jsonStr, toolDefinitions)) {
      return true;
    }
  }

  return false;
}

export function extractBalancedJson(text: string, startIndex: number): string | undefined {
  let depth = 0;
  let inString = false;
  let stringChar = '';
  let escape = false;
  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === '\\' && inString) {
      escape = true;
      continue;
    }
    if ((char === '"' || char === "'") && (!inString || char === stringChar)) {
      if (inString) {
        inString = false;
        stringChar = '';
      } else {
        inString = true;
        stringChar = char;
      }
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }
  return undefined;
}

export function repairSingleQuotedJson(text: string): string | undefined {
  let result = '';
  let index = 0;
  while (index < text.length) {
    if (text[index] === "'") {
      let value = '';
      index += 1;
      while (index < text.length && text[index] !== "'") {
        if (text[index] === '\\' && index + 1 < text.length) {
          value += text[index] + text[index + 1];
          index += 2;
        } else {
          value += text[index];
          index += 1;
        }
      }
      index += 1;
      result += '"' + value.replace(/"/g, '\\"') + '"';
    } else {
      result += text[index];
      index += 1;
    }
  }

  try {
    JSON.parse(result);
    return result;
  } catch {
    return undefined;
  }
}

function parseTaggedToolCalls(content: string, toolDefinitions: ToolDefinition[]): ToolFunctionCall[] {
  const knownToolNames = new Set(toolDefinitions.map(t => t.function.name));
  const calls: ToolFunctionCall[] = [];
  const functionPattern = /<function=([a-zA-Z0-9_]+)>\s*([\s\S]*?)<\/function>/g;
  let match: RegExpExecArray | null;

  while ((match = functionPattern.exec(content)) !== null) {
    const toolName = remapWeakModelToolName(match[1].trim());
    if (!knownToolNames.has(toolName)) {
      continue;
    }

    const args: Record<string, unknown> = {};
    const parameterPattern = /<parameter=([a-zA-Z0-9_]+)>\s*([\s\S]*?)\s*<\/parameter>/g;
    let parameterMatch: RegExpExecArray | null;
    while ((parameterMatch = parameterPattern.exec(match[2] ?? '')) !== null) {
      args[parameterMatch[1].trim()] = parameterMatch[2];
    }

    calls.push({
      type: 'function',
      function: {
        name: toolName,
        arguments: remapWeakModelArgumentAliases(args)
      }
    });
  }

  return calls;
}

function normalizeParsedToolCalls(rawValue: unknown): ToolFunctionCall[] {
  if (!rawValue || typeof rawValue !== 'object') {
    return [];
  }

  if (Array.isArray(rawValue)) {
    return rawValue
      .map(item => normalizeSingleParsedToolCall(item))
      .filter((toolCall): toolCall is ToolFunctionCall => toolCall !== undefined);
  }

  const record = rawValue as Record<string, unknown>;
  if (Array.isArray(record.tool_calls)) {
    return record.tool_calls
      .map(item => normalizeSingleParsedToolCall(item))
      .filter((toolCall): toolCall is ToolFunctionCall => toolCall !== undefined);
  }

  const singleToolCall = normalizeSingleParsedToolCall(record);
  return singleToolCall ? [singleToolCall] : [];
}

function normalizeSingleParsedToolCall(rawValue: unknown): ToolFunctionCall | undefined {
  if (!rawValue || typeof rawValue !== 'object') {
    return undefined;
  }

  const record = rawValue as Record<string, unknown>;
  const directName = typeof record.name === 'string' ? record.name.trim()
    : typeof record.function_name === 'string' ? record.function_name.trim()
    : typeof record.function === 'string' ? record.function.trim()
    : '';
  const normalizedToolName = remapWeakModelToolName(typeof record.function === 'string' ? record.function.trim() : directName);
  const directArguments = inferImplicitToolArguments(normalizedToolName, record.arguments ?? record.parameters, record);
  const functionRecord = toObjectRecord(record.function);
  const normalizedArguments = normalizeParsedToolArguments(functionRecord?.arguments ?? directArguments);

  const parsedToolCall: ParsedToolCall = {
    name: remapWeakModelToolName(typeof functionRecord?.name === 'string' ? functionRecord.name.trim() : directName),
    arguments: normalizedArguments
  };

  if (!parsedToolCall.name) {
    return undefined;
  }

  return {
    type: 'function',
    function: {
      name: parsedToolCall.name,
      arguments: parsedToolCall.arguments
    }
  };
}

function toObjectRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function normalizeParsedToolArguments(value: unknown): Record<string, unknown> | string | undefined {
  if (typeof value === 'string') {
    return value;
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return remapWeakModelArgumentAliases(value as Record<string, unknown>);
  }

  return undefined;
}

function inferImplicitToolArguments(toolName: string, explicitArguments: unknown, record: Record<string, unknown>): unknown {
  if (explicitArguments !== undefined) {
    return explicitArguments;
  }

  const rest = { ...record };
  delete rest.type;
  delete rest.name;
  delete rest.function_name;
  delete rest.function;
  delete rest.arguments;
  delete rest.parameters;

  if (Object.keys(rest).length === 0) {
    return undefined;
  }

  if (toolName === 'create_or_edit_file') {
    const filename = rest.filename ?? rest.filepath ?? rest.path;
    const content = rest.content;
    if (typeof filename === 'string' && typeof content === 'string') {
      return { filename, content };
    }
  }

  if (toolName === 'write_to_file') {
    const filepath = rest.filepath ?? rest.filename ?? rest.path;
    const content = rest.content;
    if (typeof filepath === 'string' && typeof content === 'string') {
      return { filepath, content };
    }
  }

  if (toolName === 'replace_in_file') {
    const filepath = rest.filepath ?? rest.filename ?? rest.path;
    const oldText = rest.old_text ?? rest.old_content ?? rest.old_string ?? rest.old_code;
    const newText = rest.new_text ?? rest.new_content ?? rest.new_string ?? rest.new_code;
    if (typeof filepath === 'string' && typeof oldText === 'string' && typeof newText === 'string') {
      return { filepath, old_text: oldText, new_text: newText };
    }
  }

  if (toolName === 'read_specific_file') {
    const filepath = rest.filepath ?? rest.filename ?? rest.path;
    if (typeof filepath === 'string') {
      return { filepath };
    }
  }

  return rest;
}