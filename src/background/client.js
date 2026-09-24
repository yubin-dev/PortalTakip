import {validateConnectionInput, validateDeviceConnectionInput,
  validateInvitationLink, websocketUrl} from '../ui/connection-input.js';
import {accountView, becameHolder, portalForUrl, validAccountCode} from './portal-state.js';

let connection = null;
let socket = null;
let generation = 0;
let handshakeTimer = null;
let snapshotTimer = null;
let stateResponseTimer = null;
let heartbeatTimer = null;
let retryTimer = null;
let retryDelayMs = 2000;
let lastHubId = null;
let userId = null;
let snapshot = null;
let snapshotReceivedAt = null;
let lastStateAt = null;
let accountOrganizationId = null;
let accounts = [];
let managedAccounts = [];
let legacyAllowed = false;
const selections = new Map(); // tabId -> accountId; never sent to portal page scripts
const subscribedTabs = new Map(); // tabId -> portal
const pendingRequests = new Map(); // requestId -> {tabId, message, hubId, sentAt, needsReplay}
const RETRY_ALARM = 'portaltakip-reconnect';
const notifiedGrants = new Set();
let status = {phase: 'disconnected', detail: 'Hub bağlantısı yok.'};
let storageChain = Promise.resolve();

function clearRetryAlarm() {
  void chrome.alarms?.clear(RETRY_ALARM).catch(() => {});
}
function scheduleRetryAlarm(delay) {
  // Chrome may delay alarms; this is a recovery wake-up, never a lock timer.
  void chrome.alarms?.create(RETRY_ALARM,
    {when: Date.now() + Math.max(delay, 30_000)}).catch(() => {});
}

function storageTask(operation) {
  storageChain = storageChain.catch(() => {}).then(operation);
  return storageChain;
}

function publicStatus() { return {...status}; }
function availableAccounts() {
  const managedKeys = new Set(managedAccounts.map((entry) =>
    JSON.stringify([entry.portal, entry.code])));
  return [...managedAccounts, ...(legacyAllowed ? accounts.filter((entry) =>
    !managedKeys.has(JSON.stringify([entry.portal, entry.code]))) : [])];
}
function accountForTab(tabId, portal) {
  return availableAccounts().find((entry) =>
    entry.id === selections.get(tabId) && entry.portal === portal);
}
function viewForTab(tabId, portal) {
  const view = accountView({phase: status.phase, snapshot, userId, portal,
    account: accountForTab(tabId, portal)});
  if (view.confirmationRemainingMs !== null && snapshotReceivedAt !== null) {
    view.confirmationRemainingMs = Math.max(0, view.confirmationRemainingMs -
      (performance.now() - snapshotReceivedAt));
  }
  return view;
}
function portalPayload(tabId, portal) {
  return {view: viewForTab(tabId, portal),
    legacyAllowed,
    accounts: availableAccounts().filter((entry) => entry.portal === portal).map((entry) =>
      ({id: entry.id, label: entry.label}))};
}
function sendTab(tabId, message) {
  if (!chrome.tabs?.sendMessage) return;
  chrome.tabs.sendMessage(tabId, message, {frameId: 0}).catch(() => {
    subscribedTabs.delete(tabId);
  });
}
function broadcastPortalUpdates() {
  for (const [tabId, portal] of subscribedTabs) {
    sendTab(tabId, {type: 'PT_PORTAL_UPDATE', ...portalPayload(tabId, portal)});
  }
}
function setStatus(next) {
  status = next;
  chrome.runtime.sendMessage({type: 'PT_STATUS_UPDATE', status: publicStatus()}).catch(() => {});
  broadcastPortalUpdates();
}

