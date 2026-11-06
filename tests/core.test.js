import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderFromUrl, officialUrl, eligibleDownload, describeError } from '../core.js';

const ORDER = 'ABCD1234-EF5678-9ABCD';

test('orderFromUrl accepts only seller-portal order pages', () => {
  assert.equal(orderFromUrl(`https://sellerportal.tcgplayer.com/orders/${ORDER.toLowerCase()}/`), ORDER);
  assert.equal(orderFromUrl(`https://evil.example/orders/${ORDER}`), null);
  assert.equal(orderFromUrl(`https://sellerportal.tcgplayer.com/orders/${ORDER}/items`), null);
  assert.equal(orderFromUrl('https://sellerportal.tcgplayer.com/orders/NOT-AN-ORDER'), null);
  assert.equal(orderFromUrl('not a url'), null);
});

test('officialUrl requires https on tcgplayer.com', () => {
  assert.ok(officialUrl('https://store.tcgplayer.com/x.pdf'));
  assert.ok(officialUrl('blob:https://sellerportal.tcgplayer.com/1234'));
  assert.ok(!officialUrl('http://sellerportal.tcgplayer.com/x.pdf'));
  assert.ok(!officialUrl('https://tcgplayer.com.evil.example/x.pdf'));
});

test('eligibleDownload matches only an armed, fresh, official packing slip', () => {
  const now = Date.now();
  const pending = { phase: 'armed', expires: now + 60000, created: now - 500 };
  const item = { filename: '/Users/me/Downloads/TCGplayer_PackingSlips_20261002_103919.pdf', state: 'complete', startTime: new Date(now).toISOString(), url: 'blob:https://sellerportal.tcgplayer.com/abc' };
  assert.ok(eligibleDownload(item, pending));
  assert.ok(!eligibleDownload(item, { ...pending, phase: 'processing' }));
  assert.ok(!eligibleDownload(item, { ...pending, expires: now - 1 }));
  assert.ok(!eligibleDownload({ ...item, filename: 'invoice.pdf' }, pending));
  assert.ok(!eligibleDownload({ ...item, startTime: new Date(now - 60000).toISOString() }, pending));
  assert.ok(!eligibleDownload({ ...item, url: 'https://evil.example/x.pdf' }, pending));
});

test('describeError maps Chrome and helper errors to setup guidance', () => {
  assert.equal(describeError('Specified native messaging host not found.').code, 'HELPER_NOT_INSTALLED');
  assert.match(describeError('Specified native messaging host not found.').message, /install.sh/);
  assert.equal(describeError('Access to the specified native messaging host is forbidden.').code, 'EXTENSION_NOT_ALLOWED');
  assert.equal(describeError('PRINTER_QUEUE_UNAVAILABLE').setup, true);
  assert.equal(describeError('PDF_ORDER_MISMATCH').code, 'PDF_ORDER_MISMATCH');
  assert.match(describeError('PDF_ORDER_MISMATCH').message, /Refresh the correct order/);
  assert.equal(describeError('Something else').code, 'LOCAL_PRINT_HELPER_ERROR');
  assert.equal(describeError('FUTURE_STABLE_CODE').code, 'FUTURE_STABLE_CODE');
  assert.match(describeError('FUTURE_STABLE_CODE').message, /queue/);
});

test('a changed-PDF replay preserves its code and requires verification before a new request', () => {
  const refusal = describeError('REQUEST_ID_PDF_MISMATCH');
  assert.equal(refusal.code, 'REQUEST_ID_PDF_MISMATCH');
  assert.equal(refusal.setup, false);
  assert.match(refusal.message, /stop retrying/i);
  assert.match(refusal.message, /verify the order and slip/i);
  assert.match(refusal.message, /printer queue/i);
  assert.doesNotMatch(refusal.message, /nothing was printed/i);
});
