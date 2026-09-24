import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import WebSocket from 'ws';
import {completeSetup, createInitialConfig, digest, newSecret, readConfig,
  saveConfig} from '../src/hub/config.js';
import {startHub} from '../src/hub/server.js';

function inbox(ws) {
  const messages = [];
  const waiters = new Set();
  ws.on('message', (raw) => {
    messages.push(JSON.parse(raw.toString()));
    for (const check of [...waiters]) check();
  });
  return {until(predicate) {
    const index = messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(check); reject(new Error('WS timeout')); }, 2000);
      const check = () => {
        const at = messages.findIndex(predicate);
        if (at < 0) return;
        clearTimeout(timer);
        waiters.delete(check);
        resolve(messages.splice(at, 1)[0]);
      };
      waiters.add(check);
    });
  }};
}

test('managed assignments filter STATE, reject unauthorized codes and revoke a holder with FIFO handoff', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'portaltakip-managed-'));
  const configPath = join(directory, 'hub.json');
  const password = 'A strong local admin password';
  const {config, organizationCode} = completeSetup('Ofis', password);
  const secrets = [newSecret(), newSecret(), newSecret()];
  const staff = secrets.map((token, index) => ({userId: randomUUID(),
    displayName: ['A', 'B', 'C'][index], tokenHash: digest(token), disabled: false}));
  config.staff = staff;
  saveConfig(configPath, config);
  const hub = await startHub({configPath, wsHost: '127.0.0.1', wsPort: 0, adminPort: 0});
  const sockets = [];
  t.after(async () => { sockets.forEach((ws) => ws.terminate()); await hub.close();
    rmSync(directory, {recursive: true, force: true}); });
  const base = `http://127.0.0.1:${hub.adminPort}`;
  const login = await fetch(`${base}/api/login`, {method: 'POST', headers:
    {'Content-Type': 'application/json', Origin: base}, body: JSON.stringify({password})});
  const csrf = (await login.json()).csrfToken;
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const admin = async (path, body) => {
    const response = await fetch(`${base}${path}`, {method: 'POST', headers:
      {'Content-Type': 'application/json', Origin: base, Cookie: cookie, 'X-CSRF-Token': csrf},
    body: JSON.stringify(body)});
    return {status: response.status, data: await response.json()};
  };
  const create = async (portal, label, assignedUserIds) =>
    (await admin('/api/accounts', {portal, label, assignedUserIds})).data.account;
  const gib = await create('GİB', 'Genel A', staff.map((s) => s.userId));
  const other = await create('GİB', 'Genel B', [staff[2].userId]);
  const sgk = await create('SGK', 'Bordro A', [staff[0].userId]);
  assert.notEqual(gib.code, other.code);
  assert.equal(readConfig(configPath).accounts.length, 3);
  const connect = async (index) => {
    const ws = new WebSocket(`ws://127.0.0.1:${hub.wsPort}/ws`);
    const messages = inbox(ws);
    sockets.push(ws);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(JSON.stringify({type: 'HELLO', organizationCode, staffToken: secrets[index]}));
    await messages.until((m) => m.type === 'HELLO');
    const state = await messages.until((m) => m.type === 'STATE');
    return {ws, messages, state};
  };
  const [a, b, c] = await Promise.all([connect(0), connect(1), connect(2)]);
  assert.deepEqual(a.state.accounts.map((item) => item.code).sort(), [gib.code, sgk.code].sort());
  assert.deepEqual(b.state.accounts.map((item) => item.code), [gib.code]);
  assert.deepEqual(c.state.accounts.map((item) => item.code).sort(), [gib.code, other.code].sort());
  const act = async (client, type, portal, accountCode) => {
    const requestId = randomUUID();
    client.ws.send(JSON.stringify({type, portal, accountCode, requestId}));
    return client.messages.until((m) => m.requestId === requestId);
  };
  assert.equal((await act(b, 'ACQUIRE', 'GİB', other.code)).code, 'ACCOUNT_FORBIDDEN');
  assert.equal((await act(b, 'ACQUIRE', 'SGK', sgk.code)).code, 'ACCOUNT_FORBIDDEN');
  assert.equal((await act(a, 'ACQUIRE', 'GİB', gib.code)).status, 'held');
  assert.equal((await act(b, 'ACQUIRE', 'GİB', gib.code)).status, 'queued');
  assert.equal((await act(c, 'ACQUIRE', 'GİB', gib.code)).status, 'queued');
  assert.equal((await act(c, 'ACQUIRE', 'GİB', other.code)).status, 'held');
  assert.equal((await act(a, 'ACQUIRE', 'SGK', sgk.code)).status, 'held');
  const stateRequestId = randomUUID();
  b.ws.send(JSON.stringify({type: 'STATE', requestId: stateRequestId}));
  const privateState = await b.messages.until((m) => m.type === 'STATE' &&
    m.requestId === stateRequestId);
  assert.equal(JSON.stringify(privateState).includes(other.code), false);
  assert.equal(JSON.stringify(privateState).includes(sgk.code), false);
  assert.equal((await act(b, 'ACQUIRE', 'GİB', gib.code)).position, 1);
  const revoke = await admin('/api/accounts/assign', {accountId: gib.id,
    assignedUserIds: [staff[1].userId, staff[2].userId]});
  assert.equal(revoke.status, 200);
  assert.deepEqual(revoke.data.removed, [staff[0].userId]);
  const next = await b.messages.until((m) => m.type === 'STATE' &&
    m.locks.some((lock) => lock.key.accountCode === gib.code &&
      lock.holder?.userId === staff[1].userId));
  assert.deepEqual(next.locks.find((lock) => lock.key.accountCode === gib.code).queue
    .map((entry) => entry.userId), [staff[2].userId]);
  const updatedA = await a.messages.until((m) => m.type === 'STATE' &&
    !m.accounts.some((account) => account.code === gib.code));
  assert.equal(updatedA.locks.some((lock) => lock.key.accountCode === gib.code), false);
  assert.equal(updatedA.locks.find((lock) => lock.key.accountCode === sgk.code).holder.userId,
    staff[0].userId);
  assert.equal((await act(a, 'ACQUIRE', 'GİB', gib.code)).code, 'ACCOUNT_FORBIDDEN');
  assert.equal((await act(b, 'RELEASE', 'GİB', gib.code)).status, 'released');
  const cTurn = await c.messages.until((m) => m.type === 'STATE' &&
    m.locks.some((lock) => lock.key.accountCode === gib.code &&
      lock.holder?.userId === staff[2].userId));
  assert.equal(cTurn.locks.find((lock) => lock.key.accountCode === gib.code).queue.length, 0);
});

