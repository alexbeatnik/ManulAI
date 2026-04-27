import * as assert from 'assert';
import { describe, it } from 'node:test';
import { estimateTokens, getContextWindow, getMaxPromptTokens, DEFAULT_CONTEXT_WINDOW } from './modelContextConfig';

describe('modelContextConfig', () => {
  describe('estimateTokens', () => {
    it('should correctly estimate tokens based on length', () => {
      const text = 'Hello world, this is a test.';
      const expectedTokens = Math.ceil(text.length / 3.5);
      assert.strictEqual(estimateTokens(text), expectedTokens);
    });

    it('should return 0 for empty string', () => {
      assert.strictEqual(estimateTokens(''), 0);
    });
  });

  describe('getContextWindow', () => {
    it('should return correct context window for known models', () => {
      assert.strictEqual(getContextWindow('llama3.1:8b'), 128000);
      assert.strictEqual(getContextWindow('qwen3.6:35b'), 128000);
      assert.strictEqual(getContextWindow('gemma4:9b'), 256000);
      assert.strictEqual(getContextWindow('gemma2:9b'), 8000);
      assert.strictEqual(getContextWindow('phi4-mini'), 128000);
    });

    it('should return default context window for unknown models', () => {
      assert.strictEqual(getContextWindow('unknown-model:1b'), DEFAULT_CONTEXT_WINDOW);
    });
  });

  describe('getMaxPromptTokens', () => {
    it('should apply the safety margin correctly', () => {
      const gemma4Max = getMaxPromptTokens('gemma4');
      assert.strictEqual(gemma4Max, Math.floor(256000 * 0.75));

      const unknownMax = getMaxPromptTokens('unknown');
      assert.strictEqual(unknownMax, Math.floor(DEFAULT_CONTEXT_WINDOW * 0.75));
    });
  });
});
