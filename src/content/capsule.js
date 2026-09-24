// Runs in Chrome's isolated content-script world on the allowlisted portals.
// All Hub traffic and credentials stay in the extension background worker.
(() => {
  const host = document.createElement('div');
  host.id = 'portaltakip-capsule';
  host.style.position = 'fixed';
  host.style.top = '16px';
  host.style.right = '16px';
  host.style.zIndex = '2147483647';
  host.style.width = '304px';
  host.style.fontFamily = 'system-ui, sans-serif';
  const root = host.attachShadow({mode: 'closed'});
  const make = (tag, parent, className, label) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (label !== undefined) node.textContent = label;
    parent.append(node);
    return node;
  };
  const css = make('style', root);
  css.textContent = `
    :host { color-scheme: dark; }
    * { box-sizing: border-box; }
    .card { color: #edf5f4; background: #14242d; border: 1px solid #42717a;
      border-radius: 14px; box-shadow: 0 12px 36px #0009; overflow: hidden;
      font: 13px/1.45 system-ui, sans-serif; }
    .head { display: flex; align-items: center; justify-content: space-between;
      gap: 8px; padding: 10px 12px; background: #203a43; cursor: move;
      user-select: none; touch-action: none; }
    .title { font-weight: 750; letter-spacing: .2px; }
    .mode { padding: 3px 8px; border-radius: 99px; background: #40505a;
      color: #fff; font-size: 11px; font-weight: 700; }
    .mode.mine { background: #126e5a; } .mode.busy { background: #854c19; }
    .mode.queued { background: #325d96; } .mode.offline,
    .mode.reconnecting { background: #734351; }
    .body { padding: 11px 12px 12px; display: grid; gap: 9px; }
    .hint { color: #b8cbd0; font-size: 11px; }
    .row { display: flex; align-items: center; gap: 7px; }
    label { display: block; font-size: 11px; color: #bfd5d7; }
    select, input, button { font: inherit; }
    select, input { width: 100%; min-width: 0; color: #f0f8f8; background: #0c1c24;
      border: 1px solid #56767d; border-radius: 7px; padding: 7px; }
    input::placeholder { color: #93a9ac; }
    button { border: 0; border-radius: 7px; padding: 8px 10px; color: #09231f;
      background: #7be0c4; font-weight: 700; cursor: pointer; }
    button.secondary { background: #b9ccd1; color: #17272c; }
    button:disabled { opacity: .45; cursor: default; }
    button:focus-visible, input:focus-visible, select:focus-visible {
      outline: 2px solid #fff; outline-offset: 2px; }
    .actions button { flex: 1; }
    .code { display: block; overflow-wrap: anywhere; color: #9de9d6;
      font: 11px/1.4 ui-monospace, monospace; }
    .detail { min-height: 18px; color: #d1e0e2; }
    .error { color: #ffbdac; min-height: 15px; }
    details { border-top: 1px solid #37535c; padding-top: 8px; }
    summary { cursor: pointer; color: #b8ded8; }
    .form { display: grid; gap: 6px; padding-top: 8px; }
    .toggles { display: flex; gap: 12px; color: #bfd5d7; }
    .toggles label { display: flex; align-items: center; gap: 4px; }
    .toggles input { width: auto; }
    .overlay { position: fixed; inset: 0; z-index: 2147483647; display: grid;
      place-items: center; background: #07161add; padding: 18px; }
    .overlay[hidden] { display: none; }
    .dialog { width: min(360px, 100%); padding: 18px; border: 2px solid #7be0c4;
      border-radius: 12px; color: #edf5f4; background: #14242d;
      box-shadow: 0 15px 48px #000b; }
    .dialog h2 { margin: 0 0 8px; font-size: 18px; }
    .dialog p { margin: 0 0 12px; }
    .toast { position: fixed; top: 18px; left: 50%; transform: translateX(-50%);
      background: #126e5a; color: white; border-radius: 8px; padding: 10px 14px;
      box-shadow: 0 8px 24px #0008; z-index: 2147483647; }
    .toast[hidden] { display: none; }
  `;
  const card = make('section', root, 'card');
  card.setAttribute('aria-label', 'PortalTakip erişim kapsülü');
  const head = make('div', card, 'head');
  const title = make('span', head, 'title', 'PortalTakip');
  const badge = make('span', head, 'mode', 'Bağlanıyor');
  const body = make('div', card, 'body');
  const accountLabel = make('label', body, '', 'Aktif ortak hesap kodu');
  const accountSelect = make('select', accountLabel);
  accountSelect.setAttribute('aria-label', 'Ortak hesap seçimi');
  const activeCode = make('code', body, 'code', 'Hesap seçilmedi');
  const detail = make('div', body, 'detail');
  detail.setAttribute('role', 'status');
  const actions = make('div', body, 'row actions');
  const acquireButton = make('button', actions, '', 'Kilit iste');
  const leaveButton = make('button', actions, 'secondary', 'Bırak / sıradan çık');
  const error = make('div', body, 'error');
  error.setAttribute('role', 'alert');
  const accountDetails = make('details', body);
  make('summary', accountDetails, '', 'Ortak hesap kodu ekle');
  const accountForm = make('form', accountDetails, 'form');
  const labelInput = make('input', accountForm);
  labelInput.placeholder = 'Hesap takma adı';
  labelInput.maxLength = 40;
  labelInput.required = true;
  labelInput.setAttribute('aria-label', 'Hesap takma adı');
  const codeInput = make('input', accountForm);
  codeInput.placeholder = 'Yöneticinin paylaştığı rastgele kod';
  codeInput.minLength = 16;
  codeInput.maxLength = 128;
  codeInput.required = true;
  codeInput.autocomplete = 'off';
  codeInput.spellcheck = false;
  codeInput.setAttribute('aria-label', 'Ortak hesap kodu');
  make('div', accountForm, 'hint', 'Aynı hesabı kullananlar aynı yönetici kodunu seçmeli. Vergi numarası veya portal şifresi girmeyin.');
  make('button', accountForm, '', 'Ekle ve seç');
  const toggles = make('div', body, 'toggles');
  const shortcutLabel = make('label', toggles, '', 'Kısayollar');
  const shortcutToggle = make('input', shortcutLabel);
  shortcutToggle.type = 'checkbox';
  const soundLabel = make('label', toggles, '', 'Sıra sesi');
  const soundToggle = make('input', soundLabel);
  soundToggle.type = 'checkbox';
  make('div', body, 'hint', 'Kısayollar açıkken Ctrl+Ç: iste · Ctrl+K: bırak/çık. Portal kısayolları için kapalı tutabilirsiniz.');
  const overlay = make('div', root, 'overlay');
  overlay.hidden = true;
  const dialog = make('section', overlay, 'dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'Kilit kullanım teyidi');
  make('h2', dialog, '', 'Hâlâ bu hesapta mısınız?');
  const confirmText = make('p', dialog);
  const confirmButton = make('button', dialog, '', 'Evet, devam ediyorum');
  const toast = make('div', root, 'toast');
  toast.hidden = true;
  toast.setAttribute('role', 'status');

  let payload = null;
  let confirmationStart = 0;
  let confirmationRemainingMs = null;
  let confirmationKey = null;
  let confirmPending = false;
  let toastTimer;
  let soundContext;

  function message(type, fields = {}) {
    return chrome.runtime.sendMessage({type, ...fields}).catch(() =>
      ({ok: false, error: 'Eklenti arka planına ulaşılamadı.'}));
  }
  function showError(text) { error.textContent = text || ''; }
  function render(next) {
    if (!next?.view || !Array.isArray(next.accounts)) return;
    payload = next;
    const {view, accounts} = next;
    const old = accountSelect.value;
    accountSelect.replaceChildren();
    const placeholder = make('option', accountSelect, '', 'Hesap seçin');
    placeholder.value = '';
    for (const account of accounts) {
      const option = make('option', accountSelect, '', account.label);
      option.value = account.id;
    }
    accountSelect.value = view.accountId ?? '';
    if (accountSelect.value !== (view.accountId ?? '')) accountSelect.value = old;
    accountSelect.disabled = ['mine', 'queued', 'offline', 'reconnecting', 'syncing'].includes(view.mode);
    activeCode.textContent = view.accountCode ?? 'Hesap seçilmedi';
    const modes = {
      offline: ['Kopuk', 'Hub bağlantısı yok. Kilit sizde kabul edilmiyor.'],
      reconnecting: ['Yeniden bağlanıyor', 'Hub durumuyla yeniden eşitleniyor.'],
      syncing: ['Yeniden bağlanıyor', 'Hub snapshot’ı bekleniyor.'],
      accountRequired: ['Boş', 'Kilit istemeden önce ortak hesap kodu seçin.'],
      empty: ['Boş', 'Bu hesap için kilit boş.'],
      mine: ['Sizde', 'Bu hesap için kilit sizde.'],
      busy: ['Meşgul', view.holderName ? `Kilit: ${view.holderName}` : 'Bu hesap kullanımda.'],
      queued: ['Sırada', `Sıra: ${view.queuePosition ?? '?'}${view.holderName ? ` · Kilit: ${view.holderName}` : ''}`],
    };
    const [modeText, detailText] = modes[view.mode] ?? modes.offline;
    badge.textContent = modeText;
    badge.className = 'mode ' + view.mode;
    detail.textContent = detailText;
    acquireButton.disabled = !view.accountCode || !['empty', 'busy'].includes(view.mode);
    leaveButton.disabled = !['mine', 'queued'].includes(view.mode);
    const nextKey = view.mode === 'mine' && Number.isFinite(view.confirmationDeadlineAt) ?
      `${view.accountCode}:${view.confirmationDeadlineAt}` : null;
    if (nextKey !== confirmationKey) {
      confirmationKey = nextKey;
      confirmPending = false;
    }
    overlay.hidden = nextKey === null;
    if (nextKey !== null) {
      confirmationStart = performance.now();
      confirmationRemainingMs = view.confirmationRemainingMs;
      updateCountdown();
    }
    confirmButton.disabled = confirmPending;
  }
  function updateCountdown() {
    if (overlay.hidden || confirmationRemainingMs === null) return;
    const remaining = Math.max(0, confirmationRemainingMs - (performance.now() - confirmationStart));
    confirmText.textContent = remaining > 0 ?
      `Sunucunun teyit penceresinde yaklaşık ${Math.ceil(remaining / 1000)} saniye kaldı.` :
      'Teyit süresi doldu; Hub yanıtı bekleniyor.';
  }
  function showToast(text) {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 7000);
  }
  async function playSound() {
    if (!soundToggle.checked) return;
    try {
      soundContext ??= new AudioContext();
      await soundContext.resume();
      const oscillator = soundContext.createOscillator();
      const gain = soundContext.createGain();
      oscillator.frequency.value = 784;
      gain.gain.value = 0.04;
      oscillator.connect(gain).connect(soundContext.destination);
      oscillator.start();
      oscillator.stop(soundContext.currentTime + 0.18);
    } catch { /* sound is optional */ }
  }
  soundToggle.addEventListener('change', (event) => {
    if (!event.isTrusted || !soundToggle.checked) return;
    try {
      soundContext ??= new AudioContext();
      void soundContext.resume().catch(() => {});
    } catch { /* notification still appears if audio is unavailable */ }
  });
  async function operation(action) {
    showError('');
    const response = await message('PT_ACTION', {action});
    if (!response?.ok) showError(response?.error ?? 'İşlem gönderilemedi.');
  }
  accountSelect.addEventListener('change', async (event) => {
    if (!event.isTrusted || !accountSelect.value) return;
    showError('');
    const response = await message('PT_ACCOUNT_SELECT', {accountId: accountSelect.value});
    if (response?.ok) render(response);
    else { showError(response?.error); if (payload) render(payload); }
  });
  accountForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!event.isTrusted) return;
    showError('');
    const response = await message('PT_ACCOUNT_ADD', {
      label: labelInput.value.trim(), accountCode: codeInput.value.trim(),
    });
    if (response?.ok) {
      codeInput.value = '';
      labelInput.value = '';
      accountDetails.open = false;
      render(response);
    } else showError(response?.error);
  });
  acquireButton.addEventListener('click', (event) => {
    if (event.isTrusted && !acquireButton.disabled) void operation('ACQUIRE');
  });
  leaveButton.addEventListener('click', (event) => {
    if (event.isTrusted && !leaveButton.disabled) void operation('LEAVE');
  });
  confirmButton.addEventListener('click', async (event) => {
    if (!event.isTrusted || confirmPending) return;
    confirmPending = true;
    confirmButton.disabled = true;
    const response = await message('PT_CONFIRM');
    if (!response?.ok) {
      showError(response?.error ?? 'Teyit gönderilemedi.');
      confirmPending = false;
      confirmButton.disabled = false;
    }
  });
  function editable(event) {
    const path = event.composedPath?.() ?? [event.target];
    path.push(document.activeElement);
    return path.some((item) => item instanceof Element && (
      item.matches('input, textarea, select, [contenteditable], [role="textbox"]') ||
      item.isContentEditable));
  }
  window.addEventListener('keydown', (event) => {
    if (!shortcutToggle.checked || !event.isTrusted || event.defaultPrevented ||
        event.repeat || event.isComposing || !event.ctrlKey || event.altKey ||
        event.metaKey || event.shiftKey || editable(event)) return;
    const key = event.key.toLocaleLowerCase('tr-TR');
    if (key === 'ç' && !acquireButton.disabled) {
      event.preventDefault();
      void operation('ACQUIRE');
    } else if (key === 'k' && !leaveButton.disabled) {
      event.preventDefault();
      void operation('LEAVE');
    }
  });
  head.addEventListener('pointerdown', (event) => {
    if (!event.isTrusted || event.button !== 0) return;
    event.preventDefault();
    const bounds = host.getBoundingClientRect();
    const offsetX = event.clientX - bounds.left;
    const offsetY = event.clientY - bounds.top;
    head.setPointerCapture(event.pointerId);
    const move = (pointer) => {
      const x = Math.max(0, Math.min(innerWidth - bounds.width, pointer.clientX - offsetX));
      const y = Math.max(0, Math.min(innerHeight - bounds.height, pointer.clientY - offsetY));
      host.style.left = `${x}px`;
      host.style.top = `${y}px`;
      host.style.right = 'auto';
    };
    const done = () => {
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', done);
      head.removeEventListener('pointercancel', done);
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', done);
    head.addEventListener('pointercancel', done);
  });
  chrome.runtime.onMessage.addListener((incoming, sender) => {
    if (sender.id !== chrome.runtime.id) return;
    if (incoming?.type === 'PT_PORTAL_UPDATE') render(incoming);
    if (incoming?.type === 'PT_ACTION_RESULT' && !incoming.ok) {
      showError(incoming.code ?? 'Hub işlemi reddetti.');
    }
    if (incoming?.type === 'PT_TURN') {
      showToast('Sıra sizde. Bu hesap için kilit artık sizde.');
      void playSound();
    }
  });
  (document.body ?? document.documentElement).append(host);
  void message('PT_CONTENT_INIT').then((response) => {
    if (response?.ok) render(response);
    else showError(response?.error ?? 'Durum alınamadı.');
  });
  // A restarted MV3 worker loses its in-memory tab subscriptions; re-register.
  setInterval(() => {
    void message('PT_CONTENT_INIT').then((response) => {
      if (response?.ok) render(response);
    });
  }, 10_000);
  setInterval(updateCountdown, 250);
})();
