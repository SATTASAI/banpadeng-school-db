// นำเข้ารายชื่อนักเรียน (ระบบเกรด) แล้วข้อมูลไม่ตรงหลายช่อง → แจ้งผู้ดูแลระบบที่กระดิ่งและจุดงานค้างของ system
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,call} from './notifications.test.mjs';

test('pending student-match reviews from the grade system alert superadmins only (bell + red dot), without student names',async()=>{
 const env=await fixture();await call(env,'/api/overview');
 env.raw.exec(`CREATE TABLE gr_student_match_reviews (id INTEGER PRIMARY KEY, academic_year_id INTEGER, source TEXT, row_key TEXT, payload TEXT, candidates TEXT,
  status TEXT, resolved_student_id INTEGER, created_by INTEGER, created_at TEXT DEFAULT (datetime('now')), resolved_by INTEGER, resolved_at TEXT);
  INSERT INTO gr_student_match_reviews (id, academic_year_id, row_key, payload, candidates, status, created_by) VALUES
  (1, 1, 'k', '{"code":"12345","first":"ชื่อจริง","last":"นามสกุลจริง"}', '[]', 'pending', 2),
  (2, 1, 'k2', '{"code":"999"}', '[]', 'dismissed', 2);`);
 const admin=await (await call(env,'/api/notifications')).json();
 const alert=admin.notifications.find(n=>n.message_key==='student-match:1');
 assert.ok(alert,'superadmin sees the alert');
 assert.match(alert.message,/12345/);assert.doesNotMatch(alert.message,/ชื่อจริง/);
 assert.equal(alert.url,'https://grades.banpadengschool.ac.th/admin.html#matches');
 assert.ok(!admin.notifications.some(n=>n.message_key==='student-match:2'));
 const teacher=await (await call(env,'/api/notifications','GET',undefined,2)).json();
 assert.ok(!teacher.notifications.some(n=>String(n.message_key).startsWith('student-match:')));
 const work=await (await call(env,'/api/pending-work')).json();
 assert.equal(work.items.find(i=>i.key==='student-match')?.count,1);
 const tw=await (await call(env,'/api/pending-work','GET',undefined,2)).json();
 assert.ok(!tw.items.some(i=>i.key==='student-match'));
});
