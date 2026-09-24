const $ = (id) => document.getElementById(id);
const PRESENCE_INTERVAL_MS = 15 * 60 * 1000;
let csrfToken = null;
let latestState = null;
let refreshPending = false;
let serverClock = null;
let pendingConfirmation = null;

const errorText = {
  ADMIN_REQUIRED: 'Yönetici oturumu sona erdi. Yeniden giriş yapın.',
  AUTH_FAILED: 'Yönetici parolası doğrulanamadı.',
  CSRF_REQUIRED: 'Oturum doğrulanamadı. Sayfayı yenileyip tekrar giriş yapın.',
  INVALID_SETUP: 'Kurulum bilgilerini kontrol edin.',
  INVALID_STAFF: 'Personel adını kontrol edin.',
  INVALID_USER: 'Personel kaydı bulunamadı.',
  INVALID_DEVICE: 'Cihaz kaydı bulunamadı.',
  INVALID_ACCOUNT: 'Hesap bilgilerini ve personel seçimini kontrol edin.',
  ACCOUNT_EXISTS: 'Bu portal ve kod zaten kayıtlı.',
  ACCOUNT_NOT_FOUND: 'Hesap kaydı bulunamadı.',
  IMPORT_ACTIVE_ACCOUNTS_FIRST: 'Önce etkin eski hesap kodlarını eşleştirin veya kilit ve kuyrukların boşalmasını bekleyin.',
  STAFF_DISABLED: 'Atılan personele davet oluşturulamaz. Önce yeniden kabul edin.',
  INVALID_MESSAGE: 'Portal veya ortak hesap kodunu kontrol edin.',
  RATE_LIMIT: 'Çok sık işlem yapıldı. Bir süre bekleyip tekrar deneyin.',
  SERVER_ERROR: 'Hub işlemi tamamlayamadı. Tekrar deneyin.',
};

function node(tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value !== undefined) element.textContent = value;
  return element;
}

function notify(value, kind = 'info') {
  const target = $('message');
  target.textContent = value;
  target.dataset.kind = kind;
  target.hidden = false;
}

function setHubStatus(mode, text) {
  $('hubStatus').className = `status-pill status-${mode}`;
  $('hubStatusText').textContent = text;
}

function showPanel(which) {
  for (const name of ['setupPanel', 'loginPanel', 'adminPanel']) {
    $(name).hidden = name !== which;
  }
  $('logout').hidden = which !== 'adminPanel';
  $('organizationLabel').hidden = which !== 'adminPanel';
}

function clearSecrets() {
  $('organizationCode').value = '';
  $('organizationCode').type = 'password';
  $('toggleCode').textContent = 'Göster';
  $('toggleCode').setAttribute('aria-label', 'Kurum kodunu göster');
  $('toggleCode').setAttribute('aria-pressed', 'false');
  $('toggleCode').disabled = true;
  $('copyCode').disabled = true;
  $('staffToken').value = '';
  $('staffToken').type = 'password';
  $('staffSecret').hidden = true;
  $('toggleStaffToken').textContent = 'Göster';
  $('toggleStaffToken').setAttribute('aria-label', 'Personel anahtarını göster');
  $('toggleStaffToken').setAttribute('aria-pressed', 'false');
  $('inviteLink').value = '';
  $('inviteLink').type = 'password';
  $('inviteResult').hidden = true;
  $('importCode').value = '';
}

function setOrganizationCode(value) {
  $('organizationCode').value = value;
  $('organizationCode').type = 'password';
  $('toggleCode').textContent = 'Göster';
  $('toggleCode').setAttribute('aria-label', 'Kurum kodunu göster');
  $('toggleCode').setAttribute('aria-pressed', 'false');
  $('toggleCode').disabled = !value;
  $('copyCode').disabled = !value;
}

