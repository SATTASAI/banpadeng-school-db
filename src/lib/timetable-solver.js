// Pure, bounded constraint search for the automatic timetable. No persistence.
// - hard constraints: classroom / teacher / specialist-room collisions, teacher unavailability,
//   per-day limits, contiguous blocks that never cross lunch (after period 3)
// - soft preferences (ordering only): spread a subject across days, core subjects in the morning,
//   balanced daily load per teacher
// - strict mode returns nothing on failure; allow_partial returns the best placement plus the unplaced loads
// - `proposed` verifies a previewed result instead of searching again (apply writes exactly what was previewed)
const key = (a) => JSON.stringify([a.grade_level, a.classroom]);
const groupKey = (a) => JSON.stringify([a.grade_level, a.classroom, a.subject, a.teacher_id]);
const si = (d, p) => (d - 1) * 6 + (p - 1);

export const CORE_SUBJECT = /ไทย|คณิต|คำนวณ|วิทยา|วิทย์|อังกฤษ|english|math|science/i;
export const PREFER_VALUES = ['auto', 'morning', 'afternoon', 'any'];

// ชื่อห้องสอนเฉพาะ: ตัดช่องว่างซ้ำ/ท้าย และ ฯ หรือจุดท้ายคำ — ใช้เป็นชื่อที่บันทึก
export function normalizeRoomName(value) {
  return String(value ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().replace(/[ฯ.]+$/u, '').trim();
}
// คีย์เปรียบเทียบห้อง: ไม่สนช่องว่างและตัวพิมพ์ใหญ่เล็ก "ห้อง คอม" = "ห้องคอม"
export function roomNameKey(value) {
  return normalizeRoomName(value).toLowerCase().replace(/\s/g, '');
}
export function resolvePrefer(a) {
  const p = a?.prefer || 'auto';
  if (p !== 'auto') return p;
  return CORE_SUBJECT.test(a?.subject || '') ? 'morning' : 'any';
}

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
}

