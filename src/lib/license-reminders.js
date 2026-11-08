// KSP Self-Service: official online renewal service.
export const LICENSE_RENEWAL_URL = 'https://selfservice.ksp.or.th/';
export const isLicenseReminder = (key) => String(key || '').startsWith('license:');

// A fresh key per Bangkok calendar day, shared by all logins of one person.
// Read receipts do not cancel delivery; a renewed expiry removes the next reminder.
// `now` is bound (UTC), making the 08:00 boundary deterministic in tests.
export function licenseReminderQuery(userId, hasAccounts, now = 'now') {
  const owner = hasAccounts
    ? '(p.user_id=me.id OR EXISTS(SELECT 1 FROM personnel_accounts pa WHERE pa.personnel_id=p.id AND pa.user_id=me.id))'
    : 'p.user_id=me.id';
  return {
    sql: `SELECT 'license:'||p.id||':'||date(clock.local_now), 'ต่ออายุใบประกอบวิชาชีพ',
      'ใบประกอบวิชาชีพของคุณหมดอายุวันที่ '||p.license_expiry_date||' · '||
      CASE WHEN date(p.license_expiry_date)<date(clock.local_now)
        THEN 'หมดอายุแล้ว '||CAST(julianday(date(clock.local_now))-julianday(p.license_expiry_date) AS INTEGER)||' วัน'
        WHEN date(p.license_expiry_date)=date(clock.local_now) THEN 'หมดอายุวันนี้'
        ELSE 'เหลือ '||CAST(julianday(p.license_expiry_date)-julianday(date(clock.local_now)) AS INTEGER)||' วัน' END||
      char(10)||'ต่ออายุ: ${LICENSE_RENEWAL_URL}'||char(10)||'หลังต่ออายุ กรุณาอัปเดตวันหมดอายุในบัญชีและความปลอดภัย → ข้อมูลส่วนตัว',
      datetime(date(clock.local_now)||' 08:00:00','-7 hours'), '/account.html', NULL, NULL, 1
      FROM personnel_records p JOIN (SELECT datetime(?,'+7 hours') local_now) clock JOIN users me ON me.id=?
      WHERE ${owner} AND me.status='active' AND me.deleted_at IS NULL AND me.role IS NOT NULL
        AND p.status='active' AND COALESCE(p.employment_status,'working')='working'
        AND p.license_expiry_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        AND date(p.license_expiry_date,'+0 days')=p.license_expiry_date
        AND julianday(p.license_expiry_date)-julianday(date(clock.local_now))<90
        AND time(clock.local_now)>='08:00:00'`,
    values: [now, userId],
  };
}
