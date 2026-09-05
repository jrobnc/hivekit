import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSuccessCriteria, extractSection } from 'hivekit/intent';

test('package self-reference exposes intent compiler helpers', () => {
  const raw = `# Example\n\n## Objective\nStay aligned.\n\n## Success Criteria\n- [auto] tests pass\n- [judge] architecture is restrained\n- human approval required\n`;

  assert.equal(extractSection(raw, 'Objective'), 'Stay aligned.');
  assert.deepEqual(extractSuccessCriteria(raw), [
    { tier: 'auto', text: 'tests pass' },
    { tier: 'judge', text: 'architecture is restrained' },
    { tier: 'human', text: 'human approval required' },
  ]);
});
