/* creel — DeepSeek CORS shim (Cloudflare Worker).
 *
 * DeepSeek's API does not send CORS headers, so a browser page cannot call
 * https://api.deepseek.com directly. This worker forwards requests verbatim
 * and adds CORS. Two deployment modes:
 *
 *   1. BYOK passthrough (default): the browser sends its own
 *      `Authorization: Bearer sk-...` header; the worker holds no secrets.
 *      Set the worker URL as the API Endpoint in creel's settings and keep
 *      your DeepSeek key in the harness (localStorage) as usual.
 *   2. Key-holding: set a DEEPSEEK_API_KEY worker secret and leave the key
 *      blank in the browser. Only do this on a worker you protect (e.g.
 *      Cloudflare Access), otherwise anyone with the URL spends your quota.
 *
 * Deploy: `wrangler deploy proxy/deepseek-cors-worker.js`, or paste into the
 * Cloudflare dashboard. Optionally set ALLOWED_ORIGIN to your creel origin
 * (defaults to `*`, fine for BYOK passthrough).
 */

const UPSTREAM = 'https://api.deepseek.com';

export default {
  async fetch(request, env) {
    const allowOrigin = env.ALLOWED_ORIGIN || '*';
    const corsHeaders = {
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const upstream = new Request(UPSTREAM + url.pathname + url.search, request);
    if (!upstream.headers.get('Authorization') && env.DEEPSEEK_API_KEY) {
      upstream.headers.set('Authorization', `Bearer ${env.DEEPSEEK_API_KEY}`);
    }

    const resp = await fetch(upstream);
    const out = new Response(resp.body, resp);
    for (const [k, v] of Object.entries(corsHeaders)) out.headers.set(k, v);
    return out;
  },
};
