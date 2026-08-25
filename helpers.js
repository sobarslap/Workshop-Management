const crypto = require('crypto');
const config = require('./config');

const SYMBOLS = { BDT: '\u09F3', USD: '$', EUR: '\u20AC', GBP: '\u00A3', INR: '\u20B9' };

function money(amount, currency = config.currency) {
  const value = Number(amount || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const symbol = SYMBOLS[currency];
  return symbol ? `${symbol}${value}` : `${currency} ${value}`;
}

function formatDate(dateString) {
  if (!dateString) return '';
  const date = new Date(`${dateString}T00:00:00`);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "in 12 days" / "today" / "3 days ago" — used on workshop cards. */
function relativeDays(dateString) {
  if (!dateString) return '';
  const target = new Date(`${dateString}T00:00:00`);
  if (Number.isNaN(target.getTime())) return '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((target - today) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff > 1) return `In ${diff} days`;
  if (diff === -1) return 'Yesterday';
  return `${Math.abs(diff)} days ago`;
}

function isPast(dateString) {
  if (!dateString) return false;
  const target = new Date(`${dateString}T23:59:59`);
  return target.getTime() < Date.now();
}

/** Maps a payment status onto a badge class defined in style.css. */
function statusClass(status) {
  switch (status) {
    case 'Paid':
      return 'badge-paid';
    case 'Pending':
      return 'badge-pending';
    case 'Refunded':
      return 'badge-refunded';
    case 'Failed':
      return 'badge-failed';
    default:
      return 'badge-neutral'; // Cancelled / Expired
  }
}

function seatClass(remaining, capacity) {
  if (remaining <= 0) return 'badge-failed';
  if (capacity > 0 && remaining / capacity <= 0.25) return 'badge-pending';
  return 'badge-paid';
}

/** Booking reference sent to the gateway as tran_id — unique per attempt. */
function generateTranId(bookingId) {
  const stamp = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  return `CW-${stamp}-${bookingId}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function generateToken(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** Constant-time compare so token checks do not leak timing information. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function initials(name) {
  return String(name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}

/** Minutes left on a Pending booking's seat hold; 0 once it has lapsed. */
function holdMinutesLeft(booking) {
  if (!booking || booking.payment_status !== 'Pending' || !booking.created_at) return 0;
  const created = new Date(
    booking.created_at.includes('T') ? booking.created_at : `${booking.created_at.replace(' ', 'T')}Z`
  );
  if (Number.isNaN(created.getTime())) return config.seatHoldMinutes;
  const elapsed = (Date.now() - created.getTime()) / 60000;
  return Math.max(0, Math.ceil(config.seatHoldMinutes - elapsed));
}

function maskEmail(email) {
  const [user, domain] = String(email || '').split('@');
  if (!domain) return email;
  const shown = user.slice(0, 2);
  return `${shown}${'*'.repeat(Math.max(1, user.length - 2))}@${domain}`;
}

module.exports = {
  money,
  formatDate,
  formatDateTime,
  relativeDays,
  isPast,
  statusClass,
  seatClass,
  generateTranId,
  generateToken,
  sha256,
  safeEqual,
  initials,
  holdMinutesLeft,
  maskEmail,
};
