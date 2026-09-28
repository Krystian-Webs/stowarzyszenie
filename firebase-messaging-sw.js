/* Event Kraft – odbieranie powiadomień w tle (musi leżeć obok index.html) */
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyClTPdn54xuh3aLrhvJiJUXcCRr1LM29II",
  authDomain: "event-kraft.firebaseapp.com",
  projectId: "event-kraft",
  storageBucket: "event-kraft.firebasestorage.app",
  messagingSenderId: "793899620618",
  appId: "1:793899620618:web:08d7d48a6fb101b5a5c2f3"
});
firebase.messaging();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
