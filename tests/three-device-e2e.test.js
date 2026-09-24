import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {networkInterfaces, tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {once} from 'node:events';
import WebSocket from 'ws';
import {createPendingConfig} from '../src/hub/config.js';
import {startHub} from '../src/hub/server.js';
import {PRESENCE_INTERVAL_MS, CONFIRMATION_WINDOW_MS,
  RECONNECT_GRACE_MS} from '../src/core/semaphore-state.js';

function fakeClock() {
  let time = Date.now();
  let sequence = 0;
  const jobs = new Map();
  return {now: () => time,
    setTimeout(fn, delay) {
      const id = ++sequence;
      jobs.set(id, {at: time + delay, fn});
      return id;
    },
    clearTimeout(id) { jobs.delete(id); },
    advance(ms) {
      const target = time + ms;
      for (;;) {
        const due = [...jobs].filter(([, job]) => job.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        time = due[1].at;
        jobs.delete(due[0]);
        due[1].fn();
      }
      time = target;
    },
  };
}

function inbox(ws) {
  const messages = [];
  const waiters = new Set();
  ws.on('message', (raw) => {
    messages.push(JSON.parse(raw.toString()));
    for (const check of [...waiters]) check();
  });
  return {until(predicate) {
    const existing = messages.findIndex(predicate);
    if (existing !== -1) return Promise.resolve(messages.splice(existing, 1)[0]);
    return new Promise((done, fail) => {
      const timer = setTimeout(() => { waiters.delete(check); fail(new Error('WS state timeout')); },
        3000);
      const check = () => {
        const index = messages.findIndex(predicate);
        if (index === -1) return;
        clearTimeout(timer);
        waiters.delete(check);
        done(messages.splice(index, 1)[0]);
      };
      waiters.add(check);
    });
  }};
}

async function person(address, port, organizationCode, staffToken, lastHubId) {
  const ws = new WebSocket(`ws://${address}:${port}/ws`);
  const messages = inbox(ws);
  await once(ws, 'open');
  ws.send(JSON.stringify({type: 'HELLO', organizationCode, staffToken,
    ...(lastHubId ? {lastHubId} : {})}));
  const hello = await messages.until((value) => value.type === 'HELLO' || value.type === 'ERROR');
  if (hello.type === 'HELLO') await messages.until((value) => value.type === 'STATE');
  return {ws, messages, hello};
}

async function act(personnel, type, portal, accountCode) {
  const requestId = randomUUID();
  personnel.ws.send(JSON.stringify({type, portal, accountCode, requestId}));
  return personnel.messages.until((value) => value.requestId === requestId &&
    (value.type === type || value.type === 'ERROR'));
}

function lock(snapshot, portal, code) {
  return snapshot.locks.find((item) => item.key.portal === portal &&
    item.key.accountCode === code);
}

test('two LAN staff clients and loopback admin complete setup, FIFO, presence, recovery and restart',
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'portaltakip-three-device-'));
    const configPath = join(directory, 'hub.json');
    const {setupToken} = createPendingConfig(configPath);
    const clock = fakeClock();
    let hub = await startHub({configPath, wsHost: '0.0.0.0', wsPort: 0,
      adminPort: 0, stateClock: clock});
    const sockets = [];
    t.after(async () => {
      for (const ws of sockets) ws.terminate();
      if (hub) await hub.close();
      if (dirname(resolve(directory)) === resolve(tmpdir())) {
        rmSync(directory, {recursive: true, force: true});
      }
    });
    const lanAddress = Object.values(networkInterfaces()).flat()
      .find((entry) => entry?.family === 'IPv4' && !entry.internal &&
        /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address))?.address;
    const wsAddress = lanAddress ?? '127.0.0.1';
    let base = `http://127.0.0.1:${hub.adminPort}`;
    const post = async (path, body, cookie, csrf) => {
      const response = await fetch(`${base}${path}`, {method: 'POST',
        headers: {'Content-Type': 'application/json', Origin: base,
          ...(cookie ? {Cookie: cookie} : {}),
          ...(csrf ? {'X-CSRF-Token': csrf} : {})},
        body: JSON.stringify(body)});
      return {status: response.status, data: await response.json(),
        cookie: response.headers.get('set-cookie')?.split(';')[0]};
    };
    assert.equal((await (await fetch(`${base}/api/session`)).json()).setupRequired, true);
    const password = `Admin-${randomUUID()}-secret`;
    const setup = await post('/api/setup', {setupToken,
      organizationName: 'Üç cihaz testi', password});
    assert.equal(setup.status, 201);
    const organizationCode = setup.data.organizationCode;
    let cookie = setup.cookie;
    let csrf = setup.data.csrfToken;
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    assert.equal((await post('/api/staff', {displayName: 'A'}, cookie)).status, 403);
    if (lanAddress) {
      await assert.rejects(fetch(`http://${lanAddress}:${hub.adminPort}/api/session`,
        {signal: AbortSignal.timeout(1500)}));
    }
    const staffA = await post('/api/staff', {displayName: 'A'}, cookie, csrf);
    const staffB = await post('/api/staff', {displayName: 'B'}, cookie, csrf);
    assert.equal(staffA.status, 201);
    assert.equal(staffB.status, 201);
    const assignedUserIds = [staffA.data.userId, staffB.data.userId];
    const gibCode = (await post('/api/accounts', {portal: 'GİB', label: 'Genel A',
      assignedUserIds}, cookie, csrf)).data.account.code;
    const otherCode = (await post('/api/accounts', {portal: 'GİB', label: 'Genel B',
      assignedUserIds}, cookie, csrf)).data.account.code;
    const sgkCode = (await post('/api/accounts', {portal: 'SGK', label: 'Bordro A',
      assignedUserIds}, cookie, csrf)).data.account.code;
    const bad = await person(wsAddress, hub.wsPort, 'x'.repeat(43), staffA.data.staffToken);
    sockets.push(bad.ws);
    assert.equal(bad.hello.code, 'AUTH_FAILED');
    const a = await person(wsAddress, hub.wsPort, organizationCode, staffA.data.staffToken);
    const b = await person(wsAddress, hub.wsPort, organizationCode, staffB.data.staffToken);
    sockets.push(a.ws, b.ws);
    assert.equal(a.hello.status, 'ok');
    assert.equal(b.hello.status, 'ok');
    assert.equal((await act(a, 'ACQUIRE', 'GİB', gibCode)).status, 'held');
    assert.equal((await act(b, 'ACQUIRE', 'GİB', gibCode)).status, 'queued');
    assert.equal((await act(b, 'ACQUIRE', 'GİB', otherCode)).status, 'held');
    assert.equal((await act(b, 'RELEASE', 'GİB', otherCode)).status, 'released');
    assert.equal((await act(b, 'ACQUIRE', 'SGK', sgkCode)).status, 'held');
    assert.equal((await act(a, 'ACQUIRE', 'SGK', sgkCode)).status, 'queued');
    const adminState = async () => (await (await fetch(`${base}/api/state`,
      {headers: {Cookie: cookie}})).json());
    let state = await adminState();
    assert.equal(lock(state, 'GİB', gibCode).holder.userId, staffA.data.userId);
    assert.deepEqual(lock(state, 'GİB', gibCode).queue.map((entry) => entry.userId),
      [staffB.data.userId]);
    assert.equal(lock(state, 'SGK', sgkCode).holder.userId, staffB.data.userId);
    assert.deepEqual(lock(state, 'SGK', sgkCode).queue.map((entry) => entry.userId),
      [staffA.data.userId]);
    assert.equal((await act(a, 'RELEASE', 'GİB', gibCode)).status, 'released');
    assert.equal((await act(b, 'RELEASE', 'SGK', sgkCode)).status, 'released');
    assert.equal((await act(a, 'ACQUIRE', 'GİB', gibCode)).status, 'queued');
    assert.equal((await act(b, 'ACQUIRE', 'SGK', sgkCode)).status, 'queued');
    state = await adminState();
    assert.equal(lock(state, 'GİB', gibCode).holder.userId, staffB.data.userId);
    assert.equal(lock(state, 'SGK', sgkCode).holder.userId, staffA.data.userId);
    clock.advance(PRESENCE_INTERVAL_MS - 1);
    state = await adminState();
    assert.equal(lock(state, 'GİB', gibCode).holder.confirmationDeadlineAt, null);
    clock.advance(1);
    const confirmation = await a.messages.until((value) => value.type === 'STATE' &&
      Number.isFinite(lock(value, 'SGK', sgkCode)?.holder.confirmationDeadlineAt));
    assert.equal(lock(confirmation, 'SGK', sgkCode).holder.confirmationDeadlineAt,
      clock.now() + CONFIRMATION_WINDOW_MS);
    assert.equal(confirmation.serverTime, clock.now());
    clock.advance(CONFIRMATION_WINDOW_MS - 1);
    assert.equal((await act(a, 'CONFIRM', 'SGK', sgkCode)).status, 'confirmed');
    clock.advance(1);
    const transferred = await a.messages.until((value) => value.type === 'STATE' &&
      value.serverTime === clock.now() &&
      lock(value, 'GİB', gibCode)?.holder.userId === staffA.data.userId &&
      lock(value, 'SGK', sgkCode)?.holder.userId === staffA.data.userId);
    assert.equal(lock(transferred, 'SGK', sgkCode).holder.userId, staffA.data.userId);
    const unlocked = await post('/api/force-unlock', {portal: 'SGK', accountCode: sgkCode,
      requestId: randomUUID()}, cookie, csrf);
    assert.equal(unlocked.data.status, 'unlocked');
    state = await adminState();
    assert.equal(lock(state, 'SGK', sgkCode).holder.userId, staffB.data.userId);
    assert.equal((await act(b, 'ACQUIRE', 'GİB', gibCode)).status, 'queued');
    const kicked = await post('/api/kick', {userId: staffB.data.userId,
      requestId: randomUUID()}, cookie, csrf);
    assert.equal(kicked.data.status, 'kicked');
    assert.equal((await b.messages.until((value) => value.type === 'ERROR' &&
      value.code === 'KICKED')).code, 'KICKED');
    state = await adminState();
    assert.equal(lock(state, 'GİB', gibCode).queue.length, 0);
    assert.equal(lock(state, 'SGK', sgkCode), undefined);
    const banned = await person(wsAddress, hub.wsPort, organizationCode, staffB.data.staffToken);
    sockets.push(banned.ws);
    assert.equal(banned.hello.code, 'KICKED');
    assert.equal((await post('/api/readmit', {userId: staffB.data.userId,
      requestId: randomUUID()}, cookie, csrf)).data.status, 'readmitted');
    const b2 = await person(wsAddress, hub.wsPort, organizationCode, staffB.data.staffToken);
    sockets.push(b2.ws);
    assert.equal((await act(b2, 'ACQUIRE', 'GİB', gibCode)).status, 'queued');
    a.ws.terminate();
    await b2.messages.until((value) => value.type === 'STATE' &&
      lock(value, 'GİB', gibCode)?.holder.connected === false);
    const a2 = await person(wsAddress, hub.wsPort, organizationCode,
      staffA.data.staffToken, a.hello.hubId);
    sockets.push(a2.ws);
    assert.equal(a2.hello.stateReset, false);
    assert.equal((await act(a2, 'ACQUIRE', 'GİB', gibCode)).status, 'held');
    a2.ws.terminate();
    await b2.messages.until((value) => value.type === 'STATE' &&
      lock(value, 'GİB', gibCode)?.holder.connected === false);
    clock.advance(RECONNECT_GRACE_MS - 1);
    assert.equal(lock(await adminState(), 'GİB', gibCode).holder.userId, staffA.data.userId);
    clock.advance(1);
    await b2.messages.until((value) => value.type === 'STATE' &&
      lock(value, 'GİB', gibCode)?.holder.userId === staffB.data.userId);
    await hub.close();
    hub = null;
    hub = await startHub({configPath, wsHost: '0.0.0.0', wsPort: 0,
      adminPort: 0, stateClock: clock});
    base = `http://127.0.0.1:${hub.adminPort}`;
    const login = await post('/api/login', {password});
    assert.equal(login.status, 200);
    cookie = login.cookie;
    csrf = login.data.csrfToken;
    state = await adminState();
    assert.deepEqual(state.locks, []);
    assert.equal(state.staff.length, 2);
    const afterRestart = await person(wsAddress, hub.wsPort, organizationCode,
      staffB.data.staffToken, b2.hello.hubId);
    sockets.push(afterRestart.ws);
    assert.equal(afterRestart.hello.stateReset, true);
    afterRestart.ws.send(JSON.stringify({type: 'STATE'}));
    assert.deepEqual((await afterRestart.messages.until((value) => value.type === 'STATE')).locks,
      []);
  });
