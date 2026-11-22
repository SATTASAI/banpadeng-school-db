// ปัดจากขอบซ้ายเพื่อเปิดเมนู / ปัดซ้ายเพื่อปิด (มือถือ) — เมนูเลื่อนตามนิ้วแบบเรียลไทม์
// หน้าหลัก (มี setMobileMenu) เป็นตัวควบคุม · หน้าใน iframe ส่งต่อการสัมผัสที่ขอบซ้ายให้หน้าหลัก
(() => {
  if (window.__drawerSwipe) return;
  window.__drawerSwipe = true;
  const EDGE = 24;

  // ---------- ตัวควบคุม (หน้าหลัก) ----------
  function makeHost() {
    const body = document.body;
    const sidebar = document.getElementById("mobileSidebar");
    const backdrop = document.getElementById("mobileNavBackdrop");
    const phone = window.matchMedia("(max-width:720px)");
    let mode = null, startX = 0, startY = 0, lastX = 0, lastT = 0, vx = 0, dx = 0, width = 0, decided = false, suppressClick = 0;

    const isOpen = () => body.classList.contains("mobile-nav-open");
    const busy = () => body.classList.contains("mobile-chat-open") || !!document.querySelector(".acct-sheet.is-open,.ms-picker.is-open,dialog[open]");

    function begin(x, y, fromEdge) {
      if (!phone.matches || !sidebar || busy()) return false;
      if (isOpen()) mode = "close";
      else if (fromEdge && x <= EDGE) mode = "open";
      else return false;
      startX = lastX = x; startY = y; lastT = performance.now(); vx = 0; dx = 0; decided = false;
      width = sidebar.getBoundingClientRect().width || Math.min(320, innerWidth * 0.88);
      return true;
    }
    function render() {
      const offset = mode === "open" ? Math.min(0, -width + Math.max(0, dx)) : Math.min(0, dx);
      const progress = 1 + offset / width;
      sidebar.style.transform = `translate3d(${offset}px,0,0)`;
      backdrop.style.opacity = String(Math.max(0, Math.min(1, progress)));
    }
    // คืนค่า true เมื่อกำลังลากเมนู (ให้ผู้เรียกกันการเลื่อนหน้า)
    function move(x, y) {
      if (!mode) return false;
      const now = performance.now();
      dx = x - startX;
      const dy = y - startY;
      if (!decided) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return false;
        // ต้องเป็นการปัดแนวนอนในทิศที่ถูก ไม่งั้นปล่อยให้เลื่อนหน้าปกติ
        if (Math.abs(dy) > Math.abs(dx) || (mode === "open" && dx < 0) || (mode === "close" && dx > 0)) { mode = null; return false; }
        decided = true;
        sidebar.style.transition = "none";
        sidebar.style.visibility = "visible";
        backdrop.style.transition = "none";
        backdrop.hidden = false;
      }
      const dt = Math.max(1, now - lastT);
      vx = 0.8 * ((x - lastX) / dt) + 0.2 * vx;
      lastX = x; lastT = now;
      render();
      return true;
    }
    function end() {
      if (!mode) return;
      const wasMode = mode;
      mode = null;
      if (!decided) return;
      suppressClick = performance.now();
      const travelled = wasMode === "open" ? dx : -dx;
      const fast = wasMode === "open" ? vx > 0.35 : vx < -0.35;
      const opposite = wasMode === "open" ? vx < -0.35 : vx > 0.35;
      const finalOpen = wasMode === "open" ? (fast || travelled > width * 0.35) && !opposite : !((fast || travelled > width * 0.35) && !opposite);
      // ให้ CSS transition พาเมนูจากตำแหน่งนิ้วไปยังตำแหน่งสุดท้ายอย่างนุ่มนวล
      requestAnimationFrame(() => {
        sidebar.style.transition = "";
        sidebar.style.transform = "";
        sidebar.style.visibility = "";
        backdrop.style.transition = "";
        window.setMobileMenu(finalOpen, !finalOpen);
      });
    }
    function cancel() { if (mode && decided) { dx = 0; vx = 0; } end(); }

    document.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      const inSidebar = sidebar.contains(e.target) || e.target === backdrop;
      if (isOpen() ? inSidebar : true) begin(t.clientX, t.clientY, !isOpen());
    }, { passive: true });
    document.addEventListener("touchmove", (e) => { if (mode && move(e.touches[0].clientX, e.touches[0].clientY) && e.cancelable) e.preventDefault(); }, { passive: false });
    document.addEventListener("touchend", end, { passive: true });
    document.addEventListener("touchcancel", cancel, { passive: true });
    // กันการกดลิงก์โดยไม่ตั้งใจหลังลากเมนู
    document.addEventListener("click", (e) => { if (performance.now() - suppressClick < 350) { e.preventDefault(); e.stopPropagation(); } }, true);

    return { begin, move, end, cancel };
  }

  let host = null;
  const getHost = () => {
    if (host) return host;
    if (typeof window.setMobileMenu === "function" && document.getElementById("mobileSidebar") && document.getElementById("mobileNavBackdrop")) host = makeHost();
    return host;
  };

  // ---------- หน้าใน iframe: ส่งต่อการปัดจากขอบซ้ายให้หน้าหลัก ----------
  function forwarder() {
    let parentApi = null, dragging = false, ox = 0, oy = 0;
    const api = () => { try { return window.parent.__drawerApi?.(); } catch { return null; } };
    document.addEventListener("touchstart", (e) => {
      parentApi = null; dragging = false;
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      if (t.clientX > EDGE) return;
      const target = api();
      if (!target) return;
      try { const r = window.frameElement?.getBoundingClientRect(); ox = r ? r.left : 0; oy = r ? r.top : 0; } catch { ox = oy = 0; }
      if (target.begin(t.clientX + ox, t.clientY + oy, true)) parentApi = target;
    }, { passive: true });
    document.addEventListener("touchmove", (e) => {
      if (!parentApi) return;
      const t = e.touches[0];
      if (parentApi.move(t.clientX + ox, t.clientY + oy)) { dragging = true; if (e.cancelable) e.preventDefault(); }
    }, { passive: false });
    document.addEventListener("touchend", () => { parentApi?.end(); parentApi = null; }, { passive: true });
    document.addEventListener("touchcancel", () => { parentApi?.cancel(); parentApi = null; }, { passive: true });
    document.addEventListener("click", (e) => { if (dragging) { dragging = false; e.preventDefault(); e.stopPropagation(); } }, true);
  }

  if (!("ontouchstart" in window || navigator.maxTouchPoints > 0)) return;
  if (window.parent !== window) {
    forwarder();
  } else {
    window.__drawerApi = getHost;
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", getHost, { once: true });
    else getHost();
  }
})();
