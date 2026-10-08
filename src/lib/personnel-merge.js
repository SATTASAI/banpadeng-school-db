// These identities were explicitly confirmed by the school administrator.
const CONFIRMED_NAMES = [
  'จิราพร สุขวงศ์', 'ประทุม ทองมี', 'ปิยลักษณ์ เอมรื่น', 'รพีภรณ์ สร้อยดอกไม้',
  'ราชาวดี สังข์ทอง', 'วรรณมาศ จันทร์ชัง',
  // 8 ต.ค. 2569: ผู้ดูแลระบบยืนยันให้รวม (สมัครเองพิมพ์นามสกุลผิด / มี 2 บัญชี — ผู้ดูแลระบบกับครู)
  'นางสาวผกาแก้ว จงเจริญ', 'นายศตวรรต อิ่มเจริญ',
];
export function personnelIdentity(value) {
  const cleaned = String(value || '').normalize('NFC').replace(/[\u200b-\u200f\u2060\ufeff\s.]+/g, '').toLowerCase();
  const corrected = cleaned.replace(/^นางสานางสาวราชาวดีสังขสังข์ทอง$/, 'ราชาวดีสังข์ทอง')
    .replace(/^นางสาววรรวรรณมาศจันทร์ชัง$/, 'วรรณมาศจันทร์ชัง')
    .replace(/^นางสาวผกาแก้วจงจงเจริญ$/, 'ผกาแก้วจงเจริญ');
  return corrected.replace(/^(?:ว่าที่ร้อยตรีหญิง|ว่าที่รตหญิง|ว่าที่ร้อยตรี|ว่าที่รต|นางสาว|นาง|นาย)/, '');
}
// เดิมแยก "ศตวรรต อิ่มเจริญ" ไว้ 2 รายการ — ผู้ดูแลระบบยืนยันให้รวมแล้ว (8 ต.ค. 2569) จึงไม่มีชื่อที่ต้องแยกอีก
export function keepPersonnelSeparate() {
  return false;
}
export async function ensurePersonnelAccounts(env) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS personnel_accounts (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      personnel_id INTEGER NOT NULL REFERENCES personnel_records(id))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS personnel_merges (
      duplicate_id INTEGER PRIMARY KEY REFERENCES personnel_records(id),
      personnel_id INTEGER NOT NULL REFERENCES personnel_records(id),
      original_record TEXT NOT NULL, merged_at TEXT NOT NULL DEFAULT(datetime('now')))`),
    env.DB.prepare(`INSERT OR IGNORE INTO personnel_accounts(user_id,personnel_id)
      SELECT user_id,id FROM personnel_records WHERE user_id IS NOT NULL AND status='active'`),
  ]);
}
export async function mergeConfirmedPersonnel(env) {
  await ensurePersonnelAccounts(env);
  const { results: people } = await env.DB.prepare("SELECT * FROM personnel_records WHERE status='active'").all();
  const { results: tables } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  const hasDepartments = tables.some(row => row.name === 'department_staff');
  let merged = 0;
  for (const name of CONFIRMED_NAMES) {
    const matches = people.filter(row => personnelIdentity(row.full_name) === personnelIdentity(name));
    if (matches.length < 2) continue;
    // Keep the imported identity (and its stable ID/license fields); keep all accounts linked.
    const keeper = [...matches].sort((a,b) => Number(!!b.license_expiry_date)-Number(!!a.license_expiry_date) || a.id-b.id)[0];
    const profile = [...matches].sort((a,b) => Number(!!b.phone)+Number(!!b.position)+Number(!!b.departments)
      -Number(!!a.phone)-Number(!!a.position)-Number(!!a.departments) || b.id-a.id)[0];
    const fields = ['email','personnel_type','position_number','position','academic_rank','subjects','phone',
      'homeroom_classroom','departments','responsible_projects','teaching_periods','appointment_date',
      'service_start_date','education_level','major','institution','employment_status','retirement_date'];
    const values = fields.map(key => profile[key] ?? keeper[key] ?? matches.find(row=>row[key]!=null)?.[key] ?? null);
    const account = keeper.user_id || profile.user_id || matches.find(row=>row.user_id)?.user_id || null;
    const statements = [env.DB.prepare(`UPDATE personnel_records SET user_id=?,full_name=?,
      ${fields.map(key=>`${key}=?`).join(',')},updated_at=datetime('now') WHERE id=?`)
      .bind(account, name, ...values, keeper.id)];
    for (const duplicate of matches.filter(row=>row.id!==keeper.id)) {
      const memberships = hasDepartments ? (await env.DB.prepare('SELECT department,is_head FROM department_staff WHERE personnel_id=?').bind(duplicate.id).all()).results : [];
      statements.push(env.DB.prepare(`INSERT OR IGNORE INTO personnel_merges(duplicate_id,personnel_id,original_record)
        VALUES(?,?,?)`).bind(duplicate.id,keeper.id,JSON.stringify({...duplicate, department_heads:memberships.filter(row=>row.is_head).map(row=>row.department)})));
      if (duplicate.user_id) statements.push(env.DB.prepare(`INSERT INTO personnel_accounts(user_id,personnel_id)
        VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET personnel_id=excluded.personnel_id`).bind(duplicate.user_id,keeper.id));
      if (hasDepartments) {
        // Preserve the archived member/photo row; move its head flag to the visible canonical member.
        statements.push(env.DB.prepare(`INSERT INTO department_staff(department,personnel_id,photo,photo_type,photo_version,updated_by,is_head)
          SELECT department,?,photo,photo_type,photo_version,updated_by,0 FROM department_staff WHERE personnel_id=?
          ON CONFLICT(department,personnel_id) DO UPDATE SET
            photo=COALESCE(department_staff.photo,excluded.photo),
            photo_type=COALESCE(department_staff.photo_type,excluded.photo_type),
            photo_version=MAX(department_staff.photo_version,excluded.photo_version)`)
          .bind(keeper.id,duplicate.id));
        statements.push(env.DB.prepare('UPDATE department_staff SET is_head=0 WHERE personnel_id=? AND is_head=1').bind(duplicate.id));
        for (const member of memberships.filter(row=>row.is_head)) statements.push(env.DB.prepare('UPDATE department_staff SET is_head=1 WHERE personnel_id=? AND department=?').bind(keeper.id,member.department));
      }
      const references = [ ['timetable_entries','teacher_id'], ['substitute_absences','teacher_id'],
        ['substitute_assignments','substitute_teacher_id'], ['academic_teaching_assignments','personnel_id'] ];
      for (const [table,column] of references) {
        if (tables.some(row=>row.name===table)) statements.push(env.DB.prepare(
          `UPDATE OR IGNORE ${table} SET ${column}=? WHERE ${column}=?`).bind(keeper.id,duplicate.id));
      }
      statements.push(env.DB.prepare("UPDATE personnel_records SET status='inactive',user_id=NULL,updated_at=datetime('now') WHERE id=?").bind(duplicate.id));
      merged++;
    }
    // Release unique user_id from duplicate rows before assigning it to the keeper.
    const keeperUpdate = statements.shift();
    statements.push(keeperUpdate);
    if (account) statements.push(env.DB.prepare(`INSERT INTO personnel_accounts(user_id,personnel_id) VALUES(?,?)
      ON CONFLICT(user_id) DO UPDATE SET personnel_id=excluded.personnel_id`).bind(account,keeper.id));
    await env.DB.batch(statements);
  }
  return merged;
}
