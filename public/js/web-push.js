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
  const withTimeout = (promise, ms, message) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);
  // รอให้ service worker พร้อมก่อนสมัคร (Safari ค้างถ้าสมัครตอนยังติดตั้งไม่เสร็จ)
  async function readyRegistration() {
    await registration();
    return withTimeout(navigator.serviceWorker.ready, 15000, 'เตรียมระบบแจ้งเตือนไม่สำเร็จ ลองปิดแอปแล้วเปิดใหม่ แล้วกดอีกครั้ง');
  }
  async function getConfig() { return config ||= await apiRequest('/api/push/link'); }
  async function currentSubscription() { if (!supported) return null; const reg = await registration(); return reg.pushManager.getSubscription(); }

  // สถานะของเครื่องนี้: unavailable | ios-home | blocked | off | on
  async function state() {
    const c = await getConfig();
    if (!c || !c.allowed) return { status: 'unavailable' };
    if (!supported) return { status: isIOS && !standalone ? 'ios-home' : 'unsupported', config: c };
    if (Notification.permission === 'denied') return { status: 'blocked', config: c };
    const sub = Notification.permission === 'granted' ? await currentSubscription() : null;
    let mine = false;
    if (sub) {
      // ตรวจว่าเครื่องนี้ผูกกับบัญชีนี้อยู่จริง (ไม่ใช่แค่มีเครื่องอื่นผูกไว้)
      try { mine = (await apiRequest('/api/push/device', { method: 'POST', body: { endpoint: sub.endpoint } })).linked; } catch { mine = Boolean(c.linked); }
    }
    return { status: sub && mine ? 'on' : 'off', config: c, subscription: sub };
  }

  async function enable() {
    const perm = await Notification.requestPermission(); // ต้องเรียกทันทีที่กดปุ่ม (iOS)
    if (perm !== 'granted') throw new Error(perm === 'denied' ? UNBLOCK_STEPS : 'ยังไม่ได้กดอนุญาต ลองกดอีกครั้งแล้วเลือก “อนุญาต”');
    const c = await getConfig();
    if (!c.publicKey) throw new Error('ระบบแจ้งเตือนยังไม่พร้อม ลองใหม่อีกครั้ง');
    const reg = await readyRegistration();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await withTimeout(reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(c.publicKey) }),
      20000, 'เครื่องไม่ตอบสนองตอนลงทะเบียนแจ้งเตือน ลองปิดแอปแล้วเปิดใหม่ แล้วกดอีกครั้ง');
    await withTimeout(apiRequest('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } }),
      20000, 'เชื่อมต่อระบบแจ้งเตือนไม่สำเร็จ ตรวจอินเทอร์เน็ตแล้วลองอีกครั้ง');
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

  // เบราว์เซอร์บล็อกการแจ้งเตือนไว้ (เคยกดไม่อนุญาต/ปิดคำขอหลายครั้ง Chrome จะ "บล็อกโดยอัตโนมัติ") — ต้องปลดเองในตั้งค่า
  const UNBLOCK_STEPS = isIOS
    ? 'การแจ้งเตือนถูกปิดไว้ — เปิดที่ การตั้งค่า → การแจ้งเตือน → บ้านป่าเด็ง → อนุญาตการแจ้งเตือน แล้วกลับมากดอีกครั้ง'
    : 'การแจ้งเตือนถูกบล็อกไว้ — แตะไอคอน 🔒/⚙️ หน้าที่อยู่เว็บ → สิทธิ์ → การแจ้งเตือน → อนุญาต (หรือ Chrome → ⋮ → การตั้งค่า → การตั้งค่าเว็บไซต์ → การแจ้งเตือน → system.banpadengschool.ac.th → อนุญาต) แล้วโหลดหน้าใหม่';
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

  // ป็อปอัพขอเปิดแจ้งเตือน: ขึ้นครั้งแรกครั้งเดียวหลังเข้าสู่ระบบ (login.html ตั้ง bpdPushPrompt) ทุกอุปกรณ์
  const PROMPT_KEY = 'bpdPushPrompt';
  const SEEN_KEY = 'bpdPushPromptSeen';
  async function loginPopup() {
    try {
      if (localStorage.getItem(PROMPT_KEY) !== '1') return false;
      localStorage.removeItem(PROMPT_KEY);
    } catch { return false; }
    const s = await state().catch(() => ({ status: 'unavailable' }));
    // ขึ้นแค่ครั้งแรกของแต่ละบัญชีบนเครื่องนี้ (เครื่องใช้ร่วมกัน: คนถัดไปก็เห็นครั้งแรกของตัวเอง)
    const seenKey = `${SEEN_KEY}:${s.config?.user_id || ''}`;
    try { if (localStorage.getItem(seenKey)) return false; } catch { return false; }
    if (!['off', 'ios-home'].includes(s.status)) return false;
    try { localStorage.setItem(seenKey, String(Date.now())); } catch { /* ignore */ }
    const ios = s.status === 'ios-home';
    const wrap = document.createElement('div');
    wrap.className = 'bpd-push-modal';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.innerHTML = `<style>.bpd-push-modal{position:fixed;inset:0;z-index:2000;display:grid;place-items:center;padding:20px;background:rgba(16,32,60,.45);backdrop-filter:blur(3px);animation:bpdFade .18s ease}
      @keyframes bpdFade{from{opacity:0}to{opacity:1}}@keyframes bpdRing{0%,100%{transform:rotate(0)}20%{transform:rotate(14deg)}40%{transform:rotate(-12deg)}60%{transform:rotate(8deg)}80%{transform:rotate(-4deg)}}
      .bpd-push-modal .box{width:min(400px,100%);background:#fff;border-radius:20px;padding:26px 22px 20px;text-align:center;box-shadow:0 24px 60px rgba(16,32,60,.28);font-size:15px;line-height:1.6;color:#1c2c40}
      .bpd-push-modal .bell{width:76px;height:76px;margin:0 auto 12px;border-radius:50%;display:grid;place-items:center;font-size:38px;background:linear-gradient(135deg,#4F6BED,#7B4FE0);box-shadow:0 10px 24px rgba(79,107,237,.35)}
      .bpd-push-modal .bell span{display:inline-block;animation:bpdRing 1.4s ease .3s 2}
      .bpd-push-modal h2{margin:0 0 6px;font-size:20px;color:#1e3a8a}.bpd-push-modal p{margin:0 0 16px;color:#4a5d73}
      .bpd-push-modal .steps{text-align:left;background:#f4f7ff;border:1px solid #dbe4fb;border-radius:12px;padding:12px 14px;margin:0 0 16px;font-size:14px}
      .bpd-push-modal button{display:block;width:100%;font:inherit;font-weight:700;border:0;border-radius:12px;padding:13px;cursor:pointer;margin-top:8px}
      .bpd-push-modal .go{background:linear-gradient(135deg,#4F6BED,#7B4FE0);color:#fff;font-size:16px}.bpd-push-modal .later{background:#eef2f8;color:#3b5068}
      .bpd-push-modal .msg{margin-top:10px;font-size:13px;min-height:1em}</style>
      <div class="box"><div class="bell"><span>🔔</span></div>
      <h2>เปิดการแจ้งเตือน</h2>
      <p>รับแจ้งเตือนใบลา แจ้งซ่อม นิเทศ และงานในกระดิ่งทั้งหมด เด้งเข้าเครื่องนี้ทันที ไม่ต้องเปิดระบบค้างไว้</p>
      ${ios ? `<div class="steps"><b>iPhone / iPad</b><br>${IOS_STEPS}</div><button class="later" type="button">เข้าใจแล้ว</button>`
        : '<button class="go" type="button">อนุญาตการแจ้งเตือน</button><button class="later" type="button">ไว้ทีหลัง</button>'}
      <div class="msg" role="status"></div></div>`;
    document.body.appendChild(wrap);
    const close = () => wrap.remove();
    wrap.querySelector('.later').onclick = close;
    const go = wrap.querySelector('.go');
    if (go) go.onclick = async () => {
      go.disabled = true;
      const label = go.textContent;
      go.textContent = 'กำลังเชื่อมต่อ…';
      const msg = wrap.querySelector('.msg');
      try {
        await enable();
        wrap.querySelector('h2').textContent = 'เปิดการแจ้งเตือนแล้ว ✅';
        wrap.querySelector('p').textContent = 'กำลังส่งแจ้งเตือนทดสอบมาที่เครื่องนี้…';
        go.remove(); wrap.querySelector('.later').textContent = 'ปิด';
        await test().catch(() => {});
        setTimeout(close, 3500);
      } catch (e) { msg.textContent = e.message; go.disabled = false; go.textContent = label; }
    };
    return true;
  }

  window.BpdPush = { state, enable, disable, test, banner, loginPopup, isIOS, standalone, IOS_STEPS, UNBLOCK_STEPS };
  // ลงทะเบียน service worker ไว้ เพื่อให้กดแจ้งเตือนแล้วเปิดหน้าในระบบได้
  if (supported) registration().catch(() => {});
})();
