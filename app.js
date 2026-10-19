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
// AUTH & ACCESS RIGHTS (Пароль "525252")
// ========================================================
const AUTH_STORAGE_KEY = 'dish_tracker_admin_auth';
const VALID_ADMIN_PASSWORDS = ['525252', 'мамамолодец'];

function getSavedAdminPassword() {
  return localStorage.getItem(AUTH_STORAGE_KEY) || '';
}

function normalizePassword(pass) {
  if (!pass || typeof pass !== 'string') return '';
  return pass.trim().toLowerCase().replace(/ё/g, 'е');
}

function isPasswordValid(pass) {
  const norm = normalizePassword(pass);
  return VALID_ADMIN_PASSWORDS.includes(norm);
}

function isAdmin() {
  return isPasswordValid(getSavedAdminPassword());
}

let pendingAuthAction = null;

function requireAdmin(actionCallback) {
  if (isAdmin()) {
    actionCallback();
    return;
  }
  openAuthModal(actionCallback);
}

function openAuthModal(callback = null) {
  if (callback) pendingAuthAction = callback;
  const input = document.getElementById('input-admin-pass');
  if (input) {
    input.value = '';
    setTimeout(() => input.focus(), 150);
  }
  const err = document.getElementById('auth-error-msg');
  if (err) err.classList.add('hidden');
  openModal('modal-auth');
}

function handleAuthSubmit() {
  const input = document.getElementById('input-admin-pass');
  const err = document.getElementById('auth-error-msg');
  const entered = input ? input.value : '';

  if (isPasswordValid(entered)) {
    localStorage.setItem(AUTH_STORAGE_KEY, '525252');
    closeAllModals();
    if (window.soundFx) soundFx.playVictory();
    showToast('👑 Режим управления активирован (Серёжа)!', '🎉');
    renderAuthStatus();

    if (typeof pendingAuthAction === 'function') {
      const fn = pendingAuthAction;
      pendingAuthAction = null;
      fn();
    }
  } else {
    if (err) err.classList.remove('hidden');
    if (window.soundFx) soundFx.playPop();
    if (input) {
      input.classList.add('input-shake');
      setTimeout(() => input.classList.remove('input-shake'), 400);
    }
  }
}

function logoutAdmin() {
  localStorage.removeItem(AUTH_STORAGE_KEY);
  if (window.soundFx) soundFx.playClick();
  showToast('🔒 Переключено в режим просмотра', '👁️');
  renderAuthStatus();
}

window.isAdmin = isAdmin;
window.requireAdmin = requireAdmin;
window.openAuthModal = openAuthModal;
window.handleAuthSubmit = handleAuthSubmit;
window.logoutAdmin = logoutAdmin;

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

