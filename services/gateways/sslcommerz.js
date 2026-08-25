/**
 * SSLCommerz v4 adapter.
 *
 * Two calls carry the whole flow:
 *   1. createSession() — POST the order, receive a GatewayPageURL to redirect to
 *   2. verify()        — server-to-server check that the payment really happened
 *
 * Step 2 is the one that matters. SSLCommerz redirects the browser back to our
 * success_url with a POST body, and that body could be forged by anyone who
 * knows the URL. Nothing is ever marked Paid on the redirect alone: we re-ask
 * SSLCommerz using val_id and compare status, tran_id, amount and currency.
 *
 * Uses global fetch (Node 18+), so no HTTP dependency is needed.
 */
const config = require('../../config');

const cfg = config.sslcommerz;

const id = 'sslcommerz';
const label = 'SSLCommerz';
const description = 'Cards, mobile banking and net banking through the SSLCommerz gateway.';

function isConfigured() {
  return Boolean(cfg.storeId && cfg.storePassword);
}

function configHint() {
  if (isConfigured()) return null;
  return 'Set SSLCZ_STORE_ID and SSLCZ_STORE_PASSWORD in .env. Free sandbox credentials: https://developer.sslcommerz.com/';
}

async function postForm(url, fields) {
  const body = new URLSearchParams();
  Object.entries(fields).forEach(([key, value]) => {
    if (value !== undefined && value !== null) body.append(key, String(value));
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });

  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`SSLCommerz returned a non-JSON response (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }
}

async function createSession(order) {
  if (!isConfigured()) throw new Error(configHint());

  const data = await postForm(cfg.initUrl, {
    store_id: cfg.storeId,
    store_passwd: cfg.storePassword,

    total_amount: Number(order.amount).toFixed(2),
    currency: order.currency,
    tran_id: order.tranId,

    success_url: order.successUrl,
    fail_url: order.failUrl,
    cancel_url: order.cancelUrl,
    ipn_url: order.ipnUrl,

    // A workshop seat is a non-physical product, so no shipping block is sent.
    product_name: order.productName,
    product_category: 'Training',
    product_profile: 'non-physical-goods',
    num_of_item: 1,
    shipping_method: 'NO',

    cus_name: order.customer.name,
    cus_email: order.customer.email,
    cus_phone: order.customer.phone || '01700000000',
    cus_add1: order.customer.address || 'N/A',
    cus_city: order.customer.city || 'Dhaka',
    cus_state: order.customer.city || 'Dhaka',
    cus_postcode: '1000',
    cus_country: 'Bangladesh',

    // Echoed back on the callbacks — a useful secondary reference.
    value_a: order.bookingId,
  });

  if (data.status !== 'SUCCESS' || !data.GatewayPageURL) {
    throw new Error(`SSLCommerz refused the session: ${data.failedreason || data.status || 'Unknown error'}`);
  }

  return {
    redirectUrl: data.GatewayPageURL,
    sessionKey: data.sessionkey || null,
    paymentId: null,
    raw: data,
  };
}

async function validateTransaction(valId) {
  const url = new URL(cfg.validationUrl);
  url.searchParams.set('val_id', valId);
  url.searchParams.set('store_id', cfg.storeId);
  url.searchParams.set('store_passwd', cfg.storePassword);
  url.searchParams.set('v', '1');
  url.searchParams.set('format', 'json');

  const response = await fetch(url, { signal: AbortSignal.timeout(cfg.timeoutMs) });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`SSLCommerz validation returned a non-JSON response (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }
}

async function verify({ booking, payload }) {
  if (!payload.val_id) return { ok: false, reason: 'No val_id was returned by the gateway.', raw: null };

  const validation = await validateTransaction(payload.val_id);

  const status = String(validation.status || '').toUpperCase();
  if (status !== 'VALID' && status !== 'VALIDATED') {
    return { ok: false, reason: `Gateway validation status was ${status || 'empty'}.`, raw: validation };
  }
  if (validation.tran_id !== booking.tran_id) {
    return { ok: false, reason: 'Transaction ID did not match this booking.', raw: validation };
  }
  const paid = Number(validation.amount);
  if (!Number.isFinite(paid) || Math.abs(paid - Number(booking.amount)) > 0.01) {
    return {
      ok: false,
      reason: `Amount mismatch: expected ${booking.amount}, gateway reported ${validation.amount}.`,
      raw: validation,
    };
  }
  if (validation.currency && booking.currency && validation.currency !== booking.currency) {
    return {
      ok: false,
      reason: `Currency mismatch: expected ${booking.currency}, got ${validation.currency}.`,
      raw: validation,
    };
  }

  return {
    ok: true,
    details: {
      val_id: validation.val_id || payload.val_id,
      bank_tran_id: validation.bank_tran_id || payload.bank_tran_id || null,
      card_type: validation.card_type || payload.card_type || null,
      amount: validation.amount,
      currency: validation.currency,
    },
    raw: validation,
  };
}

module.exports = { id, label, description, isConfigured, configHint, createSession, verify };
