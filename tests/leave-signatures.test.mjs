import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {fixture,call} from './notifications.test.mjs';
import {seedLeaveCalendar} from './leave-calendar.mjs';
import {ensureLeaveData} from '../src/lib/leave-data.js';
import {validSignature} from '../src/lib/signatures.js';
import {leaveStatistics} from '../src/lib/personnel-stats.js';
import {dashboardActivitySummary} from '../src/lib/dashboard-summary.js';
const png="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";
const form={leave_type:'personal',reason:'ติดต่อธุระ',position:'ครู',start_date:'2026-11-06',end_date:'2026-11-09',contact_address:'บ้านพัก',contact_phone:'0000000000',applicant_note:'หมายเหตุของครู'};
async function approveViaHead(env,id){
 assert.equal((await call(env,'/api/leave-requests/'+id,'PATCH',{action:'acknowledge'},3)).status,200);
 assert.equal((await call(env,'/api/leave-requests/'+id,'PATCH',{action:'decide',status:'approved'},4)).status,200);
}
async function setup(){
 const env=await fixture();seedLeaveCalendar(env);
 env.raw.exec(`INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES
 (4,'dir@test','x','x','ผู้อำนวยการ ตัวอย่าง','executive'),(5,'dep@test','x','x','รองผู้อำนวยการ ตัวอย่าง','executive');
 INSERT INTO staff_profiles(user_id,position) VALUES(4,'ผู้อำนวยการโรงเรียน'),(5,'รองผู้อำนวยการโรงเรียน');
 INSERT INTO budget_role_assignments(role_key,department,user_id,assigned_by) VALUES('director_approval','',4,1),('deputy_director','personnel',5,1);`);
 await ensureLeaveData(env);
 const head=env.raw.prepare('SELECT id FROM personnel_records WHERE user_id=3').get();
 await call(env,'/api/department-staff/personnel','POST',{personnel_id:head.id,is_head:true});
 const deputy=env.raw.prepare('SELECT personnel_id FROM personnel_accounts WHERE user_id=5').get().personnel_id;
 env.raw.prepare('INSERT INTO leave_settings(id,deputy_personnel_id) VALUES(1,?)').run(deputy);
 return env;
}

test('shared signature API validates images, isolates own signatures and allows admin to manage configured approvers',async()=>{
 const env=await setup();assert(validSignature(png));
 for(const data_url of ['data:image/svg+xml;base64,AAAA','data:image/png;base64,AAAA',png+'x'])assert.equal((await call(env,'/api/signatures','PUT',{data_url},2)).status,400);
 const corrupt=Buffer.from(png.split(',')[1],'base64');corrupt[corrupt.length-1]^=1;
 assert.equal(validSignature('data:image/png;base64,'+corrupt.toString('base64')),false);
 assert.equal((await call(env,'/api/signatures','PUT',{data_url:png},2)).status,200);
 assert.equal((await (await call(env,'/api/signatures','GET',undefined,2)).json()).signature.data_url,png);
 assert.equal((await call(env,'/api/signatures?user_id=2','GET',undefined,3)).status,403);
 assert.equal((await call(env,'/api/signatures?user_id=4','PUT',{data_url:png},2)).status,403);
 assert.equal((await call(env,'/api/signatures?user_id=3','PUT',{data_url:png},1)).status,403);
 assert.equal((await call(env,'/api/signatures?user_id=4','PUT',{data_url:png},1)).status,200);
 assert.equal(env.raw.prepare("SELECT COUNT(*) n FROM audit_logs WHERE resource='signature'").get().n,2);
});

test('leave stores teacher and approver signature snapshots at their transitions, hides unsigned approval and keeps old signed copies',async()=>{
 const env=await setup();
 for(const id of [2,4,5])assert.equal((await call(env,'/api/signatures?user_id='+id,'PUT',{data_url:png},id===2?2:1)).status,200);
 const response=await call(env,'/api/leave-requests','POST',form,2);assert.equal(response.status,201);const {id}=await response.json();
 let r=(await (await call(env,'/api/leave-requests/'+id,'GET',undefined,2)).json()).leave_request;
 assert.equal(r.teacher_signature,png);assert.equal(r.approver_signature,null);assert.equal(r.deputy_signature,null);assert.equal(r.applicant_note,form.applicant_note);
 await approveViaHead(env,id);
 env.raw.exec("DELETE FROM teacher_signatures");
 r=(await (await call(env,'/api/leave-requests/'+id,'GET',undefined,2)).json()).leave_request;
 assert.equal(r.approver_signature,png);assert.equal(r.deputy_signature,png);assert.equal(r.teacher_signature,png);assert.match(r.deputy_name,/รองผู้อำนวยการ/);
 const list=await (await call(env,'/api/leave-requests','GET',undefined,1)).json();assert(!('approver_signature' in list.leave_requests[0]));assert.equal(list.fiscal_statistics.real.days,0);
 const own=await (await call(env,'/api/leave-requests','GET',undefined,2)).json();assert.equal(own.fiscal_statistics.real.days,2);
});

