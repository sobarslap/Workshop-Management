/**
 * End-to-end smoke test.
 *
 * Boots the real server, drives it over real HTTP with a cookie jar, and walks
 * every journey the milestone asks for: EOI, registration, login, booking,
 * capacity enforcement, payment (success / decline / cancel), confirmation,
 * admin CRUD and the password-reset flow.
 *
 * Run with:  npm run smoke
 *
 * It uses a throwaway database (data/smoke.db) so your real data is untouched.
 */
process.env.DB_FILE = 'smoke.db';
process.env.PAYMENT_GATEWAY = 'sandbox';
process.env.SANDBOX_LATENCY_MS = '0';
process.env.PORT = process.env.SMOKE_PORT || '3999';
process.env.BASE_URL = `http://localhost:${process.env.PORT}`;
process.env.SESSION_SECRET = 'smoke-test-secret';

const fs = require('fs');
const path = require('path');

const dbFile = path.join(__dirname, '..', 'data', 'smoke.db');
['', '-wal', '-shm'].forEach((suffix) => {
  const file = dbFile + suffix;
  if (fs.existsSync(file)) fs.unlinkSync(file);
});

const app = require('../server');
const BASE = process.env.BASE_URL;

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, extra) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed++;
    failures.push(label + (extra ? ` — ${extra}` : ''));
    console.log(`  \x1b[31m✗\x1b[0m ${label}${extra ? ` \x1b[2m(${extra})\x1b[0m` : ''}`);
  }
}

function section(name) {
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

/** A tiny cookie-jar-backed fetch so sessions survive between requests. */
function makeClient() {
  const jar = new Map();

  return async function client(pathname, options = {}) {
    const url = pathname.startsWith('http') ? pathname : BASE + pathname;
    const headers = { ...(options.headers || {}) };

    if (jar.size) {
      headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    }

    let body = options.body;
    if (body && typeof body === 'object' && !(body instanceof URLSearchParams)) {
      body = new URLSearchParams(body);
    }
    if (body) headers['content-type'] = 'application/x-www-form-urlencoded';

    const response = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body,
      redirect: 'manual',
    });

    (response.headers.getSetCookie?.() || []).forEach((raw) => {
      const [pair] = raw.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (!value || raw.includes('Expires=Thu, 01 Jan 1970')) jar.delete(name);
      else jar.set(name, value);
    });

    const location = response.headers.get('location');

    // Follow redirects manually so each hop can be asserted on.
    if (options.follow !== false && location && response.status >= 300 && response.status < 400) {
      return client(location, { follow: options.follow, _depth: (options._depth || 0) + 1 });
    }

    const text = await response.text();
    return { status: response.status, text, location, url };
  };
}

