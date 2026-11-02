import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function page(){
 const outputs=[],messages=[];
 const context=vm.createContext({document:{addEventListener(){}},URLSearchParams,location:{search:''}});
 vm.runInContext(fs.readFileSync(new URL('../public/js/supervision-ui.js',import.meta.url),'utf8'),context);
 context.SupervisionUI.output=(...args)=>outputs.push(args);
 context.SupervisionUI.toast=(...args)=>messages.push(args);
 const html=fs.readFileSync(new URL('../public/supervision-admin.html',import.meta.url),'utf8');
 const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
 new vm.Script(script); // Validate the complete page script, including initialization.
 vm.runInContext(script.slice(0,script.lastIndexOf('(async()=>{'))+
  'globalThis.page={state,scheduledRequests,calendarHtml,printDoc,printCard};})();',context);
 return {...context.page,outputs,messages};
}
const request=(id,date,period,teacher,status='confirmed')=>({id,visit_date:date,period,teacher_user_id:teacher,teacher_name:`ครู ${teacher}`,subject:'ไทย <พื้นฐาน>',grade_level:'ป.1',classroom:'1',status});

test('combined schedule includes appointments across weeks and years, in date and period order, in both exports',async()=>{
 const p=page();
 p.state.list=[request(1,'2031-01-06',2,1),request(2,'2030-12-23',3,2,'pending'),request(3,'2030-12-23',1,1,'evaluated'),request(4,'2030-12-30',1,2,'cancelled')];
 assert.deepEqual(Array.from(p.scheduledRequests(),r=>r.id),[3,2,1]);
 const screen=await p.calendarHtml();
 assert.match(screen,/2 วัน · 3 รายการ/);
 assert.match(screen,/2030-12-23\|1/);
 assert.match(screen,/2031-01-06\|2/);
 assert.doesNotMatch(screen,/data-calweek|สัปดาห์/);
 for(const kind of ['pdf','word']){
  p.printDoc('schedule',kind);
  const [format,,body,options]=p.outputs.at(-1);
  assert.equal(format,kind);
  assert.equal(options.landscape,true);
  assert.equal((body.match(/<table/g)||[]).length,1);
  assert.equal((body.match(/<tr>/g)||[]).length,4);
  assert.match(body,/ยืนยันนัดหมายแล้ว/);
  assert.match(body,/รอผู้บริหารรับนิเทศ/);
  assert.match(body,/ประเมินแล้ว/);
  assert.match(body,/ไทย &lt;พื้นฐาน&gt;/);
  assert.doesNotMatch(body,/data-calslot|cancelled/);
 }
 p.state.teacher='1';
 assert.deepEqual(Array.from(p.scheduledRequests(),r=>r.id),[3,1]);
 p.printDoc('schedule','word');
 assert.doesNotMatch(p.outputs.at(-1)[2],/ครู 2/);
 p.state.list=[];
 assert.match(await p.calendarHtml(),/ยังไม่มีนัดนิเทศ/);
 const count=p.outputs.length;
 p.printDoc('schedule','pdf');
 assert.equal(p.outputs.length,count);
 assert.equal(p.messages.length,1);
 assert.match(p.printCard(0),/data-doc="schedule" data-kind="pdf" disabled/);
});
