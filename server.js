// ==========================================
// ЧИСТАЯ ТАРЕЛКА — Сервер для Raspberry Pi (Node.js)
// Система семейных аккаунтов (Админ: Серёжа)
// Поддержка In-Memory, SSE, ETag 304, Fast Cache
// ==========================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');

const PORT = process.env.PORT || 8080;
const DATA_FILE = path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.resolve(__dirname, 'public');
const AUTH_SECRET = 'family_dish_secret_2026';
const MAINTENANCE_FILE = path.join(__dirname, 'maintenance.flag');

function isMaintenanceMode() {
  return fs.existsSync(MAINTENANCE_FILE);
}

// Семейные аккаунты
const ACCOUNTS = {
  serezha: {
    username: 'serezha',
    password: '5252',
    name: 'Серёжа',
    role: 'admin',
    avatar: '👦'
  },
  mama: {
    username: 'mama',
    password: '1111',
    name: 'Мама',
    role: 'member',
    avatar: '👩'
  },
  papa: {
    username: 'papa',
    password: '2222',
    name: 'Папа',
    role: 'member',
    avatar: '👨'
  },
  vasya: {
    username: 'vasya',
    password: '3333',
    name: 'Вася',
    role: 'member',
    avatar: '🧒'
  }
};

function generateToken(username) {
  const acc = ACCOUNTS[username];
  if (!acc) return '';
  return crypto.createHash('sha256').update(`${username}:${acc.password}:${AUTH_SECRET}`).digest('hex');
}

function verifyRequestAuth(headers, bodyObj) {
  let user = headers['x-auth-user'] || '';
  let token = headers['x-auth-token'] || '';
  if (user) {
    try { user = decodeURIComponent(user); } catch (e) {}
  }
  if (token) {
    try { token = decodeURIComponent(token); } catch (e) {}
  }

  if ((!user || !token) && bodyObj && typeof bodyObj === 'object') {
    user = user || bodyObj._authUser || '';
    token = token || bodyObj._authToken || '';
  }

  user = (user || '').trim().toLowerCase();
  const acc = ACCOUNTS[user];
  if (!acc) return null;

  const expectedToken = generateToken(user);
  if (token && token === expectedToken) {
    return acc;
  }

  const directPass = headers['x-auth-password'] || (bodyObj && bodyObj._authPass ? bodyObj._authPass : '');
  if (directPass && String(directPass).trim() === acc.password) {
    return acc;
  }

  return null;
}

const DEFAULT_STATE = {
  members: {
    mama: { id: 'mama', name: 'Мама', role: 'Мама', avatar: '👩', color: '#ec4899', title: 'Хранительница очага' },
    papa: { id: 'papa', name: 'Папа', role: 'Папа', avatar: '👨', color: '#0284c7', title: 'Гроза сковородок' },
    serezha: { id: 'serezha', name: 'Серёжа', role: 'Сын', avatar: '👦', color: '#10b981', title: 'Мастер мыльной пены' },
    vasya: { id: 'vasya', name: 'Вася', role: 'Сын', avatar: '🧒', color: '#f59e0b', title: 'Повелитель тарелок' }
  },
  queue: ['mama', 'papa', 'serezha', 'vasya'],
  currentQueueIndex: 0,
  dutyStartedAt: Date.now(),
  stats: { mama: 0, papa: 0, serezha: 0, vasya: 0 },
  history: []
};

// In-Memory State Cache
let memoryState = null;
let stateVersion = Date.now();
let stateEtag = `"${stateVersion}"`;
let stateJsonStr = '';
let stateJsonBuffer = Buffer.from('{}');

function getOrCreateState() {
  if (memoryState) return memoryState;

  if (fs.existsSync(DATA_FILE)) {
    try {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      const data = JSON.parse(raw);
      if (data && data.queue && data.members) {
        memoryState = data;
        stateJsonStr = JSON.stringify(memoryState);
        stateJsonBuffer = Buffer.from(stateJsonStr);
        return memoryState;
      }
    } catch (e) {
      console.error('Ошибка загрузки data.json, восстанавливаем по умолчанию:', e.message);
    }
  }

  memoryState = JSON.parse(JSON.stringify(DEFAULT_STATE));
  stateJsonStr = JSON.stringify(memoryState);
  stateJsonBuffer = Buffer.from(stateJsonStr);
  saveStateToDisk(memoryState);
  return memoryState;
}

