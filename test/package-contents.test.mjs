import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('package includes external-consumer intent artifacts', () => {
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    encoding: 'utf8',
  });
  const packed = JSON.parse(raw)[0];
  const files = new Set(packed.files.map((file) => file.path));

  assert.ok(files.has('dist/intent.js'), 'dist/intent.js must be packaged');
  assert.ok(files.has('dist/intent.d.ts'), 'dist/intent.d.ts must be packaged');
  assert.ok(files.has('dist/types.js'), 'dist/types.js must be packaged');
  assert.ok(files.has('dist/types.d.ts'), 'dist/types.d.ts must be packaged');
});
