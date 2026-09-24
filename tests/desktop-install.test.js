import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {runDesktopFlow, readInstallerAsset} from '../src/hub/desktop.js';
import {acknowledgeNetwork, networkStatus} from '../src/hub/network-state.js';

test('double-click opens a healthy installed Hub without elevation and repairs a stopped installation', async () => {
  const actions = [];
  const healthy = await runDesktopFlow({isRunning: () => true, isReady: async () => true,
    install: () => actions.push('elevate'), open: () => actions.push('browser'), attempts: 1});
  assert.equal(healthy, 'opened');
  assert.deepEqual(actions, ['browser']);
  let running = false;
  const repaired = await runDesktopFlow({isRunning: () => running,
    isReady: async () => true, install: () => { actions.push('elevate'); running = true; },
    open: () => actions.push('browser'), attempts: 1});
  assert.equal(repaired, 'installed');
  assert.deepEqual(actions, ['browser', 'elevate', 'browser']);
  const pending = await runDesktopFlow({isRunning: () => true,
    isReady: async () => true, needsSetup: async () => true,
    install: () => actions.push('new-code'), open: () => actions.push('browser'), attempts: 1});
  assert.equal(pending, 'installed');
  assert.deepEqual(actions.slice(-2), ['new-code', 'browser']);
  await assert.rejects(runDesktopFlow({isRunning: () => false,
    isReady: async () => false, install: () => {}, open: () => {}, attempts: 1}),
  /paneli açılamadı/);
  assert.match(readInstallerAsset(), /Register-ScheduledTask/);
  if (process.platform === 'win32') {
    assert.match(execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', 'scripts/install-windows.ps1', '-ExePath', process.execPath, '-WhatIf'],
    {encoding: 'utf8'}), /What if:/i);
  }
});

test('LAN address change persists until administrator acknowledges it', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'portaltakip-network-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const path = join(directory, 'hub.json');
  assert.deepEqual(networkStatus(path, ['192.168.1.10']),
    {previous: ['192.168.1.10'], changed: false});
  assert.deepEqual(networkStatus(path, ['192.168.1.11']),
    {previous: ['192.168.1.10'], changed: true});
  acknowledgeNetwork(path, ['192.168.1.11']);
  assert.deepEqual(networkStatus(path, ['192.168.1.11']),
    {previous: ['192.168.1.11'], changed: false});
});
