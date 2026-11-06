import { HOST, PROTOCOL_VERSION, UUID_RE, ORDER_RE, orderFromUrl, eligibleDownload, describeError, validPdfPayload } from './core.js';

const VERSION = chrome.runtime.getManifest().version;
const SELLER_ORIGIN = 'https://sellerportal.tcgplayer.com';
function urlOrigin(value) { try { return new URL(value).origin; } catch { return null; } }
// Accept order-page messages only from our top-frame content script, on the
// seller portal, for the order the tab is showing right now.
async function trustedOrder(message, sender) {
  if (!message || typeof message !== 'object') return null;
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
  catch (error) { throw new Error(error?.message); }
  if (result?.ok !== true) {
    // Only an actual stable string code establishes a helper refusal. Coercing
    // malformed fields could turn an uncertain submission into retry guidance.
    if (result?.ok === false && typeof result.error === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(result.error)) throw new Error(result.error);
    throw new Error(message.command === 'ping' ? 'INVALID_HELPER_RESPONSE' : 'HELPER_RESPONSE_MISMATCH');
  }
  if (message.command === 'ping') {
    if (result.protocolVersion !== PROTOCOL_VERSION) throw new Error('HELPER_PROTOCOL_UNSUPPORTED');
    if (result.state !== 'ready' || typeof result.printer !== 'string' || !result.printer.trim()) throw new Error('INVALID_HELPER_RESPONSE');
  } else if (message.command === 'print' && (result.orderId !== message.orderId || result.requestId !== message.requestId || !['completed', 'submitted', 'duplicate'].includes(result.state))) {
    // An unexpected acknowledgement is not permission to print again. The
    // helper may already have submitted a job, so ask for a queue check.
    throw new Error('HELPER_RESPONSE_MISMATCH');
  }
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
    if (orderFromUrl(tab.url) !== p.orderId) throw new Error('ORDER_PAGE_CHANGED');
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
    if (!orderId) throw new Error('UNTRUSTED_ORDER_MESSAGE');
    if (message.type === 'TCGPRINT_ARM') {
      if (message.clientVersion !== VERSION) throw new Error('EXTENSION_UPDATED');
      if (typeof message.token !== 'string' || !UUID_RE.test(message.token)) throw new Error('INVALID_PRINT_REQUEST');
      const current = await pending();
      if (current && Date.now() < current.expires) throw new Error('PRINT_REQUEST_IN_PROGRESS');
      await native({ command: 'ping' });
      // The native connection check can outlive an SPA navigation.
      if (await trustedOrder(message, sender) !== orderId) throw new Error('ORDER_PAGE_CHANGED');
      const p = { orderId, tabId: sender.tab.id, token: message.token, created: Date.now(), expires: Date.now() + 90000, phase: 'armed', documentId: sender.documentId || null };
      await chrome.storage.session.set({ pending: p });
      return { ok: true, state: 'armed', extensionVersion: VERSION };
    }
    const p = await pending();
    if (!p || p.token !== message.token || p.tabId !== sender.tab.id || p.orderId !== orderId || (p.documentId && p.documentId !== sender.documentId)) throw new Error('NO_MATCHING_PRINT_REQUEST');
    if (message.type === 'TCGPRINT_CANCEL') {
      if (p.phase === 'armed') await chrome.storage.session.remove('pending');
      return { ok: true };
    }
    if (message.type === 'TCGPRINT_PDF' && p.phase === 'armed' && Date.now() < p.expires) {
      if (!validPdfPayload(message.pdfBase64)) {
        const result = failure(new Error('INVALID_PDF_ENCODING'));
        await status(p, result);
        await chrome.storage.session.remove('pending');
        return result;
      }
      return handoff(p, { pdfBase64: message.pdfBase64 });
    }
    throw new Error('INVALID_MESSAGE');
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
    await status(p, failure(new Error('PACKING_SLIP_NOT_CAPTURED')));
    await chrome.storage.session.remove('pending');
  }).catch(error => console.warn('TCG Order Printer handoff failed:', error.message));
});
