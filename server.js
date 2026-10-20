// ==========================================
// ЧИСТАЯ ТАРЕЛКА — Сервер для Raspberry Pi
// Система семейных аккаунтов (Админ: Серёжа)
// ==========================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

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

// MIME types
const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.js': 'text/javascript; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

// Connected SSE clients
const sseClients = new Set();

function getOrCreateState() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const content = fs.readFileSync(DATA_FILE, 'utf-8');
      const parsed = JSON.parse(content);
      if (parsed && parsed.queue && Array.isArray(parsed.queue) && parsed.members) {
        return parsed;
      }
    } catch (e) {
      console.error('Error reading data.json, re-initializing:', e);
    }
  }
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(DEFAULT_STATE, null, 2), 'utf-8');
    console.log('✅ Инициализирована база данных data.json');
  } catch (err) {
    console.error('Failed to create data.json:', err);
  }
  return JSON.parse(JSON.stringify(DEFAULT_STATE));
}

function saveStateToDisk(data) {
  try {
    const merged = { ...DEFAULT_STATE, ...(data || {}) };
    if (!data.members || Object.keys(data.members).length === 0) {
      merged.members = DEFAULT_STATE.members;
    }
    const tempFile = DATA_FILE + '.tmp';
    fs.writeFileSync(tempFile, JSON.stringify(merged, null, 2), 'utf-8');
    fs.renameSync(tempFile, DATA_FILE);
  } catch (err) {
    console.error('Error saving data.json:', err);
  }
}

function broadcastUpdate(data) {
  const payload = `event: state_update\ndata: ${JSON.stringify(data)}\n\n`;
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Auth-User, X-Auth-Token, X-Auth-Password, X-Admin-Password, X-Member-Id');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // 1. API: Get Current Master State
  if (url.pathname === '/api/state' && req.method === 'GET') {
    const currentState = getOrCreateState();
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache'
    });
    res.end(JSON.stringify(currentState));
    return;
  }

  // 2. API: Login
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
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            success: true,
            user: {
              username: acc.username,
              name: acc.name,
              role: acc.role,
              avatar: acc.avatar
            },
            token: token
          }));
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

  // 3. API: Update State
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
          const currentState = getOrCreateState();
          const currQ = currentState.queue || [];
          const currIdx = currentState.currentQueueIndex || 0;
          const currDutyId = currQ[currIdx];

          // 1. Changing queue order requires Admin rights
          if (JSON.stringify(parsedState.queue) !== JSON.stringify(currQ)) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Изменять порядок очереди может только Серёжа (Администратор)' }));
            return;
          }

          // 2. Only current duty member can mark duty as done, react or undo
          const action = parsedState._action || '';
          const isDutyWash = (['wash', 'wash_done'].includes(action) && authUser && currDutyId && authUser === currDutyId);
          const isReaction = (action === 'reaction');
          const isUndo = (action === 'undo');

          if (!isDutyWash && !isReaction && !isUndo) {
            let errMsg;
            if (['skip', 'swap', 'reorder', 'reset'].includes(action)) {
              errMsg = 'Управлять очередью и настройками может только Серёжа (Администратор)';
            } else {
              const currDutyName = (currentState.members && currentState.members[currDutyId]) ? currentState.members[currDutyId].name : 'дежурного';
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
          broadcastUpdate(parsedState);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: true }));
          console.log(`[${new Date().toLocaleTimeString()}] Посуда обновлена пользователем ${acc.name} (${acc.role})! Синхронизировано на всех устройствах.`);
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

  // 4. API: Real-Time SSE Stream
  if (url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive'
    });
    res.write(':\n\n');

    sseClients.add(res);

    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  // 5. Static Files Serving
  let filePath = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);

  if (!fs.existsSync(filePath)) {
    filePath = path.join(PUBLIC_DIR, 'public', url.pathname);
    if (!fs.existsSync(filePath)) {
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('500 Server Error: ' + err.code);
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache'
    });
    res.end(content);
  });
});

// Start Server
server.listen(PORT, '0.0.0.0', () => {
  const localIp = getLocalIp();
  getOrCreateState();

  console.log('\n======================================================');
  console.log('🍽️   ЧИСТАЯ ТАРЕЛКА — Сервер для всей семьи (Raspberry Pi)');
  console.log('======================================================');
  console.log(`📱  Домашний Wi-Fi адрес:  http://${localIp}:${PORT}`);
  console.log(`💻  Локальный адрес:       http://localhost:${PORT}`);
  console.log(`💾  Файл базы данных:      ${DATA_FILE}`);
  console.log('======================================================\n');
});
