// ========================================================
// ЧИСТАЯ ТАРЕЛКА 2.0 — График и Журнал мытья посуды
// Семья: Мама, Папа, Серёжа, Вася
// Поддержка Firebase Realtime DB, локального Wi-Fi и PWA
// ========================================================

const STORAGE_KEY = 'dish_duty_v2_data';
const SETTINGS_KEY = 'dish_duty_v2_settings';

// Default initial state
const DEFAULT_STATE = {
  members: {
    mama: { id: 'mama', name: 'Мама', avatar: '👩', color: '#ec4899', title: 'Хранительница очага' },
    papa: { id: 'papa', name: 'Папа', avatar: '👨', color: '#0284c7', title: 'Гроза сковородок' },
    serezha: { id: 'serezha', name: 'Серёжа', avatar: '👦', color: '#10b981', title: 'Мастер мыльной пены' },
    vasya: { id: 'vasya', name: 'Вася', avatar: '🧒', color: '#f59e0b', title: 'Повелитель тарелок' }
  },
  queue: ['mama', 'papa', 'serezha', 'vasya'],
  currentQueueIndex: 0,
  dutyStartedAt: Date.now(),
  stats: {
    mama: 0,
    papa: 0,
    serezha: 0,
    vasya: 0
  },
  history: []
};

// Default settings
const DEFAULT_SETTINGS = {
  sound: true,
  theme: 'light',
  wakeLock: false,
  firebaseUrl: '', // e.g. https://my-family-default-rtdb.firebaseio.com
  activeTab: 'tab-duty'
};

let state = loadState();
let settings = loadSettings();
let undoAction = null;
let wakeLockSentinel = null;
let cloudEventSource = null;
let currentHistoryFilter = 'all';

// ========================================================
// AUTH & FAMILY ACCOUNTS SYSTEM
// Логины и пароли:
// Серёжа: 5252 (Администратор 👑)
// Мама:    1111 (Дежурный)
// Папа:    2222 (Дежурный)
// Вася:    3333 (Дежурный)
// ========================================================
const AUTH_SESSION_KEY = 'dish_auth_session_v2';

function getAuthSession() {
  try {
    const raw = localStorage.getItem(AUTH_SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function setAuthSession(sessionData) {
  if (sessionData && sessionData.user && sessionData.token) {
    localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(sessionData));
  } else {
    localStorage.removeItem(AUTH_SESSION_KEY);
  }
  renderAll();
}

function isLoggedIn() {
  const s = getAuthSession();
  return Boolean(s && s.user && s.token);
}

function getCurrentUser() {
  return getAuthSession()?.user || null;
}

function isAdmin() {
  return getCurrentUser()?.role === 'admin';
}

function getCurrentUserProfile() {
  return getCurrentUser()?.username || '';
}

window.getAuthSession = getAuthSession;
window.setAuthSession = setAuthSession;
window.isLoggedIn = isLoggedIn;
window.getCurrentUser = getCurrentUser;
window.isAdmin = isAdmin;
window.getCurrentUserProfile = getCurrentUserProfile;

async function loginUser(username, password) {
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.success) {
      setAuthSession({ user: data.user, token: data.token });
      closeAllModals();
      if (window.soundFx) soundFx.playVictory();
      showToast(`Добро пожаловать, ${data.user.name}! 👋`, data.user.avatar);
      return { success: true };
    } else {
      return { success: false, error: data.error || 'Неверный пароль' };
    }
  } catch (err) {
    console.error('Login error:', err);
    return { success: false, error: 'Ошибка подключения к серверу' };
  }
}

function logoutUser() {
  setAuthSession(null);
  closeAllModals();
  if (window.soundFx) soundFx.playClick();
  showToast('Вы вышли из аккаунта', '🔒');
  openLoginModal('serezha');
}

function requireAdmin(actionCallback) {
  if (isAdmin()) {
    actionCallback();
    return;
  }
  showToast('Изменение очереди доступно только Серёже (Администратор) 🔒', '👑');
  if (window.soundFx) soundFx.playPop();
}

function openLoginModal(preselectUser = 'serezha') {
  const modal = document.getElementById('modal-login');
  if (!modal) return;

  const usernameInput = document.getElementById('login-username');
  const passInput = document.getElementById('login-password');
  const errorMsg = document.getElementById('login-error-msg');
  const labelEl = document.getElementById('login-label-user');

  if (usernameInput) usernameInput.value = preselectUser;
  if (passInput) {
    passInput.value = '';
    passInput.type = 'password';
  }
  if (errorMsg) errorMsg.classList.add('hidden');

  document.querySelectorAll('.login-user-pill').forEach(pill => {
    const u = pill.getAttribute('data-user');
    if (u === preselectUser) {
      pill.classList.add('active');
      const nameText = pill.querySelector('.login-user-name')?.textContent || u;
      if (labelEl) labelEl.textContent = `Пароль для ${nameText}:`;
    } else {
      pill.classList.remove('active');
    }
  });

  openModal('modal-login');
  setTimeout(() => { if (passInput) passInput.focus(); }, 150);
}

function openAccountModal() {
  const user = getCurrentUser();
  if (!user) {
    openLoginModal('serezha');
    return;
  }

  const avatarEl = document.getElementById('acc-modal-avatar');
  const nameEl = document.getElementById('acc-modal-name');
  const roleEl = document.getElementById('acc-modal-role');
  const descEl = document.getElementById('acc-modal-desc');

  if (avatarEl) avatarEl.textContent = user.avatar || '👤';
  if (nameEl) nameEl.textContent = user.name || user.username;
  if (roleEl) {
    if (user.role === 'admin') {
      roleEl.textContent = '👑 Администратор';
      roleEl.style.background = 'rgba(16, 185, 129, 0.15)';
      roleEl.style.color = '#10b981';
    } else {
      roleEl.textContent = 'Дежурный';
      roleEl.style.background = 'rgba(59, 130, 246, 0.15)';
      roleEl.style.color = '#3b82f6';
    }
  }
  if (descEl) {
    if (user.role === 'admin') {
      descEl.textContent = 'Вы авторизованы как Серёжа. Вам доступны все права: изменение очереди, пропуск, обмен и сброс.';
    } else {
      descEl.textContent = `Вы авторизованы как ${user.name}. Вы можете отмечать помывку, когда наступит ваша очередь.`;
    }
  }

  openModal('modal-account');
}

// ========================================================
// STORAGE & SETTINGS LOAD/SAVE
// ========================================================
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return JSON.parse(JSON.stringify(DEFAULT_STATE));
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_STATE, ...parsed };
  } catch (e) {
    console.error('Failed to load state:', e);
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (e) {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    console.error('Failed to save settings:', e);
  }
}

function saveState(skipCloudPush = false, actionType = null, memberId = null) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error('Failed to save state to localStorage:', e);
  }

  if (!skipCloudPush) {
    pushStateToCloud(actionType, memberId);
  }
}

// ========================================================
// SOUND ENGINE (Web Audio API Synthesizer)
// ========================================================
class SoundEngine {
  constructor() {
    this.ctx = null;
  }

  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) this.ctx = new AudioCtx();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  playPop() {
    if (!settings.sound) return;
    this.init();
    if (!this.ctx) return;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const now = this.ctx.currentTime;

    osc.type = 'sine';
    osc.frequency.setValueAtTime(320, now);
    osc.frequency.exponentialRampToValueAtTime(800, now + 0.08);

    gain.gain.setValueAtTime(0.35, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.09);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + 0.1);
  }

  playVictory() {
    if (!settings.sound) return;
    this.init();
    if (!this.ctx) return;

    const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6
    const now = this.ctx.currentTime;

    notes.forEach((freq, idx) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      const startTime = now + idx * 0.07;

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, startTime);

      gain.gain.setValueAtTime(0.28, startTime);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.35);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(startTime);
      osc.stop(startTime + 0.36);
    });
  }

  playClick() {
    if (!settings.sound) return;
    this.init();
    if (!this.ctx) return;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const now = this.ctx.currentTime;

    osc.type = 'sine';
    osc.frequency.setValueAtTime(850, now);
    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.04);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + 0.05);
  }

  playWash() {
    if (!settings.sound) return;
    this.init();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    [420, 580, 720, 960].forEach((startFreq, i) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      const st = now + i * 0.05;

      osc.type = 'sine';
      osc.frequency.setValueAtTime(startFreq, st);
      osc.frequency.exponentialRampToValueAtTime(startFreq * 1.6, st + 0.1);

      gain.gain.setValueAtTime(0.2, st);
      gain.gain.exponentialRampToValueAtTime(0.001, st + 0.12);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(st);
      osc.stop(st + 0.13);
    });
  }

  playHaptic(style = 'light') {
    if (!('vibrate' in navigator)) return;
    try {
      if (style === 'light') {
        navigator.vibrate(12);
      } else if (style === 'medium') {
        navigator.vibrate(28);
      } else if (style === 'success') {
        navigator.vibrate([25, 40, 30]);
      } else if (style === 'error') {
        navigator.vibrate([40, 30, 40]);
      }
    } catch (e) {
      // Ignore vibration error
    }
  }
}

