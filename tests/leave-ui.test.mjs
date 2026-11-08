import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
test('director approval of a forwarded leave moves it into history; view-as displays a disabled preview and blocks writes',async()=>{
 for(const readOnly of [false,true]){
  const nodes=new Map(),writes=[];let click,approved=false;
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',dataset:{},innerHTML:'',textContent:'',hidden:false,classList:{add(){},remove(){}}});return nodes.get(id);};
  const ctx=vm.createContext({URLSearchParams,location:{search:'?view=approval'},Date,document:{getElementById:node,querySelectorAll:()=>[],addEventListener(event,fn){if(event==='click')click=fn;}},setInterval(){},apiRequest:async(path,options)=>{
   if(path==='/api/auth/me')return {user:{id:4,role:'executive',view_as:readOnly?{read_only:true}:null}};
   if(options){writes.push(options.body);assert.equal(path,'/api/leave-requests/9');approved=true;return {ok:true};}
   return {profile:{},can_view_all_leave:true,can_approve_leave:true,leave_requests:[{id:9,full_name:'ครูตัวอย่าง',leave_type:'personal',status:approved?'approved':'pending',workflow_stage:approved?'completed':'forwarded',can_decide:!approved}]};
  }});
  vm.runInContext(fs.readFileSync('public/js/leave.js','utf8'),ctx);await new Promise(r=>setImmediate(r));
  assert.match(node('pendingPanel').innerHTML,/อนุญาต/);assert.doesNotMatch(node('pendingPanel').innerHTML,/รับทราบและอนุมัติ/);
  if(readOnly){assert.match(node('pendingPanel').innerHTML,/data-action="approved"[^>]*disabled/);assert.match(node('approvalAccess').textContent,/โหมดดูบัญชีอื่น/);}
  else assert.doesNotMatch(node('pendingPanel').innerHTML,/disabled/);
  await click({target:{closest:()=>({dataset:{id:'9',action:'approved'},disabled:readOnly})}});
  if(readOnly){assert.equal(writes.length,0);assert.match(node('errorBox').textContent,/อ่านได้อย่างเดียว/);}
  else{assert.equal(writes[0].action,'decide');assert.equal(writes[0].status,'approved');assert.equal(node('pendingSection').hidden,true);assert.match(node('historyPanel').innerHTML,/อนุญาตแล้ว/);assert.match(node('successBox').textContent,/บันทึกคำสั่งอนุญาต/);}
 }
});
test('admin sees existing pending and historical leaves in approval view with view and export actions only',async()=>{
 const nodes=new Map();
 const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',dataset:{},innerHTML:'',textContent:'',hidden:false,classList:{add(){},remove(){}}});return nodes.get(id);};
 const ctx=vm.createContext({URLSearchParams,location:{search:'?view=approval'},Date,document:{getElementById:node,querySelectorAll:()=>[],addEventListener(){}},setInterval(){},apiRequest:async path=>{
  if(path==='/api/auth/me')return {user:{id:1,role:'superadmin'}};
  assert.equal(path,'/api/leave-requests','admin approval page must not load settings or delegations');
  return {profile:{},can_view_all_leave:true,is_leave_management:false,can_manage_delegations:false,can_approve_leave:false,leave_requests:[
   {id:1,full_name:'รายการเดิมรอรับทราบ',status:'pending',workflow_stage:'submitted',can_acknowledge:true,can_cancel:true},
   {id:2,full_name:'รายการเดิมอนุญาตแล้ว',status:'approved',workflow_stage:'submitted'},
   {id:3,full_name:'รายการเดิมไม่อนุญาต',status:'rejected'}]};
 }});
 vm.runInContext(fs.readFileSync('public/js/leave.js','utf8'),ctx);await new Promise(r=>setImmediate(r));
 assert.match(node('approvalAccess').textContent,/แอดมินดูข้อมูลการลาทั้งหมด/);
 assert.match(node('pendingPanel').innerHTML,/รายการเดิมรอรับทราบ/);
 assert.match(node('historyPanel').innerHTML,/รายการเดิมอนุญาตแล้ว/);assert.match(node('historyPanel').innerHTML,/รายการเดิมไม่อนุญาต/);
 assert.match(node('pendingPanel').innerHTML,/data-detail="1"/);assert.match(node('historyPanel').innerHTML,/data-export="pdf"/);
 assert.doesNotMatch(node('pendingPanel').innerHTML+node('historyPanel').innerHTML,/data-action=/);
 assert.equal(node('delegationSettings').hidden,true);assert.equal(node('headSettings').hidden,true);
});
test('administration approval view lists pending leaves for read-only deputies and lets director grant or revoke individually',async()=>{
 for(const director of [false,true]){
  const nodes=new Map();let click,granted=false;
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',dataset:{},innerHTML:'',textContent:'',hidden:false,classList:{add(){},remove(){}}});return nodes.get(id);};
  const ctx=vm.createContext({URLSearchParams,location:{search:'?view=approval'},Date,document:{getElementById:node,querySelectorAll:()=>[],addEventListener(event,fn){if(event==='click')click=fn;}},setInterval(){},apiRequest:async(path,options)=>{
   if(path==='/api/auth/me')return {user:{id:director?4:5,role:'executive'}};
   if(path.startsWith('/api/leave-allowance'))throw Error('approval page must not load personal allowance');
   if(path==='/api/leave-delegations'){
    if(options){assert.equal(options.body.personnel_id,5);granted=options.body.can_approve;return {ok:true};}
    return {deputies:[{id:5,full_name:'รอง <script>',position:'รองผู้อำนวยการ',can_approve:granted}]};
   }
   return {profile:{},is_leave_management:true,can_view_all_leave:true,can_manage_delegations:director,can_approve_leave:director,leave_requests:[
    {id:9,full_name:'ครูทดสอบ',leave_type:'sick',workflow_stage:'forwarded',status:'pending',can_decide:director},
    {id:10,full_name:'ยังไม่ส่งต่อ',workflow_stage:'submitted',status:'pending'}]};
  }});
  vm.runInContext(fs.readFileSync('public/js/leave.js','utf8'),ctx);await new Promise(r=>setImmediate(r));
  assert.equal(node('leaveTitle').textContent,'อนุมัติการลา');assert.equal(node('newLeaveSection').hidden,true);
  assert.equal(node('pendingSection').hidden,false);assert.match(node('pendingPanel').innerHTML,/ครูทดสอบ/);assert.match(node('pendingPanel').innerHTML,/ยังไม่ส่งต่อ/);
  assert.equal(node('delegationSettings').hidden,!director);
  if(!director){assert.doesNotMatch(node('pendingPanel').innerHTML,/data-action="approved"|data-action="rejected"/);assert.match(node('approvalAccess').textContent,/ยังไม่มีสิทธิ์/);continue;}
  assert.match(node('delegationList').innerHTML,/รอง &lt;script&gt;/);
  for(const value of ['true','false']){
   await click({target:{closest:()=>({dataset:{delegate:'5',grant:value},disabled:false})}});
   assert.equal(granted,value==='true');assert.match(node('delegationList').innerHTML,value==='true'?/ถอนสิทธิ์อนุมัติ/:/มอบสิทธิ์อนุมัติ/);
  }
 }
});
test('head inbox acknowledges and forwards in one action, escapes text and retains draft notes on refresh',async()=>{
 const nodes=new Map();const node=id=>{if(!nodes.has(id))nodes.set(id,{id,value:'',dataset:{},innerHTML:'',textContent:'',hidden:false,classList:{add(){},remove(){}},scrollIntoView(){}});return nodes.get(id);};let click,poll,payload,stage='submitted';
 const ctx=vm.createContext({URLSearchParams,location:{search:'',origin:'https://school.test'},Date,window:{},document:{getElementById:node,querySelectorAll:()=>[node('note-9')],activeElement:{tagName:'BODY'},addEventListener(event,fn){if(event==='click')click=fn;}},setInterval(fn){poll=fn;},apiRequest:async(path,options)=>{
  if(path.startsWith('/api/leave-working-days')){const q=new URLSearchParams(path.split('?')[1]);return {working_days:q.get('end')==='2026-10-07'?2:1};}
  if(path.startsWith('/api/leave-allowance'))return {period:{from:'2026-10-01',to:'2027-09-30'},types:[{leave_type:'lenient',max_count:3,approved:1,pending:1,remaining:1}]};
  if(path==='/api/auth/me')return{user:{id:3,full_name:'หัวหน้าฝ่าย'}};
  if(path==='/api/leave-settings')return{limits:[],deputy_personnel_id:5,deputies:[{id:5,full_name:'รองฝ่ายบุคลากร',position:'รองผู้อำนวยการ',line_status:'active'}]};
  if(options){payload=options.body;stage='forwarded';return{ok:true};}
  return{is_personnel_head:true,can_view_pending:true,deputy_choices:[{id:5,full_name:'รองฝ่ายบุคลากร',position:'รองผู้อำนวยการ'}],default_deputy_id:5,profile:{},leave_requests:[{id:9,full_name:'ครู <img onerror=alert(1)>',leave_type:'sick',reason:'ไม่สบาย & พักผ่อน',workflow_stage:stage,status:'pending',can_acknowledge:stage==='submitted',can_record:stage==='acknowledged',can_forward:stage==='acknowledged'}]};
 }});
 vm.runInContext(fs.readFileSync('public/js/leave.js','utf8'),ctx);await new Promise(r=>setImmediate(r));
 assert.equal(node('lineTemplateSettings').hidden,true);assert.match(node('leaveAllowance').innerHTML,/ลาอนุโลม/);assert.match(node('leaveAllowance').innerHTML,/ยื่นได้อีก/);
 assert.match(node('pendingPanel').innerHTML,/รับทราบและส่งต่ออัตโนมัติ/);assert(!node('pendingPanel').innerHTML.includes('data-action="forward"'));assert.match(node('pendingPanel').innerHTML,/&lt;img onerror=alert\(1\)&gt;/);
 node('note-9').value='บันทึกที่ยังไม่ได้กดส่ง';await poll();await new Promise(r=>setImmediate(r));assert.equal(node('note-9').value,'บันทึกที่ยังไม่ได้กดส่ง');
 node('note-9').value='ตรวจแล้ว';await click({target:{closest:()=>({dataset:{id:'9',action:'acknowledge'},disabled:false})}});assert.equal(payload.action,'acknowledge');assert.equal(payload.note,'ตรวจแล้ว');assert(!node('pendingPanel').innerHTML.includes('data-action="forward"'));assert.match(node('historyPanel').innerHTML,/รอผู้อำนวยการอนุมัติ/);
});

