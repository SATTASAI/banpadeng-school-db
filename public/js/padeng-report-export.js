// ป่าเด็งโมเดล: สร้างเอกสาร "แบบรายงานผลการจัดกิจกรรม" ตามแบบฟอร์มของโรงเรียน เป็น PDF หรือ Word (.docx)
// รายฉบับ หรือรวมเล่ม (ขึ้นหน้าใหม่ทุกฉบับ) · รูปประกอบ 1–4 ภาพ จัดวางอัตโนมัติ (1 = ภาพใหญ่กลางหน้า, 2 = คู่, 3 = คู่ + 1 กลาง, 4 = ตาราง 2×2)
(function (root) {
  'use strict';
  const DOT = '……………………………';
  const xml = (v) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  const thaiDate = (iso) => /^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? new Date(iso + 'T12:00:00Z').toLocaleDateString('th-TH', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Bangkok' }) : '';
  const val = (v) => String(v ?? '').trim() || DOT;

  function model(it) {
    return {
      title1: 'แบบรายงานผลการจัดการเรียนจัดกิจกรรมกระบวนการพัฒนาการศึกษา เพื่อยกระดับผลสัมฤทธิ์ทางการเรียน',
      title2: `ป่าเด็งโมเดล (PADENG MODEL) ปีการศึกษา ${val(it.academic_year)}`,
      box: [`กลุ่มสาระการเรียนรู้ ${val(it.learning_area)}   รายวิชา ${val(it.subject)}`,
        `${it.kindergarten ? 'ชั้นอนุบาลปีที่' : 'ชั้นประถมศึกษาปีที่'} ${val(it.grade)}   ภาคเรียนที่ ${val(it.term_no)}   วันที่ ${thaiDate(it.teach_date) || DOT}`,
        `ครูผู้สอน ${val(it.teacher_name)}`],
      heading: 'ผลการจัดกิจกรรมกระบวนการพัฒนาการศึกษา ป่าเด็งโมเดล (PADENG MODEL)',
      topic: `1. เรื่องที่สอน ${val(it.topic)}`,
      resultHead: '2. ผลการจัดกิจกรรมการสอน (รายงานตามจุดประสงค์การเรียนรู้)',
      result: String(it.result || '').split('\n').map((s) => s.trimEnd()).filter((s, i, a) => s || (i > 0 && i < a.length - 1)),
      imagesHead: '3. รูปประกอบการจัดกิจกรรม',
      sign: ['ลงชื่อ ..........................................ครูผู้สอน', `(${String(it.teacher_name || '').trim() || '…………………………………'})`],
    };
  }
  // แถวของภาพตามจำนวน: [[i,i],[i]] ฯลฯ
  const rowsOf = (imgs) => imgs.length <= 1 ? [imgs] : imgs.length === 3 ? [imgs.slice(0, 2), imgs.slice(2)] : [imgs.slice(0, 2), imgs.slice(2, 4)].filter((r) => r.length);
  // pt (ภาพเดียวใหญ่ / ภาพคู่) · Word เผื่อบรรทัดสูงกว่า PDF เล็กน้อย
const boxOf = (n, word = false) => n === 1 ? (word ? { w: 310, h: 232 } : { w: 340, h: 255 }) : (word ? { w: 205, h: 154 } : { w: 228, h: 171 });
  const fit = (img, box) => { const s = Math.min(box.w / img.w, box.h / img.h); return { w: Math.round(img.w * s), h: Math.round(img.h * s) }; };

  // ---------- โหลดภาพ: ย่อและแปลงเป็น JPEG ด้วย canvas ----------
  async function decode(blob) {
    if (root.createImageBitmap) { try { return await createImageBitmap(blob); } catch {} }
    const url = URL.createObjectURL(blob);
    try { return await new Promise((ok, no) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => no(Error('decode')); im.src = url; }); }
    finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
  async function loadImage(url, maxPx) {
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) return null;
      const src = await decode(await res.blob());
      const w0 = src.width, h0 = src.height, s = Math.min(1, maxPx / Math.max(w0, h0));
      const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w0 * s)); c.height = Math.max(1, Math.round(h0 * s));
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(src, 0, 0, c.width, c.height);
      src.close?.();
      const dataUrl = c.toDataURL('image/jpeg', 0.82);
      const bin = atob(dataUrl.split(',')[1]), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return { dataUrl, bytes, w: c.width, h: c.height };
    } catch { return null; } // เช่น HEIC ที่เบราว์เซอร์อ่านไม่ได้ → ข้ามภาพนั้น
  }
  async function loadAll(items, fileUrl, onProgress) {
    const ids = [...new Set(items.flatMap((it) => it.images))], maxPx = items.length > 3 ? 1000 : 1400;
    const out = new Map(); let done = 0, next = 0;
    const worker = async () => { while (next < ids.length) { const id = ids[next++]; out.set(id, await loadImage(fileUrl(id), maxPx)); onProgress?.(`กำลังเตรียมภาพ ${++done}/${ids.length}`); } };
    await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker));
    return out;
  }

  // ---------- ลายเซ็น: ตัดพื้นหลัง (เทียบความสว่างกับพื้นรอบข้าง) + ทำเส้นเข้ม → PNG พื้นใส ----------
  async function processSignature(file) {
    let src;
    try { src = await decode(file); } catch { throw Error('เปิดภาพนี้ไม่ได้ กรุณาใช้ไฟล์ JPG หรือ PNG'); }
    const s0 = Math.min(1, 1400 / Math.max(src.width, src.height)), W = Math.max(1, Math.round(src.width * s0)), H = Math.max(1, Math.round(src.height * s0));
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true }); g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.drawImage(src, 0, 0, W, H); src.close?.();
    const img = g.getImageData(0, 0, W, H), px = img.data, n = W * H;
    const L = new Float32Array(n);
    for (let i = 0; i < n; i++) L[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    // พื้นหลังเฉพาะจุด = ค่าเฉลี่ยความสว่างรอบ ๆ (integral image) → ลดผลของเงา/แสงไม่เท่ากันจากการถ่ายรูป
    const I = new Float64Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) { let row = 0; for (let x = 0; x < W; x++) { row += L[y * W + x]; I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + row; } }
    const r = Math.max(8, Math.round(Math.max(W, H) / 18)), D = new Float32Array(n), hist = new Uint32Array(256);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
      const mean = (I[y1 * (W + 1) + x1] - I[y0 * (W + 1) + x1] - I[y1 * (W + 1) + x0] + I[y0 * (W + 1) + x0]) / ((x1 - x0) * (y1 - y0));
      const d = Math.max(0, Math.max(mean, 140) - L[y * W + x]); D[y * W + x] = d; hist[Math.min(255, Math.round(d))]++;
    }
    // Otsu: หาเกณฑ์แยก "หมึก" กับ "พื้น"
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let wB = 0, sB = 0, best = 0, t = 30;
    for (let i = 0; i < 256; i++) { wB += hist[i]; if (!wB) continue; const wF = n - wB; if (!wF) break; sB += i * hist[i];
      const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) ** 2; if (v > best) { best = v; t = i; } }
    t = Math.max(22, t);
    const lo = t * 0.55, hi = t * 1.15;
    let minX = W, minY = H, maxX = -1, maxY = -1;
    for (let i = 0; i < n; i++) {
      const a = Math.min(1, Math.max(0, (D[i] - lo) / (hi - lo))), o = i * 4;
      // ทำเส้นเข้ม: คงโทนสีหมึก (น้ำเงิน/ดำ) แต่กดความสว่างลง
      px[o] = Math.round(px[o] * 0.28); px[o + 1] = Math.round(px[o + 1] * 0.28); px[o + 2] = Math.round(px[o + 2] * 0.35);
      px[o + 3] = Math.round(255 * Math.min(1, a * 1.25));
      if (a > 0.5) { const x = i % W, y = (i / W) | 0; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    if (maxX < 0) throw Error('ไม่พบเส้นลายเซ็นในภาพ กรุณาถ่ายลายเซ็นบนกระดาษขาวให้ชัดขึ้น');
    g.clearRect(0, 0, W, H); g.putImageData(img, 0, 0);
    const pad = 10; minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad); maxX = Math.min(W - 1, maxX + pad); maxY = Math.min(H - 1, maxY + pad);
    const cw = maxX - minX + 1, ch = maxY - minY + 1;
    for (let max = 700; max >= 200; max -= 100) {
      const k = Math.min(1, max / cw, (max * 0.4) / ch), out = document.createElement('canvas');
      out.width = Math.max(1, Math.round(cw * k)); out.height = Math.max(1, Math.round(ch * k));
      out.getContext('2d').drawImage(c, minX, minY, cw, ch, 0, 0, out.width, out.height);
      const dataUrl = out.toDataURL('image/png');
      if (dataUrl.length < 380 * 1024) return dataUrl;
    }
    throw Error('ภาพลายเซ็นมีรายละเอียดมากเกินไป กรุณาครอปให้เหลือเฉพาะลายเซ็น');
  }
  function dataUrlImage(dataUrl) {
    return new Promise((ok) => { if (!dataUrl) return ok(null); const im = new Image(); im.onload = () => {
      const bin = atob(dataUrl.split(',')[1]), bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      ok({ dataUrl, bytes, w: im.naturalWidth, h: im.naturalHeight, png: true }); }; im.onerror = () => ok(null); im.src = dataUrl; });
  }
  const SIGN_BOX = { w: 120, h: 42 };

  // ---------- PDF (pdfmake) ----------
  function pdfItem(it, imgs, logo, first, sig) {
    const m = model(it), content = [];
    content.push(logo ? { image: logo.dataUrl, fit: [60, 76], alignment: 'center', ...(first ? {} : { pageBreak: 'before' }) } : { text: '', ...(first ? {} : { pageBreak: 'before' }) });
    content.push({ text: m.title1, bold: true, alignment: 'center', margin: [0, 4, 0, 0] }, { text: m.title2, bold: true, alignment: 'center' });
    content.push({ table: { widths: ['*'], body: [[{ stack: m.box.map((t) => ({ text: t, alignment: 'center' })), margin: [6, 3, 6, 5] }]] }, layout: { hLineWidth: () => 0.8, vLineWidth: () => 0.8 }, margin: [30, 8, 30, 10] });
    content.push({ text: m.heading, bold: true, margin: [24, 0, 0, 0] }, { text: m.topic }, { text: m.resultHead });
    content.push(...(m.result.length ? m.result : [DOT + DOT + DOT]).map((t) => ({ text: t || ' ', margin: [40, 0, 0, 0] })));
    content.push({ text: m.imagesHead, margin: [0, 2, 0, 6] });
    const ok = imgs.filter(Boolean);
    for (const row of rowsOf(ok)) {
      const box = boxOf(row.length);
      content.push({ columns: [{ width: '*', text: '' }, ...row.flatMap((img, i) => [...(i ? [{ width: 14, text: '' }] : []), { width: box.w, stack: [{ image: img.dataUrl, width: fit(img, box).w, height: fit(img, box).h, alignment: 'center' }] }]), { width: '*', text: '' }], margin: [0, 0, 0, 10], unbreakable: true });
    }
    if (imgs.length > ok.length) content.push({ text: `(มีภาพ ${imgs.length - ok.length} ภาพที่เปิดไม่ได้ในเบราว์เซอร์นี้)`, fontSize: 12, color: '#777', alignment: 'center' });
    const signStack = [...(sig ? [{ image: sig.dataUrl, width: fit(sig, SIGN_BOX).w, height: fit(sig, SIGN_BOX).h, alignment: 'center', margin: [0, 0, 0, -16] }] : []),
      ...m.sign.map((t) => ({ text: t, alignment: 'center' }))];
    content.push({ columns: [{ width: '*', text: '' }, { width: 240, stack: signStack }], margin: [0, sig ? 4 : 18, 0, 0], unbreakable: true });
    return content;
  }

  // ---------- Word (.docx) ----------
  const EMU = 12700;
  function docxDocument(items, imgMap, logo, sigs = {}) {
    const media = []; let pic = 0;
    const ext = (img) => img.png ? 'png' : 'jpeg';
    const embed = (img) => { media.push(img); return `rIdImg${media.length}`; };
    const drawing = (img, w, h) => {
      const rid = embed(img), id = ++pic;
      return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${w * EMU}" cy="${h * EMU}"/><wp:docPr id="${id}" name="ภาพ ${id}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="image${id}.${ext(img)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${w * EMU}" cy="${h * EMU}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
    };
    const run = (t, bold) => `<w:r><w:rPr>${bold ? '<w:b/><w:bCs/>' : ''}</w:rPr><w:t xml:space="preserve">${xml(t)}</w:t></w:r>`;
    const p = (inner, { align = 'left', ind = 0, before = 0, after = 0, pageBreak = false, keep = false } = {}) =>
      `<w:p><w:pPr>${pageBreak ? '<w:pageBreakBefore/>' : ''}${keep ? '<w:keepNext/>' : ''}<w:spacing w:before="${before}" w:after="${after}"/>${ind ? `<w:ind w:left="${ind}"/>` : ''}<w:jc w:val="${align}"/></w:pPr>${inner}</w:p>`;
    const border = ['top', 'left', 'bottom', 'right'].map((k) => `<w:${k} w:val="single" w:sz="8" w:space="0" w:color="000000"/>`).join('');
    let body = '';
    items.forEach((it, idx) => {
      const m = model(it);
      body += logo ? p(drawing(logo, 60, Math.round(60 * logo.h / logo.w)), { align: 'center', pageBreak: idx > 0 }) : p('', { pageBreak: idx > 0 });
      body += p(run(m.title1, true), { align: 'center', before: 60 }) + p(run(m.title2, true), { align: 'center', after: 120 });
      body += `<w:tbl><w:tblPr><w:tblW w:w="8500" w:type="dxa"/><w:jc w:val="center"/><w:tblBorders>${border}</w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid><w:gridCol w:w="8500"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="8500" w:type="dxa"/></w:tcPr>${m.box.map((t) => p(run(t), { align: 'center' })).join('')}</w:tc></w:tr></w:tbl>`;
      body += p(run(m.heading, true), { ind: 454, before: 160 }) + p(run(m.topic)) + p(run(m.resultHead));
      body += (m.result.length ? m.result : [DOT + DOT + DOT]).map((t) => p(run(t), { ind: 850 })).join('');
      body += p(run(m.imagesHead), { after: 100, keep: true });
      const imgs = it.images.map((id) => imgMap.get(id)), ok = imgs.filter(Boolean);
      for (const row of rowsOf(ok)) {
        const box = boxOf(row.length, true);
        body += p(row.map((img) => { const s = fit(img, box); return drawing(img, s.w, s.h); }).join(run('    ')), { align: 'center', after: 100 });
      }
      if (imgs.length > ok.length) body += p(run(`(มีภาพ ${imgs.length - ok.length} ภาพที่เปิดไม่ได้ในเบราว์เซอร์นี้)`), { align: 'center' });
      const sig = sigs[it.user_id];
      if (sig) { const s = fit(sig, SIGN_BOX); body += p(drawing(sig, s.w, s.h), { align: 'center', ind: 4500, before: 160, keep: true }); }
      body += p(run(m.sign[0]), { align: 'center', ind: 4500, before: sig ? 0 : 200, keep: true }) + p(run(m.sign[1]), { align: 'center', ind: 4500 });
    });
    const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
    const font = '<w:rFonts w:ascii="TH Sarabun PSK" w:hAnsi="TH Sarabun PSK" w:eastAsia="TH Sarabun PSK" w:cs="TH Sarabun PSK"/><w:sz w:val="32"/><w:szCs w:val="32"/>';
    const files = {
      '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
      '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      'word/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr>${font}<w:lang w:val="th-TH" w:bidi="th-TH"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults></w:styles>`,
      'word/_rels/document.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
        + media.map((img, i) => `<Relationship Id="rIdImg${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${i + 1}.${ext(img)}"/>`).join('') + '</Relationships>',
      'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${ns}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="850" w:right="1134" w:bottom="850" w:left="1247" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`,
    };
    media.forEach((img, i) => { files[`word/media/image${i + 1}.${ext(img)}`] = img.bytes; });
    return files;
  }

  // ---------- ส่วนกลาง ----------
  const loading = new Map();
  function library(name, url) {
    if (root[name]) return Promise.resolve(root[name]);
    if (!loading.has(name)) loading.set(name, new Promise((ok, no) => { const s = document.createElement('script'); s.src = url; s.onload = () => ok(root[name]); s.onerror = () => { loading.delete(name); s.remove(); no(Error('โหลดเครื่องมือสร้างเอกสารไม่สำเร็จ กรุณาลองใหม่')); }; document.head.append(s); }));
    return loading.get(name);
  }
  function download(blob, name) { const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
  async function thaiFonts() {
    return Object.fromEntries(await Promise.all(['THSarabunPSK-Regular.ttf', 'THSarabunPSK-Bold.ttf'].map(async (n) => {
      const r = await fetch('/fonts/' + n); if (!r.ok) throw Error('โหลดฟอนต์ภาษาไทยไม่สำเร็จ');
      const b = new Uint8Array(await r.arrayBuffer()); let t = ''; for (let i = 0; i < b.length; i += 8192) t += String.fromCharCode(...b.subarray(i, i + 8192));
      return [n, btoa(t)];
    })));
  }

  async function exportDocs(items, format, fileName, { fileUrl, onProgress, signatures = {} } = {}) {
    if (!items?.length) throw Error('ไม่มีแบบรายงานให้ดาวน์โหลด');
    onProgress?.('กำลังเตรียมเอกสาร…');
    const [imgMap, logo] = await Promise.all([loadAll(items, fileUrl, onProgress), loadImage('/img/padeng-logo.jpg', 300)]);
    const sigs = Object.fromEntries(await Promise.all(Object.entries(signatures || {}).map(async ([u, d]) => [u, await dataUrlImage(d)])));
    onProgress?.(`กำลังสร้างไฟล์ ${format === 'docx' ? 'Word' : 'PDF'}…`);
    if (format === 'docx') {
      const Zip = await library('JSZip', 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'), zip = new Zip();
      for (const [path, data] of Object.entries(docxDocument(items, imgMap, logo, sigs))) zip.file(path, data);
      download(await zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), fileName + '.docx');
    } else {
      const pdf = await library('pdfMake', '/js/pdfmake.min.js');
      pdf.vfs = { ...(pdf.vfs || {}), ...(await thaiFonts()) };
      pdf.fonts = { ...(pdf.fonts || {}), Sarabun: { normal: 'THSarabunPSK-Regular.ttf', bold: 'THSarabunPSK-Bold.ttf' } };
      const content = items.flatMap((it, i) => pdfItem(it, it.images.map((id) => imgMap.get(id)), logo, i === 0, sigs[it.user_id]));
      const def = { pageSize: 'A4', pageMargins: [62, 36, 56, 36], defaultStyle: { font: 'Sarabun', fontSize: 16, lineHeight: 0.92 }, content,
        info: { title: fileName } };
      download(await new Promise((ok, no) => { try { pdf.createPdf(def).getBlob(ok); } catch (e) { no(e); } }), fileName + '.pdf');
    }
    onProgress?.('');
  }
  root.PadengReportExport = { model, rowsOf, boxOf, fit, docxDocument, pdfItem, exportDocs, thaiDate, processSignature };
})(typeof window === 'undefined' ? globalThis : window);