async function api(path, method = 'GET', body) {
  const response = await fetch(path, {
    method, credentials: 'same-origin',
    headers: method === 'POST' ? {'Content-Type': 'application/json',
      ...(csrfToken ? {'X-CSRF-Token': csrfToken} : {})} : {},
    ...(method === 'POST' ? {body: JSON.stringify(body ?? {})} : {}),
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/login') {
      csrfToken = null;
      clearLiveState();
      clearSecrets();
      showPanel('loginPanel');
      setHubStatus('online', 'Oturum sona erdi');
    }
    const code = data.error ?? data.code ?? 'SERVER_ERROR';
    throw new Error(errorText[code] ?? `İşlem başarısız: ${code}`);
  }
  return data;
}

async function copyInput(id, label) {
  const value = $(id).value.trim();
  if (!value) { notify(`${label} henüz gösterilemiyor.`, 'error'); return; }
  try {
    await navigator.clipboard.writeText(value);
    notify(`${label} panoya kopyalandı.`, 'success');
  } catch {
    $(id).focus();
    $(id).select();
    notify('Pano izni verilmedi. Seçili alanı Ctrl+C ile kopyalayın.', 'error');
  }
}

function toggleSecret(inputId, buttonId, label) {
  const input = $(inputId);
  const button = $(buttonId);
  const visible = input.type === 'password';
  input.type = visible ? 'text' : 'password';
  button.textContent = visible ? 'Gizle' : 'Göster';
  button.setAttribute('aria-label', `${label} ${visible ? 'gizle' : 'göster'}`);
  button.setAttribute('aria-pressed', String(visible));
}

function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase('tr-TR') ?? '').join('');
}

function emptyState(title, description) {
  const wrapper = node('div', 'empty-state');
  wrapper.append(node('span', 'empty-icon', '—'));
  const content = node('div');
  content.append(node('strong', '', title), node('span', '', description));
  wrapper.append(content);
  return wrapper;
}

function statusChip(connected, disabled = false) {
  return node('span', `chip ${disabled ? 'chip-disabled' :
    connected ? 'chip-connected' : 'chip-disconnected'}`,
  disabled ? 'Atıldı' : connected ? 'Bağlı' : 'Bağlantı koptu');
}

function currentServerTime() {
  return serverClock ? serverClock.at + (performance.now() - serverClock.receivedAt) : Date.now();
}

