const $ = id => document.getElementById(id);
const STATES = { completed: 'printed', submitted: 'sent to printer', duplicate: 'already printed' };
async function lastResult() {
  try {
    const { lastResult: r } = await chrome.storage.local.get('lastResult');
    if (!r) { $('last').textContent = 'Nothing printed yet.'; return; }
    const when = new Date(r.time).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
    $('last').textContent = `Last: ${r.orderId} — ${r.ok ? STATES[r.state] || r.state : r.error} (${when})`;
  } catch { $('last').textContent = ''; }
}
async function check() {
  const el = $('status'); el.className = ''; el.textContent = 'Checking helper…';
  try {
    const r = await chrome.runtime.sendMessage({ type: 'TCGPRINT_PING' });
    if (r?.ok) el.textContent = `Ready · ${r.printer}`;
    else { el.textContent = r?.error || 'The print helper did not respond.'; el.className = 'bad'; }
  } catch (error) { el.textContent = error.message; el.className = 'bad'; }
  await lastResult();
}
$('check').addEventListener('click', check);
$('setup').addEventListener('click', () => { chrome.tabs.create({ url: chrome.runtime.getURL('setup.html') }); window.close(); });
check();
