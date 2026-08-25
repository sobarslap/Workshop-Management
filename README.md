# Corporate Workshops

A corporate training booking platform: expression-of-interest capture, a public
workshop catalogue with live seat counts, authenticated booking with hard
capacity limits, real payment-gateway integration with server-side verification,
and an admin dashboard for registrations, enquiries and workshop management.

Built with Node.js, Express 5, EJS and SQLite. No build step, no bundler.

---

## Quick start

```bash
npm install
npm start
```

Open <http://localhost:3000>.

That's the whole setup. **No API keys, no database server, no internet
connection are required** — the app ships with a built-in payment gateway and
writes emails to disk when no SMTP server is configured.

Optional, but recommended before a demo:

```bash
npm run seed      # loads demo customers, bookings and enquiries
```

### Accounts

| Role | Email | Password |
|---|---|---|
| Administrator | `admin@workshops.com` | `admin123` |
| Customer | register your own, or `rafiq@northwind.test` after `npm run seed` | `demo1234` |

### Scripts

| Command | What it does |
|---|---|
| `npm start` | Runs the server |
| `npm run dev` | Runs with auto-reload on file changes |
| `npm run seed` | Loads realistic demo data |
| `npm run reset-db` | Wipes and rebuilds the database |
| `npm test` | Runs both suites (182 checks, no network needed) |
| `npm run smoke` | End-to-end journey tests (114 checks) |
| `npm run test:gateways` | Gateway adapter tests (68 checks) |

---

## Requirements coverage

| # | Requirement | Where it lives |
|---|---|---|
| 1 | EOI form (name, company, email, phone, workshop) | `GET/POST /eoi` → `views/eoi.ejs` |
| 2 | Automated acknowledgment after EOI | `services/mailer.js` → `eoiAcknowledgment()` |
| 3 | Listing with dates, seats remaining, price | `GET /workshops` → `views/workshops.ejs` |
| 4 | Mandatory login before booking | `requireLogin` middleware in `server.js` |
| 5 | Booking flow: date → attendee details → payment | `/workshops/:id` → `/book/:id` → `/booking/:id/pay` |
| 6 | Capacity limit, booking blocked when full | `reserveSeat()` in `server.js` |
| 7 | Payment status tracked per booking | `bookings.payment_status` + `payment_events` |
| 8 | Confirmation page + email | `/booking/:id/confirmation`, `bookingConfirmation()` |
| 9 | Admin dashboard with filters | `/admin/dashboard` |
| 10 | Admin workshop create / edit / cancel | `/admin/workshops/*` |
| 11 | Responsive, professional design | `public/css/style.css`, `docs/DESIGN.md` |

Beyond the brief: password reset, remember-me, login throttling, printable
receipts, CSV exports, a payment audit trail, refunds, an enquiry pipeline, and
seat-hold expiry.

---

## How the important parts work

### Capacity enforcement

A seat is held by any booking that is `Pending` or `Paid`. The check and the
insert happen inside a single `BEGIN IMMEDIATE` transaction, so two people
racing for the last seat cannot both win it:

```js
db.exec('BEGIN IMMEDIATE');
const taken = /* count of Pending + Paid */;
if (taken >= workshop.capacity) { db.exec('ROLLBACK'); return { ok: false }; }
/* INSERT the booking */
db.exec('COMMIT');
```

Checking first and inserting afterwards would leave a gap between the two where
a second request could slip through. The smoke test fires five simultaneous
bookings at a one-seat workshop and asserts exactly one wins.

Unpaid holds expire after `SEAT_HOLD_MINUTES` (default 30) and return to the
pool, so an abandoned checkout cannot block a seat forever.

### Payments

`services/payments.js` is a facade over three interchangeable gateways. Each
implements the same four methods, so switching providers is one line in `.env`
and changes nothing else in the application.

| Gateway | Credentials needed | Notes |
|---|---|---|
| `sandbox` | none | Built in. Serves its own hosted checkout page. **Default.** |
| `sslcommerz` | store ID + password | Real SSLCommerz v4 — sandbox store preconfigured |
| `bkash` | app key, secret, username, password | Real bKash Tokenized Checkout — sandbox creds preconfigured |

Both real sandboxes are already wired up in `.env.example`. To use one:

```bash
cp .env.example .env
# then set PAYMENT_GATEWAY=bkash   (or sslcommerz)
npm start
```

