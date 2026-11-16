/* โหมดกลางวัน/กลางคืน: ค่าเริ่มต้นตามเครื่อง · กดปุ่ม ☀/☾ ข้างแจ้งเตือนเพื่อสลับและจำไว้ (ทุกหน้า/ทุกกรอบหน้าในแท็บเดียวกันเปลี่ยนตาม) */
(() => {
  if (window.SchoolTheme) return;
  const KEY = "school-theme", root = document.documentElement, mq = window.matchMedia("(prefers-color-scheme: dark)");
  const saved = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const current = () => saved() || (mq.matches ? "dark" : "light");
  const apply = () => {
    const t = current();
    root.dataset.theme = t; root.style.colorScheme = t;
    document.querySelectorAll(".theme-toggle").forEach((b) => {
      b.innerHTML = t === "dark"
        ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
        : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
      b.title = b.ariaLabel = t === "dark" ? "เปลี่ยนเป็นโหมดกลางวัน" : "เปลี่ยนเป็นโหมดกลางคืน";
    });
  };
  const css = document.createElement("link"); css.rel = "stylesheet"; css.href = "/css/dark.css"; document.head.append(css);
  apply();
  mq.addEventListener?.("change", apply);
  window.addEventListener("storage", (e) => { if (e.key === KEY) apply(); });
  window.SchoolTheme = {
    apply,
    toggle() {
      try { localStorage.setItem(KEY, current() === "dark" ? "light" : "dark"); } catch {}
      apply();
      document.querySelectorAll("iframe").forEach((f) => { try { f.contentWindow.SchoolTheme?.apply(); } catch {} });
    },
  };
  // ปุ่มสลับ: วางต่อจากปุ่มแจ้งเตือน (เฉพาะหน้าหลัก ไม่ใช่หน้าที่เปิดในกรอบ)
  if (window.top !== window) return;
  let tries = 0;
  const timer = setInterval(() => {
    const host = document.getElementById("schoolNotifications");
    if (host && !document.querySelector(".theme-toggle")) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "theme-toggle"; b.onclick = () => window.SchoolTheme.toggle();
      host.after(b); apply();
    }
    if (host || ++tries > 40) clearInterval(timer);
  }, 250);
})();
