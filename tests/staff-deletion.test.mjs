// ลบข้อมูลบุคลากร: เฉพาะผู้ดูแลระบบ · soft delete ไม่ให้ระบบสร้างคืนเองจากบัญชีผู้ใช้ · กู้คืนพร้อมฝ่ายงานเดิม
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,call} from './notifications.test.mjs';

test('ผู้ดูแลระบบลบบุคลากร แล้วกู้คืนได้ · ครูลบไม่ได้',async()=>{
 const env=await fixture();
 const json=async(r)=>({status:r.status,data:await r.json().catch(()=>null)});
 const api=async(path,method='GET',body,user=1)=>json(await call(env,path,method,body,user));
 const before=(await api('/api/staff')).data.staff;
 const target=before.find(p=>p.user_id===3);
 assert.ok(target,'บัญชีครูมีทะเบียนบุคลากร');
 env.raw.exec(`CREATE TABLE IF NOT EXISTS department_staff(department TEXT NOT NULL,personnel_id INTEGER NOT NULL,photo BLOB,photo_type TEXT,photo_version INTEGER NOT NULL DEFAULT 0,updated_by INTEGER,updated_at TEXT NOT NULL DEFAULT(datetime('now')),is_head INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(department,personnel_id))`);
 env.raw.prepare("INSERT INTO department_staff(department,personnel_id,is_head) VALUES('academic',?,1)").run(target.id);

 assert.equal((await api(`/api/staff/${target.id}`,'DELETE',{},2)).status,403);
 const del=await api(`/api/staff/${target.id}`,'DELETE',{});
 assert.equal(del.status,200);
 assert.equal(del.data.account_email,'co@test','แจ้งว่าบัญชีเข้าสู่ระบบยังใช้งานได้');
 assert.ok(!(await api('/api/staff')).data.staff.some(p=>p.id===target.id));
 assert.equal(env.raw.prepare('SELECT COUNT(*) n FROM department_staff WHERE personnel_id=?').get(target.id).n,0);
 assert.equal((await api(`/api/staff/${target.id}`,'DELETE',{})).status,404);

 // ระบบจับคู่บัญชีผู้ใช้กับทะเบียนบุคลากร (รันใหม่ทุก instance) ต้องไม่สร้างคนที่ลบแล้วกลับมา
 const fresh={...env,DB:{prepare:env.DB.prepare,batch:env.DB.batch}};
 const again=await (await call(fresh,'/api/staff')).json();
 assert.ok(!again.staff.some(p=>p.user_id===3),'ไม่สร้างทะเบียนใหม่ให้บัญชีของคนที่ลบแล้ว');

 const deleted=(await api('/api/staff/deleted')).data.staff;
 assert.deepEqual(deleted.map(p=>p.id),[target.id]);
 assert.equal((await api('/api/staff/deleted','GET',undefined,2)).status,403);
 assert.equal((await api(`/api/staff/${target.id}/restore`,'POST',{})).status,200);
 assert.ok((await api('/api/staff')).data.staff.some(p=>p.id===target.id));
 assert.equal(env.raw.prepare('SELECT is_head FROM department_staff WHERE personnel_id=?').get(target.id).is_head,1,'คืนฝ่ายงานและตำแหน่งหัวหน้าเดิม');
 assert.equal((await api(`/api/staff/${target.id}/restore`,'POST',{})).status,409);
});
