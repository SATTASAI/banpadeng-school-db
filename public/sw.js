// Service worker ของระบบ: รับแจ้งเตือนบนมือถือ (Web Push ผ่าน notify.banpadengschool.ac.th)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'โรงเรียนบ้านป่าเด็ง', {
    body: d.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: d.tag,
    data: { url: d.url || '/dashboard.html' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/dashboard.html', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if (new URL(c.url).origin === self.location.origin && 'navigate' in c) return c.focus().then(() => c.navigate(url)).catch(() => self.clients.openWindow(url));
    }
    return self.clients.openWindow(url);
  }));
});
