/* ประกันอุบัติเหตุ: พิมพ์รายชื่อรายห้อง / ทุกห้อง (หน้าละห้อง) / สรุปรายห้อง เป็น Word (.docx) หรือ PDF */
(function (root) {
  'use strict';
  const SCHOOL = 'โรงเรียนบ้านป่าเด็ง';
  const STATUS = { yes: 'ทำประกัน', no: 'ไม่ทำประกัน', none: 'ยังไม่บันทึก' };
  const money = (n) => (n == null || n === '' ? '' : Number(n).toLocaleString('th-TH', { maximumFractionDigits: 2 }));
  const xml = (v) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

  // rooms: [{ label, students:[{student_code, full_name, record}] }]
  function listTable(room) {
    const head = ['เลขที่', 'เลขประจำตัว', 'ชื่อ–นามสกุล', 'สถานะ', 'เบี้ย (บาท)', 'หมายเหตุ'];
    const rows = room.students.map((s, i) => {
      const r = s.record; const st = r ? (Number(r.insured) ? 'yes' : 'no') : 'none';
      return [String(i + 1), s.student_code || '', s.full_name || '', STATUS[st], r ? money(r.premium) : '', r?.notes || ''];
    });
    return [head, ...rows];
  }
  function countRoom(room) {
    const c = { yes: 0, no: 0, none: 0, premium: 0 };
    room.students.forEach((s) => { const r = s.record; c[r ? (Number(r.insured) ? 'yes' : 'no') : 'none']++; if (r && Number(r.insured) && r.premium != null) c.premium += Number(r.premium); });
    return c;
  }
  function roomCaption(room) { const c = countRoom(room); return `นักเรียน ${room.students.length} คน · ทำประกัน ${c.yes} · ไม่ทำ ${c.no} · ยังไม่บันทึก ${c.none}`; }
  function summaryTable(rooms) {
    const head = ['ห้อง', 'นักเรียน', 'ทำประกัน', 'ไม่ทำ', 'ยังไม่บันทึก', 'เบี้ยรวม (บาท)'];
    const t = { n: 0, yes: 0, no: 0, none: 0, premium: 0 };
    const rows = rooms.map((room) => { const c = countRoom(room); t.n += room.students.length; t.yes += c.yes; t.no += c.no; t.none += c.none; t.premium += c.premium;
      return [room.label, String(room.students.length), String(c.yes), String(c.no), String(c.none), money(c.premium)]; });
    return [head, ...rows, ['รวมทั้งโรงเรียน', String(t.n), String(t.yes), String(t.no), String(t.none), money(t.premium)]];
  }

  // sections: [{ title, caption, table, widths }]
  function buildSections(kind, rooms, year) {
    if (kind === 'summary') return [{ title: `สรุปการทำประกันอุบัติเหตุนักเรียน ปีการศึกษา ${year}`, caption: '', table: summaryTable(rooms), widths: ['*', 60, 60, 50, 70, 80], totalRow: true }];
    return rooms.map((room) => ({ title: `รายชื่อนักเรียนทำประกันอุบัติเหตุ ปีการศึกษา ${year} — ชั้น ${room.label}`, caption: roomCaption(room), table: listTable(room), widths: [34, 70, '*', 70, 60, 90] }));
  }

  function docxFiles(sections) {
    const run = (text, bold, size = 28) => `<w:r><w:rPr><w:rFonts w:ascii="TH SarabunPSK" w:hAnsi="TH SarabunPSK" w:cs="TH SarabunPSK"/>${bold ? '<w:b/><w:bCs/>' : ''}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr><w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
    const p = (text, o = {}) => `<w:p><w:pPr>${o.pageBreak ? '<w:pageBreakBefore/>' : ''}<w:spacing w:before="0" w:after="${o.after ?? 60}"/>${o.center ? '<w:jc w:val="center"/>' : ''}</w:pPr>${run(text, o.bold, o.size)}</w:p>`;
    const W = 10466; // A4 แนวตั้ง ขอบ 0.5 นิ้ว (twips)
    let body = '';
    sections.forEach((sec, si) => {
      body += p(SCHOOL, { bold: true, center: true, size: 32, pageBreak: si > 0, after: 0 }) + p(sec.title, { bold: true, center: true, size: 30 });
      if (sec.caption) body += p(sec.caption, { center: true, after: 120 });
      const fixed = sec.widths.filter((w) => w !== '*').reduce((a, b) => a + b, 0), scale = W / 535;
      const cols = sec.widths.map((w) => Math.round((w === '*' ? 535 - fixed : w) * scale));
      body += '<w:tbl><w:tblPr><w:tblW w:w="' + W + '" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="single" w:sz="4" w:color="808080"/>`).join('') + '</w:tblBorders><w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>' + cols.map((w) => `<w:gridCol w:w="${w}"/>`).join('') + '</w:tblGrid>';
      sec.table.forEach((row, ri) => {
        const head = ri === 0, total = sec.totalRow && ri === sec.table.length - 1;
        body += '<w:tr>' + (head ? '<w:trPr><w:tblHeader/></w:trPr>' : '') + row.map((t, ci) => `<w:tc><w:tcPr><w:tcW w:w="${cols[ci]}" w:type="dxa"/>${head || total ? '<w:shd w:val="clear" w:color="auto" w:fill="E2EDF4"/>' : ''}</w:tcPr>${p(t, { bold: head || total, after: 0, center: head || (ci !== 2 && ci !== 5 && sec.widths[ci] !== '*') })}</w:tc>`).join('') + '</w:tr>';
      });
      body += '</w:tbl>';
    });
    return {
      '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      'word/document.xml': '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + body + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="360" w:footer="360"/></w:sectPr></w:body></w:document>',
    };
  }

  function pdfDefinition(sections) {
    return {
      pageSize: 'A4', pageMargins: [30, 30, 30, 36], defaultStyle: { font: 'Sarabun', fontSize: 14 },
      content: sections.flatMap((sec, si) => [
        { text: SCHOOL, bold: true, fontSize: 17, alignment: 'center', ...(si > 0 ? { pageBreak: 'before' } : {}) },
        { text: sec.title, bold: true, fontSize: 16, alignment: 'center' },
        ...(sec.caption ? [{ text: sec.caption, alignment: 'center', margin: [0, 0, 0, 6] }] : [{ text: ' ', fontSize: 6 }]),
        { table: { headerRows: 1, widths: sec.widths, dontBreakRows: true,
          body: sec.table.map((row, ri) => row.map((text, ci) => { const head = ri === 0, total = sec.totalRow && ri === sec.table.length - 1;
            return { text, bold: head || total, fillColor: head || total ? '#e2edf4' : null, alignment: head || (sec.widths[ci] !== '*' && !(ci === 5 && !sec.totalRow)) ? 'center' : 'left' }; })) } },
      ]),
      footer: (page, total) => ({ text: `หน้า ${page} / ${total}`, alignment: 'right', fontSize: 11, margin: [0, 8, 30, 0] }),
    };
  }

  const loading = new Map();
  function library(name, url) {
    if (root[name]) return Promise.resolve(root[name]);
    if (!loading.has(name)) loading.set(name, new Promise((resolve, reject) => { const s = document.createElement('script'); s.src = url; s.onload = () => (root[name] ? resolve(root[name]) : reject(new Error('โหลดเครื่องมือไม่สำเร็จ'))); s.onerror = () => { loading.delete(name); s.remove(); reject(new Error('โหลดเครื่องมือพิมพ์ไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองอีกครั้ง')); }; document.head.append(s); }));
    return loading.get(name);
  }
  function download(blob, name) { const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }

  async function exportFile({ kind, format, rooms, year }) {
    const sections = buildSections(kind, rooms, year);
    const name = `insurance-${year}-${kind === 'summary' ? 'summary' : kind === 'all' ? 'all-rooms' : 'room-' + (rooms[0].label.match(/[\d]+/g) || []).join('-')}`;
    if (format === 'docx') {
      const Zip = await library('JSZip', 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'), zip = new Zip();
      Object.entries(docxFiles(sections)).forEach(([path, content]) => zip.file(path, content));
      download(await zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), name + '.docx');
      return;
    }
    const pdf = await library('pdfMake', '/js/pdfmake.min.js');
    const fontNames = ['THSarabunPSK-Regular.ttf', 'THSarabunPSK-Bold.ttf'];
    const entries = await Promise.all(fontNames.map(async (font) => { const res = await fetch('/fonts/' + font); if (!res.ok) throw new Error('โหลดฟอนต์ภาษาไทยไม่สำเร็จ'); const bytes = new Uint8Array(await res.arrayBuffer()); let text = ''; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192)); return [font, btoa(text)]; }));
    pdf.vfs = Object.fromEntries(entries); pdf.fonts = { Sarabun: { normal: fontNames[0], bold: fontNames[1] } };
    const blob = await new Promise((resolve, reject) => { try { pdf.createPdf(pdfDefinition(sections)).getBlob(resolve); } catch (err) { reject(err); } });
    download(blob, name + '.pdf');
  }

  root.InsurancePrint = { exportFile, buildSections, docxFiles, pdfDefinition, summaryTable, listTable };
})(typeof window === 'undefined' ? globalThis : window);
