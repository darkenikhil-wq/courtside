import express from 'express';
import { config, assertRuntimeConfig } from './config.js';
import { validateBookingRequest } from './validation.js';
import { finalizeWebtracCheckout, inspectCheckoutFlow, reserveWithWebtrac } from './webtrac.js';

const app = express();
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});
app.use(express.json({ limit: '128kb' }));

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    dryRun: config.dryRun,
    headless: config.headless,
  });
});

app.post('/reserve', async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({
      status: 'rejected',
      code: 'UNAUTHORIZED',
      message: 'Missing or invalid booking worker token.',
    });
  }

  const validation = validateBookingRequest(req.body);
  if (!validation.ok) {
    return res.status(400).json({
      status: 'rejected',
      code: validation.code,
      message: validation.message,
    });
  }

  try {
    assertRuntimeConfig();
    const result = await reserveWithWebtrac(req.body);
    console.log('[reserve]', {
      status: result.status,
      code: result.code,
      selectionSource: result.selectionSource,
      addToCart: result.addToCartResult,
      prompts: result.promptResults,
      cart: result.cartState && {
        confirmed: result.cartState.confirmed,
        itemCount: result.cartState.itemCount,
        grandTotal: result.cartState.grandTotal,
        amountToday: result.cartState.amountToday,
      },
    });
    const statusCode = result.status === 'cart_update_uncertain' ? 502 : 200;
    res.status(statusCode).json(result);
  } catch (e) {
    res.status(e.code === 'MISSING_ENV' ? 500 : 502).json({
      status: 'worker_error',
      code: e.code || 'WEBTRAC_WORKER_ERROR',
      message: e.message || String(e),
      missing: e.missing,
    });
  }
});

app.post('/checkout/inspect', async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({
      status: 'rejected',
      code: 'UNAUTHORIZED',
      message: 'Missing or invalid booking worker token.',
    });
  }

  try {
    assertRuntimeConfig();
    const result = await inspectCheckoutFlow(req.body || {});
    console.log('[checkout:inspect]', {
      code: result.code,
      stopReason: result.stopReason,
      steps: result.steps.map((step) => ({
        step: step.step,
        title: step.title,
        url: step.url,
        markers: step.markers,
        nextAction: step.nextAction,
      })),
    });
    res.json(result);
  } catch (e) {
    res.status(e.code === 'MISSING_ENV' ? 500 : 502).json({
      status: 'worker_error',
      code: e.code || 'WEBTRAC_CHECKOUT_INSPECTION_ERROR',
      message: e.message || String(e),
      missing: e.missing,
    });
  }
});

app.post('/checkout/finalize', async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({
      status: 'rejected',
      code: 'UNAUTHORIZED',
      message: 'Missing or invalid booking worker token.',
    });
  }

  try {
    assertRuntimeConfig();
    const result = await finalizeWebtracCheckout(req.body || {});
    console.log('[checkout:finalize]', {
      status: result.status,
      code: result.code,
      allowWebtracFinalPayment: config.allowWebtracFinalPayment,
      fill: result.fillResult,
      recaptcha: result.recaptcha,
      confirmation: result.confirmation && {
        confirmed: result.confirmation.confirmed,
        confirmationId: result.confirmation.confirmationId,
        hasErrorText: result.confirmation.hasErrorText,
      },
    });
    const statusCode = result.status === 'webtrac_confirmed' || result.status === 'webtrac_payment_ready' ? 200 : 502;
    res.status(statusCode).json(result);
  } catch (e) {
    res.status(e.code === 'MISSING_ENV' || e.code === 'MISSING_PAYMENT_ENV' ? 500 : 502).json({
      status: 'worker_error',
      code: e.code || 'WEBTRAC_FINALIZE_ERROR',
      message: e.message || String(e),
      missing: e.missing,
    });
  }
});

app.listen(config.port, () => {
  console.log(`Courtside booking worker listening on http://localhost:${config.port}`);
  console.log(`DRY_RUN=${config.dryRun} HEADLESS=${config.headless}`);
});

function isAuthorized(req) {
  if (!config.workerToken) return false;
  const auth = req.get('authorization') || '';
  return auth === `Bearer ${config.workerToken}`;
}
