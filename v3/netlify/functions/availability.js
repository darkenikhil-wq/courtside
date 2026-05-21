// Courtside Reservations — v3 availability scraper.
//
// Called by the frontend's date/time picker:
//   GET /.netlify/functions/availability?court=QUINC&date=05/20/2026&sport=TENNIS
//
// Returns:
//   {
//     slots: [{ start: "08:00", available: true }, ...], // aggregate "any unit"
//     courts: [{ id, label, slots: [{ start, available, bookingUrl }] }],
//     fetchedAt
//   }
//
// Uses ScraperAPI to fetch WebTrac through a real-browser proxy
// (plain server-side fetch is 403'd by their bot protection).
//
// API key MUST be set as a Netlify environment variable:
//   Site → Site configuration → Environment variables → add SCRAPER_API_KEY
// Never hardcode the key in this file — it would land in the public-facing repo.

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const { court, date, sport } = params;

  if (!court || !date) {
    return jsonResponse(400, { error: 'Missing required params: court, date' });
  }

  const apiKey = process.env.SCRAPER_API_KEY;
  if (!apiKey) {
    return jsonResponse(500, { error: 'SCRAPER_API_KEY env var not set' });
  }

  // Build the WebTrac search URL. Arlington courts close at 9pm, so the v3
  // scrape covers the same 8am-9pm window shown in the picker.
  const wtUrl = new URL('https://vaarlingtonweb.myvscloud.com/webtrac/web/search.html');
  wtUrl.searchParams.set('Action', 'Start');
  wtUrl.searchParams.set('type', (sport || 'TENNIS').toUpperCase());
  wtUrl.searchParams.set('location', court);
  wtUrl.searchParams.set('date', date); // MM/DD/YYYY
  wtUrl.searchParams.set('begintime', '08:00 am');
  wtUrl.searchParams.set('frheadcount', '2');
  wtUrl.searchParams.set('blockstodisplay', '26');
  wtUrl.searchParams.set('display', 'Detail');
  wtUrl.searchParams.set('module', 'FR');
  wtUrl.searchParams.set('search', 'yes');

  try {
    const scrape = await fetchWithScraperFallback(apiKey, wtUrl);
    if (!scrape.res || !scrape.res.ok) {
      const status = scrape.res ? scrape.res.status : 502;
      return jsonResponse(502, {
        error: `Scraper returned ${status}`,
        scraperAttempts: scrape.attempts,
        version: 'availability-scraper-fallback-v2',
      });
    }
    const html = await scrape.res.text();
    const availability = parseAvailability(html);
    return jsonResponse(200, { ...availability, fetchedAt: Date.now() }, {
      // CDN-cache per court+date for 60s — many users on same combo hit cache, not scraper.
      'Cache-Control': 'public, max-age=60',
    });
  } catch (e) {
    return jsonResponse(500, { error: String(e && e.message || e) });
  }
};

async function fetchWithScraperFallback(apiKey, wtUrl) {
  const attempts = [
    // Cheapest path first. Some cached/low-risk WebTrac pages still work here.
    { label: 'basic-us', params: { country_code: 'us' } },
    // Try rendered browsing before premium IPs; it costs less than premium+render
    // and can handle lightweight bot-wall/script changes.
    { label: 'render-us', params: { country_code: 'us', render: 'true' } },
    // WebTrac often blocks datacenter proxy IPs; US premium proxies fix that
    // without paying for JS rendering on every availability check.
    { label: 'premium-us', params: { country_code: 'us', premium: 'true' } },
    // Last resort for bot-wall changes. This is expensive, so keep it last.
    { label: 'premium-render-us', params: { country_code: 'us', premium: 'true', render: 'true' } },
  ];

  const seen = [];
  let lastRes = null;
  for (const attempt of attempts) {
    const res = await fetch(scraperApiUrl(apiKey, wtUrl, attempt.params));
    seen.push({ label: attempt.label, status: res.status });
    lastRes = res;
    if (res.ok) return { res, attempts: seen };
    if (![401, 403, 429, 500, 502, 503, 504].includes(res.status)) return { res, attempts: seen };
  }
  return { res: lastRes, attempts: seen };
}

