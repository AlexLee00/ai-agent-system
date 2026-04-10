// @ts-nocheck
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(Promise.resolve());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    } catch {
      // ignore cache cleanup failures
    }

    try {
      await self.registration.unregister();
    } catch {
      // ignore unregister failures
    }

    try {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        client.navigate(client.url);
      }
    } catch {
      // ignore client refresh failures
    }
  })());
});

self.addEventListener('fetch', () => {
  // Intentionally noop. This service worker only exists to unregister old PWA caches safely.
});
