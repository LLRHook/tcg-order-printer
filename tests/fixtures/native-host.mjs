// Safe test host: native-messaging framing and synthetic responses only.
// There is no CUPS, child-process, network, installed-host or printer access.
import { appendFileSync, readFileSync } from 'node:fs';
const configPath = process.argv[2];
if (!configPath) process.exit(2);
let input = Buffer.alloc(0);
process.stdin.on('data', chunk => {
  input = Buffer.concat([input, chunk]);
  if (input.length < 4) return;
  const length = input.readUInt32LE(0);
  if (length > 24 * 1024 * 1024) process.exit(2);
  if (input.length < length + 4) return;
  process.stdin.pause();
  respond(input.subarray(4, length + 4)).catch(() => process.exit(2));
});
async function respond(bytes) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const message = JSON.parse(bytes.toString('utf8'));
  appendFileSync(configPath + '.calls', JSON.stringify(message) + '\n');
  const delay = message.command === 'ping' ? config.pingDelayMs : config.printDelayMs;
  if (delay) await new Promise(resolve => setTimeout(resolve, delay));
  let result;
  if (message.command === 'ping') {
    result = config.pingError ? { ok: false, error: config.pingError }
      : { ok: true, state: 'ready', protocolVersion: config.protocolVersion ?? 2, printer: 'Synthetic_Test_Queue' };
  } else if (message.command === 'print') {
    // The fixture marker is only a harness rule, not PDF-parser verification.
    const pdf = typeof message.pdfBase64 === 'string' ? Buffer.from(message.pdfBase64, 'base64').toString('utf8') : '';
    const code = config.printError || (!pdf.includes(`Order Number: ${message.orderId}`) ? 'PDF_ORDER_MISMATCH' : null);
    result = code ? { ok: false, error: code }
      : { ok: true, state: 'submitted', orderId: message.orderId, requestId: message.requestId, job: 'synthetic-1', ...config.printReply };
  } else result = { ok: false, error: 'INVALID_MESSAGE' };
  const payload = Buffer.from(JSON.stringify(result));
  const header = Buffer.alloc(4); header.writeUInt32LE(payload.length);
  process.stdout.write(Buffer.concat([header, payload]), () => process.exit(0));
}
