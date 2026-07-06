// Service worker — enables PWA installability, offline fallback, and asset caching.
// CACHE_VERSION is replaced at build time by the vite plugin in vite.config.js
// with a timestamp, so every deploy gets a fresh asset cache automatically.
const CACHE_VERSION = '__SW_VERSION__';
const OFFLINE_CACHE = 'offline-v1';
const ASSET_CACHE = `assets-${CACHE_VERSION}`;

self.addEventListener('install', (event) => {
  // Precache both the offline fallback AND the app shell ("/"). Precaching
  // the shell at install time means the cache is ready the moment this SW
  // activates, instead of needing a subsequent navigation to populate it.
  // Existing users who go offline immediately after accepting the update
  // toast still get a working app. {cache: 'reload'} bypasses HTTP caches
  // so we fetch the freshly-deployed shell (which references the current
  // hashed assets), not a stale browser-cached copy.
  event.waitUntil(
    Promise.all([
      caches.open(OFFLINE_CACHE).then((cache) => cache.add('/offline.html')),
      caches.open(ASSET_CACHE).then((cache) =>
        cache.add(new Request('/', { cache: 'reload' }))
      ),
    ])
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

  // Ad networks: always bypass SW — must hit network fresh
  if (url.hostname.includes('clickadilla') ||
      url.hostname.includes('wpadmngr') ||
      url.hostname.includes('admanager')) {
    return; // let the browser handle it directly
  }

  // Navigation: network-first, but cache successful responses so the app
  // works offline after the user has visited at least once. Falls back to
  // the cached app shell first, then /offline.html only as a last resort
  // (truly first-time offline with no prior cache).
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(ASSET_CACHE).then((cache) => cache.put('/', clone));
          }
          return response;
        })
        .catch(async () => {
          const cachedShell = await caches.match('/');
          if (cachedShell) return cachedShell;
          return caches.match('/offline.html');
        })
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
