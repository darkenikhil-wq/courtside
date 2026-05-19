import 'dotenv/config';

const port = Number(process.env.PORT || 8787);
const token = process.env.BOOKING_WORKER_TOKEN || 'dev-local-token';
const maxSteps = Number(process.argv[2] || 6);

const res = await fetch(`http://localhost:${port}/checkout/inspect`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  },
  body: JSON.stringify({ maxSteps }),
});

const body = await res.json().catch(async () => ({ raw: await res.text() }));
console.log(JSON.stringify({
  httpStatus: res.status,
  code: body.code,
  message: body.message,
  stopReason: body.stopReason,
  steps: (body.steps || []).map((step) => ({
    step: step.step,
    title: step.title,
    url: step.url,
    markers: step.markers,
    controls: step.controls,
    nextAction: step.nextAction,
  })),
}, null, 2));
