/**
 * uTag V11 bridge + V12 shadow + V13 shadow
 * Existing webhook and GAS remain unchanged.
 */
async function hmacHex(keyText, data) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(keyText),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign(
    'HMAC', key, enc.encode(data)
  );
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function equalStrings(a, b) {
  if (typeof a !== 'string' ||
      typeof b !== 'string' ||
      a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const goodUrl =
      typeof env.GAS_WEBAPP_URL === 'string' &&
      /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/
        .test(env.GAS_WEBAPP_URL);

    const goodSecret =
      typeof env.UTAG_GATE_SECRET === 'string' &&
      /^[A-Za-z0-9_-]{40,256}$/
        .test(env.UTAG_GATE_SECRET);

    if (request.method === 'GET') {
      return new Response(JSON.stringify({
        name: 'uTag V11 bridge',
        ready: Boolean(goodUrl && goodSecret),
        worker_version: 11,
        checks: {
          gas_url: Boolean(goodUrl),
          secret: Boolean(goodSecret)
        }
      }), {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store'
        }
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', {status: 405});
    }

    if (!goodUrl || !goodSecret) {
      console.error('V11 BRIDGE: configuration missing');
      return new Response('Worker configuration missing', {
        status: 503
      });
    }

    const provided = request.headers.get(
      'X-Telegram-Bot-Api-Secret-Token'
    );

    if (!equalStrings(provided, env.UTAG_GATE_SECRET)) {
      console.warn('V11 BRIDGE: secret mismatch');
      return new Response('Forbidden', {status: 403});
    }

    const raw = await request.text();
    if (raw.length > 262144) {
      return new Response('Too large', {status: 413});
    }

    try {
      const update = JSON.parse(raw);
      if (!Number.isInteger(update.update_id)) {
        throw new Error('update_id');
      }
    } catch (_) {
      return new Response('Invalid update', {status: 400});
    }

    const t = String(Math.floor(Date.now() / 1000));
    const sig = await hmacHex(
      env.UTAG_GATE_SECRET, t + '.' + raw
    );
    const forwardBody = JSON.stringify({
      v: 11, t, payload: raw, sig
    });

    // V11: original GAS bridge
    ctx.waitUntil((async () => {
      try {
        const response = await fetch(env.GAS_WEBAPP_URL, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: forwardBody,
          redirect: 'manual'
        });

        console.log('V11 BRIDGE GAS HTTP:', response.status);
        if (![200, 302, 303].includes(response.status)) {
          console.error(
            'V11 BRIDGE unexpected response:', response.status
          );
        }
      } catch (e) {
        console.error(
          'V11 BRIDGE fetch failed:',
          String(e && e.message || e)
        );
      }
    })());

    // V12: existing shadow mirror
    if (typeof env.V12_SHADOW_KEY === 'string' &&
        env.V12_SHADOW_KEY.length >= 16) {
      ctx.waitUntil((async () => {
        try {
          if (!env.V12_STAGING ||
              typeof env.V12_STAGING.fetch !== 'function') {
            console.warn('V12 binding missing');
            return;
          }

          const response = await env.V12_STAGING.fetch(
            'https://utag-v12-staging.nurullohxusanov00.workers.dev/staging/ingest',
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Staging-Key': env.V12_SHADOW_KEY
              },
              body: raw,
              redirect: 'manual'
            }
          );

          if (response.status !== 202) {
            console.warn('V12 shadow HTTP:', response.status);
          }
        } catch (e) {
          console.warn(
            'V12 shadow unavailable:',
            String(e && e.message || e)
          );
        }
      })());
    }

    // V13: independent shadow mirror
    if (env.V13_STAGING &&
        typeof env.V13_STAGING.fetch === 'function' &&
        typeof env.V13_SHADOW_KEY === 'string' &&
        env.V13_SHADOW_KEY.length >= 40) {
      ctx.waitUntil((async () => {
        try {
          const response = await env.V13_STAGING.fetch(
            'https://utag-v13-staging.nurullohxusanov00.workers.dev/internal/ingest',
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Utag-Shadow-Key': env.V13_SHADOW_KEY
              },
              body: raw
            }
          );

          if (!response.ok) {
            console.warn('V13 shadow HTTP:', response.status);
          }
        } catch (e) {
          console.warn(
            'V13 shadow error:',
            String(e && e.message || e)
          );
        }
      })());
    }

    return new Response('OK', {status: 200});
  }
};
