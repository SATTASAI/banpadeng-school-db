// ใช้ร่วมกัน: หน้าป่าเด็งโมเดล และวิจัยในชั้นเรียน
window.TeachingWorks = (() => {
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fileUrl = (kind, id, download = false) => `/api/teaching-works/${kind}/files/${id}${download ? '?download=1' : ''}`;
  const termText = (t) => `${t.year_be} ภาคเรียนที่ ${t.term_number}${t.status === 'active' ? ' (ปัจจุบัน)' : t.status === 'closed' ? ' (ปิดแล้ว)' : ''}`;
  function showError(msg = '') { const el = $('error'); el.textContent = msg; el.style.display = msg ? 'block' : 'none'; }
  function fillTerms(d) {
    const sel = $('term');
    if (!d.terms?.length || sel.options.length) { if (d.term) sel.value = d.term.id; return; }
    sel.innerHTML = d.terms.map((t) => `<option value="${t.id}">${esc(termText(t))}</option>`).join('');
    if (d.term) sel.value = d.term.id;
  }
  const progressBar = (done, total) => `<i class="tw-bar"><b style="width:${total ? Math.round(done / total * 100) : 0}%"></b></i>`;

  // ส่งทีละไฟล์ (ไฟล์ใหญ่/ภาพหลายภาพไม่ชนขีดจำกัด) พร้อมแถบความคืบหน้า
  function sendOne(path, fields, onProgress) {
    return new Promise((resolve, reject) => {
      const fd = new FormData();
      for (const [k, v] of Object.entries(fields)) fd.append(k, v);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', path);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => { let d = {}; try { d = JSON.parse(xhr.responseText); } catch {} xhr.status < 300 ? resolve(d) : reject(new Error(d.error || `ส่งไม่สำเร็จ (${xhr.status})`)); };
      xhr.onerror = () => reject(new Error('การเชื่อมต่อขัดข้อง'));
      xhr.send(fd);
    });
  }
  async function uploadFiles(path, files, fieldsOf, box) {
    if (!files.length) return;
    showError();
    const failed = [];
    for (let i = 0; i < files.length; i++) {
      const paint = (p) => { if (box) box.innerHTML = `กำลังส่ง ${i + 1}/${files.length}${progressBar(Math.round(p * 100), 100)}`; };
      paint(0);
      try { await sendOne(path, fieldsOf(files[i]), paint); }
      catch (e) { failed.push(`${files[i].name}: ${e.message}`); }
    }
    if (box) box.innerHTML = '';
    if (failed.length) showError(`ส่งไม่สำเร็จ ${failed.length} ไฟล์ — ${failed.join(' · ')}`);
    try { window.parent?.postMessage?.({ type: 'school-data-changed' }, location.origin); } catch {}
  }
  function openImage(src) {
    const lb = $('lightbox'); if (!lb) return window.open(src, '_blank');
    $('lbImg').src = src; lb.hidden = false;
    $('lbClose').onclick = lb.onclick = (e) => { if (e.target === lb || e.target.id === 'lbClose') { lb.hidden = true; $('lbImg').removeAttribute('src'); } };
  }
  async function boot(start) {
    try {
      const me = await apiRequest('/api/auth/me');
      if (!me.user) { location.href = '/login.html'; return; }
      start(await apiRequest('/api/teaching-works/permissions'));
    } catch (e) { showError(e.message); $('body').innerHTML = ''; }
  }
  return { $, esc, fileUrl, termText, showError, fillTerms, progressBar, uploadFiles, openImage, boot };
})();
