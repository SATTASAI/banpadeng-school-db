// ต้องโหลด SheetJS (XLSX) ในหน้าที่ใช้ไฟล์นี้ ก่อน <script src="/js/import.js">

function normalizeHeader(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[\s\-_.]/g, "");
}

// fieldDefs: [{ key, label, synonyms: [] }]
// คืนค่า mapping: { key: headerIndex หรือ null }
function fuzzyMatchColumns(headers, fieldDefs) {
  const normHeaders = headers.map(normalizeHeader);
  const mapping = {};
  const usedIndexes = new Set();

  fieldDefs.forEach((field) => {
    let foundIndex = null;
    for (const syn of field.synonyms) {
      const normSyn = normalizeHeader(syn);
      const idx = normHeaders.findIndex(
        (h, i) => !usedIndexes.has(i) && (h === normSyn || h.includes(normSyn) || normSyn.includes(h))
      );
      if (idx !== -1) {
        foundIndex = idx;
        break;
      }
    }
    mapping[field.key] = foundIndex;
    if (foundIndex !== null) usedIndexes.add(foundIndex);
  });

  return mapping;
}

// คืนค่า { headers: [...], rows: [[...], [...]] } จากไฟล์ Excel/CSV
function parseSpreadsheetFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: "array", cellDates: true });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, dateNF: "yyyy-mm-dd" });
        const headers = (raw[0] || []).map((h) => String(h || "").trim());
        const rows = raw.slice(1).filter((r) => r.some((cell) => String(cell || "").trim() !== ""));
        resolve({ headers, rows });
      } catch (err) {
        reject(new Error("อ่านไฟล์ไม่สำเร็จ ตรวจสอบว่าเป็นไฟล์ Excel หรือ CSV ที่ถูกต้อง"));
      }
    };
    reader.onerror = () => reject(new Error("อ่านไฟล์ไม่สำเร็จ"));
    reader.readAsArrayBuffer(file);
  });
}

// สร้าง object รายแถวตาม mapping ปัจจุบัน (mapping มาจาก dropdown ที่ผู้ใช้ยืนยัน/แก้ไขแล้ว)
function buildImportRows(rows, mapping, fieldDefs) {
  return rows.map((row) => {
    const obj = {};
    fieldDefs.forEach((field) => {
      const idx = mapping[field.key];
      obj[field.key] = idx !== null && idx !== undefined && idx !== "" ? row[Number(idx)] : "";
    });
    return obj;
  });
}
