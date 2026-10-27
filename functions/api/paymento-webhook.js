// Cloudflare Pages Function: POST /api/paymento-webhook  (Paymento IPN callback)
//
// Paymento signs every callback with HMAC-SHA256 over the raw request body,
// keyed with your store's secret key, and sends the uppercase hex digest in the
// X-HMAC-SHA256-Signature header. Env vars (Pages > Settings > Environment variables):
//   PAYMENTO_SECRET   the store's secret key (callback signing)
//   PAYMENTO_API_KEY  the store's API key (used to call /v1/payment/verify)
//   TG_BOT_TOKEN, TG_CHAT_ID  optional, for order alerts

const ORDER = { PARTIAL: 2, TIMEOUT: 4, PAID: 7, APPROVE: 8, REJECT: 9, REFUNDED: 10 };

function toHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
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

// AdditionalData arrives as [{ Key, Value }] in callbacks and [{ key, value }] from verify.
function extra(list) {
  const out = {};
  for (const item of Array.isArray(list) ? list : []) {
    const k = item && (item.Key ?? item.key);
    if (k) out[k] = item.Value ?? item.value;
  }
  return out;
}

async function handle({ request, env }) {
  if (!env.PAYMENTO_SECRET || !env.PAYMENTO_API_KEY) return new Response('', { status: 500 });

  const raw = await request.text();
  const sig = (request.headers.get('x-hmac-sha256-signature') || '').trim().toUpperCase();
  if (!sig) return new Response('', { status: 401 });

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.PAYMENTO_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  if (!same(toHex(mac), sig)) return new Response('', { status: 401 });

  let evt;
  try { evt = JSON.parse(raw); } catch (e) { return new Response('', { status: 400 }); }

  const token = evt.Token;
  const orderId = evt.OrderId || 'unknown';
  const status = Number(evt.OrderStatus);
  const info = extra(evt.AdditionalData);
  const order =
    'Order: ' + orderId + '\n' +
    'Robux: ' + (info.robux || '?') + '\n' +
    'Gamepass: ' + (info.gamepass || '?') + '\n' +
    'Creator code: ' + (info.creator_code || 'none');

  if (status === ORDER.PAID) {
    if (!token) return new Response('', { status: 400 });

    // Never trust the callback alone: confirm with Paymento. A successful verify also
    // moves the order from Paid to Approve, which stops Paymento's callback retries.
    let res;
    try {
      res = await fetch('https://api.paymento.io/v1/payment/verify', {
        method: 'POST',
        headers: {
          'Api-Key': env.PAYMENTO_API_KEY,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ token })
      });
    } catch (e) {
      console.log('paymento verify unreachable:', String(e));
      return new Response('', { status: 500 }); // Paymento retries while the order is Paid
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.log('paymento verify http error:', res.status, data.code || '', data.message || '');
      return new Response('', { status: 500 });
    }

    const s = (data.body && data.body.settlement) || {};
    const paid = s.receivedCryptoAmount ? s.receivedCryptoAmount + ' ' + (s.asset || '') : 'n/a';
    try {
      if (data.success) {
        await notifyTelegram(env,
          'PAID and verified. Deliver this order.\n' + order + '\n' +
          'Received: ' + paid + '\n' +
          'Requested: EUR ' + (s.requestedFiatAmount || '?'));
      } else {
        // Valid token but not Approve after verify: needs a human look.
        await notifyTelegram(env,
          'Paymento says Paid, but verify did not approve it. Check the dashboard before delivering.\n' +
          order + '\n' +
          'Verify status: ' + (data.body ? data.body.orderStatus : '?') + ' ' + (data.message || ''));
      }
    } catch (e) { /* alerts are optional */ }
    return new Response('', { status: 200 });
  }

  try {
    if (status === ORDER.PARTIAL) {
      await notifyTelegram(env, 'Partial payment received. Not complete yet.\n' + order);
    } else if (status === ORDER.REJECT) {
      await notifyTelegram(env, 'Payment rejected by Paymento.\n' + order);
    } else if (status === ORDER.REFUNDED) {
      await notifyTelegram(env, 'Payment refunded.\n' + order);
    }
  } catch (e) { /* alerts are optional */ }

  return new Response('', { status: 200 });
}

// Paymento sends POST or PUT depending on the ipN_Method you set; accept both.
export const onRequestPost = handle;
export const onRequestPut = handle;