function clearTimers() {
  clearTimeout(handshakeTimer);
  clearTimeout(snapshotTimer);
  clearTimeout(stateResponseTimer);
  clearInterval(heartbeatTimer);
  clearTimeout(retryTimer);
  handshakeTimer = null;
  snapshotTimer = null;
  stateResponseTimer = null;
  heartbeatTimer = null;
  retryTimer = null;
}
function closeTransport({discardPending = false} = {}) {
  generation++;
  clearTimers();
  userId = null;
  snapshot = null; // never retain a held indicator across a lost connection
  managedAccounts = [];
  legacyAllowed = false;
  snapshotReceivedAt = null;
  lastStateAt = null;
  if (discardPending) pendingRequests.clear();
  if (socket) {
    const old = socket;
    socket = null;
    old.onopen = null;
    old.onmessage = null;
    old.onclose = null;
    old.onerror = null;
    old.close();
  }
}
function summarize(state) {
  const counts = {ownGibHeld: 0, ownGibQueued: 0, ownSgkHeld: 0, ownSgkQueued: 0};
  if (!Array.isArray(state?.locks) || !userId) return counts;
  for (const lock of state.locks) {
    const prefix = lock?.key?.portal === 'GİB' ? 'Gib' :
      lock?.key?.portal === 'SGK' ? 'Sgk' : null;
    if (!prefix) continue;
    if (lock.holder?.userId === userId) counts[`own${prefix}Held`]++;
    if (Array.isArray(lock.queue) && lock.queue.some((entry) => entry.userId === userId)) {
      counts[`own${prefix}Queued`]++;
    }
  }
  return counts;
}
function retry() {
  if (!connection || retryTimer) return;
  const delay = retryDelayMs;
  retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
  setStatus({phase: 'retrying', detail: `Hub bağlantısı koptu. ${delay / 1000} saniye sonra yeniden denenecek.`});
  retryTimer = setTimeout(() => { retryTimer = null; connectSocket(); }, delay);
  // Timers do not wake a stopped MV3 worker. This alarm is a 30s fallback.
  scheduleRetryAlarm(delay);
}
function fatal(code) {
  const details = {
    AUTH_FAILED: 'Kurum kodu veya personel anahtarı kabul edilmedi.',
    KICKED: 'Yönetici erişiminizi kapattı.',
    CODE_ROTATED: 'Kurum kodu yenilendi. Yeni kodu yöneticiden alın.',
    INVITE_INVALID: 'Davet süresi dolmuş veya bağlantı kullanılmış. Yöneticiden yeni davet alın.',
    DEVICE_REVOKED: 'Bu cihazın erişimi yönetici tarafından iptal edildi.',
    STORAGE_FAILED: 'Cihaz anahtarı saklanamadı. Yöneticiden yeni davet alın.',
    INVALID_HELLO: 'Hub bağlantı bilgilerini reddetti.',
    RATE_LIMIT: 'Çok fazla istek gönderildi. Bir süre bekleyin.',
  };
  connection = null;
  lastHubId = null;
  closeTransport({discardPending: true});
  clearRetryAlarm();
  void storageTask(() => chrome.storage.session.remove(['ptConnection', 'ptLastHubId']));
  void storageTask(() => chrome.storage.local?.remove('ptRememberedConnection'));
  setStatus({phase: 'error', detail: details[code] ?? 'Hub bağlantıyı reddetti.'});
}
function notifyTurns(previous, current) {
  for (const grant of becameHolder(previous, current, userId)) {
    const id = JSON.stringify([current.hubId, grant.portal, grant.accountCode,
      grant.acquiredAt, userId]);
    if (notifiedGrants.has(id)) continue;
    notifiedGrants.add(id);
    if (notifiedGrants.size > 1000) notifiedGrants.delete(notifiedGrants.values().next().value);
    if (chrome.notifications?.create) {
      chrome.notifications.create({type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: 'PortalTakip: Sıra sizde',
        message: `${grant.portal} hesabındaki sıranız geldi; kilit sizde.`}).catch(() => {});
    }
    for (const [tabId, portal] of subscribedTabs) {
      if (portal === grant.portal && accountForTab(tabId, portal)?.code === grant.accountCode) {
        sendTab(tabId, {type: 'PT_TURN', portal});
      }
    }
  }
}
function replyToOperation(message) {
  const pending = pendingRequests.get(message.requestId);
  if (!pending) return;
  pendingRequests.delete(message.requestId);
  sendTab(pending.tabId, {type: 'PT_ACTION_RESULT', ok: message.type !== 'ERROR',
    code: message.type === 'ERROR' ? message.code : undefined});
}
function replayPending() {
  for (const [requestId, pending] of pendingRequests) {
    if (!pending.needsReplay) continue;
    if (pending.hubId !== lastHubId || Date.now() - pending.sentAt > 30_000) {
      pendingRequests.delete(requestId);
      sendTab(pending.tabId, {type: 'PT_ACTION_RESULT', ok: false,
        code: pending.hubId !== lastHubId ? 'HUB_RESTARTED' : 'RETRY_EXPIRED'});
      continue;
    }
    pending.needsReplay = false;
    try { socket.send(JSON.stringify(pending.message)); } // exact requestId and payload
    catch { pending.needsReplay = true; socket.close(); return; }
  }
}
function handleState(message) {
  if (!userId || message.hubId !== lastHubId || !Array.isArray(message.locks) ||
      !Number.isFinite(message.serverTime)) return;
  const previous = snapshot;
  snapshot = message;
  snapshotReceivedAt = performance.now();
  lastStateAt = snapshotReceivedAt;
  retryDelayMs = 2000;
  clearTimeout(snapshotTimer);
  clearTimeout(stateResponseTimer);
  snapshotTimer = null;
  stateResponseTimer = null;
  clearRetryAlarm();
  replayPending();
  if (typeof message.organizationId === 'string' && message.organizationId !== accountOrganizationId) {
    if (accountOrganizationId !== null) {
      accounts = [];
      selections.clear();
      void storageTask(() => chrome.storage.session.remove(['ptAccounts', 'ptSelections']));
    }
    accountOrganizationId = message.organizationId;
    void storageTask(() => chrome.storage.session.set({ptAccountOrganizationId: accountOrganizationId}));
  }
  managedAccounts = Array.isArray(message.accounts) ? message.accounts.filter((entry) =>
    typeof entry?.id === 'string' && ['GİB', 'SGK'].includes(entry.portal) &&
    typeof entry.label === 'string' && validAccountCode(entry.code)) : [];
  legacyAllowed = message.legacyAllowed === true;
  for (const [tabId, selectedId] of selections) {
    const old = accounts.find((entry) => entry.id === selectedId);
    const mapped = old && managedAccounts.find((entry) => entry.portal === old.portal &&
      entry.code === old.code);
    if (mapped) selections.set(tabId, mapped.id);
    else if (!availableAccounts().some((entry) => entry.id === selectedId)) selections.delete(tabId);
  }
  void storageTask(() => chrome.storage.session.set({ptSelections:
    [...selections].map(([tabId, accountId]) => ({tabId, accountId}))}));
  setStatus({phase: 'connected', detail: message.reset ?
    'Hub yeniden başladı; kilit durumu sıfırlandı.' : 'Hub bağlı; durum güncel.',
  ...summarize(message)});
  notifyTurns(previous, message);
}
function connectSocket() {
  if (!connection) return;
  closeTransport();
  const current = generation;
  setStatus({phase: 'connecting', detail: 'Hub ile bağlantı kuruluyor.'});
  let ws;
  try { ws = new WebSocket(websocketUrl(connection)); }
  catch { retry(); return; }
  let credentialPersisted = Promise.resolve();
  socket = ws;
  handshakeTimer = setTimeout(() => { if (generation === current) ws.close(); }, 12_000);
  ws.onopen = () => {
    if (generation !== current) return;
    const credential = connection.authKind === 'invite' ?
      {inviteToken: connection.inviteToken} : connection.authKind === 'device' ?
        {deviceToken: connection.deviceToken} :
        {organizationCode: connection.organizationCode, staffToken: connection.staffToken};
    ws.send(JSON.stringify({type: 'HELLO', ...credential,
      ...(lastHubId ? {lastHubId} : {})}));
  };
  ws.onmessage = (event) => {
    if (generation !== current) return;
    if (typeof event.data !== 'string' || event.data.length > 2_000_000) {
      ws.close();
      return;
    }
    let message;
    try { message = JSON.parse(event.data); } catch { ws.close(); return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      ws.close();
      return;
    }
    if (message.type === 'HELLO' && message.status === 'ok' &&
        typeof message.hubId === 'string' && typeof message.userId === 'string') {
      if (connection.authKind === 'invite') {
        const validated = validateDeviceConnectionInput({authKind: 'device',
          host: connection.host, port: connection.port, deviceToken: message.deviceToken});
        if (!validated.ok) { fatal('INVALID_HELLO'); return; }
        const remember = connection.rememberDevice;
        const deviceConnection = validated.value;
        connection = deviceConnection;
        credentialPersisted = storageTask(async () => {
          await chrome.storage.session.set({ptConnection: deviceConnection});
          if (remember) await chrome.storage.local.set({ptRememberedConnection: deviceConnection});
          else await chrome.storage.local.remove('ptRememberedConnection');
        });
      }
      clearTimeout(handshakeTimer);
      handshakeTimer = null;
      lastStateAt = performance.now();
      snapshotTimer = setTimeout(() => {
        if (generation === current && !snapshot) ws.close();
      }, 12_000);
      userId = message.userId;
      lastHubId = message.hubId;
      void storageTask(() => chrome.storage.session.set({ptLastHubId: lastHubId}));
      setStatus({phase: 'connecting', detail: message.stateReset ?
        'Hub yeniden başladı; yeni durum bekleniyor.' :
        'Hub kimliği doğrulandı; güncel durum bekleniyor.'});
      heartbeatTimer = setInterval(() => {
        if (lastStateAt !== null && performance.now() - lastStateAt > 45_000) {
          ws.close();
        } else if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({type: 'STATE'}));
            clearTimeout(stateResponseTimer);
            stateResponseTimer = setTimeout(() => ws.close(), 10_000);
          } catch { ws.close(); }
        }
      }, 20_000);
      return;
    }
    if (message.type === 'STATE') {
      void credentialPersisted.then(() => {
        if (generation === current && ws.readyState === WebSocket.OPEN) handleState(message);
      }).catch(() => { if (generation === current) fatal('STORAGE_FAILED'); });
      return;
    }
    if (message.type === 'ERROR' ||
        ['ACQUIRE', 'RELEASE', 'CANCEL', 'CONFIRM'].includes(message.type)) {
      replyToOperation(message);
      if (message.type === 'ERROR' && !message.requestId) fatal(message.code);
    }
  };
  ws.onerror = () => { /* onclose reports network loss */ };
  ws.onclose = () => {
    if (generation !== current) return;
    clearTimeout(handshakeTimer);
    clearTimeout(snapshotTimer);
    clearTimeout(stateResponseTimer);
    clearInterval(heartbeatTimer);
    handshakeTimer = null;
    snapshotTimer = null;
    stateResponseTimer = null;
    heartbeatTimer = null;
    socket = null;
    userId = null;
    snapshot = null;
    snapshotReceivedAt = null;
    lastStateAt = null;
    for (const pending of pendingRequests.values()) pending.needsReplay = true;
    retry();
  };
}

