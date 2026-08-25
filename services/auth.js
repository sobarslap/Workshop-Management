/**
 * Authentication extras.
 *
 * Feature 1 — "Remember me" persistent login.
 *   Uses the split selector/validator pattern rather than storing a raw token.
 *   The cookie carries `selector:validator`; the database stores the selector in
 *   the clear (so it can be indexed) and only a SHA-256 hash of the validator.
 *   A stolen database therefore yields no usable cookies, and lookup stays O(1).
 *   Every use rotates the validator, so a copied cookie stops working as soon as
 *   the real owner logs in again.
 *
 * Feature 2 — Password reset by emailed single-use link.
 *   Only the hash of the token is stored, links expire, and they are consumed on
 *   use. The "forgot password" endpoint always reports the same thing whether or
 *   not the address exists, so it cannot be used to enumerate accounts.
 *
 * Also here: a small login throttle that locks an address after repeated
 * failures, which is the cheapest meaningful defence against password guessing.
 */
const db = require('../db');
const config = require('../config');
const helpers = require('../helpers');

const REMEMBER_COOKIE = 'cw_remember';

// ============================================================================
// REMEMBER ME
// ============================================================================
function issueRememberToken(res, user, userAgent) {
  const selector = helpers.generateToken(9);
  const validator = helpers.generateToken(32);
  const expires = new Date(Date.now() + config.auth.rememberDays * 86400000);

  db.prepare(
    'INSERT INTO remember_tokens (user_id, selector, validator_hash, user_agent, expires_at) VALUES (?, ?, ?, ?, ?)'
  ).run(user.id, selector, helpers.sha256(validator), (userAgent || '').slice(0, 200), expires.toISOString());

  res.cookie(REMEMBER_COOKIE, `${selector}:${validator}`, {
    httpOnly: true,
    sameSite: 'lax',
    expires,
    path: '/',
  });
}

