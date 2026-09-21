import {jsonResponse} from '../lib/auth.js';
import {ensurePersonnelData} from '../lib/personnel-data.js';

const TERM_RE=/^(\d{4})-([12])$/;
const SCHEMA=[
  `CREATE TABLE IF NOT EXISTS academic_teaching_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    academic_term_id INTEGER NOT NULL REFERENCES academic_terms(id) ON DELETE CASCADE,
    personnel_id INTEGER NOT NULL REFERENCES personnel_records(id),
    classroom TEXT NOT NULL,
    subject_name TEXT NOT NULL,
    periods_per_week INTEGER NOT NULL CHECK (periods_per_week BETWEEN 1 AND 60),
    max_per_day INTEGER CHECK (max_per_day BETWEEN 1 AND 12),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (academic_term_id, personnel_id, classroom, subject_name)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_teaching_assignments_term ON academic_teaching_assignments(academic_term_id, classroom)'
];
let schemaReady;

function ensureSchema(env){
  if(!schemaReady)schemaReady=env.DB.batch(SCHEMA.map(sql=>env.DB.prepare(sql))).catch(error=>{schemaReady=null;throw error;});
  return schemaReady;
}
function authorized(request,env){
  const expected=env.SCHOOL_SYNC_TOKEN,provided=request.headers.get('x-school-sync-token')||'';
  if(typeof expected!=='string'||expected.length<24)return false;
  const a=new TextEncoder().encode(expected),b=new TextEncoder().encode(provided);let difference=a.length^b.length;
  for(let i=0;i<Math.max(a.length,b.length);i++)difference|=(a[i]||0)^(b[i]||0);
  return difference===0;
}
function normalized(value){return String(value||'').normalize('NFC').trim().replace(/\s+/g,' ');}
function stableId(prefix,value){
  let hash=2166136261;
  for(const char of normalized(value).toLocaleLowerCase('th-TH')){hash^=char.codePointAt(0);hash=Math.imul(hash,16777619);}
  return `${prefix}-${(hash>>>0).toString(36)}`;
}
function subjectNames(value){
  return normalized(value).split(/[,;/|\n]+/).map(normalized).filter(Boolean);
}

export async function handleTimetableSyncRoute(request,env,pathname,method){
  if(pathname!=='/api/integrations/timetable/master-data')return null;
  if(method!=='GET')return jsonResponse({error:'Method not allowed'},405,{Allow:'GET'});
  if(!authorized(request,env))return jsonResponse({error:'ไม่มีสิทธิ์เชื่อมข้อมูลตารางสอน'},401);
  const url=new URL(request.url),termKey=url.searchParams.get('term')||'';
  const match=termKey.match(TERM_RE);
  if(!match)return jsonResponse({error:'ภาคเรียนต้องอยู่ในรูป 2569-1'},400);

  await ensurePersonnelData(env);await ensureSchema(env);
  const period=await env.DB.prepare(
    `SELECT y.id AS academic_year_id,y.year_be,y.label AS year_label,y.status AS year_status,
            t.id AS academic_term_id,t.term_number,t.name AS term_name,t.status AS term_status
     FROM academic_years y JOIN academic_terms t ON t.academic_year_id=y.id
     WHERE y.year_be=? AND t.term_number=? LIMIT 1`
  ).bind(Number(match[1]),Number(match[2])).first();
  if(!period)return jsonResponse({error:`ไม่พบปี/ภาคเรียน ${termKey} ในระบบโรงเรียน`},404);

  const [teacherResult,classResult,assignmentResult]=await Promise.all([
    env.DB.prepare(
      `SELECT p.id,p.full_name,p.subjects,p.homeroom_classroom,p.teaching_periods,u.role
       FROM personnel_records p LEFT JOIN users u ON u.id=p.user_id
       WHERE p.status='active' AND
         (u.role='teacher' OR COALESCE(TRIM(p.subjects),'')<>'' OR
          COALESCE(TRIM(p.homeroom_classroom),'')<>'' OR COALESCE(p.teaching_periods,0)>0)
       ORDER BY p.full_name`
    ).all(),
    env.DB.prepare(
      `SELECT classroom FROM student_enrollments
       WHERE academic_term_id=? AND status='enrolled' AND COALESCE(TRIM(classroom),'')<>''
       UNION SELECT homeroom_classroom AS classroom FROM personnel_records
       WHERE status='active' AND COALESCE(TRIM(homeroom_classroom),'')<>''
       UNION SELECT classroom FROM academic_teaching_assignments
       WHERE academic_term_id=? ORDER BY classroom`
    ).bind(period.academic_term_id,period.academic_term_id).all(),
    env.DB.prepare(
      `SELECT a.id,a.personnel_id,a.classroom,a.subject_name,a.periods_per_week,a.max_per_day,p.full_name
       FROM academic_teaching_assignments a JOIN personnel_records p ON p.id=a.personnel_id
       WHERE a.academic_term_id=? AND p.status='active' ORDER BY a.classroom,a.subject_name,p.full_name`
    ).bind(period.academic_term_id).all()
  ]);

  const teachers=teacherResult.results.map(row=>({
    id:`school-teacher-${row.id}`,name:normalized(row.full_name),maxPerDay:6,maxConsecutive:4,
    source:{personnelId:row.id,subjects:subjectNames(row.subjects),homeroom:normalized(row.homeroom_classroom),teachingPeriods:Number(row.teaching_periods||0)}
  }));
  const teacherIds=new Map(teacherResult.results.map(row=>[Number(row.id),`school-teacher-${row.id}`]));
  const classNames=[...new Set(classResult.results.map(row=>normalized(row.classroom)).filter(Boolean))];
  const classes=classNames.map(name=>({id:stableId('school-class',name),name}));
  const classIds=new Map(classes.map(row=>[row.name,row.id]));
  const subjectSet=new Set();
  teacherResult.results.forEach(row=>subjectNames(row.subjects).forEach(name=>subjectSet.add(name)));
  assignmentResult.results.forEach(row=>subjectSet.add(normalized(row.subject_name)));
  const subjects=[...subjectSet].sort((a,b)=>a.localeCompare(b,'th')).map(name=>({id:stableId('school-subject',name),name}));
  const subjectIds=new Map(subjects.map(row=>[row.name,row.id]));
  const assignments=assignmentResult.results.map(row=>({
    id:`school-assignment-${row.id}`,classId:classIds.get(normalized(row.classroom)),
    subjectId:subjectIds.get(normalized(row.subject_name)),teacherId:teacherIds.get(Number(row.personnel_id)),
    periodsPerWeek:Number(row.periods_per_week),maxPerDay:Number(row.max_per_day||2)
  })).filter(row=>row.classId&&row.subjectId&&row.teacherId);

  return jsonResponse({
    termKey,period:{...period},classes,teachers,subjects,assignments,
    counts:{classes:classes.length,teachers:teachers.length,subjects:subjects.length,assignments:assignments.length},
    syncedAt:new Date().toISOString()
  });
}
