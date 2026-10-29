// ปุ่มบังคับเลือกตำแหน่ง/วิทยฐานะ — ใช้ในหน้าสมัครสมาชิกและบัญชีของฉัน
(function () {
  const CHOICES = ["ครูผู้ช่วย", "ครู", "ครูชำนาญการ", "ครูชำนาญการพิเศษ", "ครูเชี่ยวชาญ", "อื่น ๆ"];
  const css = `.rank-choice{display:flex;flex-wrap:wrap;gap:8px}.rank-choice label{position:relative;display:inline-flex!important;align-items:center;margin:0;padding:8px 14px;border:1px solid var(--color-border,#d5dde6);border-radius:999px;background:#fff;font-size:14px;font-weight:500!important;cursor:pointer}
.rank-choice input{position:absolute;opacity:0;pointer-events:none;width:1px!important}.rank-choice label:has(input:checked){background:var(--color-forest-700,#1f5f46);border-color:var(--color-forest-700,#1f5f46);color:#fff}
.rank-choice label:has(input:focus-visible){outline:2px solid #1669C9;outline-offset:2px}.rank-other{margin-top:8px}.rank-other[hidden]{display:none}`;
  function mount(el, { choice = "", other = "", name = "rankChoice" } = {}) {
    if (!document.getElementById("rankChoiceCss")) { const st = document.createElement("style"); st.id = "rankChoiceCss"; st.textContent = css; document.head.append(st); }
    el.innerHTML = `<div class="rank-choice" role="radiogroup">${CHOICES.map((c, i) => `<label><input type="radio" name="${name}" value="${c}" ${c === choice ? "checked" : ""} ${i === 0 ? "required" : ""}>${c}</label>`).join("")}</div>
      <input type="text" class="rank-other" maxlength="200" placeholder="ระบุตำแหน่ง เช่น เจ้าหน้าที่ธุรการ, ผู้อำนวยการโรงเรียน" value="${String(other).replace(/"/g, "&quot;")}" ${choice === "อื่น ๆ" ? "" : "hidden"}>`;
    const otherInput = el.querySelector(".rank-other");
    const sync = () => { const v = el.querySelector("input[type=radio]:checked")?.value; otherInput.hidden = v !== "อื่น ๆ"; otherInput.required = v === "อื่น ๆ"; };
    el.querySelectorAll("input[type=radio]").forEach((r) => r.addEventListener("change", () => { sync(); if (!otherInput.hidden) otherInput.focus(); }));
    sync();
    return { value: () => ({ rank_choice: el.querySelector("input[type=radio]:checked")?.value || "", rank_other: otherInput.hidden ? "" : otherInput.value.trim() }) };
  }
  window.RankChoice = { mount, CHOICES };
})();
