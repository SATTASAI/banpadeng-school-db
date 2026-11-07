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
    <button type="button" data-tab="messages" aria-label="ข้อความ">${icon('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>')}<span>ข้อความ</span></button>
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
    e.preventDefault(); closeChat(); window.setMobileMenu?.(false); openAccount(); setActive('account');
  }, true);
  // แผงแจ้งเตือน: แถบบนมี backdrop-filter ทำให้ position:fixed ติดกรอบแถบบน → บนมือถือย้ายไปไว้ที่ body
  let snHome = null, snNext = null;
  const placeNotifications = () => {
    const sn = $('schoolNotifications'); if (!sn) return false;
    if (!snHome && sn.parentElement !== document.body) { snHome = sn.parentElement; snNext = sn.nextSibling; }
    if (phone.matches) { if (sn.parentElement !== document.body) document.body.append(sn); sn.classList.add('sn-mobile'); }
    else if (snHome && sn.parentElement !== snHome) { snHome.insertBefore(sn, snNext); sn.classList.remove('sn-mobile'); }
    return true;
  };
  if (!placeNotifications()) { const t = setInterval(() => { if (placeNotifications()) clearInterval(t); }, 300); setTimeout(() => clearInterval(t), 15000); }
  phone.addEventListener('change', placeNotifications);
  const setActive = (tab) => bar.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  // Keep one live chat frame above the bar; hiding it must not reset its draft or scroll position.
  const chatOrigin = 'https://notify.banpadengschool.ac.th';
  const chatPanel = document.createElement('section');
  chatPanel.id = 'mobileChatPanel';
  chatPanel.className = 'mobile-chat-panel';
  chatPanel.setAttribute('aria-label', 'ข้อความโรงเรียน');
  chatPanel.setAttribute('aria-hidden', 'true');
  chatPanel.inert = true;
  chatPanel.innerHTML = '<div class="mobile-chat-status" role="status"><p>กำลังเปิดห้องข้อความ…</p><button type="button" hidden>ลองอีกครั้ง</button></div>';
  const chatStatus = chatPanel.querySelector('.mobile-chat-status');
  const chatRetry = chatStatus.querySelector('button');
  const chatFrame = document.createElement('iframe');
  chatFrame.title = 'ห้องข้อความโรงเรียน';
  chatFrame.referrerPolicy = 'no-referrer';
  chatFrame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
  chatPanel.prepend(chatFrame);
  document.body.append(chatPanel);
  const chatButton = bar.querySelector('[data-tab=messages]');
  chatButton.setAttribute('aria-controls', chatPanel.id);
  chatButton.setAttribute('aria-expanded', 'false');
  let chatOpen = false, chatLoaded = false, chatConnecting = false, chatTimeout, previousTab = 'home';
  const background = document.querySelector('.layout');
  let backgroundWasInert = false;
  const sendChatVisibility = () => chatFrame.contentWindow?.postMessage({ type: 'school-chat-visibility', visible: chatOpen }, chatOrigin);
  const positionChat = () => {
    if (!chatOpen) return;
    const viewport = window.visualViewport;
    const height = viewport?.height || window.innerHeight;
    const top = viewport?.offsetTop || 0;
    const keyboardInset = Math.max(0, window.innerHeight - top - height);
    const barHeight = bar.getBoundingClientRect().height || 84;
    document.documentElement.style.setProperty('--chat-keyboard-inset', keyboardInset + 'px');
    chatPanel.style.top = top + 'px';
    chatPanel.style.height = Math.max(0, height - barHeight) + 'px';
  };
  const chatError = (text) => {
    chatLoaded = false;
    chatStatus.hidden = false;
    chatStatus.querySelector('p').textContent = text || 'เปิดแชทไม่สำเร็จ ลองอีกครั้ง';
    chatRetry.hidden = false;
  };
  const connectChat = async () => {
    if (chatConnecting || chatLoaded) return;
    chatConnecting = true;
    chatStatus.hidden = false;
    chatStatus.querySelector('p').textContent = 'กำลังเปิดห้องข้อความ…';
    chatRetry.hidden = true;
    try {
      const data = await apiRequest('/api/push/link', { signal: AbortSignal.timeout(15000) });
      if (!data.allowed || !data.url) throw new Error('บัญชีนี้ยังไม่เปิดใช้ห้องข้อความ');
      const target = new URL(data.url);
      if (target.origin !== chatOrigin || !target.searchParams.get('t')) throw new Error('ลิงก์เชื่อมบัญชีไม่ถูกต้อง');
      target.searchParams.set('chat', '1');
      target.searchParams.set('embedded', '1');
      clearTimeout(chatTimeout);
      chatTimeout = setTimeout(() => chatError('โหลดแชทไม่สำเร็จ ลองอีกครั้ง'), 20000);
      chatFrame.src = target.href;
    } catch (error) { chatError(error.message); }
    finally { chatConnecting = false; }
  };
  chatRetry.onclick = () => { chatLoaded = false; connectChat(); };
  chatFrame.addEventListener('load', sendChatVisibility);
  const openChat = () => {
    if (chatOpen) return;
    previousTab = bar.querySelector('[data-tab].active')?.dataset.tab || '';
    chatOpen = true;
    window.setMobileMenu?.(false);
    document.querySelector('#schoolNotifications .sn-panel')?.setAttribute('hidden', '');
    if (background) { backgroundWasInert = background.inert; background.inert = true; }
    document.body.classList.add('mobile-chat-open');
    positionChat();
    chatPanel.inert = false;
    chatPanel.setAttribute('aria-hidden', 'false');
    chatPanel.classList.add('is-open');
    chatButton.setAttribute('aria-expanded', 'true');
    setActive('messages');
    sendChatVisibility();
    if (!chatLoaded) connectChat();
  };
  const closeChat = () => {
    if (!chatOpen) return;
    chatOpen = false;
    sendChatVisibility();
    chatPanel.classList.remove('is-open');
    chatPanel.setAttribute('aria-hidden', 'true');
    chatPanel.inert = true;
    chatButton.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('mobile-chat-open');
    if (background) background.inert = backgroundWasInert;
    setActive(previousTab);
    refreshMessages();
  };
  window.addEventListener('message', (event) => {
    if (event.origin !== chatOrigin || event.source !== chatFrame.contentWindow) return;
    if (event.data?.type === 'school-chat-ready') {
      clearTimeout(chatTimeout);
      chatLoaded = true;
      chatStatus.hidden = true;
      sendChatVisibility();
    } else if (event.data?.type === 'school-chat-read') refreshMessages();
    else if (event.data?.type === 'school-chat-error') {
      clearTimeout(chatTimeout);
      chatError('เชื่อมต่อห้องข้อความไม่สำเร็จ ลองอีกครั้ง');
    }
  });
  window.visualViewport?.addEventListener('resize', positionChat);
  window.visualViewport?.addEventListener('scroll', positionChat);
  window.addEventListener('resize', positionChat);
  phone.addEventListener('change', () => { if (!phone.matches) closeChat(); });
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]'); if (!b) return;
    const tab = b.dataset.tab;
    if (tab !== 'messages') closeChat();
    b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop');
    try { navigator.vibrate?.(8); } catch {}
    if (tab === 'home') { window.showOverview?.(); history.replaceState(null, '', location.pathname); setActive('home'); }
    else if (tab === 'search') { const input = $('globalSearchInput'); window.setMobileMenu?.(false); input?.focus(); input?.select?.(); }
    else if (tab === 'messages') { if (chatOpen) closeChat(); else openChat(); }
    else if (tab === 'notify') { e.stopPropagation(); placeNotifications(); window.setMobileMenu?.(false); document.querySelector('#schoolNotifications .sn-toggle')?.click(); }
    else if (tab === 'account') { openAccount(); setActive('account'); }
    else if (tab === 'menu') window.setMobileMenu?.(!document.body.classList.contains('mobile-nav-open'));
  });
  // ไปหน้าอื่นจากเมนูด้านข้าง → ปุ่มภาพรวมไม่ active
  document.addEventListener('click', (e) => {
    if (e.target.closest('#overviewNav,#homeLink')) { closeChat(); setActive('home'); }
    else if (e.target.closest('.sidebar nav a[data-page],.sidebar nav .nav-child,.global-search-results')) { closeChat(); setActive(''); }
  });
  // จุดแดงงานค้างที่ปุ่มเมนู/ภาพรวม (คำนวณใน dashboard.html)
  const dotOn = (btn, on) => { let d = btn.querySelector('.mt-dot'); if (on && !d) { d = document.createElement('i'); d.className = 'mt-dot'; btn.appendChild(d); } else if (!on && d) d.remove(); };
  window.addEventListener('menu-dots', (e) => { dotOn(bar.querySelector('[data-tab=menu]'), !!e.detail?.menu); dotOn(bar.querySelector('[data-tab=home]'), !!e.detail?.overview); });
  // Chat unread state is independent of the bell. Opening the tab alone does not clear it.
  const messageButton = bar.querySelector('[data-tab=messages]');
  let messageLoading = false;
  const setMessageUnread = (unread) => {
    dotOn(messageButton, unread);
    messageButton.querySelector('.mt-dot')?.setAttribute('aria-hidden', 'true');
    messageButton.setAttribute('aria-label', unread ? 'ข้อความ มีข้อความที่ยังไม่อ่าน' : 'ข้อความ');
  };
  const refreshMessages = async () => {
    if (!phone.matches || document.hidden || messageLoading || typeof apiRequest !== 'function') return;
    messageLoading = true;
    try {
      const data = await apiRequest('/api/push/chat-unread');
      setMessageUnread(data.unread === true);
    } catch (error) {
      if (error.status === 401) setMessageUnread(false);
      // Keep the last known state during a connection failure.
    } finally { messageLoading = false; }
  };
  refreshMessages();
  setInterval(refreshMessages, 30000);
  window.addEventListener('pageshow', refreshMessages);
  window.addEventListener('focus', refreshMessages);
  document.addEventListener('visibilitychange', refreshMessages);
  phone.addEventListener('change', refreshMessages);
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
