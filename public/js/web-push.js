// แจ้งเตือนบนมือถือ (Web Push) — กดปุ่มเดียวในระบบ
// BpdPush.state() / enable() / disable() / test() และ BpdPush.banner(mountEl) แถบชวนบนหน้าแรก
(function () {
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isMobile = isIOS || /Android|Mobile/i.test(ua);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  let config = null;

  const keyBytes = (b64) => { const p = '='.repeat((4 - b64.length % 4) % 4); const s = atob((b64 + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(s, (c) => c.charCodeAt(0)); };
  const registration = () => navigator.serviceWorker.register('/sw.js');
  async function getConfig() { return config ||= await apiRequest('/api/push/link'); }
  async function currentSubscription() { if (!supported) return null; const reg = await registration(); return reg.pushManager.getSubscription(); }

  // สถานะของเครื่องนี้: unavailable | ios-home | blocked | off | on
  async function state() {
    const c = await getConfig();
    if (!c || !c.allowed) return { status: 'unavailable' };
    if (!supported) return { status: isIOS && !standalone ? 'ios-home' : 'unsupported', config: c };
    if (Notification.permission === 'denied') return { status: 'blocked', config: c };
    const sub = Notification.permission === 'granted' ? await currentSubscription() : null;
    return { status: sub && c.linked ? 'on' : 'off', config: c, subscription: sub };
  }

  async function enable() {
    const perm = await Notification.requestPermission(); // ต้องเรียกทันทีที่กดปุ่ม (iOS)
    if (perm !== 'granted') throw new Error('ไม่ได้รับอนุญาตให้แจ้งเตือน — เปิดได้ที่ การตั้งค่า > การแจ้งเตือน');
    const c = await getConfig();
    if (!c.publicKey) throw new Error('ระบบแจ้งเตือนยังไม่พร้อม ลองใหม่อีกครั้ง');
    const reg = await registration();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(c.publicKey) });
    await apiRequest('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
    config = { ...c, linked: true };
    return sub;
  }
  async function disable() {
    const sub = await currentSubscription();
    if (sub) { await apiRequest('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {}); await sub.unsubscribe(); }
    config = null;
  }
  async function test() {
    const sub = await currentSubscription();
    if (!sub) throw new Error('เครื่องนี้ยังไม่ได้เปิดแจ้งเตือน');
    return apiRequest('/api/push/test', { method: 'POST', body: { endpoint: sub.endpoint } });
  }

  const IOS_STEPS = 'แตะปุ่ม <b>แชร์</b> <span aria-hidden="true">⎋</span> ด้านล่าง → <b>เพิ่มไปยังหน้าจอโฮม</b> → เปิดระบบจากไอคอน “บ้านป่าเด็ง” แล้วกดเปิดแจ้งเตือนอีกครั้ง';
  const DISMISS_KEY = 'bpdPushBannerUntil';

  // แถบชวนเปิดแจ้งเตือน (มือถือเท่านั้น) — "ไว้ทีหลัง" ซ่อน 7 วัน
  async function banner(mount) {
    if (!mount || !isMobile) return;
    try { if (Number(localStorage.getItem(DISMISS_KEY) || 0) > Date.now()) return; } catch { /* ignore */ }
    const s = await state().catch(() => ({ status: 'unavailable' }));
    if (!['off', 'ios-home'].includes(s.status)) return;
    const el = document.createElement('div');
    el.className = 'bpd-push-banner';
    el.innerHTML = `<style>.bpd-push-banner{display:flex;gap:12px;align-items:flex-start;margin:0 0 14px;padding:14px 16px;border-radius:14px;background:linear-gradient(135deg,#eef4ff,#f6f0ff);border:1px solid #cfdcf7;font-size:14px;line-height:1.55}
      .bpd-push-banner .ic{font-size:24px;line-height:1}.bpd-push-banner .tx{flex:1}.bpd-push-banner b.t{display:block;font-size:15px;color:#1e3a8a}
      .bpd-push-banner .ac{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.bpd-push-banner button{font:inherit;font-weight:650;border:0;border-radius:10px;padding:9px 14px;cursor:pointer}
      .bpd-push-banner .go{background:linear-gradient(135deg,#4F6BED,#7B4FE0);color:#fff}.bpd-push-banner .later{background:#fff;color:#33506b;border:1px solid #d6dfeb}
      .bpd-push-banner .msg{margin-top:8px;font-size:13px}</style>
      <div class="ic">🔔</div><div class="tx"><b class="t">รับแจ้งเตือนเข้ามือถือ</b>
      <span class="ds">${s.status === 'ios-home' ? 'iPhone: ' + IOS_STEPS : 'ใบลา แจ้งซ่อม นิเทศ และงานในกระดิ่งทั้งหมด เด้งเข้ามือถือทันที ฟรี'}</span>
      <div class="ac">${s.status === 'off' ? '<button class="go" type="button">เปิดแจ้งเตือน</button>' : ''}<button class="later" type="button">ไว้ทีหลัง</button></div>
      <div class="msg" role="status"></div></div>`;
    mount.prepend(el);
    const msg = el.querySelector('.msg');
    el.querySelector('.later').onclick = () => { try { localStorage.setItem(DISMISS_KEY, String(Date.now() + 7 * 86400000)); } catch { /* ignore */ } el.remove(); };
    const go = el.querySelector('.go');
    if (go) go.onclick = async () => {
      go.disabled = true;
      try { await enable(); el.querySelector('.ds').textContent = '✅ เปิดแจ้งเตือนแล้ว กำลังส่งแจ้งเตือนทดสอบ…'; el.querySelector('.ac').remove(); await test().catch(() => {}); setTimeout(() => el.remove(), 5000); }
      catch (e) { msg.textContent = e.message; go.disabled = false; }
    };
  }

  window.BpdPush = { state, enable, disable, test, banner, isIOS, standalone, IOS_STEPS };
  // ลงทะเบียน service worker ไว้ เพื่อให้กดแจ้งเตือนแล้วเปิดหน้าในระบบได้
  if (supported) registration().catch(() => {});
})();
