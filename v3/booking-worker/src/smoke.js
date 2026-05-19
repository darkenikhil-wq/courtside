import 'dotenv/config';

const port = Number(process.env.PORT || 8787);
const token = process.env.BOOKING_WORKER_TOKEN || 'dev-local-token';

const date = process.argv[2] || localDatePlus(3);
const start = process.argv[3] || '09:00';
const duration = Number(process.argv[4] || 60);

const payload = {
  courtId: 'quincy',
  courtCode: 'QUINC',
  courtName: 'Quincy Park',
  sport: 'tennis',
  sportType: 'TENNIS',
  date,
  dateWebtrac: isoToWebtracDate(date),
  start,
  end: addMinutes(start, duration),
  duration,
  rangeLabel: `${start} for ${duration} min`,
  headcount: 2,
  webtracSearchUrl: buildSearchUrl('QUINC', 'TENNIS', isoToWebtracDate(date)),
  webtracUpdateSelectionUrls: [],
};

const res = await fetch(`http://localhost:${port}/reserve`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  },
  body: JSON.stringify(payload),
});

const body = await res.text();
console.log(res.status, body);

function localDatePlus(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isoToWebtracDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

function addMinutes(hhmm, minutes) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function buildSearchUrl(courtCode, sportType, dateWebtrac) {
  const u = new URL('https://vaarlingtonweb.myvscloud.com/webtrac/web/search.html');
  u.searchParams.set('Action', 'Start');
  u.searchParams.set('SubAction', '');
  u.searchParams.set('type', sportType);
  u.searchParams.set('location', courtCode);
  u.searchParams.set('primarycode', '');
  u.searchParams.set('date', dateWebtrac);
  u.searchParams.set('begintime', '08:00 am');
  u.searchParams.set('frheadcount', '2');
  u.searchParams.set('blockstodisplay', '26');
  u.searchParams.set('display', 'Detail');
  u.searchParams.set('search', 'yes');
  u.searchParams.set('page', '1');
  u.searchParams.set('module', 'FR');
  u.searchParams.set('frwebsearch_buttonsearch', 'yes');
  return u.toString();
}
