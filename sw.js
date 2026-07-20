/* =========================================================
   UpaPro service worker — offline + versioning strategy (M5)

   HOW VERSIONING WORKS:
   Bump CACHE_VERSION any time index.html, manifest.json, or the
   icons change. That gives the cache a new name, so install()
   re-fetches everything fresh instead of reusing stale cached
   files, and activate() deletes the old cache once the new one
   is ready. Forgetting to bump the version is the #1 cause of
   "I pushed a fix but the phone still shows the old version" —
   this is exactly why the app also does an update-available
   toast instead of silently swapping versions underneath you.

   HOW OFFLINE WORKS:
   The app shell (this file's list) is cached on install so the
   whole UI loads with zero network. All real data lives in
   IndexedDB already (see index.html), so once the shell is
   cached, the app is fully usable offline — add/edit locations,
   units, tenants, payments all keep working. Cloud sync (M4)
   simply queues and retries once back online.
   ========================================================= */

const CACHE_VERSION = 'v4';
const CACHE_NAME = `upapro-${CACHE_VERSION}`;

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
    // Deliberately NOT calling self.skipWaiting() here — the new worker
    // should sit in "waiting" until index.html's update banner posts
    // SKIP_WAITING (see the message listener below), so the switch only
    // happens when the person taps Refresh, not silently mid-session.
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

/* Cache-first for same-origin GETs (the app shell), with a network
   fallback that also refreshes the cache, and an offline fallback to
   the cached index.html for navigations that aren't otherwise cached
   (e.g. a deep link opened fresh while offline). Cross-origin requests
   (Google Fonts, Firebase, Firestore) are left alone — Firestore has
   its own offline persistence layer already (see index.html). */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => {
          if (req.mode === 'navigate') return caches.match('./index.html');
        });
    })
  );
});

/* index.html posts this when the person taps "Update" on the
   new-version toast, so the waiting worker activates on demand
   instead of switching versions out from under an open session. */
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
