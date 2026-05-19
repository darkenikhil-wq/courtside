exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Use POST' });
  }

  const secretKey = process.env.STRIPE_SECRET_KEY || '';
  if (!secretKey) {
    return jsonResponse(501, {
      status: 'not_configured',
      code: 'STRIPE_NOT_CONFIGURED',
      message: 'Stripe test mode is not configured yet.',
    });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  const amount = Number(body.amountCents);
  if (!Number.isInteger(amount) || amount < 50 || amount > 50000) {
    return jsonResponse(400, {
      status: 'rejected',
      code: 'BAD_AMOUNT',
      message: 'Payment amount is outside the allowed test range.',
    });
  }

  const booking = body.booking && typeof body.booking === 'object' ? body.booking : {};
  const purpose = body.purpose === 'support' ? 'support' : 'court_booking';
  const captureMethod = purpose === 'support' && body.captureMethod === 'automatic' ? 'automatic' : 'manual';
  const params = new URLSearchParams();
  params.set('amount', String(amount));
  params.set('currency', 'usd');
  params.set('capture_method', captureMethod);
  params.set('automatic_payment_methods[enabled]', 'true');
  params.set('description', purpose === 'support' ? 'Courtside support payment' : 'Courtside court booking authorization');
  params.set('metadata[purpose]', purpose);
  params.set('metadata[capture_method]', captureMethod);
  params.set('metadata[source]', 'courtside-v3-qa');
  if (purpose === 'court_booking') {
    params.set('metadata[court]', String(booking.courtName || booking.courtCode || '').slice(0, 120));
    params.set('metadata[date]', String(booking.date || '').slice(0, 20));
    params.set('metadata[start]', String(booking.start || '').slice(0, 20));
  }

  const stripeRes = await fetch('https://api.stripe.com/v1/payment_intents', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  const payload = await stripeRes.json().catch(() => ({}));
  if (!stripeRes.ok) {
    return jsonResponse(stripeRes.status, {
      status: 'stripe_error',
      code: payload.error && payload.error.code || 'STRIPE_ERROR',
      message: payload.error && payload.error.message || 'Stripe rejected the payment intent.',
    });
  }

  return jsonResponse(200, {
    status: payload.status,
    paymentIntentId: payload.id,
    clientSecret: payload.client_secret,
  });
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify(body),
  };
}
