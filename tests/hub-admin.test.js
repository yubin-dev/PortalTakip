import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import WebSocket from 'ws';
import {createPendingConfig, readConfig, verifyPassword} from '../src/hub/config.js';
import {startHub} from '../src/hub/server.js';

function messages(ws) {
  const queue = [];
  const waiters = [];
  ws.on('message', (buffer) => {
    const value = JSON.parse(buffer.toString());
    const waiter = waiters.shift();
    if (waiter) waiter(value); else queue.push(value);
  });
  return () => queue.length ? Promise.resolve(queue.shift()) :
    new Promise((resolvePromise) => waiters.push(resolvePromise));
}

async function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const next = messages(ws);
  await new Promise((done, fail) => { ws.once('open', done); ws.once('error', fail); });
  return {ws, next};
}

test('first setup hashes admin password; rotating organization code revokes live sessions', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'portaltakip-admin-test-'));
  const configPath = join(directory, 'hub.json');
  const {setupToken} = createPendingConfig(configPath);
  const hub = await startHub({configPath, wsHost: '127.0.0.1', wsPort: 0, adminPort: 0});
  t.after(async () => {
    await hub.close();
    if (dirname(resolve(directory)) === resolve(tmpdir())) rmSync(directory, {recursive: true, force: true});
  });
  const base = `http://127.0.0.1:${hub.adminPort}`;
  const post = async (path, body, cookie, csrf, origin = base) => {
    const response = await fetch(`${base}${path}`, {method: 'POST',
      headers: {'Content-Type': 'application/json', Origin: origin,
        ...(cookie ? {Cookie: cookie} : {}), ...(csrf ? {'X-CSRF-Token': csrf} : {})},
      body: JSON.stringify(body)});
    return {response, data: await response.json()};
  };
  assert.equal((await (await fetch(`${base}/api/session`)).json()).setupRequired, true);
  assert.equal((await post('/api/setup', {setupToken, organizationName: 'Ofis',
    password: 'VeryLongSecret123!'}, null, null, 'http://evil.invalid')).response.status, 403);
  assert.equal((await post('/api/setup', {setupToken: 'wrong', organizationName: 'Ofis',
    password: 'VeryLongSecret123!'})).response.status, 400);
  const setup = await post('/api/setup', {setupToken, organizationName: 'Ofis',
    password: 'VeryLongSecret123!'});
  assert.equal(setup.response.status, 201);
  const oldCode = setup.data.organizationCode;
  const cookie = setup.response.headers.get('set-cookie').split(';')[0];
  const csrf = setup.data.csrfToken;
  const config = readConfig(configPath);
  assert.equal(config.organizationName, 'Ofis');
  assert.equal(verifyPassword('VeryLongSecret123!', config.adminPasswordHash), true);
  assert.equal(JSON.stringify(config).includes(oldCode), false);
  assert.equal(JSON.stringify(config).includes(setupToken), false);
  assert.equal((await post('/api/setup', {setupToken, organizationName: 'Other',
    password: 'VeryLongSecret123!'})).response.status, 409);
  assert.equal((await post('/api/organization-code/rotate',
    {password: 'wrong'}, cookie, csrf)).response.status, 403);
  const staff = await post('/api/staff', {displayName: 'Ayşe'}, cookie, csrf);
  assert.equal(staff.response.status, 201);
  const live = await connect(hub.wsPort);
  t.after(() => live.ws.terminate());
  live.ws.send(JSON.stringify({type: 'HELLO', organizationCode: oldCode,
    staffToken: staff.data.staffToken}));
  assert.equal((await live.next()).type, 'HELLO');
  const rotated = await post('/api/organization-code/rotate',
    {password: 'VeryLongSecret123!'}, cookie, csrf);
  assert.equal(rotated.response.status, 200);
  assert.notEqual(rotated.data.organizationCode, oldCode);
  // A pending STATE broadcast can precede the rotation notice.
  let notice;
  for (let i = 0; i < 3; i++) {
    notice = await live.next();
    if (notice.type === 'ERROR') break;
  }
  assert.equal(notice.code, 'CODE_ROTATED');
  const stale = await connect(hub.wsPort);
  t.after(() => stale.ws.terminate());
  stale.ws.send(JSON.stringify({type: 'HELLO', organizationCode: oldCode,
    staffToken: staff.data.staffToken}));
  assert.equal((await stale.next()).code, 'AUTH_FAILED');
  const fresh = await connect(hub.wsPort);
  t.after(() => fresh.ws.terminate());
  fresh.ws.send(JSON.stringify({type: 'HELLO', organizationCode: rotated.data.organizationCode,
    staffToken: staff.data.staffToken}));
  assert.equal((await fresh.next()).status, 'ok');
  const beforeState = Date.now();
  const state = await (await fetch(`${base}/api/state`, {headers: {Cookie: cookie}})).json();
  const afterState = Date.now();
  assert.equal(state.organizationName, 'Ofis');
  assert.ok(state.serverTime >= beforeState && state.serverTime <= afterState);
  assert.equal(state.staff[0].connected, true);
  assert.equal(state.wsPort, hub.wsPort);
});
