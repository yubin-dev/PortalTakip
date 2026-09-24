import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {once} from 'node:events';
import WebSocket from 'ws';
import {createPendingConfig, digest} from '../src/hub/config.js';

const exe = resolve(process.env.PORTALTAKIP_EXE_PATH ?? 'dist/PortalTakip Hub.exe');
const directory = mkdtempSync(join(tmpdir(), 'portaltakip-exe-smoke-'));
const configPath = join(directory, 'hub.json');
const otherDirectory = join(directory, 'different-working-directory');
mkdirSync(otherDirectory);
let child;

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

function start(wsPort, adminPort) {
  const processHandle = spawn(exe, ['--config-path', configPath,
    '--ws-port', String(wsPort), '--admin-port', String(adminPort),
    '--ws-host', '127.0.0.1'], {
    cwd: otherDirectory, env: {...process.env, PORTALTAKIP_CONFIG: ''},
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  processHandle.stdout.on('data', (chunk) => { output += chunk; });
  processHandle.stderr.on('data', (chunk) => { output += chunk; });
  processHandle.getOutput = () => output;
  return processHandle;
}

async function waitFor(url) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`EXE exited: ${child.getOutput()}`);
    try { return await fetch(url); } catch { /* wait for listener */ }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`EXE did not listen: ${child.getOutput()}`);
}

async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await exited;
}

async function post(base, path, body, cookie, csrf) {
  const response = await fetch(`${base}${path}`, {method: 'POST',
    headers: {'Content-Type': 'application/json', Origin: base,
      ...(cookie ? {Cookie: cookie} : {}), ...(csrf ? {'X-CSRF-Token': csrf} : {})},
    body: JSON.stringify(body)});
  return {response, data: await response.json()};
}

async function wsMessage(ws, predicate) {
  for await (const [buffer] of onceMessages(ws)) {
    const value = JSON.parse(buffer.toString());
    if (predicate(value)) return value;
  }
  throw new Error('WebSocket closed before expected message');
}

async function* onceMessages(ws) {
  while (ws.readyState === WebSocket.OPEN) yield await once(ws, 'message');
}

try {
  const setup = execFileSync('cmd.exe', ['/d', '/s', '/c', 'npm.cmd run hub:init'], {
    cwd: resolve('.'), env: {...process.env, PORTALTAKIP_CONFIG: configPath}, encoding: 'utf8'});
  const setupToken = readFileSync(join(directory, 'setup-key.txt'), 'utf8').trim();
  assert.match(setupToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(setup.includes(setupToken), false, 'setup key must not be logged');
  assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).state, 'pending');
  const wsPort = await freePort();
  const adminPort = await freePort();
  assert.notEqual(wsPort, adminPort);
  const base = `http://127.0.0.1:${adminPort}`;
  child = start(wsPort, adminPort);
  const session = await waitFor(`${base}/api/session`);
  assert.equal((await session.json()).setupRequired, true);
  const panel = await fetch(`${base}/`);
  assert.equal(panel.status, 200);
  assert.match(await panel.text(), /id="connectedCount"/);
  assert.match(await (await fetch(`${base}/style.css`)).text(), /workspace-grid/);
  assert.match(await (await fetch(`${base}/app.js`)).text(), /setupForm/);
  const password = `Test-${randomUUID()}-Admin`;
  const completed = await post(base, '/api/setup', {setupToken,
    organizationName: 'Temiz Kurulum', password});
  assert.equal(completed.response.status, 201);
  const code = completed.data.organizationCode;
  const cookie = completed.response.headers.get('set-cookie').split(';')[0];
  const csrf = completed.data.csrfToken;
  const stored = readFileSync(configPath, 'utf8');
  assert.equal(existsSync(join(directory, 'setup-key.txt')), false,
    'setup key file should be removed after setup');
  assert.match(stored, /"state": "ready"/);
  for (const secret of [setupToken, password, code]) assert.equal(stored.includes(secret), false);
  assert.match(stored, /scrypt\$/);
  const staff = await post(base, '/api/staff', {displayName: 'Temiz Personel'}, cookie, csrf);
  assert.equal(staff.response.status, 201);
  const account = await post(base, '/api/account-code', {}, cookie, csrf);
  const ws = new WebSocket(`ws://127.0.0.1:${wsPort}/ws`);
  await once(ws, 'open');
  ws.send(JSON.stringify({type: 'HELLO', organizationCode: code,
    staffToken: staff.data.staffToken}));
  const hello = await wsMessage(ws, (msg) => msg.type === 'HELLO');
  assert.equal(hello.stateReset, true);
  const requestId = randomUUID();
  ws.send(JSON.stringify({type: 'ACQUIRE', portal: 'GİB',
    accountCode: account.data.accountCode, requestId}));
  assert.equal((await wsMessage(ws, (msg) => msg.requestId === requestId)).status, 'held');
  assert.equal((await (await fetch(`${base}/api/state`, {headers: {Cookie: cookie}})).json()).locks.length, 1);
  ws.terminate();
  await stop();
  assert.equal(child.getOutput().includes(code), false, 'organization code must not be logged');
  child = start(wsPort, adminPort);
  const restarted = await waitFor(`${base}/api/session`);
  assert.equal((await restarted.json()).setupRequired, false);
  const login = await post(base, '/api/login', {password});
  assert.equal(login.response.status, 200);
  const nextCookie = login.response.headers.get('set-cookie').split(';')[0];
  const state = await fetch(`${base}/api/state`, {headers: {Cookie: nextCookie}});
  const snapshot = await state.json();
  assert.equal(snapshot.organizationName, 'Temiz Kurulum');
  assert.equal(snapshot.staff.length, 1);
  assert.deepEqual(snapshot.locks, []);
  await stop();

  const legacy = join(directory, 'legacy', 'hub.json');
  const migrated = join(directory, 'migrated', 'hub.json');
  const {setupToken: legacyToken} = createPendingConfig(legacy);
  const oldContents = readFileSync(legacy, 'utf8');
  const migratedOutput = execFileSync(exe,
    ['--prepare', '--config-path', migrated, '--migrate-from', legacy],
    {cwd: otherDirectory, env: {...process.env, PORTALTAKIP_CONFIG: ''}, encoding: 'utf8'});
  const migratedToken = readFileSync(join(dirname(migrated), 'setup-key.txt'), 'utf8').trim();
  assert.equal(readFileSync(legacy, 'utf8'), oldContents);
  assert.equal(JSON.parse(readFileSync(migrated, 'utf8')).setupTokenHash, digest(migratedToken));
  assert.notEqual(migratedToken, legacyToken);
  assert.equal(migratedOutput.includes(migratedToken), false);
  const rotatedOutput = execFileSync(exe, ['--rotate-setup-key', '--config-path', migrated],
    {cwd: otherDirectory, env: {...process.env, PORTALTAKIP_CONFIG: ''}, encoding: 'utf8'});
  const rotatedToken = readFileSync(join(dirname(migrated), 'setup-key.txt'), 'utf8').trim();
  assert.notEqual(rotatedToken, migratedToken);
  assert.equal(JSON.parse(readFileSync(migrated, 'utf8')).setupTokenHash, digest(rotatedToken));
  assert.equal(rotatedOutput.includes(rotatedToken), false);
  process.stdout.write('EXE testi geçti: hub:init, farklı çalışma dizini, panel, yeniden başlatma, eski ayar geçişi ve anahtar yenileme.\n');
} finally {
  await stop();
  if (dirname(resolve(directory)) === resolve(tmpdir())) {
    rmSync(directory, {recursive: true, force: true});
  }
}