test('director sees approve and reject immediately without a deputy opinion',async()=>{
 const nodes=new Map();const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',dataset:{},innerHTML:'',textContent:'',hidden:false,classList:{add(){},remove(){}}});return nodes.get(id);};
 const ctx=vm.createContext({URLSearchParams,location:{search:''},Date,document:{getElementById:node,querySelectorAll:()=>[],addEventListener(){}},setInterval(){},apiRequest:async(path)=>{
  if(path==='/api/auth/me')return {user:{id:4,role:'executive'}};
  if(path.startsWith('/api/leave-working-days')){const q=new URLSearchParams(path.split('?')[1]);return {working_days:q.get('end')==='2026-10-07'?2:1};}
  if(path.startsWith('/api/leave-allowance'))return {period:null,message:'ไม่มีข้อมูล'};
  return {profile:{},leave_requests:[{id:9,full_name:'ครูทดสอบ',leave_type:'sick',workflow_stage:'forwarded',status:'pending',can_decide:true,reviewer_at:null}]};
 }});
 vm.runInContext(fs.readFileSync('public/js/leave.js','utf8'),ctx);await new Promise(r=>setImmediate(r));
 assert.match(node('pendingPanel').innerHTML,/data-action="approved"/);assert.match(node('pendingPanel').innerHTML,/data-action="rejected"/);
 assert.match(node('pendingPanel').innerHTML,/ลาป่วย/);assert.doesNotMatch(node('pendingPanel').innerHTML,/รอรองผู้บริหาร|data-action="review"/);
});

