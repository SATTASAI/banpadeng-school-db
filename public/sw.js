// Open the destination during the notification click, before awaiting any client lookup.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'โรงเรียนบ้านป่าเด็ง', {
    body: d.body || '', icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', tag: d.tag,
    actions: (d.actions || []).slice(0, 2).map((a, i) => ({ action: 'a' + i, title: a.title })),
    data: { id: d.id, url: d.url || '/', workUrl: d.workUrl, actions: (d.actions || []).map(a => a.url) },
  }));
});

function clickDestination(data, action) {
  const fallback = new URL('/notify-chat.html', self.location.origin);
  fallback.searchParams.set('chat', '1');
  let id = data.id;
  try { id ||= new URL(data.url, self.location.origin).searchParams.get('message'); } catch {}
  if (/^\d+$/.test(String(id || ''))) fallback.searchParams.set('message', String(id));
  // School System messages can open their work from the banner, including on devices without action buttons.
  const picked = /^a[01]$/.test(action || '') ? (data.actions || [])[Number(action.slice(1))] : data.workUrl;
  if (!picked) return fallback.href;
  try {
    const target = new URL(picked, self.location.origin);
    if (!['http:', 'https:'].includes(target.protocol) || (!action && target.origin !== 'https://system.banpadengschool.ac.th')) return fallback.href;
    return target.origin === self.location.origin ? target.href
      : new URL('/go.html?to=' + encodeURIComponent(target.href), self.location.origin).href;
  } catch { return fallback.href; }
}

async function reuseWindow(url) {
  const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of list) {
    try {
      if (new URL(client.url).origin !== self.location.origin || !client.navigate) continue;
      const navigated = await client.navigate(url);
      return await (navigated || client).focus();
    } catch { /* Another window may still be usable. */ }
  }
  throw new Error('No window available for notification');
}

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = clickDestination(e.notification.data || {}, e.action);
  // iOS must receive openWindow directly from the click event, without an asynchronous lookup first.
  let opening;
  try { opening = self.clients.openWindow(url); } catch (error) { opening = Promise.reject(error); }
  e.waitUntil(Promise.resolve(opening).catch(() => reuseWindow(url)).catch(error => console.error('notificationclick', error)));
});