const soundFx = new SoundEngine();
window.soundFx = soundFx;

// ========================================================
// CELEBRATION FX (Confetti & Soap Bubbles)
// ========================================================
class CelebrationFX {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas.getContext('2d');
    this.particles = [];
    this.animating = false;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    this.width = this.canvas.width = window.innerWidth;
    this.height = this.canvas.height = window.innerHeight;
  }

  burst(accentColor = '#2563eb') {
    this.resize();
    const colors = [accentColor, '#facc15', '#38bdf8', '#4ade80', '#ec4899', '#ffffff'];

    for (let i = 0; i < 90; i++) {
      this.particles.push({
        type: 'confetti',
        x: this.width / 2 + (Math.random() - 0.5) * 160,
        y: this.height * 0.42,
        vx: (Math.random() - 0.5) * 14,
        vy: -Math.random() * 16 - 6,
        size: Math.random() * 9 + 6,
        color: colors[Math.floor(Math.random() * colors.length)],
        rotation: Math.random() * 360,
        vRot: (Math.random() - 0.5) * 12,
        opacity: 1
      });
    }

    for (let i = 0; i < 35; i++) {
      this.particles.push({
        type: 'bubble',
        x: this.width * Math.random(),
        y: this.height * 0.6 + Math.random() * 100,
        vx: (Math.random() - 0.5) * 2,
        vy: -Math.random() * 3.5 - 1.5,
        radius: Math.random() * 20 + 10,
        wobble: Math.random() * Math.PI * 2,
        opacity: 0.85
      });
    }

    if (!this.animating) {
      this.animating = true;
      this.animate();
    }
  }

  animate() {
    if (this.particles.length === 0) {
      this.ctx.clearRect(0, 0, this.width, this.height);
      this.animating = false;
      return;
    }

    this.ctx.clearRect(0, 0, this.width, this.height);

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];

      if (p.type === 'confetti') {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.45;
        p.vx *= 0.98;
        p.rotation += p.vRot;
        p.opacity -= 0.007;

        this.ctx.save();
        this.ctx.globalAlpha = Math.max(0, p.opacity);
        this.ctx.translate(p.x, p.y);
        this.ctx.rotate((p.rotation * Math.PI) / 180);
        this.ctx.fillStyle = p.color;
        this.ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        this.ctx.restore();
      } else if (p.type === 'bubble') {
        p.x += p.vx + Math.sin(p.wobble) * 0.8;
        p.y += p.vy;
        p.wobble += 0.05;
        p.opacity -= 0.006;

        this.ctx.save();
        this.ctx.globalAlpha = Math.max(0, p.opacity);
        this.ctx.beginPath();
        this.ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        this.ctx.fillStyle = 'rgba(224, 242, 254, 0.25)';
        this.ctx.fill();
        this.ctx.lineWidth = 1.5;
        this.ctx.strokeStyle = 'rgba(56, 189, 248, 0.7)';
        this.ctx.stroke();

        this.ctx.beginPath();
        this.ctx.arc(p.x - p.radius * 0.35, p.y - p.radius * 0.35, p.radius * 0.25, 0, Math.PI * 2);
        this.ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
        this.ctx.fill();
        this.ctx.restore();
      }

      if (p.opacity <= 0 || p.y > this.height + 50) {
        this.particles.splice(i, 1);
      }
    }

    requestAnimationFrame(() => this.animate());
  }
}

const celebration = new CelebrationFX('fx-canvas');

// ========================================================
// SYNCHRONIZATION ENGINE (SSE + In-Memory ETag 304 + Adaptive Polling + Battery Saver)
// ========================================================
let serverPollInterval = null;
let lastServerETag = null;
let sseReconnectTimer = null;
let sseReconnectDelay = 2000;
let isTabActive = !document.hidden;

function updateConnectionUI(online) {
  const dot = document.querySelector('.cloud-dot');
  const label = document.getElementById('cloud-status-label');
  if (online) {
    if (dot) dot.className = 'cloud-dot local-connected';
    if (label) label.textContent = 'Сервер онлайн 🟢';
  } else {
    if (dot) dot.className = 'cloud-dot';
    if (label) label.textContent = 'Офлайн (локально)';
  }
}

function applyServerState(serverState) {
  if (!serverState || !serverState.queue || !Array.isArray(serverState.queue)) return;

  const sHash = `${serverState.currentQueueIndex}-${serverState.dutyStartedAt}-${(serverState.history || []).length}`;
  const lHash = `${state.currentQueueIndex}-${state.dutyStartedAt}-${(state.history || []).length}`;

  if (sHash !== lHash) {
    const prevWasher = getCurrentDutyMember().name;
    state = { ...DEFAULT_STATE, ...serverState };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    renderAll();

    const newWasher = getCurrentDutyMember().name;
    if (prevWasher !== newWasher) {
      soundFx.playVictory();
      celebration.burst(getCurrentDutyMember().color);
    }
  }
}

async function fetchStateOnce(force = false) {
  if (document.hidden && !force) return;

  try {
    const headers = {};
    if (lastServerETag && !force) {
      headers['If-None-Match'] = lastServerETag;
    }

    const res = await fetch('/api/state', { headers, cache: 'no-store' });

    if (res.status === 304) {
      // 304 Not Modified: 0 body bytes transferred! State unchanged!
      updateConnectionUI(true);
      return;
    }

    if (res.ok) {
      const etag = res.headers.get('ETag');
      if (etag) lastServerETag = etag;

      const data = await res.json();
      const serverState = (data && data.state) ? data.state : data;
      applyServerState(serverState);
      updateConnectionUI(true);
    } else {
      updateConnectionUI(false);
    }
  } catch (e) {
    updateConnectionUI(false);
  }
}

function startServerPolling() {
  if (serverPollInterval) {
    clearInterval(serverPollInterval);
    serverPollInterval = null;
  }

  // If tab is in background, never poll (saves mobile battery and CPU)
  if (document.hidden) return;

  // Adaptive interval: if SSE stream is healthy, poll only every 35s as fallback.
  // If SSE is reconnecting or down, poll every 5s.
  const isSSEActive = cloudEventSource && cloudEventSource.readyState === EventSource.OPEN;
  const pollDelay = isSSEActive ? 35000 : 5000;

  serverPollInterval = setInterval(() => {
    if (!document.hidden) {
      fetchStateOnce();
    }
  }, pollDelay);
}

function stopServerPolling() {
  if (serverPollInterval) {
    clearInterval(serverPollInterval);
    serverPollInterval = null;
  }
}

function connectLocalServerSSE() {
  if (cloudEventSource) {
    cloudEventSource.close();
    cloudEventSource = null;
  }
  if (sseReconnectTimer) {
    clearTimeout(sseReconnectTimer);
    sseReconnectTimer = null;
  }

  // If in background, delay SSE connection until foreground
  if (document.hidden) return;

  try {
    cloudEventSource = new EventSource('/api/events');

    cloudEventSource.addEventListener('state_update', (e) => {
      try {
        const raw = JSON.parse(e.data);
        const serverState = (raw && raw.state) ? raw.state : raw;
        applyServerState(serverState);
        updateConnectionUI(true);
      } catch (err) {
        console.error('Error handling SSE state_update:', err);
      }
    });

    cloudEventSource.onopen = () => {
      sseReconnectDelay = 2000;
      updateConnectionUI(true);
      // Switch polling to relaxed 35s keepalive since SSE is pushing live
      startServerPolling();
    };

    cloudEventSource.onerror = () => {
      if (cloudEventSource) {
        cloudEventSource.close();
        cloudEventSource = null;
      }
      // Tighten polling while SSE is offline
      startServerPolling();

      // Exponential backoff reconnect: 2s -> 3s -> 4.5s -> max 15s
      sseReconnectTimer = setTimeout(() => {
        if (!document.hidden) {
          connectLocalServerSSE();
        }
      }, sseReconnectDelay);
      sseReconnectDelay = Math.min(Math.round(sseReconnectDelay * 1.5), 15000);
    };
  } catch (err) {
    console.warn('SSE not supported:', err);
    startServerPolling();
  }
}

async function initCloudSync() {
  await fetchStateOnce(true);
  connectLocalServerSSE();
  startServerPolling();
}

