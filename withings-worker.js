/**
 * SolFit Atlas — Withings-integrasjon (Cloudflare Worker)
 *
 * Oppsett (én gang):
 * 1. Registrer app på https://developer.withings.com → Callback URL:
 *    https://<worker-navn>.<konto>.workers.dev/callback
 * 2. Opprett KV namespace i Cloudflare: "SOLFIT_KV", og bind den til
 *    Workeren som `KV` (Settings → Variables → KV Namespace Bindings).
 * 3. Legg inn secrets på Workeren:
 *    wrangler secret put WITHINGS_CLIENT_ID
 *    wrangler secret put WITHINGS_CLIENT_SECRET
 * 4. Besøk https://<worker>/auth ÉN gang og logg inn med Withings-kontoen.
 * 5. Lim Worker-URL-en inn i SolFit Atlas → Innstillinger.
 *
 * Endepunkter:
 *   /auth     – starter OAuth-innlogging hos Withings (gjøres én gang)
 *   /callback – mottar OAuth-koden og lagrer tokens i KV
 *   /weight   – returnerer {weight, date} for siste veiing (brukes av appen)
 */

const WITHINGS_TOKEN_URL = 'https://wbsapi.withings.net/v2/oauth2';
const WITHINGS_MEASURE_URL = 'https://wbsapi.withings.net/measure';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json',
    };

    if (url.pathname === '/auth') {
      const redirect = `${url.origin}/callback`;
      const authUrl =
        'https://account.withings.com/oauth2_user/authorize2' +
        `?response_type=code&client_id=${env.WITHINGS_CLIENT_ID}` +
        `&redirect_uri=${encodeURIComponent(redirect)}` +
        '&scope=user.metrics&state=solfit';
      return Response.redirect(authUrl, 302);
    }

    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code');
      if (!code) return new Response('Mangler code', { status: 400 });
      const tokens = await tokenRequest(env, {
        action: 'requesttoken',
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${url.origin}/callback`,
      });
      if (!tokens) return new Response('Token-utveksling feilet', { status: 500 });
      await env.KV.put('withings_tokens', JSON.stringify(tokens));
      return new Response('✅ Withings koblet til! Du kan lukke denne fanen.', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    if (url.pathname === '/weight') {
      let tokens = JSON.parse((await env.KV.get('withings_tokens')) || 'null');
      if (!tokens) return new Response(JSON.stringify({ error: 'Ikke autentisert. Besøk /auth først.' }), { status: 401, headers: cors });

      // Refresh hvis utløpt (tokens varer 3 timer)
      if (Date.now() > (tokens.obtained_at || 0) + (tokens.expires_in - 120) * 1000) {
        const refreshed = await tokenRequest(env, {
          action: 'requesttoken',
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token,
        });
        if (refreshed) {
          tokens = refreshed;
          await env.KV.put('withings_tokens', JSON.stringify(tokens));
        }
      }

      // Hent siste vektmåling (measure type 1 = vekt)
      const body = new URLSearchParams({
        action: 'getmeas',
        meastype: '1',
        category: '1',
        lastupdate: String(Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 30),
      });
      const r = await fetch(WITHINGS_MEASURE_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const data = await r.json();
      const groups = data?.body?.measuregrps || [];
      if (!groups.length) return new Response(JSON.stringify({ error: 'Ingen målinger siste 30 dager' }), { headers: cors });

      groups.sort((a, b) => b.date - a.date);
      const g = groups[0];
      const m = g.measures.find((x) => x.type === 1);
      const weight = Math.round(m.value * Math.pow(10, m.unit) * 10) / 10;
      const d = new Date(g.date * 1000);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

      return new Response(JSON.stringify({ weight, date: dateStr }), { headers: cors });
    }

    return new Response(JSON.stringify({ ok: true, endpoints: ['/auth', '/callback', '/weight'] }), { headers: cors });
  },
};

async function tokenRequest(env, params) {
  const body = new URLSearchParams({
    client_id: env.WITHINGS_CLIENT_ID,
    client_secret: env.WITHINGS_CLIENT_SECRET,
    ...params,
  });
  const r = await fetch(WITHINGS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await r.json();
  if (data.status !== 0 || !data.body?.access_token) return null;
  return { ...data.body, obtained_at: Date.now() };
}
