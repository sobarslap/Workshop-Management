const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const bcrypt = require('bcryptjs');
const path = require('path');

const config = require('./config');
const db = require('./db');
const helpers = require('./helpers');
const payments = require('./services/payments');
const mailer = require('./services/mailer');
const auth = require('./services/auth');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1); // correct protocol/host behind a tunnel (ngrok, for IPN)

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

/**
 * Minimal cookie parser. Only the remember-me cookie is read, so pulling in
 * cookie-parser for one line of work is not worth the dependency.
 */
app.use((req, res, next) => {
  req.cookies = {};
  const header = req.headers.cookie;
  if (header) {
    header.split(';').forEach((pair) => {
      const index = pair.indexOf('=');
      if (index > -1) {
        req.cookies[pair.slice(0, index).trim()] = decodeURIComponent(pair.slice(index + 1).trim());
      }
    });
  }
  next();
});

app.use(
  session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 4, httpOnly: true, sameSite: 'lax' },
  })
);
app.use(flash());
app.use(auth.rememberMeMiddleware);

const gatewayInfo = payments.describe();

// Values and helpers every view can reach.
app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;

  // Flash messages are read lazily, at render time, not here.
  //
  // Reading them eagerly is a subtle trap: a handler that calls
  // req.flash('error', ...) and then res.render(...) in the same request would
  // have its message silently dropped, because locals were already snapshotted
  // before the flash was written. Every validation error on register, login and
  // the workshop form went missing that way. Getters fix it for all of them at
  // once, and each is cached so repeated access in a template is consistent.
  let flashCache = null;
  const readFlash = () => {
    if (!flashCache) {
      flashCache = {
        success: req.flash('success'),
        error: req.flash('error'),
        info: req.flash('info'),
      };
    }
    return flashCache;
  };
  Object.defineProperties(res.locals, {
    success: { get: () => readFlash().success, enumerable: true, configurable: true },
    error: { get: () => readFlash().error, enumerable: true, configurable: true },
    info: { get: () => readFlash().info, enumerable: true, configurable: true },
  });

  res.locals.title = config.brand.name;
  res.locals.path = req.path;
  res.locals.brand = config.brand;
  res.locals.currency = config.currency;
  res.locals.gateway = gatewayInfo;
  res.locals.seatHoldMinutes = config.seatHoldMinutes;
  Object.assign(res.locals, helpers);
  next();
});

// ============================================================================
// AUTH MIDDLEWARE
// ============================================================================
function requireLogin(req, res, next) {
  if (!req.session.user) {
    req.session.returnTo = req.originalUrl;
    req.flash('error', 'Please log in to continue.');
    return res.redirect('/login');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user) {
    req.session.returnTo = req.originalUrl;
    req.flash('error', 'Please log in as an administrator.');
    return res.redirect('/login');
  }
  if (req.session.user.role !== 'admin') {
    return res.status(403).render('error', { code: 403, message: 'Administrator access is required for that page.', title: 'Forbidden' });
  }
  next();
}

// ============================================================================
// CAPACITY LOGIC
// ============================================================================
// A seat is held by any booking that is Pending or Paid. Pending bookings that
// are never paid for release automatically after SEAT_HOLD_MINUTES, so an
// abandoned checkout cannot block a seat forever.
const HOLDING = "('Pending','Paid')";

function releaseExpiredHolds() {
  const result = db
    .prepare(
      `UPDATE bookings
          SET payment_status = 'Expired',
              payment_note = COALESCE(payment_note, 'Seat hold expired before payment was completed'),
              updated_at = CURRENT_TIMESTAMP
        WHERE payment_status = 'Pending'
          AND created_at <= datetime('now', ?)`
    )
    .run(`-${config.seatHoldMinutes} minutes`);
  return result.changes || 0;
}

function seatsTaken(workshopId) {
  return db
    .prepare(`SELECT COUNT(*) AS c FROM bookings WHERE workshop_id = ? AND payment_status IN ${HOLDING}`)
    .get(workshopId).c;
}

function seatsRemaining(workshop) {
  return Math.max(0, workshop.capacity - seatsTaken(workshop.id));
}

const WORKSHOP_SELECT = `
  SELECT w.*,
         (SELECT COUNT(*) FROM bookings b
           WHERE b.workshop_id = w.id AND b.payment_status IN ${HOLDING}) AS seats_taken,
         (SELECT COUNT(*) FROM bookings b
           WHERE b.workshop_id = w.id AND b.payment_status = 'Paid') AS paid_count,
         (w.capacity - (SELECT COUNT(*) FROM bookings b
           WHERE b.workshop_id = w.id AND b.payment_status IN ${HOLDING})) AS seats_remaining
    FROM workshops w`;

function listActiveWorkshops() {
  releaseExpiredHolds();
  return db.prepare(`${WORKSHOP_SELECT} WHERE w.status = 'active' ORDER BY w.workshop_date`).all();
}

function getWorkshop(id) {
  return db.prepare(`${WORKSHOP_SELECT} WHERE w.id = ?`).get(id);
}

/**
 * Reserve a seat inside an IMMEDIATE transaction so two people racing for the
 * final seat cannot both win it. The capacity check and the INSERT have to be
 * atomic — checking first and inserting after would leave a window between them.
 */
function reserveSeat(workshopId, userId, attendee) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const workshop = db.prepare("SELECT * FROM workshops WHERE id = ? AND status = 'active'").get(workshopId);
    if (!workshop) {
      db.exec('ROLLBACK');
      return { ok: false, reason: 'That workshop is no longer available.' };
    }

    const taken = db
      .prepare(`SELECT COUNT(*) AS c FROM bookings WHERE workshop_id = ? AND payment_status IN ${HOLDING}`)
      .get(workshopId).c;

    if (taken >= workshop.capacity) {
      db.exec('ROLLBACK');
      return { ok: false, reason: 'Sorry — this workshop filled up while you were booking.' };
    }

    const info = db
      .prepare(
        `INSERT INTO bookings
          (user_id, workshop_id, attendee_name, attendee_email, attendee_phone, attendee_company,
           attendee_notes, amount, currency, gateway, payment_status, public_token)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?)`
      )
      .run(
        userId,
        workshop.id,
        attendee.name,
        attendee.email,
        attendee.phone || '',
        attendee.company || '',
        attendee.notes || '',
        Number(workshop.price),
        config.currency,
        payments.activeName,
        helpers.generateToken()
      );

    const bookingId = Number(info.lastInsertRowid);
    db.prepare('UPDATE bookings SET tran_id = ? WHERE id = ?').run(helpers.generateTranId(bookingId), bookingId);

    db.exec('COMMIT');
    return { ok: true, bookingId };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw err;
  }
}

// ============================================================================
// BOOKING LOOKUPS
// ============================================================================
const BOOKING_SELECT = `
  SELECT b.*, w.title, w.workshop_date, w.description, w.location, w.instructor,
         w.start_time, w.end_time, w.level, w.status AS workshop_status
    FROM bookings b
    JOIN workshops w ON w.id = b.workshop_id`;

