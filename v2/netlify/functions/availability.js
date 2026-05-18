// Courtside Reservations — v2 availability scraper.
//
// Called by the frontend's date/time picker:
//   GET /.netlify/functions/availability?court=QUINC&date=05/20/2026&sport=TENNIS
//
// Returns:
//   { slots: [{ start: "07:00", available: true }, { start: "07:30", available: false }, …], fetchedAt }
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

  // Build the WebTrac search URL. We ask for the whole day's worth of slots
  // (blockstodisplay=30 covers 7am–10pm) so a single scrape powers the entire picker.
  const wtUrl = new URL('https://vaarlingtonweb.myvscloud.com/webtrac/web/search.html');
  wtUrl.searchParams.set('Action', 'Start');
  wtUrl.searchParams.set('type', (sport || 'TENNIS').toUpperCase());
  wtUrl.searchParams.set('location', court);
  wtUrl.searchParams.set('date', date); // MM/DD/YYYY
  wtUrl.searchParams.set('begintime', '07:00 am');
  wtUrl.searchParams.set('frheadcount', '0');
  wtUrl.searchParams.set('blockstodisplay', '30');
  wtUrl.searchParams.set('display', 'Detail');
  wtUrl.searchParams.set('module', 'FR');
  wtUrl.searchParams.set('search', 'yes');

  const scraperUrl = 'https://api.scraperapi.com/?' + new URLSearchParams({
    api_key: apiKey,
    url: wtUrl.toString(),
  }).toString();

  try {
    const res = await fetch(scraperUrl);
    if (!res.ok) {
      return jsonResponse(502, { error: `Scraper returned ${res.status}` });
    }
    const html = await res.text();
    const slots = parseSlots(html);
    return jsonResponse(200, { slots, fetchedAt: Date.now() }, {
      // CDN-cache per court+date for 60s — many users on same combo hit cache, not scraper.
      'Cache-Control': 'public, max-age=60',
    });
  } catch (e) {
    return jsonResponse(500, { error: String(e && e.message || e) });
  }
};

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
// Each location (e.g. Quincy) shows N courts; the same time slot may appear
// multiple times. For our UI we want "is ANY court at this location available
// at this time" — so we OR availability across all courts.
function parseSlots(html) {
  // 'HH:MM' (24h) → { available, bookingUrl? }
  // bookingUrl is the WebTrac UpdateSelection link — visiting it directly adds
  // that 30-min slot to the user's cart on WebTrac in a fresh session.
  // Aggregated across all courts at this location: prefer an AVAILABLE entry
  // (with its URL) over an unavailable one for the same time.
  const slotMap = new Map();

  const linkRe = /<a\s+([^>]*?cart-button[^>]*?)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const attrs = m[1];
    const inner = m[2];

    if (/cart-button--state-label/.test(attrs)) continue;
    if (!/cart-button--state-block/.test(attrs)) continue;

    const t = inner.match(/(\d{1,2}):(\d{2})\s*([ap]m)\s*-\s*(\d{1,2}):(\d{2})\s*([ap]m)/i);
    if (!t) continue;

    const isUnavailable =
      /data-tooltip\s*=\s*"Unavailable"/i.test(attrs) ||
      /\bUnavailable\b/i.test(inner) ||
      /\berror\b/.test(attrs);
    const isAvailable = !isUnavailable;

    // Pull the href off available slots so the frontend can hand the user
    // straight into "slot in cart" on WebTrac. Unavailable slots have href="#"
    // and we ignore those.
    let bookingUrl = null;
    if (isAvailable) {
      const hrefMatch = attrs.match(/href\s*=\s*"([^"#][^"]*)"/i);
      if (hrefMatch && /UpdateSelection/i.test(hrefMatch[1])) {
        // HTML entities → real chars (WebTrac mostly emits raw &, but be safe).
        bookingUrl = hrefMatch[1]
          .replace(/&amp;/g, '&')
          .replace(/&#x2F;/gi, '/')
          .replace(/&quot;/g, '"');
      }
    }

    const startMins = to24Mins(parseInt(t[1], 10), parseInt(t[2], 10), t[3]);
    const endMins   = to24Mins(parseInt(t[4], 10), parseInt(t[5], 10), t[6]);
    if (!Number.isFinite(startMins) || !Number.isFinite(endMins) || endMins <= startMins) continue;

    // Walk every 30-min increment inside [start, end). A 1.5h booking marks
    // 3 separate 30-min slots as unavailable.
    for (let mins = startMins; mins < endMins; mins += 30) {
      const key = minsToHHMM(mins);
      const prev = slotMap.get(key);
      if (prev === undefined) {
        slotMap.set(key, { available: isAvailable, bookingUrl });
      } else if (isAvailable && !prev.available) {
        // Promote: switch this slot from unavailable to available, with URL.
        slotMap.set(key, { available: true, bookingUrl });
      } else if (isAvailable && prev.available && !prev.bookingUrl && bookingUrl) {
        // Same slot, but this entry has a URL the earlier one lacked.
        slotMap.set(key, { available: true, bookingUrl });
      }
      // Only the first 30-min slot of a multi-slot booking has the "real" URL;
      // subsequent slot keys within the same booking block don't (they map to
      // the same slot anyway, and the bookingUrl for the START is what matters).
      // Set bookingUrl=null for non-first iterations to avoid misattributing.
      bookingUrl = null;
    }
  }

  return Array.from(slotMap.entries())
    .map(([start, info]) => ({ start, available: info.available, bookingUrl: info.bookingUrl || null }))
    .sort((a, b) => a.start.localeCompare(b.start));
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
