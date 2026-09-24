import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createPendingConfig, defaultConfigPath, digest, migrateLegacyConfig,
  readConfig, rotateSetupKey, setupKeyPath, writeSetupKey} from '../src/hub/config.js';

test('Node default uses the machine ProgramData path on Windows', () => {
  if (process.platform === 'win32') {
    assert.equal(defaultConfigPath,
      join(process.env.ProgramData || join(process.env.SystemDrive || 'C:', 'ProgramData'),
        'PortalTakip', 'hub.json'));
  }
});

test('repair rotates an existing protected pending setup code without replacing hub.json', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'portaltakip-setup-repair-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const path = join(directory, 'hub.json');
  const {setupToken} = createPendingConfig(path);
  writeSetupKey(path, setupToken);
  rotateSetupKey(path);
  const replacement = readFileSync(setupKeyPath(path), 'utf8').trim();
  assert.notEqual(replacement, setupToken);
  assert.equal(readConfig(path).setupTokenHash, digest(replacement));
});

test('legacy config is copied without deletion and a leaked pending key can be rotated', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'portaltakip-config-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const legacy = join(directory, 'old', 'hub.json');
  const target = join(directory, 'new', 'hub.json');
  const {setupToken: oldToken} = createPendingConfig(legacy);
  const original = readFileSync(legacy, 'utf8');
  migrateLegacyConfig(legacy, target);
  assert.equal(readFileSync(legacy, 'utf8'), original);
  assert.deepEqual(readConfig(target), readConfig(legacy));
  const keyPath = rotateSetupKey(target);
  assert.equal(keyPath, setupKeyPath(target));
  const newToken = readFileSync(keyPath, 'utf8').trim();
  assert.match(newToken, /^[A-Za-z0-9_-]{20}$/);
  assert.notEqual(newToken, oldToken);
  assert.equal(readConfig(target).setupTokenHash, digest(newToken));
  assert.notEqual(readConfig(target).setupTokenHash, digest(oldToken));
  assert.equal(readFileSync(legacy, 'utf8'), original);
  assert.throws(() => migrateLegacyConfig(legacy, target), {code: 'EEXIST'});
});
