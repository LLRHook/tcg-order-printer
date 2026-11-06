import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeHarness, EXTENSION_ID } from './native-harness.mjs';
import { ORDER, OTHER_ORDER, syntheticSlip } from './fixtures/synthetic-slip.mjs';

// Browser + actual framed native messaging, with an isolated host that has no
// printing capability. No user host manifests, profiles or orders are read.
const EXT = fileURLToPath(new URL('..', import.meta.url));
const ORIGIN = 'https://sellerportal.tcgplayer.com';
const root = mkdtempSync(join(tmpdir(), 'tcg-order-printer-e2e-'));
const harness = nativeHarness(root);
const executablePath = process.env.TCG_E2E_BROWSER || chromium.executablePath();
let context, worker, id, installedSetup;
let scenario = {};
const printCalls = () => harness.calls().filter(call => call.command === 'print');
async function barrier() {
  // runtime.sendMessage excludes its own sending context, so send from a real
  // extension page rather than the worker whose queue is being drained.
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${id}/popup.html`);
    return await page.evaluate(() => chrome.runtime.sendMessage({ type: 'TCGPRINT_PING' }));
  } finally { await page.close(); }
}
const pending = () => worker.evaluate(async () => (await chrome.storage.session.get('pending')).pending);
function html(options) {
  const payload = options.pdfBase64 ?? syntheticSlip(options.slipOrder || ORDER).toString('base64');
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
<h2 data-testid="txtOrderHeader">Order: ${ORDER}</h2>
<div class="customer-details__actions"><div class="tcg-popover"><button class="tcg-popover__trigger" data-testid="OrderDetails_CustomerDetails_btnPackingSlip" id="packing">Packing Slip</button></div></div>
<div id="menu" hidden><button data-testid="OrderDetails_PackingSlipList_btnDownloadDefaultByRelease" id="dl">Print Default</button></div>
<script>
const options = ${JSON.stringify(options)};
window.exportsStarted = 0;
window.addEventListener('message', event => { if(event.data?.type === 'TCGPRINT_ARM_BRIDGE') window.armed = event.data; });
document.getElementById('packing').onclick = () => { if(!options.holdMenu) document.getElementById('menu').hidden = false; };
window.emitSlip = () => {
  const a = document.createElement('a'); a.download = 'TCGplayer_PackingSlips_synthetic.pdf';
  if(options.delivery === 'disk') a.href = '/synthetic-slip.pdf';
  else {
    const bytes = Uint8Array.from(atob('${payload}'), c => c.charCodeAt(0));
    a.href = URL.createObjectURL(new Blob([bytes], { type:'application/pdf' }));
  }
  a.click();
};
document.getElementById('dl').onclick = () => {
  window.exportsStarted++;
  if(options.delivery === 'malformed') window.postMessage({ type:'TCGPRINT_PDF_BRIDGE', ...window.armed, type:'TCGPRINT_PDF_BRIDGE', pdfBase64:'not base64!' }, location.origin);
  else if(options.delivery !== 'hold') window.emitSlip();
};
</script></body></html>`;
}
async function orderPage(t, options = {}, config = {}) {
  scenario = options; harness.configure(config);
  const page = await context.newPage();
  const downloads = []; page.on('download', download => downloads.push(download));
  t.after(async () => { await page.close(); });
  await page.goto(`${ORIGIN}/orders/${ORDER}`);
  await page.waitForSelector('#tcgprint-button');
  return { page, downloads };
}
async function errorText(page) {
  await page.waitForFunction(() => document.querySelector('#tcgprint-status')?.classList.contains('tcgprint-error'));
  return page.textContent('#tcgprint-status');
}
async function setupPage(t) {
  const page = await context.newPage(); t.after(() => page.close());
  await page.goto(`chrome-extension://${id}/setup.html`);
  await page.waitForFunction(() => !document.getElementById('status-title').textContent.startsWith('Checking'));
  return page;
}
before(async () => {
  assert.ok(existsSync(executablePath), 'No cached browser. Set TCG_E2E_BROWSER to an existing extension-capable Chromium executable; do not download an engine for this test.');
  context = await chromium.launchPersistentContext(harness.profile, {
    executablePath, headless: true, acceptDownloads: true,
    env: { ...process.env, HOME: harness.home, XDG_CONFIG_HOME: join(harness.home, '.config') },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--use-mock-keychain', '--password-store=basic', '--disable-background-networking'],
  });
  await context.route('**/*', route => {
    if (route.request().url().startsWith('chrome-extension://')) return route.continue();
    if (route.request().url() === `${ORIGIN}/synthetic-slip.pdf`) return route.fulfill({ contentType: 'application/pdf', headers: { 'content-disposition': 'attachment; filename="TCGplayer_PackingSlips_synthetic.pdf"' }, body: syntheticSlip() });
    if (route.request().url().startsWith(`${ORIGIN}/orders/`)) return route.fulfill({ contentType: 'text/html', body: html(scenario) });
    return route.abort();
  });
  [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  id = worker.url().split('/')[2];
  context.setDefaultTimeout(8000);
  const probe = await worker.evaluate(async () => {
    try { return await chrome.runtime.sendNativeMessage('io.github.llrhook.tcg_order_printer', { command: 'ping' }); }
    catch (error) { return { error: error.message }; }
  });
  assert.equal(probe.printer, 'Synthetic_Test_Queue', `Safe native host did not respond: ${JSON.stringify(probe)}`);
  assert.ok(harness.calls().some(call => call.command === 'ping'), 'Stop before any print test unless the isolated executable has actually received the connection probe.');
  console.log(`Browser: ${context.browser().version()}; native host: isolated synthetic stub; physical printing: unavailable`);
});
after(async () => { try { await context?.close(); } finally { rmSync(root, { recursive: true, force: true }); } });

test('development ID and first-run setup use the safe framed native host', async () => {
  assert.equal(id, EXTENSION_ID);
  await worker.evaluate(() => chrome.runtime.getManifest());
  // onInstalled opens this page; wait for it instead of fabricating the result.
  installedSetup = context.pages().find(page => page.url().endsWith('/setup.html'));
  if (!installedSetup) installedSetup = await context.waitForEvent('page');
  await installedSetup.waitForURL(`chrome-extension://${id}/setup.html`);
  await installedSetup.waitForFunction(() => document.getElementById('status-title').textContent === 'Ready to print');
  assert.equal(await installedSetup.textContent('#extension-id'), id);
  assert.match(await installedSetup.textContent('#status-detail'), /Synthetic_Test_Queue/);
  assert.equal(harness.calls().some(call => call.command === 'ping'), true, 'actual native framing must reach the isolated executable');
  await installedSetup.close();
});

test('popup reports the synthetic connection without submitting a print', async t => {
  harness.configure();
  const popup = await context.newPage(); t.after(() => popup.close());
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.waitForFunction(() => document.getElementById('status').textContent.startsWith('Ready'));
  assert.match(await popup.textContent('#status'), /Synthetic_Test_Queue/);
  assert.equal(printCalls().length, 0);
});

for (const code of ['SETUP_REQUIRED', 'PRINTER_NOT_CONFIGURED', 'RETURN_ADDRESS_NOT_CONFIGURED', 'PRINTER_QUEUE_UNAVAILABLE', 'Specified native messaging host not found.', 'Access to the specified native messaging host is forbidden.']) {
  test(`setup gives an actionable fix for ${code}`, async t => {
    harness.configure({ pingError: code });
    const page = await setupPage(t);
    assert.match(await page.textContent('#status-title'), /wizard|install.sh|Reconnect/);
    assert.match(await page.textContent('#status-detail'), /Error code:/);
    assert.equal(printCalls().length, 0);
  });
}

test('an old helper protocol is diagnosed before an order can export', async t => {
  const { page } = await orderPage(t, {}, { protocolVersion: 1 });
  await page.click('#tcgprint-button');
  assert.match(await errorText(page), /helper needs updating.*install.sh/i);
  assert.equal(await page.evaluate(() => window.exportsStarted), 0);
  assert.equal(printCalls().length, 0);
});

test('a mismatched slip is refused with its stable code and visible recovery step', async t => {
  const { page, downloads } = await orderPage(t, { slipOrder: OTHER_ORDER });
  await page.click('#tcgprint-button');
  assert.match(await errorText(page), /different order.*Nothing was printed.*Refresh/);
  assert.equal(printCalls().length, 1);
  assert.equal(downloads.length, 0);
  const last = await worker.evaluate(async () => (await chrome.storage.local.get('lastResult')).lastResult);
  assert.equal(last.code, 'PDF_ORDER_MISMATCH');
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `error status must fit at ${width}px`);
    assert.equal(await page.locator('#tcgprint-status').isVisible(), true);
  }
  await page.focus('#tcgprint-button');
  assert.equal(await page.getAttribute('#tcgprint-button', 'aria-busy'), 'false');
});

