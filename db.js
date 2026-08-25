const Database = require('./sqlite');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const config = require('./config');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// DB_FILE lets the smoke test point at a throwaway database instead of the
// real one. Everything else uses the default.
const db = new Database(path.join(dataDir, process.env.DB_FILE || 'app.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ============================================================================
// SCHEMA
// ============================================================================
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  phone TEXT,
  company TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',              -- 'user' | 'admin'
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS workshops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  workshop_date TEXT NOT NULL,
  capacity INTEGER NOT NULL,
  price REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'           -- 'active' | 'cancelled'
);

CREATE TABLE IF NOT EXISTS eoi_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  company TEXT,
  email TEXT NOT NULL,
  phone TEXT,
  workshop_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workshop_id) REFERENCES workshops(id)
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  workshop_id INTEGER NOT NULL,
  payment_status TEXT NOT NULL DEFAULT 'Pending', -- Pending | Paid | Failed | Cancelled | Expired | Refunded
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (workshop_id) REFERENCES workshops(id)
);

/* Persistent "Remember me" logins. One row per device/browser. */
CREATE TABLE IF NOT EXISTS remember_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  selector TEXT UNIQUE NOT NULL,
  validator_hash TEXT NOT NULL,
  user_agent TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

/* Single-use password reset links. */
CREATE TABLE IF NOT EXISTS password_resets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

/* Brute-force protection for the login form. */
CREATE TABLE IF NOT EXISTS login_attempts (
  email TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT
);

/* Append-only audit trail of everything that happens to a payment. */
CREATE TABLE IF NOT EXISTS payment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL,
  event TEXT NOT NULL,
  gateway TEXT,
  detail TEXT,
  payload TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE
);

/* Rows created by the built-in sandbox gateway (one per checkout session). */
CREATE TABLE IF NOT EXISTS sandbox_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key TEXT UNIQUE NOT NULL,
  tran_id TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  product_name TEXT,
  customer_name TEXT,
  customer_email TEXT,
  customer_phone TEXT,
  success_url TEXT,
  fail_url TEXT,
  cancel_url TEXT,
  status TEXT NOT NULL DEFAULT 'CREATED',         -- CREATED | VALID | FAILED | CANCELLED
  val_id TEXT,
  bank_tran_id TEXT,
  card_type TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);
`);

// ============================================================================
// MIGRATIONS — keeps an existing data/app.db from an earlier build working
// ============================================================================
function addColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// Attendee snapshot — kept on the booking so a later profile edit cannot
// silently rewrite who actually attended.
addColumn('bookings', 'attendee_name', 'TEXT');
addColumn('bookings', 'attendee_email', 'TEXT');
addColumn('bookings', 'attendee_phone', 'TEXT');
addColumn('bookings', 'attendee_company', 'TEXT');
addColumn('bookings', 'attendee_notes', 'TEXT');
// Money
addColumn('bookings', 'amount', 'REAL');
addColumn('bookings', 'currency', "TEXT DEFAULT 'BDT'");
// Gateway bookkeeping
addColumn('bookings', 'gateway', 'TEXT');
addColumn('bookings', 'tran_id', 'TEXT');
addColumn('bookings', 'session_key', 'TEXT');
addColumn('bookings', 'val_id', 'TEXT');
addColumn('bookings', 'payment_id', 'TEXT');
addColumn('bookings', 'bank_tran_id', 'TEXT');
addColumn('bookings', 'card_type', 'TEXT');
addColumn('bookings', 'payment_note', 'TEXT');
addColumn('bookings', 'gateway_response', 'TEXT');
addColumn('bookings', 'paid_at', 'TEXT');
addColumn('bookings', 'refunded_at', 'TEXT');
addColumn('bookings', 'public_token', 'TEXT');
addColumn('bookings', 'updated_at', 'TEXT');
addColumn('bookings', 'attempts', 'INTEGER DEFAULT 0');

addColumn('eoi_submissions', 'message', 'TEXT');
addColumn('eoi_submissions', 'status', "TEXT DEFAULT 'New'"); // New | Contacted | Converted | Closed
addColumn('eoi_submissions', 'handled_by', 'TEXT');
addColumn('eoi_submissions', 'handled_at', 'TEXT');

addColumn('workshops', 'location', 'TEXT');
addColumn('workshops', 'instructor', 'TEXT');
addColumn('workshops', 'start_time', 'TEXT');
addColumn('workshops', 'end_time', 'TEXT');
addColumn('workshops', 'level', 'TEXT');
addColumn('workshops', 'created_at', 'TEXT');

db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_tran_id ON bookings(tran_id) WHERE tran_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bookings_workshop ON bookings(workshop_id);
CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(user_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(payment_status);
CREATE INDEX IF NOT EXISTS idx_events_booking ON payment_events(booking_id);
CREATE INDEX IF NOT EXISTS idx_remember_user ON remember_tokens(user_id);
`);

