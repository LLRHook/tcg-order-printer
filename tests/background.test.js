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

function background(nativeHandler) {
  let listener;
  let downloadListener;
  let liveUrl = `${ORIGIN}/orders/${ORDER}`;
  const session = {};
  const nativeCalls = [];
  const statuses = [];
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
        if (nativeHandler) return nativeHandler(message);
        return { ok: true, protocolVersion: 2, printer: 'Synthetic_Test_Queue', state: message.command === 'print' ? 'completed' : 'ready', orderId: message.orderId, requestId: message.requestId };
      },
    },
    tabs: {
      get: async () => ({ id: sender.tab.id, url: liveUrl }),
      sendMessage: async (id, message) => { statuses.push(message); },
    },
    storage: {
      session: {
        get: async key => ({ [key]: structuredClone(session[key]) }),
        set: async value => Object.assign(session, structuredClone(value)),
        remove: async key => { delete session[key]; },
      },
      local: { set: async () => {} },
    },
    downloads: { onChanged: { addListener(fn) { downloadListener = fn; } }, search: async () => [] },
  };
  // Resolve the module's sole import with the actual core exports, leaving the
  // service worker and its registered message handler unchanged.
  const script = source.replace(/^import .* from '\.\/core\.js';\n/, '');
  assert.notEqual(script, source);
  vm.runInNewContext(script, { chrome, URL, console, atob, ...core });
  return {
    sender, nativeCalls, session, chrome, statuses,
    download: delta => downloadListener(delta),
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

test('malformed messages, UUIDs and PDF fields never reach native printing', async () => {
  const app = background();
  for (const message of [null, {}, { type: 'TCGPRINT_ARM', orderId: ORDER, token: '-'.repeat(36), clientVersion: VERSION }]) {
    assert.equal((await app.request(message)).ok, false);
  }
  assert.equal((await app.arm()).ok, true);
  for (const pdfBase64 of ['', 'not base64!', 'JVBERi0', 'SGVsbG8=', 12, null]) {
    const result = await app.request({ type: 'TCGPRINT_PDF', orderId: ORDER, token: TOKEN, pdfBase64 });
    assert.equal(result.ok, false, `must refuse ${JSON.stringify(pdfBase64)}`);
  }
  assert.equal(app.nativeCalls.filter(call => call.command === 'print').length, 0);
});

test('navigation while the setup ping is pending cannot arm the old order', async () => {
  let release;
  const app = background(() => new Promise(resolve => { release = resolve; }));
  const arming = app.arm();
  await new Promise(resolve => setImmediate(resolve));
  app.navigate(NEXT_ORDER);
  release({ ok: true, state: 'ready', protocolVersion: 2, printer: 'Synthetic_Test_Queue' });
  assert.equal((await arming).ok, false);
  assert.equal(app.session.pending, undefined);
});

test('helper success must echo the exact order, request and a known queue state', async () => {
  for (const patch of [{ orderId: NEXT_ORDER }, { requestId: NEXT_TOKEN }, { orderId: undefined }, { state: 'unknown' }]) {
    const app = background(message => message.command === 'ping'
      ? { ok: true, state: 'ready', protocolVersion: 2, printer: 'Synthetic_Test_Queue' }
      : { ok: true, state: 'submitted', orderId: message.orderId, requestId: message.requestId, ...patch });
    assert.equal((await app.arm()).ok, true);
    const result = await app.request({ type: 'TCGPRINT_PDF', orderId: ORDER, token: TOKEN, pdfBase64: 'JVBERi0=' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'HELPER_RESPONSE_MISMATCH');
    assert.match(result.error, /queue/i);
  }
});

test('connection checks reject an old protocol or incomplete readiness response', async () => {
  for (const response of [{ ok: true }, { ok: true, state: 'ready', printer: 'Synthetic_Test_Queue', protocolVersion: 1 }, { ok: 'true', state: 'ready', protocolVersion: 2 }]) {
    const app = background(() => response);
    const result = await app.arm();
    assert.equal(result.ok, false);
    assert.equal(app.session.pending, undefined);
    assert.equal(result.setup, true);
  }
});

test('malformed native print failures require a queue check instead of retry-safe refusal', async () => {
  for (const error of [['PDF_ORDER_MISMATCH'], { code: 'PDF_ORDER_MISMATCH' }, null, '', 42, 'PDF_ORDER_MISMATCH\n']) {
    const app = background(message => message.command === 'ping'
      ? { ok: true, state: 'ready', protocolVersion: 2, printer: 'Synthetic_Test_Queue' }
      : { ok: false, error });
    assert.equal((await app.arm()).ok, true);
    const result = await app.request({ type: 'TCGPRINT_PDF', orderId: ORDER, token: TOKEN, pdfBase64: 'JVBERi0=' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'HELPER_RESPONSE_MISMATCH');
    assert.match(result.error, /queue.*may already have been submitted/i);
    assert.doesNotMatch(result.error, /nothing was printed/i);
  }
});

test('malformed native ping failures cannot masquerade as a print refusal', async () => {
  const app = background(() => ({ ok: false, error: ['PDF_ORDER_MISMATCH'] }));
  const result = await app.arm();
  assert.equal(result.code, 'INVALID_HELPER_RESPONSE');
  assert.equal(result.setup, true);
  assert.equal(app.session.pending, undefined);
});

test('native error codes are preserved and private diagnostic text is hidden', async () => {
  for (const code of ['REQUEST_ID_ORDER_MISMATCH', 'REQUEST_ID_PDF_MISMATCH', 'INVALID_ORDER_REQUEST', 'INVALID_PRINT_REQUEST', 'PDF_BYTES_REQUIRED', 'INVALID_PDF_ENCODING', 'PDF_ORDER_MISMATCH', 'PREVIOUS_SUBMISSION_NEEDS_QUEUE_CHECK']) {
    const app = background(message => message.command === 'ping'
      ? { ok: true, state: 'ready', protocolVersion: 2, printer: 'Synthetic_Test_Queue' }
      : { ok: false, error: code });
    assert.equal((await app.arm()).ok, true);
    const result = await app.request({ type: 'TCGPRINT_PDF', orderId: ORDER, token: TOKEN, pdfBase64: 'JVBERi0=' });
    assert.equal(result.code, code);
    assert.notEqual(result.error, code, 'a machine code alone is not actionable');
  }
  const app = background(() => { throw new Error('Traceback: /private/synthetic/return-address.json'); });
  const result = await app.arm();
  assert.equal(result.code, 'LOCAL_PRINT_HELPER_ERROR');
  assert.doesNotMatch(result.error, /private|Traceback|return-address.json/);
});

test('a completed download clears the request with an actionable no-print status', async () => {
  const app = background();
  assert.equal((await app.arm()).ok, true);
  app.chrome.downloads.search = async () => [{ state: 'complete', filename: 'TCGplayer_PackingSlips_synthetic.pdf', startTime: new Date().toISOString(), url: `${ORIGIN}/synthetic.pdf` }];
  app.download({ id: 1, state: { current: 'complete' } });
  // Queue a message behind the asynchronous download handler.
  await app.request({ type: 'TCGPRINT_PING' }, { id: app.sender.id, url: 'chrome-extension://extension-id/setup.html' });
  assert.equal(app.nativeCalls.filter(call => call.command === 'print').length, 0);
  assert.equal(app.session.pending, undefined);
  assert.match(app.statuses.at(-1).error, /nothing printed.*refresh/i);
});
