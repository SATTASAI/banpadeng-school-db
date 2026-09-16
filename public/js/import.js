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

// อ่านไฟล์แล้วคืนค่าทุกแถวแบบดิบๆ (ยังไม่ตัดสินว่าแถวไหนคือหัวตาราง)
// เพราะบางไฟล์ (เช่นไฟล์จากระบบ DMC) มีแถวข้อความอื่นแทรกอยู่ก่อนหัวตารางจริง
function parseSpreadsheetRaw(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: "array", cellDates: true });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, dateNF: "yyyy-mm-dd" });
        resolve(raw);
      } catch (err) {
        reject(new Error("อ่านไฟล์ไม่สำเร็จ ตรวจสอบว่าเป็นไฟล์ Excel หรือ CSV ที่ถูกต้อง"));
      }
    };
    reader.onerror = () => reject(new Error("อ่านไฟล์ไม่สำเร็จ"));
    reader.readAsArrayBuffer(file);
  });
}

// เดาว่าแถวไหน (0-based) น่าจะเป็นหัวตารางจริง โดยดูว่าแถวไหนมีจำนวนคอลัมน์ที่มีข้อมูลมากที่สุด
// ในบรรดา maxScan แถวแรก (ไฟล์ที่มีแถวข้อความ/หัวรายงานคั่นก่อน จะมีคอลัมน์ว่างเกือบหมดในแถวนั้น)
function guessHeaderRowIndex(raw, maxScan) {
  const scanLimit = Math.min(maxScan || 10, raw.length);
  let bestIndex = 0;
  let bestCount = -1;
  for (let i = 0; i < scanLimit; i++) {
    const row = raw[i] || [];
    const count = row.filter((cell) => String(cell || "").trim() !== "").length;
    if (count > bestCount) {
      bestCount = count;
      bestIndex = i;
    }
  }
  return bestIndex;
}

// ตัดแถวหัวตาราง (ตาม headerRowIndex ที่เลือก) ออกจากข้อมูลดิบ คืนค่า { headers, rows }
function extractHeadersAndRows(raw, headerRowIndex) {
  const headers = (raw[headerRowIndex] || []).map((h) => String(h || "").trim());
  const rows = raw.slice(headerRowIndex + 1).filter((r) => r.some((cell) => String(cell || "").trim() !== ""));
  return { headers, rows };
}

// สร้างข้อความตัวเลือกสำหรับ dropdown โดยแนบตัวอย่างข้อมูลจริงไปด้วย
// ช่วยแยกแยะกรณีหัวตารางชื่อซ้ำกัน (เช่นไฟล์ DMC มีคอลัมน์ "เลขประจำตัวนักเรียน" สองคอลัมน์ที่ความหมายต่างกัน)
function columnOptionLabel(header, index, rows) {
  const sample = rows.slice(0, 3)
    .map((r) => r[index])
    .find((v) => String(v || "").trim() !== "");
  const headerText = header || `(คอลัมน์ ${index + 1})`;
  return sample ? `${headerText} — ตัวอย่าง: ${sample}` : headerText;
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