async function pushStateToCloud(actionType = null) {
  const session = getAuthSession();
  if (!session || !session.user || !session.token) {
    console.warn('Blocked: Not authenticated.');
    return;
  }

  // Always push directly to Master Raspberry Pi server
  try {
    const payload = {
      ...state,
      _authUser: session.user.username,
      _authToken: session.token,
      _action: actionType || ''
    };
    const headers = {
      'Content-Type': 'application/json',
      'X-Auth-User': encodeURIComponent(session.user.username),
      'X-Auth-Token': encodeURIComponent(session.token)
    };

    const res = await fetch('/api/state', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      updateConnectionUI(true);
    } else if (res.status === 401) {
      console.warn('Authentication token expired or rejected by server.');
      setAuthSession(null);
      openLoginModal('serezha');
    } else if (res.status === 403) {
      const errData = await res.json().catch(() => ({}));
      showToast(errData.error || 'Действие отклонено сервером', '🔒');
      fetchStateOnce(true);
    }
  } catch (e) {
    console.warn('Failed to push state to server:', e);
    const label = document.getElementById('cloud-status-label');
    if (label) label.textContent = 'Ошибка отправки 🔴';
  }
}

// Smart Battery Saver: Pause sync and polling when screen is locked or tab is hidden
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    isTabActive = false;
    stopServerPolling();
  } else {
    isTabActive = true;
    fetchStateOnce();
    if (!cloudEventSource || cloudEventSource.readyState !== EventSource.OPEN) {
      connectLocalServerSSE();
    }
    startServerPolling();
  }
});

window.addEventListener('pageshow', () => {
  if (!document.hidden) {
    fetchStateOnce();
    startServerPolling();
  }
});

window.addEventListener('focus', () => {
  if (!document.hidden) {
    fetchStateOnce();
  }
});

// ========================================================
// CORE TURN & WASH LOGIC
// ========================================================
function getCurrentDutyMember() {
  const memberId = state.queue[state.currentQueueIndex];
  return state.members[memberId] || state.members.mama;
}

function handleWashDone(note = '') {
  const currentMember = getCurrentDutyMember();
  const user = getCurrentUser();
  const isAdm = isAdmin();

  if (!isLoggedIn()) {
    openLoginModal();
    return;
  }

  if (!isAdm && user.username !== currentMember.id) {
    showToast(`Сейчас дежурит ${currentMember.name}. Отметить может только он(а)!`, '⏳');
    if (window.soundFx) soundFx.playPop();
    return;
  }

  const now = Date.now();
  const durationMs = Math.max(0, now - (state.dutyStartedAt || now));

  // Store undo action
  undoAction = {
    memberId: currentMember.id,
    prevQueueIndex: state.currentQueueIndex,
    prevStats: { ...state.stats },
    prevDutyStartedAt: state.dutyStartedAt,
    historyItemId: now
  };

  // 1. Increment individual count
  state.stats[currentMember.id] = (state.stats[currentMember.id] || 0) + 1;

  // 2. Add rich history entry
  const historyItem = {
    id: now,
    memberId: currentMember.id,
    timestamp: now,
    durationMs: durationMs,
    note: (note || '').trim(),
    reactions: { love: 0, clap: 0, star: 0 }
  };
  state.history.unshift(historyItem);

  // Keep up to 200 history entries
  if (state.history.length > 200) state.history.pop();

  // 3. Move queue to next person
  state.currentQueueIndex = (state.currentQueueIndex + 1) % state.queue.length;
  state.dutyStartedAt = now;

  saveState(false, 'wash');
  renderAll();

  // Celebratory FX & Audio
  if (window.soundFx) {
    soundFx.playWash();
    soundFx.playVictory();
    soundFx.playHaptic('success');
  }
  if (window.celebration) celebration.burst(currentMember.color);

  // Show Toast
  const verb = (currentMember.id === 'mama') ? 'помыла' : 'помыл';
  showUndoToast(`${currentMember.name} ${verb} посуду! Отлично! 🧼`);
}

function handleUndo() {
  if (!undoAction) return;

  const user = getCurrentUser();
  const isAdm = isAdmin();

  if (!isAdm && (!user || user.username !== undoAction.memberId)) {
    showToast('Отменить помывку может только тот, кто помыл, или Серёжа 🔒', 'ℹ️');
    return;
  }

  state.stats = { ...undoAction.prevStats };
  state.currentQueueIndex = undoAction.prevQueueIndex;
  state.dutyStartedAt = undoAction.prevDutyStartedAt;
  state.history = state.history.filter(h => h.id !== undoAction.historyItemId);

  undoAction = null;
  hideUndoToast();
  saveState(false, 'undo');
  renderAll();
  if (window.soundFx) soundFx.playClick();
  showToast('Помывка отменена ↩️', 'ℹ️');
}

function handleSkipTurn() {
  const current = getCurrentDutyMember();
  state.currentQueueIndex = (state.currentQueueIndex + 1) % state.queue.length;
  state.dutyStartedAt = Date.now();

  saveState(false, 'skip');
  renderAll();
  soundFx.playPop();
  showUndoToast(`Очередь ${current.name} пропущена ⏩`, 4000);
}

function handleSwapTurn(targetMemberId) {
  const currentMember = getCurrentDutyMember();
  if (targetMemberId === currentMember.id) return;

  const targetIdx = state.queue.indexOf(targetMemberId);
  if (targetIdx !== -1) {
    const temp = state.queue[state.currentQueueIndex];
    state.queue[state.currentQueueIndex] = state.queue[targetIdx];
    state.queue[targetIdx] = temp;

    state.dutyStartedAt = Date.now();
    saveState(false, 'swap');
    renderAll();
    soundFx.playClick();
    closeAllModals();
  }
}

function handleReaction(historyId, reactionType) {
  const item = state.history.find(h => h.id === historyId);
  if (!item) return;

  if (!item.reactions) item.reactions = { love: 0, clap: 0, star: 0 };
  item.reactions[reactionType] = (item.reactions[reactionType] || 0) + 1;

  if (window.soundFx) soundFx.playPop();
  saveState(false, 'reaction');
  renderHistory();
}

// ========================================================
// RENDERING (Lazy Tab Evaluation + DOM Micro-Diffing)
// ========================================================
const dirtyTabs = {
  'tab-duty': true,
  'tab-history': true,
  'tab-stats': true
};

function markTabsDirty() {
  dirtyTabs['tab-duty'] = true;
  dirtyTabs['tab-history'] = true;
  dirtyTabs['tab-stats'] = true;
}

function renderActiveTab() {
  renderAuthStatus();
  const currentTab = settings.activeTab || 'tab-duty';

  if (currentTab === 'tab-duty') {
    if (dirtyTabs['tab-duty']) {
      renderDutyTab();
      renderProfileUI();
      dirtyTabs['tab-duty'] = false;
    }
  } else if (currentTab === 'tab-history') {
    if (dirtyTabs['tab-history']) {
      renderHistory();
      dirtyTabs['tab-history'] = false;
    }
  } else if (currentTab === 'tab-stats') {
    if (dirtyTabs['tab-stats']) {
      renderStats();
      dirtyTabs['tab-stats'] = false;
    }
  }
}

function renderAll() {
  markTabsDirty();
  renderActiveTab();
}

let lastRenderedQueueHash = '';

function renderDutyTab() {
  const current = getCurrentDutyMember();
  dirtyTabs['tab-duty'] = false;

  // Hero components
  const heroCard = document.getElementById('duty-hero');
  const heroAvatar = document.getElementById('hero-avatar');
  const heroName = document.getElementById('hero-name');
  const heroRoleTitle = document.getElementById('hero-role-title');
  const heroTimer = document.getElementById('hero-timer');
  const heroStreak = document.getElementById('hero-streak');
  const heroAura = document.getElementById('hero-aura');

  if (heroAvatar && heroAvatar.textContent !== current.avatar) {
    heroAvatar.textContent = current.avatar;
  }
  if (heroName) {
    if (heroName.textContent !== current.name) heroName.textContent = current.name;
    if (heroName.style.color !== current.color) heroName.style.color = current.color;
  }
  const roleTitle = current.title || 'Член семьи';
  if (heroRoleTitle && heroRoleTitle.textContent !== roleTitle) {
    heroRoleTitle.textContent = roleTitle;
  }
  if (heroAura) {
    heroAura.style.borderTopColor = current.color;
    heroAura.style.borderRightColor = current.color;
  }
  if (heroCard) {
    heroCard.style.setProperty('--primary-glow', `${current.color}66`);
    heroCard.style.borderColor = `${current.color}45`;
  }

  const timerText = `⏱️ ${formatDutyDuration(state.dutyStartedAt)}`;
  if (heroTimer && heroTimer.textContent !== timerText) {
    heroTimer.textContent = timerText;
  }
  const totalMemberWashes = state.stats[current.id] || 0;
  const streakText = `🧼 Помыто: ${totalMemberWashes}`;
  if (heroStreak && heroStreak.textContent !== streakText) {
    heroStreak.textContent = streakText;
  }

  // Queue track
  renderQueueTrack();

  // Activity glance on Tab 1
  renderActivityGlance();
}

