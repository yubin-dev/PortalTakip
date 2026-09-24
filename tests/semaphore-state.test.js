import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSemaphoreState, PRESENCE_INTERVAL_MS, CONFIRMATION_WINDOW_MS,
  RECONNECT_GRACE_MS,
} from '../src/core/semaphore-state.js';

function clock() {
  let time = 1_000;
  let nextId = 0;
  const tasks = new Map();
  return {
    now: () => time,
    setTimeout: (fn, delay) => {
      const id = ++nextId;
      tasks.set(id, {at: time + delay, fn});
      return id;
    },
    clearTimeout: (id) => tasks.delete(id),
    advance(ms) {
      const target = time + ms;
      for (;;) {
        const due = [...tasks].filter(([, task]) => task.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        time = due[1].at;
        tasks.delete(due[0]);
        due[1].fn();
      }
      time = target;
    },
  };
}

const key = (accountCode = 'random-A', organizationId = 'org-1', portal = 'GİB') =>
  ({organizationId, portal, accountCode});
const user = (userId, requestId, accountCode = 'random-A', organizationId = 'org-1', portal = 'GİB') =>
  ({...key(accountCode, organizationId, portal), userId, socketId: `socket-${userId}`,
    displayName: `Name ${userId}`, requestId});
const admin = (requestId, accountCode = 'random-A', organizationId = 'org-1') =>
  ({...key(accountCode, organizationId), requestId,
    adminContext: {authorized: true, organizationId}});

test('composite key isolates organizations, portals, and accounts; FIFO is per key', () => {
  const state = createSemaphoreState(clock());
  assert.equal(state.acquire({...user('a', '1'), accountCode: ''}).code, 'EMPTY_ACCOUNT_CODE');
  assert.equal(state.acquire(user('a', '1')).status, 'held');
  assert.equal(state.acquire(user('b', '2')).position, 1);
  assert.equal(state.acquire(user('c', '3')).position, 2);
  assert.equal(state.acquire(user('d', '4', 'random-B')).status, 'held');
  assert.equal(state.acquire(user('e', '5', 'random-A', 'org-2')).status, 'held');
  assert.equal(state.acquire(user('f', '6', 'random-A', 'org-1', 'SGK')).status, 'held');
  assert.equal(state.acquire(user('b', '2')).position, 1);
  assert.equal(state.release(user('a', '7')).status, 'released');
  const lock = state.getSnapshot(key()).locks[0];
  assert.equal(lock.holder.userId, 'b');
  assert.deepEqual(lock.queue.map((entry) => entry.userId), ['c']);
  assert.equal(state.release(user('a', '7')).status, 'released');
  assert.equal(state.getSnapshot(key()).locks[0].holder.userId, 'b');
  assert.equal(state.cancel(user('c', '8')).status, 'cancelled');
  assert.equal(state.cancel(user('c', '9')).status, 'noop');
});

test('A, B, C keep FIFO order when B leaves the queue', () => {
  const state = createSemaphoreState(clock());
  assert.deepEqual(state.acquire(user('A', 'a1')),
    {ok: true, status: 'held', key: key(), position: 0});
  assert.equal(state.acquire(user('B', 'b1')).position, 1);
  assert.equal(state.acquire(user('C', 'c1')).position, 2);
  assert.equal(state.acquire(user('B', 'b1')).position, 1);
  assert.equal(state.cancel(user('B', 'b2')).status, 'cancelled');
  assert.equal(state.cancel(user('B', 'b2')).status, 'cancelled');
  assert.deepEqual(state.getSnapshot(key()).locks[0].queue.map((entry) => entry.userId), ['C']);
  assert.equal(state.release(user('A', 'a2')).status, 'released');
  assert.equal(state.getSnapshot(key()).locks[0].holder.userId, 'C');
  assert.equal(state.release(user('A', 'a2')).status, 'released');
  assert.equal(state.getSnapshot(key()).locks[0].holder.userId, 'C');
});

test('A, B, C receive the same lock in arrival order', () => {
  const state = createSemaphoreState(clock());
  state.acquire(user('A', 'a1'));
  state.acquire(user('B', 'b1'));
  state.acquire(user('C', 'c1'));
  assert.equal(state.release(user('A', 'a2')).status, 'released');
  assert.equal(state.getSnapshot(key()).locks[0].holder.userId, 'B');
  assert.equal(state.release(user('B', 'b2')).status, 'released');
  assert.equal(state.getSnapshot(key()).locks[0].holder.userId, 'C');
  assert.equal(state.release(user('C', 'c2')).status, 'released');
  assert.deepEqual(state.getSnapshot(key()).locks, []);
});

test('presence request opens at exactly 15 minutes; confirmation at 59,999 ms resets the clock', () => {
  const timer = clock();
  const events = [];
  const state = createSemaphoreState({...timer, onEvent: (event) => events.push(event)});
  state.acquire(user('a', '1'));
  state.acquire(user('b', '2'));
  assert.equal(state.confirmPresence(user('a', '3')).status, 'noop');
  timer.advance(PRESENCE_INTERVAL_MS - 1);
  assert.equal(events.filter((event) => event.type === 'confirmation_required').length, 0);
  assert.equal(state.getSnapshot(key()).locks[0].holder.confirmationDeadlineAt, null);
  timer.advance(1);
  const prompts = () => events.filter((event) => event.type === 'confirmation_required');
  assert.equal(prompts().length, 1);
  assert.equal(prompts()[0].deadlineAt, timer.now() + CONFIRMATION_WINDOW_MS);
  timer.advance(CONFIRMATION_WINDOW_MS - 1);
  assert.equal(state.confirmPresence(user('a', '4')).status, 'confirmed');
  assert.equal(state.confirmPresence(user('a', '5')).status, 'noop');
  timer.advance(1);
  assert.equal(state.getSnapshot(key()).locks[0].holder.userId, 'a');
  timer.advance(PRESENCE_INTERVAL_MS - 2);
  assert.equal(prompts().length, 1);
  timer.advance(1);
  assert.equal(prompts().length, 2);
  assert.equal(state.getSnapshot(key()).locks[0].holder.userId, 'a');
});

test('at exactly 60 seconds without confirmation the lock passes to the next user', () => {
  const timer = clock();
  const state = createSemaphoreState(timer);
  state.acquire(user('a', '1'));
  state.acquire(user('b', '2'));
  timer.advance(PRESENCE_INTERVAL_MS + CONFIRMATION_WINDOW_MS - 1);
  assert.equal(state.getSnapshot(key()).locks[0].holder.userId, 'a');
  timer.advance(1);
  assert.equal(state.getSnapshot(key()).locks[0].holder.userId, 'b');
  assert.equal(state.confirmPresence(user('a', '3')).code, 'NOT_HOLDER');
});

test('disconnect preserves positions for 30 seconds; reconnect uses the same user on a new socket', () => {
  const timer = clock();
  const state = createSemaphoreState(timer);
  state.acquire(user('a', '1'));
  state.acquire(user('b', '2'));
  assert.equal(state.disconnect({socketId: 'socket-a'}).affected, 1);
  assert.equal(state.getSnapshot(key()).locks[0].holder.connected, false);
  timer.advance(RECONNECT_GRACE_MS - 1);
  assert.equal(state.acquire({...user('a', '3'), socketId: 'socket-a-new'}).status, 'held');
  assert.equal(state.getSnapshot(key()).locks[0].holder.connected, true);
  assert.equal(state.disconnect({socketId: 'socket-a'}).status, 'noop');
  assert.equal(state.disconnect({socketId: 'socket-a-new'}).status, 'disconnected');
  timer.advance(RECONNECT_GRACE_MS);
  assert.equal(state.getSnapshot(key()).locks[0].holder.userId, 'b');
  assert.equal(state.acquire(user('a', '1')).code, 'NOT_CONNECTED');
});

test('reconnect at the exact 30-second boundary does not restore the old lock', () => {
  const timer = clock();
  const state = createSemaphoreState(timer);
  state.acquire(user('a', '1'));
  state.acquire(user('b', '2'));
  state.disconnect({socketId: 'socket-a'});
  timer.advance(RECONNECT_GRACE_MS);
  assert.equal(state.getSnapshot(key()).locks[0].holder.userId, 'b');
  assert.equal(state.acquire({...user('a', '3'), socketId: 'socket-a-new'}).status, 'queued');
  assert.deepEqual(state.getSnapshot(key()).locks[0].queue.map((entry) => entry.userId), ['a']);
});

test('disconnected queued users are removed; force unlock and kick require verified context', () => {
  const timer = clock();
  const state = createSemaphoreState(timer);
  state.acquire(user('a', '1'));
  state.acquire(user('b', '2'));
  state.acquire(user('c', '3'));
  assert.equal(state.forceUnlock({...admin('4'), adminContext: {authorized: false, organizationId: 'org-1'}}).code, 'ADMIN_REQUIRED');
  assert.equal(state.kick({...admin('kick-denied'), userId: 'a',
    adminContext: {authorized: false, organizationId: 'org-1'}}).code, 'ADMIN_REQUIRED');
  assert.equal(state.getSnapshot(key()).locks[0].holder.userId, 'a');
  assert.equal(state.disconnect({socketId: 'socket-b'}).status, 'disconnected');
  timer.advance(RECONNECT_GRACE_MS);
  assert.deepEqual(state.getSnapshot(key()).locks[0].queue.map((entry) => entry.userId), ['c']);
  assert.equal(state.forceUnlock(admin('5')).status, 'unlocked');
  assert.equal(state.getSnapshot(key()).locks[0].holder.userId, 'c');
  assert.equal(state.forceUnlock(admin('5')).status, 'unlocked');
  assert.equal(state.getSnapshot(key()).locks[0].holder.userId, 'c');
  assert.equal(state.kick({...admin('6'), userId: 'c'}).status, 'kicked');
  assert.equal(state.getSnapshot(key()).locks.length, 0);
  assert.equal(state.kick({...admin('7'), userId: 'c'}).status, 'noop');
});

test('request IDs cannot be reused for a different operation', () => {
  const state = createSemaphoreState(clock());
  assert.equal(state.acquire(user('a', 'same')).status, 'held');
  assert.equal(state.release(user('a', 'same')).code, 'REQUEST_ID_CONFLICT');
  assert.equal(state.getSnapshot(key()).locks[0].holder.userId, 'a');
});

test('display names do not identify users; admin actions stay within their organization', () => {
  const state = createSemaphoreState(clock());
  state.acquire({...user('a', '1'), displayName: 'Same name'});
  state.acquire({...user('b', '2'), displayName: 'Same name'});
  state.acquire(user('a', '3', 'random-B'));
  const view = state.getSnapshot(key());
  view.locks[0].holder.displayName = 'changed in snapshot';
  assert.equal(state.getSnapshot(key()).locks[0].holder.displayName, 'Same name');
  assert.equal(state.acquire({...user('c', '4'), socketId: 'socket-a'}).code, 'SOCKET_IN_USE');
  assert.equal(state.forceUnlock({...admin('5'),
    adminContext: {authorized: true, organizationId: 'org-2'}}).code, 'ADMIN_REQUIRED');
  assert.equal(state.kick({...admin('6'), userId: 'a'}).affected, 2);
  assert.equal(state.getSnapshot(key()).locks[0].holder.userId, 'b');
  assert.equal(state.getSnapshot(key('random-B')).locks.length, 0);
});

test('kick invalidates the socket and bans the user until admin readmission', () => {
  const events = [];
  const state = createSemaphoreState({...clock(), onEvent: (event) => events.push(event)});
  assert.equal(state.acquire(user('a', 'kick-acquire')).status, 'held');
  assert.equal(state.acquire(user('b', 'kick-wait')).status, 'queued');
  assert.equal(state.acquire(user('a', 'kick-other-account', 'random-B')).status, 'held');
  assert.equal(state.acquire({...user('a', 'other-org', 'random-A', 'org-2'),
    socketId: 'socket-a-org-2'}).status, 'held');

  const command = {...admin('kick-command'), userId: 'a'};
  assert.deepEqual(state.kick(command), {ok: true, status: 'kicked', affected: 2});
  assert.equal(state.getSnapshot(key()).locks[0].holder.userId, 'b');
  assert.equal(state.getSnapshot(key('random-B')).locks.length, 0);
  assert.equal(state.getSnapshot(key('random-A', 'org-2')).locks[0].holder.userId, 'a');
  assert.deepEqual(events.filter((event) => event.type === 'socket_kicked'), [
    {type: 'socket_kicked', organizationId: 'org-1', userId: 'a', socketId: 'socket-a'},
  ]);
  assert.equal(JSON.stringify(state.getSnapshot()).includes('socketId'), false);
  assert.equal(state.disconnect({socketId: 'socket-a'}).status, 'noop');
  assert.equal(state.acquire(user('a', 'kick-retry-old')).code, 'KICKED');
  assert.equal(state.acquire({...user('a', 'kick-retry-new'),
    socketId: 'socket-a-new'}).code, 'KICKED');
  assert.equal(state.release(user('a', 'kick-release')).code, 'KICKED');
  assert.equal(state.kick(command).status, 'kicked');
  assert.equal(events.filter((event) => event.type === 'socket_kicked').length, 1);

  const readmit = {...admin('readmit-command'), userId: 'a'};
  assert.equal(state.readmitUser({...readmit, adminContext: {authorized: false,
    organizationId: 'org-1'}}).code, 'ADMIN_REQUIRED');
  assert.equal(state.readmitUser(readmit).status, 'readmitted');
  assert.equal(state.readmitUser(readmit).status, 'readmitted');
  assert.equal(state.kick(command).status, 'kicked');
  assert.equal(state.getSnapshot(key()).locks[0].holder.userId, 'b');
  assert.equal(state.acquire({...user('a', 'after-readmit', 'random-B'),
    socketId: 'socket-a-new'}).status, 'held');
});

test('kicking a disconnected user cancels the grace period without a live socket event', () => {
  const timer = clock();
  const events = [];
  const state = createSemaphoreState({...timer, onEvent: (event) => events.push(event)});
  state.acquire(user('a', '1'));
  state.acquire(user('b', '2'));
  state.disconnect({socketId: 'socket-a'});
  assert.equal(state.kick({...admin('3'), userId: 'a'}).status, 'kicked');
  assert.equal(state.getSnapshot(key()).locks[0].holder.userId, 'b');
  assert.equal(events.some((event) => event.type === 'socket_kicked'), false);
  assert.equal(state.readmitUser({...admin('4'), userId: 'a'}).status, 'readmitted');
  assert.equal(state.acquire({...user('a', '5'), socketId: 'socket-a-new'}).status, 'queued');
  timer.advance(RECONNECT_GRACE_MS);
  assert.deepEqual(state.getSnapshot(key()).locks[0].queue.map((entry) => entry.userId), ['a']);
});
