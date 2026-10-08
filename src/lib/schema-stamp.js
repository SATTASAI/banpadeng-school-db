// ตั้งค่าโครงสร้างฐานข้อมูล (สร้างตาราง/trigger/index) เพียงครั้งเดียวต่อการ deploy
// เดิมทุก instance ใหม่ของ Worker ต้องรันคำสั่งตั้งค่า ~140 คำสั่งก่อนตอบ API แรก — แต่ละคำสั่งวิ่งไปฐานข้อมูลที่สิงคโปร์
// และหลาย instance แย่งล็อกกัน ทำให้คำขอแรกช้า 20–25 วินาที (หน้าเว็บเหมือนโหลดไม่ขึ้น)
// ตอนนี้: instance แรกของ deploy ใหม่ตั้งค่าแล้วบันทึกรหัสเวอร์ชันไว้ instance ต่อไปเช็ก 1 คำสั่งแล้วข้าม
// ไม่มี binding CF_VERSION_METADATA (เช่น ตอนทดสอบ) → ตั้งค่าทุกครั้งเหมือนเดิม
const KEY = "registry_schema_version";
let current;

export function deployVersion(env) {
  return env?.CF_VERSION_METADATA?.id || null;
}

export function schemaIsCurrent(env) {
  const version = deployVersion(env);
  if (!version) return Promise.resolve(false);
  current ||= env.DB.prepare("SELECT setting_value FROM system_settings WHERE setting_key = ?").bind(KEY).first()
    .then((row) => row?.setting_value === version)
    .catch(() => false);
  return current;
}

export async function markSchemaCurrent(env) {
  const version = deployVersion(env);
  if (!version || await schemaIsCurrent(env)) return;
  await env.DB.prepare(
    `INSERT INTO system_settings (setting_key, setting_value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at`
  ).bind(KEY, version).run().catch(() => {});
  current = Promise.resolve(true);
}
