/* Feature-update pop-up shown once per device to signed-in staff. Add new entries to the top of UPDATES. */
(() => {
  if (window.parent !== window || /\/(index|login|register|forgot-password|reset-password|pending)\.html$/.test(location.pathname) || location.pathname === "/") return;
  const UPDATES = [
    {
      id: "2026-11-disbursement-trial",
      badge: "ช่วงทดลอง",
      title: "ระบบเบิกจ่ายงบประมาณโครงการ ใช้งานได้แล้ว",
      items: [
        "ยื่นคำขอเบิกจ่ายงบประมาณโครงการผ่านระบบได้",
        "คำขอส่งต่อให้ผู้อนุมัติตามลำดับขั้นจนถึง ผอ. พร้อมแจ้งเตือนทุกขั้นตอน",
        "ติดตามได้ว่าเอกสารอยู่ขั้นตอนใด และเปิดดูบันทึกข้อความได้",
      ],
      note: "ระบบอยู่ในช่วงทดลองใช้งาน หากพบปัญหาหรือข้อมูลไม่ถูกต้อง กรุณาแจ้งผู้ดูแลระบบ",
    },
  ];
  const KEY = "bpd-whats-new-seen";
  const seen = () => { try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; } };
  const markSeen = (id) => { try { localStorage.setItem(KEY, JSON.stringify([...new Set([...seen(), id])].slice(-30))); } catch {} };
  const next = UPDATES.find((u) => !seen().includes(u.id));
  if (!next) return;

  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  function show() {
    if (document.getElementById("whatsNewPopup")) return;
    const style = el("style");
    style.textContent = `.wn-backdrop{position:fixed;inset:0;background:#0f233866;display:flex;align-items:center;justify-content:center;padding:18px;z-index:3000}
.wn-card{background:#fff;color:#263c50;border-radius:18px;box-shadow:0 20px 55px #1d3a5a40;width:min(440px,100%);max-height:calc(100vh - 36px);overflow:auto;padding:22px 22px 18px;font:inherit}
.wn-top{display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap}.wn-tag{font-size:13px;color:#2b5f8c;background:#e8f2fb;border-radius:999px;padding:3px 10px}
.wn-badge{font-size:13px;color:#974007;background:#fff2df;border:1px solid #f6b366;border-radius:999px;padding:2px 10px}
.wn-card h2{font-size:20px;line-height:1.4;margin:0 0 10px}.wn-card ul{margin:0 0 12px;padding-left:20px;line-height:1.7}.wn-note{font-size:14px;color:#5b6f82;background:#f5f8fb;border-radius:12px;padding:10px 12px;margin:0 0 16px}
.wn-ok{display:block;width:100%;min-height:46px;border:0;border-radius:12px;background:#2b6cb0;color:#fff;font:inherit;font-weight:600;cursor:pointer}.wn-ok:focus-visible{outline:3px solid #9cc7ef;outline-offset:2px}`;
    const backdrop = el("div", "wn-backdrop"); backdrop.id = "whatsNewPopup";
    const card = el("section", "wn-card"); card.setAttribute("role", "dialog"); card.setAttribute("aria-modal", "true"); card.setAttribute("aria-labelledby", "whatsNewTitle");
    const top = el("div", "wn-top"); top.append(el("span", "wn-tag", "อัพเดทฟีเจอร์ใหม่")); if (next.badge) top.append(el("span", "wn-badge", next.badge));
    const title = el("h2", "", next.title); title.id = "whatsNewTitle";
    const list = el("ul"); next.items.forEach((t) => list.append(el("li", "", t)));
    const ok = el("button", "wn-ok", "รับทราบ"); ok.type = "button";
    card.append(top, title, list); if (next.note) card.append(el("p", "wn-note", next.note)); card.append(ok);
    backdrop.append(card); document.head.append(style); document.body.append(backdrop);
    const close = () => { markSeen(next.id); backdrop.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    ok.addEventListener("click", close); document.addEventListener("keydown", onKey); ok.focus();
  }
  async function start() {
    try { const me = await apiRequest("/api/auth/me"); if (!me?.user || me.user.role === "viewer") return; } catch { return; }
    show();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
