import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

if (process.platform !== 'win32') throw new Error('Windows EXE must be built on Windows');
const [major] = process.versions.node.split('.').map(Number);
if (major < 26) throw new Error('Node.js 26+ is required for built-in --build-sea');

const dist = resolve('dist');
mkdirSync(dist, {recursive: true});
const main = resolve(dist, 'sea-main.cjs');
const output = resolve(process.env.PORTALTAKIP_EXE_OUTPUT ?? resolve(dist, 'PortalTakip Hub.exe'));
const configuration = resolve(dist, 'sea-config.json');

await build({entryPoints: [resolve('src/hub/index.js')], outfile: main,
  bundle: true, platform: 'node', format: 'cjs', target: 'node26',
  packages: 'bundle', logLevel: 'info'});
writeFileSync(configuration, JSON.stringify({
  main, mainFormat: 'commonjs', output,
  disableExperimentalSEAWarning: true,
  useSnapshot: false, useCodeCache: false,
  assets: {
    'admin/index.html': resolve('src/hub/admin/index.html'),
    'admin/app.js': resolve('src/hub/admin/app.js'),
    'admin/style.css': resolve('src/hub/admin/style.css'),
  },
}, null, 2));
execFileSync(process.execPath, ['--build-sea', configuration], {stdio: 'inherit'});
process.stdout.write(`EXE üretildi: ${output}\n`);