const getBookingById = (id) => db.prepare(`${BOOKING_SELECT} WHERE b.id = ?`).get(id);
const getBookingByTranId = (tranId) => db.prepare(`${BOOKING_SELECT} WHERE b.tran_id = ?`).get(tranId);
const getBookingByPaymentId = (paymentId) => db.prepare(`${BOOKING_SELECT} WHERE b.payment_id = ?`).get(paymentId);

/**
 * A booking is viewable by its owner, by an admin, or by anyone holding its
 * public token. The token exists because a gateway redirect arrives cross-site,
 * so the session cookie may not come with it — without the token the customer
 * would be bounced to a login screen at the worst possible moment.
 */
function authorizeBooking(req, booking) {
  if (!booking) return false;
  const user = req.session.user;
  if (user && (user.id === booking.user_id || user.role === 'admin')) return true;
  // Express 5 leaves req.body undefined on GET, so it cannot be read blindly.
  const token = req.query.t || (req.body && req.body.t);
  return Boolean(token && booking.public_token && helpers.safeEqual(token, booking.public_token));
}

function updateBooking(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const assignments = keys.map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE bookings SET ${assignments}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
    ...keys.map((k) => fields[k]),
    id
  );
}

async function sendBookingConfirmation(booking) {
  await mailer.sendMail(
    mailer.bookingConfirmation({
      booking,
      formatDate: helpers.formatDate,
      money: helpers.money,
      confirmationUrl: `${config.baseUrl}/booking/${booking.id}/confirmation?t=${booking.public_token}`,
    })
  );
}

// ============================================================================
// HOME
// ============================================================================
app.get('/', (req, res) => {
  const workshops = listActiveWorkshops().filter((w) => !helpers.isPast(w.workshop_date));
  const stats = {
    upcoming: workshops.length,
    seats: workshops.reduce((sum, w) => sum + Math.max(0, w.seats_remaining), 0),
    delivered: db.prepare("SELECT COUNT(*) AS c FROM bookings WHERE payment_status = 'Paid'").get().c,
  };
  res.render('home', {
    workshops: workshops.slice(0, 3),
    stats,
    title: `${config.brand.name} — ${config.brand.tagline}`,
  });
});

// ============================================================================
// REGISTER
// ============================================================================
app.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/workshops');
  res.render('register', { form: {}, title: 'Create an account' });
});

app.post('/register', async (req, res) => {
  const { name, email, phone, company, password, confirm_password, remember } = req.body;

  const fail = (message) => {
    req.flash('error', message);
    return res.render('register', { form: req.body, title: 'Create an account' });
  };

  if (!name || !email || !password) return fail('Name, email and password are all required.');

  const strength = auth.checkPassword(password);
  if (!strength.ok) return fail(strength.message);
  if (password !== confirm_password) return fail('The two passwords do not match.');

  const cleanEmail = email.toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return fail('Please enter a valid email address.');
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail)) {
    return fail('An account with that email already exists. Try logging in instead.');
  }

  const info = db
    .prepare('INSERT INTO users (name, email, phone, company, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name.trim(), cleanEmail, phone || '', company || '', bcrypt.hashSync(password, 10), 'user');

  const user = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(info.lastInsertRowid);
  req.session.user = user;

  if (remember) auth.issueRememberToken(res, user, req.get('user-agent'));

  await mailer.sendMail(mailer.welcome({ user, browseUrl: `${config.baseUrl}/workshops` }));

  req.flash('success', `Welcome, ${user.name.split(' ')[0]}. Your account is ready.`);
  const target = req.session.returnTo || '/workshops';
  delete req.session.returnTo;
  res.redirect(target);
});

// ============================================================================
// LOGIN / LOGOUT
// ============================================================================
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect(req.session.user.role === 'admin' ? '/admin/dashboard' : '/workshops');
  res.render('login', { form: {}, title: 'Log in' });
});

app.post('/login', (req, res) => {
  const { email, password, remember } = req.body;
  const cleanEmail = (email || '').toLowerCase().trim();

  const fail = (message) => {
    req.flash('error', message);
    return res.render('login', { form: { email: cleanEmail }, title: 'Log in' });
  };

  // Login feature: throttle repeated failures against one address.
  const lock = auth.lockState(cleanEmail);
  if (lock.locked) {
    return fail(`Too many failed attempts. Try again in ${lock.minutesLeft} minute(s), or reset your password.`);
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(cleanEmail);

  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    const state = auth.recordFailure(cleanEmail);
    if (state.locked) {
      return fail(`Too many failed attempts. This account is locked for ${config.auth.lockoutMinutes} minutes.`);
    }
    return fail(
      state.remaining <= 2
        ? `Invalid email or password. ${state.remaining} attempt(s) left before the account locks.`
        : 'Invalid email or password.'
    );
  }

  auth.clearFailures(cleanEmail);

  const sessionUser = { id: user.id, name: user.name, email: user.email, role: user.role };
  req.session.user = sessionUser;

  // Login feature: persistent "Remember me" across browser restarts.
  if (remember) auth.issueRememberToken(res, sessionUser, req.get('user-agent'));

  req.flash('success', `Welcome back, ${user.name.split(' ')[0]}.`);
  const target = req.session.returnTo || (user.role === 'admin' ? '/admin/dashboard' : '/workshops');
  delete req.session.returnTo;
  res.redirect(target);
});

app.post('/logout', (req, res) => {
  auth.forgetDevice(req, res);
  req.session.destroy(() => res.redirect('/'));
});

// ---------- Forgot / reset password ----------
app.get('/forgot-password', (req, res) => {
  res.render('forgot-password', { form: {}, title: 'Reset your password' });
});

app.post('/forgot-password', async (req, res) => {
  const cleanEmail = (req.body.email || '').toLowerCase().trim();
  const user = db.prepare('SELECT id, name, email FROM users WHERE email = ?').get(cleanEmail);

  if (user) {
    const token = auth.createResetToken(user);
    const resetUrl = `${config.baseUrl}/reset-password/${token}`;
    await mailer.sendMail(
      mailer.passwordReset({ user, resetUrl, expiresMinutes: config.auth.resetTokenMinutes })
    );
    console.log(`[AUTH] Password reset link for ${user.email}: ${resetUrl}`);
  }

  // Deliberately identical whether or not the account exists, so this endpoint
  // cannot be used to discover which addresses are registered.
  res.render('forgot-password-sent', {
    email: cleanEmail,
    title: 'Check your email',
  });
});

app.get('/reset-password/:token', (req, res) => {
  const record = auth.findValidReset(req.params.token);
  if (!record) {
    return res.status(400).render('error', {
      code: 400,
      message: 'That password reset link is invalid or has expired. Request a new one from the login page.',
      title: 'Link expired',
    });
  }
  res.render('reset-password', { token: req.params.token, title: 'Choose a new password' });
});

