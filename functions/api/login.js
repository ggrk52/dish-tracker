// ========================================================
// Cloudflare Pages Function: /api/login
// Авторизация семейных аккаунтов
// ========================================================

const AUTH_SECRET = 'family_dish_secret_2026';

const ACCOUNTS = {
  serezha: { username: 'serezha', password: '5252', name: 'Серёжа', role: 'admin', avatar: '👦' },
  mama: { username: 'mama', password: '1111', name: 'Мама', role: 'member', avatar: '👩' },
  papa: { username: 'papa', password: '2222', name: 'Папа', role: 'member', avatar: '👨' },
  vasya: { username: 'vasya', password: '3333', name: 'Вася', role: 'member', avatar: '🧒' }
};

const corsHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders });
}

export async function onRequestPost(context) {
  const { request } = context;
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