for (const code of ['INVALID_MESSAGE', 'INVALID_ORDER_REQUEST', 'INVALID_PRINT_REQUEST', 'PDF_BYTES_REQUIRED', 'INVALID_PDF_ENCODING', 'INVALID_OR_INCOMPLETE_PDF', 'UNSUPPORTED_PACKING_SLIP', 'REQUEST_ID_ORDER_MISMATCH', 'PREVIOUS_SUBMISSION_NEEDS_QUEUE_CHECK', 'PRINTER_JOB_CANCELLED_OR_ABORTED', 'LOCAL_PRINT_HELPER_ERROR']) {
  test(`framed helper refusal preserves ${code} and supplies an action`, async t => {
    const { page } = await orderPage(t, {}, { printError: code });
    await page.click('#tcgprint-button');
    assert.match(await errorText(page), /refresh|check|use the official/i);
    const last = await worker.evaluate(async () => (await chrome.storage.local.get('lastResult')).lastResult);
    assert.equal(last.code, code);
    assert.equal(last.ok, false);
  });
}

for (const printReply of [{ orderId: OTHER_ORDER }, { requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }, { state: 'unknown' }]) {
  test(`an unrelated helper acknowledgement cannot report success: ${JSON.stringify(printReply)}`, async t => {
    const { page } = await orderPage(t, {}, { printReply });
    await page.click('#tcgprint-button');
    assert.match(await errorText(page), /did not confirm.*Check the printer queue/);
    assert.equal(await page.textContent('#tcgprint-button'), 'Print both');
    assert.equal(printCalls().length, 1, 'do not automatically resubmit an uncertain job');
  });
}