function saveStateToDisk(data) {
  const base = JSON.parse(JSON.stringify(DEFAULT_STATE));
  memoryState = { ...base, ...data };
  if (!data.members) memoryState.members = base.members;
  stateVersion = Date.now();
  stateEtag = `"${stateVersion}"`;
  stateJsonStr = JSON.stringify(memoryState);
  stateJsonBuffer = Buffer.from(stateJsonStr);

  const tmp = DATA_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(memoryState, null, 2), 'utf-8');
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error('Ошибка записи data.json:', e.message);
  }
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

// SSE Subscribers
const sseClients = new Set();

function broadcastUpdate(data) {
  const payload = `event: state_update\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Auth-User, X-Auth-Token, X-Auth-Password, X-Admin-Password, X-Member-Id, If-None-Match');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // 0. Maintenance Mode Interceptor
  if (isMaintenanceMode()) {
    if (url.pathname.startsWith('/api/')) {
      const payload = Buffer.from(JSON.stringify({
        maintenance: true,
        error: 'Ведутся технические работы. Сервер временно недоступен.'
      }));
      res.writeHead(503, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Retry-After': '5',
        'Content-Length': payload.length
      });
      res.end(payload);
      return;
    }

    const maintenancePath = path.join(PUBLIC_DIR, 'maintenance.html');
    if ((url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/maintenance.html') && fs.existsSync(maintenancePath)) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate'
      });
      fs.createReadStream(maintenancePath).pipe(res);
      return;
    }
  }

  // 1. API: Get Current Master State (ETag 304 + In-Memory)
  if (url.pathname === '/api/state' && (req.method === 'GET' || req.method === 'HEAD')) {
    getOrCreateState();

    const reqEtag = req.headers['if-none-match'];
    if (reqEtag && reqEtag.trim() === stateEtag) {
      res.writeHead(304, {
        'ETag': stateEtag,
        'Cache-Control': 'no-cache, must-revalidate'
      });
      res.end();
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'ETag': stateEtag,
      'Cache-Control': 'no-cache, must-revalidate',
      'Content-Length': stateJsonBuffer.length
    });
    if (req.method === 'HEAD') {
      res.end();
    } else {
      res.end(stateJsonBuffer);
    }
    return;
  }

  // 2. API: Version
  if (url.pathname === '/api/version' && (req.method === 'GET' || req.method === 'HEAD')) {
    getOrCreateState();
    const vBuf = Buffer.from(JSON.stringify({ version: stateVersion, etag: stateEtag }));
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache, must-revalidate',
      'Content-Length': vBuf.length
    });
    if (req.method === 'HEAD') {
      res.end();
    } else {
      res.end(vBuf);
    }
    return;
  }

  // 3. API: Login
  if (url.pathname === '/api/login' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const creds = JSON.parse(body);
        const user = (creds.username || '').trim().toLowerCase();
        const pass = String(creds.password || '').trim();

        const acc = ACCOUNTS[user];
        if (acc && acc.password === pass) {
          const token = generateToken(user);
          const resPayload = JSON.stringify({
            success: true,
            user: {
              username: acc.username,
              name: acc.name,
              role: acc.role,
              avatar: acc.avatar
            },
            token: token
          });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(resPayload);
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Неверный пароль. Попробуйте ещё раз' }));
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // 4. API: Update State
  if (url.pathname === '/api/state' && req.method === 'POST') {
    let body = '';
    let bodyLen = 0;
    const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB
    let overflow = false;

    req.on('data', chunk => {
      bodyLen += chunk.length;
      if (bodyLen > MAX_BODY_SIZE) {
        overflow = true;
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (overflow) return;
      try {
        const parsedState = JSON.parse(body);

        const acc = verifyRequestAuth(req.headers, parsedState);
        if (!acc) {
          res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Требуется авторизация. Пожалуйста, войдите в аккаунт' }));
          return;
        }

        const isAdmin = (acc.role === 'admin');
        const authUser = acc.username;
        const action = parsedState._action || '';

        const currState = getOrCreateState();
        const currQ = currState.queue || [];
        const currIdx = currState.currentQueueIndex || 0;
        const currDutyId = (currQ && currIdx < currQ.length) ? currQ[currIdx] : null;

        if (action === 'reaction') {
          // Реакции: обновляем ТОЛЬКО реакции для существующей записи истории
          const clientHist = Array.isArray(parsedState.history) ? parsedState.history : [];
          const clientMap = new Map();
          for (const item of clientHist) {
            if (item && item.id != null) clientMap.set(item.id, item);
          }
          if (Array.isArray(currState.history)) {
            for (const hItem of currState.history) {
              if (clientMap.has(hItem.id)) {
                const cReactions = clientMap.get(hItem.id).reactions;
                if (cReactions && typeof cReactions === 'object') {
                  if (!hItem.reactions || typeof hItem.reactions !== 'object') {
                    hItem.reactions = { love: 0, clap: 0, star: 0 };
                  }
                  hItem.reactions = {
                    love: Math.max(hItem.reactions.love || 0, Math.max(0, parseInt(cReactions.love, 10) || 0)),
                    clap: Math.max(hItem.reactions.clap || 0, Math.max(0, parseInt(cReactions.clap, 10) || 0)),
                    star: Math.max(hItem.reactions.star || 0, Math.max(0, parseInt(cReactions.star, 10) || 0))
                  };
                }
              }
            }
          }
          saveStateToDisk(currState);
        } else if (['wash', 'wash_done'].includes(action)) {
          const isDuty = (currDutyId && authUser === currDutyId);
          if (!isAdmin && !isDuty) {
            const currDutyName = (currState.members && currState.members[currDutyId]) ? currState.members[currDutyId].name : 'дежурного';
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: `Сейчас очередь дежурить: ${currDutyName}. Отметить помывку может только он(а)` }));
            return;
          }

          const clientHist = Array.isArray(parsedState.history) ? parsedState.history : [];
          const newItem = clientHist.length > 0 ? clientHist[0] : {};
          const washer = (isAdmin && newItem.memberId && currState.members && currState.members[newItem.memberId])
            ? newItem.memberId
            : (currDutyId || authUser);

          const nowTs = Date.now();
          const rawPhoto = newItem.photo;
          const photoVal = (typeof rawPhoto === 'string' && rawPhoto.startsWith('data:image/')) ? rawPhoto : null;
          const durationMs = Math.max(0, parseInt(newItem.durationMs, 10) || 0);
          const noteVal = (newItem.note != null) ? String(newItem.note).trim() : '';

          const rawReactions = (newItem.reactions && typeof newItem.reactions === 'object') ? newItem.reactions : {};
          const historyReactions = {
            love: Math.max(0, parseInt(rawReactions.love, 10) || 0),
            clap: Math.max(0, parseInt(rawReactions.clap, 10) || 0),
            star: Math.max(0, parseInt(rawReactions.star, 10) || 0)
          };

          const historyEntry = {
            id: newItem.id || nowTs,
            memberId: washer,
            timestamp: newItem.timestamp || nowTs,
            durationMs: durationMs,
            note: noteVal,
            photo: photoVal,
            reactions: historyReactions
          };

          if (!currState.stats || typeof currState.stats !== 'object') currState.stats = {};
          currState.stats[washer] = (currState.stats[washer] || 0) + 1;

          if (!Array.isArray(currState.history)) currState.history = [];
          currState.history.unshift(historyEntry);
          if (currState.history.length > 200) currState.history.pop();

          if (currQ.length > 0) {
            currState.currentQueueIndex = (currIdx + 1) % currQ.length;
          }
          currState.dutyStartedAt = nowTs;
          saveStateToDisk(currState);
        } else if (action === 'undo') {
          if (!Array.isArray(currState.history) || currState.history.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Нет записей о помывке для отмены' }));
            return;
          }

          const lastWash = currState.history[0];
          const lastWasher = lastWash.memberId;
          if (!isAdmin && authUser !== lastWasher) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Отменить помывку может только тот, кто помыл, или Серёжа (Администратор)' }));
            return;
          }

          currState.history.shift();
          if (currState.stats && currState.stats[lastWasher]) {
            currState.stats[lastWasher] = Math.max(0, currState.stats[lastWasher] - 1);
          }
          if (currQ.length > 0) {
            currState.currentQueueIndex = (currIdx - 1 + currQ.length) % currQ.length;
          }
          if (currState.history.length > 0) {
            currState.dutyStartedAt = currState.history[0].timestamp || Date.now();
          } else {
            currState.dutyStartedAt = Date.now();
          }
          saveStateToDisk(currState);
        } else if (['skip', 'swap'].includes(action)) {
          const isDuty = (currDutyId && authUser === currDutyId);
          if (!isAdmin && !isDuty) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Пропустить или передать очередь может только текущий дежурный или Серёжа (Администратор)' }));
            return;
          }

          if (action === 'skip') {
            if (currQ.length > 0) {
              currState.currentQueueIndex = (currIdx + 1) % currQ.length;
            }
            currState.dutyStartedAt = Date.now();
            saveStateToDisk(currState);
          } else if (action === 'swap') {
            const clientQ = parsedState.queue;
            if (Array.isArray(clientQ) && [...clientQ].sort().join(',') === [...currQ].sort().join(',')) {
              currState.queue = [...clientQ];
              currState.dutyStartedAt = Date.now();
              saveStateToDisk(currState);
            } else {
              res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ error: 'Некорректный состав очереди' }));
              return;
            }
          }
        } else if (isAdmin) {
          if (action === 'reset') {
            saveStateToDisk(JSON.parse(JSON.stringify(DEFAULT_STATE)));
          } else if (action === 'reorder') {
            const clientQ = parsedState.queue;
            if (Array.isArray(clientQ) && [...clientQ].sort().join(',') === [...currQ].sort().join(',')) {
              currState.queue = [...clientQ];
              saveStateToDisk(currState);
            } else {
              res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ error: 'Некорректная очередь' }));
              return;
            }
          } else {
            // Full state update
            const cleanCopy = { ...parsedState };
            delete cleanCopy._authUser;
            delete cleanCopy._authToken;
            delete cleanCopy._authPass;
            delete cleanCopy._adminPassword;
            delete cleanCopy._memberId;
            delete cleanCopy._action;
            saveStateToDisk(cleanCopy);
          }
        } else {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Управлять очередью и настройками может только Серёжа (Администратор)' }));
          return;
        }

        broadcastUpdate(stateJsonStr);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, etag: stateEtag }));
        return;
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // 5. API: Real-Time SSE Stream
  if (url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    getOrCreateState();
    res.write(`event: state_update\ndata: ${stateJsonStr}\n\n`);

    sseClients.add(res);

    const pingTimer = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (e) {}
    }, 20000);

    req.on('close', () => {
      clearInterval(pingTimer);
      sseClients.delete(res);
    });
    return;
  }

  // 6. Static Files Serving (Strictly from public/ with Path Traversal Protection)
  const ALLOWED_EXTS = new Set(['.html', '.css', '.js', '.json', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.ico']);
  const FORBIDDEN_NAMES = new Set(['server.js', 'server.py', 'data.json', 'Dockerfile', 'docker-compose.yml']);

  let reqPath = '/index.html';
  try {
    reqPath = decodeURIComponent(url.pathname);
  } catch (e) {}
  if (!reqPath || reqPath === '/') {
    reqPath = '/index.html';
  }

  const safeRelPath = reqPath.replace(/^\/+/, '');
  const resolvedPath = path.resolve(PUBLIC_DIR, safeRelPath);

  // Path Traversal Check: must reside within PUBLIC_DIR
  if (!resolvedPath.startsWith(PUBLIC_DIR + path.sep) && resolvedPath !== PUBLIC_DIR) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  const ext = path.extname(resolvedPath).toLowerCase();
  const baseName = path.basename(resolvedPath);

  if (!ALLOWED_EXTS.has(ext) || baseName.startsWith('.') || (ext === '.json' && baseName !== 'manifest.json') || FORBIDDEN_NAMES.has(baseName)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }

  if (!fs.existsSync(resolvedPath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }

  try {
    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }

    const fileEtag = `"${Math.floor(stat.mtimeMs)}-${stat.size}"`;
    const reqEtag = req.headers['if-none-match'];

    if (reqEtag && reqEtag.trim() === fileEtag) {
      res.writeHead(304, { 'ETag': fileEtag, 'Cache-Control': 'public, max-age=600, must-revalidate' });
      res.end();
      return;
    }

    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const content = fs.readFileSync(resolvedPath);

    res.writeHead(200, {
      'Content-Type': contentType,
      'ETag': fileEtag,
      'Cache-Control': safeRelPath === 'sw.js' ? 'no-cache, must-revalidate' : 'public, max-age=600, must-revalidate',
      'Content-Length': content.length
    });
    if (req.method === 'HEAD') {
      res.end();
    } else {
      res.end(content);
    }
  } catch (err) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
});

// Start Server
server.listen(PORT, '0.0.0.0', () => {
  const localIp = getLocalIp();
  getOrCreateState();

  console.log('\n======================================================');
  console.log('🍽️   ЧИСТАЯ ТАРЕЛКА — Сервер для всей семьи (Raspberry Pi)');
  console.log('🚀  Node.js: Real-time SSE + In-Memory + ETag + 304');
  console.log('======================================================');
  console.log(`📱  Домашний Wi-Fi адрес:  http://${localIp}:${PORT}`);
  console.log(`💻  Локальный адрес:       http://localhost:${PORT}`);
  console.log(`💾  Файл базы данных:      ${DATA_FILE}`);
  console.log('======================================================\n');
});
