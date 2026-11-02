import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('kindergarten manual booking shows selectable periods and only kindergarten grades in the existing form',async()=>{
 const view={innerHTML:''},modals=[];
 const context=vm.createContext({URLSearchParams,location:{search:''},document:{addEventListener(){},getElementById:()=>view}});
 vm.runInContext(fs.readFileSync(new URL('../public/js/supervision-ui.js',import.meta.url),'utf8'),context);
 context.SupervisionUI.modal=html=>{modals.push(html);return {querySelector:()=>({})};};
 const html=fs.readFileSync(new URL('../public/supervision.html',import.meta.url),'utf8');
 const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];new vm.Script(script);
 const week={start:'2030-01-07',now:{date:'2030-01-01',minutes:0},closed:false,linked:true,full:[],taken:{},requests:[],
  days:[7,8,9,10,11].map((d,i)=>({date:`2030-01-${String(d).padStart(2,'0')}`,weekday:i+1,term_id:90})),
  terms:[{id:90,mode:'manual',kindergarten_manual:true,lessons:[],times:Array.from({length:6},()=>({start:'09:00',end:'10:00'}))}]};
 context.apiRequest=async()=>week;
 vm.runInContext(script.slice(0,script.lastIndexOf('(async()=>{'))+'globalThis.page={state,renderRegister,openBook};})();',context);
 const p=context.page;await p.renderRegister();
 assert.equal((view.innerHTML.match(/data-book=/g)||[]).length,30);
 assert.match(view.innerHTML,/ครูอนุบาลที่ไม่มีตารางสอน/);
 assert.doesNotMatch(view.innerHTML,/ภาคเรียนนี้ยังไม่มีตารางสอนที่เผยแพร่/);
 p.openBook('2030-01-07',2);
 assert.match(modals[0],/<option>อ\.1<\/option>/);assert.match(modals[0],/<option>อ\.3<\/option>/);
 assert.doesNotMatch(modals[0],/<option>ป\./);
 assert.match(modals[0],/bSubject/);assert.match(modals[0],/ยืนยันลงทะเบียน/);
 // Primary teachers without a lesson in a published plan get no manual booking slots.
 week.terms[0].mode='timetable';week.terms[0].kindergarten_manual=false;
 await p.renderRegister();assert.doesNotMatch(view.innerHTML,/data-book=/);
});
