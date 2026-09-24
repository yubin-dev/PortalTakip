import {configuredPath, rotateSetupKey} from '../src/hub/config.js';

try {
  const keyPath = rotateSetupKey(configuredPath());
  process.stdout.write(`Bekleyen ilk kurulum anahtarı yenilendi. Yeni anahtar yalnızca ${keyPath} dosyasındadır.\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
