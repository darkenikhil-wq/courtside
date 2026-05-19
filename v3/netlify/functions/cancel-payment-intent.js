exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Use POST' });
  }

  const secretKey = process.env.STRIPE_SECRET_KEY || '';
  if (!secretKey) {
    return jsonResponse(501, {
      status: 'not_configured',
      code: 'STRIPE_NOT_CONFIGURED',
      message: 'Stripe is not configured.',
    });
  }

  const body = parseJson(event.body);
  if (!body.ok) return jsonResponse(400, { error: 'Invalid JSON body' });

  const paymentIntentId = String(body.value.paymentIntentId || '');
  if (!/^pi_[A-Za-z0-9_]+$/.test(paymentIntentId)) {
    return jsonResponse(400, {
      status: 'rejected',
      code: 'BAD_PAYMENT_INTENT',
      message: 'Missing or invalid Stripe payment intent.',
    });
  }

  const intent = await retrievePaymentIntent(secretKey, paymentIntentId);
  if (!intent.ok) return jsonResponse(intent.statusCode, intent.body);
  if (intent.body.status !== 'requires_capture' || intent.body.metadata?.purpose !== 'court_booking') {
    return jsonResponse(409, {
      status: 'rejected',
      code: 'PAYMENT_AUTHORIZATION_NOT_CANCELABLE',
      message: 'Stripe authorization is not a pending court-booking authorization.',
      payment: {
        status: intent.body.status,
        paymentIntentId: intent.body.id,
      },
    });
  }

  const params = new URLSearchParams();
  if (body.value.reason) {
    params.set('cancellation_reason', 'requested_by_customer');
  }

  const stripeRes = await fetch(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(paymentIntentId)}/cancel`, {
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
      code: payload.error && payload.error.code || 'STRIPE_CANCEL_ERROR',
      message: payload.error && payload.error.message || 'Stripe could not release the authorization.',
    });
  }

  return jsonResponse(200, {
    status: payload.status,
    paymentIntentId: payload.id,
    cancellationReason: payload.cancellation_reason,
  });
};

async function retrievePaymentIntent(secretKey, paymentIntentId) {
  const res = await fetch(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(paymentIntentId)}`, {
    headers: {
      'Authorization': `Bearer ${secretKey}`,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false,
      statusCode: res.status,
      body: {
        status: 'stripe_error',
        code: body.error && body.error.code || 'STRIPE_RETRIEVE_ERROR',
        message: body.error && body.error.message || 'Stripe could not verify the payment authorization.',
      },
    };
  }
  return { ok: true, statusCode: 200, body };
}

function parseJson(raw) {
  try {
    return { ok: true, value: JSON.parse(raw || '{}') };
  } catch (e) {
    return { ok: false, value: null };
  }
}

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
