self.__WB_DISABLE_DEV_LOGS = true;

const CACHE_VERSION = 'luna-meeting-room-20260716a';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/app.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

try {
  importScripts('https://unpkg.com/workbox-sw@7.1.0/build/workbox-sw.js');
  if (self.workbox) {
    self.workbox.precaching.precacheAndRoute(STATIC_ASSETS.map((url) => ({ url, revision: CACHE_VERSION })));
    self.workbox.routing.registerRoute(
      ({ url }) => url.origin === self.location.origin && url.pathname.startsWith('/api/meetings'),
      new self.workbox.strategies.NetworkFirst({
        cacheName: `${CACHE_VERSION}-meetings`,
        networkTimeoutSeconds: 5,
      }),
    );
    self.workbox.routing.registerRoute(
      ({ url }) => url.origin === 'https://unpkg.com',
      new self.workbox.strategies.StaleWhileRevalidate({
        cacheName: `${CACHE_VERSION}-cdn`,
      }),
    );
  }
} catch (error) {
  console.warn('[luna-meeting-room] workbox unavailable:', error?.message || String(error));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('luna-meeting-room-') && key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request)),
  );
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const title = payload.title || 'Luna 회의 알림';
  const options = {
    body: payload.body || '새 회의가 시작됐습니다.',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: {
      url: payload.url || (payload.meetingId ? `/?meeting=${encodeURIComponent(payload.meetingId)}` : '/'),
    },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          client.navigate?.(targetUrl);
          return client.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
    }),
  );
});
