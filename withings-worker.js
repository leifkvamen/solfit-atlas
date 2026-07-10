/**
 * SolFit Atlas — integrasjons-Worker (Cloudflare Worker)
 * Withings (vekt) + Strava (økter/turer)
 *
 * Oppsett Withings:
 * 1. App på https://developer.withings.com → Callback: https://<worker>/callback
 * 2. Secrets: WITHINGS_CLIENT_ID + WITHINGS_CLIENT_SECRET
 * 3. Besøk https://<worker>/auth én gang.
 *
 * Oppsett Strava:
 * 1. App på https://www.strava.com/settings/api → Authorization Callback Domain:
 *    <worker-domenet, f.eks. solfit-withings.leif-kvamen.workers.dev>
 * 2. Secrets: STRAVA_CLIENT_ID + STRAVA_CLIENT_SECRET
 * 3. Besøk https://<worker>/strava/auth én gang.
 *
 * KV-binding: `KV` (namespace SOLFIT_KV)
 *
 * Endepunkter:
 *   /auth, /callback, /weight          – Withings
 *   /strava/auth, /strava/callback     – Strava OAuth (én gang)
 *   /activities                        – siste 15 Strava-økter, forenklet JSON
 *   /data?k=<synk-kode>                – GET/PUT: skysync av appdata (KV)
 */

const WITHINGS_TOKEN_URL = 'https://wbsapi.withings.net/v2/oauth2';
const WITHINGS_MEASURE_URL = 'https://wbsapi.withings.net/measure';
const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';
const STRAVA_API = 'https://www.strava.com/api/v3';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json',
    };

    // ---------------- SKYSYNC (appdata) ----------------
    if (url.pathname === '/data') {
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          },
        });
      }
      const key = (url.searchParams.get('k') || '').trim();
      if (key.length < 6) {
        return new Response(JSON.stringify({ error: 'Synk-kode må være minst 6 tegn (?k=...)' }), { status: 400, headers: cors });
      }
      const kvKey = 'appdata:' + key;
      if (request.method === 'GET') {
        const data = await env.KV.get(kvKey);
        return new Response(data || 'null', { headers: cors });
      }
      if (request.method === 'PUT') {
        const body = await request.text();
        if (body.length > 400000) {
          return new Response(JSON.stringify({ error: 'For stor payload' }), { status: 413, headers: cors });
        }
        try { JSON.parse(body); } catch {
          return new Response(JSON.stringify({ error: 'Ugyldig JSON' }), { status: 400, headers: cors });
        }
        await env.KV.put(kvKey, body);
        return new Response(JSON.stringify({ ok: true }), { headers: cors });
      }
      return new Response(JSON.stringify({ error: 'Bruk GET eller PUT' }), { status: 405, headers: cors });
    }

    // ---------------- WITHINGS ----------------
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
      const tokens = await withingsToken(env, {
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

      if (Date.now() > (tokens.obtained_at || 0) + (tokens.expires_in - 120) * 1000) {
        const refreshed = await withingsToken(env, {
          action: 'requesttoken',
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token,
        });
        if (refreshed) {
          tokens = refreshed;
          await env.KV.put('withings_tokens', JSON.stringify(tokens));
        }
      }

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

    // ---------------- STRAVA ----------------
    if (url.pathname === '/strava/auth') {
      const redirect = `${url.origin}/strava/callback`;
      const authUrl =
        'https://www.strava.com/oauth/authorize' +
        `?client_id=${env.STRAVA_CLIENT_ID}` +
        '&response_type=code' +
        `&redirect_uri=${encodeURIComponent(redirect)}` +
        '&scope=activity:read_all&approval_prompt=auto';
      return Response.redirect(authUrl, 302);
    }

    if (url.pathname === '/strava/callback') {
      const code = url.searchParams.get('code');
      if (!code) return new Response('Mangler code', { status: 400 });
      const r = await fetch(STRAVA_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: env.STRAVA_CLIENT_ID,
          client_secret: env.STRAVA_CLIENT_SECRET,
          code,
          grant_type: 'authorization_code',
        }),
      });
      const data = await r.json();
      if (!data.access_token) return new Response('Token-utveksling feilet: ' + JSON.stringify(data), { status: 500 });
      await env.KV.put('strava_tokens', JSON.stringify(data));
      return new Response('✅ Strava koblet til! Du kan lukke denne fanen.', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    if (url.pathname === '/activities') {
      let tokens = JSON.parse((await env.KV.get('strava_tokens')) || 'null');
      if (!tokens) return new Response(JSON.stringify({ error: 'Strava ikke koblet. Besøk /strava/auth først.' }), { status: 401, headers: cors });

      // Strava expires_at er unix-sekunder
      if (Date.now() / 1000 > (tokens.expires_at || 0) - 120) {
        const r = await fetch(STRAVA_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: env.STRAVA_CLIENT_ID,
            client_secret: env.STRAVA_CLIENT_SECRET,
            grant_type: 'refresh_token',
            refresh_token: tokens.refresh_token,
          }),
        });
        const refreshed = await r.json();
        if (refreshed.access_token) {
          tokens = { ...tokens, ...refreshed };
          await env.KV.put('strava_tokens', JSON.stringify(tokens));
        }
      }

      const r = await fetch(`${STRAVA_API}/athlete/activities?per_page=15`, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (!r.ok) return new Response(JSON.stringify({ error: 'Strava API-feil ' + r.status }), { status: 502, headers: cors });
      const acts = await r.json();
      const out = (Array.isArray(acts) ? acts : []).map((a) => ({
        id: a.id,
        name: a.name,
        type: a.sport_type || a.type,
        date: (a.start_date_local || '').slice(0, 10),
        min: Math.round((a.moving_time || 0) / 60),
        km: Math.round(((a.distance || 0) / 1000) * 10) / 10,
        hm: Math.round(a.total_elevation_gain || 0),
        hr: a.average_heartrate ? Math.round(a.average_heartrate) : null,
      }));
      return new Response(JSON.stringify(out), { headers: cors });
    }

    return new Response(
      JSON.stringify({ ok: true, endpoints: ['/auth', '/callback', '/weight', '/strava/auth', '/strava/callback', '/activities', '/data'] }),
      { headers: cors }
    );
  },
};

async function withingsToken(env, params) {
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
