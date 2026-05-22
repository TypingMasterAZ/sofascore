const CACHE_NAME = 'proscore-shell-v44';
const ASSETS_TO_CACHE = [
  '/manifest.json?v=3',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;900&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css'
];

// No external SW imports needed, sw.js handles all pushes natively

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Pre-caching offline shell v44');
      return Promise.allSettled(
        ASSETS_TO_CACHE.map(url => cache.add(url).catch(e => console.warn('[SW] Cache miss:', url, e.message)))
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('[SW] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API sorğularını SW-dan keç
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) {
    return;
  }

  // Xarici ses fayllarını (mixkit.co, vs.) SW-dan keç - səs faylları Response kimi saxlanmır
  if (url.hostname !== self.location.hostname) {
    event.respondWith(
      fetch(event.request).catch(() => new Response('', { status: 503 }))
    );
    return;
  }

  // index.html üçün həmişə network-first - köhnə versiya göstərməsin
  if (url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' })
        .catch(() => new Response('', { status: 503 }))
    );
    return;
  }

  // Digər static fayllar: Cache First
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request).then((fetchRes) => {
        if (event.request.method === 'GET' && fetchRes.status === 200) {
          const cacheRes = fetchRes.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, cacheRes);
            limitCacheSize(CACHE_NAME, 100);
          });
        }
        return fetchRes;
      });
    }).catch(() => {
      if (event.request.mode === 'navigate') {
        return caches.match('/');
      }
      return new Response('', { status: 503 });
    })
  );
});

function limitCacheSize(name, maxItems) {
  caches.open(name).then(cache => {
    cache.keys().then(keys => {
      if (keys.length > maxItems) {
        cache.delete(keys[0]).then(() => limitCacheSize(name, maxItems));
      }
    });
  });
}

function absoluteAsset(path) {
  try {
    return new URL(path, self.location.origin).href;
  } catch (e) {
    return path;
  }
}

self.addEventListener('push', (event) => {
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch (e) {
      payload = { title: 'Rabona Media', body: event.data.text() };
    }
  } else {
    payload = { title: 'Rabona Media', body: 'Yeni bildiris var.' };
  }

  // Handle both WebPush (VAPID) and FCM payload structures
  const notificationData = payload.notification || payload;
  const customData = payload.data || notificationData.data || {};

  const title = notificationData.title || customData.title || 'Rabona Media';
  const body = notificationData.body || customData.body || 'Yeni bildiriş var.';
  const matchId = customData.matchId || "";
  const targetUrl = customData.url || '/';
  const requireInteraction = notificationData.requireInteraction ?? customData.requireInteraction ?? false;
  const icon = absoluteAsset(notificationData.icon || customData.icon || '/icons/icon-192.png');
  const badge = absoluteAsset(notificationData.badge || customData.badge || '/icons/icon-192.png');

  const options = {
    body: body,
    icon,
    badge,
    vibrate: notificationData.vibrate || customData.vibrate || [200, 100, 200],
    tag: notificationData.tag || customData.tag || (matchId ? `goal-${matchId}` : 'general'),
    renotify: true,
    requireInteraction: requireInteraction === true || requireInteraction === 'true',
    silent: false,
    timestamp: Date.now(),
    data: { ...customData, title, body, url: targetUrl }
  };

  event.waitUntil(
    (async () => {
      try {
        await self.registration.showNotification(title, options);
      } catch (error) {
        console.warn('[SW] showNotification primary failed:', error && error.message ? error.message : error);
        await self.registration.showNotification(title, {
          body,
          icon,
          badge,
          tag: options.tag,
          renotify: true,
          silent: false,
          data: options.data
        });
      }
      try {
        // Broadcast to main thread if the app is open
        const bc = new BroadcastChannel('goal_notifications');
        bc.postMessage({
            type: 'GOAL_NOTIFICATION',
            payload: {
                title: title,
                body: body,
                matchId: matchId,
                time: new Date().toLocaleTimeString('az-AZ', { hour: '2-digit', minute: '2-digit' })
            }
        });
      } catch (e) {
        console.warn('[SW] BroadcastChannel disabled in background:', e);
      }
    })()
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      if (clientList.length > 0) {
        let client = clientList[0];
        for (let i = 0; i < clientList.length; i++) {
          if (clientList[i].focused) client = clientList[i];
        }
        return client.focus().then(c => {
          if (event.notification.data && event.notification.data.matchId) {
            c.postMessage({ type: 'openMatch', matchId: event.notification.data.matchId });
          }
        });
      }
      const targetUrl = event.notification.data?.url || '/';
      return clients.openWindow(targetUrl).then(c => {
        if (event.notification.data && event.notification.data.matchId) {
          setTimeout(() => {
            c.postMessage({ type: 'openMatch', matchId: event.notification.data.matchId });
          }, 2000);
        }
      });
    })
  );
});
