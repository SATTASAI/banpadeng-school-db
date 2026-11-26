// จัดนักเรียนเข้าฐานการเรียนรู้อัตโนมัติ (ฟังก์ชันล้วน ไม่แตะฐานข้อมูล — ทดสอบได้)
// students: [{id, grade, room, gender:'M'|'F'|'', prev_base_name?}]
// bases:    [{id, name, capacity:null|number, grades:[1..6]}]
// fixed:    Map(student_id → base_id) ที่คงไว้ (คนที่จัดเอง/คนที่มีฐานแล้วเมื่อจัดเฉพาะคนที่ยังไม่มีฐาน) — นับเป็นที่นั่งที่ใช้แล้ว
// คืน { assignments: Map(student_id → base_id), unplaced: [student_id] }

export const ASSIGN_METHODS = {
  balanced: "คละชั้น ห้อง และเพศ ให้ทุกฐานเท่ากัน",
  random: "สุ่มเท่ากันทุกฐาน (ไม่สนชั้น/ห้อง)",
  by_grade: "ชั้นเดียวกันอยู่ฐานเดียวกันมากที่สุด",
  whole_room: "ทั้งห้องเข้าฐานเดียวกัน (ห้องใหญ่เกินที่รับแบ่งไปฐานถัดไป)",
  keep_previous: "คงฐานเดิมจากปีก่อน แล้วคละคนที่เหลือ",
};

