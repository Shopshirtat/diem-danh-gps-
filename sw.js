const CACHE_NAME = 'diem-danh-gps-v1';
const ASSETS = ['./diem-danh-gps.html', './manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // network-first cho HTML để luôn lấy bản mới nhất khi có mạng,
  // fallback cache khi mất mạng
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