function submissionHarness({reject=false,reloadFails=false,dayPreview=null}={}){
 const nodes=new Map(),calls=[];let loads=0;
 const node=id=>{if(!nodes.has(id))nodes.set(id,{id,value:'',innerHTML:'',textContent:'',hidden:false,disabled:false,attributes:{},classList:{add(){},remove(){}},scrollIntoView(){this.scrolled=true},focus(){this.focused=true},setAttribute(k,v){this.attributes[k]=v},removeAttribute(k){delete this.attributes[k]}});return nodes.get(id);};
 const ctx=vm.createContext({URLSearchParams,location:{search:''},Date,window:{},document:{getElementById:node,querySelectorAll:()=>[],activeElement:{tagName:'BODY'},addEventListener(){}},setInterval(){},apiRequest:async(path,options)=>{
  if(path.startsWith('/api/leave-working-days')){const q=new URLSearchParams(path.split('?')[1]);return dayPreview?dayPreview(q):{working_days:q.get('end')==='2026-10-07'?2:1};}
  if(path.startsWith('/api/leave-allowance'))return {period:{from:'2026-10-01',to:'2027-09-30'},types:[{leave_type:'lenient',max_count:3,approved:1,pending:1,remaining:1}]};
  if(path==='/api/auth/me')return{user:{id:2,full_name:'ครูทดสอบ'}};
  if(options){calls.push(options.body);if(reject)throw Error('ฐานข้อมูลไม่พร้อมใช้งาน');return{id:42};}
  if(++loads>1&&reloadFails)throw Error('โหลดไม่ได้');
  return{is_personnel_head:false,deputy_choices:[],profile:{position:'ครู',phone:'0000000000'},leave_requests:[]};
 }});
 vm.runInContext(fs.readFileSync('public/js/leave.js','utf8'),ctx);
 const fill=()=>{for(const [id,value] of Object.entries({fType:'sick',fDate:'2026-10-06',fPosition:'ครู',fReason:'เหตุผลทดสอบ',fStart:'2026-10-06',fEnd:'2026-10-06',fDays:'0.5',fPhone:'0000000000',fAddress:'ที่อยู่ทดสอบ'}))node(id).value=value;};
 const submit=()=>node('leaveForm').onsubmit({preventDefault(){}});
 return{node,calls,fill,submit};
}
test('missing required details and impossible leave days show a focused field and never send a request',async()=>{
 const h=submissionHarness();await new Promise(r=>setImmediate(r));h.fill();h.node('fAddress').value=' ';
 await h.submit();assert.equal(h.calls.length,0);assert.match(h.node('submitError').textContent,/ที่อยู่ระหว่างลา/);assert.equal(h.node('submitError').hidden,false);assert.equal(h.node('fAddress').focused,true);assert.equal(h.node('fAddress').attributes['aria-invalid'],'true');
 h.fill();h.node('fDays').value='2';await h.submit();assert.equal(h.calls.length,0);assert.match(h.node('submitError').textContent,/ไม่เกิน 1 วัน/);
 h.fill();h.node('fEnd').value='2026-10-05';await h.submit();assert.equal(h.calls.length,0);assert.equal(h.node('fEnd').focused,true);
 h.fill();h.node('fDays').value='0.3';await h.submit();assert.equal(h.calls.length,0);
});
test('date input calculates days immediately and failed submission keeps the draft and re-enables retry',async()=>{
 const h=submissionHarness({reject:true});await new Promise(r=>setImmediate(r));h.fill();h.node('fEnd').value='2026-10-07';await h.node('fEnd').oninput();assert.equal(h.node('fDays').value,'2');
 await h.submit();assert.equal(h.calls.length,1);assert.equal(h.node('fReason').value,'เหตุผลทดสอบ');assert.equal(h.node('submitBtn').disabled,false);assert.match(h.node('submitError').textContent,/ฐานข้อมูลไม่พร้อม/);assert.equal(h.node('submitError').scrolled,true);
});
test('saved request stays successful if refreshing the registry fails, so users are not told to submit a duplicate',async()=>{
 const h=submissionHarness({reloadFails:true});await new Promise(r=>setImmediate(r));h.fill();await h.submit();
 assert.equal(h.calls.length,1);assert.equal(h.calls[0].leave_days,0.5);assert.equal(h.node('fReason').value,'');assert.equal(h.node('successBox').hidden,false);assert.match(h.node('errorBox').textContent,/บันทึกใบลาสำเร็จแล้ว/);assert.equal(h.node('submitError').hidden,true);assert.equal(h.node('submitBtn').disabled,false);
});