function renderQueueTrack() {
  const track = document.getElementById('queue-track');
  if (!track) return;

  const currentHash = `${state.currentQueueIndex}:${state.queue.join(',')}`;
  if (currentHash === lastRenderedQueueHash && track.children.length > 0) {
    return; // Queue structure and index unchanged, skip DOM rebuild!
  }
  lastRenderedQueueHash = currentHash;
  track.innerHTML = '';

  state.queue.forEach((memberId, idx) => {
    const member = state.members[memberId];
    if (!member) return;

    const isActive = idx === state.currentQueueIndex;
    const isNext = idx === (state.currentQueueIndex + 1) % state.queue.length;

    let label = 'В очереди';
    if (isActive) label = 'Сейчас 🧼';
    else if (isNext) label = 'Следующий 🔔';

    const card = document.createElement('div');
    card.className = `queue-card ${isActive ? 'active' : ''}`;
    card.innerHTML = `
      <span class="queue-pos-badge">#${idx + 1}</span>
      <div class="queue-avatar">${member.avatar}</div>
      <div class="queue-name">${member.name}</div>
      <div class="queue-label">${label}</div>
    `;

    card.addEventListener('click', () => {
      soundFx.playClick();
      soundFx.playHaptic('light');
    });

    track.appendChild(card);
  });
}

function renderActivityGlance() {
  const glanceBox = document.getElementById('recent-glance-box');
  if (!glanceBox) return;
  glanceBox.innerHTML = '';

  if (state.history.length === 0) {
    glanceBox.innerHTML = `<div style="text-align:center; color:var(--text-muted); padding:10px; font-size:0.85rem;">Пока нет записей. Нажмите «Я помыл посуду»!</div>`;
    return;
  }

  state.history.slice(0, 3).forEach(item => {
    const member = state.members[item.memberId] || { name: 'Неизвестный', avatar: '👤' };
    const dateStr = formatCompactDate(item.timestamp);

    const div = document.createElement('div');
    div.className = 'glance-item';
    div.innerHTML = `
      <div style="display:flex; align-items:center; gap:8px;">
        <span>${member.avatar}</span>
        <span style="font-weight:700;">${member.name}</span>
        ${item.note ? `<span style="font-size:0.75rem; color:var(--text-muted);">(${escapeHtml(item.note)})</span>` : ''}
      </div>
      <span style="font-size:0.75rem; color:var(--text-muted);">${dateStr}</span>
    `;
    glanceBox.appendChild(div);
  });
}

let historyRenderLimit = 25;

// Render Tab 2: Detailed History (Virtual Pagination & Delegated Events)
function renderHistory() {
  const timeline = document.getElementById('history-timeline');
  if (!timeline) return;
  timeline.innerHTML = '';
  dirtyTabs['tab-history'] = false;

  // Filter history
  let filtered = state.history || [];
  if (currentHistoryFilter !== 'all') {
    filtered = filtered.filter(h => h.memberId === currentHistoryFilter);
  }

  // Update filter chip counters
  document.querySelectorAll('.filter-chip').forEach(chip => {
    const filter = chip.getAttribute('data-filter');
    if (filter === 'all') {
      chip.textContent = `Все (${(state.history || []).length})`;
    }
  });

  if (filtered.length === 0) {
    timeline.innerHTML = `<div style="text-align:center; padding:30px; color:var(--text-muted); font-family:var(--font-mono); font-size:0.85rem;">История пуста. Начните отмечать дежурства! 🍽️</div>`;
    return;
  }

  // Delegate reaction clicks once on timeline container (zero memory leak, zero per-item listener loop)
  if (!timeline._hasReactionDelegation) {
    timeline._hasReactionDelegation = true;
    timeline.addEventListener('click', (e) => {
      const btn = e.target.closest('.reaction-btn');
      if (!btn) return;
      const id = Number(btn.getAttribute('data-id'));
      const type = btn.getAttribute('data-type');
      if (id && type) {
        handleReaction(id, type);
      }
    });
  }

  // Slice items up to limit for instant render
  const visibleItems = filtered.slice(0, historyRenderLimit);

  // Group by calendar day
  const groups = {};
  visibleItems.forEach(item => {
    const dayKey = getDayGroupKey(item.timestamp);
    if (!groups[dayKey]) groups[dayKey] = [];
    groups[dayKey].push(item);
  });

  for (const [dayTitle, items] of Object.entries(groups)) {
    const groupEl = document.createElement('div');
    groupEl.className = 'timeline-day-group';

    const label = document.createElement('div');
    label.className = 'timeline-date-label';
    label.textContent = dayTitle;
    groupEl.appendChild(label);

    items.forEach(item => {
      const member = state.members[item.memberId] || { name: 'Неизвестно', avatar: '👤', color: '#94a3b8' };
      const timeStr = formatExactTime(item.timestamp);
      const durationStr = formatDurationBadge(item.durationMs);
      const reactions = item.reactions || { love: 0, clap: 0, star: 0 };

      const card = document.createElement('div');
      card.className = 'timeline-card';
      card.style.borderLeft = `4px solid ${member.color}`;

      card.innerHTML = `
        <div class="timeline-card-top">
          <div class="card-person-info">
            <div class="history-avatar-sm">${member.avatar}</div>
            <div class="history-name-block">
              <span class="history-name">${member.name}</span>
              <span class="history-time-meta">${timeStr}</span>
            </div>
          </div>
          ${durationStr ? `<span class="history-duration-tag">⏱️ ${durationStr}</span>` : ''}
        </div>

        ${item.note ? `<div class="timeline-card-note">💬 ${escapeHtml(item.note)}</div>` : ''}

        <div class="history-reactions-row">
          <button class="reaction-btn" data-id="${item.id}" data-type="love" title="Сказать спасибо">
            <span>❤️</span> <span>${reactions.love || 0}</span>
          </button>
          <button class="reaction-btn" data-id="${item.id}" data-type="clap" title="Похвалить">
            <span>👏</span> <span>${reactions.clap || 0}</span>
          </button>
          <button class="reaction-btn" data-id="${item.id}" data-type="star" title="Суперчисто">
            <span>🌟</span> <span>${reactions.star || 0}</span>
          </button>
        </div>
      `;

      groupEl.appendChild(card);
    });

    timeline.appendChild(groupEl);
  }

  // "Показать ещё" button if more items remain
  if (filtered.length > historyRenderLimit) {
    const moreWrap = document.createElement('div');
    moreWrap.className = 'history-more-wrap';
    const remaining = filtered.length - historyRenderLimit;
    moreWrap.innerHTML = `
      <button class="btn-history-more" type="button">
        <span>📜</span>
        <span>Показать ещё (+${remaining > 30 ? 30 : remaining})</span>
      </button>
    `;
    const moreBtn = moreWrap.querySelector('.btn-history-more');
    moreBtn.addEventListener('click', () => {
      if (window.soundFx) soundFx.playClick();
      historyRenderLimit += 30;
      renderHistory();
    });
    timeline.appendChild(moreWrap);
  }
}

