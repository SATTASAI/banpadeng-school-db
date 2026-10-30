// สร้างไฟล์ ZIP แบบสตรีม (ไม่บีบอัด — ภาพ JPG บีบไม่ลงอยู่แล้ว) โดยไม่ต้องโหลดภาพทั้งหมดไว้ในหน่วยความจำ
// ใช้ data descriptor (bit 3) จึงคำนวณ CRC ระหว่างส่งได้ · ชื่อไฟล์ UTF-8 (bit 11)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(crc, bytes) {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const d = new Date(date.getTime() + 7 * 3600000); // เวลาไทย
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  const day = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, day };
}

function header(size, fill) {
  const buf = new Uint8Array(size);
  fill(new DataView(buf.buffer));
  return buf;
}

// entries: [{ name, open: async () => ReadableStream }] — open ถูกเรียกทีละไฟล์ตามลำดับ
export function zipStream(entries, onError = () => {}) {
  const enc = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  (async () => {
    const central = [];
    let offset = 0;
    const { time, day } = dosDateTime(new Date());
    const write = async (bytes) => { await writer.write(bytes); offset += bytes.length; };
    try {
      for (const entry of entries) {
        let stream;
        try { stream = await entry.open(); } catch (e) { onError(entry, e); continue; } // ข้ามไฟล์ที่เปิดไม่ได้
        const name = enc.encode(entry.name);
        const start = offset;
        await write(header(30, (v) => {
          v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0808, true);
          v.setUint16(8, 0, true); v.setUint16(10, time, true); v.setUint16(12, day, true);
          v.setUint16(26, name.length, true);
        }));
        await write(name);
        let crc = 0, size = 0;
        const reader = stream.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          crc = crc32(crc, value); size += value.length;
          await write(value);
        }
        await write(header(16, (v) => {
          v.setUint32(0, 0x08074b50, true); v.setUint32(4, crc, true); v.setUint32(8, size, true); v.setUint32(12, size, true);
        }));
        central.push({ name, crc, size, start });
      }
      const cdStart = offset;
      for (const f of central) {
        await write(header(46, (v) => {
          v.setUint32(0, 0x02014b50, true); v.setUint16(4, 20, true); v.setUint16(6, 20, true); v.setUint16(8, 0x0808, true);
          v.setUint16(12, time, true); v.setUint16(14, day, true); v.setUint32(16, f.crc, true);
          v.setUint32(20, f.size, true); v.setUint32(24, f.size, true); v.setUint16(28, f.name.length, true);
          v.setUint32(42, f.start, true);
        }));
        await write(f.name);
      }
      const cdSize = offset - cdStart;
      await write(header(22, (v) => {
        v.setUint32(0, 0x06054b50, true); v.setUint16(8, central.length, true); v.setUint16(10, central.length, true);
        v.setUint32(12, cdSize, true); v.setUint32(16, cdStart, true);
      }));
      await writer.close();
    } catch (e) {
      onError(null, e);
      await writer.abort(e).catch(() => {});
    }
  })();
  return readable;
}

// แบ่งภาพเป็นส่วน ๆ ไม่ให้ไฟล์ zip ใหญ่เกินไป (ไฟล์ zip ธรรมดารองรับไม่เกิน 4 GB / 65,535 ไฟล์)
export const PART_MAX_FILES = 300;
export const PART_MAX_BYTES = 1.5 * 1024 * 1024 * 1024;
export function splitParts(photos) {
  const parts = [];
  let cur = null;
  for (const p of photos) {
    const size = Number(p.file_size) || 5 * 1024 * 1024;
    if (!cur || cur.photos.length >= PART_MAX_FILES || cur.bytes + size > PART_MAX_BYTES) {
      cur = { photos: [], bytes: 0 };
      parts.push(cur);
    }
    cur.photos.push(p); cur.bytes += size;
  }
  return parts;
}

// ชื่อไฟล์ในอัลบั้มไม่ให้ซ้ำกัน: a.jpg, a (2).jpg
export function uniqueNames(names) {
  const used = new Set();
  return names.map((raw) => {
    const name = String(raw || "photo.jpg").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_");
    let candidate = name, n = 2;
    const dot = name.lastIndexOf(".");
    while (used.has(candidate.toLowerCase())) {
      candidate = dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
      n++;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  });
}