test('v1 local codes survive migration, active queues stay on the same key, enforcement is explicit', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'portaltakip-migrate-'));
  const configPath = join(directory, 'hub.json');
  const {config, organizationCode, adminPassword} = createInitialConfig(configPath);
  const token = newSecret();
  const userId = randomUUID();
  config.staff.push({userId, displayName: 'A', tokenHash: digest(token)});
  saveConfig(configPath, config);
  const hub = await startHub({configPath, wsHost: '127.0.0.1', wsPort: 0, adminPort: 0});
  const sockets = [];
  t.after(async () => { sockets.forEach((ws) => ws.terminate()); await hub.close();
    rmSync(directory, {recursive: true, force: true}); });
  assert.equal(readConfig(configPath).legacyAllowed, true);
  const base = `http://127.0.0.1:${hub.adminPort}`;
  const login = await fetch(`${base}/api/login`, {method: 'POST', headers:
    {'Content-Type': 'application/json', Origin: base},
  body: JSON.stringify({password: adminPassword})});
  const csrf = (await login.json()).csrfToken;
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const admin = async (path, body) => {
    const response = await fetch(`${base}${path}`, {method: 'POST', headers:
      {'Content-Type': 'application/json', Origin: base, Cookie: cookie, 'X-CSRF-Token': csrf},
    body: JSON.stringify(body)});
    return {status: response.status, data: await response.json()};
  };
  const ws = new WebSocket(`ws://127.0.0.1:${hub.wsPort}/ws`);
  sockets.push(ws);
  const messages = inbox(ws);
  await new Promise((resolve) => ws.once('open', resolve));
  ws.send(JSON.stringify({type: 'HELLO', organizationCode, staffToken: token}));
  await messages.until((m) => m.type === 'HELLO');
  assert.equal((await messages.until((m) => m.type === 'STATE')).legacyAllowed, true);
  const code = 'legacy_shared_code_123';
  const act = async (accountCode) => {
    const requestId = randomUUID();
    ws.send(JSON.stringify({type: 'ACQUIRE', portal: 'GİB', accountCode, requestId}));
    return messages.until((m) => m.requestId === requestId);
  };
  assert.equal((await act(code)).status, 'held');
  assert.equal((await admin('/api/accounts/enforce', {})).status, 409);
  const imported = await admin('/api/accounts/import', {portal: 'GİB', label: 'Eski A',
    accountCode: code, assignedUserIds: [userId]});
  assert.equal(imported.status, 201);
  assert.equal(imported.data.account.code, code);
  assert.equal((await admin('/api/accounts/enforce', {})).status, 200);
  assert.equal(readConfig(configPath).legacyAllowed, false);
  assert.equal((await act(code)).status, 'held');
  assert.equal((await act('unknown_code_123456')).code, 'ACCOUNT_FORBIDDEN');
});