test('lenient leave requires teacher handover, stores it, and stays outside all ordinary fiscal totals and forms',async()=>{
 const env=await setup();
 assert.equal((await call(env,'/api/leave-requests','POST',{...form,leave_type:'lenient'},2)).status,400);
 const {id}=await (await call(env,'/api/leave-requests','POST',{...form,leave_type:'lenient',substitute_teacher:'ครูผู้รับมอบหมาย คาบ 1–3'},2)).json();
 await approveViaHead(env,id);
 const actual=await (await call(env,'/api/leave-requests','POST',form,2)).json();
 await approveViaHead(env,actual.id);
 const stat=await leaveStatistics(env,{fiscalYear:2570});assert.equal(stat.summary.approved_days,2);assert.equal(stat.summary.approved_times,1);assert.equal(stat.summary.lenient_days,2);assert.equal(stat.summary.lenient_times,1);assert.equal(stat.monthly[0].times,1);
 const dash=await dashboardActivitySummary(env,2570);assert.equal(dash.leave_summary.approved_days,2);assert.equal(dash.leave_summary.lenient.approved_days,2);
 const list=await (await call(env,'/api/leave-requests','GET',undefined,2)).json();assert.equal(list.fiscal_statistics.real.days,2);assert.equal(list.fiscal_statistics.lenient.days,2);
 const real=(await (await call(env,'/api/leave-requests/'+actual.id,'GET',undefined,2)).json()).leave_request;assert(!real.stats.some(s=>s.type==='lenient'));assert.equal(real.last_leave,null);
 const lenient=(await (await call(env,'/api/leave-requests/'+id,'GET',undefined,2)).json()).leave_request;assert.equal(lenient.stats.length,1);assert.equal(lenient.statistics_period.included_in_fiscal_year,false);assert.equal(lenient.substitute_teacher,'ครูผู้รับมอบหมาย คาบ 1–3');
});

test('background removal preserves ink and existing transparency while removing white and grey paper',()=>{
 const ctx=vm.createContext({Uint8ClampedArray});vm.runInContext(fs.readFileSync('public/js/signature-upload.js','utf8'),ctx);
 const data=new Uint8ClampedArray(20*20*4);for(let i=0;i<data.length;i+=4)data.set([245,245,245,255],i);
 for(let x=6;x<14;x++)data.set([20,30,80,255],(10*20+x)*4);
 data.set([0,0,0,0],0);
 const result=ctx.SignatureUpload.removeBackground(data,20,20);assert.equal(result.pixels[3],0);assert.equal(result.pixels[7],0);assert.equal(result.pixels[(10*20+8)*4+3],255);
 assert.throws(()=>ctx.SignatureUpload.removeBackground(new Uint8ClampedArray(16),2,2),/ไม่พบเส้น/);
});

test('Word and PDF embed snapshot images in their correct blocks and omit manager images before approval',()=>{
 const ctx=vm.createContext({atob,Uint8Array,DataView});vm.runInContext(fs.readFileSync('public/js/leave-form-export.js','utf8'),ctx);
 const row={...form,id:1,full_name:'ครู ตัวอย่าง',leave_type:'lenient',leave_days:2,status:'approved',substitute_teacher:'ครูผู้รับมอบหมาย',teacher_signature:png,deputy_signature:png,approver_signature:png};
 const files=ctx.LeaveFormExport.docxFiles(row),xml=files['word/document.xml'];
 for(const key of ['teacher','deputy','approver'])assert(files['word/media/'+key+'.png'] instanceof Uint8Array);
 assert.match(xml,/w:tblW w:w="9638"/);assert.match(xml,/ครูผู้รับมอบหมาย/);assert.match(xml,/หมายเหตุของครู/);assert.match(xml,/ไม่นับรวมปีงบประมาณ/);
 const pending=ctx.LeaveFormExport.docxFiles({...row,status:'pending'});assert(!pending['word/media/approver.png']);assert(!pending['word/media/deputy.png']);
 const pdf=ctx.LeaveFormExport.pdfDefinition(row);assert.equal(pdf.pageMargins[0],pdf.pageMargins[2]);assert(JSON.stringify(pdf).includes(png));
});