export function solveTimetable(input, { maxNodes = 2000000, maxMs = 6000, names } = {}) {
  const errors = [], assignments = input.assignments || [], classes = input.classes || [];
  const periods = input.periods_per_day || [6, 5, 5, 5, 5];
  const fixed = input.fixed || [];
  const partialAllowed = input.allow_partial === true;
  const teacherName = (id) => (names instanceof Map ? names.get(id) : names?.[id]) || `รหัส ${id}`;
  if (!Array.isArray(fixed) || fixed.length > 1800) return { ok: false, errors: ['คาบที่ล็อกไม่ถูกต้อง'] };
  if (!Array.isArray(periods) || periods.length !== 5 || periods.some((n) => !Number.isInteger(n) || n < 1 || n > 6)) return { ok: false, errors: ['จำนวนคาบรายวิชาต่อวันต้องอยู่ระหว่าง 1–6'] };
  if (!classes.length || classes.length > 60 || assignments.length > 1000) return { ok: false, errors: ['เลือกห้องเรียน 1–60 ห้องและภาระสอนไม่เกิน 1,000 รายการ'] };
  if (input.proposed !== undefined && (!Array.isArray(input.proposed) || input.proposed.length > 2400)) return { ok: false, errors: ['ผลทดลองจัดไม่ถูกต้อง'] };
  const selected = new Set(classes.map(key));
  if (selected.size !== classes.length) return { ok: false, errors: ['ห้องเรียนซ้ำ'] };
  const capacity = periods.reduce((n, p) => n + p, 0);
  // คาบกิจกรรมพัฒนาผู้เรียนที่ฝ่ายวัดผลล็อกไว้ในโครงเวลาเรียน (ต่อห้อง) — ห้ามลงรายวิชา ไม่ต้องมีครู
  const reserved = new Set(), reservedCount = new Map();
  const cellKey = (a, d, p) => JSON.stringify([a.grade_level, a.classroom, d, p]);
  if (input.class_activity !== undefined && (!Array.isArray(input.class_activity) || input.class_activity.length > 1800)) return { ok: false, errors: ['คาบกิจกรรมในโครงเวลาเรียนไม่ถูกต้อง'] };
  for (const r of input.class_activity || []) {
    if (!r || !Number.isInteger(r.weekday) || r.weekday < 1 || r.weekday > 5 || !Number.isInteger(r.period) || r.period < 1 || r.period > 6) return { ok: false, errors: ['คาบกิจกรรมในโครงเวลาเรียนไม่ถูกต้อง'] };
    if (!selected.has(key(r)) || r.period > periods[r.weekday - 1]) continue;
    const k = cellKey(r, r.weekday, r.period); if (reserved.has(k)) continue;
    reserved.add(k); reservedCount.set(key(r), (reservedCount.get(key(r)) || 0) + 1);
  }
  const isReserved = (e) => reserved.has(cellKey(e, e.weekday, e.period));
  const capOf = (c) => capacity - (reservedCount.get(key(c)) || 0);

  // ชื่อห้องสอนเฉพาะ: ใช้ตัวสะกดแรกที่พบ (ตารางเดิมก่อน) เป็นชื่อมาตรฐาน
  const roomDisplay = new Map();
  const canonicalRoom = (v) => {
    const name = normalizeRoomName(v); if (!name) return '';
    const k = roomNameKey(name); if (!roomDisplay.has(k)) roomDisplay.set(k, name); return roomDisplay.get(k);
  };
  for (const e of input.existing || []) if (e.room_name) canonicalRoom(e.room_name);

  const groups = new Map();
  for (const a of assignments) {
    const k = groupKey(a);
    if (!selected.has(key(a)) || !a.subject?.trim() || a.subject.length > 120 || !Number.isSafeInteger(a.teacher_id) || a.teacher_id < 1 || !Number.isInteger(a.periods_per_week) || a.periods_per_week < 1 || a.periods_per_week > 30 || !Number.isInteger(a.max_per_day) || a.max_per_day < 1 || a.max_per_day > 6 || typeof (a.room_name || '') !== 'string' || (a.room_name || '').length > 100 || (a.prefer !== undefined && !PREFER_VALUES.includes(a.prefer))) { errors.push('ภาระสอนไม่ถูกต้อง'); continue; }
    if (groups.has(k)) { errors.push('ภาระสอนครู–วิชา–ห้องซ้ำ'); continue; }
    if (a.periods_per_week > periods.reduce((n, p) => n + Math.min(p, a.max_per_day), 0)) errors.push(`${a.grade_level}/${a.classroom} ${a.subject}: จำนวนคาบเกินข้อจำกัดต่อวัน`);
    const block = a.block_size ?? 1;
    if (!Number.isInteger(block) || block < 1 || block > 3 || a.periods_per_week % block || a.max_per_day < block) errors.push(`${a.subject}: คาบต่อเนื่องต้องเป็น 1–3 และหารจำนวนคาบต่อสัปดาห์ลงตัว`);
    const room_name = canonicalRoom(a.room_name);
    groups.set(k, { ...a, room_name, rk: room_name ? roomNameKey(room_name) : '', block_size: block, k, remaining: a.periods_per_week, prefer: resolvePrefer(a), daily: new Uint8Array(6), fails: 0 });
  }
  for (const c of classes) { const total = assignments.filter((a) => key(a) === key(c)).reduce((n, a) => n + a.periods_per_week, 0); if (total > capOf(c)) errors.push(`${c.grade_level}/${c.classroom}: ภาระสอน ${total} คาบ เกินช่องรายวิชา ${capOf(c)} คาบ (หักคาบกิจกรรมแล้ว)`); }
  if (!groups.size) errors.push('เพิ่มภาระสอนก่อนจัดตาราง');

  // ตารางการใช้งาน 5 วัน × 6 คาบ แบบตัวเลข (เร็วกว่าคีย์ข้อความหลายเท่า)
  const classBusy = new Map(), teacherBusy = new Map(), roomBusy = new Map(), blocked = new Map(), teacherDay = new Map();
  const grid = (m, k) => { let a = m.get(k); if (!a) { a = new Uint8Array(30); m.set(k, a); } return a; };
  const dayLoad = (id) => { let a = teacherDay.get(id); if (!a) { a = new Int16Array(6); teacherDay.set(id, a); } return a; };
  for (const b of input.unavailable || []) {
    if (!Number.isSafeInteger(b.teacher_id) || b.teacher_id < 1 || !Number.isInteger(b.weekday) || b.weekday < 1 || b.weekday > 5 || !Number.isInteger(b.period) || b.period < 1 || b.period > 6) errors.push('คาบไม่ว่างของครูไม่ถูกต้อง');
    else grid(blocked, b.teacher_id)[si(b.weekday, b.period)] = 1;
  }
  const isBlocked = (id, d, p) => !!blocked.get(id)?.[si(d, p)];
  const rk = (e) => (e.room_name ? roomNameKey(e.room_name) : '');
  const collides = (e) => !!(grid(classBusy, key(e))[si(e.weekday, e.period)] || grid(teacherBusy, e.teacher_id)[si(e.weekday, e.period)] || (rk(e) && grid(roomBusy, rk(e))[si(e.weekday, e.period)]));
  function occupy(e) {
    const i = si(e.weekday, e.period);
    grid(classBusy, key(e))[i] = 1; grid(teacherBusy, e.teacher_id)[i] = 1; if (rk(e)) grid(roomBusy, rk(e))[i] = 1;
    dayLoad(e.teacher_id)[e.weekday]++;
  }

  const locked = [], context = [];
  const source = [...(input.existing || [])];
  const same = (a, b) => key(a) === key(b) && a.weekday === b.weekday && a.period === b.period && a.subject === b.subject && a.teacher_id === b.teacher_id && rk(a) === rk(b);
  const sameSlot = (a, b) => key(a) === key(b) && a.weekday === b.weekday && a.period === b.period;
  const fixedSeen = new Set();
  for (const raw of fixed) {
    const e = raw && { ...raw, room_name: canonicalRoom(raw.room_name) };
    if (!e || !selected.has(key(e)) || !e.subject?.trim() || e.subject.length > 120 || !Number.isSafeInteger(e.teacher_id) || e.teacher_id < 1 || !Number.isInteger(e.weekday) || e.weekday < 1 || e.weekday > 5 || !Number.isInteger(e.period) || e.period < 1 || e.period > 6 || typeof (raw.room_name || '') !== 'string' || (raw.room_name || '').length > 100) { errors.push('คาบที่ล็อกไม่ถูกต้อง'); continue; }
    const s = JSON.stringify([e.grade_level, e.classroom, e.weekday, e.period]);
    if (fixedSeen.has(s)) { errors.push('คาบล็อกห้อง–วัน–คาบซ้ำ'); continue; } fixedSeen.add(s);
    const old = source.find((a) => sameSlot(a, e));
    if (old && same(old, e)) continue;
    if (old && (input.keep_existing || old.period > periods[old.weekday - 1])) { errors.push('คาบที่ล็อกใหม่ขัดกับตารางเดิม'); continue; }
    if (old) source.splice(source.indexOf(old), 1);
    source.push({ ...e, _fixed: true });
  }
  for (const e of source) {
    if (selected.has(key(e)) && !input.keep_existing && !e._fixed && !fixed.some((f) => same(f, e)) && e.period <= periods[e.weekday - 1]) continue;
    // ตารางเดิมที่ลงรายวิชาไว้ในช่องที่ตอนนี้เป็นคาบกิจกรรม: ไม่เก็บไว้ (ให้จัดรายวิชานั้นใหม่)
    if (selected.has(key(e)) && isReserved(e) && !e._fixed && groups.has(groupKey(e))) continue;
    if (collides(e)) { errors.push('คาบเดิมมีครู ห้องเรียน หรือห้องสอนชนกัน'); continue; }
    occupy(e);
    if (!selected.has(key(e))) { context.push(e); continue; }
    const { _fixed, ...clean } = e; locked.push(clean);
    if (isBlocked(e.teacher_id, e.weekday, e.period)) errors.push(`คาบที่ล็อกตรงกับเวลาครูไม่ว่าง: ${e.subject}`);
    // คาบพัฒนาผู้เรียนหลังคาบรายวิชา ล็อกไว้แต่ไม่นับรวมภาระรายวิชา
    if (e.period > periods[e.weekday - 1] || isReserved(e)) continue;
    const g = groups.get(groupKey(e));
    if (!g || g.rk !== rk(e)) { errors.push(`คาบที่ล็อกไม่ตรงภาระสอน: ${e.subject}`); continue; }
    g.remaining--; g.daily[e.weekday]++;
    if (g.remaining < 0 || g.daily[e.weekday] > g.max_per_day) errors.push(`คาบที่ล็อกเกินภาระสอนหรือเพดานต่อวัน: ${e.subject}`);
  }
  const blockErrors = (list) => {
    const out = [];
    for (const g of groups.values()) {
      if (g.block_size < 2) continue;
      const mine = list.filter((e) => groupKey(e) === g.k);
      for (let d = 1; d <= 5; d++) for (const half of [[1, 2, 3], [4, 5, 6]]) {
        let run = 0;
        for (const p of [...half, 0]) { if (p && mine.some((e) => e.weekday === d && e.period === p)) run++; else { if (run % g.block_size) out.push(`${g.subject}: คาบที่ล็อกต้องครบชุดต่อเนื่อง ${g.block_size} คาบและไม่ข้ามพักกลางวัน`); run = 0; } }
      }
    }
    return out;
  };
  errors.push(...blockErrors(locked));
  if (errors.length) return { ok: false, errors: [...new Set(errors)] };

  // ปิดช่องคาบกิจกรรมของห้อง (ช่องที่ยังว่าง — ถ้ามีคาบล็อกพร้อมครูลงไว้แล้วก็ใช้ช่องนั้นอยู่แล้ว)
  for (const k of reserved) { const [g0, c0, d, p] = JSON.parse(k); grid(classBusy, key({ grade_level: g0, classroom: c0 }))[si(d, p)] = 1; }
  const gList = [...groups.values()];
  for (const g of gList) {
    g.cls = grid(classBusy, key(g)); g.tch = grid(teacherBusy, g.teacher_id); g.blk = grid(blocked, g.teacher_id);
    g.room = g.rk ? grid(roomBusy, g.rk) : null; g.tday = dayLoad(g.teacher_id);
  }
  const fits = (g, d, p) => {
    const i = si(d, p);
    return !g.cls[i] && !g.tch[i] && !g.blk[i] && !(g.room && g.room[i]);
  };
  const lunchOk = (p, b) => !(p <= 3 && p + b - 1 > 3);
  const entriesOf = (g, d, p, len = g.block_size) => Array.from({ length: len }, (_, i) => ({ grade_level: g.grade_level, classroom: g.classroom, subject: g.subject, teacher_id: g.teacher_id, room_name: g.room_name || '', weekday: d, period: p + i }));
  function place(g, d, p, v, len = g.block_size) {
    for (let i = 0; i < len; i++) {
      const j = si(d, p + i);
      g.cls[j] = v; g.tch[j] = v; if (g.room) g.room[j] = v;
    }
    const n = v ? len : -len;
    g.daily[d] += n; g.tday[d] += n; g.remaining -= n;
  }

  function reasons(g) {
    const r = { class_full: 0, teacher_other: 0, teacher_unavailable: 0, room_busy: 0 };
    for (let d = 1; d <= 5; d++) for (let p = 1; p <= periods[d - 1]; p++) {
      const i = si(d, p);
      if (reserved.has(cellKey(g, d, p))) continue;
      if (g.blk[i]) r.teacher_unavailable++; else if (g.tch[i]) r.teacher_other++; else if (g.room && g.room[i]) r.room_busy++; else if (g.cls[i]) r.class_full++;
    }
    return r;
  }
  const label = (g) => `${g.grade_level}/${g.classroom} ${g.subject} (${teacherName(g.teacher_id)})`;
  const explain = (g, r) => [
    r.teacher_other && `ครูติดสอนห้องอื่น ${r.teacher_other} ช่อง`,
    r.teacher_unavailable && `ครูไม่ว่าง ${r.teacher_unavailable} ช่อง`,
    r.room_busy && `ห้อง${g.room_name}ไม่ว่าง ${r.room_busy} ช่อง`,
    r.class_full && `ห้องเรียนมีคาบอื่นแล้ว ${r.class_full} ช่อง`,
    `จำกัดวันละ ${g.max_per_day} คาบ${g.block_size > 1 ? ` ต่อเนื่องครั้งละ ${g.block_size}` : ''}`,
    g.periods_per_week >= 5 * g.max_per_day && 'ต้องลงทุกวันเต็มเพดาน ลองเพิ่ม "สูงสุด/วัน"'
  ].filter(Boolean).join(' · ');

  function finish(made, partial, warnings = []) {
    const entries = [...locked, ...made];
    const unplaced = gList.filter((g) => g.remaining > 0).map((g) => {
      const r = reasons(g);
      return { grade_level: g.grade_level, classroom: g.classroom, subject: g.subject, teacher_id: g.teacher_id, room_name: g.room_name || '', missing: g.remaining, reasons: r, reason: explain(g, r) };
    });
    const summary = classes.map((c) => ({
      ...c,
      required: assignments.filter((a) => key(a) === key(c)).reduce((n, a) => n + a.periods_per_week, 0),
      unfilled: capOf(c) - entries.filter((e) => key(e) === key(c) && e.period <= periods[e.weekday - 1] && !isReserved(e)).length,
      missing: unplaced.filter((u) => key(u) === key(c)).reduce((n, u) => n + u.missing, 0)
    }));
    const involved = new Set(entries.map((e) => e.teacher_id));
    return {
      ok: true, partial: !!partial, entries, summary, unplaced, nodes, generated: made.length,
      context: context.filter((e) => involved.has(e.teacher_id)).map((e) => ({ grade_level: e.grade_level, classroom: e.classroom, subject: e.subject, teacher_id: e.teacher_id, room_name: e.room_name || '', weekday: e.weekday, period: e.period })),
      room_names: [...roomDisplay.values()].sort((a, b) => a.localeCompare(b, 'th')),
      warnings
    };
  }
  let nodes = 0;

  // ---- โหมดตรวจผลที่ทดลองจัด (apply): บันทึกเฉพาะสิ่งที่ผู้ใช้เห็นในผลทดลอง ----
  if (input.proposed) {
    const placed = [];
    for (const raw of input.proposed) {
      const e = raw && { ...raw, room_name: canonicalRoom(raw.room_name) };
      if (!e || !selected.has(key(e)) || !Number.isInteger(e.weekday) || e.weekday < 1 || e.weekday > 5 || !Number.isInteger(e.period) || e.period < 1 || e.period > 6) { errors.push('ผลทดลองจัดไม่ถูกต้อง'); continue; }
      if (locked.some((l) => same(l, e))) continue;
      const g = groups.get(groupKey(e));
      if (!g || g.rk !== rk(e) || e.period > periods[e.weekday - 1] || isReserved(e)) { errors.push(`ผลทดลองไม่ตรงภาระสอน: ${e.subject}`); continue; }
      if (!fits(g, e.weekday, e.period)) { errors.push(`ผลทดลองมีคาบชน: ${e.grade_level}/${e.classroom} ${e.subject}`); continue; }
      if (g.remaining < 1 || g.daily[e.weekday] + 1 > g.max_per_day) { errors.push(`ผลทดลองเกินภาระสอนหรือเพดานต่อวัน: ${e.subject}`); continue; }
      place(g, e.weekday, e.period, 1, 1);
      placed.push(...entriesOf(g, e.weekday, e.period, 1));
    }
    errors.push(...blockErrors([...locked, ...placed]));
    const missing = gList.some((g) => g.remaining > 0);
    if (missing && !partialAllowed) errors.push('ผลทดลองยังลงไม่ครบภาระสอน กรุณาทดลองจัดใหม่');
    if (errors.length) return { ok: false, errors: [...new Set(errors)] };
    return finish(placed, missing);
  }

  // ---- ตรวจล่วงหน้า: หาเหตุที่ "จัดไม่ได้แน่นอน" พร้อมบอกสาเหตุ ----
  // จำนวนคาบสูงสุดที่ยังลงได้ของวิชาหนึ่ง (ไม่คำนึงถึงวิชาอื่นในรอบนี้)
  function reach(g) {
    let total = 0;
    for (let d = 1; d <= 5; d++) {
      const room = Math.floor((g.max_per_day - g.daily[d]) / g.block_size); if (room < 1) continue;
      let blocks = 0;
      for (let p = 1; p + g.block_size - 1 <= periods[d - 1];) {
        let ok = lunchOk(p, g.block_size);
        for (let i = 0; ok && i < g.block_size; i++) ok = fits(g, d, p + i);
        if (ok) { blocks++; p += g.block_size; } else p++;
      }
      total += Math.min(room, blocks) * g.block_size;
    }
    return total;
  }
  const diagnostics = [], hard = [];
  for (const g of gList) {
    if (!g.remaining) continue;
    const can = reach(g);
    if (can < g.remaining) {
      const r = reasons(g);
      diagnostics.push({ grade_level: g.grade_level, classroom: g.classroom, subject: g.subject, teacher_id: g.teacher_id, needed: g.remaining, possible: can, reasons: r });
      hard.push(`${label(g)}: ต้องลงอีก ${g.remaining} คาบ แต่ลงได้สูงสุด ${can} คาบ — ${explain(g, r)}`);
    }
  }
  const byTeacher = new Map(), byRoom = new Map();
  for (const g of gList) {
    byTeacher.set(g.teacher_id, (byTeacher.get(g.teacher_id) || 0) + g.remaining);
    if (g.rk) byRoom.set(g.rk, (byRoom.get(g.rk) || 0) + g.remaining);
  }
  for (const [id, need] of byTeacher) {
    let free = 0, other = 0, off = 0; const t = grid(teacherBusy, id), b = grid(blocked, id);
    for (let d = 1; d <= 5; d++) for (let p = 1; p <= periods[d - 1]; p++) { const i = si(d, p); if (b[i]) off++; else if (t[i]) other++; else free++; }
    if (need > free) diagnostics.push({ teacher_id: id, needed: need, possible: free, reasons: { teacher_other: other, teacher_unavailable: off } });
    if (need > free) hard.push(`ครู ${teacherName(id)}: ต้องสอนอีก ${need} คาบในห้องที่เลือก แต่เหลือช่องว่าง ${free} คาบ (ติดสอนห้องอื่น ${other} · ไม่ว่าง ${off})`);
  }
  for (const [k, need] of byRoom) {
    let free = 0; const r = grid(roomBusy, k);
    for (let d = 1; d <= 5; d++) for (let p = 1; p <= periods[d - 1]; p++) if (!r[si(d, p)]) free++;
    if (need > free) diagnostics.push({ room_name: roomDisplay.get(k), needed: need, possible: free });
    if (need > free) hard.push(`ห้อง${roomDisplay.get(k)}: มีภาระที่ต้องใช้ห้อง ${need} คาบ แต่ห้องว่าง ${free} คาบ`);
  }
  if (hard.length && !partialAllowed) return { ok: false, errors: ['จัดไม่ได้ภายใต้เงื่อนไขนี้ — สาเหตุ:', ...hard], diagnostics };

  // ---- ค้นหาแบบย้อนรอย: เลือกวิชาที่ทางเลือกน้อยที่สุดก่อน แล้วเริ่มใหม่แบบสุ่มเมื่อหมดเวลารอบ ----
  function options(g, jitter) {
    const out = [];
    for (let d = 1; d <= 5; d++) {
      if (g.daily[d] + g.block_size > g.max_per_day) continue;
      for (let p = 1; p + g.block_size - 1 <= periods[d - 1]; p++) {
        if (!lunchOk(p, g.block_size)) continue;
        let ok = true;
        for (let i = 0; ok && i < g.block_size; i++) ok = fits(g, d, p + i);
        if (!ok) continue;
        const morning = p + g.block_size - 1 <= 3;
        const pref = g.prefer === 'morning' ? (morning ? 0 : 60) : g.prefer === 'afternoon' ? (morning ? 60 : 0) : (morning ? 8 : 0);
        out.push({ d, p, score: g.daily[d] * 1000 + pref + g.tday[d] * 20 + p + (jitter ? jitter() * 45 : 0) });
      }
    }
    return out.sort((a, b) => a.score - b.score);
  }
  function countOptions(g, limit) {
    let n = 0;
    for (let d = 1; d <= 5; d++) {
      if (g.daily[d] + g.block_size > g.max_per_day) continue;
      for (let p = 1; p + g.block_size - 1 <= periods[d - 1]; p++) {
        if (!lunchOk(p, g.block_size)) continue;
        let ok = true;
        for (let i = 0; ok && i < g.block_size; i++) ok = fits(g, d, p + i);
        if (ok && ++n >= limit) return n;
      }
    }
    return n;
  }
  const started = Date.now(), totalNeeded = gList.reduce((n, g) => n + g.remaining, 0);
  let best = [];
  const stack = [];
  function attempt(nodeLimit, deadline, jitter) {
    let timedOut = false;
    function search() {
      if (++nodes > nodeLimit || Date.now() > deadline) { timedOut = true; return false; }
      let chosen = null, chosenCount = Infinity;
      for (const g of gList) {
        if (!g.remaining) continue;
        const need = g.remaining / g.block_size;
        const n = countOptions(g, Math.max(need, Math.min(chosenCount, 31)) + 1);
        if (n < need) { g.fails++; return false; }
        if (n < chosenCount || (n === chosenCount && (g.fails > chosen.fails || (g.fails === chosen.fails && g.remaining > chosen.remaining)))) { chosen = g; chosenCount = n; }
      }
      if (!chosen) return true;
      for (const o of options(chosen, jitter)) {
        place(chosen, o.d, o.p, 1); stack.push({ g: chosen, d: o.d, p: o.p });
        if (stack.length > best.length) best = stack.slice();
        if (search()) return true;
        stack.pop(); place(chosen, o.d, o.p, 0);
        if (timedOut) return false;
      }
      chosen.fails++;
      return false;
    }
    return { solved: search(), timedOut };
  }
  let solved = !totalNeeded, exhausted = false;
  if (!hard.length && totalNeeded) {
    // รอบแรกแบบตายตัว จากนั้นเริ่มใหม่แบบสุ่ม (seed คงที่) โดยวิชาที่ติดบ่อยถูกจัดก่อน
    // รอบสั้นที่ขยายขึ้นเรื่อย ๆ หนีทางตันได้เร็วกว่ารอบยาวรอบเดียว
    let budget = Math.max(1, Math.min(maxNodes, 3000));
    let r = attempt(budget, started + maxMs, null);
    solved = r.solved;
    let seed = 1;
    while (!solved && r.timedOut && nodes < maxNodes && Date.now() < started + maxMs) {
      budget = Math.ceil(budget * 1.1);
      r = attempt(Math.min(maxNodes, nodes + budget), started + maxMs, rng(seed++ * 2654435761));
      solved = r.solved;
    }
    exhausted = !solved && r.timedOut;
  }
  if (solved) {
    const made = [];
    for (const s of stack) made.push(...entriesOf(s.g, s.d, s.p));
    return finish(made, false);
  }

  // สรุปวิชาที่ทำให้ค้นหาติดบ่อยที่สุด
  const stuck = gList.filter((g) => g.fails > 0).sort((a, b) => b.fails - a.fails).slice(0, 5);
  for (const g of stuck) diagnostics.push({ grade_level: g.grade_level, classroom: g.classroom, subject: g.subject, teacher_id: g.teacher_id, needed: g.remaining, failures: g.fails, reasons: reasons(g) });
  if (!partialAllowed) {
    const head = exhausted ? 'ค้นหาไม่ทันในรอบนี้ ลองลดจำนวนห้อง ผ่อนข้อจำกัด หรือเลือก "ลงเท่าที่ลงได้" ยังสรุปไม่ได้ว่าไม่มีคำตอบ' : 'จัดไม่ได้ภายใต้เงื่อนไขนี้ ตรวจคาบที่ล็อก เวลาครูไม่ว่าง และภาระสอน';
    const hints = stuck.slice(0, 3).map((g) => `ติดบ่อย: ${label(g)} — ${explain(g, reasons(g))}`);
    return { ok: false, errors: [head, ...hints], diagnostics, nodes };
  }

  // ---- โหมดลงเท่าที่ลงได้: เริ่มจากผลที่ไปได้ไกลที่สุด แล้วเติมที่เหลือแบบทีละช่อง ข้ามวิชาที่ไม่มีช่อง ----
  const made = [];
  for (const s of best) { place(s.g, s.d, s.p, 1); made.push(...entriesOf(s.g, s.d, s.p)); }
  const skip = new Set();
  for (;;) {
    let chosen = null, chosenCount = Infinity;
    for (const g of gList) {
      if (!g.remaining || skip.has(g)) continue;
      const n = countOptions(g, Math.min(chosenCount, 31) + 1);
      if (!n) { skip.add(g); continue; }
      if (n < chosenCount) { chosen = g; chosenCount = n; }
    }
    if (!chosen) break;
    const o = options(chosen, null)[0];
    place(chosen, o.d, o.p, 1); made.push(...entriesOf(chosen, o.d, o.p));
  }
  // ซ่อมแบบย้ายหนึ่งคาบ: ถ้าช่องที่วิชาค้างต้องการถูกวิชาอื่นของห้องเดียวกันใช้อยู่
  // ให้ย้ายคาบนั้นไปช่องว่างอื่นที่ถูกเงื่อนไข แล้วลงวิชาที่ค้างแทน (เฉพาะคาบเดี่ยวที่จัดในรอบนี้)
  for (let progress = true; progress;) {
    progress = false;
    for (const g of gList) {
      if (!g.remaining || g.block_size !== 1) continue;
      for (let d = 1; d <= 5 && g.remaining; d++) {
        if (g.daily[d] + 1 > g.max_per_day) continue;
        for (let p = 1; p <= periods[d - 1] && g.remaining && g.daily[d] + 1 <= g.max_per_day; p++) {
          const i = si(d, p);
          if (!g.cls[i] || g.tch[i] || g.blk[i] || (g.room && g.room[i])) continue;
          const x = made.find((e) => key(e) === key(g) && e.weekday === d && e.period === p);
          const h = x && groups.get(groupKey(x));
          if (!h || h.block_size !== 1) continue;
          place(h, d, p, 0, 1);
          let to = null;
          for (let d2 = 1; d2 <= 5 && !to; d2++) {
            if (d2 !== d && h.daily[d2] + 1 > h.max_per_day) continue;
            for (let p2 = 1; p2 <= periods[d2 - 1]; p2++) if ((d2 !== d || p2 !== p) && fits(h, d2, p2) && fits(g, d, p)) { to = [d2, p2]; break; }
          }
          if (!to || (to[0] !== d && h.daily[to[0]] + 1 > h.max_per_day)) { place(h, d, p, 1, 1); continue; }
          place(h, to[0], to[1], 1, 1); x.weekday = to[0]; x.period = to[1];
          if (fits(g, d, p)) { place(g, d, p, 1, 1); made.push(...entriesOf(g, d, p, 1)); progress = true; }
          else { place(h, to[0], to[1], 0, 1); x.weekday = d; x.period = p; place(h, d, p, 1, 1); }
        }
      }
    }
  }
  return finish(made, true, hard);
}
