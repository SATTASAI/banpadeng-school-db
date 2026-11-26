/* ฐานการเรียนรู้: พิมพ์รายชื่อแยกฐาน / แยกห้อง / สรุปจำนวน เป็น PDF หรือ Excel (.xlsx)
   LearningBaseExport.open(data) — data = { academic_year, bases:[{id,name,capacity}], students:[{id,student_code,full_name,grade_level,classroom,gender}], members:[{student_id,base_id}] } */
(function (root) {
  'use strict';
  const SCHOOL = 'โรงเรียนบ้านป่าเด็ง';
  const NONE = 'ยังไม่มีฐาน';
  const cmp = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'th', { numeric: true });
  const gradeNo = (g) => { const m = String(g ?? '').match(/([1-6])/); return m ? Number(m[1]) : 0; };
  const roomLabel = (s) => `${s.grade_level || ''}/${s.classroom || ''}`;
  const order = (a, b) => gradeNo(a.grade_level) - gradeNo(b.grade_level) || cmp(a.classroom, b.classroom) || cmp(a.student_code, b.student_code) || cmp(a.full_name, b.full_name);

  function prepare(data) {
    const baseOf = new Map((data.members || []).map((m) => [m.student_id, m.base_id]));
    const names = new Map((data.bases || []).map((b) => [b.id, b.name]));
    const students = (data.students || []).slice().sort(order).map((s) => ({ ...s, base_id: baseOf.get(s.id) ?? null, base: names.get(baseOf.get(s.id)) || '' }));
    return { year: data.academic_year, bases: data.bases || [], students };
  }
  const genderText = (list) => { const m = list.filter((s) => s.gender === 'M').length, f = list.filter((s) => s.gender === 'F').length; return `ชาย ${m} · หญิง ${f}`; };

  // sections: [{ sheet, title, caption, table, widths, totalRow }]
  function buildSections(kind, data) {
    const d = prepare(data);
    if (kind === 'summary') {
      const head = ['ฐานการเรียนรู้', 'ป.1', 'ป.2', 'ป.3', 'ป.4', 'ป.5', 'ป.6', 'ชาย', 'หญิง', 'รวม', 'รับ'];
      const row = (label, list, cap) => [label, ...[1, 2, 3, 4, 5, 6].map((g) => String(list.filter((s) => gradeNo(s.grade_level) === g).length)),
        String(list.filter((s) => s.gender === 'M').length), String(list.filter((s) => s.gender === 'F').length), String(list.length), cap];
      const rows = d.bases.map((b) => row(b.name, d.students.filter((s) => s.base_id === b.id), b.capacity == null ? 'ไม่จำกัด' : String(b.capacity)));
      const none = d.students.filter((s) => !s.base);
      if (none.length) rows.push(row(NONE, none, ''));
      rows.push(row('รวมทั้งหมด', d.students, ''));
      return [{ sheet: 'สรุปจำนวน', title: `สรุปจำนวนนักเรียนแยกตามฐานการเรียนรู้ ปีการศึกษา ${d.year}`, caption: '', table: [head, ...rows],
        widths: ['*', 30, 30, 30, 30, 30, 30, 34, 34, 38, 46], totalRow: true }];
    }
    if (kind === 'room') {
      const rooms = new Map();
      for (const s of d.students) { const k = roomLabel(s); if (!rooms.has(k)) rooms.set(k, []); rooms.get(k).push(s); }
      return [...rooms].map(([label, list]) => ({
        sheet: label, title: `รายชื่อนักเรียนและฐานการเรียนรู้ ชั้น ${label} ปีการศึกษา ${d.year}`, caption: `นักเรียน ${list.length} คน · ${genderText(list)}`,
        table: [['ที่', 'เลขประจำตัว', 'ชื่อ–นามสกุล', 'ฐานการเรียนรู้'], ...list.map((s, i) => [String(i + 1), s.student_code || '', s.full_name || '', s.base || NONE])],
        widths: [28, 70, '*', 170],
      }));
    }
    const groups = d.bases.map((b) => [b, d.students.filter((s) => s.base_id === b.id)]);
    const none = d.students.filter((s) => !s.base);
    if (none.length) groups.push([{ name: NONE, capacity: null }, none]);
    return groups.map(([b, list]) => ({
      sheet: b.name, title: `รายชื่อนักเรียนฐาน "${b.name}" ปีการศึกษา ${d.year}`,
      caption: `จำนวน ${list.length}${b.capacity ? ` / ${b.capacity}` : ''} คน · ${genderText(list)}`,
      table: [['ที่', 'ชั้น/ห้อง', 'เลขประจำตัว', 'ชื่อ–นามสกุล'], ...list.map((s, i) => [String(i + 1), roomLabel(s), s.student_code || '', s.full_name || ''])],
      widths: [28, 60, 70, '*'],
    }));
  }

  function pdfDefinition(sections) {
    return {
      pageSize: 'A4', pageMargins: [30, 30, 30, 36], defaultStyle: { font: 'Sarabun', fontSize: 14 },
      content: sections.flatMap((sec, si) => [
        { text: SCHOOL, bold: true, fontSize: 17, alignment: 'center', ...(si > 0 ? { pageBreak: 'before' } : {}) },
        { text: sec.title, bold: true, fontSize: 16, alignment: 'center' },
        sec.caption ? { text: sec.caption, alignment: 'center', margin: [0, 0, 0, 6] } : { text: ' ', fontSize: 6 },
        { table: { headerRows: 1, widths: sec.widths, dontBreakRows: true,
          body: sec.table.map((row, ri) => row.map((text, ci) => { const head = ri === 0, total = sec.totalRow && ri === sec.table.length - 1;
            return { text, bold: head || total, fillColor: head || total ? '#e2edf4' : null, alignment: head || sec.widths[ci] !== '*' && ci !== row.length - 1 || sec.totalRow && ci ? 'center' : 'left' }; })) } },
      ]),
      footer: (page, total) => ({ text: `หน้า ${page} / ${total}`, alignment: 'right', fontSize: 11, margin: [0, 8, 30, 0] }),
    };
  }

  const loading = new Map();
  function library(name, url) {
    if (root[name]) return Promise.resolve(root[name]);
    if (!loading.has(name)) loading.set(name, new Promise((resolve, reject) => { const s = document.createElement('script'); s.src = url; s.onload = () => (root[name] ? resolve(root[name]) : reject(new Error('โหลดเครื่องมือไม่สำเร็จ'))); s.onerror = () => { loading.delete(name); s.remove(); reject(new Error('โหลดเครื่องมือไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ต')); }; document.head.append(s); }));
    return loading.get(name);
  }
  function download(blob, name) { const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
  const sheetName = (s, i, used) => { let n = String(s).replace(/[\\/*?:[\]]/g, ' ').trim().slice(0, 28) || `ชีต ${i + 1}`; while (used.has(n)) n = `${n.slice(0, 25)} ${i + 1}`; used.add(n); return n; };

  async function exportFile({ kind, format, data }) {
    const sections = buildSections(kind, data);
    if (!sections.length) throw new Error('ไม่มีข้อมูลสำหรับพิมพ์');
    const name = `learning-bases-${data.academic_year}-${kind}`;
    if (format === 'xlsx') {
      const x = await library('XLSX', 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'), book = x.utils.book_new(), used = new Set();
      sections.forEach((sec, i) => {
        const sheet = x.utils.aoa_to_sheet([[SCHOOL], [sec.title], ...(sec.caption ? [[sec.caption]] : []), [], ...sec.table]);
        sheet['!cols'] = sec.table[0].map((h) => ({ wch: /ชื่อ|ฐาน/.test(h) ? 34 : 12 }));
        x.utils.book_append_sheet(book, sheet, sheetName(sec.sheet, i, used));
      });
      download(new Blob([x.write(book, { type: 'array', bookType: 'xlsx' })], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name + '.xlsx');
      return;
    }
    const pdf = await library('pdfMake', '/js/pdfmake.min.js');
    const fontNames = ['THSarabunPSK-Regular.ttf', 'THSarabunPSK-Bold.ttf'];
    const entries = await Promise.all(fontNames.map(async (font) => { const res = await fetch('/fonts/' + font); if (!res.ok) throw new Error('โหลดฟอนต์ภาษาไทยไม่สำเร็จ'); const bytes = new Uint8Array(await res.arrayBuffer()); let text = ''; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192)); return [font, btoa(text)]; }));
    pdf.vfs = Object.fromEntries(entries); pdf.fonts = { Sarabun: { normal: fontNames[0], bold: fontNames[1] } };
    const blob = await new Promise((resolve, reject) => { try { pdf.createPdf(pdfDefinition(sections)).getBlob(resolve); } catch (err) { reject(err); } });
    download(blob, name + '.pdf');
  }

  // หน้าต่างเลือกรูปแบบ
  function open(data) {
    document.getElementById('lbExport')?.remove();
    const wrap = document.createElement('div');
    wrap.id = 'lbExport';
    wrap.innerHTML = `<style>#lbExport{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:20px;z-index:60;background:rgba(21,35,50,.32)}#lbExport>div{width:100%;max-width:440px;padding:22px;background:#fff;border-radius:18px;box-shadow:0 20px 60px rgba(20,40,70,.22)}#lbExport h2{margin:0 0 12px;font-size:18px}#lbExport label{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid var(--color-border,#dde5ee);border-radius:12px;margin-bottom:8px;cursor:pointer}#lbExport label:has(input:checked){border-color:#2D7FD3;background:#f2f8ff}#lbExport small{display:block;color:var(--color-text-muted,#6b7c8f)}#lbExport .acts{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}#lbExport .acts .btn{width:auto}#lbExport .err{color:#a33a49;font-size:13px;margin-top:8px}</style>
      <div role="dialog" aria-modal="true" aria-labelledby="lbExportTitle"><h2 id="lbExportTitle">พิมพ์รายชื่อ ปีการศึกษา ${Number(data.academic_year) || ''}</h2>
      <label><input type="radio" name="lbKind" value="base" checked><span>รายชื่อแยกฐาน<small>1 ฐานต่อหน้า (PDF) / ต่อชีต (Excel)</small></span></label>
      <label><input type="radio" name="lbKind" value="room"><span>รายชื่อแยกห้อง<small>นักเรียนแต่ละห้องอยู่ฐานไหน</small></span></label>
      <label><input type="radio" name="lbKind" value="summary"><span>สรุปจำนวน<small>จำนวนแต่ละฐาน แยกชั้นและเพศ</small></span></label>
      <div class="acts"><button type="button" class="btn btn-primary" data-format="pdf">PDF</button><button type="button" class="btn btn-primary" data-format="xlsx">Excel (.xlsx)</button><button type="button" class="btn btn-ghost" data-close>ปิด</button></div><div class="err" role="alert"></div></div>`;
    document.body.append(wrap);
    const close = () => wrap.remove();
    wrap.addEventListener('click', async (e) => {
      if (e.target === wrap || e.target.closest('[data-close]')) return close();
      const btn = e.target.closest('[data-format]'); if (!btn) return;
      const kind = wrap.querySelector('input[name=lbKind]:checked').value;
      wrap.querySelectorAll('[data-format]').forEach((b) => { b.disabled = true; });
      const label = btn.textContent; btn.textContent = 'กำลังสร้างไฟล์…'; wrap.querySelector('.err').textContent = '';
      try { await exportFile({ kind, format: btn.dataset.format, data }); close(); }
      catch (err) { wrap.querySelector('.err').textContent = err.message || 'สร้างไฟล์ไม่สำเร็จ'; }
      finally { btn.textContent = label; wrap.querySelectorAll('[data-format]').forEach((b) => { b.disabled = false; }); }
    });
    wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    wrap.querySelector('[data-format]').focus();
  }

  root.LearningBaseExport = { open, exportFile, buildSections, pdfDefinition };
})(typeof window === 'undefined' ? globalThis : window);
