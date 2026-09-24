import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {request as httpRequest} from 'node:http';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import WebSocket from 'ws';
import {createInitialConfig, digest, newSecret, readConfig,
  saveConfig} from '../src/hub/config.js';
import {startHub} from '../src/hub/server.js';

function inbox(ws) {
  const messages = [];
  const waiters = [];
  ws.on('message', (buffer) => {
    const message = JSON.parse(buffer.toString());
    messages.push(message);
    for (const waiter of [...waiters]) waiter();
  });
  return {
    async until(predicate) {
      const existing = messages.findIndex(predicate);
      if (existing >= 0) return messages.splice(existing, 1)[0];
      return new Promise((resolvePromise, reject) => {
        const timeout = setTimeout(() => {
          waiters.splice(waiters.indexOf(check), 1);
          reject(new Error('Timed out waiting for WebSocket message'));
        }, 2000);
        const check = () => {
          const index = messages.findIndex(predicate);
          if (index < 0) return;
          clearTimeout(timeout);
          waiters.splice(waiters.indexOf(check), 1);
          resolvePromise(messages.splice(index, 1)[0]);
        };
        waiters.push(check);
      });
    },
  };
}

async function openWs(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const messages = inbox(ws);
  await new Promise((resolvePromise, reject) => {
    ws.once('open', resolvePromise);
    ws.once('error', reject);
  });
  return {ws, messages};
}

function send(ws, value) { ws.send(JSON.stringify(value)); }

