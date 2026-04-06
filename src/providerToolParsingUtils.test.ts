import * as assert from 'node:assert';
import { describe, it } from 'node:test';
import { parseToolCallsFromContent } from './providerToolParsingUtils';
import type { ToolDefinition } from './types';

const TOOL_DEFS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'create_or_edit_file',
      description: 'Create or edit a file',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['filename', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_specific_file',
      description: 'Read a file',
      parameters: {
        type: 'object',
        properties: { filepath: { type: 'string' } },
        required: ['filepath']
      }
    }
  }
];

describe('providerToolParsingUtils', () => {
  describe('parseToolCallsFromContent — text-tool format', () => {
    it('parses a clean single-line {"tool": ..., "args": {...}} object', () => {
      const content = '{"tool": "create_or_edit_file", "args": {"filename": "hello.py", "content": "print(1)"}}';
      const result = parseToolCallsFromContent(content, TOOL_DEFS);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].function.name, 'create_or_edit_file');
      const args = result[0].function.arguments as Record<string, unknown>;
      assert.strictEqual(args.filename, 'hello.py');
    });

    it('parses {"tool": ..., "args": {...}} embedded in surrounding prose', () => {
      const content = 'Sure, here is the file:\n{"tool": "create_or_edit_file", "args": {"filename": "main.py", "content": "# main"}}\nLet me know if you want more.';
      const result = parseToolCallsFromContent(content, TOOL_DEFS);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].function.name, 'create_or_edit_file');
    });

    it('recovers truncated/unbalanced JSON via brace-padding fallback', () => {
      // Missing closing braces — should still parse with the recovery loop
      const content = '{"tool": "read_specific_file", "args": {"filepath": "src/main.ts"';
      const result = parseToolCallsFromContent(content, TOOL_DEFS);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].function.name, 'read_specific_file');
    });

    it('ignores args that are null or an array in the text-tool block specifically', () => {
      // Embed JSON in prose so it goes through the text-tool block rather than the
      // top-level normalizeParsedToolCalls path — the guard must not crash and must
      // not return a valid tool call from that block.
      const nullArgs = 'Here: {"tool": "create_or_edit_file", "args": null} done.';
      const result1 = parseToolCallsFromContent(nullArgs, TOOL_DEFS);
      // May be empty or contain a tool call with no/undefined args, but must not throw
      if (result1.length > 0) {
        const args = result1[0].function.arguments as Record<string, unknown> | undefined;
        assert.ok(args === undefined || (typeof args === 'object' && !Array.isArray(args)), 'args must be undefined or a plain object');
      }

      const arrayArgs = 'Here: {"tool": "create_or_edit_file", "args": [1, 2, 3]} done.';
      const result2 = parseToolCallsFromContent(arrayArgs, TOOL_DEFS);
      if (result2.length > 0) {
        const args = result2[0].function.arguments as Record<string, unknown> | undefined;
        assert.ok(args === undefined || (typeof args === 'object' && !Array.isArray(args)), 'args must be undefined or a plain object');
      }
    });
  });
});
