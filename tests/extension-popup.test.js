import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import WebSocket from 'ws';
import {normalizeLanHost, validateConnectionInput, websocketUrl} from '../src/ui/connection-input.js';
import {createInitialConfig, digest, newSecret, saveConfig} from '../src/hub/config.js';
import {startHub} from '../src/hub/server.js';

const valid = {displayName: 'Ayşe Test', organizationName: 'Ofis', host: '192.168.1.10',
  port: '8787', organizationCode: newSecret(), staffToken: newSecret()};

test('popup accepts only literal LAN/loopback targets and validates Hub credentials', () => {
  for (const host of ['10.0.0.1', '127.0.0.1', '172.16.0.1', '172.31.255.254',
    '192.168.1.1', '169.254.1.2', 'localhost', '[::1]', 'fd00::1', 'fe80::1']) {
    assert.ok(normalizeLanHost(host), host);
  }
  for (const host of ['8.8.8.8', '172.32.0.1', '192.169.1.1', '0.0.0.0',
    'localhost.evil.test', 'hub.local', 'http://10.0.0.1', '10.0.0.1/path',
    '10.0.0.1:80', '010.0.0.1', '::ffff:8.8.8.8', 'fe70::1']) {
    assert.equal(normalizeLanHost(host), null, host);
  }
  assert.equal(validateConnectionInput(valid).ok, true);
  assert.equal(websocketUrl(validateConnectionInput(valid).value),
    'ws://192.168.1.10:8787/ws');
  assert.equal(validateConnectionInput({...valid, port: '65536'}).field, 'port');
  assert.equal(validateConnectionInput({...valid, organizationCode: ''}).field,
    'organizationCode');
  assert.equal(validateConnectionInput({...valid, staffToken: 'short'}).field,
    'staffToken');
  assert.equal(validateConnectionInput({...valid, host: '8.8.8.8'}).field, 'host');
});

function fakeStorage() {
  const data = new Map();
  return {data,
    async setAccessLevel() {},
    async get(keys) { return Object.fromEntries(keys.filter((key) => data.has(key))
      .map((key) => [key, data.get(key)])); },
    async set(values) { for (const [key, value] of Object.entries(values)) data.set(key, value); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key); },
  };
}

