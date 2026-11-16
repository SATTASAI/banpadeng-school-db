/* แถบเมนูล่าง + ส่วนบัญชีในเมนูด้านข้าง สำหรับมือถือ (เฉพาะหน้าแดชบอร์ด) */
(() => {
  const phone = window.matchMedia('(max-width:720px)');
  const $ = (id) => document.getElementById(id);
  const icon = (d) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const fill = (d) => `<svg class="i-f" viewBox="0 0 24 24" width="24" height="24" fill="currentColor" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const pair = (o, f) => icon(o).replace('<svg ', '<svg class="i-o" ') + fill(f);
  const bar = document.createElement('nav');
  bar.className = 'mobile-tabbar ig-bar';
  bar.setAttribute('aria-label', 'เมนูลัด');
  bar.innerHTML = `
    <button type="button" data-tab="home" class="active" aria-label="ภาพรวม">${pair('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>', '<path d="M12 2.6 2.4 10.6a1 1 0 0 0 1.3 1.5L5 11v9.5A1.5 1.5 0 0 0 6.5 22H10v-6h4v6h3.5a1.5 1.5 0 0 0 1.5-1.5V11l1.3 1.1a1 1 0 0 0 1.3-1.5z" stroke="none"/>')}<span>ภาพรวม</span></button>
    <button type="button" data-tab="search" aria-label="ค้นหา">${pair('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>', '<circle cx="11" cy="11" r="7" fill="none" stroke-width="3"/><path d="m20 20-3.5-3.5" stroke-width="3"/>')}<span>ค้นหา</span></button>
    <button type="button" data-tab="messages" aria-label="ข้อความ">${pair('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>', '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>')}<span>ข้อความ</span></button>
    <button type="button" data-tab="notify" aria-label="แจ้งเตือน">${pair('<path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10.3 21a2 2 0 0 0 3.4 0"/>', '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10.3 21a2 2 0 0 0 3.4 0" fill="none"/>')}<span>แจ้งเตือน</span><b class="mt-badge" hidden>0</b></button>
    <button type="button" data-tab="menu" aria-label="เมนู">${pair('<path d="M4 6h16M4 12h16M4 18h16"/>', '<path d="M4 6h16M4 12h16M4 18h16" stroke-width="2.8"/>')}<span>เมนู</span></button>
    <button type="button" data-tab="account" aria-label="บัญชี"><i class="mt-avatar" aria-hidden="true">—</i><span>บัญชี</span></button>`;
  document.body.append(bar);

  // เมนูลัดของฉัน (มือถือ, ในเมนูด้านข้าง): เจ้าของบัญชีเลือกเอง เก็บตามบัญชี
  const drawer = $('mobileSidebar');
  const sc = document.createElement('section');
  sc.className = 'mobile-shortcuts';
  sc.innerHTML = `<div class="ms-head"><strong>เมนูลัดของฉัน</strong><button type="button" class="ms-edit" hidden>แก้ไข</button></div>
    <div class="ms-grid"></div><p class="ms-msg" role="status" hidden></p>`;
  drawer?.querySelector('nav')?.after(sc);
  const scGrid = sc.querySelector('.ms-grid'), scEdit = sc.querySelector('.ms-edit'), scMsg = sc.querySelector('.ms-msg');
  let shortcuts = [], scMax = 12, scEditing = false, scLoaded = false;
  const navLinks = () => [...document.querySelectorAll('.sidebar nav a[href]')].filter((a) => {
    if (a.id === 'overviewNav') return false;
    const h = a.getAttribute('href'); if (!h || h === '#' || h.startsWith('javascript:')) return false;
    for (let el = a; el && el !== document.body; el = el.parentElement) if (el.hidden || el.style.display === 'none') return false;
    return true;
  });
  const linkUrl = (a) => a.dataset.url || a.getAttribute('href');
  const linkLabel = (a) => { const c = a.cloneNode(true); c.querySelectorAll('.nav-number,.nav-chevron,.nav-external,.nav-new-dot,small').forEach((x) => x.remove()); return c.textContent.replace(/\s+/g, ' ').trim(); };
  const findLink = (url) => navLinks().find((a) => linkUrl(a) === url);
  const iconFor = (url, label) => {
    const a = findLink(url); const own = a?.classList.contains('nav-child') ? a.closest('.nav-group')?.querySelector(':scope > a .nav-number') : a?.querySelector('.nav-number');
    return own ? own.innerHTML : `<b>${(label || '?').trim().charAt(0)}</b>`;
  };
  const TONES = ['t-blue', 't-teal', 't-indigo', 't-cyan', 't-mint', 't-violet'];
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const scSay = (t) => { scMsg.textContent = t || ''; scMsg.hidden = !t; };
  const renderShortcuts = () => {
    sc.classList.toggle('editing', scEditing);
    scEdit.hidden = !shortcuts.length; scEdit.textContent = scEditing ? 'เสร็จ' : 'แก้ไข';
    scGrid.innerHTML = shortcuts.map((it, i) => `<div class="ms-item ${TONES[i % TONES.length]}" data-i="${i}">
      <button type="button" class="ms-go" data-url="${esc(it.url)}"><span class="ms-ic">${iconFor(it.url, it.label)}</span><span class="ms-label">${esc(it.label)}</span></button>
      <button type="button" class="ms-del" aria-label="ลบ ${esc(it.label)}">×</button>
      <button type="button" class="ms-left" aria-label="เลื่อนไปก่อนหน้า"${i ? '' : ' disabled'}>‹</button></div>`).join('')
      + (shortcuts.length < scMax ? '<button type="button" class="ms-add"><span class="ms-ic">+</span><span class="ms-label">เพิ่ม</span></button>' : '');
  };
  const saveShortcuts = async () => {
    renderShortcuts();
    try { const d = await apiRequest('/api/shortcuts', { method: 'PUT', body: { items: shortcuts } }); shortcuts = d.items || shortcuts; scSay(''); renderShortcuts(); }
    catch (e) { scSay(e.message || 'บันทึกเมนูลัดไม่สำเร็จ'); }
  };
  const loadShortcuts = async () => {
    try { const d = await apiRequest('/api/shortcuts'); shortcuts = d.items || []; scMax = d.max || 12; scLoaded = true; }
    catch { scLoaded = false; }
    renderShortcuts();
  };
  scEdit.onclick = () => { scEditing = !scEditing; renderShortcuts(); };
  // ตัวเลือกเมนูสำหรับเพิ่ม
  const picker = document.createElement('section');
  picker.className = 'ms-picker'; picker.setAttribute('role', 'dialog'); picker.setAttribute('aria-label', 'เลือกเมนูลัด'); picker.hidden = true;
  picker.innerHTML = '<div class="msp-card"><div class="msp-head"><strong>เพิ่มเมนูลัด</strong><button type="button" class="msp-close" aria-label="ปิด">×</button></div><div class="msp-list"></div></div>';
  document.body.append(picker);
  const closePicker = () => { picker.hidden = true; };
  picker.addEventListener('click', (e) => { if (e.target === picker || e.target.closest('.msp-close')) closePicker(); });
  const openPicker = () => {
    const have = new Set(shortcuts.map((s) => s.url)); const groups = new Map();
    navLinks().forEach((a) => {
      const sec = a.closest('.sidebar nav > [data-sec]')?.dataset.sec ?? a.dataset.sec;
      const head = sec != null ? document.querySelector(`.sidebar nav > [data-sec-head="${sec}"] .sh-text b`)?.textContent || '' : '';
      const parent = a.classList.contains('nav-child') ? linkLabel(a.closest('.nav-group').querySelector(':scope > a')) : '';
      const g = parent ? `${head} · ${parent}` : head;
      const url = linkUrl(a), label = linkLabel(a), on = have.has(url);
      if (!groups.has(g)) groups.set(g, '');
      groups.set(g, groups.get(g) + `<button type="button" class="msp-item${on ? ' on' : ''}" data-url="${esc(url)}" data-label="${esc(label)}"${on ? ' disabled' : ''}><span>${esc(label)}</span><i>${on ? '✓' : '+'}</i></button>`);
    });
    const html = [...groups].map(([g, items]) => `<h4>${esc(g || 'เมนู')}</h4>${items}`).join('');
    picker.querySelector('.msp-list').innerHTML = html || '<p>ไม่มีเมนูให้เลือก</p>';
    picker.hidden = false;
  };
  picker.querySelector('.msp-list').addEventListener('click', (e) => {
    const b = e.target.closest('.msp-item:not([disabled])'); if (!b) return;
    if (shortcuts.length >= scMax) { scSay(`เพิ่มได้สูงสุด ${scMax} เมนู`); closePicker(); return; }
    shortcuts.push({ url: b.dataset.url, label: b.dataset.label }); closePicker(); saveShortcuts();
  });
  scGrid.addEventListener('click', (e) => {
    if (e.target.closest('.ms-add')) { if (!scLoaded) { loadShortcuts(); return; } openPicker(); return; }
    const item = e.target.closest('.ms-item'); if (!item) return; const i = +item.dataset.i;
    if (e.target.closest('.ms-del')) { shortcuts.splice(i, 1); if (!shortcuts.length) scEditing = false; saveShortcuts(); return; }
    if (e.target.closest('.ms-left')) { if (i > 0) { [shortcuts[i - 1], shortcuts[i]] = [shortcuts[i], shortcuts[i - 1]]; saveShortcuts(); } return; }
    if (scEditing) return;
    const url = e.target.closest('.ms-go')?.dataset.url; if (!url) return;
    const a = findLink(url);
    if (a) a.click(); else if (/^https:/.test(url)) window.open(url, '_blank', 'noopener'); else location.href = url;
    window.setMobileMenu?.(false);
  });
  // กดค้างที่เมนูลัด = เข้าโหมดแก้ไข
  let pressT; scGrid.addEventListener('pointerdown', (e) => { if (!e.target.closest('.ms-item')) return; pressT = setTimeout(() => { scEditing = true; renderShortcuts(); try { navigator.vibrate?.(12); } catch {} }, 550); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((t) => scGrid.addEventListener(t, () => clearTimeout(pressT)));
  loadShortcuts();
  const syncAvatar = () => { bar.querySelector('.mt-avatar').textContent = $('topAvatar')?.textContent || '—'; };
  if ($('topAvatar')) new MutationObserver(syncAvatar).observe($('topAvatar'), { childList: true, characterData: true, subtree: true });
  syncAvatar();

  // ปุ่มบัญชีที่แถบล่าง → เมนูเลื่อนขึ้น (เหมือนเมนูชื่อบน PC)
  const sheetBackdrop = document.createElement('div');
  sheetBackdrop.className = 'acct-sheet-backdrop';
  const sheet = document.createElement('section');
  sheet.className = 'acct-sheet'; sheet.id = 'acctSheet';
  sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-label', 'เมนูบัญชี'); sheet.setAttribute('aria-hidden', 'true'); sheet.inert = true;
  const chev = '<i class="as-chev" aria-hidden="true"></i>';
  sheet.innerHTML = `<span class="as-grab" aria-hidden="true"></span>
    <div class="as-user"><span class="as-avatar" data-as="avatar">—</span><span><strong data-as="name">—</strong><small data-as="role">—</small></span></div>
    <div class="as-item as-static"><span class="as-ic c-mint">${icon('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>')}</span><span>ปีการศึกษา</span><b class="as-badge" data-as="year">—</b></div>
    <div class="as-viewas"></div>
    <hr class="as-sep">
    <button type="button" class="as-item" data-as="account"><span class="as-ic c-indigo">${icon('<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>')}</span><span>บัญชีของฉัน</span>${chev}</button>
    <button type="button" class="as-item as-danger" data-as="logout"><span class="as-ic c-slate">${icon('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>')}</span><span>ออกจากระบบ</span>${chev}</button>`;
  document.body.append(sheetBackdrop, sheet);
  let sheetOpen = false, sheetPrevTab = 'home';
  const syncSheet = () => {
    sheet.querySelector('[data-as=avatar]').textContent = $('topAvatar')?.textContent || '—';
    sheet.querySelector('[data-as=name]').textContent = $('topUserName')?.textContent || '—';
    sheet.querySelector('[data-as=role]').textContent = $('topUserRole')?.textContent || '';
    sheet.querySelector('[data-as=year]').textContent = $('topAcademicYear')?.textContent || '—';
    sheet.querySelector('[data-as=account]').hidden = $('topAccountLink')?.style.display === 'none';
  };
  const setSheet = (on) => {
    if (on === sheetOpen) return;
    sheetOpen = on;
    if (on) { syncSheet(); sheetPrevTab = bar.querySelector('[data-tab].active')?.dataset.tab || ''; }
    sheet.classList.toggle('is-open', on); sheetBackdrop.classList.toggle('is-open', on);
    sheet.setAttribute('aria-hidden', String(!on)); sheet.inert = !on;
    bar.querySelector('[data-tab=account]')?.setAttribute('aria-expanded', String(on));
    if (on) setActive('account'); else if (bar.querySelector('[data-tab=account]').classList.contains('active') && !accountPageOpen) setActive(sheetPrevTab);
  };
  let accountPageOpen = false;
  sheetBackdrop.onclick = () => setSheet(false);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setSheet(false); if (!picker.hidden) picker.hidden = true; } });
  phone.addEventListener('change', () => { if (!phone.matches) setSheet(false); });
  sheet.querySelector('[data-as=account]').onclick = () => { accountPageOpen = true; setSheet(false); closeChat(); window.setMobileMenu?.(false); openAccount(); setActive('account'); };
  sheet.querySelector('[data-as=logout]').onclick = () => { setSheet(false); $('logoutLink')?.click(); };
  document.addEventListener('click', (e) => { if (e.target.closest('.sidebar nav a, #overviewNav, .global-search-results')) accountPageOpen = false; }, true);

  // ย้ายปุ่ม View as เข้าเมนูด้านข้างเมื่อเป็นมือถือ แล้วย้ายกลับเมื่อจอกว้าง
  const viewAs = document.querySelector('.view-as-wrap');
  const viewAsHome = viewAs?.parentElement, viewAsNext = viewAs?.nextSibling;
  const placeViewAs = () => {
    if (!viewAs) return;
    if (phone.matches) sheet.querySelector('.as-viewas').append(viewAs);
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
  chatFrame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox');
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
    if (tab !== 'account') { setSheet(false); accountPageOpen = false; }
    b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop');
    try { navigator.vibrate?.(8); } catch {}
    if (tab === 'home') { window.showOverview?.(); history.replaceState(null, '', location.pathname); setActive('home'); }
    else if (tab === 'search') { const input = $('globalSearchInput'); window.setMobileMenu?.(false); input?.focus(); input?.select?.(); }
    else if (tab === 'messages') { if (chatOpen) closeChat(); else openChat(); }
    else if (tab === 'notify') { e.stopPropagation(); placeNotifications(); window.setMobileMenu?.(false); document.querySelector('#schoolNotifications .sn-toggle')?.click(); }
    else if (tab === 'account') { closeChat(); window.setMobileMenu?.(false); setSheet(!sheetOpen); }
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
  window.addEventListener('school-app-resume', refreshMessages);
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
