import { HOST, ORDER_RE, orderFromUrl, eligibleDownload, describeError } from './core.js';

const VERSION = chrome.runtime.getManifest().version;
const SELLER_ORIGIN = 'https://sellerportal.tcgplayer.com';
function urlOrigin(value) { try { return new URL(value).origin; } catch { return null; } }
// Accept order-page messages only from our top-frame content script, on the
// seller portal, for the order the tab is showing right now.
async function trustedOrder(message, sender) {
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id)) return null;
  if (urlOrigin(sender.url) !== SELLER_ORIGIN || (sender.origin !== undefined && sender.origin !== SELLER_ORIGIN)) return null;
  if (typeof message.orderId !== 'string' || !ORDER_RE.test(message.orderId)) return null;
  // SPA navigation may change the live order before the content script can
  // cancel. Cancellation only clears state; the pending token, tab, and
  // document are still checked below before it is allowed.
  if (message.type === 'TCGPRINT_CANCEL') return message.orderId;
  let liveTab = null;
  try { liveTab = await chrome.tabs.get(sender.tab.id); } catch {}
  const liveOrder = orderFromUrl(liveTab?.url || '');
  return liveOrder && liveOrder === message.orderId ? liveOrder : null;
}

let serial = Promise.resolve();
function exclusively(fn) {
  const result = serial.then(fn, fn);
  serial = result.catch(() => {});
  return result;
}
async function native(message) {
  let result;
  try { result = await chrome.runtime.sendNativeMessage(HOST, message); }
  catch (error) { throw new Error(error.message); }
  if (!result || !result.ok) throw new Error(result?.error || 'HELPER_CRASHED');
  return result;
}
function failure(error) {
  const { code, message, setup } = describeError(error.message);
  return { ok: false, state: 'error', code, error: message, setup };
}
function openSetup() { return chrome.tabs.create({ url: chrome.runtime.getURL('setup.html') }); }
async function pending() { return (await chrome.storage.session.get('pending')).pending; }
async function status(p, result) {
  await chrome.storage.local.set({ lastResult: { ...result, orderId: p.orderId, time: Date.now() } });
  try { await chrome.tabs.sendMessage(p.tabId, { type: 'TCGPRINT_STATUS', token: p.token, ...result }); } catch {}
}
async function handoff(p, payload) {
  p.phase = 'processing';
  await chrome.storage.session.set({ pending: p });
  let result;
  try {
    const tab = await chrome.tabs.get(p.tabId);
    if (orderFromUrl(tab.url) !== p.orderId) throw new Error('PDF_ORDER_MISMATCH');
    result = await native({ command: 'print', orderId: p.orderId, requestId: p.token, ...payload });
  } catch (error) { result = failure(error); }
  await status(p, result);
  await chrome.storage.session.remove('pending');
  return result;
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === chrome.runtime.OnInstalledReason.INSTALL) openSetup();
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  exclusively(async () => {
    // The popup has no tab; the setup page runs in one. Both are our own pages.
    const fromExtensionPage = sender.id === chrome.runtime.id && (sender.url || '').startsWith(chrome.runtime.getURL(''));
    if (message?.type === 'TCGPRINT_PING' && fromExtensionPage) return { ...await native({ command: 'ping' }), extensionVersion: VERSION };
    if (message?.type === 'TCGPRINT_OPEN_SETUP' && sender.id === chrome.runtime.id) { await openSetup(); return { ok: true }; }
    const orderId = await trustedOrder(message, sender);
    if (!orderId) throw new Error('Untrusted order-page message.');
    if (message.type === 'TCGPRINT_ARM') {
      if (message.clientVersion !== VERSION) throw new Error('The extension was updated. Refresh this page.');
      if (typeof message.token !== 'string' || !/^[a-f0-9-]{36}$/i.test(message.token)) throw new Error('Invalid print request token.');
      const current = await pending();
      if (current && Date.now() < current.expires) throw new Error('A print request is already in progress.');
      await native({ command: 'ping' });
      const p = { orderId, tabId: sender.tab.id, token: message.token, created: Date.now(), expires: Date.now() + 90000, phase: 'armed', documentId: sender.documentId || null };
      await chrome.storage.session.set({ pending: p });
      return { ok: true, state: 'armed', extensionVersion: VERSION };
    }
    const p = await pending();
    if (!p || p.token !== message.token || p.tabId !== sender.tab.id || p.orderId !== orderId || (p.documentId && p.documentId !== sender.documentId)) throw new Error('No matching print request.');
    if (message.type === 'TCGPRINT_CANCEL') {
      if (p.phase === 'armed') await chrome.storage.session.remove('pending');
      return { ok: true };
    }
    if (message.type === 'TCGPRINT_PDF' && p.phase === 'armed' && Date.now() < p.expires) {
      if (typeof message.pdfBase64 !== 'string' || message.pdfBase64.length > 24 * 1024 * 1024) throw new Error('PDF exceeds transfer limit.');
      return handoff(p, { pdfBase64: message.pdfBase64 });
    }
    throw new Error('Unsupported extension message.');
  }).then(reply, error => reply(failure(error)));
  return true;
});
chrome.downloads.onChanged.addListener(delta => {
  if (delta.state?.current !== 'complete') return;
  exclusively(async () => {
    const p = await pending();
    const [item] = await chrome.downloads.search({ id: delta.id });
    if (!item || !eligibleDownload(item, p)) return;
    // The one-click contract requires captured bytes, without Save As or a
    // filesystem permission prompt. A completed download alone is not enough.
    await status(p, { ok: false, state: 'error', error: 'The packing slip downloaded but was not captured, so nothing printed. Refresh the order page and try again.' });
    await chrome.storage.session.remove('pending');
  }).catch(error => console.warn('TCG Order Printer handoff failed:', error.message));
});