function scraperApiUrl(apiKey, wtUrl, options = {}) {
  return 'https://api.scraperapi.com/?' + new URLSearchParams({
    api_key: apiKey,
    url: wtUrl.toString(),
    ...options,
  }).toString();
}

// WebTrac slot markup observed live:
//
//   Available (any cart-button--state-block + success class + tooltip "Book Now"):
//     <a class="…success…cart-button cart-button--state-block" data-tooltip="Book Now"
//        href="…UpdateSelection…"> 8:00 am -  8:30 am</a>
//
//   Unavailable (cart-button--state-block + error class + tooltip "Unavailable",
//                and the time range often SPANS multiple 30-min slots):
//     <a class="…error cart-button cart-button--state-block cart-button--display-multiline"
//        href="#" data-tooltip="Unavailable">
//       <span> 9:30 am - 11:00 am</span><span>Unavailable</span>
//     </a>
//
// Each location (e.g. Quincy) shows N court units; the same time slot may appear
// multiple times. The API returns both per-unit availability and an aggregate
// "any unit" list for backwards compatibility.
function parseSlots(html) {
  return parseAvailability(html).slots;
}

function parseAvailability(html) {
  // 'HH:MM' (24h) → { available, bookingUrl? }
  // bookingUrl is the WebTrac UpdateSelection AJAX link. It is metadata for the
  // future backend booking adapter; do not navigate a browser directly to it.
  // Aggregated across all courts at this location: prefer an AVAILABLE entry
  // (with its URL) over an unavailable one for the same time.
  const aggregateSlotMap = new Map();
  const courtMap = new Map();
  const unitLabels = new Map();
  let currentCourt = null;

  // Labels are sometimes not anchors, so scan every cart-button-ish element in
  // DOM order and let state-label elements set the current court unit.
  const linkRe = /<([a-z][\w:-]*)\s+([^>]*?cart-button[^>]*?)>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const attrs = m[2];
    const inner = m[3];

    if (/cart-button--state-label/.test(attrs)) {
      const label = cleanHtmlText(inner) || cleanHtmlText(attributeValue(attrs, 'title')) || `Court ${courtMap.size + 1}`;
      currentCourt = isMeaningfulCourtLabel(label) ? ensureCourt(courtMap, label) : null;
      continue;
    }
    if (!/cart-button--state-block/.test(attrs)) continue;

    const t = inner.match(/(\d{1,2}):(\d{2})\s*([ap]m)\s*-\s*(\d{1,2}):(\d{2})\s*([ap]m)/i);
    if (!t) continue;

    const isUnavailable =
      /data-tooltip\s*=\s*"Unavailable"/i.test(attrs) ||
      /\bUnavailable\b/i.test(inner) ||
      /\berror\b/.test(attrs);
    const isAvailable = !isUnavailable;

    // Pull the href off available slots as metadata for the v3 booking adapter.
    // Unavailable slots have href="#" and we ignore those.
    const href = decodeHtmlEntities(attributeValue(attrs, 'href'));
    const unitId = webtracFacilityUnitId(href);
    let bookingUrl = null;
    if (isAvailable) {
      if (href && href !== '#' && /UpdateSelection/i.test(href)) bookingUrl = href;
    }

    const startMins = to24Mins(parseInt(t[1], 10), parseInt(t[2], 10), t[3]);
    const endMins   = to24Mins(parseInt(t[4], 10), parseInt(t[5], 10), t[6]);
    if (!Number.isFinite(startMins) || !Number.isFinite(endMins) || endMins <= startMins) continue;

    const unitCourt = currentCourt || (unitId ? ensureCourtForUnit(courtMap, unitLabels, unitId) : null);

    // Walk every 30-min increment inside [start, end). A 1.5h booking marks
    // 3 separate 30-min slots as unavailable.
    let unitBookingUrl = bookingUrl;
    for (let mins = startMins; mins < endMins; mins += 30) {
      const key = minsToHHMM(mins);
      if (unitCourt) mergeSlot(unitCourt.slotMap, key, isAvailable, unitBookingUrl);
      mergeSlot(aggregateSlotMap, key, isAvailable, unitBookingUrl);

      // Only the first 30-min slot of a multi-slot booking has the "real" URL;
      // subsequent slot keys within the same booking block don't (they map to
      // the same slot anyway, and the bookingUrl for the START is what matters).
      // Set bookingUrl=null for non-first iterations to avoid misattributing.
      unitBookingUrl = null;
    }
  }

  const courts = Array.from(courtMap.values())
    .map((court) => ({
      id: court.id,
      label: court.label,
      webtracFacilityId: court.webtracFacilityId || null,
      slots: slotMapToSlots(court.slotMap),
    }))
    .filter((court) => court.slots.length)
    .sort((a, b) => courtSortLabel(a.label).localeCompare(courtSortLabel(b.label), undefined, { numeric: true }));

  return {
    slots: slotMapToSlots(aggregateSlotMap),
    courts,
    courtCount: courts.length,
  };
}

