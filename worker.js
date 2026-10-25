// ========================================================
// Cloudflare Worker с поддержкой Assets и KV для «Чистой Тарелки»
// ========================================================

const AUTH_SECRET = 'family_dish_secret_2026';

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

const DEFAULT_STATE = {
  members: {
    mama: { id: 'mama', name: 'Мама', role: 'Мама', avatar: '👩', color: '#ec4899', title: 'Хранительница очага' },
    papa: { id: 'papa', name: 'Папа', role: 'Папа', avatar: '👨', color: '#0284c7', title: 'Гроза сковородок' },
    serezha: { id: 'serezha', name: 'Серёжа', role: 'Сын', avatar: '👦', color: '#10b981', title: 'Мастер мыльной пены' },
    vasya: { id: 'vasya', name: 'Вася', role: 'Сын', avatar: '🧒', color: '#f59e0b', title: 'Повелитель тарелок' }
  },
  queue: ['mama', 'papa', 'serezha', 'vasya'],
  currentQueueIndex: 0,
  dutyStartedAt: 0,
  stats: { mama: 0, papa: 0, serezha: 0, vasya: 0 },
  history: []
};

const corsHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Auth-User, X-Auth-Token, X-Auth-Password, If-None-Match',
  'Access-Control-Max-Age': '86400'
};

