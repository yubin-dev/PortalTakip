import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import WebSocket from 'ws';
import {createInitialConfig, digest, newSecret, saveConfig} from '../src/hub/config.js';
import {startHub} from '../src/hub/server.js';

function storage(data = new Map()) {
  return {data, async setAccessLevel() {},
    async get(keys) {
      const names = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(names.filter((key) => data.has(key))
        .map((key) => [key, data.get(key)]));
    },
    async set(values) { for (const [key, value] of Object.entries(values)) data.set(key, value); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key); }};
}

function chromeFixture(localData) {
  let onMessage;
  const session = storage();
  const local = storage(localData);
  return {session, local, get listener() { return onMessage; },
    chrome: {runtime: {id: 'test-extension',
      getURL: (path) => `chrome-extension://test-extension/${path}`,
      sendMessage: async () => undefined,
      onMessage: {addListener(fn) { onMessage = fn; }}},
    storage: {session, local},
    tabs: {sendMessage: async () => undefined, onRemoved: {addListener() {}}},
    notifications: {create: async () => undefined},
    alarms: {create: async () => undefined, clear: async () => true,
      onAlarm: {addListener() {}}}}};
}

async function popup(fixture, type, config) {
  return new Promise((resolve) => fixture.listener({type, ...(config ? {config} : {})},
    {id: 'test-extension', url: 'chrome-extension://test-extension/ui/popup.html'}, resolve));
}

async function connected(fixture) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await popup(fixture, 'PT_GET_STATUS');
    if (result.status.phase === 'connected') return result.status;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Worker did not connect');
}

test('invite popup flow stores only an opted-in device key in the Chrome profile and restores it', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'portaltakip-invite-client-'));
  const configPath = join(directory, 'hub.json');
  const {adminPassword, config} = createInitialConfig(configPath);
  config.staff.push({userId: randomUUID(), displayName: 'Personel',
    tokenHash: digest(newSecret()), disabled: false});
  saveConfig(configPath, config);
  const hub = await startHub({configPath, wsHost: '127.0.0.1', wsPort: 0, adminPort: 0});
  const oldChrome = globalThis.chrome;
  const oldWebSocket = globalThis.WebSocket;
  t.after(async () => {
    globalThis.chrome = oldChrome;
    globalThis.WebSocket = oldWebSocket;
    await hub.close();
    rmSync(directory, {recursive: true, force: true});
  });
  const base = `http://127.0.0.1:${hub.adminPort}`;
  const login = await fetch(`${base}/api/login`, {method: 'POST',
    headers: {'Content-Type': 'application/json', Origin: base},
    body: JSON.stringify({password: adminPassword})});
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const csrf = (await login.json()).csrfToken;
  async function invitation() {
    const response = await fetch(`${base}/api/invitations`, {method: 'POST',
      headers: {'Content-Type': 'application/json', Origin: base, Cookie: cookie,
        'X-CSRF-Token': csrf},
      body: JSON.stringify({userId: config.staff[0].userId})});
    assert.equal(response.status, 201);
    const {inviteToken} = await response.json();
    return `http://127.0.0.1:${hub.wsPort}/invite#invite=${inviteToken}`;
  }
  globalThis.WebSocket = WebSocket;
  const localData = new Map();
  const first = chromeFixture(localData);
  globalThis.chrome = first.chrome;
  await import(`../src/background/client.js?invite=${randomUUID()}`);
  assert.equal((await popup(first, 'PT_CONNECT_INVITE', {invitationLink: await invitation(),
    rememberDevice: true})).ok, true);
  await connected(first);
  const remembered = localData.get('ptRememberedConnection');
  assert.equal(remembered.authKind, 'device');
  assert.equal(remembered.deviceToken.length, 43);
  assert.equal(Object.hasOwn(remembered, 'inviteToken'), false);
  assert.equal(Object.hasOwn(remembered, 'organizationCode'), false);
  assert.equal(first.session.data.get('ptConnection').authKind, 'device');

  await popup(first, 'PT_DISCONNECT');
  assert.equal(localData.has('ptRememberedConnection'), false);
  localData.set('ptRememberedConnection', remembered); // browser restart preserves profile storage
  const reopened = chromeFixture(localData);
  globalThis.chrome = reopened.chrome;
  await import(`../src/background/client.js?reopened=${randomUUID()}`);
  await connected(reopened);
  await popup(reopened, 'PT_DISCONNECT');
  assert.equal(localData.has('ptRememberedConnection'), false);

  assert.equal((await popup(reopened, 'PT_CONNECT_INVITE', {invitationLink: await invitation(),
    rememberDevice: false})).ok, true);
  await connected(reopened);
  assert.equal(localData.has('ptRememberedConnection'), false);
  assert.equal(reopened.session.data.get('ptConnection').authKind, 'device');
  await popup(reopened, 'PT_DISCONNECT');
});
