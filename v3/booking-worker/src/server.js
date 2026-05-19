import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config, assertRuntimeConfig } from './config.js';
import { validateBookingRequest } from './validation.js';
import { finalizeWebtracCheckout, inspectCheckoutFlow, reserveWithWebtrac } from './webtrac.js';

const app = express();
const reserveJobs = new Map();
const checkoutJobs = new Map();
const RESERVE_JOB_TTL_MS = 30 * 60 * 1000;
const RESERVE_JOB_STORE_DIR = config.reserveJobStoreDir;
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
    browserRuntime: config.browserRuntimeLabel,
    remoteBrowserEnabled: config.remoteBrowserEnabled,
    browserlessEnabled: config.browserlessEnabled,
    browserConnectMode: config.browserConnectMode,
    browserConnectAttempts: config.browserConnectAttempts,
    browserlessTimeoutSeconds: config.browserlessTimeoutSeconds,
    browserlessProxyEnabled: config.browserlessProxyEnabled,
    reserveJobStore: RESERVE_JOB_STORE_DIR,
    workerBuild: 'persistent-webtrac-session-v1',
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

app.get('/reserve/status/:jobId', async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({
      status: 'rejected',
      code: 'UNAUTHORIZED',
      message: 'Missing or invalid booking worker token.',
    });
  }

  const job = reserveJobs.get(req.params.jobId) || await readReserveJob(req.params.jobId);
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

app.post('/checkout/finalize/start', async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({
      status: 'rejected',
      code: 'UNAUTHORIZED',
      message: 'Missing or invalid booking worker token.',
    });
  }

  try {
    assertRuntimeConfig();
    const job = enqueueCheckoutJob(req.body || {});
    return res.status(202).json({
      status: 'checkout_started',
      code: 'WEBTRAC_CHECKOUT_STARTED',
      message: 'Courtside is checking Arlington/WebTrac checkout.',
      jobId: job.id,
      pollAfterMs: 2000,
    });
  } catch (e) {
    res.status(e.code === 'MISSING_ENV' ? 500 : 502).json(errorPayload(e, 'WEBTRAC_FINALIZE_ERROR'));
  }
});

app.get('/checkout/finalize/status/:jobId', async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({
      status: 'rejected',
      code: 'UNAUTHORIZED',
      message: 'Missing or invalid booking worker token.',
    });
  }

  const job = checkoutJobs.get(req.params.jobId) || await readCheckoutJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({
      status: 'not_found',
      code: 'WEBTRAC_CHECKOUT_JOB_NOT_FOUND',
      message: 'Checkout job was not found or has expired.',
    });
  }

  if (job.status === 'queued' || job.status === 'running') {
    return res.status(202).json({
      status: 'checkout_running',
      code: 'WEBTRAC_CHECKOUT_RUNNING',
      message: 'Courtside is still checking Arlington/WebTrac checkout.',
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
  persistReserveJob(job);

  setTimeout(async () => {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.updatedAt = job.startedAt;
    await persistReserveJob(job);
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
      await persistReserveJob(job);
    }
  }, 0);

  return job;
}

function enqueueCheckoutJob(payload) {
  cleanupCheckoutJobs();
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
  checkoutJobs.set(job.id, job);
  persistCheckoutJob(job);

  setTimeout(async () => {
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.updatedAt = job.startedAt;
    await persistCheckoutJob(job);
    try {
      const result = await finalizeWebtracCheckout(payload);
      job.status = 'succeeded';
      job.result = result;
      job.statusCode = result.status === 'webtrac_confirmed' || result.status === 'webtrac_payment_ready' ? 200 : 502;
      console.log('[checkout:job]', {
        id: job.id,
        status: result.status,
        code: result.code,
        allowWebtracFinalPayment: config.allowWebtracFinalPayment,
      });
    } catch (e) {
      job.status = 'failed';
      job.result = errorPayload(e, 'WEBTRAC_FINALIZE_ERROR');
      job.statusCode = e.code === 'MISSING_ENV' || e.code === 'MISSING_PAYMENT_ENV' ? 500 : 502;
      console.log('[checkout:job:error]', {
        id: job.id,
        code: e.code,
        message: e.message || String(e),
      });
    } finally {
      job.finishedAt = new Date().toISOString();
      job.updatedAt = job.finishedAt;
      await persistCheckoutJob(job);
    }
  }, 0);

  return job;
}

async function persistReserveJob(job) {
  try {
    await fs.mkdir(RESERVE_JOB_STORE_DIR, { recursive: true });
    const target = reserveJobPath(job.id);
    const tmp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(job), 'utf8');
    await fs.rename(tmp, target);
  } catch (e) {
    console.warn('[reserve:job:persist_failed]', { id: job.id, message: e.message || String(e) });
  }
}

