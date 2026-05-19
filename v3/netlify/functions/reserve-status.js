exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return jsonResponse(204, {});
  }
  if (event.httpMethod !== 'GET') {
    return jsonResponse(405, { error: 'Use GET' });
  }

  const jobId = String(event.queryStringParameters?.jobId || '').trim();
  if (!/^[0-9a-f-]{20,80}$/i.test(jobId)) {
    return jsonResponse(400, {
      status: 'rejected',
      code: 'BAD_BOOKING_JOB_ID',
      message: 'Missing or invalid booking job ID.',
    });
  }

  const adapterUrl = statusUrl(jobId);
  if (!adapterUrl) {
    return jsonResponse(501, {
      status: 'not_configured',
      code: 'WEBTRAC_BOOKING_ADAPTER_REQUIRED',
      message: 'No WebTrac booking adapter is configured.',
    });
  }

  try {
    const headers = {};
    const token = process.env.WEBTRAC_BOOKING_ADAPTER_TOKEN || '';
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(adapterUrl, { headers });
    const text = await res.text();
    let payload;
    try { payload = JSON.parse(text); }
    catch (e) { payload = { status: res.ok ? 'accepted' : 'adapter_error', message: text }; }
    return jsonResponse(res.status, payload);
  } catch (e) {
    return jsonResponse(502, {
      status: 'adapter_unreachable',
      code: 'WEBTRAC_BOOKING_ADAPTER_UNREACHABLE',
      message: String(e && e.message || e),
    });
  }
};

function statusUrl(jobId) {
  if (process.env.WEBTRAC_BOOKING_ADAPTER_STATUS_URL) {
    return `${process.env.WEBTRAC_BOOKING_ADAPTER_STATUS_URL.replace(/\/$/, '')}/${encodeURIComponent(jobId)}`;
  }
  const reserveUrl = process.env.WEBTRAC_BOOKING_ADAPTER_URL || '';
  if (!reserveUrl) return '';
  try {
    const url = new URL(reserveUrl);
    url.pathname = url.pathname.replace(/\/reserve\/?$/, `/reserve/status/${encodeURIComponent(jobId)}`);
    if (!/\/reserve\/status\//.test(url.pathname)) {
      url.pathname = `${url.pathname.replace(/\/$/, '')}/reserve/status/${encodeURIComponent(jobId)}`;
    }
    return url.toString();
  } catch (e) {
    return '';
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
