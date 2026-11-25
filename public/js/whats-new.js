/* Feature-update pop-up shown once per device to signed-in staff.
   กติกาข่าว: เพิ่มที่ต้นรายการ UPDATES · 1 รายการ = 1 เรื่อง รวบอัพเดทย่อยเป็นหัวข้อสั้น + 1 ประโยค (ไม่เกิน ~100 ตัวอักษร)
   pop-up ขึ้นทุกครั้งที่เปิดแอพ (ครั้งเดียวต่อรอบการใช้งาน) ครั้งละไม่เกิน 3 เรื่อง จนกว่าจะกด "ไม่แสดงจนกว่าจะมีอัพเดทใหม่" · paused: true = พักข่าวไว้ */
(() => {
  if (window.parent !== window || /\/(index|login|register|forgot-password|reset-password|pending)\.html$/.test(location.pathname) || location.pathname === "/") return;
  const MAX = 3;
  const UPDATES = [
    {
      id: "2026-11-disbursement-trial",
      paused: true, // พักไว้ก่อนตามที่ผู้ดูแลสั่ง (1.4.40)
      title: "ระบบเบิกจ่ายโครงการ (ช่วงทดลอง)",
      text: "ยื่นคำขอ อนุมัติตามลำดับถึง ผอ. และติดตามสถานะเอกสารได้ในระบบ",
    },
  ];
  const KEY = "bpd-whats-new-seen";
  const seen = () => { try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; } };
  const markSeen = (ids) => { try { localStorage.setItem(KEY, JSON.stringify([...new Set([...seen(), ...ids])].slice(-30))); } catch {} };
  const SESSION_KEY = "bpd-whats-new-session";
  const shownThisSession = () => { try { return sessionStorage.getItem(SESSION_KEY) === "1"; } catch { return false; } };
  const markSession = () => { try { sessionStorage.setItem(SESSION_KEY, "1"); } catch {} };
  const news = UPDATES.filter((u) => !u.paused && !seen().includes(u.id)).slice(0, MAX);
  if (!news.length || shownThisSession()) return;

  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  function show() {
    if (document.getElementById("whatsNewPopup")) return;
    const style = el("style");
    style.textContent = `.wn-backdrop{position:fixed;inset:0;background:#0f233866;display:flex;align-items:center;justify-content:center;padding:18px;z-index:3000}
.wn-card{background:#fff;color:#263c50;border-radius:18px;box-shadow:0 20px 55px #1d3a5a40;width:min(440px,100%);max-height:calc(100vh - 36px);overflow:auto;padding:22px 22px 18px;font:inherit}
.wn-tag{display:inline-block;font-size:13px;color:#2b5f8c;background:#e8f2fb;border-radius:999px;padding:3px 10px;margin-bottom:12px}
.wn-list{list-style:none;margin:0 0 16px;padding:0;display:grid;gap:10px}.wn-list li{background:#f5f8fb;border-radius:12px;padding:10px 12px}
.wn-list strong{display:block;font-size:16px;line-height:1.45}.wn-list span{display:block;font-size:14px;line-height:1.55;color:#5b6f82;margin-top:2px}
.wn-ok{display:block;width:100%;min-height:46px;border:0;border-radius:12px;background:#2b6cb0;color:#fff;font:inherit;font-weight:600;cursor:pointer}.wn-ok:focus-visible,.wn-hide:focus-visible{outline:3px solid #9cc7ef;outline-offset:2px}.wn-hide{display:block;width:100%;min-height:44px;margin-top:8px;border:1px solid #c9d8e5;border-radius:12px;background:#fff;color:#39536b;font:inherit;cursor:pointer}`;
    const backdrop = el("div", "wn-backdrop"); backdrop.id = "whatsNewPopup";
    const card = el("section", "wn-card"); card.setAttribute("role", "dialog"); card.setAttribute("aria-modal", "true"); card.setAttribute("aria-labelledby", "whatsNewTitle");
    const tag = el("span", "wn-tag", "อัพเดทฟีเจอร์ใหม่"); tag.id = "whatsNewTitle";
    const list = el("ul", "wn-list"); news.forEach((u) => { const li = el("li"); li.append(el("strong", "", u.title), el("span", "", u.text)); list.append(li); });
    const ok = el("button", "wn-ok", "รับทราบ"); ok.type = "button";
    const hide = el("button", "wn-hide", "ไม่แสดงจนกว่าจะมีอัพเดทใหม่"); hide.type = "button";
    card.append(tag, list, ok, hide);
    backdrop.append(card); document.head.append(style); document.body.append(backdrop); markSession();
    const close = (forever) => { if (forever) markSeen(news.map((u) => u.id)); backdrop.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(false); };
    ok.addEventListener("click", () => close(false)); hide.addEventListener("click", () => close(true)); document.addEventListener("keydown", onKey); ok.focus();
  }
  async function start() {
    try { const me = await apiRequest("/api/auth/me"); if (!me?.user || me.user.role === "viewer") return; } catch { return; }
    show();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
