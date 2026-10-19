// ========================================================
// Cloudflare Worker для «Чистой Тарелки»
// Бесплатный бэкенд, работающий стабильно в РФ без VPN
// 100 000 бесплатных запросов в день!
// ========================================================

export default {
  async fetch(request, env) {
    // CORS headers for all family devices
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json; charset=utf-8'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // Save state
    if (request.method === 'POST' || request.method === 'PUT') {
      try {
        const body = await request.text();
        // If KV is bound to DISH_KV:
        if (env.DISH_KV) {
          await env.DISH_KV.put('state', body);
        }
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // Get state
    if (request.method === 'GET') {
      let state = null;
      if (env.DISH_KV) {
        state = await env.DISH_KV.get('state');
      }
      return new Response(state || JSON.stringify({ exists: false }), { headers: corsHeaders });
    }

    return new Response('Method Not Allowed', { status: 405 });
  }
};
