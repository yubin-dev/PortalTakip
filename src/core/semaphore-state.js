/**
 * RAM-only semaphore state for the Hub. The Hub authenticates identities and
 * administrator contexts before calling this module; no socket or Chrome API
 * is used here.
 *
 * @typedef {{organizationId: string, portal: 'GİB'|'SGK', accountCode: string}} Key
 * @typedef {{ok: false, code: string}} Failure
 * @typedef {{ok: true, status: 'held'|'queued'|'stale'|'released'|'cancelled'|
 *   'disconnected'|'confirmed'|'unlocked'|'kicked'|'readmitted'|'noop',
 *   key?: Key, position?: number, affected?: number}} Success
 * @typedef {Success|Failure} OperationResult
 * @typedef {{userId: string, displayName: string, connected: boolean,
 *   enqueuedAt: number, acquiredAt: number|null, lastConfirmedAt: number|null,
 *   confirmationDeadlineAt: number|null}} SnapshotEntry
 * @typedef {{key: Key, holder: SnapshotEntry|null, queue: SnapshotEntry[]}} LockSnapshot
 * @typedef {{locks: LockSnapshot[]}} Snapshot
 */

export const PRESENCE_INTERVAL_MS = 15 * 60 * 1000;
export const CONFIRMATION_WINDOW_MS = 60 * 1000;
export const RECONNECT_GRACE_MS = 30 * 1000;
export const REQUEST_HISTORY_MS = 24 * 60 * 60 * 1000;
export const MAX_REQUEST_HISTORY = 100_000;

const own = (value) => typeof value === 'string' ? value.trim() : '';
const keyId = (key) => JSON.stringify([key.organizationId, key.portal, key.accountCode]);
const userKey = (organizationId, userId) => JSON.stringify([organizationId, userId]);

/**
 * @param {{now?: () => number, setTimeout?: typeof setTimeout,
 *   clearTimeout?: typeof clearTimeout, onEvent?: (event: object) => void,
 *   reconnectGraceMs?: number}} options
 */
