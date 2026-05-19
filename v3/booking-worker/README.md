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

## Modes

- `DRY_RUN=true`: logs in, opens the WebTrac search page, and verifies that
  Courtside supplied live selection URLs. It does not add anything to cart.
- `DRY_RUN=false`: calls WebTrac's `UpdateSelection` endpoints from inside the
  authenticated WebTrac origin and then reloads the search page. This may add
  slots to the WebTrac cart, but it does not finalize checkout.
- Keep `HEADLESS=false` for local QA. WebTrac may show bot verification to
  headless browser sessions.

Do not automate final checkout/payment until we inspect the live confirmation
step and add an explicit separate guard for it.

## Connecting v3

For local testing, expose this service or run a small tunnel, then set the v3
Netlify function environment variables:

```text
WEBTRAC_BOOKING_ADAPTER_URL=http://localhost:8787/reserve
WEBTRAC_BOOKING_ADAPTER_TOKEN=<same as BOOKING_WORKER_TOKEN>
```

For deployment, use Render/Fly/Railway instead of Netlify Functions because
Playwright browser automation is too heavy and slow for the current static
site/function setup.
