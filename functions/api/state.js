// ========================================================
// Cloudflare Pages Function: /api/state
// Автоматический серверный эндпоинт для синхронизации
// ========================================================

const corsHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders });
}

export async function onRequestGet(context) {
  const { env } = context;
  try {
    let state = null;
    if (env.DISH_KV) {
      state = await env.DISH_KV.get('dish_state');
    }
    return new Response(state || JSON.stringify({ exists: false }), {
      headers: corsHeaders
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: corsHeaders
    });
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const body = await request.text();
    if (env.DISH_KV) {
      await env.DISH_KV.put('dish_state', body);
    }
    return new Response(JSON.stringify({ success: true }), {
      headers: corsHeaders
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: corsHeaders
    });
  }
}
