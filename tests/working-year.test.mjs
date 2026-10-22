import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {workingFiscalYear,calendarFiscalYear} from '../src/lib/project-finance.js';

function env(sql){const raw=new DatabaseSync(':memory:');raw.exec(`CREATE TABLE academic_years(id INTEGER PRIMARY KEY,year_be INTEGER,status TEXT);
 CREATE TABLE projects(id INTEGER PRIMARY KEY,fiscal_year INTEGER,academic_year_id INTEGER,status TEXT);${sql}`);
 return {DB:{prepare(q){let v=[];return{bind(...a){v=a;return this},async first(){return raw.prepare(q).get(...v)||null}}}}};}

test('calendar fiscal year rolls over on 1 October (Bangkok)',()=>{
 assert.equal(calendarFiscalYear('2026-09-30'),2569);assert.equal(calendarFiscalYear('2026-10-01'),2570);assert.equal(calendarFiscalYear('2027-03-31'),2570);
});
test('projects of the current academic year stay the default year through semester 2',async()=>{
 // ปีการศึกษา 2569 (พ.ค. 69–มี.ค. 70) โครงการทั้งหมดเป็นปีงบ 2569 แม้ปฏิทินจะเป็น 2570 แล้ว
 assert.equal(await workingFiscalYear(env(`INSERT INTO academic_years VALUES(1,2569,'active');INSERT INTO projects VALUES(1,2569,1,'ongoing'),(2,2570,1,'ongoing');`)),2569);
 // ไม่มีโครงการที่ตรงกับปีการศึกษา → ใช้ปีล่าสุดของโครงการในปีการศึกษานั้น
 assert.equal(await workingFiscalYear(env(`INSERT INTO academic_years VALUES(1,2569,'active');INSERT INTO projects VALUES(1,2568,1,'ongoing');`)),2568);
 // ยกเลิกแล้วไม่นับ / ยังไม่มีโครงการ → ปฏิทิน
 assert.equal(await workingFiscalYear(env(`INSERT INTO academic_years VALUES(1,2569,'active');INSERT INTO projects VALUES(1,2569,1,'cancelled');`)),calendarFiscalYear());
 assert.equal(await workingFiscalYear({DB:{prepare(){throw new Error('no such table')}}}),calendarFiscalYear());
});