function saveState(skipCloudPush = false) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error('Failed to save state to localStorage:', e);
  }

  if (!skipCloudPush) {
    pushStateToCloud();
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
// SYNCHRONIZATION ENGINE (Master Raspberry Pi Server + SSE + Fast Polling)
// ========================================================
let serverPollInterval = null;

async function initCloudSync() {
  const dot = document.querySelector('.cloud-dot');
  const label = document.getElementById('cloud-status-label');

  // Try connecting to Master Server (/api/state)
  try {
    const localRes = await fetch('/api/state', { cache: 'no-store' });
    if (localRes.ok) {
      const data = await localRes.json();
      const serverState = (data && data.state) ? data.state : data;

      if (serverState && serverState.queue && Array.isArray(serverState.queue)) {
        state = { ...DEFAULT_STATE, ...serverState };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        renderAll();

        if (dot) dot.className = 'cloud-dot local-connected';
        if (label) label.textContent = 'Сервер онлайн 🟢';

        connectLocalServerSSE();
        startServerPolling();
        return;
      }
    }
  } catch (e) {
    console.warn('Server fetch error:', e);
  }

  // Fallback to offline
  if (dot) dot.className = 'cloud-dot';
  if (label) label.textContent = 'Офлайн (локально)';
}

function startServerPolling() {
  if (serverPollInterval) clearInterval(serverPollInterval);

  // Poll server every 2 seconds to guarantee sync even if mobile browser pauses SSE
  serverPollInterval = setInterval(async () => {
    try {
      const res = await fetch('/api/state', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        const serverState = (data && data.state) ? data.state : data;
        if (serverState && serverState.queue) {
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

          const dot = document.querySelector('.cloud-dot');
          const label = document.getElementById('cloud-status-label');
          if (dot) dot.className = 'cloud-dot local-connected';
          if (label) label.textContent = 'Сервер онлайн 🟢';
        }
      }
    } catch (e) {
      const dot = document.querySelector('.cloud-dot');
      const label = document.getElementById('cloud-status-label');
      if (dot) dot.className = 'cloud-dot';
      if (label) label.textContent = 'Нет связи с сервером 🔴';
    }
  }, 2000);
}

function connectLocalServerSSE() {
  if (cloudEventSource) {
    cloudEventSource.close();
    cloudEventSource = null;
  }
  try {
    cloudEventSource = new EventSource('/api/events');
    cloudEventSource.addEventListener('state_update', (e) => {
      try {
        const raw = JSON.parse(e.data);
        const serverState = (raw && raw.state) ? raw.state : raw;
        if (serverState && serverState.queue) {
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
      } catch (err) {
        console.error('Error handling SSE state_update:', err);
      }
    });

    cloudEventSource.onopen = () => {
      const dot = document.querySelector('.cloud-dot');
      const label = document.getElementById('cloud-status-label');
      if (dot) dot.className = 'cloud-dot local-connected';
      if (label) label.textContent = 'Сервер онлайн 🟢';
    };

    cloudEventSource.onerror = () => {
      setTimeout(initCloudSync, 4000);
    };
  } catch (err) {
    console.warn('SSE not supported:', err);
  }
}

async function pushStateToCloud() {
  if (!isAdmin()) {
    console.warn('Blocked: Only admin phone can push changes to server.');
    return;
  }
  // Always push directly to Master Raspberry Pi server
  try {
    const adminPass = getSavedAdminPassword() || '525252';
    const payload = {
      ...state,
      _adminPassword: adminPass
    };
    const res = await fetch('/api/state', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Password': encodeURIComponent(adminPass)
      },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      const dot = document.querySelector('.cloud-dot');
      const label = document.getElementById('cloud-status-label');
      if (dot) dot.className = 'cloud-dot local-connected';
      if (label) label.textContent = 'Сервер онлайн 🟢';
    } else if (res.status === 403) {
      console.warn('Server rejected update: invalid admin password.');
      logoutAdmin();
      alert('Ошибка доступа: пароль администратора на сервере не совпал.');
    }
  } catch (e) {
    console.warn('Failed to push state to server:', e);
    const dot = document.querySelector('.cloud-dot');
    const label = document.getElementById('cloud-status-label');
    if (dot) dot.className = 'cloud-dot';
    if (label) label.textContent = 'Ошибка отправки 🔴';
  }
}

// Re-sync immediately on phone wake up / screen unlock
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    initCloudSync();
  }
});
window.addEventListener('pageshow', () => {
  initCloudSync();
});
window.addEventListener('focus', () => {
  initCloudSync();
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
    note: note.trim(),
    reactions: { love: 0, clap: 0, star: 0 }
  };
  state.history.unshift(historyItem);

  // Keep up to 200 history entries
  if (state.history.length > 200) state.history.pop();

  // 3. Move queue to next person
  state.currentQueueIndex = (state.currentQueueIndex + 1) % state.queue.length;
  state.dutyStartedAt = now;

  saveState();
  renderAll();

  // Celebratory FX & Audio
  soundFx.playVictory();
  celebration.burst(currentMember.color);

  // Show Toast
  showUndoToast(`${currentMember.name} помыл(а) посуду! Отлично! 🧼`);

  if ('vibrate' in navigator) navigator.vibrate([60, 40, 100]);
}

function handleUndo() {
  if (!undoAction) return;

  state.stats = { ...undoAction.prevStats };
  state.currentQueueIndex = undoAction.prevQueueIndex;
  state.dutyStartedAt = undoAction.prevDutyStartedAt;
  state.history = state.history.filter(h => h.id !== undoAction.historyItemId);

  undoAction = null;
  hideUndoToast();
  saveState();
  renderAll();
  soundFx.playClick();
}

function handleSkipTurn() {
  const current = getCurrentDutyMember();
  state.currentQueueIndex = (state.currentQueueIndex + 1) % state.queue.length;
  state.dutyStartedAt = Date.now();

  saveState();
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
    saveState();
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

  soundFx.playPop();
  saveState();
  renderHistory();
}

// ========================================================
// RENDERING
// ========================================================
function renderAll() {
  renderDutyTab();
  renderHistory();
  renderStats();
  renderAuthStatus();
}

function renderDutyTab() {
  const current = getCurrentDutyMember();
  
  // Hero components
  const heroCard = document.getElementById('duty-hero');
  const heroAvatar = document.getElementById('hero-avatar');
  const heroName = document.getElementById('hero-name');
  const heroTimer = document.getElementById('hero-timer');
  const heroStreak = document.getElementById('hero-streak');
  const heroAura = document.getElementById('hero-aura');

  heroAvatar.textContent = current.avatar;
  heroName.textContent = current.name;
  heroName.style.color = current.color;
  heroAura.style.borderColor = current.color;
  heroCard.style.borderColor = `${current.color}40`;

  heroTimer.textContent = formatDutyDuration(state.dutyStartedAt);
  const totalMemberWashes = state.stats[current.id] || 0;
  heroStreak.textContent = `Помыто: ${totalMemberWashes}`;

  // Queue track
  renderQueueTrack();

  // Activity glance on Tab 1
  renderActivityGlance();
}