test('MV3 worker owns the socket; popup messages connect and disconnect without disk secrets', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'portaltakip-popup-test-'));
  const configPath = join(directory, 'hub.json');
  const {organizationCode, config} = createInitialConfig(configPath);
  const staffToken = newSecret();
  config.staff.push({userId: randomUUID(), displayName: 'Ayşe Test',
    tokenHash: digest(staffToken), disabled: false});
  saveConfig(configPath, config);
  let hub = await startHub({configPath, wsHost: '127.0.0.1', wsPort: 0, adminPort: 0});
  const priorChrome = globalThis.chrome;
  const priorWebSocket = globalThis.WebSocket;
  let listener;
  const session = fakeStorage();
  const local = fakeStorage();
  const tabMessages = [];
  globalThis.chrome = {runtime: {id: 'test-extension',
    getURL: (path) => `chrome-extension://test-extension/${path}`,
    sendMessage: async () => undefined,
    onMessage: {addListener(callback) { listener = callback; }}},
  storage: {session, local},
  tabs: {sendMessage: async (tabId, message) => { tabMessages.push({tabId, message}); },
    onRemoved: {addListener() {}}},
  notifications: {create: async () => {}}};
  globalThis.WebSocket = WebSocket;
  t.after(async () => {
    globalThis.chrome = priorChrome;
    globalThis.WebSocket = priorWebSocket;
    if (hub) await hub.close();
    if (dirname(resolve(directory)) === resolve(tmpdir())) rmSync(directory, {recursive: true, force: true});
  });
  await import(`../src/background/client.js?test=${randomUUID()}`);
  const send = (type, value) => new Promise((done) => {
    listener({type, ...(value ? {config: value} : {})},
      {id: 'test-extension', url: 'chrome-extension://test-extension/ui/popup.html'}, done);
  });
  const input = {...valid, host: '127.0.0.1', port: hub.wsPort,
    organizationCode, staffToken};
  assert.equal((await send('PT_CONNECT', {...input, host: '8.8.8.8'})).ok, false);
  assert.equal((await send('PT_CONNECT', input)).ok, true);
  let current;
  for (let attempt = 0; attempt < 50; attempt++) {
    current = (await send('PT_GET_STATUS')).status;
    if (current.phase === 'connected') break;
    await new Promise((done) => setTimeout(done, 20));
  }
  assert.equal(current.phase, 'connected');
  assert.equal(session.data.get('ptConnection').organizationCode, organizationCode);
  assert.equal(local.data.has('organizationCode'), false);
  assert.equal(local.data.has('staffToken'), false);
  const content = (type, extra = {}) => new Promise((done) => {
    listener({type, ...extra}, {id: 'test-extension', frameId: 0, tab: {id: 12,
      url: 'https://dijital.gib.gov.tr/'}, url: 'https://dijital.gib.gov.tr/'}, done);
  });
  const sharedCode = 'shared_A1b2C3d4E5f6';
  assert.equal((await content('PT_CONTENT_INIT')).view.mode, 'accountRequired');
  assert.match((await content('PT_ACTION', {action: 'ACQUIRE'})).error,
    /ortak hesap kodunu seçin/i);
  const added = await content('PT_ACCOUNT_ADD', {label: 'Ortak hesap',
    accountCode: sharedCode});
  assert.equal(added.ok, true);
  assert.equal(added.view.accountCode, sharedCode);
  assert.deepEqual(added.accounts.map(({label}) => label), ['Ortak hesap']);
  assert.equal(Object.hasOwn(added.accounts[0], 'code'), false);
  assert.equal((await content('PT_ACTION', {action: 'ACQUIRE'})).ok, true);
  let view;
  for (let attempt = 0; attempt < 50; attempt++) {
    view = (await content('PT_CONTENT_INIT')).view;
    if (view.mode === 'mine') break;
    await new Promise((done) => setTimeout(done, 20));
  }
  assert.equal(view.mode, 'mine');
  assert.ok(tabMessages.some(({message}) => message.type === 'PT_PORTAL_UPDATE' &&
    message.view.mode === 'mine'));
  assert.equal((await content('PT_ACTION', {action: 'LEAVE'})).ok, true);
  for (let attempt = 0; attempt < 50; attempt++) {
    view = (await content('PT_CONTENT_INIT')).view;
    if (view.mode === 'empty') break;
    await new Promise((done) => setTimeout(done, 20));
  }
  assert.equal(view.mode, 'empty');
  const second = await content('PT_ACCOUNT_ADD', {label: 'İkinci hesap',
    accountCode: 'shared_Z9y8X7w6V5u4'});
  assert.equal(second.view.accountCode, 'shared_Z9y8X7w6V5u4');
  const reselected = await content('PT_ACCOUNT_SELECT', {accountId: added.view.accountId});
  assert.equal(reselected.view.accountCode, sharedCode);
  assert.equal((await content('PT_ACTION', {action: 'ACQUIRE'})).ok, true);
  for (let attempt = 0; attempt < 50; attempt++) {
    view = (await content('PT_CONTENT_INIT')).view;
    if (view.mode === 'mine') break;
    await new Promise((done) => setTimeout(done, 20));
  }
  assert.equal(view.mode, 'mine');
  await hub.close();
  hub = null;
  for (let attempt = 0; attempt < 50; attempt++) {
    view = (await content('PT_CONTENT_INIT')).view;
    if (view.mode === 'reconnecting') break;
    await new Promise((done) => setTimeout(done, 20));
  }
  assert.equal(view.mode, 'reconnecting');
  assert.equal(view.accountCode, sharedCode);
  assert.equal((await send('PT_DISCONNECT')).status.phase, 'disconnected');
  assert.equal(session.data.has('ptConnection'), false);
});
