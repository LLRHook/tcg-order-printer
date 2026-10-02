export const HOST = 'io.github.llrhook.tcg_order_printer';
export const ORDER_RE = /^[A-Z0-9]{8}-[A-Z0-9]{6}-[A-Z0-9]{5}$/;
export const FILE_RE = /^TCGplayer_PackingSlips_[A-Za-z0-9_ -]+(?:\s*\(\d+\))?\.pdf$/i;
export function orderFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.origin !== 'https://sellerportal.tcgplayer.com') return null;
    const match = u.pathname.match(/^\/orders\/([^/]+)\/?$/);
    const id = match && decodeURIComponent(match[1]).toUpperCase();
    return id && ORDER_RE.test(id) ? id : null;
  } catch { return null; }
}
export function officialUrl(value) {
  try {
    const u = new URL(value.startsWith('blob:') ? value.slice(5) : value);
    return u.protocol === 'https:' && (u.hostname === 'tcgplayer.com' || u.hostname.endsWith('.tcgplayer.com'));
  } catch { return false; }
}
export function eligibleDownload(item, pending) {
  const file = (item.filename || '').split(/[\\/]/).pop();
  return pending && pending.phase === 'armed' && Date.now() < pending.expires &&
    item.state === 'complete' && FILE_RE.test(file) && item.exists !== false &&
    Date.parse(item.startTime) >= pending.created - 1000 &&
    (officialUrl(item.url || '') || officialUrl(item.finalUrl || '') || officialUrl(item.referrer || ''));
}
const ERROR_TEXT = {
  HELPER_NOT_INSTALLED: 'The print helper is not installed.',
  EXTENSION_NOT_ALLOWED: 'The print helper has not been set up for this extension.',
  SETUP_REQUIRED: 'Print helper setup is not finished.',
  PRINTER_NOT_CONFIGURED: 'No label printer is configured.',
  RETURN_ADDRESS_NOT_CONFIGURED: 'No return address is configured.',
  PRINTER_QUEUE_UNAVAILABLE: 'The label printer is offline or was removed.',
  HELPER_CRASHED: 'The print helper stopped unexpectedly.',
  LOCAL_PRINT_HELPER_ERROR: 'The print helper hit an error.',
  PDF_ORDER_MISMATCH: 'The packing slip is for a different order.',
  UNSUPPORTED_PACKING_SLIP: 'Could not read the address on this packing slip.',
  INVALID_OR_INCOMPLETE_PDF: 'The packing slip download was incomplete.',
  PREVIOUS_SUBMISSION_NEEDS_QUEUE_CHECK: 'A previous print of this order has not finished. Check the printer queue.',
  PRINTER_JOB_CANCELLED_OR_ABORTED: 'The printer cancelled the job.'
};
const SETUP_ERRORS = new Set(['HELPER_NOT_INSTALLED', 'EXTENSION_NOT_ALLOWED', 'SETUP_REQUIRED', 'PRINTER_NOT_CONFIGURED', 'RETURN_ADDRESS_NOT_CONFIGURED', 'PRINTER_QUEUE_UNAVAILABLE']);
// Chrome reports a missing or unauthorized host as plain-text errors; the
// helper replies with codes. Both become { code, message, setup }.
export function describeError(raw) {
  const text = String(raw || '');
  const code = /native messaging host not found/i.test(text) ? 'HELPER_NOT_INSTALLED'
    : /forbidden/i.test(text) ? 'EXTENSION_NOT_ALLOWED'
    : /exited|disconnected/i.test(text) ? 'HELPER_CRASHED'
    : text;
  return { code, message: ERROR_TEXT[code] || text || 'Printing failed.', setup: SETUP_ERRORS.has(code) };
}
