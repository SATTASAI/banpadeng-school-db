// เจ้าหน้าที่การเงิน: ผู้รับผิดชอบฝ่ายการเงิน (finance_review) + เจ้าหน้าที่การเงินเพิ่มเติม 2 ตำแหน่ง
// ทั้งสามมีสิทธิ์เท่ากันทุกอย่าง — ลงนามขั้นฝ่ายการเงินตรวจสอบ บันทึกจ่าย แก้ยอด และรับแจ้งเตือน ทำแทนกันได้
export const FINANCE_ROLES = { finance_staff_1: "เจ้าหน้าที่การเงิน 1", finance_staff_2: "เจ้าหน้าที่การเงิน 2" };
export const FINANCE_ROLE_KEYS = ["finance_review", ...Object.keys(FINANCE_ROLES)];
export const FINANCE_ROLE_SQL = `(${FINANCE_ROLE_KEYS.map((k) => `'${k}'`).join(",")})`;

export async function isFinanceMember(env, userId) {
  if (!userId) return false;
  return Boolean(await env.DB.prepare(`SELECT 1 FROM budget_role_assignments a JOIN users u ON u.id=a.user_id
    WHERE a.role_key IN ${FINANCE_ROLE_SQL} AND a.department='' AND a.user_id=? AND u.status='active' AND u.deleted_at IS NULL`).bind(userId).first());
}
