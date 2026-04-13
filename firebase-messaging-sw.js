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

messaging.onBackgroundMessage((payload) => {
    console.log('[firebase-messaging-sw.js] Received background message ', payload);
    
    // Əgər payload-da notification obyekti varsa, onu göstər
    if (payload.notification) {
        const notificationTitle = payload.notification.title || "Yeni Qol!";
        const notificationOptions = {
            body: payload.notification.body || "Matçda yenilik var.",
            icon: '/favicon.ico', 
            badge: '/favicon.ico',
            data: payload.data, 
            vibrate: [300, 100, 400],
            requireInteraction: true,
            silent: false
        };
        return self.registration.showNotification(notificationTitle, notificationOptions);
    }
});
