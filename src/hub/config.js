import {createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';

// The Node entry point, SEA executable and SYSTEM startup task use this same path.
// PORTALTAKIP_CONFIG remains an explicit development/test override.
export const defaultConfigPath = process.platform === 'win32' ?
  join(process.env.ProgramData || join(process.env.SystemDrive || 'C:', 'ProgramData'),
    'PortalTakip', 'hub.json') : resolve('data/hub.json');

export const configuredPath = () => resolve(process.env.PORTALTAKIP_CONFIG || defaultConfigPath);
export const setupKeyPath = (path) => join(dirname(path), 'setup-key.txt');

// PowerShell sets an exact DACL: only LOCAL SYSTEM and Builtin Administrators.
// Environment conveys a path, never a secret; no ACL command output is logged.
const aclScript = `
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -and
    $identity.User.Value -ne 'S-1-5-18') { throw 'Administrator or SYSTEM required' }
$path = $env:PORTALTAKIP_ACL_PATH
$item = Get-Item -LiteralPath $path -ErrorAction Stop
$acl = Get-Acl -LiteralPath $path
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { $acl.PurgeAccessRules($rule.IdentityReference) }
$inherit = if ($item.PSIsContainer) {
  [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
} else { [Security.AccessControl.InheritanceFlags]::None }
foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
  $identityRef = [Security.Principal.SecurityIdentifier]::new($sid)
  $access = [Security.AccessControl.FileSystemAccessRule]::new(
    $identityRef, [Security.AccessControl.FileSystemRights]::FullControl,
    $inherit, [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($access)
}
Set-Acl -LiteralPath $path -AclObject $acl
`;

const adminCheckScript = `
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -and
    $identity.User.Value -ne 'S-1-5-18') { exit 1 }
`;

function requirePersistentAccess(path) {
  if (process.platform !== 'win32' || resolve(path) !== resolve(defaultConfigPath)) return;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(adminCheckScript, 'utf16le').toString('base64')], {stdio: 'pipe'});
  } catch {
    throw new Error('Kalıcı Hub ayarı için yönetici olarak açılmış PowerShell gerekir.');
  }
}

export function securePersistentPath(path) {
  if (process.platform !== 'win32' || resolve(path) !== resolve(defaultConfigPath) &&
      resolve(path) !== resolve(dirname(defaultConfigPath)) &&
      resolve(path) !== resolve(setupKeyPath(defaultConfigPath))) return;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(aclScript, 'utf16le').toString('base64')], {
      env: {...process.env, PORTALTAKIP_ACL_PATH: path}, stdio: 'pipe',
    });
  } catch {
    throw new Error('Kalıcı Hub ayar izinleri ayarlanamadı; yönetici olarak açılmış PowerShell gerekir.');
  }
}

function prepareDirectory(path) {
  requirePersistentAccess(path);
  mkdirSync(dirname(path), {recursive: true});
  securePersistentPath(dirname(path));
}

export function writeSetupKey(path, token) {
  prepareDirectory(path);
  const keyPath = setupKeyPath(path);
  const temporary = `${keyPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, token + '\n', {flag: 'wx', mode: 0o600});
    // The directory DACL protects the temporary file before it is renamed.
    renameSync(temporary, keyPath);
    securePersistentPath(keyPath);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return keyPath;
}

export function discardSetupKey(path) {
  try { unlinkSync(setupKeyPath(path)); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export function newSecret() {
  return randomBytes(32).toString('base64url');
}

export function digest(secret) {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function matches(secret, expectedHex) {
  if (typeof secret !== 'string' || typeof expectedHex !== 'string' ||
      !/^[a-f0-9]{64}$/.test(expectedHex)) return false;
  const actual = Buffer.from(digest(secret), 'hex');
  return timingSafeEqual(actual, Buffer.from(expectedHex, 'hex'));
}

export function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  if (/^[a-f0-9]{64}$/.test(stored)) return matches(password, stored); // v1 migration
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt' ||
      !/^[a-f0-9]{32}$/.test(parts[1]) || !/^[a-f0-9]{128}$/.test(parts[2])) {
    return false;
  }
  const actual = scryptSync(password, Buffer.from(parts[1], 'hex'), 64);
  return timingSafeEqual(actual, Buffer.from(parts[2], 'hex'));
}

export function createPendingConfig(path = defaultConfigPath) {
  const setupToken = newSecret();
  const config = {version: 2, state: 'pending', setupTokenHash: digest(setupToken)};
  prepareDirectory(path);
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  securePersistentPath(path);
  return {config, setupToken};
}

export function migrateLegacyConfig(source, target = defaultConfigPath) {
  if (resolve(source) === resolve(target)) throw new Error('Eski ve yeni ayar yolu aynı olamaz.');
  const config = readConfig(source);
  prepareDirectory(target);
  writeFileSync(target, JSON.stringify(config, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  securePersistentPath(target);
  return config;
}

export function rotateSetupKey(path = defaultConfigPath) {
  const config = readConfig(path);
  if (config.state !== 'pending') throw new Error('İlk kurulum tamamlandı; kurulum anahtarı artık geçerli değil.');
  const token = newSecret();
  // Write the protected secret first, then make its hash current. On failure,
  // the operation can safely be retried without deleting the configuration.
  const keyPath = writeSetupKey(path, token);
  saveConfig(path, {...config, setupTokenHash: digest(token)});
  return keyPath;
}

export function completeSetup(organizationName, adminPassword) {
  const organizationCode = newSecret();
  return {organizationCode, config: {
    version: 2, state: 'ready', organizationId: randomUUID(),
    organizationName, organizationCodeHash: digest(organizationCode),
    adminPasswordHash: hashPassword(adminPassword), staff: [],
  }};
}

export function createInitialConfig(path = defaultConfigPath) {
  const organizationCode = newSecret();
  const adminPassword = newSecret();
  const config = {
    version: 1,
    organizationId: randomUUID(),
    organizationCodeHash: digest(organizationCode),
    adminPasswordHash: digest(adminPassword),
    staff: [],
  };
  prepareDirectory(path);
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  securePersistentPath(path);
  return {config, organizationCode, adminPassword};
}

export function readConfig(path = defaultConfigPath) {
  let contents;
  try { contents = readFileSync(path, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`Hub ayarları bulunamadı: ${path}. Önce hub:init veya EXE --prepare çalıştırın.`);
    }
    throw error;
  }
  const config = JSON.parse(contents);
  if (config.version === 2 && config.state === 'pending' &&
      /^[a-f0-9]{64}$/.test(config.setupTokenHash)) return config;
  if (!((config.version === 1) || (config.version === 2 && config.state === 'ready')) ||
      typeof config.organizationId !== 'string' ||
      !/^[a-f0-9]{64}$/.test(config.organizationCodeHash) ||
      typeof config.adminPasswordHash !== 'string' ||
      !Array.isArray(config.staff)) {
    throw new Error('Invalid Hub configuration');
  }
  return config;
}

export function saveConfig(path, config) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  renameSync(temporary, path);
}
