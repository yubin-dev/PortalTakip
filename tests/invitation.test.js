import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import WebSocket from 'ws';
import {createInitialConfig, digest, newSecret, readConfig, saveConfig} from '../src/hub/config.js';
import {startHub} from '../src/hub/server.js';
import {validateInvitationLink} from '../src/ui/connection-input.js';

async function socket(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const queue = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const value = JSON.parse(raw.toString());
    const waiter = waiters.shift();
    if (waiter) waiter(value); else queue.push(value);
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return {ws, next: () => queue.length ? Promise.resolve(queue.shift()) :
    new Promise((resolve) => waiters.push(resolve))};
}

async function hello(client, credentials) {
  client.ws.send(JSON.stringify({type: 'HELLO', ...credentials}));
  return client.next();
}

async function nextMatching(client, predicate) {
  for (let index = 0; index < 12; index++) {
    const value = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WS timeout')), 2000);
      client.next().then((message) => { clearTimeout(timer); resolve(message); }, reject);
    });
    if (predicate(value)) return value;
  }
  throw new Error('Expected WebSocket message was not received');
}

test('LAN invitation is bound to staff, expires at 10 minutes, redeems once and survives restart as a revocable device', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'portaltakip-invite-'));
  const configPath = join(directory, 'hub.json');
  const {organizationCode, adminPassword, config} = createInitialConfig(configPath);
  const staffToken = newSecret();
  const userId = randomUUID();
  config.staff.push({userId, displayName: 'Test Personel', tokenHash: digest(staffToken),
    disabled: false});
  const otherToken = newSecret();
  const otherId = randomUUID();
  config.staff.push({userId: otherId, displayName: 'İkinci Personel',
    tokenHash: digest(otherToken), disabled: false});
  saveConfig(configPath, config);
  let now = 1_000_000;
  let hub = await startHub({configPath, wsHost: '127.0.0.1', wsPort: 0,
    adminPort: 0, stateClock: {now: () => now}});
  t.after(async () => { await hub.close(); rmSync(directory, {recursive: true, force: true}); });
  assert.equal(readConfig(configPath).version, 4);
  assert.equal(readConfig(configPath).staff[0].tokenHash, digest(staffToken));
  const base = () => `http://127.0.0.1:${hub.adminPort}`;
  let cookie;
  let csrf;
  async function login() {
    const response = await fetch(`${base()}/api/login`, {method: 'POST',
      headers: {'Content-Type': 'application/json', Origin: base()},
      body: JSON.stringify({password: adminPassword})});
    assert.equal(response.status, 200);
    cookie = response.headers.get('set-cookie').split(';')[0];
    csrf = (await response.json()).csrfToken;
  }
  async function post(path, body, authorized = true) {
    const response = await fetch(`${base()}${path}`, {method: 'POST',
      headers: {'Content-Type': 'application/json', Origin: base(),
        ...(authorized ? {Cookie: cookie, 'X-CSRF-Token': csrf} : {})},
      body: JSON.stringify(body)});
    return {status: response.status, data: await response.json()};
  }
  await login();
  assert.equal((await post('/api/invitations', {userId}, false)).status, 401);
  const expired = await post('/api/invitations', {userId});
  assert.equal(expired.status, 201);
  assert.equal(expired.data.expiresAt, now + 600_000);
  assert.equal(JSON.stringify(readConfig(configPath)).includes(expired.data.inviteToken), false);
  now = expired.data.expiresAt;
  const tooLate = await socket(hub.wsPort);
  t.after(() => tooLate.ws.terminate());
  assert.equal((await hello(tooLate, {inviteToken: expired.data.inviteToken})).code,
    'INVITE_INVALID');

  now++;
  const superseded = await post('/api/invitations', {userId});
  const issued = await post('/api/invitations', {userId});
  assert.equal(issued.status, 201);
  const replaced = await socket(hub.wsPort);
  t.after(() => replaced.ws.terminate());
  assert.equal((await hello(replaced, {inviteToken: superseded.data.inviteToken})).code,
    'INVITE_INVALID');
  const link = `http://127.0.0.1:${hub.wsPort}/invite#invite=${issued.data.inviteToken}`;
  assert.equal(validateInvitationLink(link).ok, true);
  assert.equal(validateInvitationLink(`http://8.8.8.8:${hub.wsPort}/invite#invite=${issued.data.inviteToken}`).ok, false);
  assert.equal(validateInvitationLink(`${link}&organizationCode=${organizationCode}`).ok, false);
  const page = await fetch(link);
  assert.equal(page.status, 200);
  assert.equal((await page.text()).includes(issued.data.inviteToken), false);
  now = issued.data.expiresAt - 1;
  const simultaneous = await Promise.all([socket(hub.wsPort), socket(hub.wsPort)]);
  for (const client of simultaneous) {
    t.after(() => client.ws.terminate());
    client.ws.send(JSON.stringify({type: 'HELLO', inviteToken: issued.data.inviteToken}));
  }
  const outcomes = await Promise.all(simultaneous.map((client) => client.next()));
  assert.deepEqual(outcomes.map((outcome) => outcome.type).sort(), ['ERROR', 'HELLO']);
  assert.equal(outcomes.find((outcome) => outcome.type === 'ERROR').code, 'INVITE_INVALID');
  const deviceToken = outcomes.find((outcome) => outcome.type === 'HELLO').deviceToken;
  assert.equal(deviceToken.length, 43);
  assert.equal(outcomes.find((outcome) => outcome.type === 'HELLO').userId, userId);
  assert.equal(JSON.stringify(readConfig(configPath)).includes(deviceToken), false);
  assert.equal(readConfig(configPath).devices.length, 1);
  const reused = await socket(hub.wsPort);
  t.after(() => reused.ws.terminate());
  assert.equal((await hello(reused, {inviteToken: issued.data.inviteToken})).code,
    'INVITE_INVALID');

  await hub.close();
  hub = await startHub({configPath, wsHost: '127.0.0.1', wsPort: 0,
    adminPort: 0, stateClock: {now: () => now}});
  await login();
  const remembered = await socket(hub.wsPort);
  t.after(() => remembered.ws.terminate());
  assert.equal((await hello(remembered, {deviceToken})).userId, userId);
  const state = await (await fetch(`${base()}/api/state`, {headers: {Cookie: cookie}})).json();
  assert.equal(state.staff[0].devices.length, 1);
  assert.equal(JSON.stringify(state).includes(deviceToken), false);
  const preKick = await post('/api/invitations', {userId});
  assert.equal((await post('/api/kick', {userId, requestId: randomUUID()})).status, 200);
  const banned = await socket(hub.wsPort);
  t.after(() => banned.ws.terminate());
  assert.equal((await hello(banned, {deviceToken})).code, 'KICKED');
  assert.equal((await post('/api/invitations', {userId})).status, 409);
  assert.equal((await post('/api/readmit', {userId, requestId: randomUUID()})).status, 200);
  const oldInvitation = await socket(hub.wsPort);
  t.after(() => oldInvitation.ws.terminate());
  assert.equal((await hello(oldInvitation, {inviteToken: preKick.data.inviteToken})).code,
    'INVITE_INVALID');
  const rejoined = await socket(hub.wsPort);
  t.after(() => rejoined.ws.terminate());
  assert.equal((await hello(rejoined, {deviceToken})).userId, userId);
  const accountCode = `acct_${newSecret()}`;
  rejoined.ws.send(JSON.stringify({type: 'ACQUIRE', portal: 'GİB', accountCode,
    requestId: randomUUID()}));
  assert.equal((await nextMatching(rejoined, (message) => message.type === 'ACQUIRE')).status,
    'held');
  const waiting = await socket(hub.wsPort);
  t.after(() => waiting.ws.terminate());
  assert.equal((await hello(waiting, {organizationCode, staffToken: otherToken})).userId,
    otherId);
  waiting.ws.send(JSON.stringify({type: 'ACQUIRE', portal: 'GİB', accountCode,
    requestId: randomUUID()}));
  assert.equal((await nextMatching(waiting, (message) => message.type === 'ACQUIRE')).status,
    'queued');
  const deviceId = readConfig(configPath).devices[0].deviceId;
  assert.equal((await post('/api/devices/revoke', {deviceId})).status, 200);
  assert.equal((await post('/api/devices/revoke', {deviceId})).status, 200);
  assert.equal((await nextMatching(waiting, (message) => message.type === 'STATE' &&
    message.locks[0]?.holder?.userId === otherId)).locks[0].queue.length, 0);
  const revoked = await socket(hub.wsPort);
  t.after(() => revoked.ws.terminate());
  assert.equal((await hello(revoked, {deviceToken})).code, 'DEVICE_REVOKED');
  const legacy = await socket(hub.wsPort);
  t.after(() => legacy.ws.terminate());
  assert.equal((await hello(legacy, {organizationCode, staffToken})).userId, userId);

  const pending = await post('/api/invitations', {userId: otherId});
  const nextInvite = await post('/api/invitations', {userId});
  const secondDevice = await socket(hub.wsPort);
  t.after(() => secondDevice.ws.terminate());
  const secondToken = (await hello(secondDevice,
    {inviteToken: nextInvite.data.inviteToken})).deviceToken;
  const rotated = await post('/api/organization-code/rotate', {password: adminPassword});
  assert.equal(rotated.status, 200);
  const rotatedDevice = await socket(hub.wsPort);
  t.after(() => rotatedDevice.ws.terminate());
  assert.equal((await hello(rotatedDevice, {deviceToken: secondToken})).code,
    'DEVICE_REVOKED');
  const cancelled = await socket(hub.wsPort);
  t.after(() => cancelled.ws.terminate());
  assert.equal((await hello(cancelled, {inviteToken: pending.data.inviteToken})).code,
    'INVITE_INVALID');
  const oldCode = await socket(hub.wsPort);
  t.after(() => oldCode.ws.terminate());
  assert.equal((await hello(oldCode, {organizationCode, staffToken})).code, 'AUTH_FAILED');
  const newCode = await socket(hub.wsPort);
  t.after(() => newCode.ws.terminate());
  assert.equal((await hello(newCode, {organizationCode: rotated.data.organizationCode,
    staffToken})).userId, userId);
});

