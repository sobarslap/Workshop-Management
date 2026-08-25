# AI usage declaration

## Summary

Generative AI (Anthropic's Claude) was used as a development assistant on this
project. It was used for implementation, refactoring and documentation. The
requirements, architectural decisions, testing and final verification were
directed and reviewed by me.

## Where AI was used

| Area | Extent |
|---|---|
| Route handlers and business logic in `server.js` | Substantial — drafted with AI, reviewed and corrected |
| Payment gateway adapters (`services/gateways/*`) | Substantial — written against the published SSLCommerz v4 and bKash Tokenized Checkout API documentation |
| Authentication extras (`services/auth.js`) | Substantial — the selector/validator and reset-token designs are standard patterns, implemented with AI assistance |
| CSS design system (`public/css/style.css`) | Substantial — generated from the design token specification in `docs/DESIGN.md` |
| EJS templates | Substantial |
| Smoke test suite (`scripts/smoke-test.js`) | Substantial |
| Documentation (`README.md`, this file) | Substantial |
| Database schema design | Collaborative — table structure decided by me, DDL written with AI |

## Tooling

- **Claude (Anthropic)** — code generation, refactoring, documentation.
- **`npx getdesign@latest add vercel`** — generated `docs/DESIGN.md`, the design
  token specification the stylesheet was built from. The visual design language
  is derived from that generated specification.

## What was not AI-generated

- The project requirements and feature scope.
- The choice of stack (Express, EJS, SQLite) and the overall architecture.
- The decision to abstract payments behind a provider interface and to include a
  self-hosted sandbox gateway so the project runs without credentials.
- All testing, verification and debugging decisions.

## Verification performed

AI-generated code was not accepted on trust. Specifically:

- The full 114-check smoke suite was written and run against the real server.
  It found and led to fixes for three genuine defects:
  1. Flash messages were silently dropped whenever a handler set one and then
     rendered in the same request — this broke every validation message on the
     register, login and workshop forms.
  2. `req.body` is `undefined` on GET requests in Express 5, which crashed the
     booking authorisation check with a 500 error.
  3. Two test assertions were themselves wrong (HTML-escaped apostrophes), which
     was confirmed by inspecting the rendered output rather than loosening the
     tests blindly.
- Every page was fetched over HTTP and checked for unrendered template tags,
  `undefined` leaking into output, and object-to-string leaks.
- Payment verification was tested adversarially by forging gateway callbacks.
- Capacity enforcement was tested under real concurrency.

## Academic integrity

I understand the material in this submission and can explain any part of it on
request, including the capacity-transaction logic, the payment verification
model, and the authentication token design.