function duration(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function updateCountdowns() {
  if (!csrfToken || !latestState) return;
  const now = currentServerTime();
  for (const timer of document.querySelectorAll('[data-confirm-at]')) {
    const remaining = Number(timer.dataset.confirmAt) - now;
    const open = timer.dataset.confirmStage === 'open';
    timer.textContent = remaining > 0 ?
      `${open ? 'Teyit penceresi' : 'Teyit isteğine'} · ${duration(remaining)}` :
      open ? 'Teyit süresi doldu · durum yenileniyor' : 'Teyit isteği bekleniyor';
    timer.parentElement.classList.toggle('due', open || remaining <= 0);
  }
}

function askConfirmation({title, description, target, actionLabel, action}) {
  if ($('confirmDialog').open) return;
  $('confirmTitle').textContent = title;
  $('confirmDescription').textContent = description;
  $('confirmTarget').textContent = target;
  $('confirmAction').textContent = actionLabel;
  pendingConfirmation = action;
  $('confirmDialog').showModal();
  $('cancelConfirm').focus();
}

async function perform(action, successText) {
  try {
    await action();
    notify(successText, 'success');
    await refresh();
  } catch (error) { notify(error.message, 'error'); }
}

function confirmForceUnlock(portal, accountCode) {
  const lock = latestState?.locks?.find((item) => item.key.portal === portal &&
    item.key.accountCode === accountCode);
  askConfirmation({
    title: 'Kilidi düşürmek istiyor musunuz?',
    description: 'Mevcut kilit sahibi çıkarılır; varsa sıra ilk kişiye devredilir.',
    target: `Portal: ${portal}\nOrtak hesap kodu: ${accountCode}\nKilit sahibi: ${lock?.holder?.displayName ?? 'Aktif sahip görünmüyor'}`,
    actionLabel: 'Kilidi düşür',
    action: () => perform(() => api('/api/force-unlock', 'POST', {portal, accountCode,
      requestId: crypto.randomUUID()}), `${portal} · ${accountCode} kilidi işlendi.`),
  });
}

function renderLocks(containerId, locks, portal, available = true) {
  const container = $(containerId);
  container.replaceChildren();
  $(portal === 'GİB' ? 'gibCount' : 'sgkCount').textContent = available ?
    `${locks.length} hesap` : 'Durum yok';
  if (!available) {
    container.append(emptyState('Canlı durum alınamıyor', 'Hub bağlantısını kontrol edin.'));
    return;
  }
  if (locks.length === 0) {
    container.append(emptyState('Şu anda aktif hesap yok', 'Bu portalda kilit veya bekleyen sıra bulunmuyor.'));
    return;
  }
  for (const lock of locks) {
    const card = node('article', 'lock-card');
    const top = node('div', 'lock-top');
    const codeBlock = node('div');
    const managed = latestState?.accounts?.find((account) =>
      account.portal === portal && account.code === lock.key.accountCode);
    if (managed) codeBlock.append(node('strong', '', managed.label));
    codeBlock.append(node('span', 'lock-code-label', 'Ortak hesap kodu'),
      node('strong', 'lock-code', lock.key.accountCode));
    top.append(codeBlock, node('span', 'count-badge', `${lock.queue.length} bekleyen`));
    card.append(top);

    const holder = node('div', 'lock-holder');
    holder.append(node('span', 'avatar', initials(lock.holder?.displayName)));
    const holderMain = node('div', 'holder-main');
    holderMain.append(node('strong', '', lock.holder?.displayName ?? 'Kilit sahibi yok'),
      node('small', '', 'Kilit sahibi'));
    holder.append(holderMain, lock.holder ? statusChip(lock.holder.connected) :
      node('span', 'count-badge', 'Boş'));
    card.append(holder);

    if (lock.holder?.confirmationDeadlineAt || lock.holder?.lastConfirmedAt) {
      const confirmation = node('div', 'confirmation');
      confirmation.append(node('span', '', lock.holder.confirmationDeadlineAt ?
        'Teyit bekleniyor' : 'Sonraki teyit'));
      const timer = node('strong');
      timer.dataset.confirmAt = String(lock.holder.confirmationDeadlineAt ??
        lock.holder.lastConfirmedAt + PRESENCE_INTERVAL_MS);
      timer.dataset.confirmStage = lock.holder.confirmationDeadlineAt ? 'open' : 'scheduled';
      confirmation.append(timer);
      card.append(confirmation);
    }

    const queue = node('div', 'queue-block');
    const queueHeading = node('div', 'queue-heading');
    queueHeading.append(node('span', '', 'FIFO sıra'),
      node('span', '', `${lock.queue.length} kişi`));
    queue.append(queueHeading);
    if (lock.queue.length) {
      const list = node('ol', 'queue-list');
      lock.queue.forEach((entry, index) => {
        const item = node('li');
        item.append(node('span', 'queue-position', String(index + 1)),
          node('span', 'queue-name', entry.displayName), statusChip(entry.connected));
        list.append(item);
      });
      queue.append(list);
    } else queue.append(node('p', 'queue-empty', 'Bu hesap için bekleyen kimse yok.'));
    card.append(queue);
    const footer = node('div', 'lock-footer');
    const button = node('button', 'button button-danger-outline', 'Kilidi düşür');
    button.type = 'button';
    button.setAttribute('aria-label', `${portal} ${lock.key.accountCode} kilidini düşür`);
    button.addEventListener('click', () => confirmForceUnlock(portal, lock.key.accountCode));
    footer.append(button);
    card.append(footer);
    container.append(card);
  }
  updateCountdowns();
}

function affectedAccounts(userId) {
  const matches = [];
  for (const lock of latestState?.locks ?? []) {
    if (lock.holder?.userId === userId || lock.queue.some((entry) => entry.userId === userId)) {
      matches.push(`${lock.key.portal} · ${lock.key.accountCode}`);
    }
  }
  return matches;
}

function renderStaff(staff, available = true) {
  const list = $('staffList');
  list.replaceChildren();
  $('staffCount').textContent = available ? `${staff.length} kayıt` : 'Durum yok';
  if (!available) { list.append(node('li', 'staff-empty', 'Personel durumu alınamıyor.')); return; }
  if (!staff.length) {
    list.append(node('li', 'staff-empty', 'Henüz personel kaydı yok. Aşağıdan ilk kişiyi ekleyin.'));
    return;
  }
  for (const person of staff) {
    const item = node('li', 'staff-row');
    item.append(node('span', 'avatar', initials(person.displayName)));
    const info = node('div', 'staff-info');
    info.append(node('strong', '', person.displayName),
      statusChip(person.connected, person.disabled));
    item.append(info);
    const inviteButton = node('button', 'button button-secondary', 'Davet oluştur');
    inviteButton.type = 'button';
    inviteButton.disabled = person.disabled;
    inviteButton.setAttribute('aria-label', `${person.displayName} için davet oluştur`);
    inviteButton.addEventListener('click', async () => {
      const host = $('lanAddress').value.trim();
      if (!latestState?.lanAddresses?.includes(host)) {
        notify('Önce listeden Hub LAN adresini seçin.', 'error'); return;
      }
      try {
        const data = await api('/api/invitations', 'POST', {userId: person.userId});
        const url = new URL(`http://${host}:${latestState.wsPort}/invite`);
        url.hash = new URLSearchParams({invite: data.inviteToken}).toString();
        $('inviteStaffName').textContent = person.displayName;
        $('inviteLink').value = url.href;
        $('inviteLink').type = 'password';
        $('toggleInviteLink').textContent = 'Göster';
        $('toggleInviteLink').setAttribute('aria-pressed', 'false');
        $('inviteExpiry').textContent = `Son kullanım: ${new Date(data.expiresAt).toLocaleTimeString('tr-TR')}. Yeni davet oluşturulursa önceki geçersizleşir.`;
        $('inviteResult').hidden = false;
        notify(`${person.displayName} için davet oluşturuldu. Bağlantıyı yalnızca ilgili kişiye iletin.`, 'success');
      } catch (error) { notify(error.message, 'error'); }
    });
    item.append(inviteButton);
    const button = node('button', `button ${person.disabled ? 'button-secondary' :
      'button-danger-outline'}`, person.disabled ? 'Yeniden kabul' : 'At');
    button.type = 'button';
    button.setAttribute('aria-label', `${person.displayName}: ${person.disabled ?
      'yeniden kabul et' : 'personeli at'}`);
    button.addEventListener('click', () => {
      if (person.disabled) {
        perform(() => api('/api/readmit', 'POST', {userId: person.userId,
          requestId: crypto.randomUUID()}), `${person.displayName} yeniden kabul edildi.`);
        return;
      }
      const accounts = affectedAccounts(person.userId);
      askConfirmation({
        title: `${person.displayName} atılsın mı?`,
        description: 'Bağlantısı kapatılır ve yeniden kabul edilene kadar katılamaz. Tüm kilit ve sıralardaki yeri silinir.',
        target: accounts.length ? `Etkilenen portal ve hesaplar:\n${accounts.join('\n')}` :
          'Bu personele ait aktif kilit veya sıra görünmüyor.',
        actionLabel: 'Personeli at',
        action: () => perform(() => api('/api/kick', 'POST', {userId: person.userId,
          requestId: crypto.randomUUID()}), `${person.displayName} atıldı.`),
      });
    });
    item.append(button);
    const devices = node('div', 'staff-devices');
    for (const device of person.devices ?? []) {
      const deviceRow = node('div', 'device-row');
      deviceRow.append(node('span', '', `Cihaz ${device.deviceId.slice(0, 8)} · ${device.revokedAt ?
        'Erişim iptal' : 'Erişim açık'}`));
      if (!device.revokedAt) {
        const revoke = node('button', 'button button-danger-outline', 'Cihazı iptal et');
        revoke.type = 'button';
        revoke.addEventListener('click', () => askConfirmation({
          title: 'Cihaz erişimi iptal edilsin mi?',
          description: 'Bu cihazın bağlantısı kapanır; yeniden katılım için yeni davet gerekir.',
          target: `Personel: ${person.displayName}\nCihaz: ${device.deviceId}`,
          actionLabel: 'Cihazı iptal et',
          action: () => perform(() => api('/api/devices/revoke', 'POST',
            {deviceId: device.deviceId}), `${person.displayName} cihaz erişimi iptal edildi.`),
        }));
        deviceRow.append(revoke);
      }
      devices.append(deviceRow);
    }
    if (devices.childElementCount) item.append(devices);
    list.append(item);
  }
}

function staffChoices(containerId, staff, selectedIds = []) {
  const container = $(containerId);
  const hadChoices = container.querySelector('input') !== null;
  const prior = new Set([...container.querySelectorAll('input:checked')].map((input) => input.value));
  container.replaceChildren();
  for (const person of staff) {
    const label = node('label', 'account-choice');
    const input = node('input');
    input.type = 'checkbox';
    input.value = person.userId;
    input.checked = hadChoices ? prior.has(person.userId) : selectedIds.includes(person.userId);
    label.append(input, document.createTextNode(person.displayName));
    container.append(label);
  }
}

function chosenStaff(container) {
  return [...container.querySelectorAll('input:checked')].map((input) => input.value);
}

function renderAccounts(data) {
  staffChoices('newAccountStaff', data.staff);
  staffChoices('importAccountStaff', data.staff);
  $('legacyMigration').hidden = !data.legacyAllowed;
  const list = $('accountList');
  // Keep an in-progress assignment edit intact during five-second refreshes.
  const editingId = list.querySelector('[data-editing="true"]')?.dataset.accountId;
  if (editingId) return;
  list.replaceChildren();
  if (!data.accounts.length) {
    list.append(node('p', 'staff-empty', 'Henüz yönetilen hesap yok.'));
    return;
  }
  for (const account of data.accounts) {
    const card = node('article', 'account-card');
    card.dataset.accountId = account.id;
    card.append(node('strong', '', `${account.portal} · ${account.label}`));
    const code = node('code', 'account-managed-code', account.code);
    card.append(code);
    const copy = node('button', 'button button-secondary', 'Bu kodu kopyala');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(account.code);
        notify(`${account.portal} · ${account.label} kodu panoya kopyalandı.`, 'success');
      } catch { notify('Pano izni verilmedi. Kodu seçip Ctrl+C kullanın.', 'error'); }
    });
    card.append(copy);
    const names = account.assignedUserIds.map((id) =>
      data.staff.find((person) => person.userId === id)?.displayName ?? 'Bilinmeyen personel');
    card.append(node('p', '', `Erişim: ${names.join(', ') || 'Kimse atanmadı'}`));
    const edit = node('button', 'button button-quiet', 'Atamaları düzenle');
    edit.type = 'button';
    edit.addEventListener('click', () => {
      card.dataset.editing = 'true';
      edit.hidden = true;
      const options = node('div', 'account-staff');
      for (const person of data.staff) {
        const label = node('label', 'account-choice');
        const checkbox = node('input');
        checkbox.type = 'checkbox';
        checkbox.value = person.userId;
        checkbox.checked = account.assignedUserIds.includes(person.userId);
        label.append(checkbox, document.createTextNode(person.displayName));
        options.append(label);
      }
      const save = node('button', 'button button-primary', 'Atamaları kaydet');
      save.type = 'button';
      const cancel = node('button', 'button button-quiet', 'Vazgeç');
      cancel.type = 'button';
      cancel.addEventListener('click', () => {
        card.dataset.editing = 'false';
        renderAccounts(latestState);
      });
      save.addEventListener('click', () => {
        const assignedUserIds = chosenStaff(options);
        const removed = account.assignedUserIds.filter((id) => !assignedUserIds.includes(id));
        const action = () => { card.dataset.editing = 'false'; return perform(() => api('/api/accounts/assign', 'POST',
          {accountId: account.id, assignedUserIds}), 'Hesap atamaları güncellendi.');
        };
        if (removed.length) askConfirmation({
          title: 'Hesap erişimi kaldırılsın mı?',
          description: 'Bu kişilerin bu hesaptaki kilit ve sıra yerleri hemen silinir. Kilit sıradakine FIFO devredilir.',
          target: `${account.portal} · ${account.label}\nKod: ${account.code}\nErişimi kaldırılanlar: ${removed.map((id) => data.staff.find((person) => person.userId === id)?.displayName ?? id).join(', ')}`,
          actionLabel: 'Erişimi kaldır', action,
        });
        else void action();
      });
      card.append(options, save, cancel);
    });
    card.append(edit);
    list.append(card);
  }
}

