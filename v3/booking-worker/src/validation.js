const ALLOWED_DURATIONS = new Set([60, 90]);
const ALLOWED_SPORT_TYPES = new Set(['TENNIS', 'PICKLE']);
const FIRST_START_MINS = 8 * 60;
const CLOSE_MINS = 21 * 60;

export function validateBookingRequest(body) {
  if (!body || typeof body !== 'object') return fail('BAD_BODY', 'Missing booking details.');
  if (!body.courtCode || !/^[A-Z0-9-]{2,12}$/.test(String(body.courtCode))) {
    return fail('BAD_COURT', 'Court is not configured for booking.');
  }
  if (!ALLOWED_SPORT_TYPES.has(String(body.sportType || '').toUpperCase())) {
    return fail('BAD_SPORT', 'Sport is not supported.');
  }
  const duration = Number(body.duration);
  if (!ALLOWED_DURATIONS.has(duration)) {
    return fail('BAD_DURATION', 'Duration must be 60 or 90 minutes.');
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
  if (m !== 0 && m !== 30) return fail('BAD_INCREMENT', 'Start time must be on a 30-minute increment.');
  if (startMins < FIRST_START_MINS || endMins > CLOSE_MINS) {
    return fail('OUTSIDE_HOURS', 'Booking must fit between 8:00 AM and 9:00 PM.');
  }

  return { ok: true };
}

function fail(code, message) {
  return { ok: false, code, message };
}
