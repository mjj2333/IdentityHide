// Service worker — enables PWA installability, offline fallback, and asset caching.
// CACHE_VERSION is replaced at build time by the vite plugin in vite.config.js
// with a timestamp, so every deploy gets a fresh asset cache automatically.
const CACHE_VERSION = '__SW_VERSION__';
const OFFLINE_CACHE = 'offline-v1';
const ASSET_CACHE = `assets-${CACHE_VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(OFFLINE_CACHE).then(cache => cache.add('/offline.html'))
  );
  // NB: We no longer call self.skipWaiting() here. A new SW sits in the
  // `waiting` state until the client posts a SKIP_WAITING message, which
  // happens when the user clicks the "Reload" button on the update toast.
  // This is what lets the app detect the update and prompt the user.
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== OFFLINE_CACHE && k !== ASSET_CACHE)
          .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Navigation: network-first, offline fallback
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/offline.html'))
    );
    return;
  }

  // Hashed assets (Vite output): cache-first (immutable, filename changes on rebuild)
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(ASSET_CACHE).then(cache => cache.put(request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // Model/WASM files: cache-first (versioned, long-lived)
  if (url.pathname.match(/\.(onnx|wasm)$/)) {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(ASSET_CACHE).then(cache => cache.put(request, clone));
          }
          return response;
        });
      })
    );
    return;
  }
});