export function seededRandom(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function shuffle(list, rand) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export function assignLearningBases({ students, bases, fixed = new Map(), method = "balanced", seed = 1 }) {
  if (!ASSIGN_METHODS[method]) throw new Error("วิธีจัดไม่ถูกต้อง");
  const rand = seededRandom(seed);
  const pool = students.filter((s) => !fixed.has(s.id));
  const state = new Map(bases.map((b) => [b.id, { base: b, count: 0, grade: new Map(), room: new Map(), gender: new Map() }]));
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  const studentById = new Map(students.map((s) => [s.id, s]));
  for (const [sid, bid] of fixed) {
    const st = state.get(bid); if (!st) continue;
    const s = studentById.get(sid); st.count++;
    if (s) { bump(st.grade, s.grade); bump(st.room, `${s.grade}|${s.room}`); bump(st.gender, s.gender); }
  }
  // เป้าหมายต่อฐาน: ใช้จำนวนรับถ้ากำหนด ไม่กำหนด = เฉลี่ยทั้งหมดต่อฐาน (ไว้เทียบความเต็ม)
  const total = students.length;
  const avg = Math.max(1, Math.ceil(total / Math.max(1, bases.length)));
  const cap = (b) => (Number.isInteger(b.capacity) && b.capacity > 0 ? b.capacity : Infinity);
  const target = (b) => (cap(b) === Infinity ? avg : cap(b));
  const eligible = (s) => bases.filter((b) => b.grades.includes(s.grade) && state.get(b.id).count < cap(b));
  const assignments = new Map(), unplaced = [];
  const place = (s, b) => {
    const st = state.get(b.id); st.count++; bump(st.grade, s.grade); bump(st.room, `${s.grade}|${s.room}`); bump(st.gender, s.gender);
    assignments.set(s.id, b.id);
  };
  const tie = new Map(bases.map((b) => [b.id, rand()]));
  const load = (b) => state.get(b.id).count / target(b);
  // เลือกฐานที่ค่าน้อยสุดตามลำดับเกณฑ์ (ค่าเท่ากันใช้ลำดับสุ่มประจำฐาน)
  const pick = (options, keys) => options.slice().sort((x, y) => {
    for (const k of keys) { const d = k(x) - k(y); if (d) return d; }
    return tie.get(x.id) - tie.get(y.id);
  })[0];

  const balancedPlace = (list) => {
    // เรียงคละ: แยกตามชั้น→ห้อง→เพศ แล้วสลับลำดับในกลุ่ม เพื่อให้แต่ละกลุ่มกระจายไปทุกฐาน
    const groups = new Map();
    for (const s of list) { const k = `${s.grade}|${s.room}|${s.gender}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); }
    const ordered = [...groups.keys()].sort().flatMap((k) => shuffle(groups.get(k), rand));
    for (const s of ordered) {
      const options = eligible(s);
      if (!options.length) { unplaced.push(s.id); continue; }
      const st = (b) => state.get(b.id);
      place(s, pick(options, [
        (b) => Math.floor(load(b) * 1000),
        (b) => st(b).room.get(`${s.grade}|${s.room}`) || 0,
        (b) => st(b).grade.get(s.grade) || 0,
        (b) => st(b).gender.get(s.gender) || 0,
      ]));
    }
  };

  if (method === "balanced") balancedPlace(pool);
  else if (method === "random") {
    for (const s of shuffle(pool, rand)) {
      const options = eligible(s);
      if (!options.length) { unplaced.push(s.id); continue; }
      place(s, pick(shuffle(options, rand), [(b) => Math.floor(load(b) * 1000)]));
    }
  } else if (method === "by_grade") {
    // เติมทีละชั้น: ฐานที่มีชั้นนั้นมากอยู่แล้วได้ก่อน จนเต็มเป้า จึงไปฐานถัดไป
    const ordered = [...pool].sort((a, b) => a.grade - b.grade || String(a.room).localeCompare(String(b.room), "th", { numeric: true }) || (rand() - 0.5));
    for (const s of ordered) {
      const options = eligible(s);
      if (!options.length) { unplaced.push(s.id); continue; }
      const notFull = options.filter((b) => state.get(b.id).count < target(b));
      const list = notFull.length ? notFull : options;
      const same = (b) => state.get(b.id).grade.get(s.grade) || 0;
      place(s, pick(list, [
        (b) => -same(b),                                         // ฐานที่มีชั้นนี้อยู่แล้ว
        (b) => (same(b) || !state.get(b.id).count ? 0 : 1),      // ไม่งั้นเปิดฐานว่างใหม่
        (b) => Math.floor(load(b) * 1000),
      ]));
    }
  } else if (method === "whole_room") {
    const rooms = new Map();
    for (const s of pool) { const k = `${s.grade}|${s.room}`; if (!rooms.has(k)) rooms.set(k, []); rooms.get(k).push(s); }
    const ordered = [...rooms.values()].sort((a, b) => b.length - a.length || (rand() - 0.5));
    for (const room of ordered) {
      let rest = shuffle(room, rand);
      while (rest.length) {
        const options = eligible(rest[0]);
        if (!options.length) { unplaced.push(...rest.map((s) => s.id)); break; }
        // ฐานที่เหลือที่ว่างมากสุด (ไม่กำหนดจำนวนรับ = ฐานที่คนน้อยสุด)
        const b = pick(options, [(x) => state.get(x.id).count - target(x), (x) => Math.floor(load(x) * 1000)]);
        const room_left = cap(b) === Infinity ? rest.length : cap(b) - state.get(b.id).count;
        rest.slice(0, room_left).forEach((s) => place(s, b));
        rest = rest.slice(room_left);
      }
    }
  } else if (method === "keep_previous") {
    const byName = new Map(bases.map((b) => [String(b.name).trim(), b]));
    const rest = [];
    for (const s of pool) {
      const b = byName.get(String(s.prev_base_name || "").trim());
      if (b && b.grades.includes(s.grade) && state.get(b.id).count < cap(b)) place(s, b); else rest.push(s);
    }
    balancedPlace(rest);
  }
  // ซ่อมคนที่ยังไม่มีที่: ย้ายคนในฐานที่เต็ม (ที่รับชั้นของคนนี้) ไปฐานอื่นที่ยังว่างและรับชั้นของเขา แล้วใส่คนนี้แทน
  const unplace = (s, bid) => {
    const st = state.get(bid); st.count--; st.grade.set(s.grade, st.grade.get(s.grade) - 1);
    const rk = `${s.grade}|${s.room}`; st.room.set(rk, st.room.get(rk) - 1); st.gender.set(s.gender, st.gender.get(s.gender) - 1);
    assignments.delete(s.id);
  };
  const still = [];
  for (const sid of unplaced) {
    const s = studentById.get(sid);
    let done = false;
    for (const b of bases.filter((x) => x.grades.includes(s.grade))) {
      for (const [tid, bid] of assignments) {
        if (bid !== b.id) continue;
        const t = studentById.get(tid);
        const to = bases.find((c) => c.id !== b.id && c.grades.includes(t.grade) && state.get(c.id).count < cap(c));
        if (!to) continue;
        unplace(t, b.id); place(t, to); place(s, b); done = true; break;
      }
      if (done) break;
    }
    if (!done) still.push(sid);
  }
  return { assignments, unplaced: still };
}
