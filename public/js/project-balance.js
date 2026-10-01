window.ProjectBalance=(()=>{
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const money=v=>Number(v||0).toLocaleString('th-TH',{minimumFractionDigits:2,maximumFractionDigits:2});
 const inboxes=[];let dialog;
 function field(p,canEdit){return `<div class="pb-field" data-balance-field data-id="${Number(p.id)}" data-name="${esc(p.name)}" data-base="${Number(p.spent_amount||0)}" data-confirmed="${Number(p.confirmed_spent_amount||0)}" data-balance-edit="${canEdit?'1':'0'}"><label>ยอดเงินที่ใช้ไปแล้วรวม (บาท)<input data-balance-value type="number" min="${Number(p.confirmed_spent_amount||0)}" step="0.01" value="${Number(p.spent_amount||0)}" ${canEdit?'':'readonly'}></label><button class="btn btn-ghost" data-balance-action>${canEdit?'แก้ไขยอดใช้แล้ว':'ขออนุญาตแก้ไข'}</button><small>ยอดยกมา ${money(p.opening_spent_amount)} · เบิกจ่ายยืนยันในระบบ ${money(p.confirmed_spent_amount)}</small></div>`}
 function notify(){window.dispatchEvent(new CustomEvent('project-balances-updated'));refreshInboxes();}
 document.addEventListener('click',event=>{
  const button=event.target.closest?.('[data-balance-action]');if(!button)return;
  const box=button.closest('[data-balance-field]'),admin=box.dataset.balanceEdit==='1',base=Number(box.dataset.base),confirmed=Number(box.dataset.confirmed),id=Number(box.dataset.id);
  if(!dialog){dialog=document.createElement('dialog');dialog.className='pb-dialog';document.body.append(dialog)}
  dialog.innerHTML=`<form><h2>${admin?'แก้ไขยอดใช้ไปแล้ว':'ขออนุญาตแก้ไขยอดใช้ไปแล้ว'}</h2><p>${esc(box.dataset.name)}</p><p class="pb-muted">ยอดปัจจุบัน ${money(base)} บาท · เบิกจ่ายยืนยันในระบบ ${money(confirmed)} บาท<br>ปรับเฉพาะยอดยกมาก่อนเริ่มระบบ รายการเบิกจ่ายที่ยืนยันแล้วคงเดิม${admin?'':' · ยอดจะเปลี่ยนเมื่อ admin หรือผู้บริหารอนุมัติคำขอนี้'}</p><label>ยอดรวมที่ถูกต้อง (บาท)<input name="total" type="number" min="${confirmed}" max="1000000000000" step="0.01" required value="${Number(box.querySelector('input').value)}"></label><label>เหตุผลแก้ไข<textarea name="reason" required maxlength="1500" placeholder="เช่น แก้ไขยอดใช้จริงที่กรอกตอนนำข้อมูลครั้งแรก"></textarea></label><div class="pb-error" role="alert"></div><div class="pb-actions"><button type="button" class="btn btn-ghost" data-close>ยกเลิก</button><button class="btn btn-primary" type="submit">${admin?'บันทึกยอดที่ถูกต้อง':'ส่งคำขอให้ admin / ผู้บริหาร'}</button></div></form>`;
  dialog.querySelector('[data-close]').onclick=()=>dialog.close();dialog.showModal();
  dialog.querySelector('form').onsubmit=async e=>{e.preventDefault();const form=e.target,submit=form.querySelector('[type="submit"]');submit.disabled=true;try{
   const total=Number(form.elements.total.value),reason=form.elements.reason.value.trim();
   if(!reason)throw new Error('กรุณาระบุเหตุผลแก้ไข');
   await apiRequest(`/api/projects/${id}/${admin?'spent-balance':'balance-requests'}`,{method:admin?'PATCH':'POST',body:{total_spent:total,expected_total:base,reason}});
   dialog.close();notify();
  }catch(error){form.querySelector('.pb-error').textContent=error.message}finally{submit.disabled=false}};
 });
 function mountInbox(container,options={}){
  let busy=false;
  async function refresh(){if(busy)return;busy=true;try{
   const data=await apiRequest('/api/project-balance-requests'+(options.department?'?department='+encodeURIComponent(options.department):''));
   const pending=data.requests.filter(r=>r.status==='pending').length,unread=data.requests.filter(r=>r.unread).length;
   container.innerHTML=`<div class="pb-inbox"><h3>${data.can_review?'คำขออนุญาตแก้ไขยอดใช้ไปแล้ว':'คำขอแก้ไขยอดของฉัน'} ${pending||unread?`<small class="pb-badge">${pending} รอพิจารณา · ${unread} แจ้งเตือน</small>`:''}</h3><div class="pb-error" role="alert"></div>${data.requests.length?data.requests.slice(0,12).map(r=>`<article class="pb-request"><strong>${esc(r.project_name)}</strong><span class="pb-status">${{pending:'รออนุมัติ',approved:'อนุมัติและปรับยอดแล้ว',rejected:'ไม่อนุมัติ'}[r.status]}</span><p>${money(r.base_total)} → ${money(r.requested_total)} บาท · ผู้ขอ ${esc(r.requester_name)}</p><p>${esc(r.reason)}</p>${r.review_note?`<p>ผลพิจารณา: ${esc(r.review_note)} · ${esc(r.reviewer_name)}</p>`:''}<div class="pb-actions">${data.can_review&&r.status==='pending'?`<button class="btn btn-primary" data-approve="${r.id}">อนุมัติยอดนี้</button><button class="btn btn-ghost" data-reject="${r.id}">ไม่อนุมัติ</button>`:''}${r.unread?`<button class="btn btn-ghost" data-read="${r.id}">รับทราบ</button>`:''}</div></article>`).join(''):'<p class="pb-muted">ยังไม่มีคำขอแก้ไขยอดใช้ไปแล้ว</p>'}</div>`;
   container.querySelectorAll('[data-approve],[data-reject]').forEach(b=>b.onclick=async()=>{
    const approve=Boolean(b.dataset.approve),id=Number(b.dataset.approve||b.dataset.reject);
    const note=approve?'':window.prompt('เหตุผลที่ไม่อนุมัติ');if(!approve&&!note?.trim())return;
    b.disabled=true;try{await apiRequest(`/api/project-balance-requests/${id}/review`,{method:'POST',body:{action:approve?'approve':'reject',note}});notify();await refresh()}
    catch(error){container.querySelector('.pb-error').textContent=error.message;b.disabled=false}
   });
   container.querySelectorAll('[data-read]').forEach(b=>b.onclick=async()=>{try{await apiRequest('/api/project-balance-requests/read',{method:'POST',body:{id:Number(b.dataset.read)}});await refresh()}catch(error){container.querySelector('.pb-error').textContent=error.message}});
  }catch(error){container.textContent=error.message}finally{busy=false}}
  inboxes.push(refresh);refresh();return {refresh};
 }
 function refreshInboxes(){for(const refresh of inboxes)refresh()}
 setInterval(()=>{if(!document.hidden)refreshInboxes()},15000);
 return {field,mountInbox,refreshInboxes};
})();
