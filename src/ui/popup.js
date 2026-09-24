import {validateConnectionInput} from './connection-input.js';

const $ = (id) => document.getElementById(id);
const fields = ['displayName', 'organizationName', 'host', 'port',
  'organizationCode', 'staffToken'];
const phaseLabels = {
  disconnected: 'Bağlı değil', connecting: 'Bağlanıyor', connected: 'Bağlı',
  retrying: 'Yeniden deneniyor', error: 'Bağlantı hatası',
};
let busy = false;

function setMessage(text) { $('message').textContent = text; }
function setBusy(value) {
  busy = value;
  $('connectButton').disabled = value;
  $('disconnectButton').disabled = value;
}

function renderStatus(status) {
  const phase = Object.hasOwn(phaseLabels, status?.phase) ? status.phase : 'error';
  $('connectionStatus').textContent = phaseLabels[phase];
  $('connectionDetail').textContent = typeof status?.detail === 'string' ? status.detail : '';
  $('statusDot').className = `status-dot ${phase}`;
  if (phase === 'connected') {
    $('gibStatus').textContent = `${Number(status?.ownGibHeld) || 0} kilit · ${Number(status?.ownGibQueued) || 0} sıra`;
    $('sgkStatus').textContent = `${Number(status?.ownSgkHeld) || 0} kilit · ${Number(status?.ownSgkQueued) || 0} sıra`;
    $('organizationCode').value = '';
    $('staffToken').value = '';
  } else {
    $('gibStatus').textContent = '—';
    $('sgkStatus').textContent = '—';
  }
}

async function request(type, config) {
  const reply = await chrome.runtime.sendMessage({type, ...(config ? {config} : {})});
  if (!reply?.ok) throw new Error(reply?.error ?? 'Background worker yanıt vermedi.');
  return reply;
}

async function initialize() {
  await chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
  // Never restore or persist connection secrets in disk-backed local storage.
  await chrome.storage.local.remove(['organizationCode', 'staffToken']);
  const saved = await chrome.storage.local.get(['displayName', 'organizationName', 'host', 'port']);
  for (const field of ['displayName', 'organizationName', 'host', 'port']) {
    if (typeof saved[field] === 'string' || typeof saved[field] === 'number') {
      $(field).value = String(saved[field]);
    }
  }
  renderStatus((await request('PT_GET_STATUS')).status);
}

$('connectionForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  for (const field of fields) $(field).removeAttribute('aria-invalid');
  const raw = Object.fromEntries(fields.map((field) => [field, $(field).value]));
  const result = validateConnectionInput(raw);
  if (!result.ok) {
    if ($(result.field)) {
      $(result.field).setAttribute('aria-invalid', 'true');
      $(result.field).focus();
    }
    setMessage(result.message);
    return;
  }
  setBusy(true);
  setMessage('');
  try {
    const {displayName, organizationName, host, port} = result.value;
    await chrome.storage.local.set({displayName, organizationName, host, port});
    renderStatus((await request('PT_CONNECT', result.value)).status);
  } catch (error) { setMessage(error.message); }
  finally { setBusy(false); }
});

$('disconnectButton').addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);
  setMessage('');
  try {
    renderStatus((await request('PT_DISCONNECT')).status);
    $('organizationCode').value = '';
    $('staffToken').value = '';
  } catch (error) { setMessage(error.message); }
  finally { setBusy(false); }
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id === chrome.runtime.id && message?.type === 'PT_STATUS_UPDATE') {
    renderStatus(message.status);
  }
});

initialize().catch((error) => {
  renderStatus({phase: 'error', detail: 'Eklenti ayarları okunamadı.'});
  setMessage(error.message);
});