app.post('/reset-password/:token', (req, res) => {
  const record = auth.findValidReset(req.params.token);
  if (!record) {
    req.flash('error', 'That reset link is no longer valid. Please request a new one.');
    return res.redirect('/forgot-password');
  }

  const { password, confirm_password } = req.body;
  const strength = auth.checkPassword(password);
  if (!strength.ok) {
    req.flash('error', strength.message);
    return res.render('reset-password', { token: req.params.token, title: 'Choose a new password' });
  }
  if (password !== confirm_password) {
    req.flash('error', 'The two passwords do not match.');
    return res.render('reset-password', { token: req.params.token, title: 'Choose a new password' });
  }

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), record.user_id);
  auth.consumeReset(record.id);
  auth.forgetAllDevices(record.user_id); // a reset signs every device out
  auth.clearFailures(db.prepare('SELECT email FROM users WHERE id = ?').get(record.user_id).email);

  req.flash('success', 'Your password has been changed. Please log in with it.');
  res.redirect('/login');
});

// ============================================================================
// ACCOUNT
// ============================================================================
app.get('/account', requireLogin, (req, res) => {
  const user = db.prepare('SELECT id, name, email, phone, company, role, created_at FROM users WHERE id = ?').get(req.session.user.id);
  res.render('account', {
    user,
    devices: auth.devicesFor(user.id),
    bookingCount: db.prepare('SELECT COUNT(*) AS c FROM bookings WHERE user_id = ?').get(user.id).c,
    title: 'Your account',
  });
});

app.post('/account', requireLogin, (req, res) => {
  const { name, phone, company } = req.body;
  if (!name || !name.trim()) {
    req.flash('error', 'Name cannot be empty.');
    return res.redirect('/account');
  }
  db.prepare('UPDATE users SET name = ?, phone = ?, company = ? WHERE id = ?').run(
    name.trim(),
    phone || '',
    company || '',
    req.session.user.id
  );
  req.session.user.name = name.trim();
  req.flash('success', 'Profile updated.');
  res.redirect('/account');
});

app.post('/account/password', requireLogin, (req, res) => {
  const { current_password, password, confirm_password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);

  if (!bcrypt.compareSync(current_password || '', user.password_hash)) {
    req.flash('error', 'Your current password is not correct.');
    return res.redirect('/account');
  }
  const strength = auth.checkPassword(password);
  if (!strength.ok) {
    req.flash('error', strength.message);
    return res.redirect('/account');
  }
  if (password !== confirm_password) {
    req.flash('error', 'The two new passwords do not match.');
    return res.redirect('/account');
  }

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), user.id);
  req.flash('success', 'Password changed.');
  res.redirect('/account');
});

app.post('/account/devices/revoke', requireLogin, (req, res) => {
  auth.forgetAllDevices(req.session.user.id);
  auth.clearRememberCookie(res);
  req.flash('success', 'Signed out of all remembered devices.');
  res.redirect('/account');
});

// ============================================================================
// FEATURE 1 — EXPRESSION OF INTEREST
// ============================================================================
app.get('/eoi', (req, res) => {
  res.render('eoi', {
    workshops: listActiveWorkshops(),
    form: { workshop_id: req.query.workshop_id || '' },
    title: 'Express your interest',
  });
});

