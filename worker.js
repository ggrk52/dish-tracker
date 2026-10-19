export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // API endpoint for family state synchronization
    if (url.pathname === '/api/state') {
      const corsHeaders = {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      };

      if (request.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
      }

      if (request.method === 'POST') {
        try {
          const body = await request.text();
          if (env.DISH_KV) {
            await env.DISH_KV.put('dish_state', body);
          }
          return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
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
