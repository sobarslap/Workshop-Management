/**
 * Email sender with a graceful fallback.
 *
 *  - If SMTP_HOST is set in .env, mail goes out for real via Nodemailer.
 *  - Otherwise every message is logged to the terminal AND written to
 *    data/outbox/ as an .html file, so the acknowledgment and confirmation
 *    emails can still be opened and demonstrated without a mail server.
 *
 * The fallback is what makes "confirmation email" a checkable feature offline:
 * open data/outbox/ and the messages are all there, rendered.
 */
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const config = require('../config');

const outboxDir = path.join(__dirname, '..', 'data', 'outbox');

let transporter = null;
if (config.mail.host) {
  transporter = nodemailer.createTransport({
    host: config.mail.host,
    port: config.mail.port,
    secure: config.mail.secure,
    auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined,
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 8000,
  });
}

function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

function writeToOutbox({ to, subject, html }) {
  try {
    if (!fs.existsSync(outboxDir)) fs.mkdirSync(outboxDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(outboxDir, `${stamp}__${slugify(subject)}.html`);
    fs.writeFileSync(file, `<!-- To: ${to}\n     Subject: ${subject}\n     Sent: ${new Date().toString()} -->\n${html}`);
    return file;
  } catch (err) {
    console.error('[MAIL] Could not write to outbox:', err.message);
    return null;
  }
}

async function sendMail(message) {
  const { to, subject, html } = message;

  if (transporter) {
    try {
      const info = await transporter.sendMail({ from: config.mail.from, ...message });
      console.log(`[MAIL SENT] to=${to} subject="${subject}" id=${info.messageId}`);
      return { delivered: true };
    } catch (err) {
      console.error(`[MAIL FAILED] to=${to} subject="${subject}" — ${err.message}`);
      // Fall through so a broken mail server never blocks the user journey.
    }
  }

  const file = writeToOutbox({ to, subject, html });
  console.log(
    `\n[MAIL SIMULATED] To: ${to}\n                 Subject: ${subject}` +
      (file ? `\n                 Saved: ${path.relative(path.join(__dirname, '..'), file)}\n` : '\n')
  );
  return { delivered: false, file };
}

// ============================================================================
// TEMPLATES — inline CSS only, matching the site's monochrome design language
// ============================================================================
const INK = '#171717';
const BODY = '#4d4d4d';
const MUTE = '#888888';
const HAIRLINE = '#ebebeb';
const SOFT = '#fafafa';

const shell = (heading, bodyHtml, accentBar = 'linear-gradient(90deg,#007cf0,#00dfd8,#7928ca,#ff0080)') => `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,Helvetica,Arial,sans-serif;background:${SOFT};padding:32px 16px">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid ${HAIRLINE};border-radius:12px;overflow:hidden">
    <div style="height:3px;background:${accentBar}"></div>
    <div style="padding:24px 28px 0">
      <div style="font-size:15px;font-weight:600;letter-spacing:-0.4px;color:${INK}">
        ${config.brand.name}
      </div>
    </div>
    <div style="padding:16px 28px 28px;color:${BODY};line-height:1.6;font-size:15px">
      <h1 style="margin:8px 0 16px;font-size:24px;line-height:1.25;letter-spacing:-0.9px;font-weight:600;color:${INK}">${heading}</h1>
      ${bodyHtml}
    </div>
    <div style="padding:16px 28px;border-top:1px solid ${HAIRLINE};background:${SOFT};color:${MUTE};font-size:12px;line-height:1.5">
      Automated message from ${config.brand.name}. Questions? Reply to this email or write to ${config.brand.supportEmail}.
    </div>
  </div>
</div>`;

const table = (rows) =>
  `<table style="width:100%;border-collapse:collapse;font-size:14px;margin:20px 0;border:1px solid ${HAIRLINE};border-radius:8px;overflow:hidden">${rows}</table>`;

const row = (labelText, value) =>
  `<tr>
     <td style="padding:10px 14px;color:${MUTE};border-bottom:1px solid ${HAIRLINE};width:42%">${labelText}</td>
     <td style="padding:10px 14px;font-weight:500;color:${INK};border-bottom:1px solid ${HAIRLINE}">${value}</td>
   </tr>`;

const button = (href, text) =>
  `<a href="${href}" style="display:inline-block;background:${INK};color:#ffffff;text-decoration:none;font-size:15px;font-weight:500;padding:12px 22px;border-radius:100px">${text}</a>`;

const statusPill = (status) => {
  const map = {
    Paid: ['#e6f6ec', '#0a7c3f'],
    Pending: ['#ffefcf', '#ab570a'],
    Failed: ['#f7d4d6', '#c50000'],
    Refunded: ['#eef2ff', '#4338ca'],
  };
  const [bg, fg] = map[status] || ['#f2f2f2', BODY];
  return `<span style="display:inline-block;background:${bg};color:${fg};font-size:12px;font-weight:600;padding:3px 10px;border-radius:100px">${status}</span>`;
};

// ---------- 1. EOI acknowledgment ----------
function eoiAcknowledgment({ name, email, workshop, formatDate, money, browseUrl }) {
  const html = shell(
    `Thanks, ${name.split(' ')[0]} — we've got your interest.`,
    `<p style="margin:0 0 4px">A member of our training team will be in touch within one business day to talk through dates, group sizes and any bespoke content you need.</p>
     ${table(
       row('Workshop', workshop.title) +
         row('Date', formatDate(workshop.workshop_date)) +
         row('Price per seat', money(workshop.price))
     )}
     <p style="margin:0 0 20px">Don't want to wait? You can create an account and secure a seat straight away.</p>
     ${button(browseUrl, 'Book a seat now')}`
  );
  return { to: email, subject: `We received your interest in ${workshop.title}`, html };
}

// ---------- 2. Booking confirmation / receipt ----------
function bookingConfirmation({ booking, formatDate, money, confirmationUrl }) {
  const paid = booking.payment_status === 'Paid';
  const html = shell(
    paid ? 'Your seat is confirmed.' : 'Your seat is being held.',
    `<p style="margin:0 0 4px">${
      paid
        ? 'Payment received in full. Keep this email — it is your receipt and your entry confirmation.'
        : `We're holding your seat, but payment is still outstanding. The hold expires in ${config.seatHoldMinutes} minutes, after which the seat returns to general sale.`
    }</p>
     ${table(
       row('Booking reference', `<code style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px">${booking.tran_id}</code>`) +
         row('Workshop', booking.title) +
         row('Date', formatDate(booking.workshop_date)) +
         (booking.start_time ? row('Time', `${booking.start_time} – ${booking.end_time || ''}`) : '') +
         (booking.location ? row('Location', booking.location) : '') +
         row('Attendee', booking.attendee_name) +
         row('Amount', money(booking.amount, booking.currency)) +
         row('Payment status', statusPill(booking.payment_status)) +
         (booking.bank_tran_id ? row('Transaction ID', booking.bank_tran_id) : '') +
         (booking.card_type ? row('Paid with', booking.card_type) : '')
     )}
     ${button(confirmationUrl, paid ? 'View your confirmation' : 'Complete payment')}`
  );
  return {
    to: booking.attendee_email,
    subject: `${paid ? 'Confirmed' : 'Reserved'}: ${booking.title} — ${booking.workshop_date}`,
    html,
  };
}

// ---------- 3. Password reset ----------
function passwordReset({ user, resetUrl, expiresMinutes }) {
  const html = shell(
    'Reset your password',
    `<p style="margin:0 0 20px">We received a request to reset the password for <strong style="color:${INK}">${user.email}</strong>. Click below to choose a new one. This link works once and expires in ${expiresMinutes} minutes.</p>
     ${button(resetUrl, 'Choose a new password')}
     <p style="margin:24px 0 0;font-size:13px;color:${MUTE}">If you didn't request this, you can safely ignore this email — your password will not change. The link is:<br>
     <span style="word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px">${resetUrl}</span></p>`,
    '#171717'
  );
  return { to: user.email, subject: 'Reset your Corporate Workshops password', html };
}

// ---------- 4. Booking cancelled / seat released ----------
function bookingCancelled({ booking, formatDate, reason }) {
  const html = shell(
    'Your booking has been cancelled',
    `<p style="margin:0 0 4px">${reason || 'The seat has been released and is available to other attendees again.'}</p>
     ${table(
       row('Booking reference', booking.tran_id || `#${booking.id}`) +
         row('Workshop', booking.title) +
         row('Date', formatDate(booking.workshop_date)) +
         row('Status', statusPill(booking.payment_status))
     )}
     <p style="margin:0">If this was a mistake, you're welcome to book again while seats remain.</p>`,
    '#ee0000'
  );
  return { to: booking.attendee_email, subject: `Cancelled: ${booking.title}`, html };
}

