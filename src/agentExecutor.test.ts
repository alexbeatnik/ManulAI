import * as assert from 'assert';
import { describe, it } from 'node:test';
const Module = require('module');

const originalLoad = Module._load;
Module._load = function (request: string, parent: any, isMain: boolean) {
  if (request === 'vscode') {
    return {
      window: {},
      workspace: {},
      Uri: {}
    };
  }
  return originalLoad.apply(this, arguments);
};

import { extractToolCallsFromText, stripToolCallsFromText } from './agentExecutor';

describe('agentExecutor', () => {
  describe('extractToolCallsFromText', () => {
    it('should extract tools in standard args format', () => {
      const text = `Some thoughts\n{"tool": "read_specific_file", "args": {"filepath": "README.md"}}\nMore thoughts`;
      const tools = extractToolCallsFromText(text);
      assert.strictEqual(tools.length, 1);
      assert.strictEqual(tools[0].function.name, 'read_specific_file');
      assert.deepStrictEqual(tools[0].function.arguments, { filepath: 'README.md' });
    });

    it('should extract tools in parameters format', () => {
      const text = `{"tool": "project_scan", "parameters": {}}`;
      const tools = extractToolCallsFromText(text);
      assert.strictEqual(tools.length, 1);
      assert.strictEqual(tools[0].function.name, 'project_scan');
      assert.deepStrictEqual(tools[0].function.arguments, {});
    });

    it('should extract tools in flat format', () => {
      const text = `{"tool": "create_file", "filename": "test.txt", "content": "hello"}`;
      const tools = extractToolCallsFromText(text);
      assert.strictEqual(tools.length, 1);
      // create_file aliases to create_or_edit_file
      assert.strictEqual(tools[0].function.name, 'create_or_edit_file');
      assert.deepStrictEqual(tools[0].function.arguments, { filename: 'test.txt', content: 'hello' });
    });

    it('should ignore duplicate identical tool calls', () => {
      const text = `
      {"tool": "read_specific_file", "args": {"filepath": "A"}}
      {"tool": "read_specific_file", "args": {"filepath": "A"}}
      `;
      const tools = extractToolCallsFromText(text);
      assert.strictEqual(tools.length, 1);
    });
  });

  describe('stripToolCallsFromText', () => {
    it('should strip json tool calls', () => {
      const text = `Here is my plan:\n{"tool": "read_specific_file", "args": {"filepath": "README.md"}}\nDone.`;
      const stripped = stripToolCallsFromText(text);
      assert.strictEqual(stripped, 'Here is my plan:\n\nDone.');
    });

    it('should strip markdown-wrapped tool calls', () => {
      const text = 'Plan:\n```json\n{"tool": "read_specific_file", "args": {"filepath": "README.md"}}\n```\nDone.';
      const stripped = stripToolCallsFromText(text);
      assert.strictEqual(stripped, 'Plan:\n\nDone.');
    });

    it('should strip ChatML tags and think tags', () => {
      const text = '<think>\nThinking...\n</think>\n<|im_start|>assistant\nHello';
      const stripped = stripToolCallsFromText(text);
      assert.strictEqual(stripped, 'Thinking...\n\nHello');
    });
  });
});
