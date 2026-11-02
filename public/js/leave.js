(function(){
 'use strict';
 const $=id=>document.getElementById(id),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const approvalView=new URLSearchParams(location.search).get('view')==='approval';
 if(approvalView){$('leaveTitle').textContent='อนุมัติการลา';document.title='อนุมัติการลา — โรงเรียนบ้านป่าเด็ง';$('newLeaveSection').hidden=true;}
 const types={sick:'ลาป่วย',personal:'ลากิจส่วนตัว',maternity:'ลาคลอดบุตร',lenient:'ลาอนุโลม',other:'อื่น ๆ'},stages={submitted:'รอหัวหน้าฝ่ายบุคลากรรับทราบ',acknowledged:'รายการเดิม: รอรับทราบและส่งต่อผู้บริหาร',forwarded:'หัวหน้าฝ่ายรับทราบแล้ว รอผู้อำนวยการอนุมัติ',completed:'ดำเนินการเสร็จแล้ว'};
 const quotaLabels={general:'ลาทั่วไป (รวมทุกประเภท ยกเว้นลาอนุโลม)',lenient:'ลาอนุโลม'};
 let user,records=[],detailId=null,busy=false,first=true,deputies=[],lineConfigured=false,allowanceVersion=0;
 async function loadAllowance(){
  const version=++allowanceVersion;
  try{
   const data=await apiRequest('/api/leave-allowance?date='+encodeURIComponent($('fStart').value||$('fDate').value));
   if(version!==allowanceVersion)return;
   if(!data.period){$('leaveAllowance').textContent=data.message;return;}
   $('leaveAllowance').innerHTML=`<p>สิทธิ์ลา ${esc(data.period.name)} ปีการศึกษา ${esc(data.period.year_be)} (${esc(data.period.from)} ถึง ${esc(data.period.to)})</p><table><thead><tr><th>ประเภท</th><th>กำหนด (ครั้ง)</th><th>อนุมัติแล้ว</th><th>รอพิจารณา</th><th>ยื่นได้อีก (ครั้ง)</th></tr></thead><tbody>${data.types.map(r=>`<tr><td>${esc(quotaLabels[r.leave_type])}</td><td>${r.max_count??'ไม่จำกัด'}</td><td>${r.approved}</td><td>${r.pending}</td><td>${r.remaining??'ไม่จำกัด'}</td></tr>`).join('')}</tbody></table><p class="muted">นับรวมบัญชีที่ผูกบุคลากรเดียวกัน ใบลาหนึ่งใบ = หนึ่งครั้ง รายการรอพิจารณากันสิทธิ์ไว้ ระบบตรวจสิทธิ์อีกครั้งเมื่อส่งใบลา</p>`;
  }catch(e){if(version===allowanceVersion)$('leaveAllowance').textContent='โหลดสิทธิ์ลาไม่สำเร็จ: '+e.message;}
 }
 $('saveLeaveLimits').onclick=async()=>{
  if(busy)return;
  const limits=Object.keys(quotaLabels).map(leave_type=>({leave_type,max_count:$('limit-'+leave_type).value===''?null:Number($('limit-'+leave_type).value)}));
  if(limits.some(r=>r.max_count!==null&&(!Number.isInteger(r.max_count)||r.max_count<0||r.max_count>10000))){error(Error('จำนวนครั้งต้องเป็นจำนวนเต็ม 0–10000 หรือเว้นว่าง'));return;}
  busy=true;$('saveLeaveLimits').disabled=true;
  try{await apiRequest('/api/leave-settings',{method:'PATCH',body:{limits}});$('leaveLimitFields').dataset.dirty='false';success('บันทึกเงื่อนไขจำนวนครั้งการลาแล้ว');await load();}
  catch(e){error(e);}finally{busy=false;$('saveLeaveLimits').disabled=false;}
 };
 $('leaveLimitFields').oninput=()=>{$('leaveLimitFields').dataset.dirty='true';};
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
  const decisionDisabled=user?.view_as?.read_only?'disabled title="โหมดดูบัญชีอื่นอ่านได้อย่างเดียว ต้องเข้าสู่ระบบด้วยบัญชีผู้มีสิทธิ์เพื่ออนุมัติจริง"':'';
  return `<article class="leave-row ${r.status==='pending'?'pending':''}" id="leave-${Number(r.id)}">
   <h4>${esc(r.full_name)} · ${esc(types[r.leave_type])}</h4>
   <p>${esc(r.start_date)} ถึง ${esc(r.end_date)} · ${esc(r.leave_days??'')} วัน</p>
   <p>เหตุผล: ${esc(r.reason||'ยังไม่มีข้อมูลเหตุผลในรายการเดิม')}</p>
   <span class="leave-status">${esc(r.status==='approved'?'อนุญาตแล้ว':r.status==='rejected'?'ไม่อนุญาต':stages[r.workflow_stage]||'รอดำเนินการ')}</span>
   ${r.acknowledged_name?`<p class="muted">รับทราบโดย ${esc(r.acknowledged_name)} · ${esc(r.acknowledged_at)}</p>`:''}
   ${r.deputy_name?`<p class="muted">ส่งต่อ: ${esc(r.director_name)} และ ${esc(r.deputy_name)}</p>`:''}
   ${r.reviewer_comment?`<p>ความเห็นผู้บังคับบัญชา: ${esc(r.reviewer_comment)}</p>`:''}
   <div class="leave-actions">
    <button class="btn btn-ghost" data-detail="${Number(r.id)}">รายละเอียด / ใบลา</button>
    <button class="btn btn-ghost" data-export="docx" data-id="${Number(r.id)}">Word</button><button class="btn btn-ghost" data-export="pdf" data-id="${Number(r.id)}">PDF</button>
    ${!approvalView&&r.can_acknowledge?`<button class="btn btn-primary" data-action="acknowledge" data-id="${Number(r.id)}">รับทราบและส่งต่ออัตโนมัติ</button>`:''}
    ${r.can_acknowledge_approve?`<button class="btn btn-primary" data-action="acknowledge_approve" data-id="${Number(r.id)}" ${decisionDisabled}>รับทราบและอนุมัติ</button>`:''}
    ${r.can_decide?`${!r.can_acknowledge_approve?`<button class="btn btn-primary" data-action="approved" data-id="${Number(r.id)}" ${decisionDisabled}>อนุญาต</button>`:''}<button class="btn btn-ghost" data-action="rejected" data-id="${Number(r.id)}" ${decisionDisabled}>ไม่อนุญาต</button>`:''}
    ${!approvalView&&r.can_cancel?`<button class="btn btn-ghost" data-action="cancel" data-id="${Number(r.id)}">ยกเลิกคำขอ</button>`:''}
   </div></article>`;
 }
 async function load(){
  const data=await apiRequest('/api/leave-requests');records=data.leave_requests;
  if(approvalView){if(!data.can_view_all_leave)records=[];}
  else await loadAllowance();
  $('approvalAccess').hidden=!approvalView;
  $('approvalAccess').textContent=!data.can_view_all_leave?'หน้านี้สำหรับแอดมิน ผอ. และรอง ผอ.':data.can_approve_leave?'กดรับทราบและอนุมัติเพื่อบันทึกผลและนับเป็นสถิติการลาได้ทันที รวมรายการเดิมที่ยังรอรับทราบหรือส่งต่อ':user.role==='superadmin'?'แอดมินดูข้อมูลการลาทั้งหมดและดาวน์โหลดใบลาได้ สิทธิ์อนุมัติเป็นของ ผอ. หรือรอง ผอ. ที่ได้รับมอบสิทธิ์':'คุณดูข้อมูลการลาทั้งหมดได้ ยังไม่มีสิทธิ์อนุมัติ กรุณาให้ ผอ. มอบสิทธิ์เป็นรายคน';
  if(user?.view_as?.read_only)$('approvalAccess').textContent+=' · ขณะนี้เป็นโหมดดูบัญชีอื่น ปุ่มอนุมัติแสดงเพื่อดูตัวอย่างและกดไม่ได้ ต้องเข้าสู่ระบบด้วยบัญชี ผอ. หรือรอง ผอ. ที่ได้รับมอบสิทธิ์เพื่ออนุมัติจริง';
  $('delegationSettings').hidden=!data.can_manage_delegations;
  if(data.can_manage_delegations){
   const permissions=await apiRequest('/api/leave-delegations');
   $('delegationList').innerHTML=permissions.deputies.map(p=>`<article class="leave-row"><h4>${esc(p.full_name)}</h4><p>${esc(p.position)}</p><p>${p.can_approve?'มีสิทธิ์อนุมัติการลา':'ดูข้อมูลได้อย่างเดียว'}</p>${p.grant?`<p class="muted">มอบสิทธิ์โดย ${esc(p.grant.granted_by_name)} · ${esc(p.grant.granted_at)}</p>`:''}<button type="button" class="btn ${p.can_approve?'btn-ghost':'btn-primary'}" data-delegate="${Number(p.id)}" data-grant="${!p.can_approve}">${p.can_approve?'ถอนสิทธิ์อนุมัติ':'มอบสิทธิ์อนุมัติ'}</button></article>`).join('')||'<p class="muted">ยังไม่มีรอง ผอ. ที่มีบัญชีผู้บริหารใช้งานอยู่ กรุณาตรวจทะเบียนบุคลากร</p>';
  }
  const draftNotes=new Map([...document.querySelectorAll('.leave-note')].map(n=>[n.id,n.value]));
  const selected=$('deputyChoice').value||data.default_deputy_id||'';
  const canConfigure=!approvalView&&(data.is_personnel_head||user.role==='superadmin');
  $('headSettings').hidden=!canConfigure;
  $('lineTemplateSettings').hidden=user.role!=='superadmin';
  if(canConfigure){
   const settings=await apiRequest('/api/leave-settings');deputies=settings.deputies;lineConfigured=settings.line_configured;
   if($('leaveLimitFields').dataset.dirty!=='true')$('leaveLimitFields').innerHTML=settings.limits.map(r=>`<div class="field"><label for="limit-${esc(r.leave_type)}">${esc(quotaLabels[r.leave_type])} (ครั้ง/เทอม)</label><input id="limit-${esc(r.leave_type)}" type="number" min="0" max="10000" step="1" placeholder="ไม่จำกัด" value="${r.max_count??''}"></div>`).join('');
   $('deputyChoice').innerHTML='<option value="">เลือกรองผู้บริหาร</option>'+deputies.map(p=>`<option value="${Number(p.id)}">${esc(p.full_name)} · ${esc(p.position)}</option>`).join('');
   $('deputyChoice').value=String(selected||settings.deputy_personnel_id||'');showDeputyStatus();
   if(user.role==='superadmin'&&$('leaveLineTemplate').dataset.dirty!=='true'){$('leaveLineTemplate').value=settings.line_template||'';showLinePreview();}
  }
  if(first){$('fPosition').value=data.profile.position||'';$('fPhone').value=data.profile.phone||'';}
  const pending=records.filter(r=>approvalView?r.status==='pending':r.can_acknowledge||r.can_decide||r.can_acknowledge_approve);
  $('pendingSection').hidden=!pending.length;$('pendingPanel').innerHTML=pending.map(row).join('');
  $('historyPanel').innerHTML=records.filter(r=>!pending.some(p=>p.id===r.id)).map(row).join('')||'<p class="leave-row muted">ยังไม่มีรายการ</p>';
  for(const [id,value] of draftNotes){const field=$(id);if(field)field.value=value;}
  if(first){first=false;const id=Number(new URLSearchParams(location.search).get('request'));if(records.some(r=>r.id===id))await details(id);}
 }
 function showDeputyStatus(){
  const p=deputies.find(x=>x.id===Number($('deputyChoice').value));
  $('deputyLineStatus').textContent=!p?'ยังไม่ได้เลือกรอง ผอ. ผู้รับข้อมูลหลังรับทราบ':!lineConfigured?'ระบบยังไม่ได้ตั้งค่า LINE Channel Access Token':p.line_status==='active'?'บัญชี LINE เชื่อมต่อและพร้อมรับข้อความ':p.line_status==='blocked'?'บัญชี LINE บล็อก OA ของโรงเรียน กรุณาปลดบล็อกและเชื่อมใหม่':'รอง ผอ. ยังไม่ได้เชื่อมบัญชี LINE โปรดเชื่อมจากหน้าบัญชีหรือให้แอดมินจับคู่ที่ตั้งค่า LINE';
 }
 function showLinePreview(){
  const template=$('leaveLineTemplate').value||'• {title}\n  {message}\n  วันที่ลา: {leave_dates}\n  เหตุผลการลา: {reason}\n  เบอร์โทรศัพท์ครู: {phone}';
  const values={title:'การลา: ครูตัวอย่าง',message:'มีคำขอลารอหัวหน้าฝ่ายบุคลากรรับทราบ',id:'123',reason:'ไม่สบาย ขอพักรักษาตัว',phone:'0800000000',leave_dates:'19/10/2569 ถึง 20/10/2569',link:location.origin+'/leave.html?request=123'};
  $('leaveLinePreview').textContent='🔔 แจ้งเตือนจากระบบโรงเรียนบ้านป่าเด็ง\n\n'+template.replace(/\{(title|message|id|link|reason|leave_dates|phone)\}/g,(_,key)=>values[key])+'\n\nเปิดดู: '+values.link;
 }
 function insertLineField(field){
  const input=$('leaveLineTemplate'),start=input.selectionStart??input.value.length,end=input.selectionEnd??start;
  input.value=input.value.slice(0,start)+field+input.value.slice(end);
  input.focus();input.setSelectionRange(start+field.length,start+field.length);
  input.dataset.dirty='true';showLinePreview();
 }
 $('insertLeaveReason').onclick=()=>insertLineField('{reason}');
 $('insertLeaveDates').onclick=()=>insertLineField('{leave_dates}');
 $('insertLeavePhone').onclick=()=>insertLineField('{phone}');
 $('leaveLineTemplate').oninput=()=>{$('leaveLineTemplate').dataset.dirty='true';showLinePreview();};
 $('saveLeaveLineTemplate').onclick=async()=>{
  if(busy)return;busy=true;$('saveLeaveLineTemplate').disabled=true;
  try{const saved=await apiRequest('/api/leave-settings',{method:'PATCH',body:{line_template:$('leaveLineTemplate').value}});
   $('leaveLineTemplate').value=saved.line_template;$('leaveLineTemplate').dataset.dirty='false';showLinePreview();success('บันทึกข้อความ LINE สำหรับการแจ้งเตือนครั้งต่อไปแล้ว');
  }catch(e){error(e);}finally{busy=false;$('saveLeaveLineTemplate').disabled=false;}
 };
 $('deputyChoice').onchange=showDeputyStatus;
 $('saveDeputy').onclick=async()=>{
  if(busy)return;const id=Number($('deputyChoice').value);if(!id){error(Error('กรุณาเลือกรอง ผอ.'));return;}
  busy=true;$('saveDeputy').disabled=true;
  try{await apiRequest('/api/leave-settings',{method:'PATCH',body:{deputy_personnel_id:id}});success('บันทึกรอง ผอ. ผู้รับข้อมูลหลังหัวหน้าฝ่ายรับทราบแล้ว');await load();}
  catch(e){error(e);}finally{busy=false;$('saveDeputy').disabled=false;}
 };
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
 for(const id of ['fStart','fEnd']){$(id).oninput=days;$(id).onchange=()=>{days();if(id==='fStart')loadAllowance();};}
 $('fDate').onchange=()=>{if(!$('fStart').value)loadAllowance();};
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
  if(user?.view_as?.read_only&&(button.dataset.delegate||button.dataset.action)){error(Error('โหมดดูบัญชีอื่นอ่านได้อย่างเดียว ต้องเข้าสู่ระบบด้วยบัญชีผู้มีสิทธิ์เพื่ออนุมัติจริง'));return;}
  if(button.dataset.delegate){
   busy=true;button.disabled=true;
   try{await apiRequest('/api/leave-delegations',{method:'PATCH',body:{personnel_id:Number(button.dataset.delegate),can_approve:button.dataset.grant==='true'}});success(button.dataset.grant==='true'?'มอบสิทธิ์อนุมัติการลาแล้ว':'ถอนสิทธิ์อนุมัติการลาแล้ว');await load();}
   catch(e){error(e);}finally{busy=false;button.disabled=false;}return;
  }
  const id=Number(button.dataset.id||button.dataset.detail);if(!id)return;
  busy=true;button.disabled=true;
  try{
   if(button.dataset.detail)await details(id);
   else if(button.dataset.export){const {leave_request}=await apiRequest('/api/leave-requests/'+id);await LeaveFormExport.exportFile(button.dataset.export,leave_request);success('สร้างไฟล์ใบลาแล้ว');}
   else if(button.dataset.action){
    const action=button.dataset.action,note=$('note-'+id)?.value||'';
    if(action==='cancel'){if(!confirm('ยืนยันยกเลิกคำขอลานี้?'))return;await apiRequest('/api/leave-requests/'+id,{method:'DELETE'});}
    else {const body=['approved','rejected'].includes(action)?{action:'decide',status:action,note}:{action,note};
     await apiRequest('/api/leave-requests/'+id,{method:'PATCH',body});
    }
    success(({acknowledge:'รับทราบแล้ว ระบบส่งข้อมูลให้ ผอ. และรอง ผอ. ที่รับผิดชอบแล้ว',acknowledge_approve:'รับทราบและอนุมัติแล้ว บันทึกเป็นสถิติการลาเรียบร้อย',approved:'บันทึกคำสั่งอนุญาตแล้ว',rejected:'บันทึกคำสั่งไม่อนุญาตแล้ว',cancel:'ยกเลิกคำขอแล้ว'})[action]);await load();if(detailId===id&&records.some(r=>r.id===id))await details(id);
   }
  }catch(e){error(e);}finally{busy=false;button.disabled=false;}
 });
 $('closeDetail').onclick=()=>{$('detailSection').hidden=true;detailId=null;};
 $('backHomeLink').onclick=e=>{if(window.parent!==window&&window.parent.showOverview){e.preventDefault();window.parent.showOverview();}};
 (async()=>{try{const data=await apiRequest('/api/auth/me');user=data.user;if(!user)throw Error('กรุณาเข้าสู่ระบบ');$('fName').value=user.full_name;$('fDate').value=new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Bangkok'});await load();
  setInterval(()=>{if(!document.hidden&&!busy&&!/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName||''))load().catch(error);},15000);
 }catch(e){error(e);$('submitBtn').disabled=true;$('leaveLoginPrompt').hidden=false;}})();
})();
