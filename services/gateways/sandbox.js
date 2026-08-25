/**
 * Built-in sandbox gateway.
 *
 * This is a *complete* payment provider that happens to run inside this app. It
 * exists so the whole payment journey works with zero credentials and zero
 * internet access — useful for marking, for offline demos, and as the default
 * out-of-the-box experience.
 *
 * It is deliberately NOT a shortcut that flips a boolean to "Paid". It follows
 * the same shape as SSLCommerz and bKash:
 *
 *   1. createSession()  — the order is registered, a session key is issued, and
 *                         the customer is redirected to a hosted checkout page
 *                         (rendered by routes in server.js, not by this app's
 *                         own templates on the booking side).
 *   2. The customer acts on that page — pay, fail, or cancel.
 *   3. The gateway redirects the browser back to success/fail/cancel_url with a
 *      tran_id and a val_id. That redirect is treated as untrusted.
 *   4. verify()         — a server-side lookup of the session by val_id, which
 *                         re-checks status, transaction id, amount and currency
 *                         before anything is marked Paid.
 *
 * Because step 4 never trusts step 3, the security model matches the real
 * providers and the switch between them changes nothing in server.js.
 */
const db = require('../../db');
const helpers = require('../../helpers');

const id = 'sandbox';
const label = 'Sandbox Checkout';
const description = 'Built-in test gateway. No credentials needed — simulates card, bKash and Nagad payments.';

/** The local gateway is always usable. */
function isConfigured() {
  return true;
}

function configHint() {
  return null;
}

async function createSession(order) {
  const sessionKey = `SBX-${helpers.generateToken(12).toUpperCase()}`;

  db.prepare(
    `INSERT INTO sandbox_sessions
      (session_key, tran_id, amount, currency, product_name,
       customer_name, customer_email, customer_phone,
       success_url, fail_url, cancel_url, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CREATED')`
  ).run(
    sessionKey,
    order.tranId,
    Number(order.amount),
    order.currency,
    order.productName,
    order.customer.name,
    order.customer.email,
    order.customer.phone || '',
    order.successUrl,
    order.failUrl,
    order.cancelUrl
  );

  return {
    redirectUrl: `/sandbox-gateway/${sessionKey}`,
    sessionKey,
    paymentId: null,
    raw: { session_key: sessionKey, status: 'CREATED' },
  };
}

/**
 * Server-side verification. Looks the transaction up by val_id — exactly the
 * role SSLCommerz's validation endpoint plays — and never reads the amount from
 * the browser's redirect.
 */
async function verify({ booking, payload }) {
  const valId = payload.val_id;
  if (!valId) return { ok: false, reason: 'No val_id was returned by the gateway.', raw: null };

  const session = db.prepare('SELECT * FROM sandbox_sessions WHERE val_id = ?').get(valId);
  if (!session) return { ok: false, reason: 'Transaction could not be found at the gateway.', raw: null };

  if (session.status !== 'VALID') {
    return { ok: false, reason: `Gateway reported status ${session.status}.`, raw: session };
  }
  if (session.tran_id !== booking.tran_id) {
    return { ok: false, reason: 'Transaction ID did not match this booking.', raw: session };
  }
  if (Math.abs(Number(session.amount) - Number(booking.amount)) > 0.01) {
    return {
      ok: false,
      reason: `Amount mismatch: expected ${booking.amount}, gateway reported ${session.amount}.`,
      raw: session,
    };
  }
  if (session.currency !== booking.currency) {
    return {
      ok: false,
      reason: `Currency mismatch: expected ${booking.currency}, got ${session.currency}.`,
      raw: session,
    };
  }

  return {
    ok: true,
    details: {
      val_id: session.val_id,
      bank_tran_id: session.bank_tran_id,
      card_type: session.card_type,
      amount: session.amount,
      currency: session.currency,
    },
    raw: session,
  };
}

/** Refunds are instant here — the session is simply flagged. */
async function refund({ booking }) {
  db.prepare("UPDATE sandbox_sessions SET status = 'REFUNDED' WHERE tran_id = ?").run(booking.tran_id);
  return { ok: true, refundId: `SBX-RF-${helpers.generateToken(6).toUpperCase()}` };
}

module.exports = { id, label, description, isConfigured, configHint, createSession, verify, refund };
