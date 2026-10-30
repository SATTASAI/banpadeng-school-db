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
 // ช่วงชั้น: อนุบาล (เขียว) · ป.1–3 (ฟ้า) · ป.4–6 (ม่วง)
 const BANDS={k:'อนุบาล',p13:'ป.1–3',p46:'ป.4–6'};
 function bandOf(grade){
  const g=String(grade||'').replace(/\s+/g,'');
  if(/^(อ\.?\d|อนุบาล|K\d?)/i.test(g))return 'k';
  const m=g.match(/^(?:ป\.?|ประถม(?:ศึกษา)?(?:ปีที่)?|P)(\d)/i);if(!m)return null;const n=Number(m[1]);
  return n>=1&&n<=3?'p13':n>=4&&n<=6?'p46':null;
 }
 const bandKey=r=>r?.grade_band||bandOf(r?.grade_level);
 const bandTag=r=>{const b=bandKey(r);return b?`<span class="sv-band b-${b}">${BANDS[b]}</span>`:'';};
 const bandLegend=()=>`<div class="sv-legend">${Object.entries(BANDS).map(([k,l])=>`<span><i class="sv-bdot b-${k}"></i>${l}</span>`).join('')}</div>`;
 const classLabel=r=>[r.grade_level,r.classroom].filter(Boolean).join('/')+(r.room_name?` · ${r.room_name}`:'');
 const level=p=>p>=90?'ดีเยี่ยม':p>=80?'ดีมาก':p>=70?'ดี':p>=60?'พอใช้':'ปรับปรุง';
 const pct=n=>Number(n).toLocaleString('th-TH',{minimumFractionDigits:2,maximumFractionDigits:2});
 function stats(list){
  const c={all:list.length,pending:0,confirmed:0,evaluated:0,overdue:0};list.forEach(r=>{if(c[r.status]!=null)c[r.status]++;if(r.overdue)c.overdue++;});
  const card=(l,v,color)=>`<div class="sv-stat"><span><i style="background:${color}"></i>${l}</span><b>${v}</b></div>`;
  return `<div class="sv-stats">${card('ลงทะเบียนทั้งหมด',c.all,'#8aa0b4')}${card('รอยืนยัน',c.pending,'#d98a1f')}${card('ยืนยันแล้ว',c.confirmed,'#2B86E5')}${card('ประเมินเสร็จ',c.evaluated,'#187E6B')}${c.overdue?card('ค้าง/เลยกำหนด',c.overdue,'#c8483d'):''}</div>`;
 }
 function details(r,{times}={}){
  const t=times?.[r.period-1];
  return `<dl class="sv-dl"><dt>ครู</dt><dd>${esc(r.teacher_name)}</dd><dt>วันที่</dt><dd>${date(r.visit_date,true)}</dd>
  <dt>คาบ</dt><dd>คาบ ${r.period}${t?` (${t.start}–${t.end} น.)`:''}</dd><dt>วิชา</dt><dd>${esc(r.subject)}</dd><dt>ชั้น/ห้อง</dt><dd>${esc(classLabel(r))||'—'} ${bandTag(r)}</dd>
  <dt>ประเภท</dt><dd>${esc(r.type_label)}</dd><dt>สถานะ</dt><dd>${pill(r.status)} ${overdue(r)}</dd>
  ${r.supervisor_name?`<dt>ผู้นิเทศ</dt><dd>${esc(r.supervisor_name)}${r.supervisor_position?` (${esc(r.supervisor_position)})`:''}</dd>`:''}
  <dt>หัวข้อ</dt><dd>${r.topic?esc(r.topic):'<span style="color:#8aa0b4">ไม่ได้ระบุ</span>'}</dd></dl>${evidence(r)}`;
 }
 // ผู้ประเมินแจ้งไม่ว่างไปนิเทศ → ครูส่งลิงก์คลิปและภาพแทน
 const safeUrl=u=>/^https?:\/\//i.test(String(u||''))?esc(u):'#';
 function evidenceTag(r){
  if(!r?.evidence||r.status==='evaluated')return '';
  if(r.evidence.submitted_at)return '<span class="sv-pill sv-ev done">ส่งคลิปและภาพแล้ว</span>';
  return r.evidence.late?`<span class="sv-pill sv-overdue">เลยกำหนดส่งคลิปและภาพ (${shortDate(r.evidence.due_date)})</span>`
   :`<span class="sv-pill sv-ev">ผู้ประเมินไม่ว่าง · รอครูส่งคลิปและภาพ${r.evidence.due_date?` ภายใน ${shortDate(r.evidence.due_date)}`:''}</span>`;
 }
 function evidence(r,{deletable}={}){
  const e=r?.evidence;if(!e)return '';
  const imgs=e.files.map(f=>`<figure class="sv-thumb"><a href="${esc(f.url)}" target="_blank" rel="noopener"><img src="${esc(f.url)}" alt="${esc(f.file_name)}" loading="lazy"></a>${deletable?`<button type="button" class="sv-thumb-del" data-ev-del="${f.id}" aria-label="ลบภาพ">×</button>`:''}</figure>`).join('');
  return `<div class="sv-evidence"><div class="sv-ev-head"><b>หลักฐานแทนการนิเทศในห้องเรียน</b><small>ผู้ประเมินแจ้งไม่ว่างไปนิเทศ ${stamp(e.requested_at)}</small></div>
   ${e.note?`<div class="sv-hint">หมายเหตุจากผู้ประเมิน: ${esc(e.note)}</div>`:''}
   <div><span class="sv-hint">คลิปการสอน:</span> ${e.video_url?`<a href="${safeUrl(e.video_url)}" target="_blank" rel="noopener noreferrer">${esc(e.video_url)}</a>`:'<span style="color:#8aa0b4">ยังไม่ได้ส่ง</span>'}</div>
   <div><span class="sv-hint">ภาพการสอน/สื่อการสอน (${e.files.length}/10)</span>${imgs?`<div class="sv-thumbs">${imgs}</div>`:' <span style="color:#8aa0b4">ยังไม่มีภาพ</span>'}</div>
   ${e.submitted_at?`<small class="sv-hint">ครูส่งหลักฐานเมื่อ ${stamp(e.submitted_at)}</small>`:e.due_date?`<small class="sv-hint">กำหนดส่ง ${date(e.due_date,true)}</small>`:''}</div>`;
 }
 function result(r,focus,{word}={}){
  const e=r.evaluation;if(!e)return '';
  return `<article class="sv-res${focus?' focus':''}" id="r-${r.id}"><div class="sv-res-head"><div><h2>${esc(r.teacher_name)}</h2>
   <div style="color:#607991;font-size:14px">${date(r.visit_date,true)} · คาบ ${r.period}</div>
   <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px"><span class="sv-tag">${esc(r.type_label)}</span><span class="sv-tag">${esc(r.subject)}</span>${classLabel(r)?`<span class="sv-tag">${esc(classLabel(r))}</span>`:''}</div></div>
   <div class="sv-res-score"><b>${pct(e.percent)}%</b><div class="lv lv-${esc(e.level)}">${esc(e.level)}</div><div style="color:#607991;font-size:13px">คะแนนรวม ${e.total} / ${e.items.reduce((a,it)=>a+(Number(it.max)||5),0)}</div></div></div>
   <div class="sv-res-body"><div>${e.items.map((it,i)=>{const prev=e.items[i-1],mx=Number(it.max)||5,no=prev&&prev.section===it.section&&prev.group===it.group?(e._n=(e._n||1)+1):(e._n=1);
    return `${it.section&&it.section!==prev?.section?`<div style="font-weight:600;color:#163e67;margin:10px 0 2px">${esc(it.section)}</div>`:''}${it.group&&it.group!==prev?.group?`<div style="font-weight:600;color:#33506b;font-size:13.5px;margin:6px 0 2px">${esc(it.group)}</div>`:''}
    <div class="sv-sc"><span>${no}. ${esc(it.label)}</span>${mx===2&&it.group?`<span class="sv-done ${Number(it.score)?'on':''}">${Number(it.score)?'✓ ปฏิบัติ':'✗ ไม่ปฏิบัติ'}</span>`:`<span class="sv-dots" aria-label="${it.score} จาก ${mx}">${Array.from({length:mx},(_,k)=>`<i${k+1<=it.score?' class="on"':''}></i>`).join('')}</span>`}<b>${it.score}</b></div>`;}).join('')}</div>
   <div><div style="font-weight:600;color:#33506b;margin-bottom:6px">ข้อเสนอแนะเพื่อพัฒนา</div><div class="sv-sugg">${e.suggestion?esc(e.suggestion):'<span style="color:#8aa0b4">ผู้นิเทศไม่ได้ระบุข้อเสนอแนะ</span>'}</div>
   ${r.topic?`<p class="sv-hint" style="margin-top:10px">หัวข้อที่ครูขอรับข้อเสนอแนะ: ${esc(r.topic)}</p>`:''}</div></div>
   <div class="sv-res-foot"><span>ผู้นิเทศ: ${esc(e.evaluator_name)}${e.evaluator_position?` (${esc(e.evaluator_position)})`:''}</span><span>บันทึกผลเมื่อ ${stamp(e.evaluated_at)}</span><button type="button" class="sv-btn sm" data-print="${r.id}">พิมพ์แบบนิเทศ${word?' (PDF)':''}</button>${word?`<button type="button" class="sv-btn sm" data-print-word="${r.id}">Word</button>`:''}</div></article>`;
 }
 // ---------- เอกสารพิมพ์: PDF (หน้าต่างพิมพ์ → บันทึกเป็น PDF) และ Word (.doc) ----------
 const TH=n=>String(n).replace(/\d/g,d=>'๐๑๒๓๔๕๖๗๘๙'[d]);
 const DOC_CSS=`body{font-family:'TH Sarabun New','Sarabun',sans-serif;font-size:14px;line-height:1.35;color:#000;margin:0}
h1{text-align:center;font-size:20px;margin:0 0 4px}.c{text-align:center}.r{text-align:right}.info{line-height:1.9}.u{border-bottom:1px dotted #000;padding:0 6px}
table{width:100%;border-collapse:collapse;margin:6px 0}th,td{border:1px solid #000;padding:1px 6px;vertical-align:top}th{background:#f2f2f2}
td.sec{font-weight:700;background:#fafafa}.w{width:44px}.wn{width:70px}.note{width:70px}.brk{break-before:page;page-break-before:always;margin:0;height:0}
table.sign{margin-top:18px;page-break-inside:avoid;break-inside:avoid}table.sign td{border:0;text-align:center;line-height:1.8;padding:0 4px}
table.crit{width:auto;margin:2px 0}table.crit td{border:0;padding:0 8px 0 0;font-size:13px}.sugg{border:1px solid #000;min-height:56px;padding:6px;white-space:pre-wrap}
table.list th,table.list td{font-size:13px}table.wk td{height:58px;font-size:12.5px}table.wk .it{margin-bottom:3px}table.wk .off{color:#666;text-align:center}.sm{font-size:12px;color:#333}`;
 const WORD_CSS=`body{font-family:'TH Sarabun New';font-size:15pt}h1{font-size:20pt}th,td{font-size:14pt}table.list th,table.list td{font-size:13pt}table.wk td{font-size:12pt}table.crit td{font-size:13pt}.sm{font-size:12pt}`;
 function output(kind,title,body,{landscape}={}){
  if(kind==='word'){
   const size=landscape?'29.7cm 21cm':'21cm 29.7cm';
   const html=`<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"><title>${esc(title)}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->
<style>@page Section1{size:${size};margin:1.4cm 1.5cm;mso-page-orientation:${landscape?'landscape':'portrait'}}div.Section1{page:Section1}${DOC_CSS}${WORD_CSS}</style></head><body><div class="Section1">${body}</div></body></html>`;
   const blob=new Blob(['﻿'+html],{type:'application/msword'}),a=document.createElement('a');
   a.href=URL.createObjectURL(blob);a.download=title.replace(/[\\/:*?"<>|]+/g,'-')+'.doc';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
   return;
  }
  const html=`<!doctype html><html lang="th"><head><meta charset="utf-8"><title>${esc(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;700&display=swap" rel="stylesheet">
<style>@page{size:A4 ${landscape?'landscape':'portrait'};margin:14mm 15mm}${DOC_CSS}@media screen{body{padding:20px;max-width:${landscape?1120:820}px;margin:auto}}</style></head><body>${body}
<script>document.fonts&&document.fonts.ready.then(()=>setTimeout(()=>print(),200));<\/script></body></html>`;
  const w=window.open('','_blank');if(!w){toast('เบราว์เซอร์บล็อกหน้าต่างพิมพ์ กรุณาอนุญาตป๊อปอัป',true);return;}
  w.document.open();w.document.write(html);w.document.close();
 }
 const BRK='<div class="brk"></div>';
 // แบบนิเทศการสอนตามแบบฟอร์มโรงเรียน (ช่องลงชื่อผู้รับการนิเทศ/ผู้นิเทศ)
 function formBody(r,{round,director}={}){
  const e=r.evaluation;if(!e)return '';
  const it=e.items,rate=it.filter(x=>!x.group),env=it.filter(x=>x.group);
  const tick=(x,v)=>Number(x.score)===v?'✓':'';
  let n=0,rows3='',prev=null;
  rate.forEach(x=>{if(x.section!==prev){rows3+=`<tr><td colspan="5" class="sec">${esc(x.section)}</td></tr>`;prev=x.section;n=0;}n++;
   rows3+=`<tr><td>${n}. ${esc(x.label)}</td><td class="c">${tick(x,3)}</td><td class="c">${tick(x,2)}</td><td class="c">${tick(x,1)}</td><td></td></tr>`;});
  let rows4='';prev=null;
  env.forEach(x=>{if(x.group!==prev){rows4+=`<tr><td colspan="4" class="sec">${esc(x.group)}</td></tr>`;prev=x.group;n=0;}n++;
   rows4+=`<tr><td>${n}. ${esc(x.label)}</td><td class="c">${tick(x,2)}</td><td class="c">${tick(x,0)}</td><td></td></tr>`;});
  const sum3=rate.reduce((a,x)=>a+Number(x.score),0),max3=rate.reduce((a,x)=>a+Number(x.max),0),sum4=env.reduce((a,x)=>a+Number(x.score),0),max4=env.reduce((a,x)=>a+Number(x.max),0);
  const d=parse(r.visit_date).toLocaleDateString('th-TH',{day:'numeric',month:'long',year:'numeric'});
  const levels=[['90 – 100','ดีเยี่ยม'],['80 – 89','ดีมาก'],['70 – 79','ดี'],['60 – 69','พอใช้'],['ต่ำกว่า 60','ปรับปรุง']];
  const sameDir=director&&director.name===e.evaluator_name;
  return `<h1>แบบนิเทศการสอน${round?` ครั้งที่ ${TH(round)}`:''}</h1>
<div class="c">ภาคเรียนที่ <span class="u">${r.term_number?TH(r.term_number):'&nbsp;&nbsp;&nbsp;'}</span> ปีการศึกษา <span class="u">${r.year_be?TH(r.year_be):'&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;'}</span></div>
<div class="info">ชื่อผู้รับการนิเทศการสอน <span class="u">${esc(r.teacher_name)}</span><br>
ชื่อวิชา <span class="u">${esc(r.subject)}</span> ระดับชั้น <span class="u">${esc(classLabel(r))||'-'}</span><br>
วันที่สอน <span class="u">${TH(d)}</span> คาบที่ <span class="u">${TH(r.period)}</span></div>
<p style="margin:4px 0">คำชี้แจง ทำเครื่องหมาย ✓ ในช่องระดับคะแนน เพื่อแสดงผลการปฏิบัติการสอนในสถานศึกษาของครู (๓ = ดีมาก, ๒ = พอใช้, ๑ = ควรปรับปรุง)</p>
<table><thead><tr><th rowspan="2">รายการวัดและประเมิน</th><th colspan="3">ระดับคะแนน</th><th rowspan="2" class="note">หมายเหตุ</th></tr><tr><th class="w">๓</th><th class="w">๒</th><th class="w">๑</th></tr></thead>
<tbody>${rows3}<tr><td class="c"><b>รวมด้านที่ ๑–๓</b></td><td colspan="4" class="c"><b>${TH(sum3)} / ${TH(max3)}</b></td></tr></tbody></table>
${BRK}
<table><thead><tr><th colspan="4" style="text-align:left">${esc(env[0]?.section||'')}</th></tr><tr><th>รายการประเมิน</th><th class="wn">ปฏิบัติ (๒)</th><th class="wn">ไม่ปฏิบัติ (๐)</th><th class="note">หมายเหตุ</th></tr></thead>
<tbody>${rows4}<tr><td class="c"><b>รวมด้านที่ ๔</b></td><td colspan="3" class="c"><b>${TH(sum4)} / ${TH(max4)}</b></td></tr></tbody></table>
<p style="margin:8px 0 2px"><b>สรุปผลการนิเทศ</b> คะแนนรวม <b>${TH(e.total)}</b> คะแนน จาก ${TH(max3+max4)} คะแนน ระดับคุณภาพ <b>${esc(e.level)}</b></p>
<table class="crit"><tr><td><b>เกณฑ์</b></td>${levels.map(([a,b])=>`<td>${TH(a)} = ${b}${b===e.level?' ✓':''}</td>`).join('')}</tr></table>
<p style="margin:8px 0 2px"><b>ข้อเสนอแนะของผู้นิเทศ</b></p><div class="sugg">${e.suggestion?esc(e.suggestion):''}</div>
<table class="sign"><tr><td>ลงชื่อ .................................<br>(${esc(r.teacher_name)})<br>ผู้รับการนิเทศ${r.teacher_position?` · ${esc(r.teacher_position)}`:''}</td>
<td>ลงชื่อ .................................<br>(${esc(e.evaluator_name)})<br>ผู้นิเทศ${e.evaluator_position?` · ${esc(e.evaluator_position)}`:''}</td>
${sameDir?'':`<td>ลงชื่อ .................................<br>(${director?esc(director.name):'.................................'})<br>${esc(director?.position||'ผู้อำนวยการโรงเรียนบ้านป่าเด็ง')}</td>`}</tr></table>`;
 }
 function printForm(r,opts={},kind='pdf'){
  if(!r?.evaluation)return;
  output(kind,`แบบนิเทศการสอน ${r.teacher_name}`,formBody(r,opts));
 }
 // รวมแบบนิเทศหลายรายการในไฟล์เดียว (ขึ้นหน้าใหม่ทุกคน) — roundOf(r) คืนครั้งที่นิเทศ
 function printForms(list,{director,roundOf,title}={},kind='pdf'){
  const rows=list.filter(r=>r.evaluation);if(!rows.length)return toast('ยังไม่มีผลการนิเทศให้พิมพ์',true);
  output(kind,title||'รวมแบบนิเทศการสอน',rows.map(r=>formBody(r,{director,round:roundOf?roundOf(r):null})).join(BRK));
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
 root.SupervisionUI={printForm,printForms,output,TH,BANDS,bandOf,bandKey,bandTag,bandLegend,evidence,evidenceTag,STATUS,DAYS,esc,date,shortDate,stamp,pill,overdue,classLabel,level,pct,stats,details,result,modal,close,toast,parse};
})(typeof window==='undefined'?globalThis:window);
