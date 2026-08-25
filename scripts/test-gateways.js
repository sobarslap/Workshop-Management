/**
 * Gateway adapter tests (offline).
 *
 * The SSLCommerz and bKash sandboxes need outbound internet, which is not
 * always available (corporate networks, exam machines, CI). This suite replaces
 * global fetch with a recording mock that replays the exact response bodies
 * those two APIs return, then asserts that our adapters:
 *
 *   - hit the right URLs with the right method and headers
 *   - send every field the API requires, correctly formatted
 *   - accept a genuine success
 *   - reject a tampered amount, a wrong transaction id, and a failed status
 *   - handle the awkward real-world cases (bKash error 2062, token reuse)
 *
 * That is the part worth testing anyway: a live sandbox call proves the network
 * works, but it cannot easily prove we reject a forged callback.
 *
 * Run with:  npm run test:gateways
 */
process.env.SSLCZ_STORE_ID = 'corpo6a89104f1a961';
process.env.SSLCZ_STORE_PASSWORD = 'corpo6a89104f1a961@ssl';
process.env.BKASH_APP_KEY = '4f6o8c51l1r7m34hfdadileqg';
process.env.BKASH_APP_SECRET = '1ls7hdktrmkvrb1jjh4411h8lldtjodqasmjve5vl5qz3fug9b';
process.env.BKASH_USERNAME = 'sandboxTokenizedUser02';
process.env.BKASH_PASSWORD = 'sandboxTokenizedUser02@12345';

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, extra) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  \x1b[31m✗\x1b[0m ${label}${extra ? ` \x1b[2m(${extra})\x1b[0m` : ''}`);
  }
}

function section(name) {
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

// ---------------------------------------------------------------------------
// Mock transport
// ---------------------------------------------------------------------------
const calls = [];
let handler = null;

global.fetch = async (url, options = {}) => {
  const record = {
    url: String(url),
    method: options.method || 'GET',
    headers: options.headers || {},
    body: options.body,
  };

  // Decode the body into something assertable regardless of encoding.
  if (options.body instanceof URLSearchParams) {
    record.fields = Object.fromEntries(options.body);
  } else if (typeof options.body === 'string') {
    try {
      record.fields = JSON.parse(options.body);
    } catch {
      record.fields = {};
    }
  } else {
    record.fields = {};
  }

  calls.push(record);
  const payload = handler(record);
  return {
    status: 200,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  };
};

const sslcommerz = require('../services/gateways/sslcommerz');
const bkash = require('../services/gateways/bkash');

const ORDER = {
  bookingId: 42,
  tranId: 'CW-260821-42-A1B2C3',
  amount: 4500,
  currency: 'BDT',
  productName: 'Leadership Essentials — 2026-09-14',
  successUrl: 'http://localhost:3000/payment/success',
  failUrl: 'http://localhost:3000/payment/fail',
  cancelUrl: 'http://localhost:3000/payment/cancel',
  ipnUrl: 'http://localhost:3000/payment/ipn',
  callbackUrl: 'http://localhost:3000/payment/bkash/callback',
  customer: {
    name: 'Rafiq Ahmed',
    email: 'rafiq@acme.test',
    phone: '01770618576',
    address: 'Acme Ltd',
  },
};

const BOOKING = {
  id: 42,
  tran_id: 'CW-260821-42-A1B2C3',
  amount: 4500,
  currency: 'BDT',
  payment_id: null,
};

async function run() {
  // =========================================================================
  section('SSLCommerz — session creation');
  // =========================================================================
  calls.length = 0;
  handler = () => ({
    status: 'SUCCESS',
    sessionkey: 'F1A2B3C4D5E6',
    GatewayPageURL: 'https://sandbox.sslcommerz.com/EasyCheckOut/testcde123',
  });

  check('Adapter reports itself configured', sslcommerz.isConfigured());

  const sslSession = await sslcommerz.createSession(ORDER);
  const init = calls[0];

  check('Posts to the v4 sandbox init endpoint',
    init.url === 'https://sandbox.sslcommerz.com/gwprocess/v4/api.php', init.url);
  check('Uses POST', init.method === 'POST');
  check('Sends store_id', init.fields.store_id === 'corpo6a89104f1a961');
  check('Sends store_passwd', init.fields.store_passwd === 'corpo6a89104f1a961@ssl');
  check('Formats total_amount to two decimals', init.fields.total_amount === '4500.00', init.fields.total_amount);
  check('Sends currency', init.fields.currency === 'BDT');
  check('Sends our tran_id', init.fields.tran_id === ORDER.tranId);
  check('Sends all four callback URLs',
    init.fields.success_url === ORDER.successUrl &&
    init.fields.fail_url === ORDER.failUrl &&
    init.fields.cancel_url === ORDER.cancelUrl &&
    init.fields.ipn_url === ORDER.ipnUrl);
  check('Declares a non-physical product (no shipping block required)',
    init.fields.product_profile === 'non-physical-goods' && init.fields.shipping_method === 'NO');
  check('Sends customer details', init.fields.cus_name === 'Rafiq Ahmed' && init.fields.cus_email === 'rafiq@acme.test');
  check('Echoes booking id in value_a for reconciliation', String(init.fields.value_a) === '42');
  check('Returns the gateway redirect URL', sslSession.redirectUrl.includes('EasyCheckOut'));
  check('Returns the session key', sslSession.sessionKey === 'F1A2B3C4D5E6');

  // ---- refusal ----
  handler = () => ({ status: 'FAILED', failedreason: 'Store Credential Error' });
  let refused = null;
  try {
    await sslcommerz.createSession(ORDER);
  } catch (err) {
    refused = err.message;
  }
  check('Surfaces a refusal reason from the gateway',
    Boolean(refused) && refused.includes('Store Credential Error'), refused);

  // =========================================================================
  section('SSLCommerz — payment verification');
  // =========================================================================
  const validPayload = {
    status: 'VALID',
    tran_id: BOOKING.tran_id,
    amount: '4500.00',
    currency: 'BDT',
    val_id: '250821123456ABCDE',
    bank_tran_id: 'SSL2608211234',
    card_type: 'VISA-Dutch Bangla',
  };

  calls.length = 0;
  handler = () => validPayload;
  const good = await sslcommerz.verify({ booking: BOOKING, payload: { val_id: '250821123456ABCDE' } });

  const validation = calls[0];
  check('Validation call includes val_id', validation.url.includes('val_id=250821123456ABCDE'));
  check('Validation call authenticates with the store credentials',
    validation.url.includes('store_id=corpo6a89104f1a961') && validation.url.includes('store_passwd='));
  check('Validation requests JSON', validation.url.includes('format=json'));
  check('Genuine payment accepted', good.ok === true, good.reason);
  check('Bank transaction id extracted', good.details.bank_tran_id === 'SSL2608211234');
  check('Card type extracted', good.details.card_type === 'VISA-Dutch Bangla');

  handler = () => ({ ...validPayload, amount: '1.00' });
  const tampered = await sslcommerz.verify({ booking: BOOKING, payload: { val_id: 'x' } });
  check('Tampered amount rejected', tampered.ok === false && tampered.reason.includes('Amount mismatch'), tampered.reason);

  handler = () => ({ ...validPayload, tran_id: 'CW-SOMEONE-ELSE' });
  const wrongTran = await sslcommerz.verify({ booking: BOOKING, payload: { val_id: 'x' } });
  check('Mismatched transaction id rejected', wrongTran.ok === false && wrongTran.reason.includes('Transaction ID'));

  handler = () => ({ ...validPayload, currency: 'USD' });
  const wrongCurrency = await sslcommerz.verify({ booking: BOOKING, payload: { val_id: 'x' } });
  check('Currency mismatch rejected', wrongCurrency.ok === false && wrongCurrency.reason.includes('Currency'));

  handler = () => ({ ...validPayload, status: 'FAILED' });
  const failedStatus = await sslcommerz.verify({ booking: BOOKING, payload: { val_id: 'x' } });
  check('Non-VALID status rejected', failedStatus.ok === false && failedStatus.reason.includes('FAILED'));

  const noVal = await sslcommerz.verify({ booking: BOOKING, payload: {} });
  check('Missing val_id rejected without a network call', noVal.ok === false && noVal.reason.includes('No val_id'));

  handler = () => 'This store is temporarily unavailable';
  let nonJson = null;
  try {
    await sslcommerz.verify({ booking: BOOKING, payload: { val_id: 'x' } });
  } catch (err) {
    nonJson = err.message;
  }
  check('Non-JSON gateway response raises a clear error',
    Boolean(nonJson) && nonJson.includes('non-JSON'), nonJson);

  // =========================================================================
  section('bKash — token grant');
  // =========================================================================
  calls.length = 0;
  handler = (call) => {
    if (call.url.endsWith('/checkout/token/grant')) {
      return { id_token: 'MOCK_ID_TOKEN', refresh_token: 'MOCK_REFRESH', expires_in: 3600, status: 'success' };
    }
    if (call.url.endsWith('/checkout/create')) {
      return {
        paymentID: 'TR0011abcXYZ',
        bkashURL: 'https://sandbox.payment.bka.sh/checkout/TR0011abcXYZ',
        statusCode: '0000',
        statusMessage: 'Successful',
        amount: '4500.00',
        merchantInvoiceNumber: ORDER.tranId,
      };
    }
    return {};
  };

  check('Adapter reports itself configured', bkash.isConfigured());

  const bkashSession = await bkash.createSession(ORDER);
  const grant = calls[0];
  const create = calls[1];

  check('Token grant hits the tokenized endpoint',
    grant.url === 'https://tokenized.sandbox.bka.sh/v1.2.0-beta/tokenized/checkout/token/grant', grant.url);
  check('Token grant sends username and password as headers',
    grant.headers.username === 'sandboxTokenizedUser02' &&
    grant.headers.password === 'sandboxTokenizedUser02@12345');
  check('Token grant sends app_key and app_secret in the body',
    grant.fields.app_key === '4f6o8c51l1r7m34hfdadileqg' &&
    grant.fields.app_secret.startsWith('1ls7hdk'));

  check('Create hits the create endpoint', create.url.endsWith('/checkout/create'), create.url);
  check('Create authorises with the id_token', create.headers.Authorization === 'MOCK_ID_TOKEN');
  check('Create sends X-APP-Key', create.headers['X-APP-Key'] === '4f6o8c51l1r7m34hfdadileqg');
  check('Create uses mode 0011 (tokenized with callback)', create.fields.mode === '0011');
  check('Create sends intent sale', create.fields.intent === 'sale');
  check('Create formats the amount to two decimals', create.fields.amount === '4500.00', create.fields.amount);
  check('Create sends BDT', create.fields.currency === 'BDT');
  check('Create sends our tran_id as merchantInvoiceNumber',
    create.fields.merchantInvoiceNumber === ORDER.tranId);
  check('Create sends the callback URL', create.fields.callbackURL === ORDER.callbackUrl);
  check('Create sends a payer reference', create.fields.payerReference === '01770618576');
  check('Returns the bKash redirect URL', bkashSession.redirectUrl.includes('payment.bka.sh'));
  check('Returns the paymentID', bkashSession.paymentId === 'TR0011abcXYZ');

  // ---- token caching ----
  calls.length = 0;
  await bkash.createSession(ORDER);
  const grantCalls = calls.filter((c) => c.url.endsWith('/token/grant')).length;
  check('Token is cached and not re-granted on every call', grantCalls === 0, `${grantCalls} extra grants`);

  // =========================================================================
  section('bKash — execute and verification');
  // =========================================================================
  const executed = {
    paymentID: 'TR0011abcXYZ',
    trxID: 'AH7XXXXXXX',
    transactionStatus: 'Completed',
    amount: '4500.00',
    currency: 'BDT',
    merchantInvoiceNumber: ORDER.tranId,
    customerMsisdn: '01770618576',
    statusCode: '0000',
    statusMessage: 'Successful',
  };

  calls.length = 0;
  handler = (call) => (call.url.endsWith('/checkout/execute') ? executed : {});
  const bkashGood = await bkash.verify({
    booking: BOOKING,
    payload: { paymentID: 'TR0011abcXYZ', status: 'success' },
  });

  const execute = calls.find((c) => c.url.endsWith('/checkout/execute'));
  check('Execute is called', Boolean(execute));
  check('Execute sends the paymentID', execute && execute.fields.paymentID === 'TR0011abcXYZ');
  check('Completed payment accepted', bkashGood.ok === true, bkashGood.reason);
  check('trxID captured as the bank transaction id', bkashGood.details.bank_tran_id === 'AH7XXXXXXX');
  check('Method recorded as bKash', bkashGood.details.card_type === 'bKash');

  // ---- customer cancelled in the app ----
  calls.length = 0;
  const cancelled = await bkash.verify({ booking: BOOKING, payload: { paymentID: 'X', status: 'cancel' } });
  check('Cancelled payment rejected', cancelled.ok === false && cancelled.reason.includes('cancelled'));
  check('Cancelled payment makes no execute call', calls.length === 0, `${calls.length} calls`);

  const failure = await bkash.verify({ booking: BOOKING, payload: { paymentID: 'X', status: 'failure' } });
  check('Failed payment rejected', failure.ok === false && failure.reason.includes('failed'));

  // ---- amount tampering ----
  handler = () => ({ ...executed, amount: '1.00' });
  const bkashTampered = await bkash.verify({ booking: BOOKING, payload: { paymentID: 'X', status: 'success' } });
  check('Tampered amount rejected', bkashTampered.ok === false && bkashTampered.reason.includes('Amount mismatch'));

  // ---- wrong invoice ----
  handler = () => ({ ...executed, merchantInvoiceNumber: 'CW-SOMEONE-ELSE' });
  const bkashWrongInvoice = await bkash.verify({ booking: BOOKING, payload: { paymentID: 'X', status: 'success' } });
  check('Mismatched invoice number rejected',
    bkashWrongInvoice.ok === false && bkashWrongInvoice.reason.includes('invoice'));

  // ---- incomplete transaction ----
  handler = () => ({ ...executed, transactionStatus: 'Initiated' });
  const incomplete = await bkash.verify({ booking: BOOKING, payload: { paymentID: 'X', status: 'success' } });
  check('Non-completed transaction rejected', incomplete.ok === false && incomplete.reason.includes('Initiated'));

  // ---- error 2062: already executed (customer refreshed the page) ----
  calls.length = 0;
  handler = (call) => {
    if (call.url.endsWith('/checkout/execute')) {
      return { errorCode: '2062', errorMessage: 'The payment has already been completed' };
    }
    if (call.url.endsWith('/checkout/payment/status')) return executed;
    return {};
  };
  const replayed = await bkash.verify({ booking: BOOKING, payload: { paymentID: 'TR0011abcXYZ', status: 'success' } });
  check('Error 2062 falls back to the query endpoint',
    calls.some((c) => c.url.endsWith('/checkout/payment/status')));
  check('Already-completed payment still accepted, not reported as a failure',
    replayed.ok === true, replayed.reason);

  // ---- insufficient balance (sandbox wallet 01823074817) ----
  handler = () => ({
    paymentID: 'TR0011abcXYZ',
    transactionStatus: 'Failed',
    statusCode: '2001',
    statusMessage: 'Insufficient Balance',
    errorCode: '2001',
  });
  const insufficient = await bkash.verify({ booking: BOOKING, payload: { paymentID: 'X', status: 'success' } });
  check('Insufficient-balance wallet produces a clean rejection',
    insufficient.ok === false && insufficient.reason.toLowerCase().includes('failed'), insufficient.reason);

  const noPaymentId = await bkash.verify({ booking: { ...BOOKING, payment_id: null }, payload: {} });
  check('Missing paymentID rejected', noPaymentId.ok === false && noPaymentId.reason.includes('No paymentID'));

  // =========================================================================
  section('Gateway registry');
  // =========================================================================
  // The gateway modules capture their slice of config at require time, so a
  // cache clear has to include them — not just config and the facade — or the
  // reload silently keeps the old credentials.
  const reloadPayments = (env) => {
    Object.assign(process.env, env);
    [
      '../config',
      '../services/payments',
      '../services/gateways/bkash',
      '../services/gateways/sslcommerz',
      '../services/gateways/sandbox',
    ].forEach((mod) => delete require.cache[require.resolve(mod)]);
    return require('../services/payments');
  };

  const payments = reloadPayments({ PAYMENT_GATEWAY: 'bkash' });
  check('Configured gateway is selected', payments.activeName === 'bkash', payments.activeName);
  check('Registry lists all three providers', payments.describe().all.length === 3);
  check('All three report as configured', payments.describe().all.every((g) => g.configured));

  const sslSelected = reloadPayments({ PAYMENT_GATEWAY: 'sslcommerz' });
  check('SSLCommerz can be selected', sslSelected.activeName === 'sslcommerz', sslSelected.activeName);

  const aliased = reloadPayments({ PAYMENT_GATEWAY: 'simulated' });
  check('Legacy "simulated" name still maps to sandbox', aliased.activeName === 'sandbox', aliased.activeName);

  const unknown = reloadPayments({ PAYMENT_GATEWAY: 'not-a-real-gateway' });
  check('Unknown gateway name falls back to sandbox', unknown.activeName === 'sandbox', unknown.activeName);

  const degraded = reloadPayments({ PAYMENT_GATEWAY: 'bkash', BKASH_APP_KEY: '' });
  check('Missing credentials fall back to sandbox rather than crashing',
    degraded.activeName === 'sandbox', degraded.activeName);
  check('Fallback explains itself', Boolean(degraded.describe().fallbackReason));
  check('Fallback records what was originally requested', degraded.describe().requested === 'bkash');

  // ---- summary ----
  console.log(`\n${'─'.repeat(56)}`);
  console.log(`\x1b[1mResults\x1b[0m  ${passed} passed, ${failed} failed  (${passed + failed} checks)`);
  if (failures.length) {
    console.log('\n\x1b[31mFailures:\x1b[0m');
    failures.forEach((f) => console.log(`  · ${f}`));
  } else {
    console.log('\n\x1b[32mAll gateway adapter checks passed.\x1b[0m');
  }
  console.log('');
  process.exit(failed ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
