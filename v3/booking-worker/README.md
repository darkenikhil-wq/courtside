# Courtside Booking Worker

Private proof-of-concept service for invisible WebTrac booking.

This worker uses your WebTrac account through Playwright. Keep it local and in
`DRY_RUN=true` until login, navigation, and slot detection are proven.

## Easiest QA path

For the uploaded Netlify QA site, you can test the in-app reservation flow
without running this worker yet. In the QA Netlify site only, set:

```text
BOOKING_QA_MODE=true
```

Redeploy QA, then click through a booking in the QA app. The app should show a
successful QA response, but no WebTrac cart is changed.

Remove `BOOKING_QA_MODE` before using the real booking adapter.

## Setup

```bash
cd /Users/ndarke/arlington-tennis/v3/booking-worker
cp .env.example .env
```

Fill in `.env` locally:

```text
BOOKING_WORKER_TOKEN=choose-a-long-random-token
WEBTRAC_USERNAME=your-webtrac-login
WEBTRAC_PASSWORD=your-webtrac-password
DRY_RUN=true
HEADLESS=false
CHROME_EXECUTABLE_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
```

Do not commit `.env`.

Then install dependencies:

```bash
npm install
```

If you do not have Google Chrome installed, run `npx playwright install chromium`.
That download is large; using system Chrome is lighter for local testing.

Run:

```bash
npm run doctor
npm run start
```

If local disk space gets tight after browser runs:

```bash
npm run clean
```

Smoke test from another terminal:

```bash
npm run smoke
```

After a court is in the WebTrac cart, inspect the remaining checkout path
without entering or submitting payment. This opens the payment-method selector
only far enough to report the available choices, chooses `Credit Card - Web`,
and stops on the card-entry screen:

```bash
npm run inspect:checkout
```

To test the final checkout runner without submitting Arlington/WebTrac payment,
fill the private payment fields in `.env` and run:

```bash
npm run finalize:checkout -- --stop-before-submit
```

Actual final WebTrac payment is guarded. It will only click the final WebTrac
continue/payment action when all of these are true:

```text
DRY_RUN=false
ALLOW_WEBTRAC_FINAL_PAYMENT=true
```

The v3 app now authorizes Stripe first, asks this worker to finish WebTrac, then
captures Stripe only if WebTrac returns `webtrac_confirmed`. If WebTrac fails or
the guard is still off, the Stripe authorization is released.

## Modes

- `DRY_RUN=true`: logs in, opens the WebTrac search page, and verifies that
  Courtside supplied live selection URLs. It does not add anything to cart.
- `DRY_RUN=false`: calls WebTrac's `UpdateSelection` endpoints from inside the
  authenticated WebTrac origin and then reloads the search page. This may add
  slots to the WebTrac cart, but final checkout still requires the separate
  `ALLOW_WEBTRAC_FINAL_PAYMENT=true` guard.
- `WEBTRAC_CLEAR_CART_BEFORE_RESERVE=true`: clears stale WebTrac cart items
  before adding the newly requested court. Keep this on while one Courtside
  request maps to one WebTrac reservation.
- Keep `HEADLESS=false` for local QA. WebTrac may show bot verification to
  headless browser sessions.

The worker also checks the WebTrac cart against the requested court, date, start,
and end time before showing payment or finalizing checkout. If the cart looks
like an earlier test, it stops before payment with `WEBTRAC_CART_MISMATCH`.

## Cloud worker

The local worker was useful for reverse-engineering WebTrac, but it should not
be the production runtime. Use GitHub as the source of truth, then deploy this
folder as a Docker web service on Render, Fly, Railway, or another small VM.

This folder includes:

- `Dockerfile`: Playwright/Chromium runtime for the worker.
- `render.yaml`: Render blueprint with safe defaults and secret placeholders.

For Render:

1. Create a new Blueprint or Web Service from the GitHub repo.
2. Set the root directory to `v3/booking-worker`.
3. Use Docker runtime.
4. Add the secret env vars from `.env.example` in Render, not in GitHub.
5. Keep `ALLOW_WEBTRAC_FINAL_PAYMENT=false` until cart matching and payment
   filling have been tested from the cloud worker.

Cloud default is `HEADLESS=true`. The Docker image runs Chromium inside the
Render worker, so Browserless/local Mac disk space is not part of the normal
booking path. If WebTrac presents reCAPTCHA, the worker will stop before final
payment with `WEBTRAC_RECAPTCHA_REQUIRED`; do not try to bypass it. A
production-grade version may need a hosted browser with a live operator view if
WebTrac requires interactive verification.

If WebTrac/Cloudflare blocks the Render browser before the login page loads,
keep the Netlify app pointed at this worker but explicitly opt into a managed
hosted-browser endpoint:

```text
REMOTE_BROWSER_ENABLED=true
PLAYWRIGHT_WS_ENDPOINT=wss://<hosted-browser-endpoint>
PLAYWRIGHT_CONNECT_MODE=cdp
PLAYWRIGHT_CONNECT_TIMEOUT_MS=60000
```

That keeps the Courtside API flow the same while replacing Render's local
Chromium/IP profile, which is the part WebTrac is currently rejecting.

For Browserless, you can either paste the full WebSocket URL into
`PLAYWRIGHT_WS_ENDPOINT`, or set the shortcut vars and let the worker build the
standard Chrome endpoint:

```text
REMOTE_BROWSER_ENABLED=true
BROWSERLESS_ENABLED=true
BROWSERLESS_TOKEN=<browserless-api-token>
BROWSERLESS_REGION=sfo
BROWSERLESS_ROUTE=chrome
BROWSERLESS_STEALTH=false
PLAYWRIGHT_CONNECT_MODE=cdp
```

If WebTrac blocks the hosted browser's datacenter IP and your Browserless plan
supports it, enable Browserless' proxy settings deliberately:

```text
BROWSERLESS_PROXY_ENABLED=true
BROWSERLESS_PROXY=residential
BROWSERLESS_PROXY_COUNTRY=us
BROWSERLESS_PROXY_STICKY=true
BROWSERLESS_PROXY_PRESET=px_gov01
```

## Connecting v3

For local testing, expose this service or run a small tunnel, then set the v3
Netlify function environment variables:

```text
WEBTRAC_BOOKING_ADAPTER_URL=http://localhost:8787/reserve
WEBTRAC_BOOKING_ADAPTER_TOKEN=<same as BOOKING_WORKER_TOKEN>
```

For the cloud worker, replace the local URL with the hosted worker URL:

```text
WEBTRAC_BOOKING_ADAPTER_URL=https://<worker-host>/reserve
WEBTRAC_BOOKING_ADAPTER_TOKEN=<same as BOOKING_WORKER_TOKEN>
WEBTRAC_FINALIZE_ADAPTER_URL=https://<worker-host>/checkout/finalize
WEBTRAC_FINALIZE_ADAPTER_TOKEN=<same as BOOKING_WORKER_TOKEN>
```

The finalizer function derives the checkout URL from the reserve URL above. You
can also set it explicitly:

```text
WEBTRAC_FINALIZE_ADAPTER_URL=http://localhost:8787/checkout/finalize
WEBTRAC_FINALIZE_ADAPTER_TOKEN=<same as BOOKING_WORKER_TOKEN>
```

Stripe also needs these Netlify variables:

```text
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_SECRET_KEY=sk_test_...
```

For deployment, use Render/Fly/Railway instead of Netlify Functions because
Playwright browser automation is too heavy and slow for the current static
site/function setup.
