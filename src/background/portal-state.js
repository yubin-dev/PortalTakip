const accountPattern = /^(?=.*[A-Za-z_-])[A-Za-z0-9_-]{16,128}$/;

export function validAccountCode(value) {
  return typeof value === 'string' && accountPattern.test(value);
}

export function portalForUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    const hostname = url.hostname.toLowerCase();
    if (hostname === 'gib.gov.tr' || hostname.endsWith('.gib.gov.tr')) return 'GİB';
    if (hostname === 'sgk.gov.tr' || hostname.endsWith('.sgk.gov.tr')) return 'SGK';
  } catch { /* malformed URL */ }
  return null;
}

/** Only a Hub STATE snapshot may establish held/queued/busy/empty. */
export function accountView({phase, snapshot, userId, portal, account}) {
  const base = {portal, accountId: account?.id ?? null,
    accountLabel: account?.label ?? null, accountCode: account?.code ?? null,
    holderName: null, queuePosition: null, confirmationDeadlineAt: null,
    confirmationRemainingMs: null};
  if (phase === 'retrying' || phase === 'connecting') {
    return {...base, mode: 'reconnecting'};
  }
  if (phase !== 'connected') return {...base, mode: 'offline'};
  if (!account) return {...base, mode: 'accountRequired'};
  if (!snapshot || !userId) return {...base, mode: 'syncing'};
  const lock = snapshot.locks?.find((entry) =>
    entry?.key?.portal === portal && entry.key.accountCode === account.code);
  if (!lock?.holder) return {...base, mode: 'empty'};
  if (lock.holder.userId === userId) {
    const deadline = Number.isFinite(lock.holder.confirmationDeadlineAt) ?
      lock.holder.confirmationDeadlineAt : null;
    const serverTime = Number.isFinite(snapshot.serverTime) ? snapshot.serverTime : null;
    return {...base, mode: 'mine', holderName: lock.holder.displayName ?? null,
      confirmationDeadlineAt: deadline,
      confirmationRemainingMs: deadline !== null && serverTime !== null ?
        Math.max(0, deadline - serverTime) : null};
  }
  const position = lock.queue?.findIndex((entry) => entry.userId === userId) ?? -1;
  if (position >= 0) {
    return {...base, mode: 'queued', holderName: lock.holder.displayName ?? null,
      queuePosition: position + 1};
  }
  return {...base, mode: 'busy', holderName: lock.holder.displayName ?? null};
}

export function becameHolder(previous, next, userId) {
  if (!previous || !next || !userId || previous.hubId !== next.hubId) return [];
  const granted = [];
  for (const lock of next.locks ?? []) {
    if (lock.holder?.userId !== userId) continue;
    const old = previous.locks?.find((entry) => entry.key?.portal === lock.key?.portal &&
      entry.key.accountCode === lock.key.accountCode);
    if (old?.queue?.some((entry) => entry.userId === userId)) {
      granted.push({portal: lock.key.portal, accountCode: lock.key.accountCode,
        acquiredAt: lock.holder.acquiredAt});
    }
  }
  return granted;
}
