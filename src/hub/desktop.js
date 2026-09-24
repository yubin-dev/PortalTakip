import {execFileSync, spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {closeSync, openSync, readFileSync, readSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {getAsset, isSea} from 'node:sea';
import {defaultConfigPath, readConfig, setupKeyPath} from './config.js';

let panelPort = 8788;
const panelUrl = () => `http://127.0.0.1:${panelPort}/`;
const powershell = (script, environment = {}, timeoutMs = 180_000) => execFileSync('powershell.exe',
  ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')],
  {encoding: 'utf8', stdio: 'pipe', windowsHide: true,
    env: {...process.env, ...environment}, timeout: timeoutMs});

function showMessage(message, title = 'PortalTakip') {
  try {
    powershell(`Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.MessageBox]::Show($env:PORTALTAKIP_DIALOG_TEXT,
  $env:PORTALTAKIP_DIALOG_TITLE, 'OK', 'Warning') | Out-Null`,
    {PORTALTAKIP_DIALOG_TEXT: message, PORTALTAKIP_DIALOG_TITLE: title});
  } catch { process.stderr.write(`${title}: ${message}\n`); }
}

async function panelSession() {
  try {
    const response = await fetch(`${panelUrl()}api/session`, {signal: AbortSignal.timeout(1000)});
    const data = await response.json();
    return response.ok && typeof data.authenticated === 'boolean' ? data : null;
  } catch { return null; }
}
const panelReady = async () => (await panelSession()) !== null;
const setupPending = async () => (await panelSession())?.setupRequired === true;

function installedTaskRunning() {
  try {
    const target = resolve(process.env.ProgramFiles, 'PortalTakip', 'PortalTakip Hub.exe');
    if (resolve(process.execPath).toLowerCase() !== target.toLowerCase()) {
      const hash = (path) => {
        const digest = createHash('sha256');
        const descriptor = openSync(path, 'r');
        const buffer = Buffer.allocUnsafe(64 * 1024);
        try {
          for (;;) {
            const count = readSync(descriptor, buffer, 0, buffer.length, null);
            if (!count) break;
            digest.update(buffer.subarray(0, count));
          }
        } finally { closeSync(descriptor); }
        return digest.digest('hex');
      };
      if (hash(process.execPath) !== hash(target)) return false; // newer EXE: update with UAC
    }
    const result = powershell(`$task = Get-ScheduledTask -TaskName 'PortalTakip Hub' -ErrorAction SilentlyContinue
$expected = Join-Path $env:ProgramFiles 'PortalTakip\\PortalTakip Hub.exe'
if ($task -and $task.State -eq 'Running' -and $task.Actions[0].Execute -ieq $expected) {
  $port = if ($task.Actions[0].Arguments -match '--admin-port\\s+(\\d+)') { [int]$Matches[1] } else { 8788 }
  $listener = Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) {
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
    if ($owner.ExecutablePath -ieq $expected) { $task.Actions[0].Arguments }
  }
}`).trim();
    if (!result) return false;
    const port = /--admin-port\s+(\d+)/.exec(result)?.[1];
    panelPort = port ? Number(port) : 8788;
    return Number.isInteger(panelPort) && panelPort > 0 && panelPort <= 65535;
  } catch { return false; }
}

function elevateAndInstall() {
  showMessage('PortalTakip ilk kurulum, güncelleme veya onarım için Windows yönetici izni isteyecek. Bu izin kalıcı ayar klasörü, açılış görevi ve yerel ağ güvenlik duvarı kuralı içindir. Mevcut kurum ayarları korunur.',
    'PortalTakip · Windows izni');
  const script = `$ErrorActionPreference = 'Stop'
$child = Start-Process -FilePath $env:PORTALTAKIP_DESKTOP_EXE -ArgumentList '--desktop-install' -Verb RunAs -Wait -PassThru
exit $child.ExitCode`;
  powershell(script, {PORTALTAKIP_DESKTOP_EXE: process.execPath}, 600_000);
}

function openPanel() {
  try {
    powershell(`Start-Process -FilePath $env:PORTALTAKIP_PANEL_URL`,
      {PORTALTAKIP_PANEL_URL: panelUrl()});
  } catch {
    showMessage(`Hub çalışıyor, ancak varsayılan tarayıcı açılamadı. Bu bilgisayarda ${panelUrl()} adresini açın.`,
      'PortalTakip · Panel');
  }
}

/** Pure orchestration seam: tests can verify the elevation and recovery decision. */
export async function runDesktopFlow({isRunning, isReady, needsSetup = async () => false,
  install, open,
  attempts = 40, delayMs = 250}) {
  if (isRunning() && await isReady() && !await needsSetup()) { open(); return 'opened'; }
  install();
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (isRunning() && await isReady()) { open(); return 'installed'; }
    if (attempt + 1 < attempts) await new Promise((done) => setTimeout(done, delayMs));
  }
  throw new Error('Kurulum tamamlandı ancak Hub paneli açılamadı. Port 8788 ve PortalTakip Hub açılış görevini kontrol edip uygulamayı yeniden açın.');
}

export async function launchDesktop() {
  try {
    await runDesktopFlow({isRunning: installedTaskRunning, isReady: panelReady,
      needsSetup: setupPending,
      install: elevateAndInstall, open: openPanel});
  } catch (error) {
    const cancelled = /cancel|iptal|vazgeç/i.test(error.message);
    showMessage(cancelled ? 'Windows yönetici izni verilmedi. Kurulum yapılmadı; uygulamayı tekrar açıp izni onaylayın.' :
      'PortalTakip açılamadı. Uygulamayı yeniden açarak onarımı deneyin. Sorun sürerse 8787/8788 portlarını ve Windows Görev Zamanlayıcı durumunu kontrol edin.',
    'PortalTakip · Kurulum/onarım');
    process.exitCode = 1;
  }
}

export function readInstallerAsset() {
  return isSea() ? Buffer.from(getAsset('scripts/install-windows.ps1')).toString('utf8') :
    readFileSync(resolve('scripts/install-windows.ps1'), 'utf8');
}

/** Parses the embedded installer through the same PowerShell scriptblock path, without changes. */
export function dryRunInstaller() {
  const wrapper = `$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PORTALTAKIP_INSTALL_SOURCE))
& ([ScriptBlock]::Create($source)) -ExePath $env:PORTALTAKIP_INSTALL_EXE -WhatIf`;
  return powershell(wrapper, {PORTALTAKIP_INSTALL_SOURCE:
    Buffer.from(readInstallerAsset()).toString('base64'),
  PORTALTAKIP_INSTALL_EXE: process.execPath});
}

function displaySetupCode(configPath) {
  const script = `Add-Type -AssemblyName System.Windows.Forms
$ErrorActionPreference = 'Stop'
$code = [IO.File]::ReadAllText($env:PORTALTAKIP_SETUP_KEY).Trim()
$form = [System.Windows.Forms.Form]::new()
$form.Text = 'PortalTakip · İlk kurulum kodu'
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.Width = 490
$form.Height = 215
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$label = [System.Windows.Forms.Label]::new()
$label.Text = 'Bu kodu tarayıcıdaki ilk kurulum ekranına girin:'
$label.AutoSize = $true
$label.Location = [System.Drawing.Point]::new(24, 22)
$box = [System.Windows.Forms.TextBox]::new()
$box.Text = $code
$box.ReadOnly = $true
$box.Font = [System.Drawing.Font]::new('Consolas', 17)
$box.Location = [System.Drawing.Point]::new(24, 54)
$box.Width = 430
$note = [System.Windows.Forms.Label]::new()
$note.Text = 'Kodu yalnızca Hub bilgisayarında kullanın. Pano otomatik doldurulmaz.'
$note.AutoSize = $true
$note.Location = [System.Drawing.Point]::new(24, 99)
$button = [System.Windows.Forms.Button]::new()
$button.Text = 'Kapat'
$button.Location = [System.Drawing.Point]::new(370, 126)
$button.Add_Click({ $form.Close() })
$form.Controls.AddRange(@($label, $box, $note, $button))
[void]$form.ShowDialog()`;
  const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')],
  {detached: true, windowsHide: true, stdio: 'ignore',
    env: {...process.env, PORTALTAKIP_SETUP_KEY: setupKeyPath(configPath)}});
  child.unref();
}