// Render Tab 3: Stats & Awards
function renderStats() {
  dirtyTabs['tab-stats'] = false;
  const container = document.getElementById('leaderboard-list');
  const totalBadge = document.getElementById('stat-total-badge');
  const awardsContainer = document.getElementById('awards-grid');
  const podiumContainer = document.getElementById('podium-container');
  const shareBox = document.getElementById('duty-share-box');

  if (container) container.innerHTML = '';
  if (awardsContainer) awardsContainer.innerHTML = '';

  const memberList = Object.values(state.members).map(m => ({
    ...m,
    count: state.stats[m.id] || 0
  }));

  // Sort descending
  memberList.sort((a, b) => b.count - a.count);

  const totalWashes = memberList.reduce((sum, m) => sum + m.count, 0);
  if (totalBadge) {
    totalBadge.textContent = `Всего: ${totalWashes} ${pluralize(totalWashes, 'мойка', 'мойки', 'моек')}`;
  }

  // 1. Render 3D Podium for Top 3
  if (podiumContainer) {
    podiumContainer.innerHTML = '';
    if (memberList.length >= 3 && totalWashes > 0) {
      const top1 = memberList[0];
      const top2 = memberList[1];
      const top3 = memberList[2];

      const podiumOrder = [
        { member: top2, rank: 2, medal: '🥈', label: '2 место' },
        { member: top1, rank: 1, medal: '🥇', label: '1 место' },
        { member: top3, rank: 3, medal: '🥉', label: '3 место' }
      ];

      podiumOrder.forEach(item => {
        const m = item.member;
        const step = document.createElement('div');
        step.className = `podium-step rank-${item.rank}`;
        step.innerHTML = `
          <div class="podium-avatar-wrap">
            ${item.rank === 1 ? '<span class="podium-crown">👑</span>' : ''}
            <div class="podium-avatar" style="border-color:${m.color}">${m.avatar}</div>
          </div>
          <div class="podium-name">${m.name}</div>
          <div class="podium-count">${m.count} ${pluralize(m.count, 'мойка', 'мойки', 'моек')}</div>
          <div class="podium-pillar" style="color:${m.color}">${item.medal}</div>
        `;
        podiumContainer.appendChild(step);
      });
    }
  }

  // 2. Render Duty Distribution Share Bar
  if (shareBox) {
    if (totalWashes > 0) {
      let segmentsHtml = '';
      memberList.forEach(m => {
        const pct = Math.round((m.count / totalWashes) * 100);
        if (pct > 0) {
          segmentsHtml += `<div class="share-segment" style="width:${pct}%; background-color:${m.color};" title="${m.name}: ${pct}%"></div>`;
        }
      });
      shareBox.innerHTML = `
        <div class="duty-share-title">
          <span>Вклад семьи в чистую кухню</span>
          <span>100%</span>
        </div>
        <div class="duty-share-bar">
          ${segmentsHtml}
        </div>
      `;
    } else {
      shareBox.innerHTML = '';
    }
  }

  // 3. Render Detailed Leaderboard List
  const medals = ['🥇', '🥈', '🥉', '✨'];
  const maxWashes = memberList[0]?.count || 1;

  memberList.forEach((m, idx) => {
    const percent = totalWashes > 0 ? Math.round((m.count / totalWashes) * 100) : 0;
    const barWidth = maxWashes > 0 ? Math.round((m.count / maxWashes) * 100) : 0;

    const row = document.createElement('div');
    row.className = 'leader-card-item';
    row.innerHTML = `
      <div class="leader-bg-bar" style="width: ${barWidth}%; background-color: ${m.color}"></div>
      <div class="leader-item-left">
        <span class="leader-medal">${medals[idx] || '✨'}</span>
        <span class="leader-avatar-box">${m.avatar}</span>
        <div class="leader-title-box">
          <span class="leader-person-name">${m.name}</span>
          <span class="leader-person-title">${m.title}</span>
        </div>
      </div>
      <div class="leader-item-right">
        <span class="leader-washes-num" style="color: ${m.color}">${m.count}</span>
        <span class="leader-washes-pct">${percent}% от всех</span>
      </div>
    `;
    if (container) container.appendChild(row);
  });

  // Calculate Family Awards
  // 1. Most active washer
  const topWasher = memberList[0]?.count > 0 ? memberList[0] : null;
  // 2. Most loved washer (reactions)
  const reactionCounts = { mama: 0, papa: 0, serezha: 0, vasya: 0 };
  state.history.forEach(h => {
    if (h.reactions && reactionCounts[h.memberId] !== undefined) {
      reactionCounts[h.memberId] += (h.reactions.love || 0) + (h.reactions.clap || 0) + (h.reactions.star || 0);
    }
  });
  let mostLovedMemberId = Object.keys(reactionCounts).reduce((a, b) => reactionCounts[a] > reactionCounts[b] ? a : b, 'mama');
  const mostLoved = reactionCounts[mostLovedMemberId] > 0 ? state.members[mostLovedMemberId] : null;

  if (awardsContainer) {
    awardsContainer.innerHTML = `
      <div class="award-box">
        <span class="award-icon">🍳</span>
        <span class="award-name">Гроза сковородок</span>
        <span class="award-winner">${topWasher ? `${topWasher.name} (${topWasher.count} раз)` : 'Пока никто'}</span>
      </div>
      <div class="award-box">
        <span class="award-icon">💖</span>
        <span class="award-name">Любимчик кухни</span>
        <span class="award-winner">${mostLoved ? `${mostLoved.name} (${reactionCounts[mostLovedMemberId]} ❤️)` : 'Ждёт реакций'}</span>
      </div>
      <div class="award-box">
        <span class="award-icon">🧼</span>
        <span class="award-name">Чистюля недели</span>
        <span class="award-winner">${topWasher ? topWasher.name : 'Вся семья'}</span>
      </div>
      <div class="award-box">
        <span class="award-icon">🌟</span>
        <span class="award-name">Мастер блеска</span>
        <span class="award-winner">Мама & Папа & Дети</span>
      </div>
    `;
  }
}

// ========================================================
// EXPORT HISTORY TO CSV
// ========================================================
function exportHistoryToCSV() {
  soundFx.playClick();
  if (state.history.length === 0) {
    alert('История пуста для экспорта.');
    return;
  }

  let csv = 'Дата,Время,Кто мыл,Время дежурства,Заметка,Лайки ❤️\n';
  state.history.forEach(h => {
    const d = new Date(h.timestamp);
    const dateStr = d.toLocaleDateString('ru-RU');
    const timeStr = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const name = state.members[h.memberId]?.name || h.memberId;
    const dur = formatDurationBadge(h.durationMs) || '0';
    const note = (h.note || '').replace(/"/g, '""');
    const loves = h.reactions ? (h.reactions.love || 0) : 0;
    csv += `"${dateStr}","${timeStr}","${name}","${dur}","${note}","${loves}"\n`;
  });

  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `istoriya-posudy-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Backup Export / Import JSON
function exportBackupJSON() {
  soundFx.playClick();
  const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(state, null, 2));
  const a = document.createElement('a');
  a.href = dataStr;
  a.download = `dish-duty-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function handleImportJSON(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const imported = JSON.parse(event.target.result);
      if (imported.members && imported.queue) {
        state = { ...DEFAULT_STATE, ...imported };
        saveState();
        renderAll();
        soundFx.playVictory();
        alert('Данные и история успешно восстановлены!');
      } else {
        alert('Некорректный файл резервной копии.');
      }
    } catch (err) {
      alert('Ошибка при чтении файла.');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

// ========================================================
// FORMATTING HELPERS
// ========================================================
function formatDutyDuration(startedAt) {
  if (!startedAt) return 'Дежурит';
  const diffMin = Math.floor((Date.now() - startedAt) / 60000);
  if (diffMin < 1) return 'Только заступил(а)';
  if (diffMin < 60) return `Дежурит ${diffMin} мин.`;
  const h = Math.floor(diffMin / 60);
  const m = diffMin % 60;
  return `Дежурит ${h} ч. ${m} мин.`;
}

function formatDurationBadge(ms) {
  if (!ms || ms < 60000) return 'быстро';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins} мин.`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h} ч. ${m} мин.`;
}

function formatExactTime(ts) {
  const d = new Date(ts);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  return `${hh}:${mm}`;
}

function formatCompactDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const time = formatExactTime(ts);
  if (d.toDateString() === now.toDateString()) return `Сегодня, ${time}`;
  return `${d.getDate()} окт, ${time}`;
}

function getDayGroupKey(ts) {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();

  if (isToday) return 'Сегодня';
  if (isYesterday) return 'Вчера';

  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

function pluralize(n, one, two, five) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 19) return five;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return two;
  return five;
}

function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return text.replace(/[&<>"']/g, m => map[m]);
}

// ========================================================
// TOAST NOTIFICATION
// ========================================================
let toastTimeout = null;

function showToast(text, icon = '✨', duration = 4000) {
  const toast = document.getElementById('undo-toast');
  const textEl = document.getElementById('undo-text');
  const iconEl = toast ? toast.querySelector('.toast-icon') : null;
  const undoBtn = document.getElementById('btn-undo');
  if (textEl) textEl.textContent = text;
  if (iconEl) iconEl.textContent = icon;
  if (undoBtn) undoBtn.style.display = 'none';
  if (toast) toast.classList.remove('hidden');

  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    hideUndoToast();
  }, duration);
}

function showUndoToast(text, duration = 8000) {
  const toast = document.getElementById('undo-toast');
  const textEl = document.getElementById('undo-text');
  const iconEl = toast ? toast.querySelector('.toast-icon') : null;
  const undoBtn = document.getElementById('btn-undo');
  if (textEl) textEl.textContent = text;
  if (iconEl) iconEl.textContent = '🧼';
  if (undoBtn) undoBtn.style.display = '';
  if (toast) toast.classList.remove('hidden');

  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    hideUndoToast();
  }, duration);
}

