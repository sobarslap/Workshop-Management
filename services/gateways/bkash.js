/**
 * bKash Tokenized Checkout adapter (v1.2.0-beta).
 *
 * The bKash flow has one more step than SSLCommerz because the merchant must
 * authenticate first and must explicitly *execute* the payment after the
 * customer authorises it:
 *
 *   1. grantToken()   POST /checkout/token/grant      → id_token (valid ~1 hour)
 *   2. createSession()POST /checkout/create           → bkashURL + paymentID
 *   3. customer authorises on bkashURL, bKash redirects back to callbackURL
 *      with ?paymentID=...&status=success|failure|cancel
 *   4. verify()       POST /checkout/execute          → trxID + transactionStatus
 *
 * Step 4 is mandatory, not optional: until execute succeeds, bKash has only
 * *authorised* the payment and no money has moved. That is also what makes the
 * flow safe — the redirect in step 3 carries no amount we could be tricked by,
 * and execute returns the authoritative amount which we compare against the
 * booking before marking it Paid.
 *
 * If execute is called twice (customer refreshes), bKash replies with error code
 * 2062 "already completed" — that case is treated as success and reconciled
 * through the query endpoint instead of being reported as a failure.
 */
const config = require('../../config');

const cfg = config.bkash;

const id = 'bkash';
const label = 'bKash';
const description = 'Pay from a bKash wallet through bKash Tokenized Checkout.';

function isConfigured() {
  return Boolean(cfg.appKey && cfg.appSecret && cfg.username && cfg.password);
}

function configHint() {
  if (isConfigured()) return null;
  return 'Set BKASH_APP_KEY, BKASH_APP_SECRET, BKASH_USERNAME and BKASH_PASSWORD in .env. Sandbox credentials: https://developer.bka.sh/';
}

// ---------- token cache ----------
let tokenCache = { idToken: null, refreshToken: null, expiresAt: 0 };

async function request(pathname, { method = 'POST', body, headers = {} } = {}) {
  const response = await fetch(`${cfg.baseUrl}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', accept: 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`bKash returned a non-JSON response (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }
  return data;
}

async function grantToken(force = false) {
  if (!force && tokenCache.idToken && Date.now() < tokenCache.expiresAt) {
    return tokenCache.idToken;
  }

  const data = await request('/checkout/token/grant', {
    body: { app_key: cfg.appKey, app_secret: cfg.appSecret },
    headers: { username: cfg.username, password: cfg.password },
  });

  if (!data.id_token) {
    throw new Error(`bKash token grant failed: ${data.statusMessage || data.message || JSON.stringify(data).slice(0, 160)}`);
  }

  // expires_in is seconds; refresh a minute early to avoid an edge-of-expiry call.
  const ttl = Number(data.expires_in || 3600);
  tokenCache = {
    idToken: data.id_token,
    refreshToken: data.refresh_token || null,
    expiresAt: Date.now() + (ttl - 60) * 1000,
  };
  return tokenCache.idToken;
}

function authHeaders(idToken) {
  return { Authorization: idToken, 'X-APP-Key': cfg.appKey };
}

async function createSession(order) {
  if (!isConfigured()) throw new Error(configHint());

  const idToken = await grantToken();

  const data = await request('/checkout/create', {
    headers: authHeaders(idToken),
    body: {
      mode: '0011', // 0011 = checkout with callback (tokenized)
      payerReference: order.customer.phone || order.customer.email || 'N/A',
      callbackURL: order.callbackUrl,
      amount: Number(order.amount).toFixed(2),
      currency: order.currency === 'BDT' ? 'BDT' : 'BDT', // bKash settles in BDT only
      intent: 'sale',
      merchantInvoiceNumber: order.tranId,
    },
  });

  if (!data.bkashURL || !data.paymentID) {
    throw new Error(`bKash refused the session: ${data.statusMessage || data.errorMessage || 'Unknown error'}`);
  }

  return {
    redirectUrl: data.bkashURL,
    sessionKey: null,
    paymentId: data.paymentID,
    raw: data,
  };
}

async function queryPayment(paymentID) {
  const idToken = await grantToken();
  return request('/checkout/payment/status', {
    headers: authHeaders(idToken),
    body: { paymentID },
  });
}

async function verify({ booking, payload }) {
  const paymentID = payload.paymentID || booking.payment_id;
  if (!paymentID) return { ok: false, reason: 'No paymentID was returned by bKash.', raw: null };

  // bKash tells us in the redirect whether the customer even authorised it.
  const status = String(payload.status || 'success').toLowerCase();
  if (status === 'cancel') return { ok: false, reason: 'Payment was cancelled in the bKash app.', raw: payload };
  if (status === 'failure') return { ok: false, reason: 'bKash reported the payment as failed.', raw: payload };

  const idToken = await grantToken();
  let data = await request('/checkout/execute', {
    headers: authHeaders(idToken),
    body: { paymentID },
  });

  // 2062 = payment already executed (a refresh or a duplicate IPN). Not an
  // error — fall back to the authoritative query endpoint.
  const alreadyDone = String(data.errorCode || '') === '2062';
  if (alreadyDone || (!data.transactionStatus && !data.trxID)) {
    data = await queryPayment(paymentID);
  }

  const txStatus = String(data.transactionStatus || '').toLowerCase();
  if (txStatus !== 'completed') {
    return {
      ok: false,
      reason: `bKash transaction status was "${data.transactionStatus || data.statusMessage || 'unknown'}".`,
      raw: data,
    };
  }

  // The invoice number is our tran_id — confirms the payment belongs here.
  if (data.merchantInvoiceNumber && data.merchantInvoiceNumber !== booking.tran_id) {
    return { ok: false, reason: 'Merchant invoice number did not match this booking.', raw: data };
  }

  const paid = Number(data.amount);
  if (!Number.isFinite(paid) || Math.abs(paid - Number(booking.amount)) > 0.01) {
    return {
      ok: false,
      reason: `Amount mismatch: expected ${booking.amount}, bKash reported ${data.amount}.`,
      raw: data,
    };
  }

  return {
    ok: true,
    details: {
      val_id: data.paymentID,
      bank_tran_id: data.trxID || null,
      card_type: 'bKash',
      amount: data.amount,
      currency: data.currency || 'BDT',
    },
    raw: data,
  };
}

async function refund({ booking }) {
  const idToken = await grantToken();
  const data = await request('/checkout/payment/refund', {
    headers: authHeaders(idToken),
    body: {
      paymentID: booking.payment_id,
      amount: Number(booking.amount).toFixed(2),
      trxID: booking.bank_tran_id,
      sku: 'workshop-seat',
      reason: 'Booking cancelled',
    },
  });
  const ok = String(data.transactionStatus || '').toLowerCase() === 'completed';
  return { ok, refundId: data.refundTrxID || null, raw: data };
}

module.exports = {
  id,
  label,
  description,
  isConfigured,
  configHint,
  createSession,
  verify,
  refund,
  queryPayment,
  grantToken,
};
