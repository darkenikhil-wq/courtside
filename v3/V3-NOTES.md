# Courtside v3 Notes

## What v3 changes

- Keeps the user inside Courtside for the primary booking action.
- Validates Arlington rules before attempting a booking:
  - reservations must be at least 24 hours ahead
  - reservations can be no more than 14 days ahead
  - online court blocks are 60 or 90 minutes
  - reservations must fit between 8:00 AM and 9:00 PM
- Makes availability duration-aware. A 60-minute booking requires two consecutive 30-minute blocks; a 90-minute booking requires three.
- Adds `/.netlify/functions/reserve` as the server-side booking boundary.

## Current blocker

The existing WebTrac `UpdateSelection` URLs are AJAX endpoints. Prior testing showed that even after WebTrac session priming, opening one as a browser navigation returns raw JSON instead of a normal cart page. A fully invisible booking flow therefore needs a server-side WebTrac booking adapter that can run inside an authenticated WebTrac session and call those endpoints as WebTrac's own page would.

## Adapter hook

Set these Netlify environment variables when the real booking agent exists:

```text
WEBTRAC_BOOKING_ADAPTER_URL=https://your-booking-agent.example.com/reserve
WEBTRAC_BOOKING_ADAPTER_TOKEN=...
```

Until then, `reserve.js` returns `WEBTRAC_BOOKING_ADAPTER_REQUIRED` and the v3 UI reveals the manual fallback link for testing.

## QA shortcut

For the separate Netlify QA site, set this environment variable:

```text
BOOKING_QA_MODE=true
```

That makes `/.netlify/functions/reserve` accept valid booking requests with a
clear dry-run message. It does not call WebTrac and does not touch a cart. Use it
only on QA, then remove it before testing the real booking adapter.

## Payment scaffold

The first Stripe pass is test-mode only. After the WebTrac worker confirms an
item in the cart, Courtside can show a Stripe Payment Element for Apple Pay/card
authorization. It intentionally does not submit WebTrac final checkout/payment.

Set these on the QA Netlify site:

```text
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_SECRET_KEY=sk_test_...
```

The PaymentIntent uses manual capture so the product flow can authorize payment
first, then complete WebTrac checkout later behind an explicit confirmation and
failure/refund guard.

The booking screen now rotates disclosure text while waiting: booking is through
Arlington County Parks & Recreation/WebTrac, Arlington confirmation/policies
apply, cancellation/refund requests go through Arlington DPR/Facilities
Scheduling, and checkout/payment remains paused until explicit confirmation.

## Local booking worker POC

The first Playwright proof of concept lives in:

```text
booking-worker/
```

It is designed to use a private WebTrac account through environment variables:

```text
WEBTRAC_USERNAME=...
WEBTRAC_PASSWORD=...
DRY_RUN=true
```

Start with `DRY_RUN=true`. That proves login, navigation, and live slot
selection URL handling without mutating the WebTrac cart. Only switch
`DRY_RUN=false` once you are intentionally testing add-to-cart behavior.
