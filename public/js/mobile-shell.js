/* แถบเมนูล่าง + ส่วนบัญชีในเมนูด้านข้าง สำหรับมือถือ (เฉพาะหน้าแดชบอร์ด) */
(() => {
  const phone = window.matchMedia('(max-width:720px)');
  const $ = (id) => document.getElementById(id);
  const icon = (d) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const bar = document.createElement('nav');
  bar.className = 'mobile-tabbar';
  bar.setAttribute('aria-label', 'เมนูลัด');
  bar.innerHTML = `
    <button type="button" data-tab="home" class="active">${icon('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>')}<span>ภาพรวม</span></button>
    <button type="button" data-tab="search">${icon('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>')}<span>ค้นหา</span></button>
    <button type="button" data-tab="notify">${icon('<path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10.3 21a2 2 0 0 0 3.4 0"/>')}<span>แจ้งเตือน</span><b class="mt-badge" hidden>0</b></button>
    <button type="button" data-tab="account">${icon('<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>')}<span>บัญชี</span></button>
    <button type="button" data-tab="menu">${icon('<path d="M4 6h16M4 12h16M4 18h16"/>')}<span>เมนู</span></button>`;
  document.body.append(bar);

  // ส่วนบัญชีในเมนูด้านข้าง (มือถือ): ชื่อ ปีการศึกษา View as ออกจากระบบ
  const drawer = $('mobileSidebar');
  const acct = document.createElement('div');
  acct.className = 'mobile-account';
  acct.innerHTML = `<div class="ma-user"><span class="top-avatar" data-ma="avatar">—</span><span><strong data-ma="name">—</strong><small data-ma="role">—</small></span></div>
    <div class="ma-year">ปีการศึกษา <strong data-ma="year">—</strong></div>
    <div class="ma-actions"><a class="btn" href="/account.html">บัญชีของฉัน</a><button type="button" class="btn" data-ma="logout">ออกจากระบบ</button></div>
    <div class="ma-viewas"></div>`;
  drawer?.querySelector('nav')?.after(acct);
  const copy = () => {
    acct.querySelector('[data-ma=avatar]').textContent = $('topAvatar')?.textContent || '—';
    acct.querySelector('[data-ma=name]').textContent = $('topUserName')?.textContent || '—';
    acct.querySelector('[data-ma=role]').textContent = $('topUserRole')?.textContent || '';
    acct.querySelector('[data-ma=year]').textContent = $('topAcademicYear')?.textContent || '—';
    const accountHidden = $('topAccountLink')?.style.display === 'none';
    acct.querySelector('a[href="/account.html"]').hidden = accountHidden;
    bar.querySelector('[data-tab=account]').hidden = accountHidden;
  };
  ['topUserName', 'topUserRole', 'topAcademicYear', 'topAvatar'].forEach((id) => { const el = $(id); if (el) new MutationObserver(copy).observe(el, { childList: true, characterData: true, subtree: true }); });
  copy();
  acct.querySelector('[data-ma=logout]').onclick = () => $('logoutLink')?.click();

  // ย้ายปุ่ม View as เข้าเมนูด้านข้างเมื่อเป็นมือถือ แล้วย้ายกลับเมื่อจอกว้าง
  const viewAs = document.querySelector('.view-as-wrap');
  const viewAsHome = viewAs?.parentElement, viewAsNext = viewAs?.nextSibling;
  const placeViewAs = () => {
    if (!viewAs) return;
    if (phone.matches) acct.querySelector('.ma-viewas').append(viewAs);
    else if (viewAs.parentElement !== viewAsHome) viewAsHome.insertBefore(viewAs, viewAsNext);
  };
  placeViewAs(); phone.addEventListener('change', placeViewAs);

  // บัญชีของฉันเปิดในกรอบหน้าเดิม เพื่อให้แถบเมนูล่างยังอยู่
  const openAccount = () => { if (typeof window.showPage === 'function') window.showPage('account', false, '/account.html'); else location.href = '/account.html'; };
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href="/account.html"]');
    if (!a || !phone.matches || e.ctrlKey || e.metaKey) return;
    e.preventDefault(); window.setMobileMenu?.(false); openAccount(); setActive('account');
  }, true);
  const setActive = (tab) => bar.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]'); if (!b) return;
    const tab = b.dataset.tab;
    b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop');
    try { navigator.vibrate?.(8); } catch {}
    if (tab === 'home') { window.showOverview?.(); history.replaceState(null, '', location.pathname); setActive('home'); }
    else if (tab === 'search') { const input = $('globalSearchInput'); window.setMobileMenu?.(false); input?.focus(); input?.select?.(); }
    else if (tab === 'notify') { e.stopPropagation(); document.querySelector('#schoolNotifications .sn-toggle')?.click(); }
    else if (tab === 'account') { openAccount(); setActive('account'); }
    else if (tab === 'menu') window.setMobileMenu?.(!document.body.classList.contains('mobile-nav-open'));
  });
  // ไปหน้าอื่นจากเมนูด้านข้าง → ปุ่มภาพรวมไม่ active
  document.addEventListener('click', (e) => {
    if (e.target.closest('#overviewNav,#homeLink')) setActive('home');
    else if (e.target.closest('.sidebar nav a[data-page],.sidebar nav .nav-child,.global-search-results')) setActive('');
  });
  // ตัวเลขแจ้งเตือน
  window.addEventListener('school-notifications', () => {
    const src = document.querySelector('#schoolNotifications .sn-count'), dst = bar.querySelector('.mt-badge');
    if (!src) return; dst.textContent = src.textContent; dst.hidden = src.hidden;
  });
  setInterval(() => {
    const src = document.querySelector('#schoolNotifications .sn-count'), dst = bar.querySelector('.mt-badge');
    if (src) { dst.textContent = src.textContent; dst.hidden = src.hidden; }
  }, 3000);
})();