test('Hub authenticates staff, isolates admin actions, broadcasts state, and signals restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'portaltakip-hub-test-'));
  const configPath = join(directory, 'hub.json');
  const {organizationCode, adminPassword} = createInitialConfig(configPath);
  const baseConfig = readConfig(configPath);
  assert.equal(JSON.stringify(baseConfig).includes(organizationCode), false);
  assert.equal(JSON.stringify(baseConfig).includes(adminPassword), false);
  let hub = await startHub({configPath, wsHost: '127.0.0.1', wsPort: 0, adminPort: 0});
  t.after(async () => {
    await hub.close();
    if (dirname(resolve(directory)) === resolve(tmpdir())) rmSync(directory, {recursive: true, force: true});
  });
  const adminUrl = `http://127.0.0.1:${hub.adminPort}`;
  assert.equal((await fetch(`${adminUrl}/`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${hub.wsPort}/`)).status, 404);
  const wrongHostStatus = await new Promise((resolvePromise, reject) => {
    const request = httpRequest(adminUrl, {headers: {Host: 'attacker.invalid'}},
      (response) => { response.resume(); resolvePromise(response.statusCode); });
    request.once('error', reject);
    request.end();
  });
  assert.equal(wrongHostStatus, 403);
  const post = async (path, body, cookie, csrf, origin = adminUrl) => {
    const response = await fetch(`${adminUrl}${path}`, {method: 'POST',
      headers: {'Content-Type': 'application/json', Origin: origin,
        ...(cookie ? {Cookie: cookie} : {}), ...(csrf ? {'X-CSRF-Token': csrf} : {})},
      body: JSON.stringify(body)});
    return {response, data: await response.json()};
  };

  assert.equal((await post('/api/login', {password: adminPassword}, null, null,
    'http://attacker.invalid')).response.status, 403);
  const login = await post('/api/login', {password: adminPassword});
  assert.equal(login.response.status, 200);
  const cookie = login.response.headers.get('set-cookie').split(';')[0];
  const csrf = login.data.csrfToken;
  assert.equal((await post('/api/staff', {displayName: 'A'}, cookie)).response.status, 403);
  const staffA = await post('/api/staff', {displayName: 'A'}, cookie, csrf);
  const staffB = await post('/api/staff', {displayName: 'B'}, cookie, csrf);
  assert.equal(staffA.response.status, 201);
  assert.equal(staffB.response.status, 201);
  assert.equal((await post('/api/staff', {displayName: 'x'.repeat(20_000)},
    cookie, csrf)).response.status, 413);
  assert.equal(JSON.stringify(readConfig(configPath)).includes(staffA.data.staffToken), false);
  const code = (await post('/api/account-code', {}, cookie, csrf)).data.accountCode;

  const invalid = await openWs(hub.wsPort);
  t.after(() => invalid.ws.terminate());
  send(invalid.ws, {type: 'HELLO', organizationCode: {toString: null},
    staffToken: staffA.data.staffToken});
  assert.equal((await invalid.messages.until((message) => message.type === 'ERROR')).code,
    'INVALID_HELLO');
  send(invalid.ws, {type: 'HELLO', organizationCode:
    (organizationCode[0] === 'A' ? 'B' : 'A') + organizationCode.slice(1),
  staffToken: staffA.data.staffToken});
  assert.equal((await invalid.messages.until((message) => message.type === 'ERROR')).code,
    'AUTH_FAILED');

  const a = await openWs(hub.wsPort);
  t.after(() => a.ws.terminate());
  send(a.ws, {type: 'HELLO', organizationCode, staffToken: staffA.data.staffToken});
  const helloA = await a.messages.until((message) => message.type === 'HELLO');
  assert.equal(helloA.stateReset, true);
  assert.equal((await a.messages.until((message) => message.type === 'STATE')).locks.length, 0);
  send(a.ws, {type: 'ACQUIRE', portal: 'GİB', accountCode: code,
    requestId: randomUUID(), userId: staffB.data.userId});
  assert.equal((await a.messages.until((message) => message.type === 'ERROR')).code,
    'INVALID_MESSAGE');
  const firstRequest = randomUUID();
  send(a.ws, {type: 'ACQUIRE', portal: 'GİB', accountCode: code, requestId: firstRequest});
  assert.equal((await a.messages.until((message) => message.requestId === firstRequest)).status, 'held');

  const b = await openWs(hub.wsPort);
  t.after(() => b.ws.terminate());
  send(b.ws, {type: 'HELLO', organizationCode, staffToken: staffB.data.staffToken,
    lastHubId: helloA.hubId});
  assert.equal((await b.messages.until((message) => message.type === 'HELLO')).stateReset, false);
  assert.equal((await b.messages.until((message) => message.type === 'STATE')).locks[0].holder.userId,
    staffA.data.userId);
  const secondRequest = randomUUID();
  send(b.ws, {type: 'ACQUIRE', portal: 'GİB', accountCode: code, requestId: secondRequest});
  assert.equal((await b.messages.until((message) => message.requestId === secondRequest)).status,
    'queued');
  send(b.ws, {type: 'ACQUIRE', portal: 'GİB', accountCode: code, requestId: secondRequest});
  assert.equal((await b.messages.until((message) => message.requestId === secondRequest)).position,
    1);
  const state = await a.messages.until((message) => message.type === 'STATE' &&
    message.locks[0]?.queue.length === 1);
  assert.equal(state.locks[0].queue[0].userId, staffB.data.userId);
  assert.equal(JSON.stringify(state).includes('socketId'), false);

  const unlock = await post('/api/force-unlock', {portal: 'GİB', accountCode: code,
    requestId: randomUUID()}, cookie, csrf);
  assert.equal(unlock.data.status, 'unlocked');
  assert.equal((await b.messages.until((message) => message.type === 'STATE' &&
    message.locks[0]?.holder.userId === staffB.data.userId)).locks[0].holder.userId,
    staffB.data.userId);
  const kicked = await post('/api/kick', {userId: staffB.data.userId,
    requestId: randomUUID()}, cookie, csrf);
  assert.equal(kicked.data.status, 'kicked');
  assert.equal((await b.messages.until((message) => message.type === 'ERROR')).code, 'KICKED');
  const banned = await openWs(hub.wsPort);
  t.after(() => banned.ws.terminate());
  send(banned.ws, {type: 'HELLO', organizationCode, staffToken: staffB.data.staffToken});
  assert.equal((await banned.messages.until((message) => message.type === 'ERROR')).code, 'KICKED');
  const readmit = await post('/api/readmit', {userId: staffB.data.userId,
    requestId: randomUUID()}, cookie, csrf);
  assert.equal(readmit.data.status, 'readmitted');

  await hub.close();
  hub = await startHub({configPath, wsHost: '127.0.0.1', wsPort: 0, adminPort: 0});
  const reconnect = await openWs(hub.wsPort);
  t.after(() => reconnect.ws.terminate());
  send(reconnect.ws, {type: 'HELLO', organizationCode,
    staffToken: staffA.data.staffToken, lastHubId: helloA.hubId});
  assert.equal((await reconnect.messages.until((message) => message.type === 'HELLO')).stateReset,
    true);
  assert.deepEqual((await reconnect.messages.until((message) => message.type === 'STATE')).locks, []);
});

test('Hub rejects oversized WebSocket messages and rate-limits a single socket', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'portaltakip-limit-test-'));
  const configPath = join(directory, 'hub.json');
  const {organizationCode, config} = createInitialConfig(configPath);
  const staffToken = newSecret();
  config.staff.push({userId: randomUUID(), displayName: 'Limit Test',
    tokenHash: digest(staffToken)});
  saveConfig(configPath, config);
  const hub = await startHub({configPath, wsHost: '127.0.0.1', wsPort: 0, adminPort: 0});
  t.after(async () => {
    await hub.close();
    if (dirname(resolve(directory)) === resolve(tmpdir())) rmSync(directory, {recursive: true, force: true});
  });

  const large = await openWs(hub.wsPort);
  t.after(() => large.ws.terminate());
  send(large.ws, {type: 'HELLO', organizationCode, staffToken});
  await large.messages.until((message) => message.type === 'HELLO');
  const largeClosed = new Promise((resolvePromise) => large.ws.once('close', resolvePromise));
  large.ws.send('x'.repeat(9 * 1024));
  assert.equal(await largeClosed, 1009);

  const noisy = await openWs(hub.wsPort);
  t.after(() => noisy.ws.terminate());
  send(noisy.ws, {type: 'HELLO', organizationCode, staffToken});
  await noisy.messages.until((message) => message.type === 'HELLO');
  for (let index = 0; index < 120; index++) send(noisy.ws, {type: 'STATE'});
  assert.equal((await noisy.messages.until((message) => message.type === 'ERROR' &&
    message.code === 'RATE_LIMIT')).code, 'RATE_LIMIT');
});

test('a kicked staff identity stays blocked after Hub restart until readmitted', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'portaltakip-ban-test-'));
  const configPath = join(directory, 'hub.json');
  const {organizationCode, adminPassword, config} = createInitialConfig(configPath);
  const staffToken = newSecret();
  const userId = randomUUID();
  config.staff.push({userId, displayName: 'Blocked', tokenHash: digest(staffToken),
    disabled: false});
  saveConfig(configPath, config);
  let hub = await startHub({configPath, wsHost: '127.0.0.1', wsPort: 0, adminPort: 0});
  t.after(async () => {
    await hub.close();
    if (dirname(resolve(directory)) === resolve(tmpdir())) rmSync(directory, {recursive: true, force: true});
  });
  async function adminAction(path, body) {
    const url = `http://127.0.0.1:${hub.adminPort}`;
    const login = await fetch(`${url}/api/login`, {method: 'POST',
      headers: {'Content-Type': 'application/json', Origin: url},
      body: JSON.stringify({password: adminPassword})});
    const csrf = (await login.json()).csrfToken;
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const response = await fetch(`${url}${path}`, {method: 'POST',
      headers: {'Content-Type': 'application/json', Origin: url, Cookie: cookie,
        'X-CSRF-Token': csrf}, body: JSON.stringify(body)});
    return response.json();
  }
  assert.equal((await adminAction('/api/kick', {userId, requestId: randomUUID()})).status,
    'kicked');
  assert.equal(readConfig(configPath).staff[0].disabled, true);
  await hub.close();
  hub = await startHub({configPath, wsHost: '127.0.0.1', wsPort: 0, adminPort: 0});
  const blocked = await openWs(hub.wsPort);
  t.after(() => blocked.ws.terminate());
  send(blocked.ws, {type: 'HELLO', organizationCode, staffToken});
  assert.equal((await blocked.messages.until((message) => message.type === 'ERROR')).code,
    'KICKED');
  assert.equal((await adminAction('/api/readmit', {userId, requestId: randomUUID()})).status,
    'readmitted');
  assert.equal(readConfig(configPath).staff[0].disabled, false);
  const admitted = await openWs(hub.wsPort);
  t.after(() => admitted.ws.terminate());
  send(admitted.ws, {type: 'HELLO', organizationCode, staffToken});
  assert.equal((await admitted.messages.until((message) => message.type === 'HELLO')).status,
    'ok');
});
