import 'dotenv/config';

const port = Number(process.env.PORT || 8787);
const token = process.env.BOOKING_WORKER_TOKEN || 'dev-local-token';

const res = await fetch(`http://localhost:${port}/checkout/finalize`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  },
  body: JSON.stringify({ stopBeforeSubmit: process.argv.includes('--stop-before-submit') }),
});

const body = await res.json().catch(async () => ({ raw: await res.text() }));
console.log(JSON.stringify({
  httpStatus: res.status,
  status: body.status,
  code: body.code,
  message: body.message,
  requiresFinalPaymentGuard: body.requiresFinalPaymentGuard,
  fillResult: body.fillResult,
  recaptcha: body.recaptcha,
  confirmation: body.confirmation,
}, null, 2));