async function restoreSession() {
  await chrome.storage.session.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
  await chrome.storage.local?.setAccessLevel?.({accessLevel: 'TRUSTED_CONTEXTS'});
  const saved = await chrome.storage.session.get(['ptConnection', 'ptLastHubId',
    'ptAccounts', 'ptSelections', 'ptAccountOrganizationId']);
  const remembered = await chrome.storage.local?.get?.('ptRememberedConnection');
  accounts = Array.isArray(saved.ptAccounts) ? saved.ptAccounts.filter((entry) =>
    typeof entry?.id === 'string' && ['GİB', 'SGK'].includes(entry.portal) &&
    typeof entry.label === 'string' && validAccountCode(entry.code)).slice(0, 50) : [];
  if (Array.isArray(saved.ptSelections)) {
    for (const item of saved.ptSelections) {
      if (Number.isInteger(item?.tabId) && typeof item.accountId === 'string') {
        selections.set(item.tabId, item.accountId);
      }
    }
  }
  accountOrganizationId = typeof saved.ptAccountOrganizationId === 'string' ?
    saved.ptAccountOrganizationId : null;
  const candidate = saved.ptConnection ?? remembered?.ptRememberedConnection;
  const validated = candidate?.authKind === 'device' ?
    validateDeviceConnectionInput(candidate) : candidate?.authKind === 'invite' ?
      validateInvitationLink(`http://${candidate.host}:${candidate.port}/invite#invite=${candidate.inviteToken}`) :
      validateConnectionInput(candidate);
  if (validated.ok) {
    connection = candidate?.authKind === 'invite' ? candidate :
      candidate?.authKind === 'device' ? validated.value :
        {...validated.value, authKind: 'legacy'};
    lastHubId = typeof saved.ptLastHubId === 'string' ? saved.ptLastHubId : null;
    connectSocket();
  }
}
const initialized = restoreSession().catch(() => {
  setStatus({phase: 'error', detail: 'Geçici bağlantı bilgileri okunamadı.'});
});

