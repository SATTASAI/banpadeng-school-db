import test from 'node:test';
import assert from 'node:assert/strict';
import {handleTimetableSyncRoute} from '../src/routes/timetable-sync.js';

function envFixture(){
  const period={academic_year_id:1,year_be:2569,year_label:'ปีการศึกษา 2569',year_status:'active',
    academic_term_id:11,term_number:1,term_name:'ภาคเรียนที่ 1',term_status:'active'};
  const teachers=[{id:7,full_name:'ครู ก',subjects:'ภาษาไทย, สังคม',homeroom_classroom:'ป.4/1',teaching_periods:18,role:'teacher'}];
  const classes=[{classroom:'ป.4/1'}];
  const assignments=[{id:31,personnel_id:7,classroom:'ป.4/1',subject_name:'ภาษาไทย',periods_per_week:5,max_per_day:2,full_name:'ครู ก'}];
  return {SCHOOL_SYNC_TOKEN:'school-sync-token-at-least-24-characters',DB:{
    prepare(sql){return {bind(){return {
      async first(){return sql.includes('FROM academic_years')?period:null;},
      async all(){if(sql.includes('SELECT p.id,p.full_name'))return {results:teachers};
        if(sql.includes('SELECT classroom FROM student_enrollments'))return {results:classes};
        if(sql.includes('SELECT a.id,a.personnel_id'))return {results:assignments};return {results:[]};},
      async run(){return {meta:{changes:1}}}
    };},async run(){return {meta:{changes:1}}}};},
    async batch(){return [];}
  }};
}
const request=(token='')=>new Request('https://school.example/api/integrations/timetable/master-data?term=2569-1',
  {headers:{'x-school-sync-token':token}});

test('timetable master data requires the shared sync token',async()=>{
  const env=envFixture(),response=await handleTimetableSyncRoute(request(),env,'/api/integrations/timetable/master-data','GET');
  assert.equal(response.status,401);
});

test('timetable master data maps stable teachers classes subjects and assignments',async()=>{
  const env=envFixture(),response=await handleTimetableSyncRoute(request(env.SCHOOL_SYNC_TOKEN),env,
    '/api/integrations/timetable/master-data','GET');
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.termKey,'2569-1');assert.equal(body.teachers[0].id,'school-teacher-7');
  assert.equal(body.classes[0].name,'ป.4/1');assert.equal(body.subjects.length,2);
  assert.equal(body.assignments[0].periodsPerWeek,5);
  assert.equal(body.assignments[0].teacherId,'school-teacher-7');
});
