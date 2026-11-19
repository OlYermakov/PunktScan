const SHELL = 'punktscan-shell-__BUILD__';
const ASSETS = [
  './',
  './index.html',
  './style.css?v=__BUILD__',
  './app.js?v=__BUILD__',
  './core.js?v=__BUILD__',
  './imaging.js?v=__BUILD__',
  './manifest.webmanifest',
  './icon.svg',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable.png',
  './offline-assets.json',
  './licenses.txt',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener('activate', (e) =>
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith('punktscan-shell-') && k !== SHELL)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  ),
);
async function cached(request) {
  return (
    (await (await caches.open(SHELL)).match(request)) ||
    (await (await caches.open('punktscan-offline-v1')).match(request))
  );
}
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Never cache authentication endpoints or arbitrary navigation responses.
  const known =
    ASSETS.some((p) => new URL(p, self.registration.scope).pathname === url.pathname) ||
    url.pathname.includes('/vendor/') ||
    /\/demo-[12]\.jpg$/.test(url.pathname);
  if (!known) return;
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(
        async () => await cached(new URL('./index.html', self.registration.scope)),
      ),
    );
    return;
  }
  e.respondWith(cached(e.request).then((hit) => hit || fetch(e.request)));
});
