// Use the existing school login to obtain a fresh signed account link. Never treat a Push endpoint as login.
(async function () {
  const status = document.getElementById('status');
  const open = document.getElementById('open');
  const retry = document.getElementById('retry');
  retry.onclick = () => location.reload();
  const current = new URL(location.href);
  const message = current.searchParams.get('message');
  const next = '/notify-chat.html' + (/^\d+$/.test(message || '') ? '?message=' + message : '');
  try {
    const data = await apiRequest('/api/push/link', { signal: AbortSignal.timeout(15000) });
    if (!data.allowed || !data.url) throw new Error('บัญชีนี้ยังไม่เปิดใช้ห้องข้อความ กรุณาติดต่อผู้ดูแลระบบ');
    const target = new URL(data.url);
    if (target.protocol !== 'https:' || target.hostname !== 'notify.banpadengschool.ac.th' || !target.searchParams.get('t')) throw new Error('ลิงก์เชื่อมบัญชีไม่ถูกต้อง');
    target.searchParams.set('chat', '1');
    if (/^\d+$/.test(message || '')) target.searchParams.set('message', message);
    open.href = target.href;
    open.hidden = false;
    status.textContent = 'กำลังเปิดห้องข้อความ หากยังไม่เปิดให้แตะปุ่มด้านล่าง';
    location.replace(target.href);
  } catch (error) {
    if (error.status === 401 || /เข้าสู่ระบบ/.test(error.message || '')) {
      location.replace('/login.html?next=' + encodeURIComponent(next));
      return;
    }
    status.textContent = error.message || 'เปิดห้องข้อความไม่สำเร็จ';
    retry.hidden = false;
  }
})();
