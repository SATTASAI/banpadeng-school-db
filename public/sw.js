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
    // ปุ่มบนแจ้งเตือน เช่น "เปิดใบลา" ไปหน้างานโดยตรง (Android/คอมพิวเตอร์)
    actions: (d.actions || []).slice(0, 2).map((a, i) => ({ action: 'a' + i, title: a.title })),
    data: { url: d.url || '/dashboard.html', actions: (d.actions || []).map((a) => a.url) },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  const picked = /^a\d$/.test(e.action || '') ? (data.actions || [])[Number(e.action.slice(1))] : null;
  let url = new URL(picked || data.url || '/dashboard.html', self.location.origin).href;
  // ลิงก์ต่างเว็บ: เปิดผ่านหน้า /go.html ของเว็บนี้ก่อน (iPhone เปิดลิงก์ต่างเว็บจาก service worker ตรง ๆ ไม่ได้)
  if (new URL(url).origin !== self.location.origin) url = new URL('/go.html?to=' + encodeURIComponent(url), self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if (new URL(c.url).origin === self.location.origin && 'navigate' in c) return c.focus().then(() => c.navigate(url)).catch(() => self.clients.openWindow(url));
    }
    return self.clients.openWindow(url);
  }));
});
