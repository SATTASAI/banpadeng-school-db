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
