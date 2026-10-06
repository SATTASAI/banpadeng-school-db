(function(){
 'use strict';
 const $=id=>document.getElementById(id),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const types={sick:'ลาป่วย',personal:'ลากิจส่วนตัว',maternity:'ลาคลอดบุตร',lenient:'ลาอนุโลม',other:'อื่น ๆ'},stages={submitted:'รอหัวหน้าฝ่ายบุคลากรรับทราบ',acknowledged:'รับทราบและบันทึกแล้ว รอส่งต่อ',forwarded:'ส่งต่อผู้บริหารแล้ว',completed:'ดำเนินการเสร็จแล้ว'};
 let user,records=[],detailId=null,busy=false,first=true;
 function error(e){$('errorBox').textContent=e.message||String(e);$('errorBox').classList.add('visible');}
 function submitError(message,field){
  error(Error(message));$('successBox').hidden=true;
  $('submitError').textContent=message;$('submitError').hidden=false;
  const target=field?$(field):$('submitError');
  target.scrollIntoView({behavior:'smooth',block:'center'});
  if(field){target.setAttribute('aria-invalid','true');target.focus();}
 }
 function success(message){$('errorBox').classList.remove('visible');$('submitError').hidden=true;$('successBox').textContent=message;$('successBox').hidden=false;}
 function row(r){
  const actionable=r.can_acknowledge||r.can_record||r.can_review||r.can_decide;
  const note=r.can_review?r.reviewer_comment:r.personnel_note;
  return `<article class="leave-row ${r.status==='pending'?'pending':''}" id="leave-${Number(r.id)}">
   <h4>${esc(r.full_name)} · ${esc(types[r.leave_type])}</h4>
   <p>${esc(r.start_date)} ถึง ${esc(r.end_date)} · ${esc(r.leave_days??'')} วัน</p>
   <p>เหตุผล: ${esc(r.reason||'ยังไม่มีข้อมูลเหตุผลในรายการเดิม')}</p>
   <span class="leave-status">${esc(r.status==='approved'?'อนุญาตแล้ว':r.status==='rejected'?'ไม่อนุญาต':stages[r.workflow_stage]||'รอดำเนินการ')}</span>
   ${r.acknowledged_name?`<p class="muted">รับทราบโดย ${esc(r.acknowledged_name)} · ${esc(r.acknowledged_at)}</p>`:''}
   ${r.deputy_name?`<p class="muted">ส่งต่อ: ${esc(r.director_name)} และ ${esc(r.deputy_name)}</p>`:''}
   ${r.reviewer_comment?`<p>ความเห็นผู้บังคับบัญชา: ${esc(r.reviewer_comment)}</p>`:''}
   ${r.can_decide&&!r.reviewer_at?'<p class="muted">รอรองผู้บริหารบันทึกความเห็นก่อนออกคำสั่ง</p>':''}
   ${actionable?`<label for="note-${Number(r.id)}">${r.can_review?'ความเห็นผู้บังคับบัญชา':r.can_decide?'หมายเหตุคำสั่ง':'บันทึกหัวหน้าฝ่ายบุคลากร'}</label><textarea class="leave-note" id="note-${Number(r.id)}" rows="2" maxlength="2000">${esc(r.can_decide?r.decision_note||'':note||'')}</textarea>`:''}
   <div class="leave-actions">
    <button class="btn btn-ghost" data-detail="${Number(r.id)}">รายละเอียด / ใบลา</button>
    <button class="btn btn-ghost" data-export="docx" data-id="${Number(r.id)}">Word</button><button class="btn btn-ghost" data-export="pdf" data-id="${Number(r.id)}">PDF</button>
    ${r.can_acknowledge?`<button class="btn btn-primary" data-action="acknowledge" data-id="${Number(r.id)}">รับทราบและบันทึก</button>`:''}
    ${r.can_record?`<button class="btn btn-ghost" data-action="record" data-id="${Number(r.id)}">บันทึกข้อมูล</button>`:''}
    ${r.can_forward?`<button class="btn btn-primary" data-action="forward" data-id="${Number(r.id)}">ส่งต่อผู้บริหาร</button>`:''}
    ${r.can_review?`<button class="btn btn-primary" data-action="review" data-id="${Number(r.id)}">บันทึกความเห็น</button>`:''}
    ${r.can_decide&&r.reviewer_at?`<button class="btn btn-primary" data-action="approved" data-id="${Number(r.id)}">อนุญาต</button><button class="btn btn-ghost" data-action="rejected" data-id="${Number(r.id)}">ไม่อนุญาต</button>`:''}
    ${r.can_cancel?`<button class="btn btn-ghost" data-action="cancel" data-id="${Number(r.id)}">ยกเลิกคำขอ</button>`:''}
   </div></article>`;
 }
 async function load(){
  const data=await apiRequest('/api/leave-requests');records=data.leave_requests;
  const draftNotes=new Map([...document.querySelectorAll('.leave-note')].map(n=>[n.id,n.value]));
  const selected=$('deputyChoice').value||data.default_deputy_id||'';
  $('headSettings').hidden=!data.is_personnel_head;
  $('deputyChoice').innerHTML='<option value="">เลือกรองผู้บริหาร</option>'+data.deputy_choices.map(p=>`<option value="${Number(p.id)}">${esc(p.full_name)} · ${esc(p.position)}</option>`).join('');$('deputyChoice').value=String(selected);
  if(first){$('fPosition').value=data.profile.position||'';$('fPhone').value=data.profile.phone||'';}
  const pending=records.filter(r=>r.can_acknowledge||r.can_record||r.can_review||r.can_decide);
  $('pendingSection').hidden=!pending.length;$('pendingPanel').innerHTML=pending.map(row).join('');
  $('historyPanel').innerHTML=records.filter(r=>!pending.some(p=>p.id===r.id)).map(row).join('')||'<p class="leave-row muted">ยังไม่มีรายการ</p>';
  for(const [id,value] of draftNotes){const field=$(id);if(field)field.value=value;}
  if(first){first=false;const id=Number(new URLSearchParams(location.search).get('request'));if(records.some(r=>r.id===id))await details(id);}
 }
 async function details(id){
  const {leave_request:r,events}=await apiRequest('/api/leave-requests/'+id);detailId=id;
  $('detailSection').hidden=false;
  const last=r.last_leave;
  $('detailPanel').innerHTML=`<div class="leave-details">${[
   ['ชื่อ',r.full_name],['ตำแหน่ง',r.position],['วันที่เขียน',r.request_date],['ประเภท',types[r.leave_type]],['เหตุผล',r.reason||'—'],['วันลา',`${r.start_date} ถึง ${r.end_date} (${r.leave_days} วัน)`],['ที่อยู่ระหว่างลา',r.contact_address||'—'],['เบอร์ติดต่อ',r.contact_phone||'—'],['การลาครั้งล่าสุด',last?`${types[last.leave_type]} ${last.start_date} ถึง ${last.end_date}`:'ไม่มีรายการที่อนุมัติในระบบ'],['บันทึกหัวหน้าฝ่าย',r.personnel_note||'—']
  ].map(([label,value])=>`<div><strong>${esc(label)}:</strong> ${esc(value)}</div>`).join('')}</div>
  <p class="muted">สถิติปีงบประมาณ ${esc(r.statistics_period.from)} ถึง ${esc(r.statistics_period.to)}</p>
  <div class="leave-stats"><table><thead><tr><th>ประเภท</th><th>ลามาแล้ว (ครั้ง)</th><th>ลามาแล้ว (วัน)</th><th>ลาครั้งนี้ (วัน)</th><th>รวม (ครั้ง)</th><th>รวม (วัน)</th></tr></thead><tbody>${r.stats.map(s=>`<tr>${[types[s.type],s.previous_count,s.previous_days,s.current_days,s.total_count,s.total_days].map(v=>`<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
  <h4>บันทึกการดำเนินการ</h4>${events.map(e=>`<p>${esc(e.created_at)} · ${esc(e.full_name)} · ${esc(({submitted:'ยื่นใบลา',acknowledged:'รับทราบ',recorded:'บันทึก',forwarded:'ส่งต่อ',reviewed:'ให้ความเห็น',approved:'อนุญาต',rejected:'ไม่อนุญาต'})[e.action]||e.action)} ${esc(e.note||'')}</p>`).join('')}
  <div class="leave-actions"><button class="btn btn-primary" data-export="docx" data-id="${Number(id)}">ดาวน์โหลดใบลา Word</button><button class="btn btn-primary" data-export="pdf" data-id="${Number(id)}">ดาวน์โหลดใบลา PDF</button></div>`;
  $('detailSection').scrollIntoView({behavior:'smooth',block:'start'});
 }
 function days(){const a=$('fStart').value,b=$('fEnd').value;if(a&&b&&b>=a)$('fDays').value=String(Math.round((Date.parse(b)-Date.parse(a))/86400000)+1);}
 for(const id of ['fStart','fEnd']){$(id).oninput=days;$(id).onchange=days;}
 const requiredFields=[['fType','ประเภทการลา'],['fDate','วันที่เขียนใบลา'],['fPosition','ตำแหน่ง'],['fReason','เหตุผลการลา'],['fStart','วันที่เริ่มลา'],['fEnd','วันที่สิ้นสุดการลา'],['fDays','จำนวนวันลา'],['fPhone','เบอร์ติดต่อ'],['fAddress','ที่อยู่ระหว่างลา']];
 function validateForm(){
  for(const [id,label] of requiredFields){
   $(id).removeAttribute('aria-invalid');
   if(!$(id).value.trim()){submitError('กรุณาระบุ'+label,id);return false;}
   if($(id).validity?.badInput||$(id).validity?.typeMismatch){submitError('กรุณาตรวจสอบ'+label,id);return false;}
  }
  const start=$('fStart').value,end=$('fEnd').value,count=Number($('fDays').value);
  if(end<start){submitError('วันที่สิ้นสุดการลาต้องไม่อยู่ก่อนวันที่เริ่มลา','fEnd');return false;}
  const span=Math.round((Date.parse(end)-Date.parse(start))/86400000)+1;
  if(!Number.isFinite(count)||count<=0||count>span||count*2!==Math.round(count*2)){
   submitError('จำนวนวันลาต้องมากกว่า 0 ไม่เกิน '+span+' วัน และระบุได้ทีละครึ่งวัน','fDays');return false;
  }
  return true;
 }
 $('leaveForm').onsubmit=async e=>{
  e.preventDefault();if(busy||!validateForm())return;busy=true;$('submitBtn').disabled=true;$('submitBtn').textContent='กำลังส่งใบลา…';$('submitError').hidden=true;
  try{await apiRequest('/api/leave-requests',{method:'POST',body:{leave_type:$('fType').value,reason:$('fReason').value.trim(),request_date:$('fDate').value,position:$('fPosition').value.trim(),start_date:$('fStart').value,end_date:$('fEnd').value,leave_days:Number($('fDays').value),contact_address:$('fAddress').value.trim(),contact_phone:$('fPhone').value.trim()}});
   success('ส่งใบลาให้หัวหน้าฝ่ายบุคลากรแล้ว');$('fReason').value='';$('fStart').value='';$('fEnd').value='';$('fDays').value='';
   try{await load();}catch(e){error(Error('บันทึกใบลาสำเร็จแล้ว แต่โหลดทะเบียนไม่สำเร็จ กรุณาโหลดหน้าใหม่เพื่อดูรายการ'));}
   $('successBox').scrollIntoView({behavior:'smooth',block:'center'});
  }catch(e){submitError(e.message||'ส่งใบลาไม่สำเร็จ กรุณาลองใหม่');}finally{busy=false;$('submitBtn').disabled=false;$('submitBtn').textContent='ส่งใบลาให้หัวหน้าฝ่ายบุคลากร';}
 };
 document.addEventListener('click',async e=>{
  const button=e.target.closest('button');if(!button||busy)return;
  const id=Number(button.dataset.id||button.dataset.detail);if(!id)return;
  busy=true;button.disabled=true;
  try{
   if(button.dataset.detail)await details(id);
   else if(button.dataset.export){const {leave_request}=await apiRequest('/api/leave-requests/'+id);await LeaveFormExport.exportFile(button.dataset.export,leave_request);success('สร้างไฟล์ใบลาแล้ว');}
   else if(button.dataset.action){
    const action=button.dataset.action,note=$('note-'+id)?.value||'';
    if(action==='cancel'){if(!confirm('ยืนยันยกเลิกคำขอลานี้?'))return;await apiRequest('/api/leave-requests/'+id,{method:'DELETE'});}
    else {const body=['approved','rejected'].includes(action)?{action:'decide',status:action,note}:{action,note};
     if(action==='forward'){body.deputy_personnel_id=Number($('deputyChoice').value);if(!body.deputy_personnel_id)throw Error('กรุณาเลือกรองผู้บริหารที่รับผิดชอบฝ่ายบุคลากร');}
     await apiRequest('/api/leave-requests/'+id,{method:'PATCH',body});
    }
    success(({acknowledge:'รับทราบและบันทึกแล้ว',record:'บันทึกข้อมูลแล้ว',forward:'ส่งต่อผู้อำนวยการและรองผู้บริหารแล้ว',review:'บันทึกความเห็นแล้ว แจ้งผู้อำนวยการเรียบร้อย',approved:'บันทึกคำสั่งอนุญาตแล้ว',rejected:'บันทึกคำสั่งไม่อนุญาตแล้ว',cancel:'ยกเลิกคำขอแล้ว'})[action]);await load();if(detailId===id&&records.some(r=>r.id===id))await details(id);
   }
  }catch(e){error(e);}finally{busy=false;button.disabled=false;}
 });
 $('closeDetail').onclick=()=>{$('detailSection').hidden=true;detailId=null;};
 $('backHomeLink').onclick=e=>{if(window.parent!==window&&window.parent.showOverview){e.preventDefault();window.parent.showOverview();}};
 (async()=>{try{const data=await apiRequest('/api/auth/me');user=data.user;if(!user)throw Error('กรุณาเข้าสู่ระบบ');$('fName').value=user.full_name;$('fDate').value=new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Bangkok'});await load();
  setInterval(()=>{if(!document.hidden&&!busy&&!/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName||''))load().catch(error);},15000);
 }catch(e){error(e);$('submitBtn').disabled=true;}})();
})();
