import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('import center inline scripts compile before page initialization', () => {
  const html = fs.readFileSync(new URL('../public/import-center.html', import.meta.url), 'utf8');
  let checked = 0;
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\bsrc\s*=/.test(match[1]) || !match[2].trim()) continue;
    assert.doesNotThrow(() => new vm.Script(match[2], { filename: 'public/import-center.html:inline' }));
    checked++;
  }
  assert.ok(checked > 0, 'must compile at least one inline script');
});