test('a double click exports and submits exactly once with unchanged PDF bytes', async t => {
  const { page, downloads } = await orderPage(t, {}, { printDelayMs: 200 });
  await page.evaluate(() => {
    const button = document.querySelector('#tcgprint-button');
    button.dispatchEvent(new MouseEvent('click')); button.dispatchEvent(new MouseEvent('click'));
  });
  await page.waitForFunction(() => document.querySelector('#tcgprint-button')?.textContent === 'Sent ✓');
  assert.equal(await page.evaluate(() => window.exportsStarted), 1);
  assert.equal(printCalls().length, 1);
  assert.equal(printCalls()[0].pdfBase64, syntheticSlip().toString('base64'));
  assert.equal(printCalls()[0].orderId, ORDER);
  assert.match(printCalls()[0].requestId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(downloads.length, 0);
});

test('malformed capture fields are refused before native printing', async t => {
  const { page } = await orderPage(t, { delivery: 'malformed' });
  await page.click('#tcgprint-button');
  assert.match(await errorText(page), /could not be decoded.*Nothing was printed.*Refresh/);
  assert.equal(printCalls().length, 0);
  await barrier();
  assert.equal(await pending(), undefined, 'a refused malformed capture must not block the next order');
});

test('a malformed heading refuses the click before arming or exporting', async t => {
  const { page } = await orderPage(t);
  await page.evaluate(() => { document.querySelector('[data-testid="txtOrderHeader"]').textContent = 'Order: malformed'; });
  await page.click('#tcgprint-button');
  assert.match(await errorText(page), /heading and page address do not match/);
  assert.equal(await page.evaluate(() => window.exportsStarted), 0);
  assert.equal(harness.calls().length, 0);
});

test('navigation during the initial helper check cancels without exporting', async t => {
  const { page } = await orderPage(t, {}, { pingDelayMs: 300 });
  await page.click('#tcgprint-button');
  await page.evaluate(other => { history.pushState({}, '', '/orders/' + other); }, OTHER_ORDER);
  assert.match(await errorText(page), /order page changed.*correct order/);
  await barrier();
  assert.equal(await pending(), undefined);
  assert.equal(await page.evaluate(() => window.exportsStarted), 0);
  assert.equal(printCalls().length, 0);
});

test('navigation while waiting for Print Default cannot click its late control', async t => {
  const { page } = await orderPage(t, { holdMenu: true });
  await page.click('#tcgprint-button');
  await page.waitForFunction(() => window.armed);
  await page.evaluate(other => {
    history.pushState({}, '', '/orders/' + other);
    document.querySelector('[data-testid="txtOrderHeader"]').textContent = 'Order: ' + other;
    document.querySelector('#menu').hidden = false;
  }, OTHER_ORDER);
  assert.match(await errorText(page), /order page changed/);
  await barrier();
  assert.equal(await pending(), undefined);
  assert.equal(await page.evaluate(() => window.exportsStarted), 0);
  assert.equal(printCalls().length, 0);
});

test('a late PDF after navigation cancellation cannot acquire another order', async t => {
  const { page } = await orderPage(t, { delivery: 'hold' });
  await page.click('#tcgprint-button');
  await page.waitForFunction(() => window.exportsStarted === 1);
  await page.evaluate(other => { history.pushState({}, '', '/orders/' + other); }, OTHER_ORDER);
  assert.match(await errorText(page), /order page changed/);
  await page.evaluate(() => window.emitSlip());
  await barrier();
  assert.equal(printCalls().length, 0);
  assert.equal(await pending(), undefined);
});

test('a slip saved to disk is never a print input and gives a no-print fix', async t => {
  const { page } = await orderPage(t, { delivery: 'disk' });
  const directory = join(root, 'downloads'); mkdirSync(directory);
  const cdp = await context.newCDPSession(page);
  // Playwright's allowAndName replaces the filename with a GUID, unlike a
  // normal browser download. Preserve the site's name in this temporary folder
  // so Chrome's downloads API sees the real production completion event.
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: directory, eventsEnabled: true });
  const downloaded = page.waitForEvent('download');
  await page.click('#tcgprint-button');
  await downloaded;
  assert.match(await errorText(page), /downloaded but was not captured.*nothing printed.*Refresh/);
  assert.ok(statSync(join(directory, 'TCGplayer_PackingSlips_synthetic.pdf')).size > 100);
  assert.equal(printCalls().length, 0);
  assert.equal(await pending(), undefined);
});