bKash sandbox test wallets, PINs and OTPs are listed in **[docs/PAYMENTS.md](docs/PAYMENTS.md)**
and are also shown on the payment page itself when bKash sandbox is active.

**The redirect from a gateway is never trusted.** When the customer comes back
to `/payment/success`, that POST body could be forged by anyone who knows the
URL. Nothing is marked `Paid` until a separate server-to-server call confirms
the status, transaction ID, amount and currency all match what we expect. If
that verification call itself fails, the booking stays `Pending` for an admin to
review rather than being optimistically marked paid.

The built-in sandbox gateway follows the same contract rather than shortcutting
it — it issues session keys, redirects to a checkout page on its own route, and
gets verified by `val_id` lookup. It can simulate a successful payment, a bank
decline, and a customer cancellation, so every branch is demonstrable offline.

### Authentication

Standard bcrypt password hashing, plus:

- **Remember me** — the split selector/validator pattern. The cookie carries
  `selector:validator`; the database stores the selector in the clear and only a
  SHA-256 hash of the validator, so a stolen database yields no usable cookies.
  The validator rotates on every use, and a selector presented with the wrong
  validator revokes every token for that user as a theft signal.
- **Password reset** — single-use tokens, stored hashed, expiring after an hour.
  The forgot-password endpoint responds identically whether or not the address
  exists, so it cannot be used to enumerate accounts. A reset signs out every
  remembered device.
- **Login throttling** — an address locks for 15 minutes after 5 failed
  attempts.

---

## Testing

```bash
npm run smoke
```

Boots the real server on a throwaway database and drives it over HTTP with a
cookie jar. 114 assertions covering every journey, including the ones that are
awkward to check by hand:

- a forged `/payment/success` callback is rejected rather than trusted
- five concurrent bookings on a one-seat workshop produce exactly one winner
- a stale unpaid hold expires and releases its seat
- one customer cannot open another customer's booking
- a used password-reset token cannot be reused
- a normal user gets 403 on the admin area

```
Results  114 passed, 0 failed  (114 checks)
```

### Gateway adapters

```bash
npm run test:gateways
```

The SSLCommerz and bKash sandboxes need outbound internet, which is not always
available. This suite replaces `fetch` with a recording mock that replays the
exact response bodies both APIs return, then asserts the adapters send the right
fields to the right URLs and — more importantly — reject a tampered amount, a
mismatched transaction ID, a wrong invoice number and a non-completed status.

A live sandbox call proves the network works. It cannot easily prove we refuse a
forged callback, which is the thing actually worth testing.

```
Results  68 passed, 0 failed  (68 checks)
```

---

## Project layout

```
corporate-workshops/
├── server.js                   all routes
├── config.js                   environment configuration
├── db.js                       schema, migrations, seed data
├── sqlite.js                   driver adapter (better-sqlite3 → node:sqlite)
├── helpers.js                  formatting and token helpers
├── services/
│   ├── payments.js             gateway facade
│   ├── auth.js                 remember-me, reset tokens, throttling
│   ├── mailer.js               templates + offline fallback
│   └── gateways/
│       ├── sandbox.js          built-in gateway
│       ├── sslcommerz.js       SSLCommerz v4
│       └── bkash.js            bKash Tokenized Checkout
├── views/                      EJS templates
├── public/css/style.css        design system
├── public/js/app.js            progressive enhancement only
├── scripts/                    seed, reset, smoke test
└── docs/
    ├── DESIGN.md               generated design specification
    ├── AI-USAGE.md             AI usage declaration
    └── TESTING.md              manual test checklist
```

### Database driver

`sqlite.js` prefers `better-sqlite3` and falls back to `node:sqlite`, built into
Node 22.5+. That fallback matters on Windows, where `better-sqlite3` needs
Visual Studio build tools to compile. **Node 22.5 or newer is required.**

---

## Deployment

The app needs a persistent filesystem for its SQLite database, so a static host
will not work. Render, Railway and Fly.io all suit it.

1. Set `BASE_URL` to the deployed URL — payment gateways redirect back to it.
2. Set `SESSION_SECRET` to a long random string.
3. Mount a persistent disk at `data/`, or the database resets on each deploy.
4. Start command: `npm start`.

### Going live with a real gateway

Put production credentials in `.env`, set `SSLCZ_IS_LIVE=true` or
`BKASH_IS_LIVE=true`, and the adapters swap to the production hosts
automatically. Nothing else changes. Full checklist in
**[docs/PAYMENTS.md](docs/PAYMENTS.md)**.
