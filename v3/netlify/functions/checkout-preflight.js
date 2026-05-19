exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return jsonResponse(204, {});
  }
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Use POST' });
  }

  const body = parseJson(event.body);
  if (!body.ok) return jsonResponse(400, { error: 'Invalid JSON body' });

  const finalizeUrl = finalizerUrl();
  if (!finalizeUrl) {
    return jsonResponse(501, {
      status: 'not_configured',
      code: 'WEBTRAC_FINALIZE_ADAPTER_REQUIRED',
      message: 'Final WebTrac checkout worker is not configured.',
    });
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    const token = process.env.WEBTRAC_FINALIZE_ADAPTER_TOKEN || process.env.WEBTRAC_BOOKING_ADAPTER_TOKEN || '';
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(finalizeUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        booking: body.value.booking || null,
        stopBeforeSubmit: true,
        requestedAt: Date.now(),
      }),
    });
    const text = await res.text();
    let webtrac;
    try { webtrac = JSON.parse(text); }
    catch (e) { webtrac = { status: res.ok ? 'accepted' : 'adapter_error', message: text }; }
    webtrac.httpStatus = res.status;

    const ready = webtrac.status === 'webtrac_payment_ready';
    return jsonResponse(ready ? 200 : (res.status >= 400 ? res.status : 409), {
      status: ready ? 'ready' : 'not_ready',
      code: ready ? 'WEBTRAC_CHECKOUT_READY' : (webtrac.code || 'WEBTRAC_CHECKOUT_NOT_READY'),
      message: ready
        ? 'Arlington/WebTrac checkout is ready.'
        : (webtrac.message || 'Arlington/WebTrac checkout is not ready.'),
      webtrac: summarizeWebtrac(webtrac),
    });
  } catch (e) {
    return jsonResponse(502, {
      status: 'adapter_unreachable',
      code: 'WEBTRAC_FINALIZE_ADAPTER_UNREACHABLE',
      message: String(e && e.message || e),
    });
  }
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

function summarizeWebtrac(webtrac) {
  return {
    status: webtrac.status,
    code: webtrac.code,
    message: webtrac.message,
    httpStatus: webtrac.httpStatus,
    requiresFinalPaymentGuard: webtrac.requiresFinalPaymentGuard || false,
    allowWebtracFinalPayment: webtrac.allowWebtracFinalPayment === true,
    cart: webtrac.cart ? {
      confirmed: webtrac.cart.confirmed,
      itemCount: webtrac.cart.itemCount,
      amountToday: webtrac.cart.amountToday,
      grandTotal: webtrac.cart.grandTotal,
      expectedMatch: webtrac.cart.expectedMatch || null,
    } : null,
    fillResult: webtrac.fillResult || null,
    missing: webtrac.missing || null,
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
    body: statusCode === 204 ? '' : JSON.stringify(body),
  };
}