function portalSender(sender) {
  if (sender.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id) ||
      sender.frameId !== 0) return null;
  const portal = portalForUrl(sender.url);
  if (!portal || (sender.tab.url && portalForUrl(sender.tab.url) !== portal)) return null;
  return {portal, tabId: sender.tab.id};
}
function popupSender(sender) {
  return sender.id === chrome.runtime.id &&
    sender.url === chrome.runtime.getURL('ui/popup.html');
}
function persistAccounts() {
  return storageTask(() => chrome.storage.session.set({ptAccounts: accounts,
    ptSelections: [...selections].map(([tabId, accountId]) => ({tabId, accountId}))}));
}
function selectionMayChange(tabId, portal, nextId) {
  const currentId = selections.get(tabId);
  if (!currentId || currentId === nextId) return true;
  const mode = viewForTab(tabId, portal).mode;
  return !['mine', 'queued', 'offline', 'reconnecting', 'syncing'].includes(mode);
}
function sendHubOperation(tabId, type, portal, accountCode) {
  if (status.phase !== 'connected' || !snapshot ||
      socket?.readyState !== WebSocket.OPEN) return {ok: false, error: 'Hub bağlı değil.'};
  const requestId = crypto.randomUUID();
  if (pendingRequests.size >= 100) return {ok: false, error: 'Bekleyen çok fazla işlem var.'};
  const message = {type, portal, accountCode, requestId};
  pendingRequests.set(requestId, {tabId, message, hubId: lastHubId,
    sentAt: Date.now(), needsReplay: false});
  try { socket.send(JSON.stringify(message)); }
  catch {
    pendingRequests.get(requestId).needsReplay = true;
    socket.close();
  }
  return {ok: true, status: 'sent', requestId};
}

