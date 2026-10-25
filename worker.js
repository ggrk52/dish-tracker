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

          if (env.DISH_KV) {
            await env.DISH_KV.put('dish_state', rawText);
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
        return new Response(state || JSON.stringify({ exists: false }), { headers: corsHeaders });
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
