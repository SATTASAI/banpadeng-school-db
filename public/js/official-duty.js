// การ์ด "ไปราชการ" ในหน้าการลา — ไม่นับวันลา บันทึกเพื่อให้ฝ่ายบุคคลจัดสอนแทน ผอ. กดรับทราบ
(function(){
 'use strict';
 const $=id=>document.getElementById(id),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const query=new URLSearchParams(location.search),focusId=/^\d+$/.test(query.get('duty')||'')?Number(query.get('duty')):null;
 const statusLabel={pending:'รอ ผอ. รับทราบ',acknowledged:'ผอ. รับทราบแล้ว',cancelled:'ยกเลิก'};
 let duties=[],me=null,busy=false,opened=false;
 const thDate=d=>{if(!d)return '';const [y,m,dd]=d.split('-').map(Number);return dd+'/'+m+'/'+(y+543);};
 const span=r=>thDate(r.start_date)+(r.end_date!==r.start_date?' – '+thDate(r.end_date):'')+(r.day_part!=='full'?' ('+esc(r.day_part_label)+')':'');
 function showError(msg){const box=$('dutyError');box.textContent=msg;box.hidden=!msg;if(msg)box.scrollIntoView({behavior:'smooth',block:'center'});}
 function flash(msg){const b=$('successBox');if(!b)return;$('errorBox')?.classList.remove('visible');b.textContent=msg;b.hidden=false;}
 function select(on){
  opened=on;
  $('dutyCard').classList.toggle('active',on);$('dutyCard').setAttribute('aria-pressed',String(on));
  $('dutySection').hidden=!on;
  if(on){
   for(const id of ['realLeaveCard','lenientLeaveCard']){$(id).classList.remove('active');$(id).setAttribute('aria-pressed','false');}
   $('newLeaveSection').hidden=true;$('leaveCategoryHint').hidden=true;$('detailSection').hidden=true;
  }
 }
 function card(r){
  const st=r.status==='acknowledged'?'ack':r.status;
  return `<article class="duty-item${r.id===focusId?' focus':''}" id="duty-${Number(r.id)}">
   <h4>${esc(r.full_name)}</h4>
   <p><b>${esc(r.title)}</b></p><p>ณ ${esc(r.location||'—')}</p><p>${span(r)}</p>
   ${r.note?`<p class="muted">${esc(r.note)}</p>`:''}
   <span class="duty-status ${st}">${esc(statusLabel[r.status])}</span>
   ${r.acknowledged_name&&r.status==='acknowledged'?`<p class="muted">รับทราบโดย ${esc(r.acknowledged_name)}</p>`:''}
   <div class="leave-actions">
    ${r.has_file?`<button class="btn btn-ghost" data-duty-file="${Number(r.id)}">เปิดหนังสือคำสั่ง</button>`:''}
    ${r.can_acknowledge?`<button class="btn btn-primary" data-duty-ack="${Number(r.id)}">รับทราบ</button>`:''}
    ${r.can_attach&&!r.has_file?`<button class="btn btn-ghost" data-duty-attach="${Number(r.id)}">แนบหนังสือ</button>`:''}
    ${r.can_cancel?`<button class="btn btn-ghost" data-duty-cancel="${Number(r.id)}">ยกเลิก</button>`:''}
   </div></article>`;
 }
 function render(){
  const mine=duties.filter(r=>Number(r.user_id)===Number(me?.id)&&r.status!=='cancelled');
  $('dutyTotal').textContent=mine.length+' ครั้ง (ไม่นับวันลา)';
  const pend=duties.filter(r=>r.can_acknowledge||(Number(r.user_id)===Number(me?.id)&&r.status==='pending')).length;
  $('dutyCard').classList.toggle('has-pending',pend>0);$('dutyCard').title=pend?'รอ ผอ. รับทราบ '+pend+' รายการ':'';
  const list=[...duties].sort((a,b)=>Number(b.can_acknowledge)-Number(a.can_acknowledge)||String(b.start_date).localeCompare(String(a.start_date))||b.id-a.id);
  $('dutyList').innerHTML=list.map(card).join('')||'<p class="muted">ยังไม่มีรายการ</p>';
 }
 async function load(){
  const data=await apiRequest('/api/official-duties');duties=data.duties||[];render();
 }
 async function upload(id,file){
  if(file.size>10*1024*1024)throw Error('ไฟล์ต้องไม่เกิน 10 MB');
  const res=await fetch('/api/official-duties/'+id+'/file',{method:'POST',credentials:'same-origin',cache:'no-store',
   headers:{'Content-Type':file.type||'application/octet-stream','X-File-Name':encodeURIComponent(file.name)},body:file});
  if(!res.ok){const d=await res.json().catch(()=>({}));throw Error(d.error||'แนบไฟล์ไม่สำเร็จ');}
 }
 $('dutyCard').addEventListener('click',()=>{select(true);load().catch(e=>showError(e.message));});
 for(const id of ['realLeaveCard','lenientLeaveCard'])$(id).addEventListener('click',()=>select(false));
 $('dStart').addEventListener('change',()=>{if(!$('dEnd').value||$('dEnd').value<$('dStart').value)$('dEnd').value=$('dStart').value;});
 $('dutyForm').addEventListener('submit',async e=>{
  e.preventDefault();if(busy)return;showError('');
  const body={title:$('dTitle').value.trim(),location:$('dLocation').value.trim(),start_date:$('dStart').value,end_date:$('dEnd').value,day_part:$('dPart').value,note:$('dNote').value.trim()};
  if(!body.title)return showError('กรุณาระบุเรื่อง');
  if(!body.location)return showError('กรุณาระบุสถานที่');
  if(!body.start_date||!body.end_date||body.end_date<body.start_date)return showError('ระบุวันที่เริ่มและสิ้นสุดให้ถูกต้อง');
  if(body.day_part!=='full'&&body.start_date!==body.end_date)return showError('ไปราชการครึ่งวันต้องเป็นวันเดียวกัน');
  const file=$('dFile').files[0];
  busy=true;$('dutySubmit').disabled=true;$('dutySubmit').textContent='กำลังบันทึก…';
  try{
   const saved=await apiRequest('/api/official-duties',{method:'POST',body});
   let msg='บันทึกการไปราชการแล้ว แจ้ง ผอ. และฝ่ายบุคคลเรียบร้อย';
   if(file){try{await upload(saved.id,file);}catch(err){msg+=' แต่แนบไฟล์ไม่สำเร็จ ('+err.message+') กดแนบหนังสือใหม่ได้ในทะเบียน';}}
   $('dutyForm').reset();flash(msg);await load();
  }catch(err){showError(err.message||'บันทึกไม่สำเร็จ');}
  finally{busy=false;$('dutySubmit').disabled=false;$('dutySubmit').textContent='บันทึกการไปราชการ';}
 });
 document.addEventListener('click',async e=>{
  const b=e.target.closest('button[data-duty-file],button[data-duty-ack],button[data-duty-cancel],button[data-duty-attach]');if(!b||busy)return;
  const id=Number(b.dataset.dutyFile||b.dataset.dutyAck||b.dataset.dutyCancel||b.dataset.dutyAttach);
  if(b.dataset.dutyAttach){
   const input=document.createElement('input');input.type='file';input.accept='.pdf,.doc,.docx,image/*';
   input.onchange=async()=>{const f=input.files[0];if(!f)return;busy=true;b.disabled=true;
    try{await upload(id,f);flash('แนบหนังสือแล้ว');await load();}catch(err){showError(err.message);}finally{busy=false;b.disabled=false;}};
   input.click();return;
  }
  if(b.dataset.dutyFile){
   const win=window.open('','_blank');
   try{const res=await fetch('/api/official-duties/'+id+'/file',{credentials:'same-origin',cache:'no-store'});
    if(!res.ok){const d=await res.json().catch(()=>({}));throw Error(d.error||'เปิดไฟล์ไม่สำเร็จ');}
    const url=URL.createObjectURL(await res.blob());if(win)win.location=url;else location.href=url;}
   catch(err){win?.close();showError(err.message);}
   return;
  }
  if(b.dataset.dutyCancel&&!confirm('ยืนยันยกเลิกรายการไปราชการนี้?'))return;
  busy=true;b.disabled=true;
  try{
   if(b.dataset.dutyAck){await apiRequest('/api/official-duties/'+id,{method:'PATCH',body:{action:'acknowledge'}});flash('รับทราบการไปราชการแล้ว');}
   else{await apiRequest('/api/official-duties/'+id,{method:'DELETE'});flash('ยกเลิกรายการไปราชการแล้ว');}
   await load();
  }catch(err){showError(err.message);}finally{busy=false;b.disabled=false;}
 });
 (async()=>{
  try{me=(await apiRequest('/api/auth/me')).user;if(!me)return;
   if(me.view_as?.read_only||me.role==='viewer')$('dutyForm').hidden=true;
   await load();
   if(focusId){select(true);requestAnimationFrame(()=>$('duty-'+focusId)?.scrollIntoView({behavior:'smooth',block:'center'}));}
  }catch(e){$('dutyTotal').textContent='—';}
  setInterval(()=>{if(opened&&!document.hidden&&!busy&&!/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName||''))load().catch(()=>{});},30000);
 })();
})();
