import {existsSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {configuredPath, createPendingConfig, migrateLegacyConfig, rotateSetupKey,
  securePersistentPath, setupKeyPath, writeSetupKey} from './config.js';
import {startHub} from './server.js';

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function port(name, cliName, fallback) {
  const value = option(cliName) ?? process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${name} must be a port from 1 to 65535`);
  }
  return parsed;
}

async function main() {
  const configPath = resolve(option('--config-path') ?? configuredPath());
  if (process.argv.includes('--secure-config')) {
    securePersistentPath(dirname(configPath));
    securePersistentPath(configPath);
    if (existsSync(setupKeyPath(configPath))) securePersistentPath(setupKeyPath(configPath));
    return;
  }
  if (process.argv.includes('--rotate-setup-key')) {
    const keyPath = rotateSetupKey(configPath);
    process.stdout.write(`Kurulum anahtarı yenilendi. Korunmuş dosya: ${keyPath}\n`);
    return;
  }
  if (process.argv.includes('--prepare')) {
    const legacyPath = option('--migrate-from');
    let pending = false;
    if (legacyPath && existsSync(legacyPath)) {
      const config = migrateLegacyConfig(legacyPath, configPath);
      pending = config.state === 'pending';
      if (pending) rotateSetupKey(configPath);
      process.stdout.write(`Eski ayarlar kopyalandı; kaynak dosya korundu. Kalıcı konum: ${configPath}\n`);
    } else {
      const {setupToken} = createPendingConfig(configPath);
      writeSetupKey(configPath, setupToken);
      pending = true;
      process.stdout.write(`İlk kurulum hazır. Kalıcı konum: ${configPath}\n`);
    }
    if (pending) process.stdout.write('Bekleyen kurulum anahtarı aynı klasördeki setup-key.txt dosyasındadır.\n');
    return;
  }
  const hub = await startHub({
    configPath,
    wsHost: option('--ws-host') ?? process.env.PORTALTAKIP_WS_HOST ?? '0.0.0.0',
    wsPort: port('PORTALTAKIP_WS_PORT', '--ws-port', 8787),
    adminPort: port('PORTALTAKIP_ADMIN_PORT', '--admin-port', 8788),
  });
  process.stdout.write(`PortalTakip Hub hazır. WS portu: ${hub.wsPort}; yönetici: http://127.0.0.1:${hub.adminPort}\n`);
  process.stdout.write(`Hub kimliği: ${hub.hubId}. Personel LAN IP adresini ve kurum kodunu ayrı girmelidir.\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
      await hub.close();
      process.exit(0);
    });
  }
}

main().catch((error) => {
  process.stderr.write(`Hub başlatılamadı: ${error.message}\n`);
  process.exitCode = 1;
});
