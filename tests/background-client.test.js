import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {newSecret} from '../src/hub/config.js';

function storage() {
  const data = new Map();
  return {async setAccessLevel() {},
    async get(keys) { return Object.fromEntries(keys.filter((key) => data.has(key))
      .map((key) => [key, data.get(key)])); },
    async set(values) { for (const [key, value] of Object.entries(values)) data.set(key, value); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key); }};
}

test('client replays an uncertain operation with its original requestId after reconnect', async (t) => {
  const oldChrome = globalThis.chrome;
  const oldWebSocket = globalThis.WebSocket;
  const sockets = [];
  const operations = [];
  const alarms = [];
  let onMessage;
  let onAlarm;
  const sentTabs = [];
  let hubId = 'hub-1';
  class FakeWebSocket {
    static OPEN = 1;
    constructor(url) {
      assert.match(url, /^ws:\/\/127\.0\.0\.1:8787\/ws$/);
      this.readyState = 0;
      sockets.push(this);
      queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
    }
    receive(value) { this.onmessage?.({data: JSON.stringify(value)}); }
    send(raw) {
      const value = JSON.parse(raw);
      if (value.type === 'HELLO') {
        queueMicrotask(() => {
          this.receive({type: 'HELLO', status: 'ok', hubId, userId: 'staff-1'});
          this.receive({type: 'STATE', hubId, serverTime: Date.now(),
            organizationId: 'org-1', locks: []});
        });
      } else if (value.type === 'ACQUIRE') {
        operations.push(value);
        if (sockets.length === 1 || (sockets.length === 2 && operations.length === 3)) {
          queueMicrotask(() => this.close());
        }
        else queueMicrotask(() => this.receive({type: 'ACQUIRE', requestId: value.requestId}));
      } else if (value.type === 'STATE') {
        queueMicrotask(() => this.receive({type: 'STATE', hubId,
          serverTime: Date.now(), organizationId: 'org-1', locks: []}));
      }
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      queueMicrotask(() => this.onclose?.());
    }
  }
  globalThis.WebSocket = FakeWebSocket;
  globalThis.chrome = {runtime: {id: 'test-extension',
    getURL: (path) => `chrome-extension://test-extension/${path}`,
    sendMessage: async () => undefined,
    onMessage: {addListener(fn) { onMessage = fn; }}},
  storage: {session: storage()},
  tabs: {sendMessage: async (id, value) => { sentTabs.push({id, value}); },
    onRemoved: {addListener() {}}},
  notifications: {create: async () => undefined},
  alarms: {create: async (name) => { alarms.push(name); },
    clear: async () => true, onAlarm: {addListener(fn) { onAlarm = fn; }}}};
  t.after(() => {
    globalThis.chrome = oldChrome;
    globalThis.WebSocket = oldWebSocket;
  });
  await import(`../src/background/client.js?test=${randomUUID()}`);
  const popupSender = {id: 'test-extension',
    url: 'chrome-extension://test-extension/ui/popup.html'};
  const portalSender = {id: 'test-extension', frameId: 0, tab: {id: 17,
    url: 'https://dijital.gib.gov.tr/'}, url: 'https://dijital.gib.gov.tr/'};
  const request = (sender, type, fields = {}) => new Promise((done) => {
    onMessage({type, ...fields}, sender, done);
  });
  const popup = (type, fields) => request(popupSender, type, fields);
  const portal = (type, fields) => request(portalSender, type, fields);
  const config = {displayName: 'Test Staff', organizationName: 'Office',
    host: '127.0.0.1', port: 8787, organizationCode: newSecret(),
    staffToken: newSecret()};
  assert.equal((await popup('PT_CONNECT', {config})).ok, true);
  for (let n = 0; n < 20; n++) {
    if ((await popup('PT_GET_STATUS')).status.phase === 'connected') break;
    await new Promise((done) => setTimeout(done, 0));
  }
  assert.equal((await portal('PT_ACCOUNT_ADD', {label: 'Test',
    accountCode: 'shared_A1b2C3d4E5f6'})).ok, true);
  assert.equal((await portal('PT_ACTION', {action: 'ACQUIRE'})).ok, true);
  for (let n = 0; n < 20; n++) {
    if ((await popup('PT_GET_STATUS')).status.phase === 'retrying') break;
    await new Promise((done) => setTimeout(done, 0));
  }
  assert.equal((await popup('PT_GET_STATUS')).status.phase, 'retrying');
  assert.equal((await portal('PT_CONTENT_INIT')).view.mode, 'reconnecting');
  assert.deepEqual(alarms, ['portaltakip-reconnect']);
  onAlarm({name: 'portaltakip-reconnect'});
  for (let n = 0; n < 20; n++) {
    if (operations.length === 2) break;
    await new Promise((done) => setTimeout(done, 0));
  }
  assert.equal(operations.length, 2);
  assert.deepEqual(operations[1], operations[0]);
  assert.ok(sentTabs.some(({value}) => value.type === 'PT_ACTION_RESULT' && value.ok));
  assert.equal((await portal('PT_ACTION', {action: 'ACQUIRE'})).ok, true);
  for (let n = 0; n < 20; n++) {
    if ((await popup('PT_GET_STATUS')).status.phase === 'retrying') break;
    await new Promise((done) => setTimeout(done, 0));
  }
  hubId = 'hub-2';
  onAlarm({name: 'portaltakip-reconnect'});
  for (let n = 0; n < 20; n++) {
    if ((await popup('PT_GET_STATUS')).status.phase === 'connected' && sockets.length === 3) break;
    await new Promise((done) => setTimeout(done, 0));
  }
  assert.equal(operations.length, 3); // no replay into a restarted Hub
  assert.ok(sentTabs.some(({value}) => value.type === 'PT_ACTION_RESULT' &&
    value.code === 'HUB_RESTARTED'));
  assert.equal((await portal('PT_CONTENT_INIT')).view.mode, 'empty');
  assert.equal((await popup('PT_DISCONNECT')).status.phase, 'disconnected');
});
