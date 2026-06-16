self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    try {
      await self.clients.claim();
    } catch (error) {
      console.warn('[SW] claim skipped:', error && error.message ? error.message : error);
    }
  })());
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  if (event.request.method !== 'GET' || url.pathname.startsWith('/api/')) {
    return;
  }

  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request));
    return;
  }

  event.respondWith(
    fetch(event.request).catch(() => new Response(null, { status: 204, statusText: 'No Content' }))
  );
});

function absoluteAsset(path) {
  try {
    return new URL(path, self.location.origin).href;
  } catch (e) {
    return path;
  }
}

self.addEventListener('push', event => {
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

  const notificationData = payload.notification || payload;
  const customData = payload.data || notificationData.data || {};
  const title = notificationData.title || customData.title || 'Rabona Media';
  const body = notificationData.body || customData.body || 'Yeni bildiriş var.';
  const matchId = customData.matchId || "";
  const targetUrl = customData.url || '/';
  const icon = absoluteAsset(notificationData.icon || customData.icon || '/icons/icon-192.png');
  const badge = absoluteAsset(notificationData.badge || customData.badge || '/icons/icon-192.png');
  const requireInteraction = notificationData.requireInteraction ?? customData.requireInteraction ?? false;

  const options = {
    body,
    icon,
    badge,
    vibrate: notificationData.vibrate || customData.vibrate || [200, 100, 200],
    tag: notificationData.tag || customData.tag || (matchId ? `goal-${matchId}` : 'general'),
    renotify: true,
    requireInteraction: requireInteraction === true || requireInteraction === 'true',
    silent: false,
    timestamp: Date.now(),
    data: { ...customData, title, body, url: targetUrl, matchId }
  };

  event.waitUntil(
    self.registration.showNotification(title, options).then(() => {
      try {
        const bc = new BroadcastChannel('goal_notifications');
        bc.postMessage({
          type: 'GOAL_NOTIFICATION',
          payload: {
            title,
            body,
            matchId,
            time: new Date().toLocaleTimeString('az-AZ', { hour: '2-digit', minute: '2-digit' })
          }
        });
      } catch (e) {}
    }).catch(error => {
      console.warn('[SW] showNotification failed:', error && error.message ? error.message : error);
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      const matchId = event.notification.data?.matchId;
      const targetUrl = event.notification.data?.url || '/';
      const focused = clientList.find(client => client.focused) || clientList[0];
      if (focused) {
        return focused.focus().then(client => {
          if (matchId) client.postMessage({ type: 'openMatch', matchId });
        });
      }
      return clients.openWindow(targetUrl).then(client => {
        if (client && matchId) {
          setTimeout(() => client.postMessage({ type: 'openMatch', matchId }), 1600);
        }
      });
    })
  );
});