app.post('/eoi', async (req, res) => {
  const { name, company, email, phone, workshop_id, message } = req.body;

  const fail = (msg) => {
    req.flash('error', msg);
    return res.render('eoi', { workshops: listActiveWorkshops(), form: req.body, title: 'Express your interest' });
  };

  if (!name || !email || !workshop_id) return fail('Name, email and a workshop of interest are all required.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return fail('Please enter a valid email address.');

  const workshop = db.prepare('SELECT * FROM workshops WHERE id = ?').get(workshop_id);
  if (!workshop) return fail('Please choose a workshop from the list.');

  db.prepare(
    'INSERT INTO eoi_submissions (name, company, email, phone, workshop_id, message, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(name.trim(), company || '', email.trim().toLowerCase(), phone || '', workshop.id, message || '', 'New');

  // FEATURE 2 — automated acknowledgment
  await mailer.sendMail(
    mailer.eoiAcknowledgment({
      name: name.trim(),
      email: email.trim(),
      workshop,
      formatDate: helpers.formatDate,
      money: helpers.money,
      browseUrl: `${config.baseUrl}/workshops`,
    })
  );

  res.render('eoi-success', {
    name: name.trim(),
    email: email.trim(),
    workshop,
    title: 'Interest received',
  });
});

// ============================================================================
// FEATURE 3 — WORKSHOP LISTING
// ============================================================================
app.get('/workshops', (req, res) => {
  let workshops = listActiveWorkshops();

  const filters = {
    q: (req.query.q || '').trim(),
    level: req.query.level || '',
    availability: req.query.availability || '',
    sort: req.query.sort || 'date',
  };

  if (filters.q) {
    const needle = filters.q.toLowerCase();
    workshops = workshops.filter((w) =>
      [w.title, w.description, w.instructor, w.location].some((field) =>
        String(field || '').toLowerCase().includes(needle)
      )
    );
  }
  if (filters.level) workshops = workshops.filter((w) => w.level === filters.level);
  if (filters.availability === 'available') workshops = workshops.filter((w) => w.seats_remaining > 0);
  if (filters.availability === 'limited') {
    workshops = workshops.filter((w) => w.seats_remaining > 0 && w.seats_remaining / w.capacity <= 0.25);
  }

  if (filters.sort === 'price-asc') workshops.sort((a, b) => a.price - b.price);
  else if (filters.sort === 'price-desc') workshops.sort((a, b) => b.price - a.price);
  else if (filters.sort === 'seats') workshops.sort((a, b) => b.seats_remaining - a.seats_remaining);

  const levels = db
    .prepare("SELECT DISTINCT level FROM workshops WHERE status = 'active' AND level IS NOT NULL AND level <> '' ORDER BY level")
    .all()
    .map((r) => r.level);

  res.render('workshops', { workshops, filters, levels, title: 'Upcoming workshops' });
});

app.get('/workshops/:id', (req, res) => {
  releaseExpiredHolds();
  const workshop = getWorkshop(req.params.id);
  if (!workshop || workshop.status !== 'active') {
    return res.status(404).render('error', { code: 404, message: 'That workshop could not be found.', title: 'Not found' });
  }

  let existing = null;
  if (req.session.user) {
    existing = db
      .prepare(`SELECT * FROM bookings WHERE user_id = ? AND workshop_id = ? AND payment_status IN ${HOLDING}`)
      .get(req.session.user.id, workshop.id);
  }

  const related = db
    .prepare(`${WORKSHOP_SELECT} WHERE w.status = 'active' AND w.id <> ? ORDER BY w.workshop_date LIMIT 3`)
    .all(workshop.id);

  res.render('workshop-detail', { workshop, existing, related, title: workshop.title });
});

// ============================================================================
// FEATURE 4/5 — BOOKING FLOW (login required)
// ============================================================================
// Step 1 — confirm attendee details
app.get('/book/:workshopId', requireLogin, (req, res) => {
  releaseExpiredHolds();
  const workshop = getWorkshop(req.params.workshopId);
  if (!workshop || workshop.status !== 'active') {
    req.flash('error', 'That workshop is no longer available.');
    return res.redirect('/workshops');
  }
  if (helpers.isPast(workshop.workshop_date)) {
    req.flash('error', 'That workshop date has already passed.');
    return res.redirect('/workshops');
  }

  // Send the user back to an existing booking rather than creating a duplicate.
  const existing = db
    .prepare(`SELECT * FROM bookings WHERE user_id = ? AND workshop_id = ? AND payment_status IN ${HOLDING}`)
    .get(req.session.user.id, workshop.id);

  if (existing) {
    if (existing.payment_status === 'Paid') {
      req.flash('info', 'You have already booked and paid for this workshop.');
      return res.redirect(`/booking/${existing.id}/confirmation`);
    }
    req.flash('info', 'You already have a seat on hold here — just complete the payment.');
    return res.redirect(`/booking/${existing.id}/pay`);
  }

  if (workshop.seats_remaining <= 0) {
    req.flash('error', 'Sorry, this workshop is fully booked.');
    return res.redirect(`/workshops/${workshop.id}`);
  }

  const profile = db.prepare('SELECT name, email, phone, company FROM users WHERE id = ?').get(req.session.user.id);
  res.render('book', { workshop, form: profile, title: `Book: ${workshop.title}` });
});

// Step 2 — reserve the seat, then move to payment
app.post('/book/:workshopId', requireLogin, (req, res) => {
  releaseExpiredHolds();
  const workshop = getWorkshop(req.params.workshopId);
  if (!workshop || workshop.status !== 'active') {
    req.flash('error', 'That workshop is no longer available.');
    return res.redirect('/workshops');
  }

  const { attendee_name, attendee_email, attendee_phone, attendee_company, attendee_notes } = req.body;
  if (!attendee_name || !attendee_email) {
    req.flash('error', 'The attendee name and email are required.');
    return res.redirect(`/book/${workshop.id}`);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(attendee_email.trim())) {
    req.flash('error', 'Please enter a valid attendee email address.');
    return res.redirect(`/book/${workshop.id}`);
  }

  // FEATURE 6 — capacity enforcement, applied atomically at write time.
  const result = reserveSeat(workshop.id, req.session.user.id, {
    name: attendee_name.trim(),
    email: attendee_email.trim().toLowerCase(),
    phone: attendee_phone,
    company: attendee_company,
    notes: attendee_notes,
  });

  if (!result.ok) {
    req.flash('error', result.reason);
    return res.redirect(`/workshops/${workshop.id}`);
  }

  payments.logEvent(result.bookingId, 'booking.created', `Seat held for ${config.seatHoldMinutes} minutes`);
  res.redirect(`/booking/${result.bookingId}/pay`);
});

// Step 3 — payment page
app.get('/booking/:bookingId/pay', (req, res) => {
  const booking = getBookingById(req.params.bookingId);
  if (!authorizeBooking(req, booking)) return requireLogin(req, res, () => res.redirect('/my-bookings'));

  if (booking.payment_status === 'Paid') return res.redirect(`/booking/${booking.id}/confirmation`);

  res.render('pay', { booking, title: 'Complete your payment' });
});

// Step 4 — hand the customer to the gateway
app.post('/booking/:bookingId/checkout', requireLogin, async (req, res) => {
  const booking = getBookingById(req.params.bookingId);
  if (!booking || booking.user_id !== req.session.user.id) {
    req.flash('error', 'Booking not found.');
    return res.redirect('/my-bookings');
  }
  if (booking.payment_status === 'Paid') return res.redirect(`/booking/${booking.id}/confirmation`);

  // A retry after a failed / cancelled / expired attempt needs a fresh
  // transaction id, and has to re-check that a seat is still free.
  if (booking.payment_status !== 'Pending') {
    releaseExpiredHolds();
    const workshop = getWorkshop(booking.workshop_id);
    if (!workshop || workshop.status !== 'active' || workshop.seats_remaining <= 0) {
      req.flash('error', 'This workshop is no longer available to book.');
      return res.redirect('/workshops');
    }
    updateBooking(booking.id, {
      payment_status: 'Pending',
      payment_note: null,
      tran_id: helpers.generateTranId(booking.id),
      created_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    });
    payments.logEvent(booking.id, 'payment.retry', 'Customer restarted a failed or expired payment');
  }

  const fresh = getBookingById(booking.id);
  db.prepare('UPDATE bookings SET attempts = COALESCE(attempts, 0) + 1 WHERE id = ?').run(fresh.id);

  try {
    const session = await payments.createSession({
      bookingId: fresh.id,
      tranId: fresh.tran_id,
      amount: fresh.amount,
      currency: fresh.currency,
      productName: `${fresh.title} — ${fresh.workshop_date}`,
      successUrl: `${config.baseUrl}/payment/success`,
      failUrl: `${config.baseUrl}/payment/fail`,
      cancelUrl: `${config.baseUrl}/payment/cancel`,
      ipnUrl: `${config.baseUrl}/payment/ipn`,
      callbackUrl: `${config.baseUrl}/payment/bkash/callback`, // bKash uses one URL
      customer: {
        name: fresh.attendee_name,
        email: fresh.attendee_email,
        phone: fresh.attendee_phone,
        address: fresh.attendee_company || 'N/A',
      },
    });

    updateBooking(fresh.id, {
      session_key: session.sessionKey || null,
      payment_id: session.paymentId || null,
      gateway: payments.activeName,
    });
    payments.logEvent(fresh.id, 'payment.session_created', `Redirecting to ${payments.active.label}`, session.raw);

    console.log(`[PAY] Session created for ${fresh.tran_id} via ${payments.active.label}`);
    return res.redirect(session.redirectUrl);
  } catch (err) {
    console.error('[PAY] Session initiation failed:', err.message);
    updateBooking(fresh.id, { payment_note: `Gateway error: ${err.message}` });
    payments.logEvent(fresh.id, 'payment.session_failed', err.message);
    req.flash('error', `Could not start the payment session. ${err.message}`);
    return res.redirect(`/booking/${fresh.id}/pay`);
  }
});

// ============================================================================
// BUILT-IN SANDBOX GATEWAY (only reachable when PAYMENT_GATEWAY=sandbox)
// ============================================================================
// These routes stand in for the hosted checkout page a real provider would
// serve. They live behind the same redirect/verify contract as SSLCommerz.
app.get('/sandbox-gateway/:sessionKey', (req, res) => {
  const sess = db.prepare('SELECT * FROM sandbox_sessions WHERE session_key = ?').get(req.params.sessionKey);
  if (!sess) {
    return res.status(404).render('error', { code: 404, message: 'That payment session does not exist.', title: 'Session not found' });
  }
  if (sess.status !== 'CREATED') {
    return res.redirect(`/payment/success?tran_id=${encodeURIComponent(sess.tran_id)}&val_id=${encodeURIComponent(sess.val_id || '')}`);
  }
  res.render('sandbox-gateway', { session: sess, layout: false, title: 'Secure Checkout' });
});

app.post('/sandbox-gateway/:sessionKey', async (req, res) => {
  const sess = db.prepare('SELECT * FROM sandbox_sessions WHERE session_key = ?').get(req.params.sessionKey);
  if (!sess) return res.status(404).send('Unknown session');

  // Simulated network latency so the demo behaves like a real redirect.
  if (config.sandbox.latencyMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, config.sandbox.latencyMs));
  }

  const action = req.body.action;
  const method = req.body.method || 'Visa';

  if (action === 'cancel') {
    db.prepare("UPDATE sandbox_sessions SET status = 'CANCELLED', completed_at = CURRENT_TIMESTAMP WHERE id = ?").run(sess.id);
    return res.redirect(`/payment/cancel?tran_id=${encodeURIComponent(sess.tran_id)}`);
  }

  if (action === 'fail') {
    db.prepare("UPDATE sandbox_sessions SET status = 'FAILED', completed_at = CURRENT_TIMESTAMP WHERE id = ?").run(sess.id);
    return res.redirect(
      `/payment/fail?tran_id=${encodeURIComponent(sess.tran_id)}&error=${encodeURIComponent('Issuing bank declined the transaction')}`
    );
  }

  const valId = `SBXVAL-${helpers.generateToken(10).toUpperCase()}`;
  const bankTranId = `SBXBNK-${Date.now().toString(36).toUpperCase()}`;
  db.prepare(
    "UPDATE sandbox_sessions SET status = 'VALID', val_id = ?, bank_tran_id = ?, card_type = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(valId, bankTranId, method, sess.id);

  return res.redirect(
    `/payment/success?tran_id=${encodeURIComponent(sess.tran_id)}&val_id=${encodeURIComponent(valId)}&status=VALID`
  );
});

// ============================================================================
// GATEWAY CALLBACKS
// ============================================================================
// These are deliberately NOT behind requireLogin: the request arrives
// cross-site, so the session cookie may not be attached. The booking is found
// by tran_id / paymentID instead, and every success is verified
// server-to-server before anything is marked Paid.
async function handleGatewayReturn(req, res, outcome, booking, payload) {
  if (!booking) {
    console.warn(`[PAY] ${outcome} callback could not be matched to a booking`);
    return res.status(404).render('payment-result', {
      booking: null,
      outcome: 'error',
      reason: 'We could not match this payment to a booking. Please contact support with your transaction reference.',
      title: 'Payment problem',
    });
  }

  const rawResponse = JSON.stringify(payload);

  // ----- customer bailed out or the gateway declined -----
  if (outcome === 'cancel' || outcome === 'fail') {
    if (booking.payment_status !== 'Paid') {
      updateBooking(booking.id, {
        payment_status: outcome === 'cancel' ? 'Cancelled' : 'Failed',
        payment_note:
          outcome === 'cancel'
            ? 'Payment was cancelled at the gateway.'
            : `Payment failed at the gateway${payload.error ? `: ${payload.error}` : '.'}`,
        gateway_response: rawResponse,
      });
      payments.logEvent(booking.id, `payment.${outcome}`, payload.error || null, payload);
    }
    return res.redirect(`/booking/${booking.id}/payment-result?t=${booking.public_token}`);
  }

  // ----- success claimed; verify it before believing it -----
  if (booking.payment_status === 'Paid') {
    return res.redirect(`/booking/${booking.id}/confirmation?t=${booking.public_token}`);
  }

  try {
    const check = await payments.verify({ booking, payload });

    if (!check.ok) {
      console.warn(`[PAY] Verification rejected for ${booking.tran_id}: ${check.reason}`);
      updateBooking(booking.id, {
        payment_status: 'Failed',
        payment_note: `Verification failed — ${check.reason}`,
        val_id: payload.val_id || null,
        gateway_response: JSON.stringify({ callback: payload, verification: check.raw }),
      });
      payments.logEvent(booking.id, 'payment.verification_failed', check.reason, check.raw);
      return res.redirect(`/booking/${booking.id}/payment-result?t=${booking.public_token}`);
    }

    // Overselling guard: if the seat count somehow passed capacity while this
    // customer was at the gateway, keep the payment but flag it for an admin
    // rather than silently refusing money that has already moved.
    const workshop = db.prepare('SELECT * FROM workshops WHERE id = ?').get(booking.workshop_id);
    const paidSeats = db
      .prepare("SELECT COUNT(*) AS c FROM bookings WHERE workshop_id = ? AND payment_status = 'Paid'")
      .get(workshop.id).c;
    const oversold = paidSeats >= workshop.capacity;

    updateBooking(booking.id, {
      payment_status: 'Paid',
      paid_at: new Date().toISOString(),
      val_id: check.details.val_id || null,
      bank_tran_id: check.details.bank_tran_id || null,
      card_type: check.details.card_type || null,
      payment_note: oversold ? 'Paid, but capacity was already reached — needs admin review.' : null,
      gateway_response: JSON.stringify({ callback: payload, verification: check.raw }),
    });
    payments.logEvent(booking.id, 'payment.paid', check.details.bank_tran_id, check.raw);

    const updated = getBookingById(booking.id);
    console.log(`[PAY] Payment verified for ${updated.tran_id} (${updated.card_type || 'unknown method'})`);
    await sendBookingConfirmation(updated);

    return res.redirect(`/booking/${updated.id}/confirmation?t=${updated.public_token}`);
  } catch (err) {
    // The verification call itself failed (network, credentials). We must not
    // trust the redirect on its own, so the booking stays Pending for an admin.
    console.error('[PAY] Verification request failed:', err.message);
    updateBooking(booking.id, {
      payment_note: `Awaiting verification — the check could not be completed: ${err.message}`,
      val_id: payload.val_id || null,
      gateway_response: rawResponse,
    });
    payments.logEvent(booking.id, 'payment.verification_error', err.message, payload);
    return res.redirect(`/booking/${booking.id}/payment-result?t=${booking.public_token}&pending=1`);
  }
}

function payloadOf(req) {
  return { ...req.query, ...req.body };
}

app.all('/payment/success', (req, res) => {
  const payload = payloadOf(req);
  return handleGatewayReturn(req, res, 'success', payload.tran_id ? getBookingByTranId(payload.tran_id) : null, payload);
});
app.all('/payment/fail', (req, res) => {
  const payload = payloadOf(req);
  return handleGatewayReturn(req, res, 'fail', payload.tran_id ? getBookingByTranId(payload.tran_id) : null, payload);
});
app.all('/payment/cancel', (req, res) => {
  const payload = payloadOf(req);
  return handleGatewayReturn(req, res, 'cancel', payload.tran_id ? getBookingByTranId(payload.tran_id) : null, payload);
});

// bKash returns to a single callbackURL and puts the result in ?status=
app.all('/payment/bkash/callback', (req, res) => {
  const payload = payloadOf(req);
  const booking = payload.paymentID ? getBookingByPaymentId(payload.paymentID) : null;
  const status = String(payload.status || '').toLowerCase();
  const outcome = status === 'cancel' ? 'cancel' : status === 'failure' ? 'fail' : 'success';
  return handleGatewayReturn(req, res, outcome, booking, payload);
});

// Instant Payment Notification — server-to-server, no browser involved. Needs a
// publicly reachable BASE_URL (an ngrok tunnel, for example) to actually fire.
app.post('/payment/ipn', async (req, res) => {
  const payload = req.body || {};
  const booking = payload.tran_id
    ? getBookingByTranId(payload.tran_id)
    : payload.paymentID
      ? getBookingByPaymentId(payload.paymentID)
      : null;

  if (!booking) return res.status(404).send('Unknown transaction');

  console.log(`[IPN] ${payload.tran_id || payload.paymentID} status=${payload.status}`);
  payments.logEvent(booking.id, 'payment.ipn', payload.status, payload);

  if (booking.payment_status === 'Paid') return res.send('Already processed');

  try {
    const check = await payments.verify({ booking, payload });
    if (check.ok) {
      updateBooking(booking.id, {
        payment_status: 'Paid',
        paid_at: new Date().toISOString(),
        val_id: check.details.val_id || null,
        bank_tran_id: check.details.bank_tran_id || null,
        card_type: check.details.card_type || null,
        payment_note: 'Confirmed via IPN.',
        gateway_response: JSON.stringify({ ipn: payload, verification: check.raw }),
      });
      payments.logEvent(booking.id, 'payment.paid', 'via IPN', check.raw);
      await sendBookingConfirmation(getBookingById(booking.id));
    } else {
      updateBooking(booking.id, {
        payment_status: 'Failed',
        payment_note: `IPN verification failed — ${check.reason}`,
        gateway_response: JSON.stringify({ ipn: payload, verification: check.raw }),
      });
      payments.logEvent(booking.id, 'payment.verification_failed', check.reason, check.raw);
    }
  } catch (err) {
    console.error('[IPN] Verification failed:', err.message);
    return res.status(500).send('Validation error');
  }

  res.send('OK');
});

// ============================================================================
// RESULT PAGES
// ============================================================================
app.get('/booking/:bookingId/payment-result', (req, res) => {
  const booking = getBookingById(req.params.bookingId);
  if (!authorizeBooking(req, booking)) return requireLogin(req, res, () => res.redirect('/my-bookings'));

  res.render('payment-result', {
    booking,
    outcome: req.query.pending === '1' ? 'pending' : booking.payment_status.toLowerCase(),
    reason: booking.payment_note,
    title: 'Payment result',
  });
});

app.get('/booking/:bookingId/confirmation', (req, res) => {
  const booking = getBookingById(req.params.bookingId);
  if (!authorizeBooking(req, booking)) return requireLogin(req, res, () => res.redirect('/my-bookings'));
  res.render('confirmation', { booking, title: 'Booking confirmation' });
});

/** Printable receipt — the browser's own "Save as PDF" turns this into a PDF. */
app.get('/booking/:bookingId/receipt', (req, res) => {
  const booking = getBookingById(req.params.bookingId);
  if (!authorizeBooking(req, booking)) return requireLogin(req, res, () => res.redirect('/my-bookings'));
  res.render('receipt', { booking, title: `Receipt ${booking.tran_id}` });
});

// ============================================================================
// MY BOOKINGS
// ============================================================================
app.get('/my-bookings', requireLogin, (req, res) => {
  releaseExpiredHolds();
  const bookings = db.prepare(`${BOOKING_SELECT} WHERE b.user_id = ? ORDER BY b.created_at DESC`).all(req.session.user.id);

  const summary = {
    total: bookings.length,
    paid: bookings.filter((b) => b.payment_status === 'Paid').length,
    pending: bookings.filter((b) => b.payment_status === 'Pending').length,
    spent: bookings.filter((b) => b.payment_status === 'Paid').reduce((sum, b) => sum + Number(b.amount || 0), 0),
  };

  res.render('my-bookings', { bookings, summary, title: 'Your bookings' });
});

app.post('/booking/:bookingId/release', requireLogin, async (req, res) => {
  const booking = getBookingById(req.params.bookingId);
  if (!booking || booking.user_id !== req.session.user.id) {
    req.flash('error', 'Booking not found.');
    return res.redirect('/my-bookings');
  }
  if (booking.payment_status !== 'Pending') {
    req.flash('error', 'Only unpaid bookings can be cancelled here. Contact us about a paid booking.');
    return res.redirect('/my-bookings');
  }

  updateBooking(booking.id, {
    payment_status: 'Cancelled',
    payment_note: 'Cancelled by the customer before payment.',
  });
  payments.logEvent(booking.id, 'booking.cancelled', 'Customer released the seat');

  await mailer.sendMail(
    mailer.bookingCancelled({
      booking: getBookingById(booking.id),
      formatDate: helpers.formatDate,
      reason: 'You cancelled this booking before payment, so the seat has been released.',
    })
  );

  req.flash('success', 'Booking cancelled — the seat has been released.');
  res.redirect('/my-bookings');
});

// ============================================================================
// ADMIN
// ============================================================================
function adminBookingQuery(filters) {
  let sql = `
    SELECT b.*, u.name AS user_name, u.email AS user_email,
           w.title, w.workshop_date, w.capacity
      FROM bookings b
      JOIN users u ON u.id = b.user_id
      JOIN workshops w ON w.id = b.workshop_id
     WHERE 1 = 1`;
  const params = [];

  if (filters.workshop_id) {
    sql += ' AND w.id = ?';
    params.push(filters.workshop_id);
  }
  if (filters.date) {
    sql += ' AND w.workshop_date = ?';
    params.push(filters.date);
  }
  if (filters.status) {
    sql += ' AND b.payment_status = ?';
    params.push(filters.status);
  }
  if (filters.from) {
    sql += ' AND w.workshop_date >= ?';
    params.push(filters.from);
  }
  if (filters.to) {
    sql += ' AND w.workshop_date <= ?';
    params.push(filters.to);
  }
  if (filters.q) {
    sql += ' AND (b.attendee_name LIKE ? OR b.attendee_email LIKE ? OR b.tran_id LIKE ? OR u.name LIKE ? OR b.attendee_company LIKE ?)';
    const like = `%${filters.q}%`;
    params.push(like, like, like, like, like);
  }
  sql += ' ORDER BY b.created_at DESC';
  return db.prepare(sql).all(...params);
}

function readFilters(req) {
  return {
    workshop_id: req.query.workshop_id || '',
    date: req.query.date || '',
    status: req.query.status || '',
    from: req.query.from || '',
    to: req.query.to || '',
    q: (req.query.q || '').trim(),
  };
}

app.get('/admin/dashboard', requireAdmin, (req, res) => {
  const released = releaseExpiredHolds();
  if (released) console.log(`[CAPACITY] Released ${released} expired seat hold(s).`);

  const filters = readFilters(req);
  const bookings = adminBookingQuery(filters);
  const workshops = db.prepare(`${WORKSHOP_SELECT} ORDER BY w.workshop_date`).all();

  const eois = db
    .prepare(
      `SELECT e.*, w.title AS workshop_title
         FROM eoi_submissions e
         LEFT JOIN workshops w ON w.id = e.workshop_id
        ORDER BY e.created_at DESC`
    )
    .all();

  const stats = {
    totalBookings: db.prepare('SELECT COUNT(*) AS c FROM bookings').get().c,
    paidBookings: db.prepare("SELECT COUNT(*) AS c FROM bookings WHERE payment_status = 'Paid'").get().c,
    pendingBookings: db.prepare("SELECT COUNT(*) AS c FROM bookings WHERE payment_status = 'Pending'").get().c,
    failedBookings: db.prepare("SELECT COUNT(*) AS c FROM bookings WHERE payment_status IN ('Failed','Cancelled','Expired')").get().c,
    revenue: db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM bookings WHERE payment_status = 'Paid'").get().s,
    eoiCount: db.prepare('SELECT COUNT(*) AS c FROM eoi_submissions').get().c,
    newEoi: db.prepare("SELECT COUNT(*) AS c FROM eoi_submissions WHERE status = 'New'").get().c,
    users: db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'user'").get().c,
    activeWorkshops: db.prepare("SELECT COUNT(*) AS c FROM workshops WHERE status = 'active'").get().c,
  };

  // Conversion: paid bookings as a share of every booking ever started.
  stats.conversion = stats.totalBookings ? Math.round((stats.paidBookings / stats.totalBookings) * 100) : 0;

  const workshopDates = db.prepare('SELECT DISTINCT workshop_date FROM workshops ORDER BY workshop_date').all().map((r) => r.workshop_date);

  res.render('admin-dashboard', {
    bookings,
    workshops,
    workshopDates,
    eois,
    stats,
    filters,
    tab: req.query.tab || 'bookings',
    title: 'Admin dashboard',
  });
});

app.get('/admin/bookings/:id', requireAdmin, (req, res) => {
  const booking = db
    .prepare(
      `SELECT b.*, u.name AS user_name, u.email AS user_email, u.phone AS user_phone,
              w.title, w.workshop_date, w.capacity, w.location, w.instructor, w.start_time, w.end_time
         FROM bookings b
         JOIN users u ON u.id = b.user_id
         JOIN workshops w ON w.id = b.workshop_id
        WHERE b.id = ?`
    )
    .get(req.params.id);

  if (!booking) return res.status(404).render('error', { code: 404, message: 'Booking not found.', title: 'Not found' });

  res.render('admin-booking-detail', {
    booking,
    events: payments.eventsFor(booking.id),
    title: `Booking #${booking.id}`,
  });
});

app.get('/admin/bookings.csv', requireAdmin, (req, res) => {
  const rows = adminBookingQuery(readFilters(req));

  const header = [
    'Booking ID', 'Transaction ID', 'Attendee', 'Email', 'Phone', 'Company',
    'Workshop', 'Date', 'Amount', 'Currency', 'Payment Status', 'Gateway',
    'Bank Transaction ID', 'Paid At', 'Booked At',
  ];
  const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [
    header.join(','),
    ...rows.map((b) =>
      [
        b.id, b.tran_id, b.attendee_name || b.user_name, b.attendee_email || b.user_email,
        b.attendee_phone, b.attendee_company, b.title, b.workshop_date, b.amount,
        b.currency, b.payment_status, b.gateway, b.bank_tran_id, b.paid_at, b.created_at,
      ]
        .map(escape)
        .join(',')
    ),
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="workshop-registrations.csv"');
  res.send('\uFEFF' + csv); // BOM so Excel reads UTF-8 correctly
});

app.post('/admin/bookings/:id/status', requireAdmin, async (req, res) => {
  const allowed = ['Pending', 'Paid', 'Failed', 'Cancelled', 'Expired', 'Refunded'];
  const status = req.body.payment_status;
  if (!allowed.includes(status)) {
    req.flash('error', 'That is not a valid payment status.');
    return res.redirect('/admin/dashboard');
  }

  const booking = getBookingById(req.params.id);
  if (!booking) {
    req.flash('error', 'Booking not found.');
    return res.redirect('/admin/dashboard');
  }

  updateBooking(booking.id, {
    payment_status: status,
    payment_note: `Set to ${status} manually by ${req.session.user.email}`,
    paid_at: status === 'Paid' ? booking.paid_at || new Date().toISOString() : null,
    refunded_at: status === 'Refunded' ? new Date().toISOString() : null,
  });
  payments.logEvent(booking.id, 'admin.status_change', `${booking.payment_status} → ${status} by ${req.session.user.email}`);

  req.flash('success', `Booking #${booking.id} marked as ${status}.`);
  res.redirect(req.get('Referer') || '/admin/dashboard');
});

app.post('/admin/bookings/:id/refund', requireAdmin, async (req, res) => {
  const booking = getBookingById(req.params.id);
  if (!booking || booking.payment_status !== 'Paid') {
    req.flash('error', 'Only a paid booking can be refunded.');
    return res.redirect('/admin/dashboard');
  }

  let note = 'Refunded manually by an administrator.';
  try {
    const result = await payments.refund({ booking });
    note = result.ok ? `Refunded via ${payments.active.label}${result.refundId ? ` (${result.refundId})` : ''}` : `Gateway refund unavailable: ${result.reason}`;
  } catch (err) {
    note = `Gateway refund failed (${err.message}) — recorded as refunded manually.`;
  }

  updateBooking(booking.id, {
    payment_status: 'Refunded',
    refunded_at: new Date().toISOString(),
    payment_note: note,
  });
  payments.logEvent(booking.id, 'admin.refund', note);

  await mailer.sendMail(
    mailer.bookingCancelled({
      booking: getBookingById(booking.id),
      formatDate: helpers.formatDate,
      reason: 'Your booking has been refunded. The seat has been released.',
    })
  );

  req.flash('success', `Booking #${booking.id} refunded. ${note}`);
  res.redirect(req.get('Referer') || '/admin/dashboard');
});

// ---------- EOI management ----------
app.post('/admin/eoi/:id/status', requireAdmin, (req, res) => {
  const allowed = ['New', 'Contacted', 'Converted', 'Closed'];
  if (!allowed.includes(req.body.status)) {
    req.flash('error', 'That is not a valid status.');
    return res.redirect('/admin/dashboard?tab=eoi');
  }
  db.prepare('UPDATE eoi_submissions SET status = ?, handled_by = ?, handled_at = CURRENT_TIMESTAMP WHERE id = ?').run(
    req.body.status,
    req.session.user.email,
    req.params.id
  );
  req.flash('success', `Enquiry #${req.params.id} marked as ${req.body.status}.`);
  res.redirect(req.get('Referer') || '/admin/dashboard?tab=eoi');
});

app.get('/admin/eoi.csv', requireAdmin, (req, res) => {
  const rows = db
    .prepare(
      `SELECT e.*, w.title AS workshop_title FROM eoi_submissions e
         LEFT JOIN workshops w ON w.id = e.workshop_id ORDER BY e.created_at DESC`
    )
    .all();
  const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [
    ['ID', 'Name', 'Company', 'Email', 'Phone', 'Workshop', 'Message', 'Status', 'Submitted'].join(','),
    ...rows.map((r) =>
      [r.id, r.name, r.company, r.email, r.phone, r.workshop_title, r.message, r.status, r.created_at].map(escape).join(',')
    ),
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="expressions-of-interest.csv"');
  res.send('\uFEFF' + csv);
});

// ---------- Workshop CRUD ----------
app.get('/admin/workshops/new', requireAdmin, (req, res) => {
  res.render('admin-workshop-form', { workshop: null, title: 'New workshop' });
});

function readWorkshopForm(body) {
  return {
    title: (body.title || '').trim(),
    description: body.description || '',
    workshop_date: body.workshop_date || '',
    capacity: Number(body.capacity),
    price: Number(body.price),
    location: body.location || '',
    instructor: body.instructor || '',
    start_time: body.start_time || '',
    end_time: body.end_time || '',
    level: body.level || '',
  };
}

function validateWorkshop(data) {
  if (!data.title) return 'A title is required.';
  if (!data.workshop_date) return 'A date is required.';
  if (!Number.isFinite(data.capacity) || data.capacity < 1) return 'Capacity must be at least 1.';
  if (!Number.isFinite(data.price) || data.price < 0) return 'Price must be zero or more.';
  if (data.start_time && data.end_time && data.end_time <= data.start_time) return 'The end time must be after the start time.';
  return null;
}

app.post('/admin/workshops/new', requireAdmin, (req, res) => {
  const data = readWorkshopForm(req.body);
  const problem = validateWorkshop(data);
  if (problem) {
    req.flash('error', problem);
    return res.render('admin-workshop-form', { workshop: { ...data, id: null }, title: 'New workshop' });
  }

  db.prepare(
    `INSERT INTO workshops (title, description, workshop_date, capacity, price, location, instructor, start_time, end_time, level, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
  ).run(
    data.title, data.description, data.workshop_date, data.capacity, data.price,
    data.location, data.instructor, data.start_time, data.end_time, data.level
  );

  req.flash('success', `"${data.title}" has been published.`);
  res.redirect('/admin/dashboard?tab=workshops');
});

app.get('/admin/workshops/:id/edit', requireAdmin, (req, res) => {
  const workshop = getWorkshop(req.params.id);
  if (!workshop) return res.redirect('/admin/dashboard?tab=workshops');
  res.render('admin-workshop-form', { workshop, title: `Edit: ${workshop.title}` });
});

app.post('/admin/workshops/:id/edit', requireAdmin, (req, res) => {
  const workshop = getWorkshop(req.params.id);
  if (!workshop) return res.redirect('/admin/dashboard?tab=workshops');

  const data = readWorkshopForm(req.body);
  const problem = validateWorkshop(data);
  if (problem) {
    req.flash('error', problem);
    return res.redirect(`/admin/workshops/${workshop.id}/edit`);
  }

  // Capacity can never be cut below the seats already committed, or the
  // remaining-seat count would go negative and the listing would lie.
  const taken = seatsTaken(workshop.id);
  if (data.capacity < taken) {
    req.flash('error', `Capacity cannot go below the ${taken} seat(s) already booked.`);
    return res.redirect(`/admin/workshops/${workshop.id}/edit`);
  }

  db.prepare(
    `UPDATE workshops SET title = ?, description = ?, workshop_date = ?, capacity = ?, price = ?,
            location = ?, instructor = ?, start_time = ?, end_time = ?, level = ?
      WHERE id = ?`
  ).run(
    data.title, data.description, data.workshop_date, data.capacity, data.price,
    data.location, data.instructor, data.start_time, data.end_time, data.level, workshop.id
  );

  req.flash('success', `"${data.title}" updated.`);
  res.redirect('/admin/dashboard?tab=workshops');
});

app.post('/admin/workshops/:id/cancel', requireAdmin, async (req, res) => {
  const workshop = getWorkshop(req.params.id);
  if (!workshop) return res.redirect('/admin/dashboard?tab=workshops');

  db.prepare("UPDATE workshops SET status = 'cancelled' WHERE id = ?").run(workshop.id);

  // Everyone holding a seat needs to be told, not just quietly dropped.
  const affected = db.prepare(`${BOOKING_SELECT} WHERE b.workshop_id = ? AND b.payment_status IN ${HOLDING}`).all(workshop.id);
  for (const booking of affected) {
    await mailer.sendMail(mailer.workshopCancelled({ booking, formatDate: helpers.formatDate }));
    payments.logEvent(booking.id, 'workshop.cancelled', 'Organiser cancelled the workshop');
  }

  req.flash('success', `"${workshop.title}" cancelled and pulled from the public listing. ${affected.length} attendee(s) notified.`);
  res.redirect('/admin/dashboard?tab=workshops');
});

app.post('/admin/workshops/:id/reactivate', requireAdmin, (req, res) => {
  db.prepare("UPDATE workshops SET status = 'active' WHERE id = ?").run(req.params.id);
  req.flash('success', 'Workshop re-activated and back on the public listing.');
  res.redirect('/admin/dashboard?tab=workshops');
});

app.get('/admin/workshops/:id/attendees.csv', requireAdmin, (req, res) => {
  const workshop = getWorkshop(req.params.id);
  if (!workshop) return res.redirect('/admin/dashboard?tab=workshops');

  const rows = db
    .prepare(`SELECT * FROM bookings WHERE workshop_id = ? AND payment_status IN ${HOLDING} ORDER BY attendee_name`)
    .all(workshop.id);

  const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [
    ['Attendee', 'Email', 'Phone', 'Company', 'Payment Status', 'Reference', 'Notes'].join(','),
    ...rows.map((b) =>
      [b.attendee_name, b.attendee_email, b.attendee_phone, b.attendee_company, b.payment_status, b.tran_id, b.attendee_notes]
        .map(escape)
        .join(',')
    ),
  ].join('\n');

  const slug = workshop.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="attendees-${slug}-${workshop.workshop_date}.csv"`);
  res.send('\uFEFF' + csv);
});

// ============================================================================
// HEALTH + ERRORS
// ============================================================================
app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    gateway: payments.activeName,
    driver: require('./sqlite').driverName,
    time: new Date().toISOString(),
  });
});

app.use((req, res) => {
  res.status(404).render('error', { code: 404, message: 'We could not find that page.', title: 'Not found' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { code: 500, message: 'Something went wrong on our side. Please try again.', title: 'Error' });
});

// ============================================================================
// BOOT
// ============================================================================
if (require.main === module) {
  app.listen(config.port, () => {
    const info = payments.describe();
    console.log(`\n  ${config.brand.name}`);
    console.log(`  ${'─'.repeat(52)}`);
    console.log(`  URL        ${config.baseUrl}  (port ${config.port})`);
    console.log(`  Database   ${require('./sqlite').driverName}`);
    console.log(`  Payments   ${info.label}${info.isSandbox ? '  (no credentials needed)' : ''}`);
    if (info.fellBack) {
      console.log(`\n  ! PAYMENT_GATEWAY=${info.requested} was requested but is not configured.`);
      console.log(`    ${info.fallbackReason}`);
      console.log(`    Falling back to the built-in sandbox gateway so booking still works.`);
    }
    console.log(`  Email      ${config.mail.host ? `SMTP ${config.mail.host}` : 'console + data/outbox/ (no SMTP configured)'}`);
    console.log(`  Admin      admin@workshops.com / admin123`);
    console.log('');
  });
}

module.exports = app;
