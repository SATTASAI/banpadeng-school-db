import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,call} from './notifications.test.mjs';
import {seedLeaveCalendar} from './leave-calendar.mjs';
import {workingDays,effectiveLeaveDays,leaveCalendar} from '../src/lib/leave-working-days.js';
import {ensureLeaveData} from '../src/lib/leave-data.js';
import {dashboardActivitySummary} from '../src/lib/dashboard-summary.js';
import {leaveStatistics} from '../src/lib/personnel-stats.js';

test('weekends, official/substitute holidays and cross-year periods use working days; half days survive',()=>{
 assert.equal(workingDays('2026-11-06','2026-11-09'),2);
 assert.equal(workingDays('2026-11-07','2026-11-08'),0);
 assert.equal(workingDays('2026-10-22','2026-10-26'),2);
 assert.equal(workingDays('2026-12-04','2026-12-08'),2); // Monday substitute
 assert.equal(workingDays('2026-12-30','2027-01-04'),2);
 assert.equal(workingDays('2026-11-06','2026-11-09',['2026-11-09']),1);
 const row={start_date:'2026-11-06',end_date:'2026-11-09',leave_days:4};
 assert.equal(effectiveLeaveDays(row),2);
 assert.equal(effectiveLeaveDays({...row,leave_days:3.5}),1.5);
 assert.equal(effectiveLeaveDays({...row,leave_days:0.5}),0.5);
 assert.equal(effectiveLeaveDays(row,[],'2026-11-07','2026-11-08'),0);
 assert.equal(effectiveLeaveDays(row,[],'2026-11-09','2026-11-09'),1);
});

test('school holidays exclude activity dates, deduplicate dates and support old calendar schemas',async()=>{
 const env=await fixture();
 assert.deepEqual(await leaveCalendar(env),[]);
 env.raw.exec(`CREATE TABLE gr_holidays(academic_year_id INTEGER,holiday_date TEXT,kind TEXT);
 INSERT INTO gr_holidays VALUES(1,'2026-11-09','holiday'),(2,'2026-11-09','holiday'),(1,'2026-11-10','activity');`);
 assert.equal(workingDays('2026-11-06','2026-11-10',await leaveCalendar(env)),2);
 env.raw.exec('ALTER TABLE gr_holidays DROP COLUMN kind');
 assert.equal(workingDays('2026-11-06','2026-11-10',await leaveCalendar(env)),1);
});

test('API enforces working days and old requests match forms, lists, dashboard and staff statistics without rewriting history',async()=>{
 const env=await fixture();await ensureLeaveData(env);seedLeaveCalendar(env);
 env.raw.exec(`CREATE TABLE gr_holidays(holiday_date TEXT,kind TEXT); INSERT INTO gr_holidays VALUES('2026-11-09','holiday');`);
 const preview=await call(env,'/api/leave-working-days?start=2026-11-06&end=2026-11-10','GET',undefined,2);
 assert.equal((await preview.json()).working_days,2);
 for(const date of ['bad','2026-02-30'])assert.equal((await call(env,'/api/leave-working-days?start='+date+'&end=2026-11-10','GET',undefined,2)).status,400);
 const form={leave_type:'sick',reason:'ทดสอบ',position:'ครู',contact_address:'บ้านพัก',contact_phone:'0000000000',start_date:'2026-11-06',end_date:'2026-11-10'};
 assert.equal((await call(env,'/api/leave-requests','POST',{...form,leave_days:5},2)).status,400);
 assert.equal((await call(env,'/api/leave-requests','POST',{...form,start_date:'2026-11-07',end_date:'2026-11-08'},2)).status,400);
 const submitted=await call(env,'/api/leave-requests','POST',form,2);assert.equal(submitted.status,201);
 const {id}=await submitted.json();assert.equal(env.raw.prepare('SELECT leave_days FROM leave_requests WHERE id=?').get(id).leave_days,2);
 env.raw.prepare("UPDATE leave_requests SET status='approved',workflow_stage='completed',leave_days=5 WHERE id=?").run(id);
 const list=await (await call(env,'/api/leave-requests','GET',undefined,2)).json();assert.equal(list.leave_requests.find(r=>r.id===id).leave_days,2);
 const detail=await (await call(env,'/api/leave-requests/'+id,'GET',undefined,2)).json();assert.equal(detail.leave_request.leave_days,2);
 assert.equal((await dashboardActivitySummary(env,2570)).leave_summary.approved_days,2);
 assert.equal((await leaveStatistics(env,{fiscalYear:2570})).summary.approved_days,2);
 assert.equal(env.raw.prepare('SELECT leave_days FROM leave_requests WHERE id=?').get(id).leave_days,5);
 env.raw.exec("INSERT INTO gr_holidays VALUES('2026-11-10','holiday')");
 assert.equal((await dashboardActivitySummary(env,2570)).leave_summary.approved_days,1);
});
