(() => {
  // Runs only on sellerportal.tcgplayer.com. It observes the native export's
  // ordinary Blob/fetch/XHR response, never recreates the packing slip.
  if (window.__tcgPrintBridgeInstalled) return;
  window.__tcgPrintBridgeInstalled = true;
  const MAX = 16 * 1024 * 1024;
  const ORDER = /^[A-Z0-9]{8}-[A-Z0-9]{6}-[A-Z0-9]{5}$/;
  const FILE = /^TCGplayer_PackingSlips_[A-Za-z0-9_ -]+(?:\s*\(\d+\))?\.pdf$/i;
  let active = null;
  const blobs = new Map();
  const live = () => active && Date.now() < active.expires;
  async function transfer(blob, filename = 'TCGplayer_PackingSlips_native.pdf') {
    const request = active;
    if (!live() || request.sent || request.reading || !(blob instanceof Blob) || blob.size > MAX || blob.size < 5) return;
    request.reading = true;
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-' || active !== request || !live()) return;
      let binary = '';
      for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
      request.sent = true;
      window.postMessage({ type: 'TCGPRINT_PDF_BRIDGE', token: request.token, orderId: request.orderId, filename, pdfBase64: btoa(binary) }, location.origin);
    } finally { request.reading = false; }
  }
  function candidate(blob) {
    return blob instanceof Blob && blob.size <= MAX && blob.size >= 5 && (!blob.type || /pdf|octet-stream/i.test(blob.type));
  }
  function exportAnchor(anchor) {
    if (!live() || !(anchor instanceof HTMLAnchorElement) || !FILE.test(anchor.download || '')) return false;
    const blob = blobs.get(anchor.href);
    if (!candidate(blob)) return false;
    transfer(blob, anchor.download).catch(() => {});
    return true;
  }
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const msg = event.data;
    if (msg?.type === 'TCGPRINT_ARM_BRIDGE' && /^[a-f0-9-]{36}$/i.test(msg.token) && ORDER.test(msg.orderId)) {
      active = { token: msg.token, orderId: msg.orderId, expires: Date.now() + 90000, sent: false, reading: false };
      window.postMessage({ type: 'TCGPRINT_BRIDGE_READY', token: msg.token }, location.origin);
    } else if (msg?.type === 'TCGPRINT_DISARM' && active?.token === msg.token) {
      // Let the site's trailing FileSaver click be suppressed after a successful
      // handoff; no new bytes are emitted once sent is true.
      if (active.sent) active.expires = Date.now() + 10000;
      else active = null;
    }
  });
  const originalCreate = URL.createObjectURL;
  URL.createObjectURL = function (blob) {
    const url = originalCreate.call(this, blob);
    if (candidate(blob) && live()) {
      blobs.set(url, blob);
      if (blobs.size > 8) blobs.delete(blobs.keys().next().value);
      transfer(blob).catch(() => {});
    }
    return url;
  };
  const originalClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (...args) {
    if (exportAnchor(this)) return;
    return originalClick.apply(this, args);
  };
  const originalDispatch = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = function (event) {
    if (event?.type === 'click' && exportAnchor(this)) return true;
    return originalDispatch.call(this, event);
  };
  document.addEventListener('click', event => {
    const anchor = event.target?.closest?.('a');
    if (exportAnchor(anchor)) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    if (live() && /pdf|octet-stream/i.test(response.headers.get('content-type') || '')) {
      response.clone().blob().then(blob => transfer(blob)).catch(() => {});
    }
    return response;
  };
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    if (live()) this.addEventListener('load', () => {
      if (!live()) return;
      if (candidate(this.response)) transfer(this.response).catch(() => {});
      else if (this.response instanceof ArrayBuffer && this.response.byteLength <= MAX) transfer(new Blob([this.response])).catch(() => {});
    }, { once: true });
    return originalSend.apply(this, args);
  };
})();