async function generateToken(username) {
  const acc = ACCOUNTS[username];
  if (!acc) return '';
  const msgUint8 = new TextEncoder().encode(`${username}:${acc.password}:${AUTH_SECRET}`);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyAuth(request, bodyObj) {
  let user = request.headers.get('x-auth-user') || '';
  let token = request.headers.get('x-auth-token') || '';
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

  const expectedToken = await generateToken(user);
  if (token && token === expectedToken) return acc;

  const directPass = request.headers.get('x-auth-password') || (bodyObj && bodyObj._authPass ? bodyObj._authPass : '');
  if (directPass && String(directPass).trim() === acc.password) return acc;

  return null;
}

function mutateState(parsed, auth, existingState) {
  let currState = existingState ? JSON.parse(JSON.stringify(existingState)) : JSON.parse(JSON.stringify(DEFAULT_STATE));
  if (!currState.members || !Array.isArray(currState.queue)) {
    currState = JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
  const isAdmin = (auth.role === 'admin');
  const authUser = auth.username;
  const action = (parsed && parsed._action) || '';

  const currQ = Array.isArray(currState.queue) ? currState.queue : [];
  const currIdx = currState.currentQueueIndex || 0;
  const currDutyId = currQ[currIdx] || null;

  if (action === 'reaction') {
    const clientHist = (parsed && Array.isArray(parsed.history)) ? parsed.history : [];
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
    return { ok: true, state: currState };
  }

  if (action === 'wash' || action === 'wash_done') {
    const isDuty = (currDutyId && authUser === currDutyId);
    if (!isAdmin && !isDuty) {
      const currDutyName = (currState.members && currState.members[currDutyId]) ? currState.members[currDutyId].name : 'дежурного';
      return { ok: false, status: 403, error: `Сейчас очередь дежурить: ${currDutyName}. Отметить помывку может только он(а)` };
    }

    const clientHist = (parsed && Array.isArray(parsed.history)) ? parsed.history : [];
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
    return { ok: true, state: currState };
  }

  if (action === 'undo') {
    if (!Array.isArray(currState.history) || currState.history.length === 0) {
      return { ok: false, status: 400, error: 'Нет записей о помывке для отмены' };
    }
    const lastWash = currState.history[0];
    const lastWasher = lastWash.memberId;
    if (!isAdmin && authUser !== lastWasher) {
      return { ok: false, status: 403, error: 'Отменить помывку может только тот, кто помыл, или Серёжа (Администратор)' };
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
    return { ok: true, state: currState };
  }

  if (action === 'skip' || action === 'swap') {
    const isDuty = (currDutyId && authUser === currDutyId);
    if (!isAdmin && !isDuty) {
      return { ok: false, status: 403, error: 'Пропустить или передать очередь может только текущий дежурный или Серёжа (Администратор)' };
    }
    if (action === 'skip') {
      if (currQ.length > 0) {
        currState.currentQueueIndex = (currIdx + 1) % currQ.length;
      }
      currState.dutyStartedAt = Date.now();
      return { ok: true, state: currState };
    }
    if (action === 'swap') {
      const clientQ = parsed && parsed.queue;
      if (Array.isArray(clientQ) && [...clientQ].sort().join(',') === [...currQ].sort().join(',')) {
        currState.queue = [...clientQ];
        currState.dutyStartedAt = Date.now();
        return { ok: true, state: currState };
      }
      return { ok: false, status: 400, error: 'Некорректный состав очереди' };
    }
  }

  if (isAdmin) {
    if (action === 'reset') {
      return { ok: true, state: JSON.parse(JSON.stringify(DEFAULT_STATE)) };
    }
    if (action === 'reorder') {
      const clientQ = parsed && parsed.queue;
      if (Array.isArray(clientQ) && [...clientQ].sort().join(',') === [...currQ].sort().join(',')) {
        currState.queue = [...clientQ];
        return { ok: true, state: currState };
      }
      return { ok: false, status: 400, error: 'Некорректная очередь' };
    }
    // Full state update by admin
    const cleanCopy = { ...parsed };
    delete cleanCopy._authUser;
    delete cleanCopy._authToken;
    delete cleanCopy._authPass;
    delete cleanCopy._adminPassword;
    delete cleanCopy._memberId;
    delete cleanCopy._action;
    currState = { ...JSON.parse(JSON.stringify(DEFAULT_STATE)), ...cleanCopy };
    if (!cleanCopy.members) currState.members = DEFAULT_STATE.members;
    return { ok: true, state: currState };
  }

  return { ok: false, status: 403, error: 'Управлять очередью и настройками может только Серёжа (Администратор)' };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // 1. Login endpoint
    if (url.pathname === '/api/login' && request.method === 'POST') {
      try {
        const creds = await request.json();
        const user = (creds.username || '').trim().toLowerCase();
        const pass = String(creds.password || '').trim();

        const acc = ACCOUNTS[user];
        if (acc && acc.password === pass) {
          const token = await generateToken(user);
          return new Response(JSON.stringify({
            success: true,
            user: {
              username: acc.username,
              name: acc.name,
              role: acc.role,
              avatar: acc.avatar
            },
            token: token
          }), { headers: corsHeaders });
        } else {
          return new Response(JSON.stringify({ error: 'Неверный пароль. Попробуйте ещё раз' }), {
            status: 401,
            headers: corsHeaders
          });
        }
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 400, headers: corsHeaders });
      }
    }

    // 2. Version endpoint
    if (url.pathname === '/api/version') {
      return new Response(JSON.stringify({ version: Date.now() }), { headers: corsHeaders });
    }

    // 3. API endpoint for family state synchronization
    if (url.pathname === '/api/state') {
      if (request.method === 'POST' || request.method === 'PUT') {
        try {
          const rawText = await request.text();
          let parsed = null;
          try { parsed = JSON.parse(rawText); } catch (e) {}

          const auth = await verifyAuth(request, parsed);
          if (!auth) {
            return new Response(JSON.stringify({ error: 'Требуется авторизация. Пожалуйста, войдите в аккаунт' }), {
              status: 401,
              headers: corsHeaders
            });
          }

          let existingState = null;
          if (env.DISH_KV) {
            const raw = await env.DISH_KV.get('dish_state');
            if (raw) {
              try { existingState = JSON.parse(raw); } catch (e) {}
            }
          }

          const result = mutateState(parsed, auth, existingState);
          if (!result.ok) {
            return new Response(JSON.stringify({ error: result.error }), {
              status: result.status,
              headers: corsHeaders
            });
          }

          const cleanJson = JSON.stringify(result.state);
          if (env.DISH_KV) {
            await env.DISH_KV.put('dish_state', cleanJson);
          }
          return new Response(JSON.stringify({ success: true, etag: `"${Date.now()}"` }), { headers: corsHeaders });
        } catch (err) {
          return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
        }
      }

      // GET
      try {
        let state = null;
        if (env.DISH_KV) {
          state = await env.DISH_KV.get('dish_state');
        }
        return new Response(state || JSON.stringify(DEFAULT_STATE), { headers: corsHeaders });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // Serve static files from the public folder
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Assets not configured', { status: 404 });
  }
};