function clearLiveState() {
  latestState = null;
  serverClock = null;
  $('connectedCount').textContent = '—';
  $('activeCount').textContent = '—';
  $('waitingCount').textContent = '—';
  $('lanSummary').textContent = '—';
  $('lastUpdated').textContent = 'Canlı veri alınamıyor';
  $('addressNotice').hidden = true;
  $('restartNotice').hidden = true;
  renderLocks('gibLocks', [], 'GİB', false);
  renderLocks('sgkLocks', [], 'SGK', false);
  renderStaff([], false);
  $('accountList').replaceChildren();
  $('legacyMigration').hidden = true;
}

async function refresh() {
  if (!csrfToken || refreshPending) return;
  refreshPending = true;
  const requestedCsrf = csrfToken;
  try {
    const data = await api('/api/state');
    if (csrfToken !== requestedCsrf) return;
    latestState = data;
    try {
      const old = JSON.parse(localStorage.getItem('ptAdminLastHub') ?? 'null');
      if (old?.organizationId === data.organizationId && old.hubId !== data.hubId) {
        $('restartNotice').hidden = false;
      }
      localStorage.setItem('ptAdminLastHub', JSON.stringify({organizationId: data.organizationId,
        hubId: data.hubId}));
    } catch { /* Browser storage is optional for this notice. */ }
    serverClock = {at: data.serverTime ?? Date.now(), receivedAt: performance.now()};
    setHubStatus('online', 'Hub bağlı');
    $('headerOrganization').textContent = data.organizationName;
    $('connectedCount').textContent = String(data.clients);
    $('activeCount').textContent = String(data.locks.filter((lock) => lock.holder).length);
    $('waitingCount').textContent = String(data.locks.reduce((sum, lock) => sum + lock.queue.length, 0));
    $('wsPort').value = String(data.wsPort);
    $('lastUpdated').textContent = `Son güncelleme ${new Date(data.serverTime ?? Date.now()).toLocaleTimeString('tr-TR')}`;

    const addresses = $('lanAddresses');
    addresses.replaceChildren();
    for (const address of data.lanAddresses) {
      const option = node('option');
      option.value = address;
      addresses.append(option);
    }
    if (!$('lanAddress').value && data.lanAddresses[0]) $('lanAddress').value = data.lanAddresses[0];
    $('lanSummary').textContent = $('lanAddress').value.trim() || 'Bulunamadı';
    $('lanSummaryNote').textContent = $('lanAddress').value.trim() ?
      `WebSocket portu ${data.wsPort}` : 'Adresi aşağıdan elle girin';
    const noAddress = data.lanAddresses.length === 0;
    $('addressNotice').hidden = !noAddress && !data.network?.changed;
    $('acknowledgeAddress').hidden = noAddress;
    $('addressNoticeText').textContent = noAddress ?
      'Aktif LAN IPv4 adresi bulunamadı. Ağ bağlantısını ve Windows ağ profilini kontrol edin.' :
      data.network?.changed ?
        `Önceki: ${data.network.previous.join(', ') || 'bilinmiyor'}. Yeni: ${data.lanAddresses.join(', ')}. Personelin Hub adresini güncelleyin.` : '';
    renderLocks('gibLocks', data.locks.filter((lock) => lock.key.portal === 'GİB'), 'GİB');
    renderLocks('sgkLocks', data.locks.filter((lock) => lock.key.portal === 'SGK'), 'SGK');
    renderStaff(data.staff);
    renderAccounts(data);
  } catch (error) {
    if (csrfToken) {
      const wasOnline = latestState !== null;
      setHubStatus('offline', 'Hub bağlantısı yok');
      clearLiveState();
      if (wasOnline) notify('Hub bağlantısı kesildi. Canlı durum yeniden bağlanınca gösterilecek.', 'error');
    } else notify(error.message, 'error');
  } finally { refreshPending = false; }
}

