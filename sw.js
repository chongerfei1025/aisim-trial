/* Service Worker — 网络优先（改代码立即生效），断网回落缓存；API 请求永不缓存 */
const CACHE = 'aisim-v5';
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'api.js',
  'manifest.json',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(
        ASSETS
          .map((a) => new URL(a, self.registration.scope).href)
          .map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {}))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 跨域（大模型 API）一律直连，不缓存、不拦截
  if (url.origin !== self.location.origin) return;

  // 页面与代码文件强制绕过 HTTP 缓存。
  // GitHub Pages 默认给静态文件 10 分钟缓存，不这样做更新后会一直吃旧版。
  const fresh = req.mode === 'navigate' ||
    /\.(html|js|css|json|webmanifest)$/i.test(url.pathname);

  e.respondWith(
    fetch(req, fresh ? { cache: 'no-store' } : undefined).then((res) => {
      if (res && res.status === 200 && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => {
      return caches.match(req).then((hit) => {
        if (hit) return hit;
        if (req.mode === 'navigate') return caches.match('index.html').then((r) => r || caches.match('./'));
        return new Response('离线', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      });
    })
  );
});
