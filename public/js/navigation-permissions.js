// โหลดสิทธิ์เมนูซ้ำเมื่อเครือข่ายหรือเซิร์ฟเวอร์ขัดข้องชั่วคราว
(() => {
  const failed = new Map();
  let notice;
  function showFailures() {
    if (!notice) {
      notice = document.createElement('div');
      notice.setAttribute('role', 'status');
      notice.style.cssText = 'margin:8px;padding:10px;border-radius:8px;background:#fff1dc;color:#754d12;font-size:13px';
      const message = document.createElement('span');
      message.textContent = 'เมนูบางส่วนยังโหลดไม่สำเร็จ ';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = 'โหลดเมนูใหม่';
      retry.onclick = () => { for (const task of failed.values()) task.run(); };
      notice.append(message, retry);
      document.querySelector('.sidebar nav')?.prepend(notice);
    }
    notice.hidden = failed.size === 0;
  }
  window.loadNavigationPermission = (path, apply) => {
    const task = { pending: null, run() {
      if (task.pending) return task.pending;
      task.pending = (async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 12000);
          try {
            const data = await apiRequest(path, {signal: controller.signal});
            if (!data || typeof data !== 'object') throw new Error('โหลดสิทธิ์ไม่สมบูรณ์');
            apply(data);
            failed.delete(path);
            if (notice) showFailures();
            return;
          } catch (error) {
            const transient = !error.status || error.status === 429 || error.status >= 500;
            // ขีดจำกัดฐานข้อมูลรายวันต้องรอรอบใหม่ การยิงซ้ำไม่ช่วย
            if (!transient || error.data?.code === 'DATABASE_DAILY_QUOTA_EXCEEDED' || attempt === 2) break;
          } finally {
            clearTimeout(timeout);
          }
          await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
        }
        failed.set(path, task);
        showFailures();
      })().finally(() => { task.pending = null; });
      return task.pending;
    }};
    return task.run();
  };
  window.addEventListener('online', () => { for (const task of failed.values()) task.run(); });
})();
