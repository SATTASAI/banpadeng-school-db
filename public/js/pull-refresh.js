// ดึงลงเพื่อรีเฟรช (เฉพาะจอสัมผัส): ใช้ได้ทุกหน้า ทั้งหน้าหลักและหน้าที่เปิดในพื้นที่ทำงาน (iframe)
// เริ่มเมื่อทุกส่วนที่เลื่อนได้ใต้นิ้วอยู่บนสุดแล้ว · ดึงเกินเกณฑ์แล้วปล่อย = โหลดหน้านั้นใหม่
(() => {
  if (window.__pullRefresh || !("ontouchstart" in window || navigator.maxTouchPoints > 0)) return;
  window.__pullRefresh = true;
  const THRESHOLD = 72, MAX = 120;
  let startY = 0, startX = 0, pull = 0, tracking = false, active = false, busy = false, el = null;

  const css = `.ptr{position:fixed;left:50%;top:calc(env(safe-area-inset-top) + 6px);z-index:2147483000;width:38px;height:38px;margin-left:-19px;border-radius:50%;background:#fff;box-shadow:0 4px 16px rgba(20,40,70,.18);display:flex;align-items:center;justify-content:center;opacity:0;transform:translateY(-48px);pointer-events:none;color:#1E5FC0}
.ptr svg{width:20px;height:20px;transition:transform .15s}.ptr.ready svg{color:#109A78}
.ptr.spin svg{animation:ptr-spin .7s linear infinite}.ptr.back{transition:transform .25s ease,opacity .25s ease}
@keyframes ptr-spin{to{transform:rotate(360deg)}}html[data-theme=dark] .ptr{background:#1f2a37;color:#8cc0ff}`;

  function indicator() {
    if (el) return el;
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
    el = document.createElement("div");
    el.className = "ptr";
    el.setAttribute("aria-hidden", "true");
    el.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/></svg>';
    document.body.appendChild(el);
    return el;
  }

  const atTop = (node) => {
    if ((window.scrollY || document.documentElement.scrollTop || 0) > 0) return false;
    for (let n = node; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      if (n.scrollTop > 0) return false;
    }
    return true;
  };
  const blocked = (target) => {
    if (busy || !target || !target.closest) return true;
    if (target.closest("input,textarea,select,[contenteditable],dialog[open],.modal,.modal-panel,.mobile-chat-panel,.acct-sheet,.ms-picker,[data-no-pull]")) return true;
    const body = document.body;
    // ไม่ดึงขณะเปิดเมนู/แชท/แผ่นบัญชีบนมือถือ
    return /mobile-nav-open|mobile-chat-open|modal-open/.test(body.className) || !!document.querySelector(".acct-sheet.is-open,dialog[open]");
  };

  function show(distance, final) {
    const box = indicator();
    const progress = Math.min(distance / THRESHOLD, 1);
    box.classList.remove("back");
    box.classList.toggle("ready", distance >= THRESHOLD && !final);
    box.style.opacity = String(Math.min(progress * 1.2, 1));
    box.style.transform = `translateY(${Math.min(distance, MAX) * 0.6 - 10}px)`;
    box.querySelector("svg").style.transform = final ? "" : `rotate(${progress * 270}deg)`;
  }
  function hide() {
    if (!el) return;
    el.classList.add("back");
    el.classList.remove("ready", "spin");
    el.style.opacity = "0";
    el.style.transform = "translateY(-48px)";
  }

  document.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 1 || blocked(event.target) || !atTop(event.target)) { tracking = false; return; }
    tracking = true; active = false; pull = 0;
    startY = event.touches[0].clientY; startX = event.touches[0].clientX;
  }, { passive: true });

  document.addEventListener("touchmove", (event) => {
    if (!tracking) return;
    const dy = event.touches[0].clientY - startY, dx = event.touches[0].clientX - startX;
    if (!active) {
      // เริ่มนับเมื่อเป็นการลากลงชัดเจน ไม่ใช่เลื่อนแนวนอน
      if (dy < 8 || Math.abs(dx) > dy) { if (dy < -4 || Math.abs(dx) > 10) tracking = false; return; }
      if (!atTop(event.target)) { tracking = false; return; }
      active = true;
    }
    pull = Math.max(0, (dy - 8) * 0.55);
    if (event.cancelable) event.preventDefault();
    show(pull);
  }, { passive: false });

  function end() {
    if (!tracking) return;
    tracking = false;
    if (!active) return;
    active = false;
    if (pull >= THRESHOLD) {
      busy = true;
      show(THRESHOLD, true);
      el.classList.add("spin");
      setTimeout(() => location.reload(), 150);
    } else hide();
    pull = 0;
  }
  document.addEventListener("touchend", end, { passive: true });
  document.addEventListener("touchcancel", () => { tracking && (pull = 0); end(); }, { passive: true });
  window.addEventListener("pageshow", () => { busy = false; hide(); });
})();
