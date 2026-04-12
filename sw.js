importScripts('/firebase-messaging-sw.js');

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => caches.delete(cacheName))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      if (clientList.length > 0) {
        let client = clientList[0];
        for (let i = 0; i < clientList.length; i++) {
          if (clientList[i].focused) {
            client = clientList[i];
          }
        }
        return client.focus().then(c => {
          if (event.notification.data && event.notification.data.matchId) {
            c.postMessage({ type: 'openMatch', matchId: event.notification.data.matchId });
          }
        });
      }
      return clients.openWindow('/').then(c => {
          if (event.notification.data && event.notification.data.matchId) {
            setTimeout(() => {
                c.postMessage({ type: 'openMatch', matchId: event.notification.data.matchId });
            }, 2000);
          }
      });
    })
  );
});