// ============================================================================
// SEED DATA (only when the tables are empty)
// ============================================================================
function futureDate(daysFromNow) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

const workshopCount = db.prepare('SELECT COUNT(*) AS c FROM workshops').get().c;
if (workshopCount === 0) {
  const insert = db.prepare(
    `INSERT INTO workshops
      (title, description, workshop_date, capacity, price, location, instructor, start_time, end_time, level, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
  );
  // Prices are in BDT — both SSLCommerz and bKash settle in Bangladeshi Taka.
  insert.run(
    'Leadership Essentials',
    'A one-day intensive on modern leadership practice for team leads and new managers. Covers delegation, feedback conversations, and running a team through change.',
    futureDate(24), 20, 4500, 'Gulshan Training Centre, Dhaka', 'Farhana Rahman', '09:30', '17:00', 'Intermediate'
  );
  insert.run(
    'Data Analytics Bootcamp',
    'Hands-on workshop covering practical analytics: cleaning real datasets, building dashboards, and presenting findings that a board will actually act on.',
    futureDate(31), 15, 7500, 'Banani Corporate Hub, Dhaka', 'Tanvir Hasan', '09:00', '17:30', 'Beginner'
  );
  insert.run(
    'Corporate Communication Skills',
    'Sharpen professional writing, presentation delivery, and client-facing communication. Includes a filmed practice session with individual feedback.',
    futureDate(45), 25, 3500, 'Motijheel Business Centre, Dhaka', 'Nusrat Jahan', '10:00', '16:00', 'Beginner'
  );
  insert.run(
    'Project Management Fundamentals',
    'Introductory workshop on PM frameworks (Agile and Waterfall) with case studies drawn from local industry. Preparation towards PMP/CAPM foundations.',
    futureDate(59), 20, 6000, 'Gulshan Training Centre, Dhaka', 'Imran Kabir', '09:30', '17:00', 'Intermediate'
  );
  insert.run(
    'Negotiation & Client Retention',
    'A practical negotiation lab for account managers and sales leads. Role-play driven, with a focus on renewals and difficult pricing conversations.',
    futureDate(38), 12, 8500, 'Bashundhara Conference Suite, Dhaka', 'Sabrina Alam', '09:30', '16:30', 'Advanced'
  );
  insert.run(
    'Cybersecurity Awareness for Teams',
    'Non-technical security training for the whole organisation: phishing, password hygiene, device policy, and what to do in the first hour of an incident.',
    futureDate(17), 30, 2500, 'Online (Live)', 'Rakib Chowdhury', '14:00', '17:00', 'Beginner'
  );
}

const adminExists = db.prepare('SELECT COUNT(*) AS c FROM users WHERE role = ?').get('admin').c;
if (adminExists === 0) {
  db.prepare(
    'INSERT INTO users (name, email, phone, company, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    'Administrator',
    'admin@workshops.com',
    '01700000000',
    'Corporate Workshops Ltd',
    bcrypt.hashSync('admin123', 10),
    'admin'
  );
}

// Backfill columns added after the first release.
db.prepare(
  `UPDATE bookings
      SET currency = COALESCE(currency, ?),
          amount = COALESCE(amount, (SELECT w.price FROM workshops w WHERE w.id = bookings.workshop_id))
    WHERE amount IS NULL OR currency IS NULL`
).run(config.currency);

module.exports = db;