async function handlePortalMessage(message, sender, verified) {
  const {portal, tabId} = verified;
  subscribedTabs.set(tabId, portal);
  if (message.type === 'PT_CONTENT_INIT') return {ok: true, ...portalPayload(tabId, portal)};
  if (message.type === 'PT_ACCOUNT_ADD') {
    if (!legacyAllowed || status.phase !== 'connected') {
      return {ok: false, error: 'Hesapları yönetici atar; güncel bağlantıyı bekleyin.'};
    }
    const label = typeof message.label === 'string' ? message.label.trim() : '';
    if (label.length < 1 || label.length > 40 || /[\u0000-\u001f]/.test(label) ||
        !validAccountCode(message.accountCode)) {
      return {ok: false, error: 'Hesap etiketi veya kodu geçersiz.'};
    }
    let account = availableAccounts().find((entry) =>
      entry.portal === portal && entry.code === message.accountCode);
    if (!selectionMayChange(tabId, portal, account?.id)) {
      return {ok: false, error: 'Mevcut kilit veya sırayı bırakmadan hesap değiştirilemez.'};
    }
    if (!account) {
      if (accounts.length >= 50) return {ok: false, error: 'En çok 50 hesap eklenebilir.'};
      account = {id: crypto.randomUUID(), portal, label, code: message.accountCode};
      accounts.push(account);
    }
    selections.set(tabId, account.id);
    await persistAccounts();
    broadcastPortalUpdates();
    return {ok: true, ...portalPayload(tabId, portal)};
  }
  if (message.type === 'PT_ACCOUNT_SELECT') {
    const account = availableAccounts().find((entry) => entry.id === message.accountId &&
      entry.portal === portal);
    if (!account) return {ok: false, error: 'Hesap bulunamadı.'};
    if (!selectionMayChange(tabId, portal, account.id)) {
      return {ok: false, error: 'Mevcut kilit veya sırayı bırakmadan hesap değiştirilemez.'};
    }
    selections.set(tabId, account.id);
    await persistAccounts();
    broadcastPortalUpdates();
    return {ok: true, ...portalPayload(tabId, portal)};
  }
  const account = accountForTab(tabId, portal);
  if (!account) return {ok: false, error: 'Önce ortak hesap kodunu seçin.'};
  const view = viewForTab(tabId, portal);
  if (message.type === 'PT_ACTION') {
    if (message.action === 'ACQUIRE') {
      if (!['empty', 'busy'].includes(view.mode)) {
        return {ok: false, error: 'Bu hesap için kilit isteği şu anda gönderilemez.'};
      }
      return sendHubOperation(tabId, 'ACQUIRE', portal, account.code);
    }
    if (message.action === 'LEAVE') {
      const type = view.mode === 'mine' ? 'RELEASE' :
        view.mode === 'queued' ? 'CANCEL' : null;
      if (!type) return {ok: false, error: 'Bu hesapta kilit veya sıra kaydınız yok.'};
      return sendHubOperation(tabId, type, portal, account.code);
    }
    return {ok: false, error: 'Geçersiz işlem.'};
  }
  if (message.type === 'PT_CONFIRM') {
    if (view.mode !== 'mine' || view.confirmationDeadlineAt === null) {
      return {ok: false, error: 'Açık teyit penceresi yok.'};
    }
    return sendHubOperation(tabId, 'CONFIRM', portal, account.code);
  }
  return {ok: false, error: 'Geçersiz mesaj.'};
}

