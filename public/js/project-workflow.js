/* Shared document and finance views. All balances and notifications come from the server. */
window.ProjectWorkflow = (() => {
  const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = v => Number(v || 0).toLocaleString('th-TH',{minimumFractionDigits:2,maximumFractionDigits:2});
  const today = () => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const departments = {academic:'วิชาการ',early_childhood:'ปฐมวัย',budget:'งบประมาณ',personnel:'บุคคล',general:'บริหารทั่วไป'};
  const fundingTypes={subsidy:'งบอุดหนุน',free_education:'งบเรียนฟรี 15 ปี',school_income:'งบรายได้สถานศึกษา'};
  const states = {draft:'ร่าง',returned:'ส่งกลับให้แก้ไข',finance_queue:'รอเจ้าหน้าที่รับเรื่อง',finance_processing:'รับเรื่องแล้ว กำลังดำเนินการ',finance_ready:'ดำเนินการเสร็จสิ้น รอยืนยัน',completed:'ยืนยันแล้ว สามารถเบิกจ่ายได้',rejected:'ไม่อนุมัติ'};
  const opts = (entries, selected) => Object.entries(entries).map(([v,label])=>`<option value="${esc(v)}" ${String(v)===String(selected)?'selected':''}>${esc(label)}</option>`).join('');
  const field = (label,content,wide=false) => `<label class="field ${wide?'wf-wide':''}"><span>${label}</span>${content}</label>`;

  function mount(root, options = {}) {
    let data={projects:[],requests:[],notifications:[],permissions:{}},openedProject=Number(options.project)||null, search='', busy=false;
    const dialog=document.createElement('dialog');dialog.className='wf-modal';document.body.append(dialog);
    const statusBox=document.createElement('div');statusBox.className='wf-error';root.before(statusBox);
    function error(message){statusBox.textContent=message||'';statusBox.style.display=message?'block':'none';}
    function modal(content){dialog.innerHTML=`<div class="wf-modal-error wf-error"></div>${content}`;if(!dialog.open)dialog.showModal();dialog.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>dialog.close());}
    function modalError(message){const box=dialog.querySelector('.wf-modal-error');if(box){box.textContent=message;box.style.display='block';}}
    async function refresh(){
      try { error(); const q=new URLSearchParams();if(options.department)q.set('department',options.department);const year=typeof options.year==='function'?options.year():options.year;if(year)q.set('fiscal_year',year);
        data=await apiRequest('/api/project-documents/overview?'+q);render();options.onRefresh?.(data);return data;
      } catch(e){error(e.message);throw e;}
    }
    function balances(p){return `<div class="wf-balances"><div><span>งบทั้งหมด</span><strong>${money(p.budget_amount)}</strong></div><div><span>จ่ายแล้ว</span><strong>${money(p.spent_amount)}</strong></div><div class="wf-remaining"><span>เงินคงเหลือ</span><strong>${money(p.remaining_amount)}</strong></div><div><span>รอดำเนินการ / วงเงินที่ขอได้</span><strong>${money(p.reserved_amount)} / ${money(p.available_amount)}</strong></div></div>`;}
    function render(){
      const projects=data.projects.filter(p=>(!options.internal || p.department==='budget') && (!search || (p.name+' '+p.owner_names).toLowerCase().includes(search)));
      const unread=data.notifications.filter(n=>!n.read_at);
      root.innerHTML=`${unread.slice(0,6).map(n=>`<div class="wf-notice">${esc(n.project_name)}: ${esc(n.message)} <button class="btn btn-ghost" data-open="${n.project_id}">ดูรายการ</button></div>`).join('')}
        <div class="wf-tools"><input type="search" data-search aria-label="ค้นหาโครงการ" placeholder="ค้นหาชื่อโครงการ / ผู้รับผิดชอบ" value="${esc(search)}"><span class="wf-muted">${projects.length} โครงการ</span></div>
        <div class="wf-projects">${projects.map(p=>`<article class="wf-project" data-project="${p.id}">
          ${p.unread_count||p.new_request_count?`<small class="wf-alert">${p.new_request_count?`รอรับ ${p.new_request_count}`:`แจ้งเตือน ${p.unread_count}`}</small>`:''}
          <h3>${esc(p.name)}</h3><div class="wf-muted">ฝ่าย${departments[p.department]||esc(p.department)} · ปีงบประมาณ ${p.fiscal_year}</div>
          <div class="wf-muted">${fundingTypes[p.funding_type]||"ยังไม่ระบุประเภทเงิน"}</div><div class="wf-muted">ผู้รับผิดชอบ: ${esc(p.owner_names||'ยังไม่ระบุ')}</div>${balances(p)}
          <div class="wf-actions"><button class="btn btn-ghost" data-open="${p.id}">เอกสาร / ความคืบหน้า</button>
          ${p.can_request&&p.status!=='cancelled'?p.funding_type?`<button class="btn btn-primary" data-new="${p.id}">+ จัดทำคำขอเบิกจ่าย</button>`:`<a class="btn btn-primary" href="/department.html?dept=${p.department}&project=${p.id}">ระบุประเภทเงินโครงการ</a>`:''}
          ${data.permissions.can_finance&&options.finance?`<button class="btn btn-ghost" data-allocation="${p.id}">ปรับวงเงินโครงการ</button>`:''}</div>
        </article>`).join('')||'<p class="wf-muted">ยังไม่มีโครงการในรายการนี้</p>'}</div>
        ${openedProject?renderProject(openedProject):''}`;
      root.querySelector('[data-search]').oninput=e=>{search=e.target.value.trim().toLowerCase();const pos=e.target.selectionStart;render();const input=root.querySelector('[data-search]');input.focus();input.setSelectionRange(pos,pos);};
      root.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>openProject(Number(b.dataset.open)));
      root.querySelectorAll('[data-new]').forEach(b=>b.onclick=()=>newRequest(Number(b.dataset.new)));
      root.querySelectorAll('[data-allocation]').forEach(b=>b.onclick=()=>allocation(Number(b.dataset.allocation)));
      root.querySelectorAll('[data-edit-request]').forEach(b=>b.onclick=()=>editRequest(Number(b.dataset.editRequest)));
      root.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>requestAction(Number(b.dataset.request),b.dataset.action));
      root.querySelectorAll('[data-attach]').forEach(b=>b.onclick=()=>attach(Number(b.dataset.attach)));
    }
    function renderProject(id){
      const project=data.projects.find(p=>p.id===id);if(!project)return '';
      const requests=data.requests.filter(e=>e.project_id===id);
      return `<section class="wf-document-view" data-details><h2>${esc(project.name)} — เอกสารและความคืบหน้า</h2>
        ${requests.map(e=>`<article class="wf-request"><h4>${esc(e.request_no)} · ${money(e.amount)} บาท</h4>
          <span class="wf-state ${esc(e.current_step)}">${states[e.current_step]||esc(e.status)}</span>
          <p>${esc(e.request_purpose)}</p><div class="wf-muted">ผู้ขอ: ${esc(e.requester_name)} · ความสำคัญ: ${e.priority==='urgent'?'ด่วนมาก':e.priority==='high'?'ด่วน':'ปกติ'}${e.needed_date?' · ต้องการใช้เงิน '+esc(e.needed_date):''}</div>
          <p class="wf-muted">เหตุผล: ${esc(e.necessity)}${e.review_note?'<br>หมายเหตุเจ้าหน้าที่: '+esc(e.review_note):''}</p>
          <div style="overflow:auto"><table class="wf-detail-table"><thead><tr><th>รายการ</th><th>จำนวน</th><th>ราคา/หน่วย</th><th>รวม</th></tr></thead><tbody>${(e.items||[]).map(i=>`<tr><td>${esc(i.description)}</td><td>${i.quantity} ${esc(i.unit)}</td><td>${money(i.unit_price)}</td><td>${money(i.amount)}</td></tr>`).join('')}</tbody></table></div>
          ${e.status==='paid'?`<div class="wf-notice">ใบสำคัญ ${esc(e.payment_no)} · วันที่ ${esc(e.payment_date)} · ผู้รับเงิน ${esc(e.payment_recipient)} · ยอดสุทธิ ${money(e.net_paid)} บาท</div>`:''}
          <div class="wf-files">${e.documents.filter(d=>d.attachment_id).map(d=>`<a href="/api/attachments/${d.attachment_id}" target="_blank" rel="noopener">${esc(d.title)} — ${esc(d.file_name)}</a>`).join('')||'<span class="wf-muted">ยังไม่มีไฟล์แนบ</span>'}</div>
          <div class="wf-actions">${e.can_edit?`<button class="btn btn-ghost" data-edit-request="${e.id}">แก้ไขร่าง</button><button class="btn btn-primary" data-request="${e.id}" data-action="submit">ส่งเอกสาร</button>`:''}
          ${e.can_attach?`<button class="btn btn-ghost" data-attach="${e.id}">+ แนบเอกสารเพิ่มเติม</button>`:''}
          ${data.permissions.can_finance&&options.finance?financeButtons(e):''}
          ${['approved','paid'].includes(e.status)?`<a class="btn btn-ghost" target="_blank" rel="noopener" href="/api/budget/requests/${e.id}/document">พิมพ์คำขอ</a>`:''}
          ${e.status==='paid'?`<a class="btn btn-ghost" target="_blank" rel="noopener" href="/api/budget/requests/${e.id}/payment-document">ใบสำคัญจ่าย</a>`:''}</div></article>`).join('')||'<p class="wf-muted">ยังไม่มีคำขอเบิกจ่ายที่คุณมีสิทธิ์ดูในโครงการนี้</p>'}</section>`;
    }
    function financeButtons(e){
      const button=(action,label)=>`<button class="btn btn-primary" data-request="${e.id}" data-action="${action}">${label}</button>`;
      const primary=e.current_step==='finance_queue'?button('receive','รับเรื่อง'):e.current_step==='finance_processing'?button('complete','ดำเนินการเสร็จสิ้น'):e.current_step==='finance_ready'?button('pay','ยืนยันการเบิกจ่าย') : '';
      return primary+(['pending','approved'].includes(e.status)?button('return','ส่งกลับแก้ไข')+button('reject','ไม่อนุมัติ'):'');
    }
    async function openProject(id){openedProject=id;await apiRequest('/api/project-documents/notifications/read',{method:'POST',body:{project_id:id}});await refresh();root.querySelector('[data-details]')?.scrollIntoView({behavior:'smooth',block:'start'});}
    function newRequest(id){editRequest(null,id);}
    function editRequest(id,projectId){
      let savedId=id;const request=data.requests.find(e=>e.id===id);const selectedId=request?.project_id||projectId;const eligible=data.projects.filter(p=>p.can_request&&p.status!=='cancelled');
      if(!eligible.length){error('ยังไม่มีโครงการที่คุณเป็นผู้รับผิดชอบ');return;}
      modal(`<h2>${request?'แก้ไขร่างคำขอ':'จัดทำเอกสารขอเบิกจ่าย'}</h2><form id="wfRequestForm"><div class="wf-grid">
        ${field('โครงการ (เลือกจากระบบ)',`<select name="project_id" required ${request?'disabled':''}>${eligible.map(p=>`<option value="${p.id}" ${p.id===selectedId?'selected':''}>${esc(p.name)} · ${p.fiscal_year}</option>`).join('')}</select>`,true)}
        ${field('ฝ่ายงาน / ปีงบประมาณ',`<input id="wfProjectMeta" readonly>`)}${field('ผู้รับผิดชอบโครงการ',`<input id="wfOwners" readonly>`)}
        ${field('วันที่จัดทำคำขอ',`<input name="expense_date" type="date" required value="${esc(request?.expense_date||today())}">`)}
        ${field('วันที่ต้องการใช้เงิน',`<input name="needed_date" type="date" value="${esc(request?.needed_date||'')}">`)}
        ${field('ความสำคัญ',`<select name="priority">${opts({normal:'ปกติ',high:'ด่วน',urgent:'ด่วนมาก'},request?.priority||'normal')}</select>`)}
        ${field('แหล่งเงิน',`<select name="source_type" disabled>${opts(fundingTypes,request?.source_type||data.projects.find(p=>p.id===selectedId)?.funding_type)}</select>`)}
        ${field('วิธีรับเงิน',`<select name="payment_preference">${opts({transfer:'โอนเงิน',cash:'เงินสด',cheque:'เช็ค',other:'อื่น ๆ'},request?.payment_preference||'transfer')}</select>`)}
        ${field('ผู้รับเงิน / ร้านค้า',`<input name="payee" maxlength="250" value="${esc(request?.payee||'')}">`)}
        ${field('วัตถุประสงค์การเบิกจ่าย',`<textarea name="request_purpose" required maxlength="1500">${esc(request?.request_purpose||'')}</textarea>`,true)}
        ${field('เหตุผลความจำเป็น',`<textarea name="necessity" required maxlength="1500">${esc(request?.necessity||'')}</textarea>`,true)}
        ${field('หมายเหตุ',`<textarea name="notes" maxlength="1500">${esc(request?.notes||'')}</textarea>`,true)}</div>
        <h3>รายการค่าใช้จ่าย</h3><div id="wfItems"></div><button type="button" class="btn btn-ghost" id="wfAddItem">+ เพิ่มรายการ</button><div class="wf-total" id="wfTotal"></div>
        <p class="wf-muted">บันทึกร่างเพื่อแนบไฟล์ก่อนส่ง หรือส่งเอกสารแล้วแนบหลักฐานเพิ่มเติมภายหลังได้</p><div class="wf-actions"><button type="button" class="btn btn-ghost" data-close>ยกเลิก</button><button class="btn btn-ghost" name="intent" value="draft">บันทึกร่าง</button><button class="btn btn-primary" name="intent" value="send">บันทึกและส่งเอกสาร</button></div></form>`);
      const form=dialog.querySelector('form'),select=form.elements.project_id;
      function updateMeta(){const p=data.projects.find(p=>p.id===Number(select.value));dialog.querySelector('#wfProjectMeta').value=`ฝ่าย${departments[p.department]} / ${p.fiscal_year}`;dialog.querySelector('#wfOwners').value=p.owner_names||'ยังไม่ระบุ';form.elements.source_type.value=p.funding_type||'';}
      select.onchange=updateMeta;updateMeta();
      const updateTotal=()=>{const total=[...dialog.querySelectorAll('.wf-item')].reduce((sum,row)=>sum+Math.round(Number(row.querySelector('[name="quantity"]').value)*Number(row.querySelector('[name="unit_price"]').value)*100)/100,0);dialog.querySelector('#wfTotal').textContent='ยอดรวม '+money(total)+' บาท';};
      function addItem(item={}){const row=document.createElement('div');row.className='wf-item';row.innerHTML=`<div class="wf-item-grid"><label>รายละเอียด<input name="description" required maxlength="500" value="${esc(item.description||'')}"></label><label>จำนวน<input name="quantity" type="number" min="0.001" step="any" required value="${item.quantity||1}"></label><label>หน่วย<input name="unit" maxlength="100" value="${esc(item.unit||'รายการ')}"></label><label>ราคาต่อหน่วย<input name="unit_price" type="number" min="0" step="0.01" required value="${esc(item.unit_price??'')}"></label></div><div class="wf-actions"><select name="category" aria-label="หมวดค่าใช้จ่าย">${opts({materials:'วัสดุ',equipment:'ครุภัณฑ์',services:'จ้างบริการ',compensation:'ค่าตอบแทน',utilities:'สาธารณูปโภค',travel:'เดินทาง',food:'อาหาร',other:'อื่น ๆ'},item.category||'materials')}</select><button type="button" class="btn btn-ghost" data-remove>ลบรายการ</button></div>`;dialog.querySelector('#wfItems').append(row);row.querySelector('[data-remove]').onclick=()=>{row.remove();updateTotal();};row.oninput=updateTotal;updateTotal();}
      (request?.items?.length?request.items:[{}]).forEach(addItem);dialog.querySelector('#wfAddItem').onclick=()=>addItem();
      form.onsubmit=async event=>{event.preventDefault();if(busy)return;busy=true;const send=event.submitter?.value==='send';const buttons=form.querySelectorAll('button');buttons.forEach(b=>b.disabled=true);
        try{const body=Object.fromEntries(new FormData(form));body.project_id=Number(select.value);body.items=[...dialog.querySelectorAll('.wf-item')].map(row=>Object.fromEntries([...row.querySelectorAll('input,select')].map(el=>[el.name,el.value])));
          const result=await apiRequest('/api/project-documents/requests'+(savedId?'/'+savedId:''),{method:savedId?'PATCH':'POST',body});savedId=result.id;select.disabled=true;openedProject=body.project_id;
          if(send)await apiRequest(`/api/project-documents/requests/${result.id}/action`,{method:'POST',body:{action:'submit'}});
          dialog.close();await refresh();options.onChange?.();
        }catch(e){modalError(e.message);await refresh().catch(()=>{});}finally{busy=false;buttons.forEach(b=>b.disabled=false);}};
    }
    function requestAction(id,action){const row=data.requests.find(e=>e.id===id);if(!row)return;
      if(action==='pay'){payment(row);return;}
      const label={submit:'ส่งเอกสารให้ฝ่ายงบประมาณ',receive:'รับเรื่อง',complete:'ดำเนินการเสร็จสิ้น',return:'ส่งกลับให้แก้ไข',reject:'ไม่อนุมัติ'}[action];
      modal(`<h2>${label}</h2><p>${esc(row.request_no)} · ${money(row.amount)} บาท</p><form><label class="field">หมายเหตุ / เหตุผล<textarea name="review_note" maxlength="1500" ${['return','reject'].includes(action)?'required':''}></textarea></label><div class="wf-actions"><button class="btn btn-ghost" type="button" data-close>ยกเลิก</button><button class="btn btn-primary">ยืนยัน${label}</button></div></form>`);
      dialog.querySelector('form').onsubmit=e=>{e.preventDefault();execute(id,{action,review_note:dialog.querySelector('textarea').value});};
    }
    async function execute(id,body){if(busy)return;busy=true;dialog.querySelectorAll('button').forEach(b=>b.disabled=true);
      try{await apiRequest(`/api/project-documents/requests/${id}/action`,{method:'POST',body});dialog.close();await refresh();options.onChange?.();}
      catch(e){modalError(e.message);await refresh().catch(()=>{});}finally{busy=false;dialog.querySelectorAll('button').forEach(b=>b.disabled=false);}}
    function payment(row){modal(`<h2>ยืนยันการเบิกจ่าย</h2><p>${esc(row.request_no)} · ${money(row.amount)} บาท</p><p class="wf-steps">เมื่อยืนยัน ระบบปรับยอดเงินคงเหลือทั้งระบบและแจ้งเจ้าของโครงการทันที</p><form><div class="wf-grid">
      ${field('เลขที่ใบสำคัญจ่าย',`<input name="payment_no" required maxlength="100">`)}${field('วันที่เบิกจ่าย',`<input name="payment_date" type="date" required value="${today()}">`)}
      ${field('วิธีจ่าย',`<select name="payment_method">${opts({transfer:'โอนเงิน',cash:'เงินสด',cheque:'เช็ค',other:'อื่น ๆ'},row.payment_preference)}</select>`)}${field('เลขอ้างอิงโอนเงิน / เช็ค',`<input name="payment_reference" maxlength="150">`)}
      ${field('ผู้รับเงิน',`<input name="payment_recipient" required maxlength="250" value="${esc(row.payee||'')}">`)}${field('ภาษีหัก ณ ที่จ่าย (บาท)',`<input name="withholding_tax" type="number" min="0" max="${row.amount}" step="0.01" value="0">`)}
      ${field('หมายเหตุ',`<textarea name="payment_note" maxlength="1500"></textarea>`,true)}</div><div class="wf-actions"><button type="button" class="btn btn-ghost" data-close>ยกเลิก</button><button class="btn btn-primary">ยืนยันการเบิกจ่าย</button></div></form>`);dialog.querySelector('form').onsubmit=e=>{e.preventDefault();execute(row.id,{action:'pay',...Object.fromEntries(new FormData(e.target))});};}
    function attach(id){modal(`<h2>แนบเอกสารเพิ่มเติม</h2><p>ไฟล์เดิมจะอยู่ครบ สามารถเพิ่มได้หลายครั้ง เจ้าหน้าที่จะได้รับแจ้งเมื่ออัปโหลดสำเร็จ</p><form>${field('ชื่อเอกสาร / รายละเอียด',`<input name="title" required maxlength="300" placeholder="ใบเสร็จ / หลักฐานการจ่าย">`)}${field('ไฟล์หลักฐาน',`<input name="files" type="file" required multiple accept=".pdf,.jpg,.jpeg,.png,.webp">`)}<p class="wf-muted">PDF ไม่เกิน 1 MB ต่อไฟล์ · ภาพไม่เกิน 2 MB ต่อไฟล์</p><div class="wf-actions"><button type="button" class="btn btn-ghost" data-close>ยกเลิก</button><button class="btn btn-primary">อัปโหลดและแจ้งเจ้าหน้าที่</button></div></form>`);
      dialog.querySelector('form').onsubmit=async e=>{e.preventDefault();if(busy)return;busy=true;const form=e.target,button=form.querySelector('button:last-child');button.disabled=true;const files=[...form.elements.files.files];let done=0;
        try{for(const file of files){if(!/\.(pdf|jpe?g|png|webp)$/i.test(file.name))throw Error('รองรับ PDF และรูปภาพเท่านั้น');if(file.size>(/\.pdf$/i.test(file.name)?1024*1024:2*1024*1024))throw Error('ไฟล์ '+file.name+' เกินขนาดที่กำหนด');}
          for(const file of files){button.textContent=`กำลังอัปโหลด ${done+1}/${files.length}`;const document=await apiRequest(`/api/project-documents/requests/${id}/supporting-documents`,{method:'POST',body:{title:form.elements.title.value+(files.length>1?' — '+file.name:'')}});const payload=new FormData();payload.set('file',file);await apiRequest(`/api/attachments/${document.entity_type}/${document.entity_id}`,{method:'POST',body:payload});done++;}
          dialog.close();await refresh();options.onChange?.();
        }catch(err){modalError((done?'อัปโหลดสำเร็จ '+done+' ไฟล์แล้ว · ':'')+err.message);await refresh().catch(()=>{});if(done)form.elements.files.value='';}
        finally{busy=false;button.disabled=false;button.textContent='อัปโหลดและแจ้งเจ้าหน้าที่';}};
    }
    function allocation(id){const p=data.projects.find(p=>p.id===id);modal(`<h2>ปรับวงเงินโครงการ</h2><p>${esc(p.name)}</p><form>${field('ยอดจัดสรร (บาท)',`<input name="budget_amount" type="number" required min="${p.spent_amount+p.reserved_amount}" step="0.01" value="${p.budget_amount}">`)}<p>จ่ายแล้ว ${money(p.spent_amount)} · รอดำเนินการ ${money(p.reserved_amount)}</p><div class="wf-actions"><button class="btn btn-ghost" type="button" data-close>ยกเลิก</button><button class="btn btn-primary">บันทึก</button></div></form>`);dialog.querySelector('form').onsubmit=async e=>{e.preventDefault();try{await apiRequest(`/api/projects/${id}`,{method:'PATCH',body:{budget_amount:Number(e.target.elements.budget_amount.value)}});dialog.close();await refresh();options.onChange?.();}catch(err){modalError(err.message);}};}
    document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!dialog.open)refresh().catch(()=>{});});
    const timer=setInterval(()=>{if(!document.hidden&&!dialog.open)refresh().catch(()=>{});},15000);
    window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
    return {refresh,newRequest,openProject};
  }
  function renderFundingSummary(container,summary){
    if(!container||!summary)return;
    container.innerHTML=`<h3>ยอดเงินโครงการแยกประเภทเงิน · ปีงบประมาณ ${summary.fiscal_year}</h3><div class="wf-funding">${summary.budgets.map(b=>`<article class="wf-project"><h3>${esc(b.label)}</h3><div class="wf-funding-row"><span>ยอดทั้งหมด</span><strong>${money(b.total_amount)} บาท</strong></div><div class="wf-funding-row"><span>ใช้ไปแล้ว</span><strong>${money(b.spent_amount)} บาท</strong></div><div class="wf-funding-row wf-green"><span>คงเหลือ</span><strong>${money(b.remaining_amount)} บาท</strong></div><div class="wf-muted">${b.project_count} โครงการ · รอดำเนินการ ${money(b.reserved_amount)} บาท</div></article>`).join('')}</div>${summary.unclassified.project_count?`<p class="wf-muted">โครงการเดิมที่ยังไม่ระบุประเภทเงิน ${summary.unclassified.project_count} โครงการ · วงเงิน ${money(summary.unclassified.total_amount)} บาท · ใช้ไป ${money(summary.unclassified.spent_amount)} บาท · คงเหลือ ${money(summary.unclassified.remaining_amount)} บาท</p>`:''}`;
  }
  return {mount,renderFundingSummary};
})();
