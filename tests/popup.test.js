import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('a duplicate acknowledgement does not imply completed printing in the popup', async () => {
  const elements = Object.fromEntries(['last', 'status', 'check', 'setup'].map(id => [id, { textContent: '', addEventListener() {} }]));
  const chrome = {
    runtime: { sendMessage: async () => ({ ok: true, printer: 'Synthetic_Test_Queue' }) },
    storage: { local: { get: async () => ({ lastResult: { orderId: 'ABCD1234-EF5678-9ABCD', ok: true, state: 'duplicate', time: 0 } }) } },
  };
  vm.runInNewContext(readFileSync(new URL('../popup.js', import.meta.url), 'utf8'), {
    chrome, document: { getElementById: id => elements[id] },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(elements.last.textContent, /already sent/);
  assert.doesNotMatch(elements.last.textContent, /printed/);
});
