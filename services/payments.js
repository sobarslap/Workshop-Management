/**
 * Payment facade.
 *
 * server.js talks only to this module, never to a specific provider. Every
 * gateway exposes the same four things:
 *
 *   isConfigured()                     -> boolean
 *   createSession(order)               -> { redirectUrl, sessionKey, paymentId, raw }
 *   verify({ booking, payload })       -> { ok, reason?, details?, raw }
 *   refund({ booking })                -> { ok, refundId? }        (optional)
 *
 * Switching PAYMENT_GATEWAY in .env therefore changes nothing else in the app.
 * If the configured provider is missing its credentials we fall back to the
 * built-in sandbox rather than crashing, and say so loudly at boot — a missing
 * key should degrade the demo, not break the booking flow.
 */
const config = require('../config');
const db = require('../db');

const sandbox = require('./gateways/sandbox');
const sslcommerz = require('./gateways/sslcommerz');
const bkash = require('./gateways/bkash');

const registry = { sandbox, sslcommerz, bkash };

// 'simulated' was the name used in the previous build — keep it working.
const ALIASES = { simulated: 'sandbox', local: 'sandbox', ssl: 'sslcommerz' };

function resolveName(name) {
  const key = ALIASES[name] || name;
  return registry[key] ? key : 'sandbox';
}

const requested = resolveName(config.gateway);
const requestedProvider = registry[requested];

const activeName = requestedProvider.isConfigured() ? requested : 'sandbox';
const active = registry[activeName];

/** True when we quietly fell back because credentials were missing. */
const fellBack = activeName !== requested;
const fallbackReason = fellBack ? requestedProvider.configHint() : null;

function describe() {
  return {
    id: active.id,
    label: active.label,
    description: active.description,
    requested,
    fellBack,
    fallbackReason,
    isSandbox: active.id === 'sandbox',
    // Real gateways still have a test mode; the pay page shows different help
    // for a live store than for a sandbox one.
    isLive: Boolean(config[active.id] && config[active.id].isLive),
    all: Object.values(registry).map((g) => ({
      id: g.id,
      label: g.label,
      configured: g.isConfigured(),
      active: g.id === active.id,
      hint: g.configHint(),
    })),
  };
}

/** Append-only audit trail. Every state change on a payment lands here. */
function logEvent(bookingId, event, detail, payload) {
  try {
    db.prepare(
      'INSERT INTO payment_events (booking_id, event, gateway, detail, payload) VALUES (?, ?, ?, ?, ?)'
    ).run(
      bookingId,
      event,
      active.id,
      detail ? String(detail).slice(0, 500) : null,
      payload ? JSON.stringify(payload).slice(0, 8000) : null
    );
  } catch (err) {
    console.error('[PAYMENTS] Could not write audit event:', err.message);
  }
}

function eventsFor(bookingId) {
  return db
    .prepare('SELECT * FROM payment_events WHERE booking_id = ? ORDER BY id DESC')
    .all(bookingId);
}

async function createSession(order) {
  return active.createSession(order);
}

async function verify(args) {
  return active.verify(args);
}

async function refund(args) {
  if (typeof active.refund !== 'function') {
    return { ok: false, reason: `${active.label} does not support automated refunds.` };
  }
  return active.refund(args);
}

module.exports = {
  active,
  activeName,
  describe,
  createSession,
  verify,
  refund,
  logEvent,
  eventsFor,
};
