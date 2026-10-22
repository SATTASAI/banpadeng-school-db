// แถบโหมดมุมมองบุคคลอื่น: แสดงบนหน้าต่างหลักเท่านั้น (ไม่ซ้อนใน iframe ของแดชบอร์ด)
(() => {
  if (window.SchoolViewAs) return;
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const call = (method, path, body) => fetch(path, { method, credentials: "same-origin", cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined })
    .then(async (r) => { const data = await r.json().catch(() => ({})); if (!r.ok) throw new Error(data.error || "ทำรายการไม่สำเร็จ"); return data; });
  const home = () => { try { window.top.location.href = "/dashboard.html"; } catch { location.href = "/dashboard.html"; } };
  // ข้อมูลที่หน้าเว็บจำไว้ (เช่น ตัวกรอง) เป็นของบัญชีผู้ดูแล — ล้างข้อมูลชั่วคราวของแท็บก่อนสลับมุมมอง
  const reset = () => { try { sessionStorage.clear(); } catch {} };
  const api = {
    async start(userId) { await call("POST", "/api/admin/view-as", { user_id: Number(userId) }); reset(); home(); },
    async stop() { await call("DELETE", "/api/admin/view-as"); reset(); home(); },
  };
  window.SchoolViewAs = api;
  if (window.parent !== window) return;

  const time = (v) => { const d = new Date(String(v || "").replace(" ", "T") + "Z"); return isNaN(d) ? "" : d.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" }) + " น."; };
  function show(state) {
    if (!state || document.getElementById("viewAsBar")) return;
    const style = document.createElement("style");
    style.textContent = `#viewAsBar{position:fixed;left:0;right:0;top:0;z-index:2147483000;display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:8px 16px;background:#7a2e0e;color:#fff;font:14px/1.4 inherit;box-shadow:0 4px 14px #0003}
      #viewAsBar b{font-weight:700}#viewAsBar .va-text{flex:1 1 320px;min-width:0}#viewAsBar small{opacity:.85}
      #viewAsBar select,#viewAsBar button{font:inherit;font-size:13px;border-radius:8px;padding:5px 10px;border:1px solid #ffffff66}
      #viewAsBar select{background:#fff;color:#222;max-width:240px}#viewAsBar button{background:#fff;color:#7a2e0e;font-weight:700;cursor:pointer}
      html.view-as-active body{padding-top:var(--view-as-h,46px)!important}
      @media print{#viewAsBar{display:none}html.view-as-active body{padding-top:0!important}}`;
    document.head.append(style);
    const bar = document.createElement("div");
    bar.id = "viewAsBar"; bar.setAttribute("role", "status");
    bar.innerHTML = `<span class="va-text">👁 กำลังดูในมุมมองของ <b>${esc(state.target.full_name)}</b> (${esc(state.target.role_label)}) · <b>ดูได้อย่างเดียว</b> บันทึก/แก้ไขไม่ได้
      <small>· ผู้ทดสอบ ${esc(state.admin.full_name)}${state.expires_at ? ` · สิ้นสุดอัตโนมัติ ${esc(time(state.expires_at))}` : ""}</small></span>
      <select aria-label="สลับไปดูบัญชีอื่น"><option value="">สลับไปดูบัญชีอื่น…</option></select>
      <button type="button">กลับเป็นบัญชีของฉัน</button>`;
    document.body.prepend(bar);
    document.documentElement.classList.add("view-as-active");
    const fit = () => document.documentElement.style.setProperty("--view-as-h", bar.offsetHeight + "px");
    fit(); window.addEventListener("resize", fit);
    const select = bar.querySelector("select"), button = bar.querySelector("button");
    let loaded = false;
    select.addEventListener("focus", async () => {
      if (loaded) return; loaded = true;
      try {
        const { users } = await call("GET", "/api/admin/view-as/candidates");
        select.insertAdjacentHTML("beforeend", users.filter((u) => Number(u.id) !== Number(state.target.id))
          .map((u) => `<option value="${Number(u.id)}">${esc(u.full_name)} · ${esc(u.role_label)}${u.position ? " · " + esc(u.position) : ""}</option>`).join(""));
      } catch { loaded = false; }
    });
    select.addEventListener("change", () => { if (select.value) api.start(select.value).catch((e) => alert(e.message)); });
    button.addEventListener("click", () => { button.disabled = true; api.stop().catch((e) => { button.disabled = false; alert(e.message); }); });
  }
  const run = () => call("GET", "/api/auth/me").then((r) => show(r?.user?.view_as)).catch(() => {});
  if (document.body) run(); else document.addEventListener("DOMContentLoaded", run, { once: true });
})();
