import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
test('head inbox shows acknowledgement and forwarding separately, sends the selected deputy, escapes text and retains draft notes on refresh',async()=>{
 const nodes=new Map();const node=id=>{if(!nodes.has(id))nodes.set(id,{id,value:'',innerHTML:'',textContent:'',hidden:false,classList:{add(){},remove(){}},scrollIntoView(){}});return nodes.get(id);};let click,poll,payload,stage='submitted';
 const ctx=vm.createContext({URLSearchParams,location:{search:''},Date,window:{},document:{getElementById:node,querySelectorAll:()=>[node('note-9')],activeElement:{tagName:'BODY'},addEventListener(event,fn){if(event==='click')click=fn;}},setInterval(fn){poll=fn;},apiRequest:async(path,options)=>{
  if(path==='/api/auth/me')return{user:{id:3,full_name:'หัวหน้าฝ่าย'}};
  if(options){payload=options.body;stage='acknowledged';return{ok:true};}
  return{is_personnel_head:true,can_view_pending:true,deputy_choices:[{id:5,full_name:'รองฝ่ายบุคลากร',position:'รองผู้อำนวยการ'}],default_deputy_id:5,profile:{},leave_requests:[{id:9,full_name:'ครู <img onerror=alert(1)>',leave_type:'sick',reason:'ไม่สบาย & พักผ่อน',workflow_stage:stage,status:'pending',can_acknowledge:stage==='submitted',can_record:stage==='acknowledged',can_forward:stage==='acknowledged'}]};
 }});
 vm.runInContext(fs.readFileSync('public/js/leave.js','utf8'),ctx);await new Promise(r=>setImmediate(r));
 assert.match(node('pendingPanel').innerHTML,/รับทราบและบันทึก/);assert(!node('pendingPanel').innerHTML.includes('data-action="forward"'));assert.match(node('pendingPanel').innerHTML,/&lt;img onerror=alert\(1\)&gt;/);
 node('note-9').value='ตรวจแล้ว';await click({target:{closest:()=>({dataset:{id:'9',action:'acknowledge'},disabled:false})}});assert.equal(payload.action,'acknowledge');assert.equal(payload.note,'ตรวจแล้ว');assert.match(node('pendingPanel').innerHTML,/data-action="forward"/);
 node('note-9').value='บันทึกที่ยังไม่ได้กดส่ง';await poll();await new Promise(r=>setImmediate(r));assert.equal(node('note-9').value,'บันทึกที่ยังไม่ได้กดส่ง');
 node('deputyChoice').value='5';await click({target:{closest:()=>({dataset:{id:'9',action:'forward'},disabled:false})}});assert.equal(payload.action,'forward');assert.equal(payload.deputy_personnel_id,5);
});

function submissionHarness({reject=false,reloadFails=false}={}){
 const nodes=new Map(),calls=[];let loads=0;
 const node=id=>{if(!nodes.has(id))nodes.set(id,{id,value:'',innerHTML:'',textContent:'',hidden:false,disabled:false,attributes:{},classList:{add(){},remove(){}},scrollIntoView(){this.scrolled=true},focus(){this.focused=true},setAttribute(k,v){this.attributes[k]=v},removeAttribute(k){delete this.attributes[k]}});return nodes.get(id);};
 const ctx=vm.createContext({URLSearchParams,location:{search:''},Date,window:{},document:{getElementById:node,querySelectorAll:()=>[],activeElement:{tagName:'BODY'},addEventListener(){}},setInterval(){},apiRequest:async(path,options)=>{
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
 const h=submissionHarness({reject:true});await new Promise(r=>setImmediate(r));h.fill();h.node('fEnd').value='2026-10-07';h.node('fEnd').oninput();assert.equal(h.node('fDays').value,'2');
 await h.submit();assert.equal(h.calls.length,1);assert.equal(h.node('fReason').value,'เหตุผลทดสอบ');assert.equal(h.node('submitBtn').disabled,false);assert.match(h.node('submitError').textContent,/ฐานข้อมูลไม่พร้อม/);assert.equal(h.node('submitError').scrolled,true);
});
test('saved request stays successful if refreshing the registry fails, so users are not told to submit a duplicate',async()=>{
 const h=submissionHarness({reloadFails:true});await new Promise(r=>setImmediate(r));h.fill();await h.submit();
 assert.equal(h.calls.length,1);assert.equal(h.calls[0].leave_days,0.5);assert.equal(h.node('fReason').value,'');assert.equal(h.node('successBox').hidden,false);assert.match(h.node('errorBox').textContent,/บันทึกใบลาสำเร็จแล้ว/);assert.equal(h.node('submitError').hidden,true);assert.equal(h.node('submitBtn').disabled,false);
});
