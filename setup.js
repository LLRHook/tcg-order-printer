const $ = id => document.getElementById(id);
$('extension-id').textContent = chrome.runtime.id;
$('version').textContent = 'v' + chrome.runtime.getManifest().version;
function render(kind, title, detail) {
  $('status-dot').className = 'dot ' + kind;
  $('status-title').textContent = title;
  $('status-detail').textContent = detail;
}
async function check() {
  render('', 'Checking the print helper…', '');
  try {
    const r = await chrome.runtime.sendMessage({ type: 'TCGPRINT_PING' });
    if (r?.ok) render('ok', 'Ready to print', `Labels go to ${r.printer}. Open an order in the Seller Portal and click Print both.`);
    else render('bad', r?.error || 'The print helper did not respond.', r?.setup ? 'Follow the steps below, then check again.' : 'Re-run ./install.sh, then check again.');
  } catch (error) { render('bad', 'The print helper did not respond.', error.message); }
}
$('check').addEventListener('click', check);
document.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($(button.dataset.copy).textContent);
    const label = button.textContent; button.textContent = 'Copied'; setTimeout(() => { button.textContent = label; }, 1500);
  } catch {}
}));
check();
