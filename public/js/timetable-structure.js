(()=>{'use strict';
const $=id=>document.getElementById(id),days=['จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์'],P=[1,2,3,4,5,6];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const BANDS={lower:'ป.ต้น (ป.1–3)',upper:'ป.ปลาย (ป.4–6)'};
let years=[],data=null,need={lower:0,upper:0},dirty=false;
const bandOf=g=>{const m=String(g||'').normalize('NFC').replace(/\s+/g,'').match(/^(?:ป\.?|ประถมศึกษาปีที่)([1-6])$/);return m?(Number(m[1])<=3?'lower':'upper'):null;};
function notice(m,err=false){$('notice').textContent=m;$('notice').classList.toggle('error',err);}
async function api(path,opt){try{return await apiRequest(path,opt);}catch(e){if(e.status===401)location.href='/login.html';throw e;}}
const DEFAULT={times:[['08:30','09:30'],['09:30','10:30'],['10:30','11:30'],['12:30','13:30'],['13:30','14:30'],['14:30','15:30']].map(([start,end])=>({start,end})),lunch:{start:'11:30',end:'12:30'},
 bands:Object.fromEntries(['lower','upper'].map(b=>[b,[[2,6,'โครงงานคุณธรรม'],[3,6,'ลดเวลาเรียน เพิ่มเวลารู้'],[4,6,'ลูกเสือ/เนตรนารี'],[5,6,'แนะแนว']].map(([weekday,period,name])=>({weekday,period,name}))]))};
function renderTimes(st){
 const t=(cls,p,v,l)=>`<input type="time" class="${cls}" data-p="${p}" value="${esc(v)}" aria-label="${l}">`;
 $('times').innerHTML=P.map(p=>(p===4?`<label class="lunch-box">พักกลางวัน<span class="times">${t('ls',0,st.lunch.start,'เริ่มพักกลางวัน')}–${t('le',0,st.lunch.end,'สิ้นสุดพักกลางวัน')}</span></label>`:'')+`<label>คาบ ${p}<span class="times">${t('ts',p,st.times[p-1].start,`เริ่มคาบ ${p}`)}–${t('te',p,st.times[p-1].end,`สิ้นสุดคาบ ${p}`)}</span></label>`).join('');
}
function renderBands(st,canEdit){
 $('bands').innerHTML=Object.entries(BANDS).map(([b,label])=>`<div class="band" data-band="${b}"><h3>${label} <span class="hint" data-count></span></h3><div class="scroll"><table class="structure"><thead><tr><th>วัน</th>${P.map(p=>(p===4?'<th class="lunch">พัก</th>':'')+`<th>คาบ ${p}<small>${esc(st.times[p-1].start.replace(':','.'))}–${esc(st.times[p-1].end.replace(':','.'))}</small></th>`).join('')}</tr></thead><tbody>${days.map((d,i)=>`<tr><td>${d}</td>${P.map(p=>{const n=(st.bands?.[b]||[]).find(a=>a.weekday===i+1&&a.period===p)?.name||'';return (p===4?'<td class="lunch"></td>':'')+`<td class="cell${n?' on':''}"><input list="actNames" maxlength="60" data-d="${i+1}" data-p="${p}" value="${esc(n)}" placeholder="รายวิชา" aria-label="${label} วัน${d} คาบ ${p}" ${canEdit?'':'disabled'}></td>`;}).join('')}</tr>`).join('')}</tbody></table></div></div>`).join('');
 counts();
}
function counts(){for(const el of $('bands').querySelectorAll('.band')){const b=el.dataset.band,acts=[...el.querySelectorAll('input')].filter(i=>i.value.trim()).length,slots=30-acts;el.querySelector('[data-count]').innerHTML=`ช่องรายวิชา ${slots} คาบ/สัปดาห์ · กิจกรรม ${acts} คาบ${need[b]?` · ภาระสอนรายวิชาจากฝ่ายวัดผล สูงสุด ${need[b]} คาบ/ห้อง${need[b]>slots?` <strong class="warn">— ช่องรายวิชาไม่พอ ${need[b]-slots} คาบ</strong>`:''}`:''}`;}
 for(const td of $('bands').querySelectorAll('td.cell'))td.classList.toggle('on',!!td.querySelector('input').value.trim());}
function read(){
 const v=(c,p)=>$('times').querySelector(`.${c}[data-p="${p}"]`).value;
 return {times:P.map(p=>({start:v('ts',p),end:v('te',p)})),lunch:{start:v('ls',0),end:v('le',0)},
  bands:Object.fromEntries([...$('bands').querySelectorAll('.band')].map(el=>[el.dataset.band,[...el.querySelectorAll('input')].filter(i=>i.value.trim()).map(i=>({weekday:Number(i.dataset.d),period:Number(i.dataset.p),name:i.value.trim()}))]))};
}
function show(st){renderTimes(st);renderBands(st,data.can_edit);$('save').hidden=$('copyBand').hidden=$('reset').hidden=!data.can_edit;dirty=false;}
async function load(){
 $('controls').disabled=true;notice('กำลังโหลดโครงเวลาเรียน…');
 try{
  const term=$('term').value;data=await api(`/api/timetable/structure?term_id=${term}`);
  need={lower:0,upper:0};
  try{const s=await api(`/api/timetable/setup?term_id=${term}`);const per=new Map();for(const c of s.master?.courses||[]){const k=`${c.grade_level}/${c.classroom}`;per.set(k,(per.get(k)||0)+c.periods_per_week);const b=bandOf(c.grade_level);if(b)need[b]=Math.max(need[b],per.get(k));}}catch{}
  show(data.structure);
  $('savedInfo').textContent=data.saved?`บันทึกล่าสุด ${data.updated_at||''}${data.updated_by_name?` โดย ${data.updated_by_name}`:''}`:'ยังไม่เคยบันทึกสำหรับภาคเรียนนี้ — แสดงค่าเริ่มต้น';
  notice(data.can_edit?'แก้ไขได้ — ช่องสีส้มคือคาบกิจกรรมที่ล็อกไว้ ช่องว่างคือคาบรายวิชา':'ดูได้อย่างเดียว — แก้ได้เฉพาะฝ่ายวัดผล ฝ่ายวิชาการ หรือผู้ดูแลระบบ');
 }catch(e){notice(e.message,true);}finally{$('controls').disabled=false;}
}
$('bands').addEventListener('input',()=>{dirty=true;counts();});$('times').addEventListener('change',()=>{dirty=true;});
$('copyBand').onclick=()=>{const st=read();st.bands.upper=st.bands.lower.map(a=>({...a}));renderBands(st,true);dirty=true;notice('คัดลอกแล้ว ยังไม่บันทึก');};
$('reset').onclick=()=>{renderTimes(DEFAULT);renderBands(DEFAULT,true);dirty=true;notice('คืนค่าเริ่มต้นแล้ว ยังไม่บันทึก');};
$('save').onclick=async()=>{$('controls').disabled=true;try{const r=await api('/api/timetable/structure',{method:'PUT',body:{term_id:Number($('term').value),structure:read()}});data.structure=r.structure;show(r.structure);$('savedInfo').textContent='บันทึกแล้ว';notice('บันทึกโครงเวลาเรียนแล้ว — การจัดตารางอัตโนมัติครั้งถัดไปจะเว้นคาบกิจกรรมตามนี้');}catch(e){notice(e.message,true);}finally{$('controls').disabled=false;}};
$('year').onchange=()=>{$('term').innerHTML=(years.find(y=>y.id===Number($('year').value))?.terms||[]).map(t=>`<option value="${t.id}">${esc(t.name)}</option>`).join('');load();};
$('term').onchange=load;
window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
(async()=>{try{const d=await api('/api/timetable/periods');years=d.years||[];if(!years.length)throw Error('ยังไม่มีปีการศึกษา');$('year').innerHTML=years.map(y=>`<option value="${y.id}">ปีการศึกษา ${y.year_be}</option>`).join('');const y=years.find(y=>y.status==='active')||years[0];$('year').value=y.id;
 const want=Number(new URLSearchParams(location.search).get('term_id'));$('term').innerHTML=y.terms.map(t=>`<option value="${t.id}">${esc(t.name)}</option>`).join('');const pick=y.terms.find(t=>t.id===want)||y.terms.find(t=>t.status==='active')||y.terms[0];if(pick)$('term').value=pick.id;await load();}catch(e){notice(e.message,true);}})();
})();
