# Payments

Three interchangeable gateways sit behind one interface (`services/payments.js`).
Switching between them is a single line in `.env` and changes nothing else in
the application.

```env
PAYMENT_GATEWAY=sandbox      # or: sslcommerz | bkash
```

| Gateway | Credentials | Internet needed | Use it for |
|---|---|---|---|
| `sandbox` | none | no | Offline demos, marking, CI. **Default.** |
| `sslcommerz` | store ID + password | yes | Real SSLCommerz sandbox or live |
| `bkash` | 4 values | yes | Real bKash Tokenized Checkout |

If the selected gateway is missing credentials, the app logs a warning at boot
and falls back to `sandbox` rather than breaking the booking flow. The admin
dashboard shows a banner when that happens.

---

## The verification model

This is the part that matters, and it is identical for all three gateways.

```
1. POST  /booking/:id/checkout      → create a session at the gateway
2. redirect the customer to the gateway's own hosted page
3. customer pays (or fails, or cancels) — we are not involved
4. gateway redirects the browser back to /payment/success
5. ⚠ that redirect is NOT trusted
6. server-to-server call back to the gateway to confirm the truth
7. only then is the booking marked Paid
```

Step 5 is the whole point. Anyone can open
`/payment/success?tran_id=CW-260821-42-A1B2C3&val_id=anything` in a browser. If
the app believed that redirect, every seat in the system would be free. Instead
the callback triggers a fresh server-side lookup, and the booking is only marked
`Paid` when the gateway itself confirms the status, the transaction ID, the
amount and the currency all match what we expect.

If the verification call itself fails — network down, credentials wrong — the
booking stays `Pending` with a note for an administrator. It is never
optimistically marked paid.

Every state change is written to the `payment_events` table and visible in the
admin booking detail page.

---

## 1. Sandbox (default)

A complete gateway that runs inside the app. It is not a boolean flip to
"Paid" — it issues session keys, serves a hosted checkout page on its own route
(`/sandbox-gateway/:sessionKey`), and gets verified by `val_id` lookup exactly
like SSLCommerz. Keeping the same contract is what makes it a fair stand-in.

The checkout page deliberately looks nothing like the rest of the site, because
a real gateway is a different company's domain and that visual break is part of
what tells a customer they have left the merchant.

Three buttons cover every branch:

| Button | Booking becomes | Shown to the customer |
|---|---|---|
| **Pay** | `Paid` | Confirmation page, receipt email |
| **Simulate decline** | `Failed` | Failure page with a retry button |
| **Cancel payment** | `Cancelled` | Cancellation page, seat released |

```env
PAYMENT_GATEWAY=sandbox
SANDBOX_LATENCY_MS=600     # fake network delay; 0 for instant
```

---

## 2. SSLCommerz

```env
PAYMENT_GATEWAY=sslcommerz
SSLCZ_STORE_ID=corpo6a89104f1a961
SSLCZ_STORE_PASSWORD=corpo6a89104f1a961@ssl
SSLCZ_IS_LIVE=false
```

**On the password:** SSLCommerz issues it when the store is created. The usual
convention is `<store_id>@ssl`, which is what is configured above. If the
gateway returns *"Store Credential Error"*, sign in at
<https://developer.sslcommerz.com/> and copy the exact password from the
merchant panel.

### Flow

| Step | Endpoint |
|---|---|
| Create session | `POST /gwprocess/v4/api.php` → `GatewayPageURL` |
| Verify | `GET /validator/api/validationserverAPI.php?val_id=…` |

A workshop seat is sent as `product_profile=non-physical-goods` with
`shipping_method=NO`, so no shipping block is required. The booking ID is echoed
in `value_a` as a secondary reconciliation key.

### Test cards

The sandbox checkout page prefills its own test card details — pick any method
and submit. No card numbers need to be typed.

---

## 3. bKash Tokenized Checkout

```env
PAYMENT_GATEWAY=bkash
BKASH_APP_KEY=4f6o8c51l1r7m34hfdadileqg
BKASH_APP_SECRET=1ls7hdktrmkvrb1jjh4411h8lldtjodqasmjve5vl5qz3fug9b
BKASH_USERNAME=sandboxTokenizedUser02
BKASH_PASSWORD=sandboxTokenizedUser02@12345
BKASH_IS_LIVE=false
```

