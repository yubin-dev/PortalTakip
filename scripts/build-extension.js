import {copyFileSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {deflateSync} from 'node:zlib';

const files = [
  ['src/extension/manifest.json', 'manifest.json'],
  ['src/ui/popup.html', 'ui/popup.html'],
  ['src/ui/popup.css', 'ui/popup.css'],
  ['src/ui/popup.js', 'ui/popup.js'],
  ['src/ui/connection-input.js', 'ui/connection-input.js'],
  ['src/background/client.js', 'background/client.js'],
  ['src/background/portal-state.js', 'background/portal-state.js'],
  ['src/content/capsule.js', 'content/capsule.js'],
];
const target = resolve('dist/extension');
// Remove the obsolete entry point from older builds; current builds use client.js.
rmSync(resolve(target, 'background/worker.js'), {force: true});
for (const [source, destination] of files) {
  const output = resolve(target, destination);
  mkdirSync(resolve(output, '..'), {recursive: true});
  copyFileSync(resolve(source), output);
}
// Small deterministic PNG used by the manifest and Chrome notifications.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^
      (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, checksum]);
}
const size = 128;
const rows = [];
for (let y = 0; y < size; y++) {
  const row = Buffer.alloc(1 + size * 4);
  for (let x = 0; x < size; x++) {
    const vertical = x >= 42 && x < 55 && y >= 30 && y < 99;
    const bowl = x >= 42 && x < 91 && y >= 30 && y < 68 &&
      !(x >= 55 && x < 78 && y >= 43 && y < 57);
    const accent = vertical || bowl;
    const offset = 1 + x * 4;
    row[offset] = accent ? 123 : 20;
    row[offset + 1] = accent ? 224 : 36;
    row[offset + 2] = accent ? 196 : 45;
    row[offset + 3] = 255;
  }
  rows.push(row);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0);
header.writeUInt32BE(size, 4);
header[8] = 8;
header[9] = 6;
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),
  chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))),
  chunk('IEND', Buffer.alloc(0))]);
const icon = resolve(target, 'icons/icon128.png');
mkdirSync(resolve(icon, '..'), {recursive: true});
writeFileSync(icon, png);
process.stdout.write(`Manifest V3 eklentisi hazır: ${target}\n`);
