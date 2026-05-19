// Courtside Reservations v3 — booking request adapter.
//
// This function validates the in-app booking intent against Arlington's public
// rules, then hands the request to a future WebTrac booking agent if configured.
// It intentionally does NOT navigate to WebTrac's UpdateSelection URL. That URL
// is an AJAX endpoint and returns raw JSON when opened as a page.
//
// To enable true invisible booking later, deploy a separate Playwright/WebTrac
// adapter and set:
//   WEBTRAC_BOOKING_ADAPTER_URL=https://...
//   WEBTRAC_BOOKING_ADAPTER_TOKEN=...

const ALLOWED_DURATIONS = new Set([60, 90]);
const ALLOWED_SPORT_TYPES = new Set(['TENNIS', 'PICKLE', 'VBALL']);
const FIRST_START_MINS = 8 * 60;
const CLOSE_MINS = 21 * 60;
const MAX_DAYS_AHEAD = 14;
const QA_MODE = process.env.BOOKING_QA_MODE === 'true';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return jsonResponse(204, {});
  }
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Use POST' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  const validation = validateBooking(body);
  if (!validation.ok) {
    return jsonResponse(400, {
      status: 'rejected',
      code: validation.code,
      message: validation.message,
    });
  }

  if (QA_MODE) {
    return jsonResponse(200, {
      status: 'qa_accepted',
      code: 'BOOKING_QA_MODE',
      message: 'QA mode accepted this booking request. No WebTrac cart was changed.',
      dryRun: true,
      rules: publicRules(),
      booking: bookingSummary(body),
      manualFallbackUrl: body.webtracSearchUrl || null,
    });
  }

  const adapterUrl = process.env.WEBTRAC_BOOKING_ADAPTER_URL;
  if (!adapterUrl) {
    return jsonResponse(501, {
      status: 'not_configured',
      code: 'WEBTRAC_BOOKING_ADAPTER_REQUIRED',
      message: 'Booking request is valid, but no WebTrac booking adapter is configured.',
      rules: publicRules(),
      manualFallbackUrl: body.webtracSearchUrl || null,
    });
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.WEBTRAC_BOOKING_ADAPTER_TOKEN) {
      headers.Authorization = `Bearer ${process.env.WEBTRAC_BOOKING_ADAPTER_TOKEN}`;
    }
    const res = await fetch(adapterUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...body,
        rules: publicRules(),
        webtracUpdateSelectionUrls: normalizeSelectionUrls(body),
        requestedAt: Date.now(),
      }),
    });
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

function validateBooking(body) {
  if (!body || typeof body !== 'object') {
    return fail('BAD_BODY', 'Missing booking details.');
  }
  if (!body.courtCode || !/^[A-Z0-9-]{2,12}$/.test(String(body.courtCode))) {
    return fail('BAD_COURT', 'Court is not configured for booking.');
  }
  const sportType = String(body.sportType || '').toUpperCase();
  if (!ALLOWED_SPORT_TYPES.has(sportType)) {
    return fail('BAD_SPORT', 'Sport is not supported.');
  }
  const duration = Number(body.duration);
  if (!ALLOWED_DURATIONS.has(duration)) {
    return fail('BAD_DURATION', 'Arlington online court reservations are 60 or 90 minutes.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.date || ''))) {
    return fail('BAD_DATE', 'Date must be YYYY-MM-DD.');
  }
  if (!/^\d{2}:\d{2}$/.test(String(body.start || ''))) {
    return fail('BAD_TIME', 'Start time must be HH:MM.');
  }

  const [h, m] = String(body.start).split(':').map(Number);
  const startMins = h * 60 + m;
  const endMins = startMins + duration;
  if (m !== 0 && m !== 30) {
    return fail('BAD_INCREMENT', 'Start time must be on a 30-minute increment.');
  }
  if (startMins < FIRST_START_MINS || endMins > CLOSE_MINS) {
    return fail('OUTSIDE_HOURS', 'Court reservations must fit between 8:00 AM and 9:00 PM.');
  }

  const selected = arlingtonWallEpoch(body.date, body.start);
  const now = arlingtonNowWallEpoch();
  const min = now + 24 * 60 * 60 * 1000;
  if (selected < min) {
    return fail('TOO_SOON', 'Arlington requires reservations at least 24 hours in advance.');
  }

  const selectedDay = arlingtonDateEpoch(body.date);
  const today = arlingtonTodayEpoch();
  const maxDay = today + MAX_DAYS_AHEAD * 24 * 60 * 60 * 1000;
  if (selectedDay > maxDay) {
    return fail('TOO_FAR', 'Arlington reservations can be made no more than 14 days ahead.');
  }

  return { ok: true };
}

function normalizeSelectionUrls(body) {
  if (Array.isArray(body.webtracUpdateSelectionUrls)) {
    return body.webtracUpdateSelectionUrls.filter(Boolean);
  }
  return body.webtracUpdateSelectionUrl ? [body.webtracUpdateSelectionUrl] : [];
}

function publicRules() {
  return {
    minAdvanceHours: 24,
    maxDaysAhead: MAX_DAYS_AHEAD,
    allowedDurationsMinutes: Array.from(ALLOWED_DURATIONS),
    operatingWindow: { opens: '08:00', closes: '21:00' },
  };
}

function bookingSummary(body) {
  return {
    courtId: body.courtId || null,
    courtCode: body.courtCode || null,
    courtName: body.courtName || null,
    courtUnitId: body.courtUnitId || null,
    courtUnitName: body.courtUnitName || null,
    courtUnitDisplayName: body.courtUnitDisplayName || null,
    sport: body.sport || null,
    sportType: body.sportType || null,
    date: body.date || null,
    start: body.start || null,
    end: body.end || null,
    duration: Number(body.duration),
    selectionUrlCount: normalizeSelectionUrls(body).length,
  };
}

function fail(code, message) {
  return { ok: false, code, message };
}

function arlingtonNowParts() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    h: Number(parts.hour),
    min: Number(parts.minute),
    s: Number(parts.second),
  };
}

function arlingtonNowWallEpoch() {
  const p = arlingtonNowParts();
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
}

function arlingtonTodayEpoch() {
  const p = arlingtonNowParts();
  return Date.UTC(p.y, p.m - 1, p.d);
}

function arlingtonDateEpoch(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function arlingtonWallEpoch(iso, hhmm) {
  const [y, mo, d] = String(iso).split('-').map(Number);
  const [h, m] = String(hhmm).split(':').map(Number);
  return Date.UTC(y, mo - 1, d, h, m);
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