async function run() {
  const server = app.listen(process.env.PORT);
  await new Promise((resolve) => server.once('listening', resolve));

  const db = require('../db');
  const guest = makeClient();

  try {
    // ================= PUBLIC PAGES =================
    section('Public pages');
    for (const [label, route] of [
      ['Home page renders', '/'],
      ['Workshop listing renders', '/workshops'],
      ['EOI form renders', '/eoi'],
      ['Login page renders', '/login'],
      ['Register page renders', '/register'],
      ['Forgot-password page renders', '/forgot-password'],
    ]) {
      const res = await guest(route);
      check(label, res.status === 200, `status ${res.status}`);
    }

    const notFound = await guest('/this-does-not-exist');
    check('Unknown route returns 404', notFound.status === 404, `status ${notFound.status}`);

    const health = await guest('/healthz');
    check('Health endpoint responds', health.status === 200 && health.text.includes('sandbox'));

    // ================= FEATURE 1 + 2: EOI =================
    section('Feature 1 & 2 — Expression of interest + acknowledgment');
    const workshop = db.prepare("SELECT * FROM workshops WHERE status = 'active' ORDER BY id LIMIT 1").get();

    const eoiRes = await guest('/eoi', {
      method: 'POST',
      body: {
        name: 'Nadia Islam',
        company: 'Acme Ltd',
        email: 'nadia@acme.test',
        phone: '01711111111',
        workshop_id: workshop.id,
        message: 'Interested in a group of 6.',
      },
    });
    check('EOI submission accepted', eoiRes.status === 200, `status ${eoiRes.status}`);
    check('EOI success page shown', eoiRes.text.includes('Thanks, Nadia'));

    const eoiRow = db.prepare('SELECT * FROM eoi_submissions WHERE email = ?').get('nadia@acme.test');
    check('EOI stored in database', Boolean(eoiRow));
    check('EOI linked to the chosen workshop', eoiRow && eoiRow.workshop_id === workshop.id);
    check('EOI starts with status "New"', eoiRow && eoiRow.status === 'New');

    const outbox = path.join(__dirname, '..', 'data', 'outbox');
    const ackSent = fs.existsSync(outbox) && fs.readdirSync(outbox).some((f) => f.includes('received-your-interest'));
    check('Automated acknowledgment email generated', ackSent);

    const eoiInvalid = await guest('/eoi', { method: 'POST', body: { name: 'X', email: '', workshop_id: '' } });
    check('EOI rejects missing required fields', eoiInvalid.text.includes('required'));

    // ================= FEATURE 4: REGISTRATION / LOGIN =================
    section('Feature 4 — Mandatory registration & login');
    const user = makeClient();

    const blocked = await user(`/book/${workshop.id}`, { follow: false });
    check('Booking blocked while logged out', blocked.status === 302 && blocked.location === '/login',
      `→ ${blocked.location}`);

    const weakPassword = await user('/register', {
      method: 'POST',
      body: { name: 'Test User', email: 'buyer@acme.test', password: 'abc', confirm_password: 'abc' },
    });
    check('Weak password rejected', weakPassword.text.includes('at least 8 characters'));

    const mismatch = await user('/register', {
      method: 'POST',
      body: { name: 'Test User', email: 'buyer@acme.test', password: 'goodpass1', confirm_password: 'otherpass1' },
    });
    check('Mismatched passwords rejected', mismatch.text.includes('do not match'));

    const registered = await user('/register', {
      method: 'POST',
      body: {
        name: 'Rafiq Ahmed',
        email: 'buyer@acme.test',
        phone: '01722222222',
        company: 'Acme Ltd',
        password: 'goodpass1',
        confirm_password: 'goodpass1',
        remember: '1',
      },
    });
    check('Registration succeeds', registered.status === 200);
    check('User is logged in after registering', registered.text.includes('Rafiq'));

    const duplicate = await makeClient()('/register', {
      method: 'POST',
      body: { name: 'Someone', email: 'buyer@acme.test', password: 'goodpass1', confirm_password: 'goodpass1' },
    });
    check('Duplicate email rejected', duplicate.text.includes('already exists'));

    const dbUser = db.prepare('SELECT * FROM users WHERE email = ?').get('buyer@acme.test');
    check('Password stored as a bcrypt hash', Boolean(dbUser) && dbUser.password_hash.startsWith('$2'));
    check('Password never stored in plain text', Boolean(dbUser) && !dbUser.password_hash.includes('goodpass1'));

    // ---- Login feature: remember me ----
    const remembered = db.prepare('SELECT * FROM remember_tokens WHERE user_id = ?').get(dbUser.id);
    check('Remember-me token issued', Boolean(remembered));
    check('Remember-me validator is hashed, not raw', Boolean(remembered) && remembered.validator_hash.length === 64);

    // ---- Login feature: throttle ----
    const attacker = makeClient();
    let lockMessage = '';
    for (let i = 0; i < 6; i++) {
      const res = await attacker('/login', {
        method: 'POST',
        body: { email: 'buyer@acme.test', password: 'wrong-password' },
      });
      lockMessage = res.text;
    }
    check('Account locks after repeated failed logins', lockMessage.includes('locked') || lockMessage.includes('Too many'));
    db.prepare('DELETE FROM login_attempts WHERE email = ?').run('buyer@acme.test');

    const goodLogin = await makeClient()('/login', {
      method: 'POST',
      body: { email: 'buyer@acme.test', password: 'goodpass1' },
    });
    check('Correct credentials log in', goodLogin.text.includes('Welcome back'));

    // ================= FEATURE 5: BOOKING FLOW =================
    section('Feature 5 — Booking flow');
    const bookForm = await user(`/book/${workshop.id}`);
    check('Booking form reachable when logged in', bookForm.status === 200 && bookForm.text.includes("Who's attending"));

    const booked = await user(`/book/${workshop.id}`, {
      method: 'POST',
      body: {
        attendee_name: 'Rafiq Ahmed',
        attendee_email: 'rafiq@acme.test',
        attendee_phone: '01722222222',
        attendee_company: 'Acme Ltd',
        attendee_notes: 'Vegetarian lunch',
      },
    });
    check('Booking created and lands on payment page', booked.status === 200 && booked.text.includes('Complete your payment'));

    const booking = db.prepare('SELECT * FROM bookings WHERE attendee_email = ?').get('rafiq@acme.test');
    check('Booking row created', Boolean(booking));
    check('Booking starts as Pending', booking && booking.payment_status === 'Pending');
    check('Booking has a unique transaction reference', booking && booking.tran_id.startsWith('CW-'));
    check('Attendee details snapshotted onto booking', booking && booking.attendee_notes === 'Vegetarian lunch');
    check('Amount copied from the workshop price', booking && Number(booking.amount) === Number(workshop.price));

    const duplicateBooking = await user(`/book/${workshop.id}`, { follow: false });
    check('Duplicate booking redirects to existing one',
      duplicateBooking.status === 302 && duplicateBooking.location.includes(`/booking/${booking.id}/pay`),
      `→ ${duplicateBooking.location}`);

    // ================= PAYMENT: SUCCESS =================
    section('Payment — successful path');
    const checkout = await user(`/booking/${booking.id}/checkout`, { method: 'POST', follow: false });
    check('Checkout redirects to the gateway',
      checkout.status === 302 && checkout.location.includes('/sandbox-gateway/'),
      `→ ${checkout.location}`);

    const sessionKey = checkout.location.split('/sandbox-gateway/')[1];
    const gatewayPage = await user(`/sandbox-gateway/${sessionKey}`);
    check('Hosted checkout page renders', gatewayPage.status === 200 && gatewayPage.text.includes('Sandbox Gateway'));

    const sessionRow = db.prepare('SELECT * FROM sandbox_sessions WHERE session_key = ?').get(sessionKey);
    check('Gateway session recorded', Boolean(sessionRow) && sessionRow.status === 'CREATED');
    check('Gateway session amount matches the booking',
      sessionRow && Number(sessionRow.amount) === Number(booking.amount));

    const paidResult = await user(`/sandbox-gateway/${sessionKey}`, {
      method: 'POST',
      body: { action: 'pay', method: 'bKash' },
    });
    check('Payment completes and shows confirmation', paidResult.text.includes('booked') && paidResult.text.includes(booking.tran_id));

    const paidBooking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(booking.id);
    check('Booking marked Paid', paidBooking.payment_status === 'Paid');
    check('paid_at timestamp recorded', Boolean(paidBooking.paid_at));
    check('Bank transaction id stored', Boolean(paidBooking.bank_tran_id));
    check('Payment method stored', paidBooking.card_type === 'bKash');
    check('Raw gateway response archived', Boolean(paidBooking.gateway_response));

    const events = db.prepare('SELECT * FROM payment_events WHERE booking_id = ?').all(booking.id);
    check('Payment audit trail written', events.length >= 3, `${events.length} events`);
    check('Audit trail contains a paid event', events.some((e) => e.event === 'payment.paid'));

    const confirmEmail = fs.readdirSync(outbox).some((f) => f.includes('confirmed'));
    check('Confirmation email generated', confirmEmail);

    const receipt = await user(`/booking/${booking.id}/receipt`);
    check('Printable receipt renders', receipt.status === 200 && receipt.text.includes('Receipt'));

    // ---- Tamper resistance ----
    section('Payment — verification & tamper resistance');
    const forged = await makeClient()(
      `/payment/success?tran_id=${encodeURIComponent(paidBooking.tran_id)}&val_id=TOTALLY-MADE-UP`,
      { follow: false }
    );
    check('Forged callback on a paid booking does not corrupt it',
      db.prepare('SELECT payment_status FROM bookings WHERE id = ?').get(booking.id).payment_status === 'Paid');

    // A brand-new booking hit with a forged success callback must NOT become paid.
    const victimClient = makeClient();
    await victimClient('/register', {
      method: 'POST',
      body: { name: 'Victim User', email: 'victim@acme.test', password: 'goodpass1', confirm_password: 'goodpass1' },
    });
    const otherWorkshop = db.prepare("SELECT * FROM workshops WHERE status = 'active' AND id <> ? LIMIT 1").get(workshop.id);
    await victimClient(`/book/${otherWorkshop.id}`, {
      method: 'POST',
      body: { attendee_name: 'Victim User', attendee_email: 'victim@acme.test' },
    });
    const victimBooking = db.prepare('SELECT * FROM bookings WHERE attendee_email = ?').get('victim@acme.test');
    await makeClient()(
      `/payment/success?tran_id=${encodeURIComponent(victimBooking.tran_id)}&val_id=FORGED-VAL-ID`,
      { follow: false }
    );
    const afterForge = db.prepare('SELECT * FROM bookings WHERE id = ?').get(victimBooking.id);
    check('Forged success callback is rejected, not trusted',
      afterForge.payment_status !== 'Paid', `status became ${afterForge.payment_status}`);
    check('Rejection reason recorded', Boolean(afterForge.payment_note));

    // ================= PAYMENT: DECLINE + CANCEL =================
    section('Payment — decline and cancel paths');
    const declineClient = makeClient();
    await declineClient('/register', {
      method: 'POST',
      body: { name: 'Decline Tester', email: 'decline@acme.test', password: 'goodpass1', confirm_password: 'goodpass1' },
    });
    await declineClient(`/book/${otherWorkshop.id}`, {
      method: 'POST',
      body: { attendee_name: 'Decline Tester', attendee_email: 'decline@acme.test' },
    });
    const declineBooking = db.prepare('SELECT * FROM bookings WHERE attendee_email = ?').get('decline@acme.test');
    const declineCheckout = await declineClient(`/booking/${declineBooking.id}/checkout`, { method: 'POST', follow: false });
    const declineKey = declineCheckout.location.split('/sandbox-gateway/')[1];
    const declined = await declineClient(`/sandbox-gateway/${declineKey}`, { method: 'POST', body: { action: 'fail' } });
    check('Declined payment shows a failure page', declined.text.includes('did not go through'));
    check('Declined booking marked Failed',
      db.prepare('SELECT payment_status FROM bookings WHERE id = ?').get(declineBooking.id).payment_status === 'Failed');

    const retry = await declineClient(`/booking/${declineBooking.id}/checkout`, { method: 'POST', follow: false });
    check('Failed payment can be retried', retry.status === 302 && retry.location.includes('/sandbox-gateway/'));
    const retriedBooking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(declineBooking.id);
    check('Retry issues a fresh transaction id', retriedBooking.tran_id !== declineBooking.tran_id);

    const cancelKey = retry.location.split('/sandbox-gateway/')[1];
    const cancelled = await declineClient(`/sandbox-gateway/${cancelKey}`, { method: 'POST', body: { action: 'cancel' } });
    check('Cancelled payment shows a cancellation page', cancelled.text.includes('cancelled'));
    check('Cancelled booking marked Cancelled',
      db.prepare('SELECT payment_status FROM bookings WHERE id = ?').get(declineBooking.id).payment_status === 'Cancelled');

    // ================= FEATURE 6: CAPACITY =================
    section('Feature 6 — Capacity enforcement');
    const tiny = db
      .prepare(
        `INSERT INTO workshops (title, description, workshop_date, capacity, price, status)
         VALUES ('Capacity Test', 'Two seats only.', date('now', '+40 days'), 2, 100, 'active')`
      )
      .run();
    const tinyId = Number(tiny.lastInsertRowid);

    const seatTakers = [];
    for (let i = 1; i <= 3; i++) {
      const c = makeClient();
      await c('/register', {
        method: 'POST',
        body: {
          name: `Seat Tester ${i}`,
          email: `seat${i}@acme.test`,
          password: 'goodpass1',
          confirm_password: 'goodpass1',
        },
      });
      seatTakers.push(c);
    }

    const first = await seatTakers[0](`/book/${tinyId}`, {
      method: 'POST',
      body: { attendee_name: 'Seat One', attendee_email: 'seat1@acme.test' },
    });
    check('First seat books successfully', first.text.includes('Complete your payment'));

    const second = await seatTakers[1](`/book/${tinyId}`, {
      method: 'POST',
      body: { attendee_name: 'Seat Two', attendee_email: 'seat2@acme.test' },
    });
    check('Second seat books successfully', second.text.includes('Complete your payment'));

    const third = await seatTakers[2](`/book/${tinyId}`, {
      method: 'POST',
      body: { attendee_name: 'Seat Three', attendee_email: 'seat3@acme.test' },
    });
    check('Third booking blocked once capacity is reached',
      third.text.includes('filled up') || third.text.includes('fully booked'));

    const heldSeats = db
      .prepare("SELECT COUNT(*) AS c FROM bookings WHERE workshop_id = ? AND payment_status IN ('Pending','Paid')")
      .get(tinyId).c;
    check('Never oversold beyond capacity', heldSeats === 2, `${heldSeats} seats held on a 2-seat workshop`);

    const listing = await guest('/workshops');
    check('Full workshop shows as fully booked on the listing', listing.text.includes('Fully booked'));

    // Concurrency: five simultaneous attempts on one remaining seat.
    const raceWorkshop = db
      .prepare(
        `INSERT INTO workshops (title, description, workshop_date, capacity, price, status)
         VALUES ('Race Test', 'One seat.', date('now', '+41 days'), 1, 100, 'active')`
      )
      .run();
    const raceId = Number(raceWorkshop.lastInsertRowid);

    const racers = [];
    for (let i = 1; i <= 5; i++) {
      const c = makeClient();
      await c('/register', {
        method: 'POST',
        body: { name: `Racer ${i}`, email: `race${i}@acme.test`, password: 'goodpass1', confirm_password: 'goodpass1' },
      });
      racers.push(c);
    }
    await Promise.all(
      racers.map((c, i) =>
        c(`/book/${raceId}`, {
          method: 'POST',
          body: { attendee_name: `Racer ${i + 1}`, attendee_email: `race${i + 1}@acme.test` },
        }).catch(() => null)
      )
    );
    const raceSeats = db
      .prepare("SELECT COUNT(*) AS c FROM bookings WHERE workshop_id = ? AND payment_status IN ('Pending','Paid')")
      .get(raceId).c;
    check('Concurrent race for the last seat yields exactly one winner', raceSeats === 1, `${raceSeats} winners`);

    // ---- Seat hold expiry ----
    db.prepare("UPDATE bookings SET created_at = datetime('now', '-120 minutes') WHERE workshop_id = ? AND payment_status = 'Pending'")
      .run(tinyId);
    await guest('/workshops');
    const afterExpiry = db
      .prepare("SELECT COUNT(*) AS c FROM bookings WHERE workshop_id = ? AND payment_status = 'Expired'")
      .get(tinyId).c;
    check('Stale unpaid holds expire and release their seats', afterExpiry > 0, `${afterExpiry} expired`);

    // ================= MY BOOKINGS =================
    section('Customer account');
    const myBookings = await user('/my-bookings');
    check('My-bookings page lists the booking', myBookings.status === 200 && myBookings.text.includes(workshop.title));

    const account = await user('/account');
    check('Account page renders', account.status === 200 && account.text.includes('Remembered devices'));

    const profileUpdate = await user('/account', {
      method: 'POST',
      body: { name: 'Rafiq A. Ahmed', phone: '01799999999', company: 'Acme Group' },
    });
    check('Profile update saves', profileUpdate.text.includes('Profile updated'));

    // Ownership: another user must not see this booking.
    const nosey = makeClient();
    await nosey('/register', {
      method: 'POST',
      body: { name: 'Nosey Parker', email: 'nosey@acme.test', password: 'goodpass1', confirm_password: 'goodpass1' },
    });
    const peek = await nosey(`/booking/${booking.id}/confirmation`, { follow: false });
    check("Other users cannot open someone else's booking",
      peek.status === 302 && peek.location.includes('my-bookings'), `→ ${peek.location}`);

    const tokenAccess = await makeClient()(`/booking/${booking.id}/confirmation?t=${paidBooking.public_token}`);
    check('Public token grants access after a gateway redirect', tokenAccess.status === 200 && tokenAccess.text.includes(paidBooking.tran_id));

    // ================= PASSWORD RESET =================
    section('Login feature — password reset');
    const resetClient = makeClient();
    const requested = await resetClient('/forgot-password', { method: 'POST', body: { email: 'buyer@acme.test' } });
    check('Reset request accepted', requested.text.includes('Check your inbox'));

    const unknownEmail = await makeClient()('/forgot-password', {
      method: 'POST',
      body: { email: 'nobody-here@nowhere.test' },
    });
    check('Unknown email gives an identical response (no account enumeration)',
      unknownEmail.text.includes('Check your inbox'));

    const resetRow = db.prepare('SELECT * FROM password_resets WHERE user_id = ?').get(dbUser.id);
    check('Reset token stored', Boolean(resetRow));
    check('Reset token stored hashed, not raw', Boolean(resetRow) && resetRow.token_hash.length === 64);

    // Pull the real token out of the generated email.
    const resetEmail = fs
      .readdirSync(outbox)
      .filter((f) => f.includes('reset'))
      .sort()
      .pop();
    const resetHtml = fs.readFileSync(path.join(outbox, resetEmail), 'utf8');
    const tokenMatch = resetHtml.match(/reset-password\/([a-f0-9]{64})/);
    check('Reset link present in the email', Boolean(tokenMatch));

    if (tokenMatch) {
      const token = tokenMatch[1];
      const resetPage = await makeClient()(`/reset-password/${token}`);
      check('Reset page opens with a valid token', resetPage.status === 200 && resetPage.text.includes('Set a new password'));

      const changed = await makeClient()(`/reset-password/${token}`, {
        method: 'POST',
        body: { password: 'brandnew99', confirm_password: 'brandnew99' },
      });
      check('Password successfully changed', changed.text.includes('has been changed'));

      const reuse = await makeClient()(`/reset-password/${token}`);
      check('Reset token cannot be reused', reuse.status === 400);

      const newLogin = await makeClient()('/login', {
        method: 'POST',
        body: { email: 'buyer@acme.test', password: 'brandnew99' },
      });
      check('New password works at login', newLogin.text.includes('Welcome back'));

      const oldLogin = await makeClient()('/login', {
        method: 'POST',
        body: { email: 'buyer@acme.test', password: 'goodpass1' },
      });
      check('Old password no longer works', oldLogin.text.includes('Invalid email or password'));

      const devicesLeft = db.prepare('SELECT COUNT(*) AS c FROM remember_tokens WHERE user_id = ?').get(dbUser.id).c;
      check('Reset signs out all remembered devices', devicesLeft === 0, `${devicesLeft} left`);
    }

    const badToken = await makeClient()('/reset-password/deadbeef');
    check('Invalid reset token rejected', badToken.status === 400);

    // ================= ADMIN =================
    section('Features 9 & 10 — Admin dashboard and workshop CRUD');
    const anon = await makeClient()('/admin/dashboard', { follow: false });
    check('Admin area blocked for logged-out visitors',
      anon.status === 302 && anon.location === '/login', `→ ${anon.location}`);

    const nonAdmin = await user('/admin/dashboard');
    check('Admin area blocked for normal users', nonAdmin.status === 403, `status ${nonAdmin.status}`);

    const admin = makeClient();
    const adminLogin = await admin('/login', {
      method: 'POST',
      body: { email: 'admin@workshops.com', password: 'admin123' },
    });
    check('Admin can log in', adminLogin.text.includes('Dashboard'));

    const dash = await admin('/admin/dashboard');
    check('Dashboard shows registrations', dash.status === 200 && dash.text.includes('Rafiq'));
    check('Dashboard shows revenue', dash.text.includes('Revenue collected'));

    const filtered = await admin(`/admin/dashboard?tab=bookings&status=Paid`);
    check('Filter by payment status works', filtered.status === 200 && filtered.text.includes('Paid'));

    const byWorkshop = await admin(`/admin/dashboard?tab=bookings&workshop_id=${workshop.id}`);
    check('Filter by workshop works', byWorkshop.status === 200);

    const byDate = await admin(`/admin/dashboard?tab=bookings&date=${workshop.workshop_date}`);
    check('Filter by date works', byDate.status === 200);

    const search = await admin('/admin/dashboard?tab=bookings&q=Rafiq');
    check('Search finds an attendee', search.text.includes('Rafiq'));

    const csv = await admin('/admin/bookings.csv');
    check('Registrations CSV exports', csv.status === 200 && csv.text.includes('Booking ID'));

    const eoiTab = await admin('/admin/dashboard?tab=eoi');
    check('Enquiries tab lists the EOI', eoiTab.text.includes('nadia@acme.test'));

    const eoiStatus = await admin(`/admin/eoi/${eoiRow.id}/status`, { method: 'POST', body: { status: 'Contacted' } });
    check('EOI status can be updated',
      db.prepare('SELECT status FROM eoi_submissions WHERE id = ?').get(eoiRow.id).status === 'Contacted');

    const eoiCsv = await admin('/admin/eoi.csv');
    check('Enquiries CSV exports', eoiCsv.status === 200 && eoiCsv.text.includes('Name'));

    const detail = await admin(`/admin/bookings/${booking.id}`);
    check('Booking detail page renders', detail.status === 200 && detail.text.includes('Audit trail'));

    // ---- Workshop CRUD ----
    const newForm = await admin('/admin/workshops/new');
    check('New-workshop form renders', newForm.status === 200);

    const created = await admin('/admin/workshops/new', {
      method: 'POST',
      body: {
        title: 'Smoke Test Workshop',
        description: 'Created by the automated smoke test.',
        workshop_date: '2027-03-15',
        capacity: '12',
        price: '5500',
        location: 'Dhaka',
        instructor: 'Test Instructor',
        start_time: '09:00',
        end_time: '17:00',
        level: 'Beginner',
      },
    });
    check('Workshop created', created.text.includes('has been published'));

    const createdRow = db.prepare('SELECT * FROM workshops WHERE title = ?').get('Smoke Test Workshop');
    check('New workshop stored with all fields',
      Boolean(createdRow) && createdRow.capacity === 12 && createdRow.instructor === 'Test Instructor');

    const invalidWorkshop = await admin('/admin/workshops/new', {
      method: 'POST',
      body: { title: '', workshop_date: '2027-01-01', capacity: '5', price: '100' },
    });
    check('Workshop validation rejects a missing title', invalidWorkshop.text.includes('title is required'));

    const badTimes = await admin('/admin/workshops/new', {
      method: 'POST',
      body: { title: 'Bad Times', workshop_date: '2027-01-01', capacity: '5', price: '100', start_time: '17:00', end_time: '09:00' },
    });
    check('Workshop validation rejects end time before start time', badTimes.text.includes('end time must be after'));

    const edited = await admin(`/admin/workshops/${createdRow.id}/edit`, {
      method: 'POST',
      body: {
        title: 'Smoke Test Workshop (Edited)',
        description: 'Updated.',
        workshop_date: '2027-03-16',
        capacity: '15',
        price: '6000',
        location: 'Dhaka',
        instructor: 'Test Instructor',
        level: 'Intermediate',
      },
    });
    check('Workshop edited', edited.text.includes('updated'));
    const editedRow = db.prepare('SELECT * FROM workshops WHERE id = ?').get(createdRow.id);
    check('Edits persisted', editedRow.title.includes('Edited') && editedRow.capacity === 15);

    const shrink = await admin(`/admin/workshops/${tinyId}/edit`, {
      method: 'POST',
      body: { title: 'Capacity Test', workshop_date: '2027-04-01', capacity: '0', price: '100' },
    });
    check('Capacity cannot be set below 1', shrink.text.includes('at least 1'));

    const roster = await admin(`/admin/workshops/${workshop.id}/attendees.csv`);
    check('Attendee roster CSV exports', roster.status === 200 && roster.text.includes('Attendee'));

    const cancelledWorkshop = await admin(`/admin/workshops/${createdRow.id}/cancel`, { method: 'POST' });
    check('Workshop cancelled', cancelledWorkshop.text.includes('cancelled'));
    check('Cancelled workshop status updated',
      db.prepare('SELECT status FROM workshops WHERE id = ?').get(createdRow.id).status === 'cancelled');

    const publicList = await guest('/workshops');
    check('Cancelled workshop hidden from the public listing', !publicList.text.includes('Smoke Test Workshop'));

    await admin(`/admin/workshops/${createdRow.id}/reactivate`, { method: 'POST' });
    check('Workshop re-activated',
      db.prepare('SELECT status FROM workshops WHERE id = ?').get(createdRow.id).status === 'active');

    // ---- Admin status override + refund ----
    const override = await admin(`/admin/bookings/${booking.id}/status`, { method: 'POST', body: { payment_status: 'Pending' } });
    check('Admin can override a payment status',
      db.prepare('SELECT payment_status FROM bookings WHERE id = ?').get(booking.id).payment_status === 'Pending');
    await admin(`/admin/bookings/${booking.id}/status`, { method: 'POST', body: { payment_status: 'Paid' } });

    const refunded = await admin(`/admin/bookings/${booking.id}/refund`, { method: 'POST' });
    check('Admin can refund a paid booking',
      db.prepare('SELECT payment_status FROM bookings WHERE id = ?').get(booking.id).payment_status === 'Refunded');

    const badStatus = await admin(`/admin/bookings/${booking.id}/status`, { method: 'POST', body: { payment_status: 'Nonsense' } });
    check('Invalid status value rejected', badStatus.text.includes('not a valid payment status'));

    // ================= LOGOUT =================
    section('Session');
    const loggedOut = await user('/logout', { method: 'POST' });
    check('Logout returns to home', loggedOut.status === 200);
    const afterLogout = await user('/my-bookings', { follow: false });
    check('Protected page blocked after logout',
      afterLogout.status === 302 && afterLogout.location === '/login', `→ ${afterLogout.location}`);
  } catch (err) {
    failed++;
    failures.push(`Uncaught error: ${err.stack}`);
    console.error('\n\x1b[31mUNCAUGHT ERROR\x1b[0m\n', err);
  } finally {
    server.close();
  }

  // ================= SUMMARY =================
  console.log(`\n${'─'.repeat(56)}`);
  console.log(`\x1b[1mResults\x1b[0m  ${passed} passed, ${failed} failed  (${passed + failed} checks)`);
  if (failures.length) {
    console.log('\n\x1b[31mFailures:\x1b[0m');
    failures.forEach((f) => console.log(`  · ${f}`));
  } else {
    console.log('\n\x1b[32mAll checks passed.\x1b[0m');
  }
  console.log('');

  process.exit(failed ? 1 : 0);
}

run();
