import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
export const HOST = 'io.github.llrhook.tcg_order_printer';
export const EXTENSION_ID = 'pidblibebfmenlpcbnajfcdoikdldhgj';
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
export function nativeHarness(root) {
  const home = join(root, 'home');
  const profile = join(root, 'profile');
  const config = join(root, 'native-config.json');
  const launcher = join(root, 'safe-native-host');
  const script = fileURLToPath(new URL('fixtures/native-host.mjs', import.meta.url));
  mkdirSync(home, { recursive: true });
  mkdirSync(profile, { recursive: true });
  writeFileSync(launcher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} ${quote(config)}\n`, { mode: 0o700 });
  const manifest = JSON.stringify({ name: HOST, description: 'Synthetic test host with no printing capability', type: 'stdio', path: launcher, allowed_origins: [`chrome-extension://${EXTENSION_ID}/`] });
  // Every registration belongs to this disposable HOME/profile. Never read an
  // installed manifest or copy a user host into the test browser.
  const directories = [join(profile, 'NativeMessagingHosts')];
  for (const product of ['Chromium', 'Google/Chrome', 'net.imput.helium', 'BraveSoftware/Brave-Browser', 'Microsoft Edge']) {
    directories.push(join(home, 'Library/Application Support', product, 'NativeMessagingHosts'));
  }
  directories.push(join(home, '.config/chromium/NativeMessagingHosts'));
  for (const directory of directories) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${HOST}.json`), manifest);
  }
  const harness = {
    home, profile, launcher,
    configure(value = {}) { writeFileSync(config, JSON.stringify(value)); writeFileSync(config + '.calls', ''); },
    calls() { return existsSync(config + '.calls') ? readFileSync(config + '.calls', 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []; },
  };
  harness.configure();
  return harness;
}
