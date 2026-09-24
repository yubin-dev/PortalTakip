import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {networkInterfaces} from 'node:os';
import WebSocket, {WebSocketServer} from 'ws';
import {createSemaphoreState} from '../core/semaphore-state.js';
import {completeSetup, defaultConfigPath, digest, discardSetupKey, hashPassword, matches, newSecret, readConfig,
  saveConfig, verifyPassword} from './config.js';
import {readAdminAsset} from './admin-assets.js';
import {MAX_ADMIN_BYTES, MAX_WS_BYTES, exactObject, validAccountCode,
  validPortal, validRequestId, validateClientMessage} from './protocol.js';
import {createRateLimiter} from './rate-limit.js';

const adminFiles = new Map([
  ['/', ['admin/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['admin/app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['admin/style.css', 'text/css; charset=utf-8']],
]);
const SESSION_IDLE_MS = 30 * 60_000;
const SESSION_ABSOLUTE_MS = 8 * 60 * 60_000;

function json(response, status, body, headers = {}) {
  response.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', ...headers});
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw Object.assign(new Error('JSON_REQUIRED'), {status: 415});
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_ADMIN_BYTES) throw Object.assign(new Error('TOO_LARGE'), {status: 413});
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('INVALID_JSON'), {status: 400});
  }
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Starts the LAN WebSocket service and loopback-only administrator HTTP service.
 * stateClock is an in-process test seam for the RAM semaphore and STATE serverTime;
 * the Windows entry point uses the real clock.
 */