function hideUndoToast() {
  const toast = document.getElementById('undo-toast');
  if (toast) toast.classList.add('hidden');
  const undoBtn = document.getElementById('btn-undo');
  if (undoBtn) undoBtn.style.display = '';
  const iconEl = toast ? toast.querySelector('.toast-icon') : null;
  if (iconEl) iconEl.textContent = '🧼';
  if (toastTimeout) clearTimeout(toastTimeout);
}

// ========================================================
// AUTH UI STATUS RENDERING
// ========================================================
function renderAuthStatus() {
  const user = getCurrentUser();
  const admin = isAdmin();

  // 1. Top nav account pill button
  const accBtn = document.getElementById('btn-account-badge');
  const accAvatar = document.getElementById('account-badge-avatar');
  const accName = document.getElementById('account-badge-name');
  const accRole = document.getElementById('account-badge-role');

  if (accBtn && accAvatar && accName) {
    if (user) {
      accAvatar.textContent = user.avatar || '👤';
      accName.textContent = user.name || user.username;
      if (accRole) {
        accRole.textContent = admin ? '👑' : '▾';
      }
      accBtn.classList.toggle('is-admin', admin);
      accBtn.title = `Вы вошли как ${user.name} (${admin ? 'Администратор' : 'Дежурный'}). Нажмите для просмотра`;
    } else {
      accAvatar.textContent = '👤';
      accName.textContent = 'Войти';
      if (accRole) accRole.textContent = '▾';
      accBtn.classList.remove('is-admin');
      accBtn.title = 'Нажмите, чтобы войти в аккаунт';
    }
  }

  // 2. Settings modal section
  const settingsBadge = document.getElementById('settings-auth-badge');
  const settingsDesc = document.getElementById('settings-auth-desc');
  const settingsActions = document.getElementById('settings-auth-actions');
  if (settingsBadge && settingsDesc && settingsActions) {
    if (user) {
      if (admin) {
        settingsBadge.className = 'setup-badge';
        settingsBadge.textContent = '👑 Администратор (Серёжа)';
        settingsDesc.textContent = 'Вам доступны все права: управление очередью, пропуск, обмен и сброс данных.';
        settingsActions.innerHTML = `
          <button type="button" class="secondary-action-btn" onclick="openAccountModal();">
            Мой аккаунт (Серёжа) 👤
          </button>
        `;
      } else {
        settingsBadge.className = 'setup-badge neutral';
        settingsBadge.textContent = `${user.name} (Дежурный)`;
        settingsDesc.textContent = 'Вы можете отмечать помывку посуды, когда наступит ваша очередь. Изменение очереди закрыто.';
        settingsActions.innerHTML = `
          <button type="button" class="secondary-action-btn" onclick="openAccountModal();">
            Мой аккаунт (${user.name}) 👤
          </button>
        `;
      }
    } else {
      settingsBadge.className = 'setup-badge neutral';
      settingsBadge.textContent = '🔒 Не авторизован';
      settingsDesc.textContent = 'Войдите в аккаунт, чтобы отмечать помытую посуду.';
      settingsActions.innerHTML = `
        <button type="button" class="primary-action-btn" onclick="closeAllModals(); openLoginModal('serezha');">
          Войти в аккаунт 🔓
        </button>
      `;
    }
  }
}

// ========================================================
// PROFILE & DYNAMIC TURN UI RENDERING
// ========================================================
function renderProfileUI() {
  const user = getCurrentUser();
  const currentDuty = getCurrentDutyMember();
  const isAdm = isAdmin();

  // 1. Personal duty status banner
  const banner = document.getElementById('banner-duty-status');
  const bannerIcon = document.getElementById('banner-status-icon');
  const bannerTitle = document.getElementById('banner-status-title');
  const bannerSub = document.getElementById('banner-status-sub');
  const bannerBtn = document.getElementById('btn-banner-profile');

  if (banner && bannerIcon && bannerTitle && bannerSub) {
    if (!user) {
      banner.className = 'duty-status-banner no-profile';
      bannerIcon.textContent = '👤';
      bannerTitle.textContent = 'Войдите в свой аккаунт';
      bannerSub.textContent = 'Отмечать помывку сможет только тот, чья сейчас очередь';
      if (bannerBtn) bannerBtn.textContent = 'Войти 🔓';
    } else if (user.username === currentDuty.id) {
      banner.className = 'duty-status-banner is-my-turn';
      bannerIcon.textContent = '✨';
      bannerTitle.textContent = `${user.name}, сейчас ваша очередь дежурить! 🧼`;
      bannerSub.textContent = 'Помойте посуду и нажмите «Я помыл(а) посуду!» ниже';
      if (bannerBtn) bannerBtn.textContent = 'Мой профиль 👤';
    } else if (isAdm) {
      banner.className = 'duty-status-banner is-my-turn';
      bannerIcon.textContent = '👑';
      bannerTitle.textContent = `Администратор Серёжа (дежурит: ${currentDuty.name} ${currentDuty.avatar})`;
      bannerSub.textContent = 'Вы можете отметить помывку за дежурного или настроить очередь';
      if (bannerBtn) bannerBtn.textContent = 'Мой профиль 👤';
    } else {
      banner.className = 'duty-status-banner is-not-my-turn';
      bannerIcon.textContent = '⏳';
      bannerTitle.textContent = `Сейчас дежурит: ${currentDuty.name} ${currentDuty.avatar}`;

      const userQueueIdx = state.queue.indexOf(user.username);
      let turnsRemaining = -1;
      if (userQueueIdx !== -1) {
        turnsRemaining = (userQueueIdx - state.currentQueueIndex + state.queue.length) % state.queue.length;
      }

      if (turnsRemaining === 1) {
        bannerSub.textContent = `🔔 Вы следующий(ая) в очереди! Приготовьтесь после ${currentDuty.name}`;
      } else if (turnsRemaining > 1) {
        bannerSub.textContent = `Ваш черёд через ${turnsRemaining} ${pluralize(turnsRemaining, 'смену', 'смены', 'смен')}. На этом телефоне доступен просмотр`;
      } else {
        bannerSub.textContent = `Ваш черёд наступит позже (${user.name}). На этом телефоне доступен просмотр`;
      }
      if (bannerBtn) bannerBtn.textContent = 'Мой профиль 👤';
    }
  }

  // 2. Wash button styling & text
  const washBtn = document.getElementById('btn-wash-done');
  if (washBtn) {
    washBtn.classList.remove('btn-locked', 'btn-my-turn', 'btn-not-my-turn', 'btn-no-profile');

    if (!user) {
      washBtn.classList.add('btn-no-profile');
      washBtn.innerHTML = `
        <span class="wash-icon">👤</span>
        <div class="wash-label-box">
          <span class="wash-title">КТО ПОМЫЛ ПОСУДУ?</span>
          <span class="wash-sub">Нажмите, чтобы войти в аккаунт 🔓</span>
        </div>
      `;
    } else if (user.username === currentDuty.id) {
      washBtn.classList.add('btn-my-turn');
      const actionTitle = (user.username === 'mama') ? 'Я ПОМЫЛА ПОСУДУ!' : 'Я ПОМЫЛ ПОСУДУ!';
      washBtn.innerHTML = `
        <div class="wash-btn-shine"></div>
        <span class="wash-icon">🧼</span>
        <div class="wash-label-box">
          <span class="wash-title">${actionTitle}</span>
          <span class="wash-sub">Передать очередь дальше ✨ (+1 к рейтингу)</span>
        </div>
      `;
    } else if (isAdm) {
      washBtn.classList.add('btn-my-turn');
      washBtn.innerHTML = `
        <div class="wash-btn-shine"></div>
        <span class="wash-icon">👑</span>
        <div class="wash-label-box">
          <span class="wash-title">ОТМЕТИТЬ ЗА: ${currentDuty.name.toUpperCase()}</span>
          <span class="wash-sub">Режим управления (Серёжа) ✨</span>
        </div>
      `;
    } else {
      washBtn.classList.add('btn-locked', 'btn-not-my-turn');
      const userQueueIdx = state.queue.indexOf(user.username);
      let turnsRemaining = -1;
      if (userQueueIdx !== -1) {
        turnsRemaining = (userQueueIdx - state.currentQueueIndex + state.queue.length) % state.queue.length;
      }
      const subMsg = (turnsRemaining === 1) ? '🔔 Вы следующий(ая) в очереди!' : `Отметить может только ${currentDuty.name} 🔒`;
      washBtn.innerHTML = `
        <span class="wash-icon">⏳</span>
        <div class="wash-label-box">
          <span class="wash-title">ДЕЖУРИТ: ${currentDuty.name.toUpperCase()}</span>
          <span class="wash-sub">${subMsg}</span>
        </div>
      `;
    }
  }
}

