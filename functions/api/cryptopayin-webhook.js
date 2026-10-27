// Cloudflare Pages Function: POST /api/cryptopayin-webhook
// Only accepts requests whose signature matches CRYPTOPAYIN_WEBHOOK_SECRET
// (the whsec_... value shown once when you register the endpoint).

function toHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time string compare, so the check doesn't leak timing hints.
function same(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function notifyTelegram(env, text) {
  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) return;
  await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text })
  });
}

export async function onRequestPost({ request, env }) {
  if (!env.CRYPTOPAYIN_WEBHOOK_SECRET) return new Response('', { status: 500 });

  const raw = await request.text();
  const ts = request.headers.get('x-cpi-timestamp') || '';
  const sig = (request.headers.get('x-cpi-signature') || '').replace(/^sha256=/, '');

  // Replay protection. Assumes the timestamp is in seconds.
  if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) {
    return new Response('', { status: 400 });
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.CRYPTOPAYIN_WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ts + '.' + raw));
  if (!same(toHex(mac), sig)) return new Response('', { status: 401 });

  let evt;
  try { evt = JSON.parse(raw); } catch (e) { return new Response('', { status: 400 }); }

  const type = evt.type || evt.event || 'unknown';
  const detail = JSON.stringify(evt.data || evt).slice(0, 1500);
  try {
    if (type === 'payment.completed' || type === 'payment.overpaid') {
      await notifyTelegram(env, 'Crypto payment received: ' + type + '\n' + detail);
    } else if (type === 'payment.underpaid' || type === 'payment.failed') {
      await notifyTelegram(env, 'Crypto payment problem: ' + type + '\n' + detail);
    }
  } catch (e) { /* alerts are optional */ }

  return new Response('', { status: 200 });
}