function renderQueueTrack() {
  const track = document.getElementById('queue-track');
  track.innerHTML = '';

  state.queue.forEach((memberId, idx) => {
    const member = state.members[memberId];
    if (!member) return;

    const isActive = idx === state.currentQueueIndex;
    const isNext = idx === (state.currentQueueIndex + 1) % state.queue.length;

    let label = 'В очереди';
    if (isActive) label = 'Сейчас 🧼';
    else if (isNext) label = 'Следующий';

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
    });

    track.appendChild(card);
  });
}

function renderActivityGlance() {
  const glanceBox = document.getElementById('recent-glance-box');
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

// Render Tab 2: Detailed History
function renderHistory() {
  const timeline = document.getElementById('history-timeline');
  timeline.innerHTML = '';

  // Filter history
  let filtered = state.history;
  if (currentHistoryFilter !== 'all') {
    filtered = filtered.filter(h => h.memberId === currentHistoryFilter);
  }

  // Update filter chip counters
  document.querySelectorAll('.filter-chip').forEach(chip => {
    const filter = chip.getAttribute('data-filter');
    if (filter === 'all') {
      chip.textContent = `Все (${state.history.length})`;
    }
  });

  if (filtered.length === 0) {
    timeline.innerHTML = `<div style="text-align:center; padding:30px; color:var(--text-muted);">История пуста. Начните отмечать дежурства! 🍽️</div>`;
    return;
  }

  // Group by calendar day
  const groups = {};
  filtered.forEach(item => {
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

      // Attach reaction listeners
      card.querySelectorAll('.reaction-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = Number(btn.getAttribute('data-id'));
          const type = btn.getAttribute('data-type');
          handleReaction(id, type);
        });
      });

      groupEl.appendChild(card);
    });

    timeline.appendChild(groupEl);
  }
}

