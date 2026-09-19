import test from "node:test";
import assert from "node:assert/strict";
import { signJWT } from "../src/lib/crypto.js";
import { handleLearnerAnalysisRoute } from "../src/routes/learner-analysis.js";

const secret = "learner-analysis-test-secret";
const term = { id:4, academic_year_id:2, name:"ภาคเรียนที่ 1", year_be:2569 };
function environment({ role="teacher", enrolled=true }={}) {
  const calls=[];
  const user={ id:7, role, status:"active", full_name:"ครูตัวอย่าง" };
  return { JWT_SECRET:secret, calls, DB:{
    prepare(sql){
      const statement={
        bind(...values){statement.values=values;return statement;},
        async first(){
          calls.push({sql,values:statement.values||[]});
          if(sql.includes("FROM users WHERE id = ?"))return user;
          if(sql.includes("FROM academic_terms t"))return term;
          if(sql.includes("SELECT 1 FROM student_enrollments"))return enrolled?{1:1}:null;
          if(sql.includes("FROM student_enrollments e JOIN students s"))return enrolled?{ id:9,student_code:"S09",full_name:"นักเรียนตัวอย่าง",classroom:"ป.4/1" }:null;
          return null;
        },
        async all(){calls.push({sql,values:statement.values||[]});return { results:sql.includes("SELECT e.classroom")?[{classroom:"ป.4/1",student_count:1}]:[{id:9,student_code:"S09",full_name:"นักเรียนตัวอย่าง",classroom:"ป.4/1",analysis_id:null}] };},
        async run(){calls.push({sql,values:statement.values||[]});return { success:true };},
      };
      return statement;
    },
  }};
}

async function request(path, method="GET", body, authenticated=true) {
  const token=authenticated?await signJWT({sub:7},secret):"";
  return new Request(`https://school.example/api/learner-analysis/${path}`,{
    method,headers:{Cookie:`bpd_session=${token}`,"Content-Type":"application/json"},
    body:body===undefined?undefined:JSON.stringify(body),
  });
}
async function call(path,env,method="GET",body,authenticated=true){
  const req=await request(path,method,body,authenticated);
  return handleLearnerAnalysisRoute(req,env,new URL(req.url).pathname,method);
}

test("unauthenticated users cannot list or print children",async()=>{
  const env=environment();const response=await call("roster?term_id=4&classroom=ป.4%2F1&print=1",env,"GET",undefined,false);
  assert.equal(response.status,401);
  assert.equal(env.calls.length,0);
});

test("room print selects only the chosen term and classroom, with the signed-in teacher's analysis",async()=>{
  const env=environment();const response=await call("roster?term_id=4&classroom=ป.4%2F1&print=1",env);
  assert.equal(response.status,200);
  const data=await response.json();assert.equal(data.teacher_name,"ครูตัวอย่าง");
  assert.equal(data.students.length,1);
  const select=env.calls.find(c=>c.sql.includes("LEFT JOIN learner_analyses a") && c.sql.includes("FROM student_enrollments e"));
  assert.deepEqual(select.values,[7,4,"ป.4/1"]);
  assert.match(select.sql,/a\.teacher_user_id=\?/);
  assert.match(select.sql,/e\.status='enrolled'/);
  assert.match(select.sql,/s\.health_conditions/);
  assert.equal(response.headers.get("Cache-Control"),"private, no-store");
});

test("a teacher can save only for an enrolled student and year is taken from the selected term",async()=>{
  const env=environment();const response=await call("records/9",env,"PUT",{term_id:4,strengths:"อ่านคล่อง",academic_year_id:999});
  assert.equal(response.status,200);
  const insert=env.calls.find(c=>c.sql.includes("INSERT INTO learner_analyses"));
  assert.deepEqual(insert.values.slice(0,4),[9,2,4,7]);
  assert.ok(insert.values.includes("อ่านคล่อง"));
  assert.match(insert.sql,/ON CONFLICT\(student_id,academic_term_id,teacher_user_id\)/);
});

test("does not save a record outside the selected term or with an impossible date",async()=>{
  const unavailable=environment({enrolled:false});
  assert.equal((await call("records/9",unavailable,"PUT",{term_id:4,reading_result:"ดี"})).status,404);
  const invalid=environment();
  assert.equal((await call("records/9",invalid,"PUT",{term_id:4,assessment_date:"2026-02-31"})).status,400);
  assert.ok(!invalid.calls.some(c=>c.sql.includes("INSERT INTO learner_analyses")));
});

test("teachers cannot read another teacher's record through the direct endpoint",async()=>{
  const env=environment();const response=await call("records/9?term_id=4",env);
  assert.equal(response.status,200);
  const read=env.calls.find(c=>c.sql.includes("FROM learner_analyses") && c.sql.includes("SELECT assessment_date"));
  assert.deepEqual(read.values,[9,4,7]);
});
