/* Service worker — Điểm danh GPS
 * v2: sửa lỗi chí mạng ở v1 (cache tên file không tồn tại -> install fail -> PWA không cài được)
 */
const CACHE_NAME = 'diem-danh-gps-v2';

// Chỉ liệt kê file CÓ THẬT trong repo. Một file 404 ở đây là đủ để
// cache.addAll() reject -> sự kiện install thất bại -> SW không bao giờ activate.
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      // addAll là all-or-nothing. Dùng add() từng file và nuốt lỗi lẻ
      // để một asset hỏng không kéo sập toàn bộ quá trình cài đặt.
      .then(c => Promise.all(ASSETS.map(u => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;

  // Không đụng vào request không phải GET, và không bao giờ cache lệnh gọi backend.
  if (req.method !== 'GET') return;
  if (req.url.indexOf('script.google') !== -1 || req.url.indexOf('googleusercontent') !== -1) return;

  e.respondWith(
    fetch(req)
      .then(res => {
        // Lưu bản sao mới nhất cho lần offline sau
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(req);
        if (hit) return hit;
        // v1 trả về undefined ở nhánh này -> respondWith(undefined) -> network error trắng trang.
        if (req.mode === 'navigate') {
          const shell = await caches.match('./index.html');
          if (shell) return shell;
        }
        return new Response('Đang ngoại tuyến và chưa có bản lưu.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      })
  );
});
