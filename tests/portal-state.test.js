import test from 'node:test';
import assert from 'node:assert/strict';
import {accountView, becameHolder, portalForUrl, validAccountCode} from
  '../src/background/portal-state.js';

const code = 'shared_A1b2C3d4E5f6';
const account = {id: 'a1', label: 'Ofis hesabı', code};
const base = {phase: 'connected', userId: 'staff-a', portal: 'GİB', account};
const key = {portal: 'GİB', accountCode: code};

test('only official HTTPS GİB and SGK hosts are eligible', () => {
  assert.equal(portalForUrl('https://dijital.gib.gov.tr/page'), 'GİB');
  assert.equal(portalForUrl('https://e.sgk.gov.tr/'), 'SGK');
  assert.equal(portalForUrl('https://gib.gov.tr/'), 'GİB');
  for (const url of ['http://dijital.gib.gov.tr/', 'https://gib.gov.tr.evil.test/',
    'https://notgib.gov.tr/', 'https://example.com/', 'bad-url']) {
    assert.equal(portalForUrl(url), null);
  }
});

test('account code is required and modes derive from authoritative snapshot', () => {
  assert.equal(validAccountCode(code), true);
  assert.equal(validAccountCode(''), false);
  assert.equal(validAccountCode('1234567890123456'), false);
  assert.equal(accountView({...base, account: null, snapshot: {locks: []}}).mode,
    'accountRequired');
  assert.equal(accountView({...base, snapshot: null}).mode, 'syncing');
  assert.equal(accountView({...base, phase: 'retrying', snapshot: {locks: []}}).mode,
    'reconnecting');
  assert.equal(accountView({...base, phase: 'disconnected', snapshot: {locks: []}}).mode,
    'offline');
  assert.equal(accountView({...base, snapshot: {locks: []}}).mode, 'empty');
  const snapshot = {serverTime: 1000, locks: [{key,
    holder: {userId: 'staff-b', displayName: 'B'},
    queue: [{userId: 'staff-a'}, {userId: 'staff-c'}]}]};
  const queued = accountView({...base, snapshot});
  assert.equal(queued.mode, 'queued');
  assert.equal(queued.queuePosition, 1);
  assert.equal(queued.holderName, 'B');
  snapshot.locks[0].queue = [];
  assert.equal(accountView({...base, snapshot}).mode, 'busy');
  snapshot.locks[0].holder = {userId: 'staff-a', displayName: 'A',
    confirmationDeadlineAt: 61_000};
  const mine = accountView({...base, snapshot});
  assert.equal(mine.mode, 'mine');
  assert.equal(mine.confirmationRemainingMs, 60_000);
  snapshot.serverTime = 61_000;
  assert.equal(accountView({...base, snapshot}).confirmationRemainingMs, 0);
});

test('queue-to-holder transition is notified once per matching account', () => {
  const previous = {hubId: 'hub-1', locks: [{key,
    holder: {userId: 'staff-b'}, queue: [{userId: 'staff-a'}]}]};
  const next = {hubId: 'hub-1', locks: [{key,
    holder: {userId: 'staff-a', acquiredAt: 500}, queue: []}]};
  assert.deepEqual(becameHolder(previous, next, 'staff-a'),
    [{portal: 'GİB', accountCode: code, acquiredAt: 500}]);
  assert.deepEqual(becameHolder({...previous, hubId: 'old'}, next, 'staff-a'), []);
  assert.deepEqual(becameHolder(next, next, 'staff-a'), []);
});