test('registries show all until a card is chosen; cards filter registries and form types without losing draft notes',async()=>{
 const nodes=new Map();const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',dataset:{},hidden:false,textContent:'',innerHTML:'',setAttribute(){},classList:{add(){},remove(){}}});return nodes.get(id);};
 const ctx=vm.createContext({URLSearchParams,Date,location:{search:'?view=approval'},document:{getElementById:node,querySelectorAll:()=>[],addEventListener(){}},setInterval(){},apiRequest:async path=>path==='/api/auth/me'?{user:{id:4,role:'executive'}}:{profile:{},can_view_all_leave:true,leave_requests:[{id:1,full_name:'ครู ก',leave_type:'sick',status:'pending'},{id:2,full_name:'ครู ข',leave_type:'lenient',status:'pending'}]}});
 vm.runInContext(fs.readFileSync('public/js/leave.js','utf8'),ctx);await new Promise(r=>setImmediate(r));
 assert.match(node('pendingPanel').innerHTML,/ครู ก/);assert.match(node('pendingPanel').innerHTML,/ครู ข/);
 node('fNote').value='ร่างหมายเหตุ';node('lenientLeaveCard').onclick();assert.doesNotMatch(node('fType').innerHTML,/sick/);
 assert.equal(node('fType').value,'lenient');assert.equal(node('substituteTeacherField').hidden,false);assert.equal(node('fSubstitute').required,true);assert.match(node('pendingPanel').innerHTML,/ครู ข/);assert.doesNotMatch(node('pendingPanel').innerHTML,/ครู ก/);
 node('realLeaveCard').onclick();assert.equal(node('substituteTeacherField').hidden,true);assert.equal(node('fNote').value,'ร่างหมายเหตุ');
 assert.equal(node('fType').value,'sick');assert.doesNotMatch(node('fType').innerHTML,/lenient/);
});

test('teacher sees the new-leave form only after choosing a real or lenient card',async()=>{
 const nodes=new Map();const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',dataset:{},hidden:id==='newLeaveSection',textContent:'',innerHTML:'',setAttribute(){},classList:{add(){},remove(){}}});return nodes.get(id);};
 const ctx=vm.createContext({URLSearchParams,Date,location:{search:''},document:{getElementById:node,querySelectorAll:()=>[],addEventListener(){}},setInterval(){},apiRequest:async path=>path==='/api/auth/me'?{user:{id:2,role:'teacher',full_name:'ครู ก'}}:path.startsWith('/api/leave-allowance')?{period:null,message:''}:{profile:{},leave_requests:[]}});
 vm.runInContext(fs.readFileSync('public/js/leave.js','utf8'),ctx);await new Promise(r=>setImmediate(r));
 assert.equal(node('newLeaveSection').hidden,true);
 node('lenientLeaveCard').onclick();assert.equal(node('newLeaveSection').hidden,false);assert.equal(node('leaveCategoryHint').hidden,true);assert.equal(node('newLeaveTitle').textContent,'ยื่นใบลาอนุโลม');
 node('realLeaveCard').onclick();assert.equal(node('newLeaveTitle').textContent,'ยื่นใบลาจริง');
});

test('approver settings offers assigned users and mounts the upload against the selected identity',()=>{
 const source=fs.readFileSync('public/budget.html','utf8'),start=source.indexOf('function renderApproverSignatures(){'),end=source.indexOf('function renderRoles(){',start);
 const nodes=new Map(),calls=[],$=id=>{if(!nodes.has(id))nodes.set(id,{value:'',innerHTML:''});return nodes.get(id);};
 const ctx=vm.createContext({$,esc:s=>s,SignatureUpload:{mount:(node,options)=>calls.push(options)},data:{role_assignments:[{user_id:4},{user_id:5}],assignable_users:[{id:2,full_name:'ครูทั่วไป'},{id:4,full_name:'ผู้อำนวยการ'},{id:5,full_name:'รองฝ่ายบุคคล'}]}});
 vm.runInContext(source.slice(start,end)+'renderApproverSignatures();',ctx);
 assert.match($('approverSignatureUser').innerHTML,/ผู้อำนวยการ/);assert.doesNotMatch($('approverSignatureUser').innerHTML,/ครูทั่วไป/);
 $('approverSignatureUser').value='5';$('approverSignatureUser').onchange();assert.equal(calls[0].endpoint,'/api/signatures?user_id=5');
});
