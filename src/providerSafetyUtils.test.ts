import * as assert from 'node:assert';
import { describe, it } from 'node:test';
import { inferBuildVerifyStack, isTerminalReadOnlyInspectionCommand } from './providerSafetyUtils';

describe('providerSafetyUtils', () => {
  describe('inferBuildVerifyStack', () => {
    it('infers rust', () => {
      assert.strictEqual(inferBuildVerifyStack('error[e1234]: oops rustc'), 'rust');
      assert.strictEqual(inferBuildVerifyStack('cargo check'), 'rust');
    });

    it('infers go', () => {
      assert.strictEqual(inferBuildVerifyStack('go test ./...'), 'go');
      assert.strictEqual(inferBuildVerifyStack('undefined: manul'), 'go');
    });

    it('infers python', () => {
      assert.strictEqual(inferBuildVerifyStack('Traceback (most recent call last):'), 'python');
      assert.strictEqual(inferBuildVerifyStack('SyntaxError: invalid syntax'), 'python');
    });
  });

  describe('isTerminalReadOnlyInspectionCommand', () => {
    it('allows simple read tools', () => {
      assert.strictEqual(isTerminalReadOnlyInspectionCommand('cat package.json'), true);
      assert.strictEqual(isTerminalReadOnlyInspectionCommand('head -n 20 src/main.rs'), true);
      assert.strictEqual(isTerminalReadOnlyInspectionCommand('ls -la'), true);
    });

    it('rejects commands with operators or dangerous flags', () => {
      assert.strictEqual(isTerminalReadOnlyInspectionCommand('cat foo.txt ; rm -rf /'), false);
      assert.strictEqual(isTerminalReadOnlyInspectionCommand('ls && echo hi'), false);
      assert.strictEqual(isTerminalReadOnlyInspectionCommand('sed -i s/a/b/ file.txt'), false);
      assert.strictEqual(isTerminalReadOnlyInspectionCommand('find . -exec rm {} \\;'), false);
    });
  });
});