// Render Tab 3: Stats & Awards
function renderStats() {
  const container = document.getElementById('leaderboard-list');
  const totalBadge = document.getElementById('stat-total-badge');
  const awardsContainer = document.getElementById('awards-grid');

  container.innerHTML = '';
  awardsContainer.innerHTML = '';

  const memberList = Object.values(state.members).map(m => ({
    ...m,
    count: state.stats[m.id] || 0
  }));

  // Sort descending
  memberList.sort((a, b) => b.count - a.count);

  const totalWashes = memberList.reduce((sum, m) => sum + m.count, 0);
  totalBadge.textContent = `Всего: ${totalWashes} ${pluralize(totalWashes, 'мойка', 'мойки', 'моек')}`;

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
        <span class="leader-medal">${medals[idx]}</span>
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
    container.appendChild(row);
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
  const admin = isAdmin();

  // 1. Header button
  const authBadge = document.getElementById('btn-auth-badge');
  const authIcon = document.getElementById('auth-badge-icon');
  if (authBadge && authIcon) {
    if (admin) {
      authBadge.classList.add('is-admin');
      authIcon.textContent = '👑';
      authBadge.title = '👑 Вы в режиме управления (Серёжа). Нажмите, чтобы выйти';
    } else {
      authBadge.classList.remove('is-admin');
      authIcon.textContent = '🔒';
      authBadge.title = '🔒 Режим просмотра. Нажмите, чтобы войти с PIN-кодом';
    }
  }

  // 2. Readonly Banner in Tab 1
  const banner = document.getElementById('banner-readonly');
  if (banner) {
    if (admin) {
      banner.classList.add('hidden');
    } else {
      banner.classList.remove('hidden');
    }
  }

  // 3. Wash button appearance
  const washBtn = document.getElementById('btn-wash-done');
  if (washBtn) {
    if (admin) {
      washBtn.classList.remove('btn-locked');
      washBtn.innerHTML = `
        <div class="wash-btn-shine"></div>
        <span class="wash-icon">🧼</span>
        <div class="wash-label-box">
          <span class="wash-title">Я ПОМЫЛ ПОСУДУ!</span>
          <span class="wash-sub">Передать очередь дальше ✨</span>
        </div>
      `;
    } else {
      washBtn.classList.add('btn-locked');
      washBtn.innerHTML = `
        <span class="wash-icon">🔒</span>
        <div class="wash-label-box">
          <span class="wash-title">РЕЖИМ ПРОСМОТРА</span>
          <span class="wash-sub">Нажмите, чтобы ввести PIN 🔑</span>
        </div>
      `;
    }
  }

  // 4. Settings modal section
  const settingsBadge = document.getElementById('settings-auth-badge');
  const settingsDesc = document.getElementById('settings-auth-desc');
  const settingsActions = document.getElementById('settings-auth-actions');
  if (settingsBadge && settingsDesc && settingsActions) {
    if (admin) {
      settingsBadge.className = 'setup-badge';
      settingsBadge.textContent = '👑 Режим управления (Серёжа)';
      settingsDesc.textContent = 'Этот телефон авторизован. Серёжа может отмечать помывку и менять порядок очереди.';
      settingsActions.innerHTML = `
        <button type="button" class="secondary-action-btn" onclick="logoutAdmin(); closeAllModals();">
          Выйти из режима управления
        </button>
      `;
    } else {
      settingsBadge.className = 'setup-badge neutral';
      settingsBadge.textContent = '🔒 Только просмотр';
      settingsDesc.textContent = 'Изменять статус и очередь может только Серёжа с секретным PIN-кодом.';
      settingsActions.innerHTML = `
        <button type="button" class="primary-action-btn" onclick="closeAllModals(); openAuthModal();">
          Ввести PIN-код 🔑
        </button>
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
      saveState();
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
  if (settings.theme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
    document.getElementById('btn-theme').querySelector('.btn-icon').textContent = '☀️';
  }

  // Theme switch button
  document.getElementById('btn-theme').addEventListener('click', () => {
    soundFx.playClick();
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (isDark) {
      document.documentElement.removeAttribute('data-theme');
      settings.theme = 'light';
      document.getElementById('btn-theme').querySelector('.btn-icon').textContent = '🌙';
    } else {
      document.documentElement.setAttribute('data-theme', 'dark');
      settings.theme = 'dark';
      document.getElementById('btn-theme').querySelector('.btn-icon').textContent = '☀️';
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
  document.getElementById('btn-wake').addEventListener('click', toggleWakeLock);

  // Bottom Tab Navigation
  document.querySelectorAll('.tab-item').forEach(tabBtn => {
    tabBtn.addEventListener('click', () => {
      soundFx.playClick();
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

  // Auth button in header
  const btnAuthBadge = document.getElementById('btn-auth-badge');
  if (btnAuthBadge) {
    btnAuthBadge.addEventListener('click', () => {
      if (isAdmin()) {
        if (confirm('Вы авторизованы как администратор (Серёжа).\n\nВыйти из режима управления на этом телефоне?')) {
          logoutAdmin();
        }
      } else {
        openAuthModal();
      }
    });
  }

  // Banner login button
  const btnBannerLogin = document.getElementById('btn-banner-login');
  if (btnBannerLogin) {
    btnBannerLogin.addEventListener('click', () => {
      openAuthModal();
    });
  }

  // Auth form submission
  const formAuth = document.getElementById('form-admin-auth');
  if (formAuth) {
    formAuth.addEventListener('submit', (e) => {
      e.preventDefault();
      handleAuthSubmit();
    });
  }

  // Main Wash button
  document.getElementById('btn-wash-done').addEventListener('click', () => {
    requireAdmin(() => handleWashDone());
  });

  // Undo button
  document.getElementById('btn-undo').addEventListener('click', () => {
    requireAdmin(() => handleUndo());
  });

  // Turn Modifiers
  document.getElementById('btn-skip-duty').addEventListener('click', () => {
    requireAdmin(() => handleSkipTurn());
  });
  document.getElementById('btn-swap-duty').addEventListener('click', () => {
    requireAdmin(() => openSwapModal());
  });
  document.getElementById('btn-reorder-queue').addEventListener('click', () => {
    requireAdmin(() => openReorderModal());
  });

  // Note Modal
  document.getElementById('btn-add-note').addEventListener('click', () => {
    requireAdmin(() => {
      document.getElementById('modal-note-text').value = '';
      openModal('modal-note');
    });
  });

  document.querySelectorAll('.note-tag-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const textarea = document.getElementById('modal-note-text');
      const tag = btn.getAttribute('data-tag');
      textarea.value = textarea.value ? `${textarea.value} ${tag}` : tag;
      soundFx.playClick();
    });
  });

  document.getElementById('btn-submit-note-wash').addEventListener('click', () => {
    requireAdmin(() => {
      const note = document.getElementById('modal-note-text').value;
      closeAllModals();
      handleWashDone(note);
    });
  });

  // View all history button from Tab 1
  document.getElementById('btn-view-all-history').addEventListener('click', () => {
    document.querySelector('[data-tab="tab-history"]').click();
  });

  // History Filter Chips
  document.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      soundFx.playClick();
      document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      currentHistoryFilter = chip.getAttribute('data-filter');
      renderHistory();
    });
  });

  // Export History CSV
  document.getElementById('btn-export-history').addEventListener('click', exportHistoryToCSV);

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
          saveState();
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
