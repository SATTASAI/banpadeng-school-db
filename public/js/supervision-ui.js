/* ส่วนร่วมของหน้าลงทะเบียนนิเทศ (ครู) และหน้านิเทศการสอน (ฝ่ายบริหาร) */
(function(root){
 'use strict';
 const STATUS={pending:'รอผู้บริหารรับนิเทศ',confirmed:'ยืนยันนัดหมายแล้ว',evaluated:'ประเมินแล้ว'};
 const DAYS=['','จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์'];
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
 const parse=s=>{const [y,m,d]=String(s).split('-').map(Number);return new Date(y,m-1,d);};
 const date=(s,long)=>parse(s).toLocaleDateString('th-TH',long?{weekday:'long',day:'numeric',month:'long',year:'numeric'}:{weekday:'short',day:'numeric',month:'short',year:'2-digit'});
 const shortDate=s=>parse(s).toLocaleDateString('th-TH',{day:'numeric',month:'short'});
 // เวลาจาก D1 เป็น UTC รูปแบบ "YYYY-MM-DD HH:MM:SS"
 const stamp=s=>{if(!s)return '—';const d=new Date(String(s).replace(' ','T')+'Z');return d.toLocaleString('th-TH',{timeZone:'Asia/Bangkok',day:'numeric',month:'short',year:'2-digit',hour:'2-digit',minute:'2-digit'})+' น.';};
 const pill=s=>`<span class="sv-pill st-${esc(s)}">${esc(STATUS[s]||s)}</span>`;
 // เลยวันนิเทศแล้วแต่ยังไม่มีผล
 const overdue=r=>r?.overdue?`<span class="sv-pill sv-overdue">${r.status==='confirmed'?'ค้างบันทึกคะแนน':'เลยกำหนด ไม่มีผู้รับนิเทศ'}</span>`:'';
 const classLabel=r=>[r.grade_level,r.classroom].filter(Boolean).join('/')+(r.room_name?` · ${r.room_name}`:'');
 const level=p=>p>=90?'ดีเยี่ยม':p>=80?'ดีมาก':p>=70?'ดี':p>=60?'พอใช้':'ควรพัฒนา';
 const pct=n=>Number(n).toLocaleString('th-TH',{minimumFractionDigits:2,maximumFractionDigits:2});
 function stats(list){
  const c={all:list.length,pending:0,confirmed:0,evaluated:0,overdue:0};list.forEach(r=>{if(c[r.status]!=null)c[r.status]++;if(r.overdue)c.overdue++;});
  const card=(l,v,color)=>`<div class="sv-stat"><span><i style="background:${color}"></i>${l}</span><b>${v}</b></div>`;
  return `<div class="sv-stats">${card('ลงทะเบียนทั้งหมด',c.all,'#8aa0b4')}${card('รอยืนยัน',c.pending,'#d98a1f')}${card('ยืนยันแล้ว',c.confirmed,'#2B86E5')}${card('ประเมินเสร็จ',c.evaluated,'#187E6B')}${c.overdue?card('ค้าง/เลยกำหนด',c.overdue,'#c8483d'):''}</div>`;
 }
 function details(r,{times}={}){
  const t=times?.[r.period-1];
  return `<dl class="sv-dl"><dt>ครู</dt><dd>${esc(r.teacher_name)}</dd><dt>วันที่</dt><dd>${date(r.visit_date,true)}</dd>
  <dt>คาบ</dt><dd>คาบ ${r.period}${t?` (${t.start}–${t.end} น.)`:''}</dd><dt>วิชา</dt><dd>${esc(r.subject)}</dd><dt>ชั้น/ห้อง</dt><dd>${esc(classLabel(r))||'—'}</dd>
  <dt>ประเภท</dt><dd>${esc(r.type_label)}</dd><dt>สถานะ</dt><dd>${pill(r.status)} ${overdue(r)}</dd>
  ${r.supervisor_name?`<dt>ผู้นิเทศ</dt><dd>${esc(r.supervisor_name)}${r.supervisor_position?` (${esc(r.supervisor_position)})`:''}</dd>`:''}
  <dt>หัวข้อ</dt><dd>${r.topic?esc(r.topic):'<span style="color:#8aa0b4">ไม่ได้ระบุ</span>'}</dd></dl>`;
 }
 function result(r,focus){
  const e=r.evaluation;if(!e)return '';
  return `<article class="sv-res${focus?' focus':''}" id="r-${r.id}"><div class="sv-res-head"><div><h2>${esc(r.teacher_name)}</h2>
   <div style="color:#607991;font-size:14px">${date(r.visit_date,true)} · คาบ ${r.period}</div>
   <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px"><span class="sv-tag">${esc(r.type_label)}</span><span class="sv-tag">${esc(r.subject)}</span>${classLabel(r)?`<span class="sv-tag">${esc(classLabel(r))}</span>`:''}</div></div>
   <div class="sv-res-score"><b>${pct(e.percent)}%</b><div class="lv lv-${esc(e.level)}">${esc(e.level)}</div><div style="color:#607991;font-size:13px">คะแนนรวม ${e.total} / 25</div></div></div>
   <div class="sv-res-body"><div>${e.items.map((it,i)=>`${it.section&&it.section!==e.items[i-1]?.section?`<div style="font-weight:600;color:#163e67;margin:8px 0 2px">${esc(it.section)}</div>`:''}<div class="sv-sc"><span>${i+1}. ${esc(it.label)}</span><span class="sv-dots" aria-label="${it.score} จาก 5">${[1,2,3,4,5].map(v=>`<i${v<=it.score?' class="on"':''}></i>`).join('')}</span><b>${it.score}</b></div>`).join('')}</div>
   <div><div style="font-weight:600;color:#33506b;margin-bottom:6px">ข้อเสนอแนะเพื่อพัฒนา</div><div class="sv-sugg">${e.suggestion?esc(e.suggestion):'<span style="color:#8aa0b4">ผู้นิเทศไม่ได้ระบุข้อเสนอแนะ</span>'}</div>
   ${r.topic?`<p class="sv-hint" style="margin-top:10px">หัวข้อที่ครูขอรับข้อเสนอแนะ: ${esc(r.topic)}</p>`:''}</div></div>
   <div class="sv-res-foot"><span>ผู้นิเทศ: ${esc(e.evaluator_name)}${e.evaluator_position?` (${esc(e.evaluator_position)})`:''}</span><span>บันทึกผลเมื่อ ${stamp(e.evaluated_at)}</span></div></article>`;
 }
 function modal(html){
  close();const wrap=document.createElement('div');wrap.className='sv-overlay';wrap.id='svModal';
  wrap.innerHTML=`<div class="sv-modal" role="dialog" aria-modal="true">${html}</div>`;
  wrap.addEventListener('click',e=>{if(e.target===wrap||e.target.closest('[data-close]'))close();});
  document.body.appendChild(wrap);(wrap.querySelector('[data-autofocus]')||wrap.querySelector('button'))?.focus();return wrap;
 }
 function close(){document.getElementById('svModal')?.remove();}
 document.addEventListener('keydown',e=>{if(e.key==='Escape')close();});
 function toast(message,error){
  let box=document.querySelector('.sv-toasts');if(!box){box=document.createElement('div');box.className='sv-toasts';box.setAttribute('aria-live','polite');document.body.appendChild(box);}
  const t=document.createElement('div');t.className='sv-toast'+(error?' err':'');t.textContent=message;box.appendChild(t);
  while(box.children.length>3)box.firstChild.remove();setTimeout(()=>t.remove(),error?5500:3800);
 }
 root.SupervisionUI={STATUS,DAYS,esc,date,shortDate,stamp,pill,overdue,classLabel,level,pct,stats,details,result,modal,close,toast,parse};
})(typeof window==='undefined'?globalThis:window);
