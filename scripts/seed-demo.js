/**
 * Loads a realistic demo dataset on top of the seed workshops: customers,
 * bookings in every payment state, and a few expressions of interest.
 *
 * Handy for screenshots and for showing the admin dashboard with something in
 * it rather than a row of zeroes.
 *
 * Usage: npm run seed
 */
const bcrypt = require('bcryptjs');
const db = require('../db');
const helpers = require('../helpers');
const config = require('../config');

const PEOPLE = [
  ['Rafiq Ahmed', 'rafiq@northwind.test', '01711000001', 'Northwind Logistics'],
  ['Sadia Chowdhury', 'sadia@brightpath.test', '01711000002', 'BrightPath Consulting'],
  ['Imran Hossain', 'imran@deltabank.test', '01711000003', 'Delta Bank'],
  ['Nusrat Jahan', 'nusrat@orbitmedia.test', '01711000004', 'Orbit Media'],
  ['Tanvir Alam', 'tanvir@apexgroup.test', '01711000005', 'Apex Group'],
  ['Farhana Akter', 'farhana@lumentech.test', '01711000006', 'Lumen Tech'],
];

const STATUSES = ['Paid', 'Paid', 'Paid', 'Pending', 'Paid', 'Failed', 'Paid', 'Cancelled'];

console.log('\nSeeding demo data…\n');

const hash = bcrypt.hashSync('demo1234', 10);
const userIds = [];

PEOPLE.forEach(([name, email, phone, company]) => {
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    userIds.push(existing.id);
    return;
  }
  const info = db
    .prepare('INSERT INTO users (name, email, phone, company, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, email, phone, company, hash, 'user');
  userIds.push(Number(info.lastInsertRowid));
  console.log(`  user   ${email}  (password: demo1234)`);
});

const workshops = db.prepare("SELECT * FROM workshops WHERE status = 'active'").all();
let bookingCount = 0;

workshops.forEach((workshop, wIndex) => {
  // Fill each workshop to a different degree so the seat meters vary.
  const target = Math.max(1, Math.floor(workshop.capacity * [0.9, 0.4, 0.25, 0.6, 1, 0.15][wIndex % 6]));

  for (let i = 0; i < Math.min(target, PEOPLE.length); i++) {
    const userId = userIds[i];
    const [name, email, phone, company] = PEOPLE[i];

    const already = db
      .prepare('SELECT id FROM bookings WHERE user_id = ? AND workshop_id = ?')
      .get(userId, workshop.id);
    if (already) continue;

    const status = STATUSES[(wIndex + i) % STATUSES.length];

    const info = db
      .prepare(
        `INSERT INTO bookings
          (user_id, workshop_id, attendee_name, attendee_email, attendee_phone, attendee_company,
           amount, currency, gateway, payment_status, public_token, paid_at, card_type, bank_tran_id, attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sandbox', ?, ?, ?, ?, ?, 1)`
      )
      .run(
        userId, workshop.id, name, email, phone, company,
        workshop.price, config.currency, status,
        helpers.generateToken(),
        status === 'Paid' ? new Date().toISOString() : null,
        status === 'Paid' ? ['Visa', 'bKash', 'Mastercard', 'Nagad'][i % 4] : null,
        status === 'Paid' ? `SEED-${Date.now().toString(36).toUpperCase()}-${i}` : null
      );

    const bookingId = Number(info.lastInsertRowid);
    db.prepare('UPDATE bookings SET tran_id = ? WHERE id = ?').run(helpers.generateTranId(bookingId), bookingId);
    db.prepare('INSERT INTO payment_events (booking_id, event, gateway, detail) VALUES (?, ?, ?, ?)')
      .run(bookingId, 'booking.created', 'sandbox', 'Seeded demo booking');
    if (status === 'Paid') {
      db.prepare('INSERT INTO payment_events (booking_id, event, gateway, detail) VALUES (?, ?, ?, ?)')
        .run(bookingId, 'payment.paid', 'sandbox', 'Seeded demo payment');
    }
    bookingCount++;
  }
});
console.log(`  ${bookingCount} bookings across ${workshops.length} workshops`);

const ENQUIRIES = [
  ['Kamrul Islam', 'Zenith Pharma', 'kamrul@zenith.test', '01811000001', 'Looking for a private session for 15 people in October.', 'New'],
  ['Ayesha Siddiqua', 'Meridian Ltd', 'ayesha@meridian.test', '01811000002', 'Do you offer this content in Bangla?', 'Contacted'],
  ['Shakib Rahman', 'Vertex Solutions', 'shakib@vertex.test', '01811000003', 'Interested in the full leadership track for our managers.', 'Converted'],
  ['Mehjabin Haque', 'Coastal Textiles', 'mehjabin@coastal.test', '01811000004', '', 'New'],
];

let eoiCount = 0;
ENQUIRIES.forEach(([name, company, email, phone, message, status], i) => {
  if (db.prepare('SELECT id FROM eoi_submissions WHERE email = ?').get(email)) return;
  db.prepare(
    'INSERT INTO eoi_submissions (name, company, email, phone, workshop_id, message, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(name, company, email, phone, workshops[i % workshops.length].id, message, status);
  eoiCount++;
});
console.log(`  ${eoiCount} expressions of interest`);

console.log('\nDone. Log in as admin@workshops.com / admin123 to see the dashboard.\n');
process.exit(0);
