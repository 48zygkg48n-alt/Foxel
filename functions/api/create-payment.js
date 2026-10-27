// Cloudflare Pages Function: POST /api/create-payment
// Secrets come from env (set in Pages > Settings > Environment variables).
// Never put the key in this file or in index.html.

const PRICE = {
  eur1k: 5,
  tierFrom: 25000,
  tierEur1k: 4,
  min: 5000,
  max: 10000000,
  small: { robux: 1000, eur: 8 }
};

// Same pricing as the page. The server recalculates it, so a changed
// value in the browser can't lower what is charged.
function priceFor(r) {
  if (r === PRICE.small.robux) return PRICE.small.eur;
  const lo = 10000, hi = PRICE.tierFrom;
  const pLo = lo / 1000 * PRICE.eur1k;
  const pHi = hi / 1000 * PRICE.tierEur1k;
  if (r <= lo) return r / 1000 * PRICE.eur1k;
  if (r < hi) return pLo + (r - lo) / (hi - lo) * (pHi - pLo);
  return r / 1000 * PRICE.tierEur1k;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function notifyTelegram(env, text) {
  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) return;
  await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text })
  });
}

// TEMPORARY health check: open /api/create-payment in a browser.
// JSON with "deployed": true means the function is live. Remove once payments work.
export async function onRequestGet({ env }) {
  return json({
    deployed: true,
    paymento_api_key_set: Boolean(env.PAYMENTO_API_KEY),
    paymento_secret_set: Boolean(env.PAYMENTO_SECRET),
    telegram_alerts_set: Boolean(env.TG_BOT_TOKEN && env.TG_CHAT_ID)
  });
}

export async function onRequestPost({ request, env }) {
  if (!env.PAYMENTO_API_KEY) {
    return json({ error: 'Crypto payments are not configured' }, 500);
  }

  let body;
  try { body = await request.json(); } catch (e) {
    return json({ error: 'Bad request' }, 400);
  }

  const robux = Number(body.robux);
  const asset = body.asset;
  const gp = String(body.gp || '').trim().slice(0, 100);
  const ref = String(body.ref || '').trim().slice(0, 40);

  const validAmount = robux === PRICE.small.robux ||
    (Number.isInteger(robux) && robux >= PRICE.min && robux <= PRICE.max);
  if (!validAmount) return json({ error: 'Invalid amount' }, 400);
  if (!['SOL', 'LTC'].includes(asset)) return json({ error: 'Invalid payment method' }, 400);
  if (!gp) return json({ error: 'Missing gamepass ID or username' }, 400);

  const orderId = 'FX' + Date.now().toString(36).toUpperCase() +
    Math.random().toString(36).slice(2, 6).toUpperCase();
  const amount = priceFor(robux).toFixed(2);

  // Paymento: POST /v1/payment/request returns { success, message, body: <token> }.
  // A refused request still comes back as HTTP 200 with success:false.
  let upstream;
  try {
    upstream = await fetch('https://api.paymento.io/v1/payment/request', {
      method: 'POST',
      headers: {
        'Api-Key': env.PAYMENTO_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        fiatAmount: amount,
        fiatCurrency: 'EUR',
        orderId,
        returnUrl: 'https://foxel.net/?order=' + orderId,
        tokenExpiryDate: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        // Comes back in the callback so the alert can show what was ordered.
        additionalData: [
          { key: 'robux', value: String(robux) },
          { key: 'gamepass', value: gp },
          { key: 'creator_code', value: ref || 'none' },
          { key: 'preferred_coin', value: asset }
        ]
      })
    });
  } catch (e) {
    console.log('paymento request failed to connect:', String(e));
    return json({ error: 'Payment provider is unreachable' }, 502);
  }

  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok || !data.success || !data.body || typeof data.body !== 'string') {
    // Visible in Cloudflare Pages > Functions > real-time logs. Never logs the key.
    console.log('paymento refused:', upstream.status, data.code || '', data.message || '');
    return json({ error: 'Could not create the payment' }, 502);
  }
  const checkoutUrl = 'https://app.paymento.io/gateway?token=' + encodeURIComponent(data.body);

  try {
    await notifyTelegram(env,
      'New crypto order (awaiting payment)\n' +
      'Order: ' + orderId + '\n' +
      'Robux: ' + robux + '\n' +
      'Price: EUR ' + amount + '\n' +
      'Preferred coin: ' + asset + ' (customer picks the coin on the checkout page)\n' +
      'Gamepass: ' + gp + '\n' +
      'Creator code: ' + (ref || 'none'));
  } catch (e) { /* alerts are optional */ }

  return json({ checkout_url: checkoutUrl, order_id: orderId });
}