// ---------- 5. Workshop cancelled by the organiser ----------
function workshopCancelled({ booking, formatDate }) {
  const html = shell(
    'A workshop you booked has been cancelled',
    `<p style="margin:0 0 4px">We're sorry — <strong style="color:${INK}">${booking.title}</strong> on ${formatDate(
      booking.workshop_date
    )} has been cancelled by the organiser.</p>
     ${table(row('Booking reference', booking.tran_id || `#${booking.id}`) + row('Payment status', statusPill(booking.payment_status)))}
     <p style="margin:0">${
       booking.payment_status === 'Paid'
         ? `A full refund is being processed. Contact ${config.brand.supportEmail} if you'd rather transfer to another date.`
         : 'No payment was taken, so there is nothing to refund.'
     }</p>`,
    '#f5a623'
  );
  return { to: booking.attendee_email, subject: `Cancelled: ${booking.title} — ${booking.workshop_date}`, html };
}

// ---------- 6. Welcome ----------
function welcome({ user, browseUrl }) {
  const html = shell(
    `Welcome aboard, ${user.name.split(' ')[0]}.`,
    `<p style="margin:0 0 20px">Your account is ready. You can now book seats on any upcoming workshop, track your payment status, and download your receipts from one place.</p>
     ${button(browseUrl, 'Browse upcoming workshops')}`
  );
  return { to: user.email, subject: `Welcome to ${config.brand.name}`, html };
}

module.exports = {
  sendMail,
  eoiAcknowledgment,
  bookingConfirmation,
  passwordReset,
  bookingCancelled,
  workshopCancelled,
  welcome,
};