async function handlePopupMessage(message) {
  if (message.type === 'PT_GET_STATUS') return {ok: true, status: publicStatus()};
  if (message.type === 'PT_DISCONNECT') {
    connection = null;
    lastHubId = null;
    closeTransport({discardPending: true});
    clearRetryAlarm();
    await storageTask(() => chrome.storage.session.remove(['ptConnection', 'ptLastHubId']));
    await storageTask(() => chrome.storage.local?.remove('ptRememberedConnection'));
    setStatus({phase: 'disconnected', detail: 'Bağlantı kullanıcı tarafından kesildi.'});
    return {ok: true, status: publicStatus()};
  }
  const invite = message.type === 'PT_CONNECT_INVITE';
  const validated = invite ? validateInvitationLink(message.config?.invitationLink) :
    validateConnectionInput(message.config);
  if (!validated.ok) return {ok: false, error: validated.message};
  if (!invite && connection && connection.organizationCode !== validated.value.organizationCode) {
    accounts = [];
    selections.clear();
    accountOrganizationId = null;
    await storageTask(() => chrome.storage.session.remove(
      ['ptAccounts', 'ptSelections', 'ptAccountOrganizationId']));
  }
  closeTransport({discardPending: true});
  clearRetryAlarm();
  connection = invite ? {...validated.value, authKind: 'invite',
    rememberDevice: message.config?.rememberDevice === true} :
    {...validated.value, authKind: 'legacy'};
  lastHubId = null;
  retryDelayMs = 2000;
  await storageTask(() => chrome.storage.session.set({ptConnection: connection}));
  await storageTask(() => chrome.storage.session.remove('ptLastHubId'));
  await storageTask(() => chrome.storage.local?.remove('ptRememberedConnection'));
  connectSocket();
  return {ok: true, status: publicStatus()};
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const portal = portalSender(sender);
  const isPortalMessage = portal && ['PT_CONTENT_INIT', 'PT_ACCOUNT_ADD',
    'PT_ACCOUNT_SELECT', 'PT_ACTION', 'PT_CONFIRM'].includes(message?.type);
  const isPopupMessage = popupSender(sender) && ['PT_GET_STATUS', 'PT_CONNECT',
    'PT_CONNECT_INVITE', 'PT_DISCONNECT'].includes(message?.type);
  if (!isPortalMessage && !isPopupMessage) return;
  (async () => {
    await initialized;
    return isPortalMessage ? handlePortalMessage(message, sender, portal) :
      handlePopupMessage(message);
  })().then(sendResponse, () => sendResponse({ok: false, error: 'İşlem tamamlanamadı.'}));
  return true;
});

chrome.tabs?.onRemoved?.addListener((tabId) => {
  // UI bookkeeping only: Hub decides disconnect grace and lock expiry.
  subscribedTabs.delete(tabId);
  if (selections.delete(tabId)) void persistAccounts();
});

chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm.name !== RETRY_ALARM) return;
  void initialized.then(() => {
    if (connection && status.phase === 'retrying') {
      clearTimeout(retryTimer);
      retryTimer = null;
      connectSocket();
    }
  });
});
