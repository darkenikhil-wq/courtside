exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return jsonResponse(204, {});
  }
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
  if (!intent.ok) {
    return jsonResponse(intent.statusCode, intent.body);
  }
  if (intent.body.status !== 'requires_capture' || intent.body.metadata?.purpose !== 'court_booking') {
    return jsonResponse(409, {
      status: 'rejected',
      code: 'PAYMENT_AUTHORIZATION_NOT_READY',
      message: 'Stripe authorization is not ready for court-booking capture, so WebTrac checkout was not attempted.',
      payment: {
        status: intent.body.status,
        paymentIntentId: intent.body.id,
      },
    });
  }

  const finalizeUrl = finalizerUrl();
  if (!finalizeUrl) {
    const payment = await cancelPaymentIntent(secretKey, paymentIntentId, 'adapter_not_configured');
    return jsonResponse(501, {
      status: 'not_configured',
      code: 'WEBTRAC_FINALIZE_ADAPTER_REQUIRED',
      message: 'Final WebTrac checkout worker is not configured. Stripe authorization was released.',
      payment,
    });
  }

  let webtrac;
  try {
    const headers = { 'Content-Type': 'application/json' };
    const token = process.env.WEBTRAC_FINALIZE_ADAPTER_TOKEN || process.env.WEBTRAC_BOOKING_ADAPTER_TOKEN || '';
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(finalizeUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        booking: body.value.booking || null,
        paymentIntentId,
        requestedAt: Date.now(),
      }),
    });
    const text = await res.text();
    try { webtrac = JSON.parse(text); }
    catch (e) { webtrac = { status: res.ok ? 'accepted' : 'adapter_error', message: text }; }
    webtrac.httpStatus = res.status;
  } catch (e) {
    webtrac = {
      status: 'adapter_unreachable',
      code: 'WEBTRAC_FINALIZE_ADAPTER_UNREACHABLE',
      message: String(e && e.message || e),
    };
  }

  if (webtrac.status === 'webtrac_confirmed') {
    const payment = await capturePaymentIntent(secretKey, paymentIntentId);
    if (payment.ok) {
      return jsonResponse(200, {
        status: 'confirmed',
        code: 'BOOKING_CONFIRMED_PAYMENT_CAPTURED',
        message: 'Court booked through Arlington/WebTrac. Payment captured.',
        webtrac: summarizeWebtrac(webtrac),
        payment: payment.body,
      });
    }

    return jsonResponse(502, {
      status: 'payment_capture_failed',
      code: payment.body.code || 'STRIPE_CAPTURE_ERROR',
      message: 'WebTrac appears confirmed, but Stripe capture failed. Review this booking manually.',
      webtrac: summarizeWebtrac(webtrac),
      payment: payment.body,
    });
  }

  const payment = await cancelPaymentIntent(secretKey, paymentIntentId, webtrac.code || 'webtrac_not_confirmed');
  return jsonResponse(webtrac.httpStatus && webtrac.httpStatus < 500 ? 409 : 502, {
    status: 'webtrac_not_confirmed',
    code: webtrac.code || 'WEBTRAC_NOT_CONFIRMED',
    message: `${webtrac.message || 'WebTrac did not confirm the booking.'} Stripe authorization was released.`,
    webtrac: summarizeWebtrac(webtrac),
    payment,
  });
};

function finalizerUrl() {
  if (process.env.WEBTRAC_FINALIZE_ADAPTER_URL) return process.env.WEBTRAC_FINALIZE_ADAPTER_URL;
  const reserveUrl = process.env.WEBTRAC_BOOKING_ADAPTER_URL || '';
  if (!reserveUrl) return '';
  try {
    const url = new URL(reserveUrl);
    url.pathname = url.pathname.replace(/\/reserve\/?$/, '/checkout/finalize');
    if (!/\/checkout\/finalize\/?$/.test(url.pathname)) {
      url.pathname = `${url.pathname.replace(/\/$/, '')}/checkout/finalize`;
    }
    return url.toString();
  } catch (e) {
    return '';
  }
}

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

async function capturePaymentIntent(secretKey, paymentIntentId) {
  const res = await fetch(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(paymentIntentId)}/capture`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false,
      body: {
        status: 'stripe_error',
        code: body.error && body.error.code || 'STRIPE_CAPTURE_ERROR',
        message: body.error && body.error.message || 'Stripe could not capture the authorization.',
      },
    };
  }
  return {
    ok: true,
    body: {
      status: body.status,
      paymentIntentId: body.id,
      amountReceived: body.amount_received,
    },
  };
}

async function cancelPaymentIntent(secretKey, paymentIntentId, reason) {
  const params = new URLSearchParams();
  if (reason) params.set('cancellation_reason', 'requested_by_customer');
  const res = await fetch(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(paymentIntentId)}/cancel`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      status: 'stripe_error',
      code: body.error && body.error.code || 'STRIPE_CANCEL_ERROR',
      message: body.error && body.error.message || 'Stripe could not release the authorization.',
    };
  }
  return {
    status: body.status,
    paymentIntentId: body.id,
    cancellationReason: body.cancellation_reason,
  };
}

function summarizeWebtrac(webtrac) {
  return {
    status: webtrac.status,
    code: webtrac.code,
    message: webtrac.message,
    httpStatus: webtrac.httpStatus,
    confirmation: webtrac.confirmation || null,
    recaptcha: webtrac.recaptcha || null,
    requiresFinalPaymentGuard: webtrac.requiresFinalPaymentGuard || false,
  };
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
