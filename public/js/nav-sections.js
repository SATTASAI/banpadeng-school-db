/* เมนูด้านซ้าย: พับตามหมวด (กดหัวหมวดเพื่อกาง เปิดได้ทีละหมวด หมวดของหน้าที่อยู่เปิดค้างไว้) */
(() => {
  const nav = document.querySelector('.sidebar nav'); if (!nav) return;
  const KEY = 'school-nav-section';
  const labels = [...nav.querySelectorAll(':scope > .nav-label')];
  if (!labels.length) return;
  const svg = (d) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICONS = [
    [/ข้อมูลหลัก/, 'c-blue', '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>'],
    [/ฝ่าย/, 'c-indigo', '<path d="M3 21h18"/><path d="M5 21V7l7-4 7 4v14"/><path d="M9 21v-5h6v5"/><path d="M9 10h.01M15 10h.01"/>'],
    [/สนับสนุน/, 'c-teal', '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/>'],
    [/บริหารระบบ/, 'c-violet', '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'],
    [/นำเข้า/, 'c-mint', '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>'],
  ];
  const itemsOf = (i) => [...nav.querySelectorAll(`:scope > [data-sec="${i}"]`)];
  const visibleCount = (i) => itemsOf(i).filter((el) => !el.hidden && el.style.display !== 'none').length;
  const decorate = (label, i) => {
    if (!label.querySelector('.sh-text')) {
      const text = label.textContent.trim();
      const [, cls, d] = ICONS.find(([re]) => re.test(text)) || [null, 'c-blue', '<path d="M4 6h16M4 12h16M4 18h16"/>'];
      label.dataset.tone = cls;
      label.innerHTML = `<i class="sh-ic">${svg(d)}</i><span class="sh-text"><b></b><small></small></span><i class="sh-chev" aria-hidden="true"></i>`;
      label.querySelector('b').textContent = text;
    }
    const n = visibleCount(i), small = label.querySelector('small'), t = n + ' เมนู';
    if (small.textContent !== t) small.textContent = t;
  };
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
    const shown = itemsOf(i ?? -1).filter((el) => !el.hidden && el.style.display !== 'none');
    shown.forEach((el, k) => { el.classList.toggle('sec-first', k === 0); el.classList.toggle('sec-last', k === shown.length - 1); el.style.setProperty('--sec-i', k); });
    if (remember) try { i === null ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, String(i)); } catch {}
  };
  const toggle = (i) => set(open === i ? null : i);
  labels.forEach((l, i) => {
    l.addEventListener('click', () => toggle(i));
    l.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(i); } });
  });
  const activeSec = () => { const a = nav.querySelector(':scope > a.active[data-sec], :scope > [data-sec] a.active'); const host = a?.closest(':scope > [data-sec]') || a; return host?.dataset.sec != null ? +host.dataset.sec : null; };
  const dots = () => labels.forEach((l, i) => l.classList.toggle('sec-dot', !!nav.querySelector(`:scope > [data-sec="${i}"][data-has-new], :scope > [data-sec="${i}"] [data-has-new]`)));
  let last = null, busy = false;
  const sync = () => {
    if (busy) return; busy = true;
    labels.forEach(decorate);
    const s = activeSec();
    if (s !== null && s !== last && s !== open) set(s);
    last = s; dots();
    busy = false;
  };
  new MutationObserver(() => queueMicrotask(sync)).observe(nav, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'data-has-new', 'style', 'hidden'] });
  let saved = null; try { const v = localStorage.getItem(KEY); saved = v === null ? null : +v; } catch {}
  labels.forEach(decorate);
  last = activeSec();
  set(last ?? saved, false); dots();
})();
