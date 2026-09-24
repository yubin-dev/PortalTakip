import {existsSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {configuredPath, createPendingConfig, defaultConfigPath, migrateLegacyConfig,
  rotateSetupKey, writeSetupKey} from '../src/hub/config.js';

const path = configuredPath();
const legacyPath = resolve(dirname(fileURLToPath(import.meta.url)), '../data/hub.json');
try {
  let pending = false;
  if (existsSync(path)) throw Object.assign(new Error('Hub ayarları zaten var.'), {code: 'EEXIST'});
  if (path === defaultConfigPath && existsSync(legacyPath)) {
    const config = migrateLegacyConfig(legacyPath, path);
    pending = config.state === 'pending';
    if (pending) rotateSetupKey(path);
    process.stdout.write(`Eski ayarlar kopyalandı; kaynak dosya korundu. Kalıcı konum: ${path}\n`);
  } else {
    const {setupToken} = createPendingConfig(path);
    writeSetupKey(path, setupToken);
    pending = true;
    process.stdout.write(`İlk kurulum hazır. Kalıcı konum: ${path}\n`);
  }
  if (pending) process.stdout.write('Kurulum anahtarı aynı klasördeki korunmuş setup-key.txt dosyasındadır.\n');
} catch (error) {
  if (error?.code === 'EEXIST') {
    process.stderr.write('Hub ayarları zaten var; mevcut sırlar değiştirilmedi. Bekleyen kurulum anahtarını yenilemek için hub:rotate-setup-key kullanın.\n');
  } else {
    process.stderr.write(`${error.message}\n`);
  }
  process.exitCode = 1;
}