$('confirmAction').addEventListener('click', async () => {
  const action = pendingConfirmation;
  pendingConfirmation = null;
  $('confirmDialog').close();
  if (action) await action();
});
$('cancelConfirm').addEventListener('click', () => { pendingConfirmation = null; $('confirmDialog').close(); });
$('confirmDialog').addEventListener('cancel', () => { pendingConfirmation = null; });
$('dismissRestart').addEventListener('click', () => { $('restartNotice').hidden = true; });
$('acknowledgeAddress').addEventListener('click', () => perform(() =>
  api('/api/network/acknowledge', 'POST'), 'Yeni LAN adresi kaydedildi. Personel bağlantı adreslerini güncelleyin.'));

$('setupForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if ($('setupPassword').value !== $('setupPasswordAgain').value) {
    notify('Parolalar eşleşmiyor.', 'error'); return;
  }
  try {
    const data = await api('/api/setup', 'POST', {setupToken: $('setupToken').value,
      organizationName: $('organizationName').value, password: $('setupPassword').value});
    $('setupToken').value = '';
    $('setupPassword').value = '';
    $('setupPasswordAgain').value = '';
    csrfToken = data.csrfToken;
    setOrganizationCode(data.organizationCode);
    showPanel('adminPanel');
    notify('Kurulum tamamlandı. Kurum kodunu güvenli bir yere kaydedin.', 'success');
    await refresh();
  } catch (error) { notify(error.message, 'error'); }
});

