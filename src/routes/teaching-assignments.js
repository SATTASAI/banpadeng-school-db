import {getCurrentUser,jsonResponse,isAdmin} from "../lib/auth.js";

const TERM_RE=/^(\d{4})-([1-3])$/;
let schemaReady;

function ensureSchema(env){
  if(!schemaReady)schemaReady=env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS academic_teaching_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      academic_term_id INTEGER NOT NULL REFERENCES academic_terms(id) ON DELETE CASCADE,
      personnel_id INTEGER NOT NULL REFERENCES personnel_records(id),
      classroom TEXT NOT NULL,
      subject_name TEXT NOT NULL,
      periods_per_week INTEGER NOT NULL CHECK (periods_per_week BETWEEN 1 AND 60),
      max_per_day INTEGER CHECK (max_per_day BETWEEN 1 AND 12),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (academic_term_id, personnel_id, classroom, subject_name)
    )`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_teaching_assignments_term ON academic_teaching_assignments(academic_term_id, classroom)")
  ]).catch(error=>{schemaReady=null;throw error;});
  return schemaReady;
}
const normalized=value=>String(value??"").normalize("NFC").trim().replace(/\s+/g," ");
const boundedInt=(value,min,max)=>{const n=Number(value);return Number.isInteger(n)&&n>=min&&n<=max?n:null;};
function teacherMatches(sourceName,personnel){
  const needle=normalized(sourceName).replace(/^(?:นาย|นางสาว|นาง|ว่าที่ร้อยตรีหญิง|ว่าที่ร้อยตรี)/,"").trim();
  return personnel.filter(row=>{
    const name=normalized(row.full_name).replace(/^(?:นาย|นางสาว|นาง|ว่าที่ร้อยตรีหญิง|ว่าที่ร้อยตรี)/,"").trim();
    return name===needle||name.startsWith(needle+" ")||name.includes(" "+needle+" ");
  });
}
async function resolveTerm(env,termKey){
  const match=normalized(termKey).match(TERM_RE);
  if(!match)return null;
  return env.DB.prepare(`SELECT t.id,t.term_number,t.name,y.year_be,y.label AS year_label
    FROM academic_terms t JOIN academic_years y ON y.id=t.academic_year_id
    WHERE y.year_be=? AND t.term_number=? LIMIT 1`).bind(Number(match[1]),Number(match[2])).first();
}
async function getPersonnel(env){
  return (await env.DB.prepare(`SELECT id,full_name,homeroom_classroom,status
    FROM personnel_records WHERE status='active' ORDER BY full_name`).all()).results;
}
export function prepareTeachingImport(payload,personnel){
  const rows=Array.isArray(payload.rows)?payload.rows:[];
  if(!rows.length||rows.length>1000)throw new Error("กรุณาส่งข้อมูลภาระสอน 1–1,000 รายการ");
  const excluded=new Set((payload.excluded_teachers||[]).map(normalized));
  const preferences=payload.duplicate_preferences||{};
  const duplicateGroups=new Map();
  for(const row of rows){
    const group=normalized(row.duplicate_group);
    if(group&&!duplicateGroups.has(group))duplicateGroups.set(group,new Set());
    if(group)duplicateGroups.get(group).add(normalized(row.teacher));
  }
  const unresolvedDuplicates=[];
  for(const [group,names] of duplicateGroups){
    const matched=[...names].filter(name=>teacherMatches(name,personnel).length===1&&!excluded.has(name));
    if(matched.length===1)preferences[group]=matched[0];
    else if(!matched.includes(normalized(preferences[group])))unresolvedDuplicates.push({group,teachers:[...names],matched_teachers:matched});
  }
  const unmatched=new Map(),ambiguous=new Map(),inferred=[];
  const prepared=new Map();
  for(let index=0;index<rows.length;index++){
    const row=rows[index]||{},sourceTeacher=normalized(row.teacher),group=normalized(row.duplicate_group);
    if(!sourceTeacher||excluded.has(sourceTeacher))continue;
    if(group&&normalized(preferences[group])!==sourceTeacher)continue;
    const matches=teacherMatches(sourceTeacher,personnel);
    if(matches.length===0){unmatched.set(sourceTeacher,(unmatched.get(sourceTeacher)||0)+1);continue;}
    if(matches.length>1){ambiguous.set(sourceTeacher,matches.map(x=>x.full_name));continue;}
    const person=matches[0],subject=normalized(row.subject);
    let classroom=normalized(row.classroom);
    if(!classroom&&row.infer_homeroom){
      classroom=normalized(person.homeroom_classroom);
      if(classroom)inferred.push({teacher:sourceTeacher,full_name:person.full_name,classroom,subject});
    }
    const periods=boundedInt(row.periods_per_week,1,60);
    if(!classroom||!subject||!periods)continue;
    const key=[person.id,classroom,subject].join("|");
    if(!prepared.has(key))prepared.set(key,{personnel_id:Number(person.id),teacher:person.full_name,classroom,subject_name:subject,periods_per_week:0,max_per_day:1});
    const item=prepared.get(key);
    item.periods_per_week+=periods;
    item.max_per_day=Math.min(2,item.periods_per_week);
  }
  return {
    rows:[...prepared.values()],
    unmatched_teachers:[...unmatched].map(([teacher,row_count])=>({teacher,row_count})),
    ambiguous_teachers:[...ambiguous].map(([teacher,matches])=>({teacher,matches})),
    unresolved_duplicates:unresolvedDuplicates,
    inferred_homerooms:inferred
  };
}
function buildInsertStatement(env,termId,rows){
  const values=rows.map(()=>"(?,?,?,?,?,?,datetime('now'))").join(",");
  const args=rows.flatMap(row=>[termId,row.personnel_id,row.classroom,row.subject_name,row.periods_per_week,row.max_per_day]);
  return env.DB.prepare(`INSERT INTO academic_teaching_assignments
    (academic_term_id,personnel_id,classroom,subject_name,periods_per_week,max_per_day,updated_at)
    VALUES ${values}
    ON CONFLICT(academic_term_id,personnel_id,classroom,subject_name) DO UPDATE SET
      periods_per_week=excluded.periods_per_week,max_per_day=excluded.max_per_day,updated_at=datetime('now')`).bind(...args);
}

export async function handleTeachingAssignmentsRoute(request,env,pathname,method){
  if(pathname!=="/api/academic/teaching-assignments"&&pathname!=="/api/academic/teaching-assignments/import")return null;
  const user=await getCurrentUser(request,env);
  if(!user)return jsonResponse({error:"กรุณาเข้าสู่ระบบ"},401);
  await ensureSchema(env);
  const url=new URL(request.url);
  if(pathname==="/api/academic/teaching-assignments"&&method==="GET"){
    const termKey=url.searchParams.get("term")||"";
    const term=await resolveTerm(env,termKey);
    if(!term)return jsonResponse({error:`ไม่พบปี/ภาคเรียน ${termKey}`},404);
    const [personnel,result]=await Promise.all([
      getPersonnel(env),
      env.DB.prepare(`SELECT a.id,a.personnel_id,p.full_name AS teacher,a.classroom,a.subject_name,
        a.periods_per_week,a.max_per_day,a.updated_at
        FROM academic_teaching_assignments a JOIN personnel_records p ON p.id=a.personnel_id
        WHERE a.academic_term_id=? ORDER BY p.full_name,a.classroom,a.subject_name`).bind(term.id).all()
    ]);
    return jsonResponse({term,personnel,assignments:result.results,can_manage:isAdmin(user)});
  }
  if(pathname==="/api/academic/teaching-assignments/import"&&method==="POST"){
    if(!isAdmin(user))return jsonResponse({error:"เฉพาะผู้บริหารหรือผู้ดูแลระบบเท่านั้น"},403);
    let payload;
    try{payload=await request.json();}catch{return jsonResponse({error:"รูปแบบข้อมูลไม่ถูกต้อง"},400);}
    const termKey=normalized(payload.term_key),term=await resolveTerm(env,termKey);
    if(!term)return jsonResponse({error:`ไม่พบปี/ภาคเรียน ${termKey}`},404);
    const prepared=prepareTeachingImport(payload,await getPersonnel(env));
    const blockers=prepared.unmatched_teachers.length+prepared.ambiguous_teachers.length+prepared.unresolved_duplicates.length;
    const preview={term,summary:{source_rows:payload.rows.length,ready_assignments:prepared.rows.length,
      matched_teachers:new Set(prepared.rows.map(x=>x.personnel_id)).size,blockers},
      ...prepared};
    if(payload.mode!=="commit")return jsonResponse(preview);
    if(blockers&&!payload.allow_partial)return jsonResponse({error:"ยังมีชื่อครูหรือรายการซ้ำที่ต้องตรวจสอบ",...preview},409);
    const statements=[];
    if(payload.replace_existing){
      for(const personnelId of new Set(prepared.rows.map(x=>x.personnel_id)))
        statements.push(env.DB.prepare("DELETE FROM academic_teaching_assignments WHERE academic_term_id=? AND personnel_id=?").bind(term.id,personnelId));
    }
    for(let i=0;i<prepared.rows.length;i+=15)statements.push(buildInsertStatement(env,term.id,prepared.rows.slice(i,i+15)));
    if(statements.length)await env.DB.batch(statements);
    return jsonResponse({ok:true,imported_assignments:prepared.rows.length,replaced_existing:!!payload.replace_existing,...preview});
  }
  return jsonResponse({error:"Method not allowed"},405,{Allow:pathname.endsWith("/import")?"POST":"GET"});
}
