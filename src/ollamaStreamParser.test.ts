import * as assert from 'assert';
import { describe, it } from 'node:test';
import { OllamaStreamParser } from './ollamaStreamParser';

describe('OllamaStreamParser', () => {
  it('should parse content correctly', () => {
    const parser = new OllamaStreamParser();
    const chunks = parser.parse('{"message": {"content": "Hello"}}\n{"message": {"content": " World"}}\n');
    assert.strictEqual(chunks.length, 2);
    assert.strictEqual(chunks[0].content, 'Hello');
    assert.strictEqual(chunks[1].content, ' World');
  });

  it('should parse reasoning correctly', () => {
    const parser = new OllamaStreamParser();
    const raw = '{"message": {"content": "<think>"}}\n{"message": {"content": "Reasoning"}}\n{"message": {"content": "</think>"}}\n{"message": {"content": "Done"}}\n';
    const chunks = parser.parse(raw);
    
    // The chunks might be empty or combined based on the internal logic,
    // let's accumulate them to verify.
    let content = '';
    let reasoning = '';
    for (const chunk of chunks) {
      if (chunk.content) content += chunk.content;
      if (chunk.reasoning) reasoning += chunk.reasoning;
    }
    
    assert.strictEqual(reasoning, 'Reasoning');
    assert.strictEqual(content, 'Done');
  });

  it('should handle DONE marker', () => {
    const parser = new OllamaStreamParser();
    const chunks = parser.parse('{"done": true}\n');
    assert.strictEqual(chunks.length, 1);
    assert.strictEqual(chunks[0].done, true);
  });

  it('should handle [DONE] string marker', () => {
    const parser = new OllamaStreamParser();
    const chunks = parser.parse('[DONE]\n');
    assert.strictEqual(chunks.length, 1);
    assert.strictEqual(chunks[0].done, true);
  });
});
