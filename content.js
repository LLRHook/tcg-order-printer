(() => {
  const VERSION = chrome.runtime.getManifest().version;
  const PACKING = '[data-testid="OrderDetails_CustomerDetails_btnPackingSlip"]';
  const DEFAULT = '[data-testid="OrderDetails_PackingSlipList_btnDownloadDefaultByRelease"]';
  const HEADER = '[data-testid="txtOrderHeader"]';
  const IDLE_LABEL = 'Print the official packing slip and matching address label';
  let active = null;
  let resultSequence = 0;
  function orderId() {
    const path = location.pathname.match(/^\/orders\/([^/]+)\/?$/);
    const heading = document.querySelector(HEADER)?.textContent.trim().match(/^Order:\s*([A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+)/i);
    const id = path && decodeURIComponent(path[1]).toUpperCase();
    if (!id || !/^[A-Z0-9]{8}-[A-Z0-9]{6}-[A-Z0-9]{5}$/.test(id) || heading?.[1].toUpperCase() !== id) throw new Error('The order heading and page address do not match.');
    return id;
  }
  function resetButton(button) {
    button.textContent = 'Print both'; button.title = IDLE_LABEL; button.setAttribute('aria-label', IDLE_LABEL);
  }
  // Errors show a short status; setup problems become a link to the setup page.
  function showError(message, setup = false) {
    const el = document.getElementById('tcgprint-status');
    if (el) {
      el.replaceChildren();
      if (setup) {
        const link = document.createElement('button'); link.type = 'button'; link.className = 'tcgprint-setup';
        link.textContent = 'Finish setup';
        link.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'TCGPRINT_OPEN_SETUP' }).catch(() => {}));
        el.append(link);
      }
      const detail = document.createElement('span'); detail.textContent = message; el.append(detail);
      el.title = message; el.classList.add('tcgprint-error');
    }
    const button = document.getElementById('tcgprint-button');
    if (button) { resetButton(button); button.title = message; }
  }
  function showProgress(text) {
    const el = document.getElementById('tcgprint-status');
    if (el) { el.replaceChildren(); el.title = ''; el.classList.remove('tcgprint-error'); }
    const button = document.getElementById('tcgprint-button');
    if (button && active) { button.textContent = 'Printing…'; button.title = text; }
  }
  async function waitFor(selector, request, timeout = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      ensureCurrent(request);
      const found = [...document.querySelectorAll(selector)].filter(el => el.getClientRects().length && !el.disabled);
      if (found.length === 1) return found[0];
      if (found.length > 1) throw new Error('The Print Default control is ambiguous.');
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    throw new Error('The Print Default control was not found.');
  }
  function ensureCurrent(request) {
    if (active !== request) throw new Error('The print request was cancelled.');
    let current;
    try { current = orderId(); } catch {}
    if (current !== request.orderId) throw new Error('The order page changed. Open the correct order and click Print both again.');
  }
  function cancel(request, message) {
    if (active !== request) return;
    chrome.runtime.sendMessage({ type: 'TCGPRINT_CANCEL', orderId: request.orderId, token: request.token }).catch(() => {});
    finish({ ok: false, error: request.phase === 'handoff'
      ? 'The helper has not confirmed this request. Check the printer queue before trying again.' : message }, request);
  }
  function checkPage() {
    if (!active) return;
    const request = active;
    try { ensureCurrent(request); }
    catch { cancel(request, 'The order page changed. Open the correct order and click Print both again.'); }
  }
  function finish(result, request = active) {
    if (!request || active !== request) return;
    window.postMessage({ type: 'TCGPRINT_DISARM', token: request.token }, location.origin);
    clearTimeout(request.timeout); clearInterval(request.pageCheck);
    active = null;
    request.cancelReady?.();
    const sequence = ++resultSequence;
    const button = document.getElementById('tcgprint-button');
    if (button) { button.disabled = false; button.setAttribute('aria-busy', 'false'); }
    if (!result?.ok) { showError(result?.error || 'Printing failed. Check the printer queue before retrying.', result?.setup); return; }
    if (button) {
      button.textContent = result.state === 'duplicate' ? 'Already sent' : result.state === 'submitted' ? 'Sent ✓' : 'Printed ✓';
      button.setAttribute('aria-label', result.state === 'completed' ? 'Packing slip and address label printed' : 'Packing slip and address label submitted');
      button.title = result.state === 'duplicate' ? 'This request was already handled. Check the printer queue; no duplicate was submitted.' : result.state === 'completed' ? 'Packing slip and address label printed.' : 'Both pages sent to the printer.';
    }
    showProgress('');
    setTimeout(() => { if (button && !active && resultSequence === sequence) resetButton(button); }, 5000);
  }
  function readyBridge(request) {
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); window.removeEventListener('message', ready); request.cancelReady = null; };
      const timer = setTimeout(() => { cleanup(); reject(new Error('The PDF capture bridge did not start. Refresh this page.')); }, 2000);
      function ready(event) {
        if (event.source === window && event.origin === location.origin && event.data?.type === 'TCGPRINT_BRIDGE_READY' && event.data.token === request.token) {
          cleanup(); resolve();
        }
      }
      request.cancelReady = () => { cleanup(); reject(new Error('The print request was cancelled.')); };
      window.addEventListener('message', ready);
      window.postMessage({ type: 'TCGPRINT_ARM_BRIDGE', token: request.token, orderId: request.orderId }, location.origin);
    });
  }
  async function printPair(button) {
    // A disabled button still receives synthetic dispatchEvent clicks. Own the
    // request before the first await so a second handler cannot start an export.
    if (active || button.disabled) return;
    button.disabled = true; button.setAttribute('aria-busy', 'true'); button.setAttribute('aria-label', 'Printing packing slip and address label');
    let request;
    try {
      const id = orderId(); const token = crypto.randomUUID();
      request = { orderId: id, token, phase: 'arming' }; active = request;
      request.pageCheck = setInterval(checkPage, 100);
      request.timeout = setTimeout(() => cancel(request, 'No packing slip arrived from TCGplayer. Refresh the order page and try again.'), 95000);
      const response = await chrome.runtime.sendMessage({ type: 'TCGPRINT_ARM', orderId: id, token, clientVersion: VERSION });
      ensureCurrent(request);
      if (!response?.ok) { const error = new Error(response?.error || 'The print helper is unavailable. Open Setup and check the connection.'); error.setup = response?.setup; throw error; }
      if (response.extensionVersion !== VERSION) throw new Error('The extension was updated. Refresh this page.');
      request.phase = 'capturing';
      await readyBridge(request);
      ensureCurrent(request);
      showProgress('Getting the official packing slip…');
      if (!document.querySelector(DEFAULT)?.getClientRects().length) {
        const controls = document.querySelectorAll(PACKING);
        if (controls.length !== 1) throw new Error('The Packing Slip control is missing or ambiguous. Refresh the order page.');
        controls[0].click();
      }
      const nativeDefault = await waitFor(DEFAULT, request);
      ensureCurrent(request);
      nativeDefault.click();
      showProgress('Printing packing slip + address label…');
    } catch (error) {
      if (request && active === request) {
        chrome.runtime.sendMessage({ type: 'TCGPRINT_CANCEL', orderId: request.orderId, token: request.token }).catch(() => {});
        finish({ ok: false, error: error.message, setup: error.setup }, request);
      } else if (!request) {
        button.disabled = false; button.setAttribute('aria-busy', 'false'); showError(error.message, error.setup);
      }
    }
  }
  window.addEventListener('message', async event => {
    if (event.source !== window || event.origin !== location.origin || !active || event.data?.type !== 'TCGPRINT_PDF_BRIDGE' || event.data.token !== active.token || event.data.orderId !== active.orderId) return;
    const request = active;
    if (request.phase !== 'capturing') return;
    try {
      ensureCurrent(request);
      request.phase = 'handoff';
      const response = await chrome.runtime.sendMessage({ type: 'TCGPRINT_PDF', orderId: request.orderId, token: request.token, pdfBase64: event.data.pdfBase64 });
      if (active?.token === request.token) finish(response, request);
    } catch (error) {
      if (active === request) {
        chrome.runtime.sendMessage({ type: 'TCGPRINT_CANCEL', orderId: request.orderId, token: request.token }).catch(() => {});
        finish({ ok: false, error: error.message }, request);
      }
    }
  });
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.type === 'TCGPRINT_STATUS' && sender.id === chrome.runtime.id && active?.token === message.token) finish(message);
  });
  function mount() {
    checkPage();
    const controls = document.querySelectorAll(PACKING);
    const existing = document.getElementById('tcgprint-controls');
    if (controls.length !== 1) { if (existing) existing.remove(); return; }
    if (existing) return;
    try { orderId(); } catch { return; }
    const wrap = document.createElement('span'); wrap.id = 'tcgprint-controls';
    const button = document.createElement('button'); button.id = 'tcgprint-button'; button.type = 'button'; resetButton(button);
    button.addEventListener('click', () => printPair(button));
    const status = document.createElement('span'); status.id = 'tcgprint-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    wrap.append(button, status);
    const nativePopover = controls[0].closest('.tcg-popover');
    if (nativePopover?.parentElement?.classList.contains('customer-details__actions')) {
      // Add only our node beside the existing trigger; leave every React-owned
      // native element in its original parent to keep reconciliation intact.
      nativePopover.classList.add('tcgprint-group');
      nativePopover.append(wrap);
    }
  }
  new MutationObserver(mount).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('popstate', checkPage);
  mount();
})();