$('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const data = await api('/api/login', 'POST', {password: $('password').value});
    $('password').value = '';
    csrfToken = data.csrfToken;
    clearSecrets();
    showPanel('adminPanel');
    notify('Giriş yapıldı. Kurum kodu kayıpsa bu ekrandan yenileyin.', 'success');
    await refresh();
  } catch (error) { notify(error.message, 'error'); }
});

$('logout').addEventListener('click', async () => {
  try {
    await api('/api/logout', 'POST');
    csrfToken = null;
    clearLiveState();
    clearSecrets();
    showPanel('loginPanel');
    setHubStatus('online', 'Hub erişilebilir');
    notify('Çıkış yapıldı.', 'success');
  } catch (error) { notify(error.message, 'error'); }
});

$('staffForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const data = await api('/api/staff', 'POST', {displayName: $('staffName').value});
    $('staffName').value = '';
    $('secretStaffName').textContent = data.displayName;
    $('staffToken').value = data.staffToken;
    $('staffToken').type = 'password';
    $('toggleStaffToken').textContent = 'Göster';
    $('toggleStaffToken').setAttribute('aria-label', 'Personel anahtarını göster');
    $('toggleStaffToken').setAttribute('aria-pressed', 'false');
    $('staffSecret').hidden = false;
    notify(`${data.displayName} oluşturuldu. Erişim anahtarını güvenli biçimde iletin.`, 'success');
    await refresh();
  } catch (error) { notify(error.message, 'error'); }
});

