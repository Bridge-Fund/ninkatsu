const CACHE = 'ninkatu-v4';
const ASSETS = ['./index.html', './app.js', './manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS))
  );
  self.skipWaiting(); // 即座に新しいSWを有効化
});

self.addEventListener('activate', e => {
  // 古いキャッシュを全削除
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim(); // 全クライアントを即座に新SWに切り替え
});

self.addEventListener('fetch', e =>
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  )
);
