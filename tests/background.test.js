import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as core from '../core.js';

const source = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const ORIGIN = 'https://sellerportal.tcgplayer.com';
const ORDER = 'ABCD1234-EF5678-9ABCD';
const NEXT_ORDER = '1234ABCD-5678EF-ABCD9';
const TOKEN = '12345678-1234-1234-1234-123456789abc';
const NEXT_TOKEN = 'abcdef12-1234-1234-1234-123456789abc';
const VERSION = '1.1.0';

function background() {
  let listener;
  let liveUrl = `${ORIGIN}/orders/${ORDER}`;
  const session = {};
  const nativeCalls = [];
  const sender = { id: 'extension-id', frameId: 0, tab: { id: 7 }, documentId: 'document-a', url: liveUrl, origin: ORIGIN };
  const chrome = {
    runtime: {
      id: sender.id,
      getManifest: () => ({ version: VERSION }),
      getURL: path => `chrome-extension://${sender.id}/${path}`,
      onInstalled: { addListener() {} },
      onMessage: { addListener(fn) { listener = fn; } },
      async sendNativeMessage(host, message) {
        assert.equal(host, core.HOST);
        nativeCalls.push(message);
        return { ok: true, state: message.command === 'print' ? 'completed' : 'ready' };
      },
    },
    tabs: {
      get: async () => ({ id: sender.tab.id, url: liveUrl }),
      sendMessage: async () => {},
    },
    storage: {
      session: {
        get: async key => ({ [key]: structuredClone(session[key]) }),
        set: async value => Object.assign(session, structuredClone(value)),
        remove: async key => { delete session[key]; },
      },
      local: { set: async () => {} },
    },
    downloads: { onChanged: { addListener() {} } },
  };
  // Resolve the module's sole import with the actual core exports, leaving the
  // service worker and its registered message handler unchanged.
  const script = source.replace(/^import .* from '\.\/core\.js';\n/, '');
  assert.notEqual(script, source);
  vm.runInNewContext(script, { chrome, URL, console, ...core });
  return {
    sender, nativeCalls,
    navigate(orderId) { liveUrl = `${ORIGIN}/orders/${orderId}`; },
    request(message, from = sender) {
      return new Promise(resolve => { assert.equal(listener(message, from, resolve), true); });
    },
    arm(orderId = ORDER, token = TOKEN) {
      return this.request({ type: 'TCGPRINT_ARM', orderId, token, clientVersion: VERSION });
    },
  };
}

test('an order navigation can cancel its armed request and print the next order', async () => {
  const app = background();
  assert.equal((await app.arm()).ok, true);
  app.navigate(NEXT_ORDER);
  const cancelled = await app.request({ type: 'TCGPRINT_CANCEL', orderId: ORDER, token: TOKEN });
  assert.equal(cancelled.ok, true, cancelled.error);
  const armed = await app.arm(NEXT_ORDER, NEXT_TOKEN);
  assert.equal(armed.ok, true, armed.error);
  const printed = await app.request({ type: 'TCGPRINT_PDF', orderId: NEXT_ORDER, token: NEXT_TOKEN, pdfBase64: 'JVBERi0=' });
  assert.equal(printed.ok, true, printed.error);
  assert.equal(app.nativeCalls.filter(call => call.command === 'print').length, 1);
  assert.equal(app.nativeCalls.at(-1).orderId, NEXT_ORDER);
});

test('cancellation still requires the original tab, document, and request token', async () => {
  const app = background();
  assert.equal((await app.arm()).ok, true);
  app.navigate(NEXT_ORDER);
  const message = { type: 'TCGPRINT_CANCEL', orderId: ORDER, token: TOKEN };
  for (const sender of [
    { ...app.sender, tab: { id: 8 } },
    { ...app.sender, documentId: 'document-b' },
    { ...app.sender, frameId: 1 },
    { ...app.sender, origin: 'https://evil.example' },
    { ...app.sender, url: 'https://evil.example' },
    { ...app.sender, id: 'other-extension' },
  ]) {
    assert.equal((await app.request(message, sender)).ok, false);
  }
  assert.equal((await app.request({ ...message, token: NEXT_TOKEN })).ok, false);
  assert.equal((await app.request({ ...message, orderId: NEXT_ORDER })).ok, false);
  assert.equal((await app.arm(NEXT_ORDER, NEXT_TOKEN)).ok, false, 'failed cancellations must retain the existing request');
});

test('PDF delivery after navigation never reaches the native print helper', async () => {
  const app = background();
  assert.equal((await app.arm()).ok, true);
  app.navigate(NEXT_ORDER);
  const response = await app.request({ type: 'TCGPRINT_PDF', orderId: ORDER, token: TOKEN, pdfBase64: 'JVBERi0=' });
  assert.equal(response.ok, false);
  assert.equal(app.nativeCalls.filter(call => call.command === 'print').length, 0);
});

test('duplicate PDF messages are handed to the native helper only once', async () => {
  const app = background();
  assert.equal((await app.arm()).ok, true);
  const message = { type: 'TCGPRINT_PDF', orderId: ORDER, token: TOKEN, pdfBase64: 'JVBERi0=' };
  const results = await Promise.all([app.request(message), app.request(message)]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(app.nativeCalls.filter(call => call.command === 'print').length, 1);
});
