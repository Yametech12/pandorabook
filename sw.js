/* PandoraBook service worker — cache-first for static assets, offline fallback. */
'use strict';

const CACHE_NAME = 'pandorabook-v2';

// Core app shell: cached on install so the app opens offline.
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/app.css',
  '/js/app.js',
  '/data/content.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  // M2 fix: decouple skipWaiting from precache so a single 404 doesn't
  // leave the SW stuck in "waiting" with a half-populated cache.
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.allSettled(
        CORE_ASSETS.map((u) => cache.add(u).catch((e) => console.warn('[sw] precache miss:', u)))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Only handle GET requests; let everything else pass through.
  if (request.method !== 'GET') return;

  // Navigations: network-first, fall back to cached index.html when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Static assets: cache-first, populate cache on miss.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        // Only cache successful, same-origin responses.
        if (
          response &&
          response.status === 200 &&
          new URL(request.url).origin === self.location.origin
        ) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});

/* App → SW messaging: lets the offline page report what's cached. */
self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'CACHE_STATUS') return;
  const port = event.ports && event.ports[0];
  caches.open(CACHE_NAME).then((cache) =>
    cache.keys().then((keys) => {
      const urls = keys.map((r) => new URL(r.url).pathname);
      const status = {
        shell: urls.includes('/index.html') || urls.includes('/'),
        styles: urls.includes('/css/app.css'),
        appJs: urls.includes('/js/app.js'),
        data: urls.includes('/data/content.json'),
        icons: urls.includes('/icons/icon-192.png'),
        total: keys.length,
      };
      if (port) port.postMessage({ type: 'CACHE_STATUS', status });
    })
  );
});