// ========================================================
// MODAL CONTROLS
// ========================================================
function openModal(id) {
  const modal = document.getElementById(id);
  if (modal) {
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }
}

function closeAllModals() {
  document.querySelectorAll('.modal-backdrop').forEach(m => {
    m.classList.add('hidden');
  });
  document.body.style.overflow = '';
}

// Expose globally so inline onclick="closeAllModals()" always works
window.openModal = openModal;
window.closeAllModals = closeAllModals;

// Delegated click handler on document for closing modals
document.addEventListener('click', (e) => {
  const closeBtn = e.target.closest('.modal-close-btn');
  if (closeBtn) {
    e.preventDefault();
    closeAllModals();
    if (window.soundFx && typeof window.soundFx.playClick === 'function') {
      window.soundFx.playClick();
    }
    return;
  }

  if (e.target.classList.contains('modal-backdrop')) {
    e.preventDefault();
    closeAllModals();
    if (window.soundFx && typeof window.soundFx.playClick === 'function') {
      window.soundFx.playClick();
    }
  }
});

// Escape key to close any modal
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' || e.key === 'Esc') {
    closeAllModals();
  }
});

function openSwapModal() {
  const current = getCurrentDutyMember();
  const grid = document.getElementById('swap-member-list');
  grid.innerHTML = '';

  Object.values(state.members).forEach(m => {
    if (m.id === current.id) return;
    const card = document.createElement('div');
    card.className = 'swap-card';
    card.innerHTML = `
      <span style="font-size:2.2rem;">${m.avatar}</span>
      <span style="font-weight:700; font-size:0.95rem;">${m.name}</span>
    `;
    card.addEventListener('click', () => {
      requireAdmin(() => handleSwapTurn(m.id));
    });
    grid.appendChild(card);
  });

  openModal('modal-swap');
}

function openReorderModal() {
  const container = document.getElementById('reorder-rows-container');
  const tempQueue = [...state.queue];

  function renderRows() {
    container.innerHTML = '';
    tempQueue.forEach((mId, idx) => {
      const m = state.members[mId];
      const row = document.createElement('div');
      row.className = 'reorder-row-item';
      row.innerHTML = `
        <div style="display:flex; align-items:center; gap:10px;">
          <span style="font-size:1.6rem;">${m.avatar}</span>
          <span style="font-weight:700;">${m.name}</span>
        </div>
        <div class="reorder-arrows-box">
          <button class="btn-arrow" ${idx === 0 ? 'disabled' : ''} data-dir="up" data-idx="${idx}">▲</button>
          <button class="btn-arrow" ${idx === tempQueue.length - 1 ? 'disabled' : ''} data-dir="down" data-idx="${idx}">▼</button>
        </div>
      `;
      container.appendChild(row);
    });

    container.querySelectorAll('.btn-arrow').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const dir = e.currentTarget.dataset.dir;
        const i = parseInt(e.currentTarget.dataset.idx, 10);
        const swapI = dir === 'up' ? i - 1 : i + 1;
        if (swapI >= 0 && swapI < tempQueue.length) {
          const tmp = tempQueue[i];
          tempQueue[i] = tempQueue[swapI];
          tempQueue[swapI] = tmp;
          soundFx.playClick();
          renderRows();
        }
      });
    });
  }

  renderRows();

  document.getElementById('btn-save-reorder-modal').onclick = () => {
    requireAdmin(() => {
      state.queue = [...tempQueue];
      state.currentQueueIndex = 0;
      state.dutyStartedAt = Date.now();
      saveState(false, 'reorder');
      renderAll();
      closeAllModals();
      soundFx.playVictory();
    });
  };

  openModal('modal-reorder');
}

// ========================================================
// WAKE LOCK & THEME
// ========================================================
async function toggleWakeLock() {
  const btn = document.getElementById('btn-wake');
  if (!('wakeLock' in navigator)) {
    alert('Ваш браузер не поддерживает удержание экрана активным.');
    return;
  }

  try {
    if (wakeLockSentinel) {
      await wakeLockSentinel.release();
      wakeLockSentinel = null;
      btn.classList.remove('active');
      soundFx.playClick();
    } else {
      wakeLockSentinel = await navigator.wakeLock.request('screen');
      btn.classList.add('active');
      soundFx.playPop();
      wakeLockSentinel.addEventListener('release', () => {
        btn.classList.remove('active');
        wakeLockSentinel = null;
      });
    }
  } catch (err) {
    console.warn('Wake Lock error:', err);
  }
}

