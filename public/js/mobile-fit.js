/* มือถือ: กันหน้าเลื่อนซ้ายขวา — ตารางที่กว้างเกินจอถูกห่อด้วยกรอบเลื่อนของตัวเอง (หน้าไม่ขยับ แต่ยังเลื่อนดูตารางได้) */
(() => {
  const phone = window.matchMedia('(max-width:720px)');
  const scrollable = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll') return true; } return false; };
  function fit() {
    if (!phone.matches) return;
    const W = document.documentElement.clientWidth;
    document.querySelectorAll('table').forEach((t) => {
      if (t.closest('.mfit-scroll') || t.getBoundingClientRect().right <= W + 1 || scrollable(t)) return;
      const wrap = document.createElement('div');
      wrap.className = 'mfit-scroll';
      t.parentNode.insertBefore(wrap, t); wrap.appendChild(t);
    });
  }
  let timer = 0;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(fit, 120); };
  const start = () => { fit(); new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true }); window.addEventListener('resize', schedule); phone.addEventListener('change', schedule); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