$('rotateForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const password = $('rotatePassword').value;
  askConfirmation({
    title: 'Kurum kodu yenilensin mi?',
    description: 'Tüm personel bağlantıları kapanır; davetler ve cihaz anahtarları iptal edilir. Eski yöntemle bağlananlara yeni kod gerekir.',
    target: `Kurum: ${latestState?.organizationName ?? 'Kurum'}\nEtkilenen bağlı personel: ${latestState?.clients ?? 'bilinmiyor'}`,
    actionLabel: 'Kodu yenile',
    action: () => perform(async () => {
      const data = await api('/api/organization-code/rotate', 'POST', {password});
      $('rotatePassword').value = '';
      $('inviteLink').value = '';
      $('inviteResult').hidden = true;
      setOrganizationCode(data.organizationCode);
    }, 'Kurum kodu yenilendi. Eski bağlantılar ve davetler geçersiz; gerektiğinde yeni davet oluşturun.'),
  });
});

$('accountForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/accounts', 'POST', {portal: $('accountPortal').value,
      label: $('accountLabel').value, assignedUserIds: chosenStaff($('newAccountStaff'))});
    $('accountLabel').value = '';
    $('newAccountStaff').replaceChildren();
    notify('Hesap oluşturuldu ve seçilen personele gönderildi.', 'success');
    await refresh();
  } catch (error) { notify(error.message, 'error'); }
});

