/* Courtside Reservations — service worker
 *
 * Conservative cache-first strategy for the app shell only.
 * Bump CACHE_VERSION whenever index.html or shell assets change so users
 * get the new version on next visit (after one refresh).
 *
 * Explicitly NEVER cached:
 *   - WebTrac requests (must stay live; availability is dynamic)
 *   - Open-Meteo weather requests (must stay live)
 *   - Plausible analytics
 *   - anything cross-origin (Google Fonts CSS still hits network)
 */

const CACHE_VERSION = 'courtside-v9-v3';
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/logo.svg',
  '/favicon-32.png',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/og.png',
];

// Pre-cache the shell on install.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// Drop old caches when a new SW version activates.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Fetch handler: cache-first for same-origin shell GETs; everything else passes through.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never touch cross-origin (WebTrac, Open-Meteo, Plausible, Google Fonts CDN).
  if (url.origin !== self.location.origin) return;

  // Skip the dashboard route entirely so admin pages always reflect live counts.
  if (url.searchParams.has('view') && url.searchParams.get('view') === 'dashboard') return;

  const isDocument = req.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html';
  if (isDocument) {
    event.respondWith(
      fetch(req, { cache: 'no-store' }).catch(() => {
        return caches.match('/').then((m) => m || caches.match('/index.html'));
      })
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) {
        // Revalidate in the background — keeps shell fresh without blocking nav.
        fetch(req).then((res) => {
          if (res && res.ok) {
            caches.open(CACHE_VERSION).then((c) => c.put(req, res.clone())).catch(() => {});
          }
        }).catch(() => {});
        return cached;
      }
      return fetch(req).then((res) => {
        // Cache successful same-origin GETs of HTML/asset types.
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => {
        // Offline fallback: serve cached root, falling back to /index.html so
        // the SW works regardless of which path the host actually serves at '/'.
        return caches.match('/').then((m) => m || caches.match('/index.html'));
      });
    })
  );
});