test('superadmin inserts leave dates, reason and teacher phone at the cursor and previews their values',async()=>{
 const nodes=new Map();let saved;
 const node=id=>{if(!nodes.has(id))nodes.set(id,{id,value:'',dataset:{},hidden:false,classList:{add(){},remove(){}},focus(){},setSelectionRange(a,b){this.selectionStart=a;this.selectionEnd=b;}});return nodes.get(id);};
 const ctx=vm.createContext({URLSearchParams,location:{search:'',origin:'https://school.test'},Date,document:{getElementById:node,querySelectorAll:()=>[],addEventListener(){}},setInterval(){},apiRequest:async(path,options)=>{
  if(path.startsWith('/api/leave-working-days')){const q=new URLSearchParams(path.split('?')[1]);return {working_days:q.get('end')==='2026-10-07'?2:1};}
  if(path.startsWith('/api/leave-allowance'))return {period:{from:'2026-10-01',to:'2027-09-30'},types:[{leave_type:'lenient',max_count:3,approved:1,pending:1,remaining:1}]};
  if(path==='/api/auth/me')return{user:{id:1,role:'superadmin'}};
  if(path==='/api/leave-settings'){if(options){saved=options.body.line_template;return{line_template:saved};}return{limits:[],deputies:[],line_template:'วันที่ลา: '};}
  return{profile:{},leave_requests:[]};
 }});
 vm.runInContext(fs.readFileSync('public/js/leave.js','utf8'),ctx);await new Promise(r=>setImmediate(r));
 assert.equal(node('lineTemplateSettings').hidden,false);
 node('insertLeaveDates').onclick();
 const input=node('leaveLineTemplate');input.value+='\nเหตุผล: ';input.selectionStart=input.selectionEnd=input.value.length;
 node('insertLeaveReason').onclick();
 input.value+='\nโทร: ';input.selectionStart=input.selectionEnd=input.value.length;node('insertLeavePhone').onclick();
 assert.equal(input.value,'วันที่ลา: {leave_dates}\nเหตุผล: {reason}\nโทร: {phone}');
 assert.match(node('leaveLinePreview').textContent,/วันที่ลา: 19\/10\/2569 ถึง 20\/10\/2569/);
 assert.match(node('leaveLinePreview').textContent,/เหตุผล: ไม่สบาย ขอพักรักษาตัว/);
 assert.match(node('leaveLinePreview').textContent,/โทร: 0800000000/);
 await node('saveLeaveLineTemplate').onclick();assert.equal(saved,input.value);
});

test('personal leave form exposes paternity and switches its preview and hint independently of maternity',async()=>{
 const h=submissionHarness({dayPreview:q=>({working_days:q.get('type')==='maternity'?4:2,counts_calendar_days:q.get('type')==='maternity'})});
 const flush=()=>new Promise(r=>setImmediate(r));await flush();
 h.node('realLeaveCard').onclick();assert.match(h.node('fType').innerHTML,/value="paternity"/);
 h.fill();h.node('fStart').value='2026-11-06';h.node('fEnd').value='2026-11-09';
 h.node('fType').value='paternity';h.node('fType').onchange();await flush();
 assert.equal(h.node('fDays').value,'2');assert.match(h.node('leaveDaysHint').textContent,/ไม่นับเสาร์ อาทิตย์/);
 h.node('fType').value='maternity';h.node('fType').onchange();await flush();
 assert.equal(h.node('fDays').value,'4');assert.match(h.node('leaveDaysHint').textContent,/รวมเสาร์ อาทิตย์/);
 h.node('fType').value='paternity';h.node('fType').onchange();await flush();await h.submit();
 assert.equal(h.calls.length,1);assert.equal(h.calls[0].leave_type,'paternity');assert.equal(h.calls[0].leave_days,2);
});