/** Elevated child of the double-click launcher. No secret is put in arguments or URL. */
export function installFromDesktop() {
  try {
    const source = readInstallerAsset();
    const wrapper = `$ErrorActionPreference = 'Stop'
$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PORTALTAKIP_INSTALL_SOURCE))
& ([ScriptBlock]::Create($source)) -ExePath $env:PORTALTAKIP_INSTALL_EXE -LegacyPath $env:PORTALTAKIP_LEGACY_PATH`;
    powershell(wrapper, {PORTALTAKIP_INSTALL_SOURCE: Buffer.from(source).toString('base64'),
      PORTALTAKIP_INSTALL_EXE: process.execPath,
      PORTALTAKIP_LEGACY_PATH: resolve(dirname(process.execPath), '..', 'data', 'hub.json')});
    const configPath = defaultConfigPath;
    if (readConfig(configPath).state === 'pending') displaySetupCode(configPath);
  } catch (error) {
    const lines = String(error.stderr || error.message).trim().split(/\r?\n/)
      .map((line) => line.trim()).filter(Boolean);
    const detail = (lines.find((line) => /Port \d+|Hub paneli|izin|onar|ayar|görev/i.test(line)) ??
      lines[0] ?? 'Bilinmeyen kurulum hatası.').slice(0, 500);
    showMessage(`Kurulum veya onarım tamamlanamadı. Mevcut kurum ayarları silinmedi.\n\n${detail}\n\nPort çakışmasını giderip PortalTakip Hub.exe dosyasını yeniden açın.`,
      'PortalTakip · Onarım gerekli');
    process.exitCode = 1;
  }
}
