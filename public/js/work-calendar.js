// ปฏิทินปฏิบัติงาน (dashboard) — แสดงแบบเดียวกับปฏิทินวันหยุดของระบบผลการเรียน (grades) แบบอ่านอย่างเดียว
// ข้อมูลวันหยุดมาจาก /api/work-calendar ซึ่งอ่านตาราง gr_holidays ของระบบ grades
(function () {
  const TH_MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
  const TH_MON_S = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  const TH_WD = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
  const TH_WD_S = ["อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."];
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const isoOf = (y, m, d) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
  const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const wdOf = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();
  const thDate = (iso, wd = true) => { const [y, m, d] = iso.split("-").map(Number); return `${wd ? TH_WD_S[wdOf(iso)] + " " : ""}${d} ${TH_MON_S[m - 1]} ${String(y + 543).slice(-2)}`; };
  const thRange = (a, b) => (a === b ? thDate(a) : `${thDate(a)} – ${thDate(b)}`);
  const weekdaysIn = (a, b) => { const out = []; for (let d = a; d <= b; d = addDays(d, 1)) { const w = wdOf(d); if (w && w !== 6) out.push(d); } return out; };
  const todayIso = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  let calMonth = "";
  try { calMonth = sessionStorage.getItem("work-cal-month") || ""; } catch {}

  async function render(view) {
    view.innerHTML = '<p class="muted-line">กำลังโหลดปฏิทิน...</p>';
    let c;
    try { c = await apiRequest("/api/work-calendar"); }
    catch (err) { view.innerHTML = `<div class="error-box" style="display:block">${esc(err.message || "โหลดปฏิทินไม่สำเร็จ")}</div>`; return; }
    const hol = new Map(c.holidays.map((h) => [h.holiday_date, h.name]));
    const govSet = new Set(c.holidays.filter((h) => h.gov).map((h) => h.holiday_date));
    const importantDays = c.important_days || [];
    const important = new Map();
    for (const d of importantDays) important.set(d.date, [important.get(d.date), d.name].filter(Boolean).join(" / "));
    const groups = [];
    for (const h of c.holidays) {
      const g = groups.at(-1);
      let next = g && addDays(g.to, 1);
      while (next && [0, 6].includes(wdOf(next))) next = addDays(next, 1);
      if (g && g.name === h.name && !!h.gov === g.gov && next === h.holiday_date) { g.to = h.holiday_date; g.dates.push(h.holiday_date); }
      else groups.push({ name: h.name, from: h.holiday_date, to: h.holiday_date, dates: [h.holiday_date], gov: !!h.gov });
    }
    const terms = c.terms;
    const termOf = (iso) => terms.find((t) => iso >= t.start_date && iso <= t.end_date);
    const termDays = terms.map((t) => weekdaysIn(t.start_date, t.end_date).filter((d) => !hol.has(d)).length);
    const months = [];
    if (terms.length) {
      let [y, m] = terms[0].start_date.split("-").map(Number); m -= 1;
      const [ey, em] = terms.at(-1).end_date.split("-").map(Number);
      while (y < ey || (y === ey && m <= em - 1)) { months.push(`${y}-${String(m + 1).padStart(2, "0")}`); if (++m > 11) { m = 0; y++; } }
    }
    const today = todayIso();
    if (!/^\d{4}-\d{2}$/.test(calMonth)) calMonth = months.includes(today.slice(0, 7)) || !months.length ? today.slice(0, 7) : months[0];

    view.innerHTML = `<div class="work-cal">
      <div class="cal-summary">
        ${terms.map((t, i) => `<div class="cal-stat"><span>ภาคเรียนที่ ${t.term_number}</span><strong>${termDays[i]}</strong><small>วันเรียน · ${thDate(t.start_date, false)} – ${thDate(t.end_date, false)}</small></div>`).join("")}
        <div class="cal-stat total"><span>รวมทั้งปี</span><strong>${c.school_days}</strong><small>วันเรียน (จ.–ศ. ไม่รวมวันหยุด) · หยุด ${c.holidays.length} วัน</small></div>
      </div>
      <div class="cal-panel">
        <div class="cal-top">
          <div class="cal-nav">
            <button type="button" class="cal-arrow" data-nav="-1" aria-label="เดือนก่อน">‹</button>
            <h2 id="workCalTitle"></h2>
            <button type="button" class="cal-arrow" data-nav="1" aria-label="เดือนถัดไป">›</button>
          </div>
          <button type="button" class="btn btn-ghost" data-today>เดือนนี้</button>
        </div>
        ${months.length ? '<div class="cal-months" id="workCalMonths"></div>' : ""}
        <div class="cal-grid" id="workCalGrid" role="grid"></div>
        <div class="cal-legend">
          <span><i class="lg hol"></i>วันหยุด (ราชการ / โรงเรียน / เสาร์–อาทิตย์)</span><span><i class="lg important"></i>วันสำคัญที่ไม่ใช่วันหยุด</span><span><i class="lg off"></i>ปิดภาคเรียน</span>
        </div>
        <p class="cal-hint">สีแดง = วันหยุด · สีเหลือง = วันสำคัญที่ยังนับเป็นวันเรียนเมื่ออยู่ในภาคเรียน · หากตรงวันหยุด ช่องวันเป็นสีแดงและแสดงชื่อวันสำคัญประกอบ</p>
        <p class="cal-hint">ดูอย่างเดียว · วันหยุดดึงจากระบบผลการเรียน (grades) — วันหยุดราชการระบบใส่ให้ทุกปี ส่วนวันหยุดอื่นกำหนดโดยฝ่ายวัดผล</p>
      </div>
      <div class="cal-panel">
        <div class="cal-head"><h3>วันหยุดทั้งปี</h3><span>${groups.length} รายการ · แตะเพื่อไปที่เดือนนั้น</span></div>
        <div class="cal-list">${groups.map((g, i) => `<button type="button" class="cal-item${g.gov ? " gov" : ""}" data-go="${i}"><span class="cal-item-date">${thRange(g.from, g.to)}</span><span class="cal-item-name">${esc(g.name)}${g.gov ? ' <em class="gov-tag">ราชการ</em>' : ""}</span><span class="cal-item-n">${g.dates.length} วัน</span></button>`).join("") || '<p class="cal-empty">ฝ่ายวัดผลยังไม่ได้ตั้งวันหยุด</p>'}</div>
      </div>
      <div class="cal-panel">
        <div class="cal-head"><h3>วันสำคัญในปีการศึกษา</h3><span>แสดงประกอบปฏิทิน · ไม่เพิ่มวันหยุด</span></div>
        <div class="cal-list">${importantDays.map((d) => {
          const isOff = hol.has(d.date) || [0, 6].includes(wdOf(d.date));
          return `<button type="button" class="cal-item${isOff ? "" : " important"}" data-important-date="${d.date}"><span class="cal-item-date">${thDate(d.date)}</span><span class="cal-item-name">${esc(d.name)}</span><span class="cal-item-n">${isOff ? "ตรงวันหยุด" : "วันสำคัญ"}</span></button>`;
        }).join("") || '<p class="cal-empty">ไม่มีวันสำคัญในช่วงปีการศึกษานี้</p>'}</div>
      </div>
    </div>`;

    const grid = view.querySelector("#workCalGrid");
    function drawMonth() {
      try { sessionStorage.setItem("work-cal-month", calMonth); } catch {}
      const [y, m] = calMonth.split("-").map(Number);
      view.querySelector("#workCalTitle").innerHTML = `${TH_MONTHS[m - 1]} <span>${y + 543}</span>`;
      const mEl = view.querySelector("#workCalMonths");
      if (mEl) {
        mEl.innerHTML = months.map((k) => {
          const [yy, mm] = k.split("-").map(Number), n = c.holidays.filter((h) => h.holiday_date.startsWith(k)).length;
          return `<button type="button" class="cal-mchip${k === calMonth ? " on" : ""}" data-month="${k}">${TH_MON_S[mm - 1]}<small>${String(yy + 543).slice(-2)}</small>${n ? `<b>${n}</b>` : ""}</button>`;
        }).join("");
        const on = mEl.querySelector(".on");
        if (on) mEl.scrollLeft = on.offsetLeft - mEl.clientWidth / 2 + on.clientWidth / 2;
      }
      const first = isoOf(y, m - 1, 1), lead = wdOf(first), dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
      let html = TH_WD.map((w, i) => `<div class="cal-wd${i === 0 || i === 6 ? " we" : ""}"><span class="full">${w}</span><span class="short">${TH_WD_S[i]}</span></div>`).join("");
      const cells = Math.ceil((lead + dim) / 7) * 7;
      for (let i = 0; i < cells; i++) {
        const iso = addDays(first, i - lead), [, cm, cd] = iso.split("-").map(Number), wd = wdOf(iso);
        const other = cm !== m, name = hol.get(iso), term = termOf(iso), event = important.get(iso), weekend = wd === 0 || wd === 6;
        const cls = ["cal-day", other && "other", weekend && "we", name && "hol", event && !name && !weekend && "important", govSet.has(iso) && "gov", !term && "off", iso === today && "today"].filter(Boolean).join(" ");
        const marks = terms.flatMap((t) => [iso === t.start_date && `<em class="mark open">เปิดภาค ${t.term_number}</em>`, iso === t.end_date && `<em class="mark close">ปิดภาค ${t.term_number}</em>`]).filter(Boolean).join("");
        const label = `${TH_WD[wd]} ${cd} ${TH_MONTHS[cm - 1]} ${Number(iso.slice(0, 4)) + 543}${name ? ` วันหยุด ${name}` : weekend ? " วันหยุดประจำสัปดาห์" : ""}${event ? ` วันสำคัญ ${event}` : ""}`;
        html += `<div class="${cls}" title="${esc(label)}" aria-label="${esc(label)}"><span class="num">${cd}</span>${marks}${name ? `<span class="hname">${esc(name)}</span>` : ""}${event ? `<span class="iname">${esc(event)}</span>` : ""}</div>`;
      }
      grid.innerHTML = html;
    }
    const goMonth = (k) => { calMonth = k; drawMonth(); };
    const scrollToGrid = () => view.querySelector(".cal-panel").scrollIntoView({ behavior: "smooth", block: "start" });
    view.querySelectorAll("[data-nav]").forEach((b) => (b.onclick = () => {
      let [y, m] = calMonth.split("-").map(Number); m += Number(b.dataset.nav);
      if (m < 1) { m = 12; y--; } if (m > 12) { m = 1; y++; }
      goMonth(`${y}-${String(m).padStart(2, "0")}`);
    }));
    view.querySelector("[data-today]").onclick = () => goMonth(today.slice(0, 7));
    view.querySelector("#workCalMonths")?.addEventListener("click", (e) => { const b = e.target.closest("[data-month]"); if (b) goMonth(b.dataset.month); });
    view.querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => { goMonth(groups[Number(b.dataset.go)].from.slice(0, 7)); scrollToGrid(); }));
    view.querySelectorAll("[data-important-date]").forEach((b) => (b.onclick = () => { goMonth(b.dataset.importantDate.slice(0, 7)); scrollToGrid(); }));
    drawMonth();
  }

  window.WorkCalendar = { render };
})();
