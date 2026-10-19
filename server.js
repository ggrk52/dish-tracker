// ==========================================
// ЧИСТАЯ ТАРЕЛКА — Сервер для Raspberry Pi
// Единая база данных для всех устройств семьи
// ==========================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 8080;
const DATA_FILE = path.join(__dirname, 'data.json');
const PUBLIC_DIR = __dirname;

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

// Load or create state file on disk
function getOrCreateState() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const content = fs.readFileSync(DATA_FILE, 'utf-8');
      const parsed = JSON.parse(content);
      if (parsed && parsed.queue && Array.isArray(parsed.queue)) {
        return parsed;
      }
    } catch (e) {
      console.error('Error reading data.json, re-initializing:', e);
    }
  }
  // Initialize default file
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(DEFAULT_STATE, null, 2), 'utf-8');
    console.log('✅ Инициализирована база данных data.json');
  } catch (err) {
    console.error('Failed to create data.json:', err);
  }
  return DEFAULT_STATE;
}

function saveStateToDisk(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error saving data.json:', err);
  }
}

// Broadcast updates to all devices instantly
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

// Get Local IPv4
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
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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

  // 2. API: Update State and notify all other devices
  if (url.pathname === '/api/state' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const parsedState = JSON.parse(body);
        if (parsedState && parsedState.queue) {
          saveStateToDisk(parsedState);
          broadcastUpdate(parsedState);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: true }));
          console.log(`[${new Date().toLocaleTimeString()}] Посуда обновлена! Синхронизировано на всех устройствах.`);
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

  // 3. API: Real-Time SSE Stream
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

  // 4. Serve Static Files
  let reqPath = url.pathname === '/' ? 'index.html' : url.pathname;
  let filePath = path.join(PUBLIC_DIR, reqPath);
  
  // If not in root, check in public/
  if (!fs.existsSync(filePath)) {
    filePath = path.join(PUBLIC_DIR, 'public', reqPath);
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404: Файл не найден');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('500: Ошибка сервера');
      }
    } else {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache'
      });
      res.end(content);
    }
  });
});

// Initialize database file on startup
getOrCreateState();

server.listen(PORT, '0.0.0.0', () => {
  const localIp = getLocalIp();
  console.log('\n======================================================');
  console.log('🍽️   ЧИСТАЯ ТАРЕЛКА — Сервер на Raspberry Pi');
  console.log('======================================================');
  console.log(`📱  Открывайте на всех телефонах в домашнем Wi-Fi:`);
  console.log(`    👉  http://${localIp}:${PORT}`);
  console.log(`💾  База данных: ${DATA_FILE}`);
  console.log('======================================================\n');
});