function mergeSlot(slotMap, key, isAvailable, bookingUrl) {
  const prev = slotMap.get(key);
  if (prev === undefined) {
    slotMap.set(key, { available: isAvailable, bookingUrl });
  } else if (isAvailable && !prev.available) {
    slotMap.set(key, { available: true, bookingUrl });
  } else if (isAvailable && prev.available && !prev.bookingUrl && bookingUrl) {
    slotMap.set(key, { available: true, bookingUrl });
  }
}

function slotMapToSlots(slotMap) {
  return Array.from(slotMap.entries())
    .map(([start, info]) => ({ start, available: info.available, bookingUrl: info.bookingUrl || null }))
    .sort((a, b) => a.start.localeCompare(b.start));
}

function ensureCourt(courtMap, label) {
  const normalized = normalizeCourtLabel(label);
  const id = slugify(normalized || `court-${courtMap.size + 1}`);
  if (!courtMap.has(id)) {
    courtMap.set(id, {
      id,
      label: normalized || `Court ${courtMap.size + 1}`,
      slotMap: new Map(),
    });
  }
  return courtMap.get(id);
}

function ensureCourtForUnit(courtMap, unitLabels, unitId) {
  const key = String(unitId || '').trim();
  if (!key) return null;
  if (!unitLabels.has(key)) unitLabels.set(key, `Court ${unitLabels.size + 1}`);
  const label = unitLabels.get(key);
  const id = `unit-${slugify(key)}`;
  if (!courtMap.has(id)) {
    courtMap.set(id, {
      id,
      label,
      webtracFacilityId: key,
      slotMap: new Map(),
    });
  }
  return courtMap.get(id);
}

function normalizeCourtLabel(label) {
  return cleanHtmlText(label)
    .replace(/\bFacility Reservation\b/gi, '')
    .replace(/\bBook Now\b/gi, '')
    .replace(/\bUnavailable\b/gi, '')
    .replace(/^[\s:·|/\\-]+|[\s:·|/\\-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isMeaningfulCourtLabel(label) {
  const normalized = normalizeCourtLabel(label);
  return /[a-z0-9]/i.test(normalized) && !/^court$/i.test(normalized);
}

function courtSortLabel(label) {
  return String(label || '').replace(/^.*?(\d+)$/, 'Court $1');
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&[a-z0-9#]+;/gi, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'court';
}

function cleanHtmlText(value) {
  return decodeHtmlEntities(String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

function attributeValue(attrs, name) {
  const re = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = attrs.match(re);
  return match ? (match[1] || match[2] || match[3] || '') : '';
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&#x2F;/gi, '/')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function webtracFacilityUnitId(href) {
  if (!href || !/UpdateSelection/i.test(href)) return '';
  try {
    const url = new URL(href, 'https://vaarlingtonweb.myvscloud.com');
    return url.searchParams.get('FRFMIDList') || '';
  } catch (e) {
    return (String(href).match(/[?&]FRFMIDList=([^&]+)/i) || [])[1] || '';
  }
}

function to24Mins(h, m, ampm) {
  const ap = String(ampm).toLowerCase();
  let h24;
  if (ap === 'am') h24 = h === 12 ? 0 : h;
  else             h24 = h === 12 ? 12 : h + 12;
  return h24 * 60 + m;
}
function minsToHHMM(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function jsonResponse(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  };
}
