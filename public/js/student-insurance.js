/* ประกันอุบัติเหตุนักเรียน: กรอกรายบุคคล (จากหน้าข้อมูลนักเรียน) และกรอกทั้งห้อง */
(function (root) {
  'use strict';
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  const compare = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'th', { numeric: true });
  const money = (n) => (n == null || n === '' ? '' : Number(n).toLocaleString('th-TH', { maximumFractionDigits: 2 }));
  const thaiDate = (d) => { if (!d) return ''; const x = new Date(d + 'T00:00:00'); return Number.isNaN(x.getTime()) ? d : new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric' }).format(x); };
  const STATUS = { 1: 'ทำประกัน', 0: 'ไม่ทำประกัน' };
  const status = (rec) => (rec ? STATUS[Number(rec.insured)] : 'ยังไม่บันทึก');
  const SHARED = [['company', 'บริษัทประกัน', 'text'], ['plan_name', 'แผน/ประเภทความคุ้มครอง', 'text'], ['coverage_amount', 'วงเงินคุ้มครอง (บาท)', 'number'], ['start_date', 'วันเริ่มคุ้มครอง', 'date'], ['end_date', 'วันสิ้นสุดคุ้มครอง', 'date']];

  let styled = false;
  function style() {
    if (styled) return; styled = true;
    const s = document.createElement('style');
    s.textContent = `.ins-modal{max-width:980px}.ins-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.ins-grid label{display:block;font-size:12px;color:var(--color-text-muted);margin-bottom:4px}.ins-grid input,.ins-grid select,.ins-grid textarea,.ins-table input,.ins-table select{width:100%;padding:8px 10px;border:1px solid var(--color-border);border-radius:8px;font-family:var(--font-body);background:var(--color-surface);color:var(--color-text)}.ins-wide{grid-column:1/-1}.ins-box{padding:14px;border:1px solid var(--color-border);border-radius:var(--radius-md,12px);background:var(--color-bg);margin:12px 0}.ins-box h3{margin:0 0 10px;font-size:15px;color:var(--color-primary)}.ins-quick{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.ins-quick .btn{width:auto;padding:7px 12px;font-size:13px}.ins-table-wrap{overflow:auto;border:1px solid var(--color-border);border-radius:10px;max-height:46vh}.ins-table{width:100%;border-collapse:collapse;min-width:720px}.ins-table th,.ins-table td{padding:6px 8px;border-bottom:1px solid var(--color-border);text-align:left;font-size:13px;vertical-align:middle}.ins-table th{position:sticky;top:0;background:var(--color-surface);z-index:1}.ins-table tr.ins-yes td:first-child{box-shadow:inset 3px 0 0 #2e9d6a}.ins-table tr.ins-no td:first-child{box-shadow:inset 3px 0 0 #c4505f}.ins-summary{color:var(--color-text-muted);font-size:13px;margin:8px 0}.ins-chip{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600}.ins-chip.yes{background:rgba(46,157,106,.13);color:#1f7a50}.ins-chip.no{background:rgba(196,80,95,.12);color:#a33a49}.ins-chip.none{background:var(--color-surface-2,#eef2f7);color:var(--color-text-muted)}.ins-years{display:grid;gap:8px}.ins-year{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap;padding:10px 12px;border:1px solid var(--color-border);border-radius:10px;background:var(--color-surface)}.ins-year .meta{font-size:13px;color:var(--color-text-muted)}@media(max-width:700px){.ins-grid{grid-template-columns:1fr}}`;
    document.head.append(s);
  }

  function modal(html) {
    style();
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop'; backdrop.style.display = 'flex';
    backdrop.innerHTML = html;
    const previous = document.activeElement;
    const api = { backdrop, $: (sel) => backdrop.querySelector(sel), onEscape: null };
    const onKey = (e) => { if (e.key === 'Escape' && document.body.lastElementChild === backdrop) { e.stopPropagation(); (api.onEscape || api.close)(); } };
    api.close = () => { document.removeEventListener('keydown', onKey, true); backdrop.remove(); previous?.focus?.(); };
    document.addEventListener('keydown', onKey, true);
    document.body.append(backdrop);
    return api;
  }
  const showError = (box, msg) => { box.textContent = msg || ''; box.classList.toggle('visible', Boolean(msg)); };

  // ---------- สรุปในหน้าข้อมูลนักเรียน + กรอกรายบุคคล ----------
  async function renderSummary(container, student, onChange) {
    const section = document.createElement('section');
    section.className = 'detail-section'; section.id = 'insuranceSection';
    section.innerHTML = '<h3>ประกันอุบัติเหตุ</h3><div class="detail-loading" style="padding:8px 0">กำลังโหลด…</div>';
    container.append(section);
    try {
      const data = await apiRequest(`/api/student-insurance/student/${student.id}`);
      const records = data.records || [];
      const hasCurrent = records.some((r) => Number(r.academic_year) === Number(data.current_year));
      const rows = [...(hasCurrent ? [] : [{ academic_year: data.current_year, _empty: true }]), ...records];
      section.innerHTML = `<h3>ประกันอุบัติเหตุ</h3><div class="ins-years">${rows.map((r) => `
        <div class="ins-year"><div><strong>ปีการศึกษา ${esc(r.academic_year)}</strong> <span class="ins-chip ${r._empty ? 'none' : Number(r.insured) ? 'yes' : 'no'}">${status(r._empty ? null : r)}</span>
          ${r._empty ? '' : `<div class="meta">${esc([r.company, r.plan_name, r.policy_no ? 'กรมธรรม์ ' + r.policy_no : '', r.premium != null ? 'เบี้ย ' + money(r.premium) + ' บาท' : '', r.coverage_amount != null ? 'คุ้มครอง ' + money(r.coverage_amount) + ' บาท' : '', r.start_date || r.end_date ? `${thaiDate(r.start_date)} – ${thaiDate(r.end_date)}` : '', r.notes].filter(Boolean).join(' · ') || '-')}</div>`}</div>
          ${data.can_edit ? `<button type="button" class="btn btn-ghost" style="width:auto;padding:6px 12px;font-size:13px" data-ins-edit="${esc(r.academic_year)}">${r._empty ? 'บันทึกข้อมูล' : 'แก้ไข'}</button>` : ''}
        </div>`).join('')}</div>
        ${data.can_edit ? '<button type="button" class="btn btn-ghost" style="width:auto;margin-top:8px;font-size:13px" data-ins-edit="">+ บันทึกปีอื่น</button>' : ''}`;
      section.querySelectorAll('[data-ins-edit]').forEach((btn) => btn.addEventListener('click', () => {
        const year = btn.dataset.insEdit;
        openStudent(student, { year: year || data.current_year, record: records.find((r) => String(r.academic_year) === String(year)), askYear: !year, onSaved: () => { section.remove(); renderSummary(container, student, onChange); onChange?.(); } });
      }));
    } catch (err) {
      section.innerHTML = `<h3>ประกันอุบัติเหตุ</h3><div class="student-cell-muted">${esc(err.message)}</div>`;
    }
  }

  function openStudent(student, o = {}) {
    const r = o.record || {};
    const field = (k, label, type = 'text', wide = false) => `<div${wide ? ' class="ins-wide"' : ''}><label for="ins-${k}">${label}</label>${type === 'textarea' ? `<textarea id="ins-${k}" name="${k}" rows="2">${esc(r[k])}</textarea>` : `<input id="ins-${k}" name="${k}" type="${type}" ${type === 'number' ? 'min="0" step="0.01" inputmode="decimal"' : ''} value="${esc(r[k])}">`}</div>`;
    const m = modal(`<div class="modal ins-modal" style="max-width:640px" role="dialog" aria-modal="true" aria-labelledby="insTitle">
      <h2 id="insTitle">ประกันอุบัติเหตุ — ${esc(student.full_name)}</h2>
      <p class="ins-summary">${esc([student.student_code ? 'เลขประจำตัว ' + student.student_code : '', student.grade_level, student.classroom ? 'ห้อง ' + student.classroom : ''].filter(Boolean).join(' · '))}</p>
      <div class="error-box" id="insErr"></div>
      <form><div class="ins-grid">
        <div><label for="ins-year">ปีการศึกษา (พ.ศ.)</label><input id="ins-year" name="academic_year" type="number" min="2500" max="2700" value="${esc(o.year)}" ${o.askYear ? '' : 'readonly'}></div>
        <div><label for="ins-insured">การทำประกัน</label><select id="ins-insured" name="insured"><option value="1">ทำประกัน</option><option value="0">ไม่ทำประกัน</option></select></div>
        ${field('policy_no', 'เลขกรมธรรม์/เลขที่บัตร')}
        ${field('company', 'บริษัทประกัน')}${field('plan_name', 'แผน/ประเภทความคุ้มครอง')}${field('premium', 'เบี้ยประกัน (บาท)', 'number')}
        ${field('coverage_amount', 'วงเงินคุ้มครอง (บาท)', 'number')}${field('start_date', 'วันเริ่มคุ้มครอง', 'date')}${field('end_date', 'วันสิ้นสุดคุ้มครอง', 'date')}
        ${field('notes', 'หมายเหตุ', 'textarea', true)}
      </div>
      <div class="modal-actions">${o.record ? '<button type="button" class="btn btn-ghost" id="insClear" style="color:var(--color-danger);border-color:var(--color-danger)">ล้างข้อมูลปีนี้</button>' : ''}<button type="button" class="btn btn-ghost" id="insCancel">ยกเลิก</button><button type="submit" class="btn btn-primary" id="insSave">บันทึก</button></div></form></div>`);
    m.$('#ins-insured').value = o.record ? String(Number(r.insured)) : '1';
    m.$('#insCancel').onclick = m.close;
    if (m.$('#insClear')) m.$('#insClear').onclick = async () => {
      if (!confirm(`ล้างข้อมูลประกันปี ${o.year} ของ ${student.full_name}?`)) return;
      try { await apiRequest(`/api/student-insurance/student/${student.id}?academic_year=${encodeURIComponent(o.year)}`, { method: 'DELETE' }); m.close(); o.onSaved?.(); } catch (err) { showError(m.$('#insErr'), err.message); }
    };
    m.$('form').onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target));
      const button = m.$('#insSave'); button.disabled = true; button.textContent = 'กำลังบันทึก…';
      try {
        await apiRequest('/api/student-insurance', { method: 'PUT', body: { academic_year: body.academic_year, records: [{ ...body, student_id: student.id }] } });
        m.close(); o.onSaved?.();
      } catch (err) { showError(m.$('#insErr'), err.message); } finally { button.disabled = false; button.textContent = 'บันทึก'; }
    };
    m.$('#ins-insured').focus();
  }

  // ---------- กรอกทั้งห้อง ----------
  async function openClassroom(students, defaults = {}) {
    const m = modal(`<div class="modal ins-modal" role="dialog" aria-modal="true" aria-labelledby="insRoomTitle">
      <h2 id="insRoomTitle">ประกันอุบัติเหตุ — กรอกทั้งห้อง</h2>
      <div class="error-box" id="insErr"></div>
      <div class="ins-grid">
        <div><label for="insYear">ปีการศึกษา (พ.ศ.)</label><select id="insYear"></select></div>
        <div><label for="insGrade">ระดับชั้น</label><select id="insGrade"></select></div>
        <div><label for="insRoom">ห้อง</label><select id="insRoom"></select></div>
      </div>
      <div class="ins-box"><h3>ข้อมูลที่เหมือนกันทั้งห้อง</h3><div class="ins-grid">${SHARED.map(([k, label, type]) => `<div><label for="insShared-${k}">${label}</label><input id="insShared-${k}" data-shared="${k}" type="${type}" ${type === 'number' ? 'min="0" step="0.01" inputmode="decimal"' : ''}></div>`).join('')}
        <div><label for="insShared-premium">เบี้ยประกันต่อคน (บาท)</label><input id="insShared-premium" data-shared-premium type="number" min="0" step="0.01" inputmode="decimal"></div></div>
        <div class="ins-quick"><button type="button" class="btn btn-ghost" data-all="1">ทุกคนทำประกัน</button><button type="button" class="btn btn-ghost" data-all="0">ทุกคนไม่ทำประกัน</button><button type="button" class="btn btn-ghost" id="insFillPremium">ใส่เบี้ยให้คนที่ทำประกันทุกคน</button></div>
      </div>
      <p class="ins-summary" id="insSummary" aria-live="polite"></p>
      <div class="ins-table-wrap"><table class="ins-table"><thead><tr><th>#</th><th>เลขประจำตัว</th><th>ชื่อ–นามสกุล</th><th style="width:150px">การทำประกัน</th><th>เลขกรมธรรม์</th><th style="width:110px">เบี้ย (บาท)</th><th>หมายเหตุ</th></tr></thead><tbody id="insRows"><tr><td colspan="7" class="detail-loading">กำลังโหลด…</td></tr></tbody></table></div>
      <p class="ins-summary">แถวที่เลือก “ยังไม่บันทึก” จะไม่ถูกบันทึก (ข้อมูลเดิมของคนนั้นยังอยู่) · ข้อมูลที่เหมือนกันทั้งห้องจะใช้กับทุกคนที่บันทึกในครั้งนี้</p>
      <div class="modal-actions"><button type="button" class="btn btn-ghost" id="insCancel">ปิด</button><button type="button" class="btn btn-primary" id="insSave">บันทึกทั้งห้อง</button></div></div>`);
    m.$('#insCancel').onclick = () => { if (!dirty || confirm('ยังไม่ได้บันทึก ต้องการปิดหรือไม่?')) m.close(); };
    m.onEscape = () => m.$('#insCancel').click();
    let dirty = false, info = null, records = new Map(), roster = [];
    const enrolled = students.filter((s) => !s.status || s.status === 'enrolled');
    try { info = await apiRequest('/api/student-insurance'); } catch (err) { showError(m.$('#insErr'), err.message); return; }
    const perms = info.permissions || {};
    const allowed = perms.manage_all ? null : new Set(perms.homerooms || []);
    const rooms = [...new Set(enrolled.map((s) => `${String(s.grade_level ?? '').trim()}|${String(s.classroom ?? '').trim()}`))].filter((k) => !allowed || allowed.has(k)).sort(compare);
    if (!rooms.length) { m.$('#insRows').innerHTML = '<tr><td colspan="7" class="detail-loading">ท่านไม่มีห้องที่บันทึกได้ (บันทึกได้เฉพาะผู้ดูแล/เจ้าหน้าที่ และครูประจำชั้นของห้องตนเอง)</td></tr>'; m.$('#insSave').disabled = true; return; }
    const yearSel = m.$('#insYear'), gradeSel = m.$('#insGrade'), roomSel = m.$('#insRoom');
    const years = [...new Set([...(info.years || []), info.current_year, info.current_year + 1])].sort((a, b) => b - a);
    years.forEach((y) => yearSel.add(new Option(String(y), String(y))));
    yearSel.value = String(info.current_year);
    [...new Set(rooms.map((k) => k.split('|')[0]))].forEach((g) => gradeSel.add(new Option(g || 'ไม่ระบุชั้น', g)));
    const firstRoom = rooms.find((k) => k === `${defaults.grade || ''}|${defaults.classroom || ''}`) || rooms.find((k) => k.startsWith(`${defaults.grade || ''}|`)) || rooms[0];
    gradeSel.value = firstRoom.split('|')[0];
    const fillRooms = () => { roomSel.innerHTML = ''; rooms.filter((k) => k.split('|')[0] === gradeSel.value).forEach((k) => roomSel.add(new Option(k.split('|')[1] || 'ไม่ระบุห้อง', k.split('|')[1]))); };
    fillRooms(); roomSel.value = firstRoom.split('|')[1];

    const summary = () => {
      const rows = [...m.backdrop.querySelectorAll('#insRows tr[data-id]')];
      const count = (v) => rows.filter((tr) => tr.querySelector('[data-f=insured]').value === v).length;
      m.$('#insSummary').textContent = `${rows.length} คน · ทำประกัน ${count('1')} · ไม่ทำ ${count('0')} · ยังไม่บันทึก ${count('')}`;
      rows.forEach((tr) => { const v = tr.querySelector('[data-f=insured]').value; tr.className = v === '1' ? 'ins-yes' : v === '0' ? 'ins-no' : ''; });
    };
    function renderRows() {
      roster = enrolled.filter((s) => String(s.grade_level ?? '').trim() === gradeSel.value && String(s.classroom ?? '').trim() === roomSel.value).sort((a, b) => compare(a.student_code, b.student_code) || compare(a.full_name, b.full_name));
      const firstRec = roster.map((s) => records.get(s.id)).find(Boolean);
      SHARED.forEach(([k]) => { m.$(`[data-shared=${k}]`).value = firstRec?.[k] ?? ''; });
      m.$('[data-shared-premium]').value = firstRec?.premium ?? '';
      m.$('#insRows').innerHTML = roster.length ? roster.map((s, i) => { const r = records.get(s.id) || {}; const ins = records.has(s.id) ? String(Number(r.insured)) : '';
        return `<tr data-id="${s.id}"><td>${i + 1}</td><td>${esc(s.student_code)}</td><td>${esc(s.full_name)}</td><td><select data-f="insured" aria-label="การทำประกันของ ${esc(s.full_name)}"><option value="">ยังไม่บันทึก</option><option value="1"${ins === '1' ? ' selected' : ''}>ทำประกัน</option><option value="0"${ins === '0' ? ' selected' : ''}>ไม่ทำประกัน</option></select></td><td><input data-f="policy_no" value="${esc(r.policy_no)}"></td><td><input data-f="premium" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(r.premium)}"></td><td><input data-f="notes" value="${esc(r.notes)}"></td></tr>`; }).join('') : '<tr><td colspan="7" class="detail-loading">ไม่มีนักเรียนที่กำลังศึกษาในห้องนี้</td></tr>';
      dirty = false; summary();
    }
    async function loadYear() {
      m.$('#insRows').innerHTML = '<tr><td colspan="7" class="detail-loading">กำลังโหลด…</td></tr>';
      try { const d = await apiRequest(`/api/student-insurance?academic_year=${encodeURIComponent(yearSel.value)}`); records = new Map((d.records || []).map((r) => [r.student_id, r])); renderRows(); } catch (err) { showError(m.$('#insErr'), err.message); }
    }
    const guard = (fn) => () => { if (dirty && !confirm('ยังไม่ได้บันทึกห้องนี้ ต้องการเปลี่ยนหรือไม่?')) return false; fn(); return true; };
    let prev = { year: yearSel.value, grade: gradeSel.value, room: roomSel.value };
    const revert = () => { yearSel.value = prev.year; gradeSel.value = prev.grade; fillRooms(); roomSel.value = prev.room; };
    const remember = () => { prev = { year: yearSel.value, grade: gradeSel.value, room: roomSel.value }; };
    yearSel.onchange = () => { if (!guard(loadYear)()) revert(); else remember(); };
    gradeSel.onchange = () => { if (!guard(() => { fillRooms(); renderRows(); })()) revert(); else remember(); };
    roomSel.onchange = () => { if (!guard(renderRows)()) revert(); else remember(); };
    m.backdrop.querySelector('#insRows').addEventListener('input', () => { dirty = true; summary(); });
    m.backdrop.querySelector('#insRows').addEventListener('change', () => { dirty = true; summary(); });
    m.backdrop.querySelectorAll('[data-shared],[data-shared-premium]').forEach((el) => el.addEventListener('input', () => { dirty = true; }));
    m.backdrop.querySelectorAll('[data-all]').forEach((btn) => btn.onclick = () => { m.backdrop.querySelectorAll('#insRows [data-f=insured]').forEach((s) => { s.value = btn.dataset.all; }); dirty = true; summary(); });
    m.$('#insFillPremium').onclick = () => {
      const v = m.$('[data-shared-premium]').value;
      if (v === '') { showError(m.$('#insErr'), 'กรุณาใส่เบี้ยประกันต่อคนก่อน'); return; }
      showError(m.$('#insErr'), '');
      m.backdrop.querySelectorAll('#insRows tr[data-id]').forEach((tr) => { if (tr.querySelector('[data-f=insured]').value === '1') tr.querySelector('[data-f=premium]').value = v; });
      dirty = true;
    };
    m.$('#insSave').onclick = async () => {
      const shared = Object.fromEntries(SHARED.map(([k]) => [k, m.$(`[data-shared=${k}]`).value.trim()]));
      const rows = [...m.backdrop.querySelectorAll('#insRows tr[data-id]')].map((tr) => ({ student_id: Number(tr.dataset.id), insured: tr.querySelector('[data-f=insured]').value, policy_no: tr.querySelector('[data-f=policy_no]').value.trim(), premium: tr.querySelector('[data-f=premium]').value, notes: tr.querySelector('[data-f=notes]').value.trim() })).filter((r) => r.insured !== '');
      if (!rows.length) { showError(m.$('#insErr'), 'ยังไม่ได้เลือกการทำประกันของนักเรียนคนใดเลย'); return; }
      const button = m.$('#insSave'); button.disabled = true; button.textContent = 'กำลังบันทึก…'; showError(m.$('#insErr'), '');
      try {
        const res = await apiRequest('/api/student-insurance', { method: 'PUT', body: { academic_year: yearSel.value, records: rows.map((r) => ({ ...shared, ...r })) } });
        dirty = false;
        const d = await apiRequest(`/api/student-insurance?academic_year=${encodeURIComponent(yearSel.value)}`); records = new Map((d.records || []).map((r) => [r.student_id, r])); renderRows();
        m.$('#insSummary').textContent = `บันทึกแล้ว ${res.saved} คน · ` + m.$('#insSummary').textContent;
      } catch (err) { showError(m.$('#insErr'), err.message); } finally { button.disabled = false; button.textContent = 'บันทึกทั้งห้อง'; }
    };
    await loadYear();
    yearSel.focus();
  }

  // ---------- ใช้ร่วมกับหน้า export: ติดข้อมูลประกันของปีที่เลือกเข้ากับรายชื่อ ----------
  function attach(students, records, year) {
    const map = new Map((records || []).filter((r) => String(r.academic_year) === String(year)).map((r) => [r.student_id, r]));
    return students.map((s) => { const r = map.get(s.id);
      return { ...s, insurance_status: r ? (Number(r.insured) ? 'insured' : 'not_insured') : 'none', insurance_company: r?.company ?? '', insurance_plan: r?.plan_name ?? '', insurance_policy: r?.policy_no ?? '', insurance_premium: r?.premium ?? '', insurance_coverage: r?.coverage_amount ?? '', insurance_period: r && (r.start_date || r.end_date) ? `${thaiDate(r.start_date)} – ${thaiDate(r.end_date)}` : '', insurance_notes: r?.notes ?? '' }; });
  }

  root.StudentInsurance = { renderSummary, openStudent, openClassroom, attach, status };
})(typeof window === 'undefined' ? globalThis : window);
