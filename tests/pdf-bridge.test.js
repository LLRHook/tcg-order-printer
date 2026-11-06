import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../pdf-bridge.js', import.meta.url), 'utf8');
const ORIGIN = 'https://sellerportal.tcgplayer.com';
const ORDER = 'ABCD1234-EF5678-9ABCD';
const NEXT_ORDER = '1234ABCD-5678EF-ABCD9';
const TOKEN = '12345678-1234-1234-1234-123456789abc';
const NEXT_TOKEN = 'abcdef12-1234-1234-1234-123456789abc';
const pdf = text => new Blob([`%PDF-1.7\n${text}`], { type: 'application/pdf' });
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// Run the actual main-world script with isolated browser interfaces. No native
// messaging or printer is available to this harness.
function bridge(fetch = async () => new Response()) {
  class EventTarget {
    listeners = new Map();
    addEventListener(type, listener, options) {
      const listeners = this.listeners.get(type) || [];
      listeners.push({ listener, once: options?.once });
      this.listeners.set(type, listeners);
    }
    dispatchEvent(event) {
      for (const entry of [...(this.listeners.get(event.type) || [])]) {
        if (entry.once) this.listeners.set(event.type, this.listeners.get(event.type).filter(item => item !== entry));
        entry.listener.call(this, event);
      }
      return true;
    }
  }
  class HTMLAnchorElement extends EventTarget {
    download = '';
    href = '';
    clicks = 0;
    click() { this.clicks++; }
  }
  class XMLHttpRequest extends EventTarget {
    send() {}
  }
  let sequence = 0;
  class ObjectURL extends URL {
    static createObjectURL() { return `blob:${ORIGIN}/${++sequence}`; }
    static revokeObjectURL() {}
  }
  const messages = [];
  const window = new EventTarget();
  Object.assign(window, { fetch, postMessage: message => messages.push(message) });
  vm.runInNewContext(source, {
    window, document: new EventTarget(), location: { origin: ORIGIN },
    URL: ObjectURL, EventTarget, HTMLAnchorElement, XMLHttpRequest,
    Blob, ArrayBuffer, Uint8Array, btoa,
  });
  return {
    arm(token = TOKEN, orderId = ORDER) {
      window.dispatchEvent({ type: 'message', source: window, origin: ORIGIN, data: { type: 'TCGPRINT_ARM_BRIDGE', token, orderId } });
    },
    captures: () => messages.filter(message => message.type === 'TCGPRINT_PDF_BRIDGE'),
    window, URL: ObjectURL, XMLHttpRequest, HTMLAnchorElement,
  };
}

test('bridge captures a packing slip while an earlier non-PDF blob is being read', async () => {
  const app = bridge();
  app.arm();
  const read = deferred();
  const unrelated = new Blob(['not a pdf'], { type: 'application/octet-stream' });
  unrelated.arrayBuffer = () => read.promise;
  app.URL.createObjectURL(unrelated);
  const slip = pdf('the requested packing slip');
  app.URL.createObjectURL(slip);
  read.resolve(await new Blob(['not a pdf']).arrayBuffer());
  await flush();
  assert.equal(app.captures().length, 1);
  assert.equal(app.captures()[0].pdfBase64, Buffer.from(await slip.arrayBuffer()).toString('base64'));
});

test('bridge ignores fetch responses belonging to a previous print request', async () => {
  const response = deferred();
  const app = bridge(() => response.promise);
  app.arm();
  const fetch = app.window.fetch('/packing-slip');
  app.arm(NEXT_TOKEN, NEXT_ORDER);
  response.resolve(new Response(pdf('previous order'), { headers: { 'content-type': 'application/pdf' } }));
  await fetch;
  await flush();
  assert.equal(app.captures().length, 0, 'a late response must not acquire the next request token');
  app.URL.createObjectURL(pdf('current order'));
  await flush();
  assert.equal(app.captures().length, 1);
  assert.equal(app.captures()[0].token, NEXT_TOKEN);
});

test('bridge ignores fetches started before a print request was armed', async () => {
  const response = deferred();
  const app = bridge(() => response.promise);
  const fetch = app.window.fetch('/unrelated-document');
  app.arm();
  response.resolve(new Response(pdf('unrelated PDF'), { headers: { 'content-type': 'application/pdf' } }));
  await fetch;
  await flush();
  assert.equal(app.captures().length, 0);
});

test('bridge keeps the original request while a fetch response body is read', async () => {
  const body = deferred();
  const app = bridge(async () => ({
    headers: new Headers({ 'content-type': 'application/pdf' }),
    clone: () => ({ blob: () => body.promise }),
  }));
  app.arm();
  await app.window.fetch('/packing-slip');
  app.arm(NEXT_TOKEN, NEXT_ORDER);
  body.resolve(pdf('previous order'));
  await flush();
  assert.equal(app.captures().length, 0);
});

test('bridge ignores XHR responses belonging to a previous print request', async () => {
  const app = bridge();
  app.arm();
  const xhr = new app.XMLHttpRequest();
  xhr.send();
  app.arm(NEXT_TOKEN, NEXT_ORDER);
  xhr.response = await pdf('previous order').arrayBuffer();
  xhr.dispatchEvent({ type: 'load' });
  await flush();
  assert.equal(app.captures().length, 0, 'a late response must not acquire the next request token');
});

test('bridge does not reuse object URLs from a previous print request', async () => {
  const app = bridge();
  app.arm();
  const anchor = new app.HTMLAnchorElement();
  anchor.href = app.URL.createObjectURL(pdf('previous order'));
  anchor.download = 'TCGplayer_PackingSlips_20261022_000000.pdf';
  await flush();
  assert.equal(app.captures().length, 1);
  app.arm(NEXT_TOKEN, NEXT_ORDER);
  anchor.click();
  await flush();
  assert.equal(app.captures().length, 1, 'an old URL must not acquire the next request token');
  assert.equal(anchor.clicks, 1, 'old URLs are left to the site');
});

test('overlapping valid PDFs still produce only one transfer', async () => {
  const app = bridge();
  app.arm();
  const read = deferred();
  const slow = pdf('slow response');
  slow.arrayBuffer = () => read.promise;
  app.URL.createObjectURL(slow);
  const slip = pdf('fast response');
  app.URL.createObjectURL(slip);
  await flush();
  read.resolve(await pdf('slow response').arrayBuffer());
  await flush();
  assert.equal(app.captures().length, 1);
  assert.equal(app.captures()[0].pdfBase64, Buffer.from(await slip.arrayBuffer()).toString('base64'));
});

test('bridge emits the exact PDF bytes once and suppresses the native download', async () => {
  const app = bridge();
  app.arm();
  const slip = pdf('buyer <name> & apartment #2\nitem details');
  const anchor = new app.HTMLAnchorElement();
  anchor.href = app.URL.createObjectURL(slip);
  anchor.download = 'TCGplayer_PackingSlips_20261022_000000.pdf';
  anchor.click();
  anchor.click();
  await flush();
  assert.equal(anchor.clicks, 0);
  assert.equal(app.captures().length, 1);
  assert.equal(app.captures()[0].pdfBase64, Buffer.from(await slip.arrayBuffer()).toString('base64'));
});
