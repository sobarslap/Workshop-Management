require('dotenv').config();

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const sslIsLive = bool(process.env.SSLCZ_IS_LIVE, false);
const bkashIsLive = bool(process.env.BKASH_IS_LIVE, false);

const gateway = (process.env.PAYMENT_GATEWAY || process.env.PAYMENT_MODE || 'sandbox').toLowerCase();

module.exports = {
  port: num(process.env.PORT, 3000),
  baseUrl: (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000').replace(/\/$/, ''),
  sessionSecret: process.env.SESSION_SECRET || 'change-me-in-production',
  env: process.env.NODE_ENV || 'development',

  brand: {
    name: process.env.BRAND_NAME || 'Corporate Workshops',
    tagline: process.env.BRAND_TAGLINE || 'Professional training, booked in seconds.',
    supportEmail: process.env.SUPPORT_EMAIL || 'hello@demomailtrap.co',
    supportPhone: process.env.SUPPORT_PHONE || '+880 1700 000000',
  },

  currency: process.env.CURRENCY || 'BDT',

  seatHoldMinutes: num(process.env.SEAT_HOLD_MINUTES, 30),

  auth: {
    rememberDays: num(process.env.REMEMBER_ME_DAYS, 30),
    resetTokenMinutes: num(process.env.RESET_TOKEN_MINUTES, 60),
    maxLoginAttempts: num(process.env.MAX_LOGIN_ATTEMPTS, 5),
    lockoutMinutes: num(process.env.LOCKOUT_MINUTES, 15),
  },

  gateway,

  sandbox: {
    latencyMs: num(process.env.SANDBOX_LATENCY_MS, 600),
    secret: process.env.SANDBOX_SECRET || 'local-sandbox-signing-key',
  },

  sslcommerz: {
    storeId: process.env.SSLCZ_STORE_ID || '',
    storePassword: process.env.SSLCZ_STORE_PASSWORD || '',
    isLive: sslIsLive,
    initUrl: sslIsLive
      ? 'https://securepay.sslcommerz.com/gwprocess/v4/api.php'
      : 'https://sandbox.sslcommerz.com/gwprocess/v4/api.php',
    validationUrl: sslIsLive
      ? 'https://securepay.sslcommerz.com/validator/api/validationserverAPI.php'
      : 'https://sandbox.sslcommerz.com/validator/api/validationserverAPI.php',
    timeoutMs: num(process.env.SSLCZ_TIMEOUT_MS, 20000),
  },

  bkash: {
    appKey: process.env.BKASH_APP_KEY || '',
    appSecret: process.env.BKASH_APP_SECRET || '',
    username: process.env.BKASH_USERNAME || '',
    password: process.env.BKASH_PASSWORD || '',
    isLive: bkashIsLive,
    baseUrl: bkashIsLive
      ? 'https://tokenized.pay.bka.sh/v1.2.0-beta/tokenized'
      : 'https://tokenized.sandbox.bka.sh/v1.2.0-beta/tokenized',
    timeoutMs: num(process.env.BKASH_TIMEOUT_MS, 20000),
  },

  mail: {
    host: process.env.SMTP_HOST || '',
    port: num(process.env.SMTP_PORT, 587),
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from:
      process.env.EMAIL_FROM ||
      process.env.MAIL_FROM ||
      (process.env.FROM_EMAIL
        ? `${process.env.FROM_NAME || 'Corporate Workshops'} <${process.env.FROM_EMAIL}>`
        : 'Corporate Workshops <hello@demomailtrap.co>'),
  },
};