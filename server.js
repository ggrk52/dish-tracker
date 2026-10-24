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
const PUBLIC_DIR = __dirname;
const AUTH_SECRET = 'family_dish_secret_2026';

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

  memoryState = { ...DEFAULT_STATE };
  stateJsonStr = JSON.stringify(memoryState);
  stateJsonBuffer = Buffer.from(stateJsonStr);
  saveStateToDisk(memoryState);
  return memoryState;
}

function saveStateToDisk(data) {
  memoryState = { ...DEFAULT_STATE, ...data };
  if (!data.members) memoryState.members = DEFAULT_STATE.members;
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
  return '192.168.1.75';
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

  // 1. API: Get Current Master State (ETag 304 + In-Memory)
  if (url.pathname === '/api/state' && req.method === 'GET') {
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
    res.end(stateJsonBuffer);
    return;
  }

  // 2. API: Version
  if (url.pathname === '/api/version' && req.method === 'GET') {
    getOrCreateState();
    const vBuf = Buffer.from(JSON.stringify({ version: stateVersion, etag: stateEtag }));
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache, must-revalidate',
      'Content-Length': vBuf.length
    });
    res.end(vBuf);
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
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
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

        if (!isAdmin) {
          const currState = getOrCreateState();
          const currQ = currState.queue || [];
          const currIdx = currState.currentQueueIndex || 0;
          const currDutyId = (currQ && currIdx < currQ.length) ? currQ[currIdx] : null;

          if (JSON.stringify(parsedState.queue) !== JSON.stringify(currQ)) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Изменять порядок очереди может только Серёжа (Администратор)' }));
            return;
          }

          const action = parsedState._action || '';
          const isDutyWash = (['wash', 'wash_done'].includes(action) && authUser && currDutyId && authUser === currDutyId);
          const isReaction = (action === 'reaction');
          const isUndo = (action === 'undo');

          if (!isDutyWash && !isReaction && !isUndo) {
            let errMsg = '';
            if (['skip', 'swap', 'reorder', 'reset'].includes(action)) {
              errMsg = 'Управлять очередью и настройками может только Серёжа (Администратор)';
            } else {
              const currDutyName = (currState.members && currState.members[currDutyId]) ? currState.members[currDutyId].name : 'дежурного';
              errMsg = `Сейчас очередь дежурить: ${currDutyName}. Отметить помывку может только он(а)`;
            }
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: errMsg }));
            return;
          }
        }

        if (parsedState && typeof parsedState === 'object') {
          delete parsedState._authUser;
          delete parsedState._authToken;
          delete parsedState._authPass;
          delete parsedState._adminPassword;
          delete parsedState._memberId;
          delete parsedState._action;
        }

        if (parsedState && parsedState.queue) {
          saveStateToDisk(parsedState);
          broadcastUpdate(stateJsonStr);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: true }));
          return;
        }
        throw new Error('Invalid state structure');
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

  // 6. Static Files Serving
  let filePath = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(PUBLIC_DIR, 'public', url.pathname);
    if (!fs.existsSync(filePath)) {
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }
  }

  try {
    const stat = fs.statSync(filePath);
    const fileEtag = `"${Math.floor(stat.mtimeMs)}-${stat.size}"`;
    const reqEtag = req.headers['if-none-match'];

    if (reqEtag && reqEtag.trim() === fileEtag) {
      res.writeHead(304, { 'ETag': fileEtag, 'Cache-Control': 'public, max-age=600, must-revalidate' });
      res.end();
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const content = fs.readFileSync(filePath);

    res.writeHead(200, {
      'Content-Type': contentType,
      'ETag': fileEtag,
      'Cache-Control': url.pathname === '/sw.js' ? 'no-cache, must-revalidate' : 'public, max-age=600, must-revalidate',
      'Content-Length': content.length
    });
    res.end(content);
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