async function readReserveJob(id) {
  if (!/^[a-f0-9-]{20,}$/i.test(id || '')) return null;
  try {
    const text = await fs.readFile(reserveJobPath(id), 'utf8');
    const job = JSON.parse(text);
    const created = Date.parse(job.createdAt || '');
    if (Number.isFinite(created) && created < Date.now() - RESERVE_JOB_TTL_MS) {
      await fs.rm(reserveJobPath(id), { force: true });
      return null;
    }
    return job;
  } catch {
    return null;
  }
}

async function persistCheckoutJob(job) {
  try {
    await fs.mkdir(RESERVE_JOB_STORE_DIR, { recursive: true });
    const target = checkoutJobPath(job.id);
    const tmp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(job), 'utf8');
    await fs.rename(tmp, target);
  } catch (e) {
    console.warn('[checkout:job:persist_failed]', { id: job.id, message: e.message || String(e) });
  }
}

async function readCheckoutJob(id) {
  if (!/^[a-f0-9-]{20,}$/i.test(id || '')) return null;
  try {
    const text = await fs.readFile(checkoutJobPath(id), 'utf8');
    const job = JSON.parse(text);
    const created = Date.parse(job.createdAt || '');
    if (Number.isFinite(created) && created < Date.now() - RESERVE_JOB_TTL_MS) {
      await fs.rm(checkoutJobPath(id), { force: true });
      return null;
    }
    return job;
  } catch {
    return null;
  }
}

function reserveJobPath(id) {
  return path.join(RESERVE_JOB_STORE_DIR, `${id}.json`);
}

function checkoutJobPath(id) {
  return path.join(RESERVE_JOB_STORE_DIR, `checkout-${id}.json`);
}

function cleanupReserveJobs() {
  const cutoff = Date.now() - RESERVE_JOB_TTL_MS;
  for (const [id, job] of reserveJobs) {
    const created = Date.parse(job.createdAt || '');
    if (Number.isFinite(created) && created < cutoff) reserveJobs.delete(id);
  }
  cleanupReserveJobFiles(cutoff);
}

function cleanupCheckoutJobs() {
  const cutoff = Date.now() - RESERVE_JOB_TTL_MS;
  for (const [id, job] of checkoutJobs) {
    const created = Date.parse(job.createdAt || '');
    if (Number.isFinite(created) && created < cutoff) checkoutJobs.delete(id);
  }
  cleanupReserveJobFiles(cutoff);
}

async function cleanupReserveJobFiles(cutoff) {
  try {
    const entries = await fs.readdir(RESERVE_JOB_STORE_DIR, { withFileTypes: true });
    await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map(async (entry) => {
        const target = path.join(RESERVE_JOB_STORE_DIR, entry.name);
        try {
          const stat = await fs.stat(target);
          if (stat.mtimeMs < cutoff) await fs.rm(target, { force: true });
        } catch {
          // Best-effort cleanup only.
        }
      }));
  } catch {
    // The store is created lazily on the first reserve job.
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
