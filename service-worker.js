const CACHE_NAME = 'sjt7-navassist-v6';
const CORE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './manifest.json',
  './js/venue-graph.js',
  './js/venues/sjt-7th-floor.js',
  './js/venues/hblock-3rd-floor.js',
  './js/venues/outdoor-hostels.js',
  './js/gps-nav.js',
  './js/localization.js',
  './js/venues/sjt-7th-floor.fingerprints.js',
  './js/venues/hblock-3rd-floor.fingerprints.js',
  './js/qr-scanner.js',
  './js/voice.js',
  './js/ar.js',
  './js/hazards.js',
  './js/app.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Network-first strategy: always try network first for live development, fallback to cache if offline
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