export function createSemaphoreState(options = {}) {
  const now = options.now ?? Date.now;
  const schedule = options.setTimeout ?? globalThis.setTimeout;
  const unschedule = options.clearTimeout ?? globalThis.clearTimeout;
  const onEvent = options.onEvent ?? (() => {});
  const reconnectGraceMs = options.reconnectGraceMs ?? RECONNECT_GRACE_MS;
  if (!Number.isSafeInteger(reconnectGraceMs) || reconnectGraceMs < 0) {
    throw new RangeError('reconnectGraceMs must be a nonnegative integer');
  }

  const locks = new Map();
  const sessions = new Map(); // organization + user -> {socketId, connected, timer}
  const sockets = new Map(); // socketId -> organization + user
  const kickedUsers = new Set(); // organization + user; cleared only by readmitUser
  const completedRequests = new Map(); // bounded successful request deduplication
  let eventBatch = null;

  function dispatchEvent(event) {
    if (eventBatch !== null) {
      eventBatch.push(event);
      return;
    }
    // An observer must not undo a completed state transition.
    try { onEvent(event); } catch { /* observer failure */ }
  }

  function emit(type, key, extra = {}) {
    dispatchEvent({type, key: {...key}, ...extra});
  }

  function emitInternal(event) {
    // This event is for the Hub only. Never forward its socketId to clients.
    dispatchEvent(event);
  }

  function withBatchedEvents(operation) {
    const previousBatch = eventBatch;
    const events = [];
    eventBatch = events;
    try {
      return operation();
    } finally {
      eventBatch = previousBatch;
      for (const event of events) dispatchEvent(event);
    }
  }

  function parseKey(input) {
    const key = {
      organizationId: own(input?.organizationId),
      portal: own(input?.portal),
      accountCode: own(input?.accountCode),
    };
    if (!key.organizationId) return {error: 'INVALID_ORGANIZATION'};
    if (key.portal !== 'GİB' && key.portal !== 'SGK') return {error: 'INVALID_PORTAL'};
    if (!key.accountCode) return {error: 'EMPTY_ACCOUNT_CODE'};
    return {key: Object.freeze(key)};
  }

  function lockFor(key) {
    const id = keyId(key);
    let lock = locks.get(id);
    if (!lock) {
      lock = {key, holder: null, queue: [], timer: null};
      locks.set(id, lock);
    }
    return lock;
  }

  function clearLockTimer(lock) {
    if (lock.timer !== null) unschedule(lock.timer);
    lock.timer = null;
  }

  function scheduleHolder(lock) {
    clearLockTimer(lock);
    if (!lock.holder) return;
    const due = lock.holder.confirmationDeadlineAt ??
      lock.holder.lastConfirmedAt + PRESENCE_INTERVAL_MS;
    lock.timer = schedule(() => {
      lock.timer = null;
      tickLock(lock);
    }, Math.max(0, due - now()));
  }

  function grantNext(lock, eventType, previousUserId) {
    clearLockTimer(lock);
    lock.holder = lock.queue.shift() ?? null;
    if (lock.holder) {
      lock.holder.acquiredAt = now();
      lock.holder.lastConfirmedAt = now();
      lock.holder.confirmationDeadlineAt = null;
      scheduleHolder(lock);
    } else {
      locks.delete(keyId(lock.key));
    }
    if (eventType) emit(eventType, lock.key, {userId: previousUserId});
    if (lock.holder) emit('granted', lock.key, {userId: lock.holder.userId});
  }

  function tickLock(lock) {
    const holder = lock.holder;
    if (!holder) return;
    const current = now();
    let opened = false;
    if (holder.confirmationDeadlineAt === null) {
      const due = holder.lastConfirmedAt + PRESENCE_INTERVAL_MS;
      if (current < due) { scheduleHolder(lock); return; }
      holder.confirmationDeadlineAt = due + CONFIRMATION_WINDOW_MS;
      opened = true;
    }
    if (current >= holder.confirmationDeadlineAt) {
      grantNext(lock, 'expired', holder.userId);
    } else {
      scheduleHolder(lock);
      if (opened) {
        emit('confirmation_required', lock.key, {
          userId: holder.userId, deadlineAt: holder.confirmationDeadlineAt,
        });
      }
    }
  }

  function sweep() {
    for (const lock of [...locks.values()]) tickLock(lock);
    for (const [id, session] of [...sessions]) {
      if (!session.connected && now() >= session.disconnectedAt + reconnectGraceMs) {
        expireSession(id, session);
      }
    }
  }

  function expireSession(id, session) {
    if (sessions.get(id) !== session || session.connected) return;
    if (session.timer !== null) unschedule(session.timer);
    session.timer = null;
    for (const lock of [...locks.values()]) {
      removeUserFromLock(lock, session.userId, session.organizationId, 'disconnect_expired');
    }
    sessions.delete(id);
  }

  function removeUserFromLock(lock, userId, organizationId, reason) {
    if (lock.key.organizationId !== organizationId) return 0;
    let removed = 0;
    const before = lock.queue.length;
    lock.queue = lock.queue.filter((entry) => entry.userId !== userId);
    removed += before - lock.queue.length;
    if (lock.holder?.userId === userId) {
      removed++;
      grantNext(lock, reason, userId);
    } else if (removed) {
      emit(reason, lock.key, {userId});
    }
    return removed;
  }

  function bind(input, key) {
    const userId = own(input?.userId);
    const socketId = own(input?.socketId);
    const displayName = own(input?.displayName);
    if (!userId || !socketId || !displayName) return {error: 'INVALID_IDENTITY'};
    const id = userKey(key.organizationId, userId);
    if (kickedUsers.has(id)) return {error: 'KICKED'};
    if (sockets.has(socketId) && sockets.get(socketId) !== id) return {error: 'SOCKET_IN_USE'};
    let session = sessions.get(id);
    if (session?.connected && session.socketId !== socketId) return {error: 'USER_CONNECTED'};
    if (!session) {
      session = {organizationId: key.organizationId, userId, socketId,
        connected: true, disconnectedAt: null, timer: null};
      sessions.set(id, session);
    } else if (!session.connected) {
      if (now() >= session.disconnectedAt + reconnectGraceMs) {
        expireSession(id, session);
        return bind(input, key);
      }
      if (session.timer !== null) unschedule(session.timer);
      session.timer = null;
      session.socketId = socketId;
      session.connected = true;
      session.disconnectedAt = null;
      for (const lock of locks.values()) {
        if (lock.key.organizationId !== key.organizationId) continue;
        for (const entry of [lock.holder, ...lock.queue]) {
          if (entry?.userId === userId) {
            entry.displayName = displayName;
            emit('reconnected', lock.key, {userId});
          }
        }
      }
    }
    sockets.set(socketId, id);
    return {userId, socketId, displayName};
  }

  function identify(input, key) {
    const userId = own(input?.userId);
    const socketId = own(input?.socketId);
    if (!userId || !socketId) return {error: 'INVALID_IDENTITY'};
    const id = userKey(key.organizationId, userId);
    if (kickedUsers.has(id)) return {error: 'KICKED'};
    const session = sessions.get(id);
    if (!session?.connected || session.socketId !== socketId ||
        sockets.get(socketId) !== id) {
      return {error: 'NOT_CONNECTED'};
    }
    return {userId};
  }

  function adminAuthorized(input, key) {
    const context = input?.adminContext;
    return context?.authorized === true &&
      own(context.organizationId) === key.organizationId;
  }

  /** @returns {OperationResult} */
  function acquire(input) {
    sweep();
    const parsed = parseKey(input);
    if (parsed.error) return {ok: false, code: parsed.error};
    const identity = bind(input, parsed.key);
    if (identity.error) return {ok: false, code: identity.error};
    const lock = lockFor(parsed.key);
    if (lock.holder?.userId === identity.userId) {
      return {ok: true, status: 'held', key: parsed.key, position: 0};
    }
    const index = lock.queue.findIndex((entry) => entry.userId === identity.userId);
    if (index >= 0) return {ok: true, status: 'queued', key: parsed.key, position: index + 1};
    const entry = {userId: identity.userId, displayName: identity.displayName,
      enqueuedAt: now(), acquiredAt: null, lastConfirmedAt: null,
      confirmationDeadlineAt: null};
    if (!lock.holder) {
      lock.holder = entry;
      entry.acquiredAt = now();
      entry.lastConfirmedAt = now();
      scheduleHolder(lock);
      emit('granted', lock.key, {userId: entry.userId});
      return {ok: true, status: 'held', key: parsed.key, position: 0};
    }
    lock.queue.push(entry);
    emit('queued', lock.key, {userId: entry.userId, position: lock.queue.length});
    return {ok: true, status: 'queued', key: parsed.key, position: lock.queue.length};
  }

  /** @returns {OperationResult} */
  function release(input) {
    sweep();
    const parsed = parseKey(input);
    if (parsed.error) return {ok: false, code: parsed.error};
    const identity = identify(input, parsed.key);
    if (identity.error) return {ok: false, code: identity.error};
    const lock = locks.get(keyId(parsed.key));
    if (!lock || lock.holder?.userId !== identity.userId) {
      return {ok: true, status: 'noop', key: parsed.key};
    }
    grantNext(lock, 'released', identity.userId);
    return {ok: true, status: 'released', key: parsed.key};
  }

  /** @returns {OperationResult} */
  function cancel(input) {
    sweep();
    const parsed = parseKey(input);
    if (parsed.error) return {ok: false, code: parsed.error};
    const identity = identify(input, parsed.key);
    if (identity.error) return {ok: false, code: identity.error};
    const lock = locks.get(keyId(parsed.key));
    if (!lock) return {ok: true, status: 'noop', key: parsed.key};
    const index = lock.queue.findIndex((entry) => entry.userId === identity.userId);
    if (index < 0) return {ok: true, status: 'noop', key: parsed.key};
    lock.queue.splice(index, 1);
    emit('cancelled', lock.key, {userId: identity.userId});
    return {ok: true, status: 'cancelled', key: parsed.key};
  }

  /** @returns {OperationResult} */
  function disconnect(input) {
    sweep();
    const socketId = own(input?.socketId);
    if (!socketId) return {ok: false, code: 'INVALID_SOCKET'};
    const id = sockets.get(socketId);
    if (!id) return {ok: true, status: 'noop', affected: 0};
    const session = sessions.get(id);
    sockets.delete(socketId);
    if (!session?.connected || session.socketId !== socketId) {
      return {ok: true, status: 'noop', affected: 0};
    }
    session.connected = false;
    session.disconnectedAt = now();
    session.timer = schedule(() => {
      session.timer = null;
      if (now() >= session.disconnectedAt + reconnectGraceMs) expireSession(id, session);
      else session.timer = schedule(() => expireSession(id, session),
        session.disconnectedAt + reconnectGraceMs - now());
    }, reconnectGraceMs);
    let affected = 0;
    for (const lock of locks.values()) {
      if (lock.key.organizationId !== session.organizationId) continue;
      affected += Number(lock.holder?.userId === session.userId);
      affected += lock.queue.filter((entry) => entry.userId === session.userId).length;
      if (lock.holder?.userId === session.userId ||
          lock.queue.some((entry) => entry.userId === session.userId)) {
        emit('disconnected', lock.key, {userId: session.userId});
      }
    }
    return {ok: true, status: 'disconnected', affected};
  }

  /** @returns {OperationResult} */
  function confirmPresence(input) {
    sweep();
    const parsed = parseKey(input);
    if (parsed.error) return {ok: false, code: parsed.error};
    const identity = identify(input, parsed.key);
    if (identity.error) return {ok: false, code: identity.error};
    const lock = locks.get(keyId(parsed.key));
    if (!lock || lock.holder?.userId !== identity.userId) {
      return {ok: false, code: 'NOT_HOLDER'};
    }
    if (lock.holder.confirmationDeadlineAt === null) {
      return {ok: true, status: 'noop', key: parsed.key};
    }
    lock.holder.lastConfirmedAt = now();
    lock.holder.confirmationDeadlineAt = null;
    scheduleHolder(lock);
    emit('presence_confirmed', lock.key, {userId: identity.userId});
    return {ok: true, status: 'confirmed', key: parsed.key};
  }

  /** Always removes the current holder and atomically grants the next queued user. */
  /** @returns {OperationResult} */
  function forceUnlock(input) {
    sweep();
    const parsed = parseKey(input);
    if (parsed.error) return {ok: false, code: parsed.error};
    if (!adminAuthorized(input, parsed.key)) return {ok: false, code: 'ADMIN_REQUIRED'};
    const lock = locks.get(keyId(parsed.key));
    if (!lock?.holder) return {ok: true, status: 'noop', key: parsed.key};
    grantNext(lock, 'force_unlocked', lock.holder.userId);
    return {ok: true, status: 'unlocked', key: parsed.key};
  }

  /** Bans and removes a user from every lock/queue in one organization. @returns {OperationResult} */
  function kick(input) {
    sweep();
    const organizationId = own(input?.organizationId);
    const userId = own(input?.userId);
    if (!organizationId) return {ok: false, code: 'INVALID_ORGANIZATION'};
    if (!userId) return {ok: false, code: 'INVALID_IDENTITY'};
    if (!adminAuthorized(input, {organizationId})) return {ok: false, code: 'ADMIN_REQUIRED'};
    return withBatchedEvents(() => {
      const id = userKey(organizationId, userId);
      const newlyKicked = !kickedUsers.has(id);
      kickedUsers.add(id);
      const session = sessions.get(id);
      const socketId = session?.connected ? session.socketId : null;
      if (session) {
        if (session.timer !== null) unschedule(session.timer);
        session.timer = null;
        if (sockets.get(session.socketId) === id) sockets.delete(session.socketId);
        sessions.delete(id);
      }
      if (socketId !== null) {
        emitInternal({type: 'socket_kicked', organizationId, userId, socketId});
      }
      let affected = 0;
      for (const lock of [...locks.values()]) {
        affected += removeUserFromLock(lock, userId, organizationId, 'kicked');
      }
      return {ok: true, status: newlyKicked || affected ? 'kicked' : 'noop', affected};
    });
  }

  /** Clears a ban without restoring any old lock or queue position. @returns {OperationResult} */
  function readmitUser(input) {
    sweep();
    const organizationId = own(input?.organizationId);
    const userId = own(input?.userId);
    if (!organizationId) return {ok: false, code: 'INVALID_ORGANIZATION'};
    if (!userId) return {ok: false, code: 'INVALID_IDENTITY'};
    if (!adminAuthorized(input, {organizationId})) return {ok: false, code: 'ADMIN_REQUIRED'};
    const removed = kickedUsers.delete(userKey(organizationId, userId));
    return {ok: true, status: removed ? 'readmitted' : 'noop'};
  }

  /** @returns {Snapshot} */
  function getSnapshot(filter = {}) {
    sweep();
    const organizationId = own(filter.organizationId);
    const portal = own(filter.portal);
    const accountCode = own(filter.accountCode);
    const result = [];
    for (const lock of locks.values()) {
      const key = lock.key;
      if (organizationId && key.organizationId !== organizationId) continue;
      if (portal && key.portal !== portal) continue;
      if (accountCode && key.accountCode !== accountCode) continue;
      const view = (entry) => {
        if (!entry) return null;
        const session = sessions.get(userKey(key.organizationId, entry.userId));
        return {userId: entry.userId, displayName: entry.displayName,
          connected: session?.connected === true, enqueuedAt: entry.enqueuedAt,
          acquiredAt: entry.acquiredAt, lastConfirmedAt: entry.lastConfirmedAt,
          confirmationDeadlineAt: entry.confirmationDeadlineAt};
      };
      result.push({key: {...key}, holder: view(lock.holder), queue: lock.queue.map(view)});
    }
    return {locks: result};
  }

  function isKicked(input) {
    return kickedUsers.has(userKey(own(input?.organizationId), own(input?.userId)));
  }

  /** Stops every scheduled deadline when the owning Hub shuts down. */
  function dispose() {
    for (const lock of locks.values()) clearLockTimer(lock);
    for (const session of sessions.values()) {
      if (session.timer !== null) unschedule(session.timer);
    }
    locks.clear();
    sessions.clear();
    sockets.clear();
    kickedUsers.clear();
    completedRequests.clear();
  }

  function idempotent(name, operation) {
    return (input) => {
      const requestId = own(input?.requestId);
      if (!requestId) return {ok: false, code: 'INVALID_REQUEST_ID'};
      for (const [oldId, entry] of completedRequests) {
        if (now() - entry.at < REQUEST_HISTORY_MS &&
            completedRequests.size <= MAX_REQUEST_HISTORY) break;
        completedRequests.delete(oldId);
      }
      const id = JSON.stringify([own(input?.organizationId), requestId]);
      const fingerprint = JSON.stringify([name, own(input?.organizationId),
        own(input?.portal), own(input?.accountCode), own(input?.userId),
        own(input?.socketId), own(input?.displayName),
        input?.adminContext?.authorized === true,
        own(input?.adminContext?.organizationId)]);
      const previous = completedRequests.get(id);
      if (previous) {
        if (previous.fingerprint !== fingerprint) {
          return {ok: false, code: 'REQUEST_ID_CONFLICT'};
        }
        if (name === 'acquire') {
          sweep();
          const key = parseKey(input).key;
          const identity = identify(input, key);
          if (identity.error) return {ok: false, code: identity.error};
          const lock = locks.get(keyId(key));
          if (lock?.holder?.userId === identity.userId) {
            return {ok: true, status: 'held', key, position: 0};
          }
          const index = lock?.queue.findIndex((entry) => entry.userId === identity.userId) ?? -1;
          return index >= 0 ? {ok: true, status: 'queued', key, position: index + 1} :
            {ok: true, status: 'stale', key};
        }
        return {...previous.result};
      }
      const result = operation(input);
      if (result.ok) completedRequests.set(id, {fingerprint, result: {...result}, at: now()});
      return result;
    };
  }

  return {acquire: idempotent('acquire', acquire),
    release: idempotent('release', release),
    cancel: idempotent('cancel', cancel), disconnect,
    confirmPresence: idempotent('confirmPresence', confirmPresence),
    forceUnlock: idempotent('forceUnlock', forceUnlock),
    kick: idempotent('kick', kick),
    readmitUser: idempotent('readmitUser', readmitUser), getSnapshot, isKicked, dispose};
}