export async function startHub({configPath = defaultConfigPath, wsHost = '0.0.0.0',
  wsPort = 8787, adminPort = 8788, stateClock = {}} = {}) {
  let config = readConfig(configPath);
  const hubId = randomUUID(); // changes on every process start; all core state is new RAM
  const limiter = createRateLimiter();
  const adminSessions = new Map();
  const activeByUser = new Map();
  const activeBySocket = new Map();
  const clientsByWs = new WeakMap();
  const wss = new WebSocketServer({noServer: true, maxPayload: MAX_WS_BYTES,
    perMessageDeflate: false});
  let broadcastPending = false;
  let adminAddress;
  let closing = false;

  const state = createSemaphoreState({...stateClock, onEvent(event) {
    if (event.type === 'socket_kicked') {
      const client = activeBySocket.get(event.socketId);
      if (client) {
        activeBySocket.delete(event.socketId);
        activeByUser.delete(client.auth.userId);
        client.auth = null;
        send(client.ws, {type: 'ERROR', code: 'KICKED'});
        client.ws.close(4003, 'KICKED');
      }
    }
    scheduleBroadcast();
  }});
  for (const staff of config.staff ?? []) {
    if (staff.disabled === true) {
      state.kick({organizationId: config.organizationId, userId: staff.userId,
        requestId: randomUUID(), adminContext: {authorized: true,
          organizationId: config.organizationId}});
    }
  }

  function send(ws, message) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 1024 * 1024) { ws.terminate(); return; }
    ws.send(JSON.stringify(message));
  }

  function sendState(client, reason, requestId, reset = false) {
    if (!client.auth) return;
    send(client.ws, {type: 'STATE', hubId, serverTime: stateClock.now?.() ?? Date.now(),
      organizationId: config.organizationId,
      reason, reset, ...(requestId ? {requestId} : {}),
      ...state.getSnapshot({organizationId: config.organizationId})});
  }

  function scheduleBroadcast() {
    if (broadcastPending || closing) return;
    broadcastPending = true;
    queueMicrotask(() => {
      broadcastPending = false;
      if (closing) return;
      for (const client of activeBySocket.values()) sendState(client, 'CHANGE');
    });
  }

  const lanServer = createServer({maxHeaderSize: 8192}, (_request, response) => {
    response.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'});
    response.end('Not found');
  });
  lanServer.maxHeadersCount = 32;
  lanServer.headersTimeout = 10_000;
  lanServer.requestTimeout = 10_000;

  lanServer.on('upgrade', (request, socket, head) => {
    const ip = request.socket.remoteAddress ?? 'unknown';
    const origin = request.headers.origin;
    if (config.state === 'pending') {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (request.url !== '/ws' || !limiter.allow('upgrade', ip, 30) ||
        (origin && (typeof origin !== 'string' ||
          !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)))) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    try {
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
    } catch {
      socket.destroy();
    }
  });

  wss.on('connection', (ws, request) => {
    const ip = request.socket.remoteAddress ?? 'unknown';
    const client = {ws, ip, socketId: randomUUID(), auth: null, alive: true};
    clientsByWs.set(ws, client);
    const helloTimer = setTimeout(() => ws.close(4001, 'HELLO_REQUIRED'), 10_000);
    ws.on('pong', () => { client.alive = true; });
    ws.on('message', (buffer, isBinary) => {
      if (!limiter.allow('message-ip', ip, 600) ||
          !limiter.allow('message-socket', client.socketId, 120)) {
        send(ws, {type: 'ERROR', code: 'RATE_LIMIT'});
        ws.close(4008, 'RATE_LIMIT');
        return;
      }
      if (isBinary || buffer.length > MAX_WS_BYTES) {
        send(ws, {type: 'ERROR', code: 'INVALID_MESSAGE'});
        ws.close(1009, 'INVALID_MESSAGE');
        return;
      }
      let message;
      try { message = JSON.parse(buffer.toString('utf8')); } catch {
        send(ws, {type: 'ERROR', code: 'INVALID_JSON'});
        return;
      }
      const validated = validateClientMessage(message, !!client.auth);
      if (!validated.ok) {
        send(ws, {type: 'ERROR', requestId: validRequestId(message?.requestId) ?
          message.requestId : undefined, code: validated.code});
        return;
      }
      if (!client.auth) {
        if (!limiter.allow('hello', ip, 20) ||
            !matches(message.organizationCode, config.organizationCodeHash)) {
          send(ws, {type: 'ERROR', code: 'AUTH_FAILED'});
          ws.close(4003, 'AUTH_FAILED');
          return;
        }
        const staff = config.staff.find((entry) => matches(message.staffToken, entry.tokenHash));
        if (!staff) {
          send(ws, {type: 'ERROR', code: 'AUTH_FAILED'});
          ws.close(4003, 'AUTH_FAILED');
          return;
        }
        if (state.isKicked({organizationId: config.organizationId, userId: staff.userId})) {
          send(ws, {type: 'ERROR', code: 'KICKED'});
          ws.close(4003, 'KICKED');
          return;
        }
        clearTimeout(helloTimer);
        const old = activeByUser.get(staff.userId);
        if (old) {
          activeBySocket.delete(old.socketId);
          old.auth = null;
          state.disconnect({socketId: old.socketId});
          old.ws.close(4000, 'REPLACED');
        }
        client.auth = {userId: staff.userId, displayName: staff.displayName,
          organizationId: config.organizationId, socketId: client.socketId};
        activeByUser.set(staff.userId, client);
        activeBySocket.set(client.socketId, client);
        const reset = message.lastHubId !== hubId;
        send(ws, {type: 'HELLO', status: 'ok', hubId, connectionId: client.socketId,
          userId: staff.userId, displayName: staff.displayName, stateReset: reset});
        sendState(client, 'HELLO', undefined, reset);
        return;
      }
      if (message.type === 'STATE') {
        sendState(client, 'REQUEST', message.requestId);
        return;
      }
      const input = {...client.auth, portal: message.portal,
        accountCode: message.accountCode, requestId: message.requestId};
      const method = {ACQUIRE: 'acquire', RELEASE: 'release',
        CANCEL: 'cancel', CONFIRM: 'confirmPresence'}[message.type];
      const result = state[method](input);
      if (result.ok) {
        send(ws, {type: message.type, requestId: message.requestId,
          status: result.status, ...(result.position !== undefined ?
            {position: result.position} : {})});
      } else {
        send(ws, {type: 'ERROR', requestId: message.requestId, code: result.code});
      }
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (client.auth && !closing) {
        activeBySocket.delete(client.socketId);
        if (activeByUser.get(client.auth.userId) === client) {
          activeByUser.delete(client.auth.userId);
        }
        state.disconnect({socketId: client.socketId});
      }
    });
    ws.on('error', () => {});
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const client = clientsByWs.get(ws);
      if (client?.alive === false) { ws.terminate(); continue; }
      if (client) client.alive = false;
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }
  }, 30_000);

  const adminServer = createServer({maxHeaderSize: 8192}, async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    const host = `127.0.0.1:${adminAddress?.port ?? adminPort}`;
    if (request.socket.remoteAddress !== '127.0.0.1' || request.headers.host !== host ||
        !limiter.allow('admin-http', request.socket.remoteAddress, 240)) {
      json(response, 403, {error: 'FORBIDDEN'});
      return;
    }
    if (request.method === 'POST' && request.headers.origin !== `http://${host}`) {
      json(response, 403, {error: 'ORIGIN_REQUIRED'});
      return;
    }
    let pathname;
    try { pathname = new URL(request.url, `http://${host}`).pathname; } catch {
      json(response, 400, {error: 'INVALID_URL'});
      return;
    }
    const cookie = /(?:^|;\s*)portal_admin=([^;]+)/.exec(request.headers.cookie ?? '')?.[1];
    const session = cookie ? adminSessions.get(digest(cookie)) : null;
    const validSession = session && Date.now() < session.expiresAt &&
      Date.now() < session.absoluteUntil;
    if (session && !validSession) adminSessions.delete(digest(cookie));
    if (validSession) session.expiresAt = Date.now() + SESSION_IDLE_MS;

    try {
      if (request.method === 'GET' && adminFiles.has(pathname)) {
        const [file, contentType] = adminFiles.get(pathname);
        response.writeHead(200, {'Content-Type': contentType});
        response.end(readAdminAsset(file.slice('admin/'.length)));
        return;
      }
      if (request.method === 'GET' && pathname === '/api/session') {
        json(response, 200, validSession ? {authenticated: true, csrfToken: session.csrfToken} :
          {authenticated: false, setupRequired: config.state === 'pending'});
        return;
      }
      if (request.method === 'POST' && pathname === '/api/setup') {
        if (config.state !== 'pending') { json(response, 409, {error: 'ALREADY_SETUP'}); return; }
        if (!limiter.allow('admin-setup', request.socket.remoteAddress, 5)) {
          json(response, 429, {error: 'RATE_LIMIT'}); return;
        }
        const body = await readJson(request);
        if (!exactObject(body, ['setupToken', 'organizationName', 'password']) ||
            !matches(body.setupToken, config.setupTokenHash) ||
            typeof body.organizationName !== 'string' ||
            body.organizationName.trim().length < 2 ||
            body.organizationName.trim().length > 100 ||
            typeof body.password !== 'string' || body.password.length < 12 ||
            body.password.length > 128) {
          json(response, 400, {error: 'INVALID_SETUP'}); return;
        }
        const completed = completeSetup(body.organizationName.trim(), body.password);
        saveConfig(configPath, completed.config);
        try { discardSetupKey(configPath); } catch { /* The hash is already invalidated. */ }
        config = completed.config;
        const token = newSecret();
        const current = Date.now();
        const newSession = {csrfToken: newSecret(), expiresAt: current + SESSION_IDLE_MS,
          absoluteUntil: current + SESSION_ABSOLUTE_MS};
        adminSessions.set(digest(token), newSession);
        json(response, 201, {authenticated: true, csrfToken: newSession.csrfToken,
          organizationCode: completed.organizationCode},
        {'Set-Cookie': `portal_admin=${token}; HttpOnly; SameSite=Strict; Path=/`});
        return;
      }
      if (request.method === 'POST' && pathname === '/api/login') {
        if (config.state === 'pending') { json(response, 409, {error: 'SETUP_REQUIRED'}); return; }
        if (!limiter.allow('admin-login', request.socket.remoteAddress, 5)) {
          json(response, 429, {error: 'RATE_LIMIT'});
          return;
        }
        const body = await readJson(request);
        if (!exactObject(body, ['password']) || typeof body.password !== 'string' ||
            body.password.length > 128 || !verifyPassword(body.password, config.adminPasswordHash)) {
          json(response, 401, {error: 'AUTH_FAILED'});
          return;
        }
        if (config.version === 1) {
          const migrated = {...config, version: 2, state: 'ready',
            organizationName: 'Kurum', adminPasswordHash: hashPassword(body.password)};
          saveConfig(configPath, migrated);
          config = migrated;
        }
        const token = newSecret();
        const current = Date.now();
        const newSession = {csrfToken: newSecret(), expiresAt: current + SESSION_IDLE_MS,
          absoluteUntil: current + SESSION_ABSOLUTE_MS};
        adminSessions.set(digest(token), newSession);
        json(response, 200, {authenticated: true, csrfToken: newSession.csrfToken},
          {'Set-Cookie': `portal_admin=${token}; HttpOnly; SameSite=Strict; Path=/`});
        return;
      }
      if (!validSession) { json(response, 401, {error: 'ADMIN_REQUIRED'}); return; }
      if (request.method === 'GET' && pathname === '/api/state') {
        const lanAddresses = Object.values(networkInterfaces()).flatMap((entries) =>
          (entries ?? []).filter((entry) => entry.family === 'IPv4' && !entry.internal)
            .map((entry) => entry.address));
        json(response, 200, {hubId, serverTime: stateClock.now?.() ?? Date.now(), organizationId: config.organizationId,
          organizationName: config.organizationName ?? 'Kurum', wsPort: lanServer.address().port,
          lanAddresses: [...new Set(lanAddresses)],
          clients: activeBySocket.size,
          staff: config.staff.map(({userId, displayName, disabled}) =>
            ({userId, displayName, disabled: disabled === true,
              connected: activeByUser.has(userId)})),
          ...state.getSnapshot({organizationId: config.organizationId})});
        return;
      }
      if (request.method !== 'POST' || request.headers['x-csrf-token'] !== session.csrfToken) {
        json(response, 403, {error: 'CSRF_REQUIRED'});
        return;
      }
      const body = await readJson(request);
      if (pathname === '/api/logout') {
        if (!exactObject(body, [])) { json(response, 400, {error: 'INVALID_MESSAGE'}); return; }
        adminSessions.delete(digest(cookie));
        json(response, 200, {ok: true}, {'Set-Cookie':
          'portal_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});
        return;
      }
      if (pathname === '/api/organization-code/rotate') {
        if (!exactObject(body, ['password']) ||
            !verifyPassword(body.password, config.adminPasswordHash)) {
          json(response, 403, {error: 'AUTH_FAILED'}); return;
        }
        const organizationCode = newSecret();
        const previousHash = config.organizationCodeHash;
        config.organizationCodeHash = digest(organizationCode);
        try { saveConfig(configPath, config); } catch (error) {
          config.organizationCodeHash = previousHash;
          throw error;
        }
        for (const client of activeBySocket.values()) {
          state.disconnect({socketId: client.socketId});
          client.auth = null;
        }
        activeBySocket.clear();
        activeByUser.clear();
        for (const ws of wss.clients) {
          send(ws, {type: 'ERROR', code: 'CODE_ROTATED'});
          ws.close(4003, 'CODE_ROTATED');
        }
        json(response, 200, {organizationCode});
        return;
      }
      if (pathname === '/api/account-code') {
        if (!exactObject(body, [])) { json(response, 400, {error: 'INVALID_MESSAGE'}); return; }
        json(response, 200, {accountCode: `acct_${newSecret()}`});
        return;
      }
      if (pathname === '/api/staff') {
        if (!exactObject(body, ['displayName']) || typeof body.displayName !== 'string' ||
            body.displayName.trim().length < 1 || body.displayName.trim().length > 80) {
          json(response, 400, {error: 'INVALID_STAFF'}); return;
        }
        const staffToken = newSecret();
        const staff = {userId: randomUUID(), displayName: body.displayName.trim(),
          tokenHash: digest(staffToken), disabled: false};
        config.staff.push(staff);
        try { saveConfig(configPath, config); } catch (error) {
          config.staff.pop();
          throw error;
        }
        json(response, 201, {userId: staff.userId, displayName: staff.displayName, staffToken});
        return;
      }
      if (pathname === '/api/force-unlock') {
        if (!exactObject(body, ['portal', 'accountCode', 'requestId']) ||
            !validPortal(body.portal) || !validAccountCode(body.accountCode) ||
            !validRequestId(body.requestId)) {
          json(response, 400, {error: 'INVALID_MESSAGE'}); return;
        }
        const result = state.forceUnlock({...body, organizationId: config.organizationId,
          adminContext: {authorized: true, organizationId: config.organizationId}});
        json(response, result.ok ? 200 : 400, result);
        return;
      }
      if (pathname === '/api/kick' || pathname === '/api/readmit') {
        if (!exactObject(body, ['userId', 'requestId']) ||
            !validRequestId(body.userId) || !validRequestId(body.requestId) ||
            !config.staff.some((entry) => entry.userId === body.userId)) {
          json(response, 400, {error: 'INVALID_USER'}); return;
        }
        const staff = config.staff.find((entry) => entry.userId === body.userId);
        const result = state[pathname === '/api/kick' ? 'kick' : 'readmitUser']({
          ...body, organizationId: config.organizationId,
          adminContext: {authorized: true, organizationId: config.organizationId},
        });
        if (result.ok) {
          const disabled = state.isKicked({organizationId: config.organizationId,
            userId: staff.userId});
          if (staff.disabled !== disabled) {
            staff.disabled = disabled;
            saveConfig(configPath, config);
          }
          scheduleBroadcast();
        }
        json(response, result.ok ? 200 : 400, result);
        return;
      }
      json(response, 404, {error: 'NOT_FOUND'});
    } catch (error) {
      json(response, error.status ?? 500, {error: error.status ? error.message : 'SERVER_ERROR'});
    }
  });
  adminServer.maxHeadersCount = 32;
  adminServer.headersTimeout = 10_000;
  adminServer.requestTimeout = 10_000;

  try {
    const wsAddress = await listen(lanServer, wsPort, wsHost);
    adminAddress = await listen(adminServer, adminPort, '127.0.0.1');
    return {hubId, organizationId: config.organizationId ?? null,
      wsPort: wsAddress.port, adminPort: adminAddress.port,
      async close() {
        closing = true;
        clearInterval(heartbeat);
        for (const ws of wss.clients) ws.terminate();
        activeBySocket.clear();
        activeByUser.clear();
        state.dispose();
        await Promise.all([closeServer(lanServer), closeServer(adminServer)]);
        wss.close();
      }};
  } catch (error) {
    clearInterval(heartbeat);
    if (lanServer.listening) await closeServer(lanServer);
    if (adminServer.listening) await closeServer(adminServer);
    throw error;
  }
}
