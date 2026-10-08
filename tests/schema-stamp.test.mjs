// ตั้งค่าโครงสร้างฐานข้อมูลครั้งเดียวต่อ deploy: instance ถัดไปไม่ต้องรันคำสั่งตั้งค่าซ้ำ (เดิมคำขอแรกช้า 20–25 วินาที)
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,call} from './notifications.test.mjs';

test('บันทึกเวอร์ชันของ deploy หลังตั้งค่าเสร็จ',async()=>{
 const env=await fixture();
 env.raw.exec('CREATE TABLE IF NOT EXISTS system_settings(setting_key TEXT PRIMARY KEY,setting_value TEXT,updated_by INTEGER,updated_at TEXT)');
 env.CF_VERSION_METADATA={id:'version-a'};
 assert.equal((await call(env,'/api/students')).status,200);
 assert.equal(env.raw.prepare("SELECT setting_value v FROM system_settings WHERE setting_key='registry_schema_version'").get().v,'version-a');
});