test('v2 hub.json upgrades without changing the existing organization or staff credential hashes', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'portaltakip-invite-migrate-'));
  const configPath = join(directory, 'hub.json');
  const {organizationCode, config} = createInitialConfig(configPath);
  const staffToken = newSecret();
  const userId = randomUUID();
  const prior = {...config, version: 2, state: 'ready', organizationName: 'Eski Ofis',
    staff: [{userId, displayName: 'Eski Personel', tokenHash: digest(staffToken),
      disabled: false}]};
  saveConfig(configPath, prior);
  const hub = await startHub({configPath, wsHost: '127.0.0.1', wsPort: 0, adminPort: 0});
  t.after(async () => { await hub.close(); rmSync(directory, {recursive: true, force: true}); });
  const current = readConfig(configPath);
  assert.equal(current.version, 4);
  assert.equal(current.legacyAllowed, true);
  assert.deepEqual(current.accounts, []);
  assert.equal(current.organizationId, prior.organizationId);
  assert.equal(current.organizationCodeHash, prior.organizationCodeHash);
  assert.deepEqual(current.staff, prior.staff);
  assert.deepEqual(current.invitations, []);
  assert.deepEqual(current.devices, []);
  const previousMethod = await socket(hub.wsPort);
  t.after(() => previousMethod.ws.terminate());
  assert.equal((await hello(previousMethod, {organizationCode, staffToken})).userId, userId);
});
