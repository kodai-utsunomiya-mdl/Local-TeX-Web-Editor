const cacheName = 'local-tex-editor-connection-__APP_VERSION__';
const waitingFiles = ['/offline.html', '/offline.js', '/offline.css', '/app-icon.svg'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    await cache.addAll(waitingFiles.map(path => new Request(path, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('local-tex-editor-connection-') && name !== cacheName) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

// Project files, API responses and the editor's JavaScript always use the
// running application. Only this small connection page is available offline.
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (request.mode === 'navigate' && url.pathname === '/') {
    event.respondWith(fetch(request).catch(async () => (await caches.open(cacheName)).match('/offline.html')));
  } else if (waitingFiles.includes(url.pathname)) {
    event.respondWith(fetch(request).catch(async () => (await caches.open(cacheName)).match(url.pathname)));
  }
});
