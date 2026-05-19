import express from 'express';
import crypto from 'node:crypto';
import { config, assertRuntimeConfig } from './config.js';
import { validateBookingRequest } from './validation.js';
import { finalizeWebtracCheckout, inspectCheckoutFlow, reserveWithWebtrac } from './webtrac.js';

const app = express();
const reserveJobs = new Map();
const RESERVE_JOB_TTL_MS = 30 * 60 * 1000;
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
    browserProfile: 'browser-like-v1',
    browserRuntime: config.browserWsEndpoint ? `remote:${config.browserConnectMode}` : 'local',
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
      details: e.details,
    });
  }
});

app.post('/reserve/start', async (req, res) => {
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
    const job = enqueueReserveJob(req.body);
    return res.status(202).json({
      status: 'booking_started',
      code: 'WEBTRAC_BOOKING_STARTED',
      message: 'Courtside is working through Arlington/WebTrac. This can take a minute.',
      jobId: job.id,
      pollAfterMs: 2000,
    });
  } catch (e) {
    res.status(e.code === 'MISSING_ENV' ? 500 : 502).json(errorPayload(e, 'WEBTRAC_WORKER_ERROR'));
  }
});

app.get('/reserve/status/:jobId', (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({
      status: 'rejected',
      code: 'UNAUTHORIZED',
      message: 'Missing or invalid booking worker token.',
    });
  }

  const job = reserveJobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({
      status: 'not_found',
      code: 'WEBTRAC_BOOKING_JOB_NOT_FOUND',
      message: 'Booking job was not found or has expired.',
    });
  }

  if (job.status === 'queued' || job.status === 'running') {
    return res.status(202).json({
      status: 'booking_running',
      code: 'WEBTRAC_BOOKING_RUNNING',
      message: 'Courtside is still working through Arlington/WebTrac.',
      jobId: job.id,
      jobStatus: job.status,
      pollAfterMs: 2000,
      startedAt: job.startedAt || null,
      updatedAt: job.updatedAt,
    });
  }

  const statusCode = job.statusCode || (job.status === 'failed' ? 502 : 200);
  return res.status(statusCode).json({
    ...job.result,
    jobId: job.id,
    jobStatus: job.status,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
  });
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
      details: e.details,
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
      details: e.details,
    });
  }
});

app.listen(config.port, () => {
  console.log(`Courtside booking worker listening on http://localhost:${config.port}`);
  console.log(`DRY_RUN=${config.dryRun} HEADLESS=${config.headless}`);
});

function enqueueReserveJob(payload) {
  cleanupReserveJobs();
  const job = {
    id: crypto.randomUUID(),
    status: 'queued',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    result: null,
    statusCode: 202,
  };
  reserveJobs.set(job.id, job);

  setTimeout(async () => {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.updatedAt = job.startedAt;
    try {
      const result = await reserveWithWebtrac(payload);
      job.status = 'succeeded';
      job.result = result;
      job.statusCode = result.status === 'cart_update_uncertain' ? 502 : 200;
      console.log('[reserve:job]', {
        id: job.id,
        status: result.status,
        code: result.code,
        selectionSource: result.selectionSource,
      });
    } catch (e) {
      job.status = 'failed';
      job.result = errorPayload(e, 'WEBTRAC_WORKER_ERROR');
      job.statusCode = e.code === 'MISSING_ENV' ? 500 : 502;
      console.log('[reserve:job:error]', {
        id: job.id,
        code: e.code,
        message: e.message || String(e),
      });
    } finally {
      job.finishedAt = new Date().toISOString();
      job.updatedAt = job.finishedAt;
    }
  }, 0);

  return job;
}

function cleanupReserveJobs() {
  const cutoff = Date.now() - RESERVE_JOB_TTL_MS;
  for (const [id, job] of reserveJobs) {
    const created = Date.parse(job.createdAt || '');
    if (Number.isFinite(created) && created < cutoff) reserveJobs.delete(id);
  }
}

function errorPayload(e, fallbackCode) {
  return {
    status: 'worker_error',
    code: e.code || fallbackCode,
    message: e.message || String(e),
    missing: e.missing,
    details: e.details,
  };
}

function isAuthorized(req) {
  if (!config.workerToken) return false;
  const auth = req.get('authorization') || '';
  return auth === `Bearer ${config.workerToken}`;
}