/** Reads the cookie, validates it, rotates it, and returns the user. */
function consumeRememberToken(req, res) {
  const raw = req.cookies?.[REMEMBER_COOKIE];
  if (!raw || !raw.includes(':')) return null;

  const [selector, validator] = raw.split(':');
  const record = db.prepare('SELECT * FROM remember_tokens WHERE selector = ?').get(selector);
  if (!record) {
    clearRememberCookie(res);
    return null;
  }

  if (new Date(record.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM remember_tokens WHERE id = ?').run(record.id);
    clearRememberCookie(res);
    return null;
  }

  if (!helpers.safeEqual(helpers.sha256(validator), record.validator_hash)) {
    // Wrong validator for a real selector — treat as theft and revoke the
    // whole family of tokens for that user.
    db.prepare('DELETE FROM remember_tokens WHERE user_id = ?').run(record.user_id);
    clearRememberCookie(res);
    console.warn(`[AUTH] Remember-token mismatch for user ${record.user_id}; all sessions revoked.`);
    return null;
  }

  const user = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(record.user_id);
  if (!user) {
    db.prepare('DELETE FROM remember_tokens WHERE id = ?').run(record.id);
    clearRememberCookie(res);
    return null;
  }

  // Rotate the validator on every use.
  const newValidator = helpers.generateToken(32);
  const newExpires = new Date(Date.now() + config.auth.rememberDays * 86400000);
  db.prepare('UPDATE remember_tokens SET validator_hash = ?, expires_at = ? WHERE id = ?').run(
    helpers.sha256(newValidator),
    newExpires.toISOString(),
    record.id
  );
  res.cookie(REMEMBER_COOKIE, `${selector}:${newValidator}`, {
    httpOnly: true,
    sameSite: 'lax',
    expires: newExpires,
    path: '/',
  });

  return user;
}

function clearRememberCookie(res) {
  res.clearCookie(REMEMBER_COOKIE, { path: '/' });
}

function forgetDevice(req, res) {
  const raw = req.cookies?.[REMEMBER_COOKIE];
  if (raw && raw.includes(':')) {
    db.prepare('DELETE FROM remember_tokens WHERE selector = ?').run(raw.split(':')[0]);
  }
  clearRememberCookie(res);
}

function forgetAllDevices(userId) {
  db.prepare('DELETE FROM remember_tokens WHERE user_id = ?').run(userId);
}

function devicesFor(userId) {
  return db
    .prepare('SELECT id, user_agent, created_at, expires_at FROM remember_tokens WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId);
}

/** Express middleware — restores a session from the cookie when one is absent. */
function rememberMeMiddleware(req, res, next) {
  if (!req.session.user) {
    const user = consumeRememberToken(req, res);
    if (user) {
      req.session.user = user;
      req.session.restoredFromCookie = true;
    }
  }
  next();
}

// ============================================================================
// PASSWORD RESET
// ============================================================================
function createResetToken(user) {
  // One live link at a time per user.
  db.prepare('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL').run(user.id);

  const token = helpers.generateToken(32);
  const expires = new Date(Date.now() + config.auth.resetTokenMinutes * 60000);

  db.prepare('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)').run(
    user.id,
    helpers.sha256(token),
    expires.toISOString()
  );

  return token;
}

function findValidReset(token) {
  if (!token) return null;
  const record = db.prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(helpers.sha256(token));
  if (!record) return null;
  if (record.used_at) return null;
  if (new Date(record.expires_at).getTime() < Date.now()) return null;
  return record;
}

function consumeReset(resetId) {
  db.prepare('UPDATE password_resets SET used_at = CURRENT_TIMESTAMP WHERE id = ?').run(resetId);
}

// ============================================================================
// LOGIN THROTTLE
// ============================================================================
function lockState(email) {
  const record = db.prepare('SELECT * FROM login_attempts WHERE email = ?').get(email);
  if (!record || !record.locked_until) return { locked: false, attempts: record?.attempts || 0 };

  const until = new Date(record.locked_until).getTime();
  if (until < Date.now()) {
    db.prepare('DELETE FROM login_attempts WHERE email = ?').run(email);
    return { locked: false, attempts: 0 };
  }
  return { locked: true, minutesLeft: Math.ceil((until - Date.now()) / 60000), attempts: record.attempts };
}

function recordFailure(email) {
  const record = db.prepare('SELECT * FROM login_attempts WHERE email = ?').get(email);
  const attempts = (record?.attempts || 0) + 1;

  if (attempts >= config.auth.maxLoginAttempts) {
    const until = new Date(Date.now() + config.auth.lockoutMinutes * 60000).toISOString();
    db.prepare(
      `INSERT INTO login_attempts (email, attempts, locked_until) VALUES (?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET attempts = excluded.attempts, locked_until = excluded.locked_until`
    ).run(email, attempts, until);
    return { locked: true, minutesLeft: config.auth.lockoutMinutes, attempts };
  }

  db.prepare(
    `INSERT INTO login_attempts (email, attempts, locked_until) VALUES (?, ?, NULL)
     ON CONFLICT(email) DO UPDATE SET attempts = excluded.attempts`
  ).run(email, attempts);

  return { locked: false, attempts, remaining: config.auth.maxLoginAttempts - attempts };
}

function clearFailures(email) {
  db.prepare('DELETE FROM login_attempts WHERE email = ?').run(email);
}

// ============================================================================
// PASSWORD RULES
// ============================================================================
/** Returns { ok, message } — kept in one place so register and reset agree. */
function checkPassword(password) {
  if (!password || password.length < 8) return { ok: false, message: 'Password must be at least 8 characters.' };
  if (!/[a-zA-Z]/.test(password)) return { ok: false, message: 'Password must contain at least one letter.' };
  if (!/[0-9]/.test(password)) return { ok: false, message: 'Password must contain at least one number.' };
  return { ok: true };
}

module.exports = {
  REMEMBER_COOKIE,
  issueRememberToken,
  consumeRememberToken,
  clearRememberCookie,
  forgetDevice,
  forgetAllDevices,
  devicesFor,
  rememberMeMiddleware,
  createResetToken,
  findValidReset,
  consumeReset,
  lockState,
  recordFailure,
  clearFailures,
  checkPassword,
};
