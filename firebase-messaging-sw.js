importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

const firebaseConfig = {
    apiKey: "AIzaSyAFaXweRjTkEL6WZZUzvJNPsr2Et-uwH94",
    authDomain: "rabona-media.firebaseapp.com",
    projectId: "rabona-media",
    storageBucket: "rabona-media.firebasestorage.app",
    messagingSenderId: "687991431553",
    appId: "1:687991431553:web:d047c1f2d6af53e9f20880",
    measurementId: "G-75VQ3Q8GH7"
};

firebase.initializeApp(firebaseConfig);
const messaging = firebase.messaging();

// Create BroadcastChannel to communicate with main thread
const bc = new BroadcastChannel('goal_notifications');

messaging.onBackgroundMessage((payload) => {
    console.log('[FCM SW] Received background message:', payload);
    
    const notificationTitle = payload.notification?.title || payload.data?.title || "Rabona Media";
    const notificationBody = payload.notification?.body || payload.data?.body || "Yeni xəbər var.";
    
    // Broadcast to main thread if open
    bc.postMessage({
        type: 'GOAL_NOTIFICATION',
        payload: {
            title: notificationTitle,
            body: notificationBody,
            matchId: payload.data?.matchId,
            time: new Date().toLocaleTimeString('az-AZ', { hour: '2-digit', minute: '2-digit' })
        }
    });

    // On many platforms (Chrome, Safari), if payload.notification is present, 
    // the browser shows it automatically. We only show it manually if it's a data-only message.
    if (!payload.notification) {
        const notificationOptions = {
            body: notificationBody,
            icon: 'https://imglink.cc/cdn/hC_7Jg-pCe.png',
            badge: 'https://imglink.cc/cdn/hC_7Jg-pCe.png',
            data: payload.data,
            tag: payload.data?.matchId ? `goal-${payload.data.matchId}` : 'general',
            vibrate: [200, 100, 200],
            requireInteraction: true,
            sound: 'default'
        };
        return self.registration.showNotification(notificationTitle, notificationOptions);
    }
});

