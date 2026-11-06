export const HOST = 'io.github.llrhook.tcg_order_printer';
export const PROTOCOL_VERSION = 2;
export const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
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
  HELPER_NOT_INSTALLED: 'The print helper is not installed. Run ./install.sh in the helper folder, restart the browser, then check the connection.',
  EXTENSION_NOT_ALLOWED: 'The print helper has not been set up for this extension. Re-run the helper wizard with the ID on the Setup page, then restart the browser.',
  SETUP_REQUIRED: 'Print helper setup is not finished. Re-run the helper wizard, then check the connection.',
  PRINTER_NOT_CONFIGURED: 'No label printer is configured. Select one in the helper wizard, then check the connection.',
  RETURN_ADDRESS_NOT_CONFIGURED: 'No return address is configured. Enter one in the helper wizard, then check the connection.',
  PRINTER_QUEUE_UNAVAILABLE: 'The label printer is unavailable. Reconnect it or select an available printer in the helper wizard, then check the connection.',
  HELPER_CRASHED: 'The print helper stopped unexpectedly. Check the printer queue before retrying; re-run ./install.sh if the helper keeps stopping.',
  LOCAL_PRINT_HELPER_ERROR: 'The print helper hit an error. Check the printer queue before retrying, then check the helper connection.',
  PDF_ORDER_MISMATCH: 'The packing slip is for a different order. Nothing was printed. Refresh the correct order page and try again.',
  UNSUPPORTED_PACKING_SLIP: 'Could not read the address on this packing slip. Nothing was printed. Use the official Print Default slip and check for helper updates.',
  INVALID_OR_INCOMPLETE_PDF: 'The packing slip download was incomplete. Nothing was printed. Refresh the order page and try again.',
  INVALID_MESSAGE: 'The helper could not read the request. Refresh the order page and check for extension and helper updates.',
  INVALID_ORDER_REQUEST: 'The order number is invalid. Nothing was printed. Open the order details page and refresh it.',
  INVALID_PRINT_REQUEST: 'The print request is invalid. Nothing was printed. Refresh the order page and try again.',
  PDF_BYTES_REQUIRED: 'No packing slip was captured. Nothing was printed. Refresh the order page and try again.',
  INVALID_PDF_ENCODING: 'The captured packing slip could not be decoded. Nothing was printed. Refresh the order page and try again.',
  REQUEST_ID_ORDER_MISMATCH: 'This request belongs to a different order. Nothing was printed. Refresh the correct order page and try again.',
  REQUEST_ID_PDF_MISMATCH: 'The packing slip changed for a previous request. Stop retrying. Verify the order and slip and check the printer queue before starting a new request.',
  PREVIOUS_SUBMISSION_NEEDS_QUEUE_CHECK: 'A previous print of this order needs checking. Check the printer queue before trying again.',
  PRINTER_JOB_CANCELLED_OR_ABORTED: 'The printer cancelled the job. Check the printer and queue before trying again.',
  HELPER_PROTOCOL_UNSUPPORTED: 'The print helper needs updating. Install the current helper with ./install.sh, restart the browser, then check the connection.',
  INVALID_HELPER_RESPONSE: 'The helper returned an incomplete connection check. Re-run the helper wizard and check for helper updates.',
  HELPER_RESPONSE_MISMATCH: 'The helper did not confirm this order and request. Check the printer queue before trying again; the job may already have been submitted.',
  ORDER_PAGE_CHANGED: 'The order page changed. Open the correct order and click Print both again.',
  PRINT_REQUEST_IN_PROGRESS: 'A print request is already in progress. Wait for its result and check the printer queue before retrying.',
  NO_MATCHING_PRINT_REQUEST: 'This print request expired or was cancelled. Refresh the order page and try again.',
  EXTENSION_UPDATED: 'The extension was updated. Refresh the order page and try again.',
  UNTRUSTED_ORDER_MESSAGE: 'The order page could not be verified. Open the order details page and refresh it.',
  PACKING_SLIP_NOT_CAPTURED: 'The packing slip downloaded but was not captured, so nothing printed. Refresh the order page and try again.'
};
const SETUP_ERRORS = new Set(['HELPER_NOT_INSTALLED', 'EXTENSION_NOT_ALLOWED', 'SETUP_REQUIRED', 'PRINTER_NOT_CONFIGURED', 'RETURN_ADDRESS_NOT_CONFIGURED', 'PRINTER_QUEUE_UNAVAILABLE', 'HELPER_PROTOCOL_UNSUPPORTED', 'INVALID_HELPER_RESPONSE']);
// Native diagnostics can include local paths or address data. Preserve stable
// codes, but never expose arbitrary helper or Chrome diagnostic text.
export function describeError(raw) {
  const text = typeof raw === 'string' ? raw : '';
  const code = /native messaging host not found/i.test(text) ? 'HELPER_NOT_INSTALLED'
    : /access to .*native messaging host.*forbidden/i.test(text) ? 'EXTENSION_NOT_ALLOWED'
    : /native (?:host|messaging).*exited|native (?:host|messaging).*disconnected/i.test(text) ? 'HELPER_CRASHED'
    : /^[A-Z][A-Z0-9_]{1,79}$/.test(text) ? text : 'LOCAL_PRINT_HELPER_ERROR';
  return { code, message: ERROR_TEXT[code] || ERROR_TEXT.LOCAL_PRINT_HELPER_ERROR, setup: SETUP_ERRORS.has(code) };
}
export function validPdfPayload(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 24 * 1024 * 1024 || value.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try { return atob(value.slice(0, 8)).startsWith('%PDF-'); } catch { return false; }
}
