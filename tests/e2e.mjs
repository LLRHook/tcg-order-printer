import { chromium } from 'playwright';
import fs from 'fs';
import os from 'os';
// End-to-end check against the INSTALLED helper: loads the extension, checks the
// setup page and popup, then clicks Print both on a stubbed order page whose
// slip is for a different order, so the helper refuses it and nothing prints.
import { fileURLToPath } from 'url';
const EXT = fileURLToPath(new URL('..', import.meta.url));
const ORDER = 'ABCD1234-EF5678-9ABCD';
const slip = fs.readFileSync(new URL('fixtures/other-order-slip.pdf', import.meta.url)).toString('base64');
const SUPPORT = process.env.HOME + '/Library/Application Support/';
const HOST = 'io.github.llrhook.tcg_order_printer.json';
const hostManifest = ['Chromium', 'Google/Chrome', 'net.imput.helium', 'BraveSoftware/Brave-Browser', 'Microsoft Edge']
  .map(dir => `${SUPPORT}${dir}/NativeMessagingHosts/${HOST}`).find(fs.existsSync);
if (!hostManifest) { console.error('Install the helper first (./install.sh).'); process.exit(1); }
const results = [];
function check(name, ok, detail) { results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); }
const page_html = `<!doctype html><html><body>
<h2 data-testid="txtOrderHeader">Order: ${ORDER}</h2>
<div class="customer-details__actions"><div class="tcg-popover"><button class="tcg-popover__trigger" data-testid="OrderDetails_CustomerDetails_btnPackingSlip" onclick="document.getElementById('menu').hidden=false">Packing Slip</button></div></div>
<div id="menu" hidden><button data-testid="OrderDetails_PackingSlipList_btnDownloadDefaultByRelease" id="dl">Print Default</button></div>
<script>
document.getElementById('dl').onclick = () => {
  const bytes = Uint8Array.from(atob('${slip}'), c => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = document.createElement('a'); a.href = url; a.download = 'TCGplayer_PackingSlips_20261002_000000.pdf'; a.click();
};
</script></body></html>`;
const profile = fs.mkdtempSync(os.tmpdir() + '/tcgp-');
// A custom --user-data-dir is where Chromium looks for user-level native hosts.
fs.mkdirSync(profile + '/NativeMessagingHosts');
fs.copyFileSync(hostManifest, `${profile}/NativeMessagingHosts/${HOST}`);
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const id = sw.url().split('/')[2];
check('dev extension id', id === 'pidblibebfmenlpcbnajfcdoikdldhgj', id);
// onInstalled should have opened the setup page
await new Promise(r => setTimeout(r, 1500));
const setup = ctx.pages().find(p => p.url().includes('/setup.html')) || await ctx.newPage();
check('setup page opens on install', setup.url().includes('setup.html'));
if (!setup.url().includes('setup.html')) await setup.goto(`chrome-extension://${id}/setup.html`);
await setup.waitForFunction(() => !document.getElementById('status-title').textContent.startsWith('Checking'), null, { timeout: 15000 });
check('setup page reports ready', await setup.textContent('#status-title') === 'Ready to print', await setup.textContent('#status-detail'));
check('setup page shows extension id', await setup.textContent('#extension-id') === id);
const popup = await ctx.newPage(); await popup.goto(`chrome-extension://${id}/popup.html`);
await popup.waitForFunction(() => !document.getElementById('status').textContent.startsWith('Checking'));
check('popup reports ready', (await popup.textContent('#status')).startsWith('Ready'), await popup.textContent('#status'));
// content script on a stubbed order page
await ctx.route('https://sellerportal.tcgplayer.com/**', route => route.fulfill({ contentType: 'text/html', body: page_html }));
const page = await ctx.newPage();
await page.goto(`https://sellerportal.tcgplayer.com/orders/${ORDER}`);
await page.waitForSelector('#tcgprint-button', { timeout: 10000 });
check('Print both button mounted', await page.textContent('#tcgprint-button') === 'Print both');
await page.click('#tcgprint-button');
await page.waitForFunction(() => document.getElementById('tcgprint-status')?.title, null, { timeout: 30000 });
const title = await page.getAttribute('#tcgprint-status', 'title');
check('captured slip reached the helper and was refused', title === 'The packing slip is for a different order.', title);
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
process.exit(results.every(Boolean) ? 0 : 1);