These are bKash's **public** sandbox credentials, published for testing and
shared by every developer. They only work against
`tokenized.sandbox.bka.sh`. Replace them with the credentials from your bKash
Relationship Manager before going live.

### Flow

bKash has one more step than SSLCommerz, because the merchant must authenticate
first *and* must explicitly execute the payment afterwards:

| Step | Endpoint |
|---|---|
| 1. Authenticate | `POST /tokenized/checkout/token/grant` → `id_token` (≈1 hour) |
| 2. Create | `POST /tokenized/checkout/create` → `bkashURL` + `paymentID` |
| 3. Customer authorises in the bKash UI | — |
| 4. Execute | `POST /tokenized/checkout/execute` → `trxID` + `transactionStatus` |
| 5. Reconcile if needed | `POST /tokenized/checkout/payment/status` |

**Step 4 is mandatory, not optional.** Until `execute` succeeds, bKash has only
*authorised* the payment — no money has moved. That is also what makes the flow
safe: the redirect in step 3 carries no amount we could be tricked by, and
`execute` returns the authoritative amount, which is compared against the
booking before anything is marked paid.

The `id_token` is cached in memory and refreshed a minute before expiry, so a
grant call does not happen on every payment.

### Test wallets

All sandbox wallets share the same **PIN `12121`** and **OTP `123456`**.

| Wallet number | Result |
|---|---|
| `01770618576` | Successful payment |
| `01929918378` | Successful payment |
| `01877722345` | Successful payment |
| `01619777282` | Successful payment |
| `01823074817` | **Fails** — insufficient balance |
| `01823074818` | **Fails** — debit blocked |

These are also displayed on the payment page itself when bKash sandbox is
active, so there is nothing to look up mid-demo.

### Known bKash quirks handled in the adapter

- **Error `2062` — "already completed."** Returned when `execute` is called
  twice, which happens whenever a customer refreshes the callback page. This is
  not a failure: the adapter falls back to the query endpoint and reconciles the
  real status instead of reporting an error.
- **CORS.** bKash blocks browser-origin requests entirely. Every call in this
  app is made server-side from `services/gateways/bkash.js`, which is both
  required and correct — the App Secret must never reach the frontend.
- **BDT only.** bKash settles exclusively in Bangladeshi Taka.

---

## Testing without internet

Both real sandboxes need outbound HTTPS. Where that is unavailable, the adapters
are covered by a mocked-transport suite:

```bash
npm run test:gateways     # 68 checks, no network required
```

It replays the exact response bodies both APIs return and asserts that the
adapters send the right fields to the right URLs, accept a genuine success, and
reject a tampered amount, a mismatched transaction ID, a wrong invoice number, a
non-completed status, and a missing validation ID.

For the end-to-end journey use the sandbox gateway:

```bash
npm run smoke             # 114 checks, no network required
```

---

## IPN (Instant Payment Notification)

Both real gateways can notify the server directly, independently of the
customer's browser — useful when someone closes the tab mid-payment. The handler
lives at `POST /payment/ipn` and verifies exactly like the redirect path does.

For IPN to fire, the gateway must be able to reach your `BASE_URL`, which
`localhost` is not. Expose it with a tunnel while developing:

```bash
ngrok http 3000
# then set BASE_URL=https://your-id.ngrok-free.app in .env and restart
```

Without a tunnel, everything still works — the redirect path handles
verification on its own. IPN is a safety net, not a dependency.

---

## Going live

1. Get production credentials from SSLCommerz or your bKash Relationship
   Manager.
2. Set `SSLCZ_IS_LIVE=true` or `BKASH_IS_LIVE=true` — the adapters swap to the
   production hosts automatically.
3. Set `BASE_URL` to the real HTTPS domain.
4. Set a long random `SESSION_SECRET`.
5. Confirm `.env` is gitignored and no credentials are committed.
6. Run one small real transaction end to end before opening bookings.