// ========================================================
// DOM INITIALIZATION
// ========================================================
document.addEventListener('DOMContentLoaded', () => {
  // Theme init
  const currentTheme = settings.theme || 'dark';
  document.documentElement.setAttribute('data-theme', currentTheme);
  const themeBtnIcon = document.getElementById('btn-theme')?.querySelector('.btn-icon');
  if (themeBtnIcon) {
    themeBtnIcon.textContent = (currentTheme === 'dark') ? '☀️' : '🌙';
  }

  // Theme switch button
  document.getElementById('btn-theme').addEventListener('click', () => {
    soundFx.playClick();
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const newTheme = isDark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    settings.theme = newTheme;
    if (themeBtnIcon) {
      themeBtnIcon.textContent = (newTheme === 'dark') ? '☀️' : '🌙';
    }
    saveSettings();
  });

  // Sound toggle button
  const btnSound = document.getElementById('btn-sound');
  btnSound.querySelector('.btn-icon').textContent = settings.sound ? '🔊' : '🔇';
  btnSound.addEventListener('click', () => {
    settings.sound = !settings.sound;
    btnSound.querySelector('.btn-icon').textContent = settings.sound ? '🔊' : '🔇';
    saveSettings();
    if (settings.sound) soundFx.playPop();
  });

  // Wake lock
  const btnWake = document.getElementById('btn-wake');
  if (btnWake) {
    btnWake.addEventListener('click', toggleWakeLock);
  }

  // Bottom Tab Navigation
  document.querySelectorAll('.tab-item').forEach(tabBtn => {
    tabBtn.addEventListener('click', () => {
      soundFx.playClick();
      soundFx.playHaptic('light');
      const targetTabId = tabBtn.getAttribute('data-tab');

      // Update buttons
      document.querySelectorAll('.tab-item').forEach(b => b.classList.remove('active'));
      tabBtn.classList.add('active');

      // Update tab views
      document.querySelectorAll('.tab-view').forEach(view => view.classList.remove('active'));
      const activeView = document.getElementById(targetTabId);
      if (activeView) activeView.classList.add('active');

      settings.activeTab = targetTabId;
      saveSettings();
      renderActiveTab();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  // Hamburger Settings button
  const btnMenu = document.getElementById('btn-menu');
  if (btnMenu) {
    btnMenu.addEventListener('click', () => {
      soundFx.playClick();
      openModal('modal-settings');
    });
  }

  // Ensure active tab exists
  if (!document.getElementById(settings.activeTab)) {
    settings.activeTab = 'tab-duty';
  }

  // Account badge in header
  const btnAccountBadge = document.getElementById('btn-account-badge');
  if (btnAccountBadge) {
    btnAccountBadge.addEventListener('click', (e) => {
      e.preventDefault();
      if (isLoggedIn()) {
        openAccountModal();
      } else {
        openLoginModal('serezha');
      }
      if (window.soundFx) soundFx.playClick();
    });
  }

  // Account button on duty banner
  const btnBannerProfile = document.getElementById('btn-banner-profile');
  if (btnBannerProfile) {
    btnBannerProfile.addEventListener('click', (e) => {
      e.preventDefault();
      if (isLoggedIn()) {
        openAccountModal();
      } else {
        openLoginModal('serezha');
      }
      if (window.soundFx) soundFx.playClick();
    });
  }

  // User pills in login modal
  document.querySelectorAll('.login-user-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      const u = pill.getAttribute('data-user');
      if (!u) return;
      document.querySelectorAll('.login-user-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      const hiddenInput = document.getElementById('login-username');
      if (hiddenInput) hiddenInput.value = u;
      const labelEl = document.getElementById('login-label-user');
      const nameText = pill.querySelector('.login-user-name')?.textContent || u;
      if (labelEl) labelEl.textContent = `Пароль для ${nameText}:`;
      const passInput = document.getElementById('login-password');
      if (passInput) {
        passInput.value = '';
        passInput.focus();
      }
      const errorMsg = document.getElementById('login-error-msg');
      if (errorMsg) errorMsg.classList.add('hidden');
      if (window.soundFx) soundFx.playClick();
    });
  });

  // Login form submission
  const formLogin = document.getElementById('form-login');
  if (formLogin) {
    formLogin.addEventListener('submit', async (e) => {
      e.preventDefault();
      const usernameInput = document.getElementById('login-username');
      const passInput = document.getElementById('login-password');
      const errorMsg = document.getElementById('login-error-msg');
      const submitBtn = document.getElementById('btn-submit-login');

      const username = usernameInput ? usernameInput.value : '';
      const password = passInput ? passInput.value : '';

      if (!username || !password) return;

      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Входим... ⏳';
      }

      const res = await loginUser(username, password);

      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Войти в аккаунт 🔓';
      }

      if (!res.success) {
        if (errorMsg) {
          errorMsg.textContent = `❌ ${res.error || 'Неверный пароль'}`;
          errorMsg.classList.remove('hidden');
        }
        if (passInput) {
          passInput.value = '';
          passInput.focus();
        }
        if (window.soundFx) soundFx.playPop();
      }
    });
  }

  // Toggle password visibility button
  const btnTogglePass = document.getElementById('btn-toggle-login-pass');
  if (btnTogglePass) {
    btnTogglePass.addEventListener('click', () => {
      const passInput = document.getElementById('login-password');
      if (passInput) {
        if (passInput.type === 'password') {
          passInput.type = 'text';
          btnTogglePass.textContent = '🙈';
        } else {
          passInput.type = 'password';
          btnTogglePass.textContent = '👁️';
        }
      }
    });
  }

  // Logout button in account modal
  const btnLogoutAccount = document.getElementById('btn-logout-account');
  if (btnLogoutAccount) {
    btnLogoutAccount.addEventListener('click', () => {
      const u = getCurrentUser();
      const name = u ? u.name : 'пользователя';
      if (confirm(`Выйти из аккаунта ${name} на этом устройстве?`)) {
        logoutUser();
      }
    });
  }

  // Main Wash button
  const btnWashDone = document.getElementById('btn-wash-done');
  if (btnWashDone) {
    btnWashDone.addEventListener('click', () => {
      const user = getCurrentUser();
      const currentMember = getCurrentDutyMember();
      const isAdm = isAdmin();

      if (!user) {
        openLoginModal('serezha');
        return;
      }

      if (user.username === currentMember.id || isAdm) {
        handleWashDone();
      } else {
        showToast(`Сейчас дежурит ${currentMember.name}. Отметить может только он(а)! 🔒`, '⏳');
        if (window.soundFx) soundFx.playPop();
      }
    });
  }

  // Undo button
  const btnUndo = document.getElementById('btn-undo');
  if (btnUndo) {
    btnUndo.addEventListener('click', () => {
      handleUndo();
    });
  }

  // Turn Modifiers (Admin only)
  const btnSkipDuty = document.getElementById('btn-skip-duty');
  if (btnSkipDuty) {
    btnSkipDuty.addEventListener('click', () => {
      requireAdmin(() => handleSkipTurn());
    });
  }

  const btnSwapDuty = document.getElementById('btn-swap-duty');
  if (btnSwapDuty) {
    btnSwapDuty.addEventListener('click', () => {
      requireAdmin(() => openSwapModal());
    });
  }

  const btnReorderQueue = document.getElementById('btn-reorder-queue');
  if (btnReorderQueue) {
    btnReorderQueue.addEventListener('click', () => {
      requireAdmin(() => openReorderModal());
    });
  }

  // Note Modal
  const btnAddNote = document.getElementById('btn-add-note');
  if (btnAddNote) {
    btnAddNote.addEventListener('click', () => {
      const user = getCurrentUser();
      const currentMember = getCurrentDutyMember();
      const isAdm = isAdmin();

      if (!user) {
        openLoginModal('serezha');
        return;
      }

      if (user.username === currentMember.id || isAdm) {
        const textEl = document.getElementById('modal-note-text');
        if (textEl) textEl.value = '';
        openModal('modal-note');
      } else {
        showToast(`Сейчас дежурит ${currentMember.name}!`, '⏳');
        if (window.soundFx) soundFx.playPop();
      }
    });
  }

  document.querySelectorAll('.note-tag-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const textarea = document.getElementById('modal-note-text');
      const tag = btn.getAttribute('data-tag');
      if (textarea && tag) {
        textarea.value = textarea.value ? `${textarea.value} ${tag}` : tag;
        if (window.soundFx) soundFx.playClick();
      }
    });
  });

  const btnSubmitNoteWash = document.getElementById('btn-submit-note-wash');
  if (btnSubmitNoteWash) {
    btnSubmitNoteWash.addEventListener('click', () => {
      const textEl = document.getElementById('modal-note-text');
      const note = textEl ? textEl.value : '';
      closeAllModals();
      handleWashDone(note);
    });
  }

  // View all history button from Tab 1
  const btnViewAllHistory = document.getElementById('btn-view-all-history');
  if (btnViewAllHistory) {
    btnViewAllHistory.addEventListener('click', () => {
      const histTab = document.querySelector('[data-tab="tab-history"]');
      if (histTab) histTab.click();
    });
  }

  // History Filter Chips
  document.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      if (window.soundFx) soundFx.playClick();
      document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      currentHistoryFilter = chip.getAttribute('data-filter');
      renderHistory();
    });
  });

  // Export History CSV
  const btnExportHistory = document.getElementById('btn-export-history');
  if (btnExportHistory) {
    btnExportHistory.addEventListener('click', exportHistoryToCSV);
  }

  // Cloud Settings Tab
  const inputFirebase = document.getElementById('input-firebase-url');
  if (inputFirebase) inputFirebase.value = settings.firebaseUrl || '';

  const btnSaveCloud = document.getElementById('btn-save-cloud');
  if (btnSaveCloud) {
    btnSaveCloud.addEventListener('click', () => {
      if (inputFirebase) {
        settings.firebaseUrl = inputFirebase.value.trim();
        saveSettings();
        soundFx.playVictory();
        alert('Настройки облака сохранены! Подключаемся...');
        initCloudSync();
      }
    });
  }

  // Cloud guide modal
  const btnCloudGuide = document.getElementById('btn-cloud-guide');
  if (btnCloudGuide) {
    btnCloudGuide.addEventListener('click', () => {
      openModal('modal-cloud-guide');
    });
  }

  // Copy local IP
  const btnCopyLocalIp = document.getElementById('btn-copy-local-ip');
  if (btnCopyLocalIp) {
    btnCopyLocalIp.addEventListener('click', () => {
      const codeEl = document.getElementById('local-ip-code');
      const code = codeEl ? codeEl.textContent : 'http://192.168.1.75:8080';
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(() => {
          soundFx.playPop();
          alert('Адрес скопирован в буфер обмена!');
        }).catch(() => {
          alert('Адрес: ' + code);
        });
      } else {
        alert('Адрес: ' + code);
      }
    });
  }

  // Backup handlers
  const btnExportBackup = document.getElementById('btn-export-backup');
  if (btnExportBackup) btnExportBackup.addEventListener('click', exportBackupJSON);

  const btnImportBackup = document.getElementById('btn-import-backup');
  const fileImportInput = document.getElementById('file-import-input');
  if (btnImportBackup && fileImportInput) {
    btnImportBackup.addEventListener('click', () => {
      requireAdmin(() => fileImportInput.click());
    });
    fileImportInput.addEventListener('change', handleImportJSON);
  }

  // Reset data handler
  const btnResetData = document.getElementById('btn-reset-data');
  if (btnResetData) {
    btnResetData.addEventListener('click', () => {
      requireAdmin(() => {
        if (confirm('ВНИМАНИЕ: Вы уверены, что хотите сбросить всю историю и статистику мытья посуды?')) {
          state.history = [];
          state.stats = { mama: 0, papa: 0, serezha: 0, vasya: 0 };
          saveState(false, 'reset');
          renderAll();
          soundFx.playClick();
          alert('Данные сброшены.');
        }
      });
    });
  }

  // Direct modal close bindings
  document.querySelectorAll('.modal-close-btn').forEach(btn => {
    btn.addEventListener('click', closeAllModals);
  });
  document.querySelectorAll('.modal-backdrop').forEach(bg => {
    bg.addEventListener('click', (e) => {
      if (e.target === bg) closeAllModals();
    });
  });

  // Periodic timer for duty duration (every minute)
  setInterval(() => {
    const timerEl = document.getElementById('hero-timer');
    if (timerEl) timerEl.textContent = formatDutyDuration(state.dutyStartedAt);
  }, 60000);

  // Initial render
  renderAll();

  // If user is not logged in yet, prompt them gently with the login modal
  if (!isLoggedIn()) {
    setTimeout(() => {
      openLoginModal('serezha');
    }, 450);
  }

  // Initialize Cloud Sync
  initCloudSync();

  // Register PWA service worker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(err => {
        console.log('SW registration skipped:', err);
      });
    });
  }
});