$('importAccountForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/accounts/import', 'POST', {portal: $('importPortal').value,
      label: $('importLabel').value, accountCode: $('importCode').value.trim(),
      assignedUserIds: chosenStaff($('importAccountStaff'))});
    $('importLabel').value = '';
    $('importCode').value = '';
    $('importAccountStaff').replaceChildren();
    notify('Eski kod aynen eşleştirildi; etkin sıra taşınmadı.', 'success');
    await refresh();
  } catch (error) { notify(error.message, 'error'); }
});

$('enforceAccounts').addEventListener('click', () => askConfirmation({
  title: 'Eski elle kullanımı kapat?',
  description: 'Eşleşmemiş yerel kodlarla yeni kilit isteği Hub tarafından reddedilir. Kodları önce içe alın; bu işlem mevcut kodları değiştirmez.',
  target: `Kurum: ${latestState?.organizationName ?? 'Kurum'}\nYönetilen hesap: ${latestState?.accounts?.length ?? 0}`,
  actionLabel: 'Elle kullanımı kapat',
  action: () => perform(() => api('/api/accounts/enforce', 'POST'), 'Artık yalnızca atanan hesaplar kullanılabilir.'),
}));

$('unlockForm').addEventListener('submit', (event) => {
  event.preventDefault();
  confirmForceUnlock($('portal').value, $('unlockAccount').value.trim());
});

for (const [button, input, label] of [
  ['copyAddress', 'lanAddress', 'Hub LAN adresi'], ['copyPort', 'wsPort', 'WebSocket portu'],
  ['copyCode', 'organizationCode', 'Kurum kodu'], ['copyStaffToken', 'staffToken', 'Personel anahtarı'],
  ['copyInviteLink', 'inviteLink', 'Davet bağlantısı'],
]) $(button).addEventListener('click', () => copyInput(input, label));

$('toggleCode').addEventListener('click', () => toggleSecret('organizationCode', 'toggleCode', 'Kurum kodunu'));
$('toggleStaffToken').addEventListener('click', () => toggleSecret('staffToken', 'toggleStaffToken', 'Personel anahtarını'));
$('toggleInviteLink').addEventListener('click', () => toggleSecret('inviteLink', 'toggleInviteLink', 'Davet bağlantısını'));
$('lanAddress').addEventListener('input', () => {
  $('lanSummary').textContent = $('lanAddress').value.trim() || 'Bulunamadı';
});

async function initialize() {
  try {
    const session = await api('/api/session');
    csrfToken = session.csrfToken ?? null;
    setHubStatus('online', 'Hub erişilebilir');
    showPanel(session.authenticated ? 'adminPanel' :
      session.setupRequired ? 'setupPanel' : 'loginPanel');
    if (session.authenticated) await refresh();
  } catch (error) {
    setHubStatus('offline', 'Hub bağlantısı yok');
    notify(`Hub'a ulaşılamıyor: ${error.message}`, 'error');
  }
}

setInterval(refresh, 5000);
setInterval(updateCountdowns, 1000);
initialize();
