/* เมนูด้านซ้าย: พับตามหมวด (กดหัวหมวดเพื่อกาง เปิดได้ทีละหมวด หมวดของหน้าที่อยู่เปิดค้างไว้) */
(() => {
  const nav = document.querySelector('.sidebar nav'); if (!nav) return;
  const KEY = 'school-nav-section';
  const labels = [...nav.querySelectorAll(':scope > .nav-label')];
  if (!labels.length) return;
  labels.forEach((label, i) => {
    label.classList.add('sec-head'); label.dataset.secHead = i;
    label.setAttribute('role', 'button'); label.tabIndex = 0;
    for (let el = label.nextElementSibling; el && !el.classList.contains('nav-label'); el = el.nextElementSibling) el.dataset.sec = i;
  });
  let open = null;
  const set = (i, remember = true) => {
    open = i;
    labels.forEach((l, j) => { l.classList.toggle('sec-open', j === i); l.setAttribute('aria-expanded', String(j === i)); });
    nav.querySelectorAll(':scope > [data-sec]').forEach((el) => el.classList.toggle('sec-on', +el.dataset.sec === i));
    if (remember) try { i === null ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, String(i)); } catch {}
  };
  const toggle = (i) => set(open === i ? null : i);
  labels.forEach((l, i) => {
    l.addEventListener('click', () => toggle(i));
    l.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(i); } });
  });
  const activeSec = () => { const a = nav.querySelector(':scope > a.active[data-sec], :scope > [data-sec] a.active'); const host = a?.closest(':scope > [data-sec]') || a; return host?.dataset.sec != null ? +host.dataset.sec : null; };
  // จุดแดงของรายการที่ซ่อนอยู่ → แสดงที่หัวหมวด
  const dots = () => labels.forEach((l, i) => l.classList.toggle('sec-dot', !!nav.querySelector(`:scope > [data-sec="${i}"][data-has-new], :scope > [data-sec="${i}"] [data-has-new]`)));
  let last = null;
  new MutationObserver(() => {
    const s = activeSec();
    if (s !== null && s !== last && s !== open) set(s);
    last = s; dots();
  }).observe(nav, { subtree: true, attributes: true, attributeFilter: ['class', 'data-has-new'] });
  let saved = null; try { const v = localStorage.getItem(KEY); saved = v === null ? null : +v; } catch {}
  last = activeSec();
  set(last ?? saved, false); dots();
})();
