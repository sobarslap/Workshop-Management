# Manual test checklist

Automated coverage lives in `scripts/smoke-test.js` (`npm run smoke`, 114
checks). This document is the by-hand walkthrough for a demo or viva, in the
order that shows the system off best.

Start clean:

```bash
npm run reset-db
npm run seed
npm start
```

---

## 1. Expression of interest

1. Open `/eoi`.
2. Submit with a blank name → the form redisplays with an error and keeps what
   you typed.
3. Submit properly. You land on a confirmation page naming the workshop.
4. **Check the acknowledgment email**: open the newest file in `data/outbox/`
   in a browser. It is a real rendered HTML email.
5. The enquiry now appears under Admin → Enquiries with status `New`.

## 2. Public catalogue

1. Open `/workshops`. Each card shows the date, price, a seat meter and seats
   remaining.
2. Search for `leadership`; filter by level; sort by price. Filters combine.
3. Filter by "Almost full" — only workshops at ≥75% capacity remain.
4. Click a card for the detail page: full description, venue, instructor,
   what's included, and a sticky booking panel.

## 3. Login is mandatory before booking

1. While logged out, go to `/book/1` directly.
2. You are redirected to `/login` with "Please log in to continue."
3. Log in. You are sent **back to the booking page**, not to the home page.

## 4. Registration and the login features

1. Register with password `abc` → rejected, too short.
2. Register with mismatched passwords → rejected.
3. Watch the strength meter as you type a good password.
4. Register properly with **Keep me logged in** ticked.
5. Admin → Account → "Remembered devices" lists that session.

**Password reset:**

1. Log out. Go to `/login` → "Forgot password?".
2. Enter an address that does not exist → the same "Check your inbox" response.
   The endpoint deliberately cannot be used to discover who has an account.
3. Enter your real address. The reset link is printed to the server console and
   saved in `data/outbox/`.
4. Open the link, set a new password.
5. Try the link a second time → rejected, single use.
6. Log in with the old password → fails. New password → works.

**Throttling:** enter a wrong password 5 times. The account locks and the
message counts down the remaining attempts before it does.

## 5. Booking and capacity

1. Book a workshop. Enter a *different* attendee's details to show that booking
   on someone else's behalf works.
2. You land on the payment page with a live seat-hold countdown.
3. Open `/my-bookings` in another tab — the booking shows as `Pending`.
4. Go back and try to book the same workshop again → you are returned to the
   existing booking rather than creating a duplicate.

**To demonstrate a full workshop:** Admin → Workshops → edit any workshop and
set capacity to match the number already booked. The public listing immediately
shows "Fully booked" and the booking button becomes a waitlist link.

## 6. Payment — all three outcomes

From the payment page, click "Pay …". You reach the gateway's own checkout page,
which deliberately looks nothing like the site — that visual break is what tells
a real customer they have left the merchant.

| Button | Result |
|---|---|
| **Pay** | Booking → `Paid`, confirmation page, receipt email |
| **Simulate decline** | Booking → `Failed`, retry offered |
| **Cancel payment** | Booking → `Cancelled`, seat released |

After a successful payment:

- The confirmation page shows the reference, transaction ID and payment method.
- "Download receipt" opens a printable receipt — use the browser's *Save as PDF*.
- `data/outbox/` contains the confirmation email.
- Admin → booking detail shows the full audit trail of every payment event.

**To prove payments are verified, not assumed**, visit this URL manually with a
real `tran_id` from an unpaid booking:

```
/payment/success?tran_id=CW-XXXXXX&val_id=I-MADE-THIS-UP
```

The booking is marked `Failed` with "Transaction could not be found at the
gateway" — the forged redirect is not believed.

## 7. Admin dashboard

1. Log in as `admin@workshops.com` / `admin123`.
2. Stat cards show revenue, bookings, conversion rate and outstanding enquiries.
3. **Registrations tab**: filter by workshop, date, payment status; search by
   attendee, company or reference. Export the filtered set to CSV.
4. Change a booking's status inline from the table.
5. Open a booking's detail page for the payment audit trail and refund button.
6. **Workshops tab**: seat meters per workshop, roster CSV download.
7. **Enquiries tab**: move an enquiry through New → Contacted → Converted.

## 8. Admin workshop management

1. Create a workshop. Leave the title blank → rejected. Set an end time before
   the start time → rejected.
2. Create it properly. It appears on the public catalogue immediately.
3. Edit it. Try setting capacity below the number already booked → rejected,
   with the exact number that blocks it.
4. Cancel it → disappears from the public listing, and everyone holding a seat
   is emailed (check `data/outbox/`).
5. Re-activate it → back on the listing.

## 9. Access control

| Attempt | Expected |
|---|---|
| `/admin/dashboard` logged out | redirect to `/login` |
| `/admin/dashboard` as a normal user | 403 page |
| Another user's `/booking/:id/confirmation` | redirect to `/my-bookings` |
| `/nonexistent` | styled 404 |

## 10. Responsive design

Resize to ~380px wide, or use device emulation:

- The navigation collapses to a hamburger — and it works with JavaScript
  disabled, because it is a CSS checkbox rather than a script.
- Workshop grids drop 3-up → 2-up → 1-up.
- Tables scroll horizontally instead of breaking the layout.
- The sticky booking sidebar becomes a normal block.

Turn JavaScript off entirely: every form, every page and the whole booking and
payment flow still work. The JavaScript only adds the password reveal, strength
meter, countdown and copy button.
