(() => {
  const $=id=>document.getElementById(id), esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const departments={academic:'วิชาการ',early_childhood:'ปฐมวัย',budget:'งบประมาณ',personnel:'บุคคล',general:'บริหารทั่วไป'};
  let state=null,loading=false;
  const status=(text,bad=false)=>{ $('projectSettingsStatus').textContent=text; $('projectSettingsStatus').classList.toggle('settings-error',bad); };
  function render(){
    if(!state)return;
    const rows=state.projects;
    $('projectSettingsCount').textContent=`(${state.projects.length})`;
    const drafts=new Map([...$('projectSettingsList').querySelectorAll('form[data-dirty]')].map(f=>[f.dataset.project,{fields:Object.fromEntries(new FormData(f)),owners:[...f.querySelectorAll('[name=owner_ids]:checked')].map(i=>i.value)}]));
    const open=new Set([...$('projectSettingsList').querySelectorAll('details[open]')].map(d=>d.dataset.id));
    $('projectSettingsList').innerHTML=rows.map(p=>`<details class="project-setting" data-id="${p.id}" ${open.has(String(p.id))?'open':''}><summary><strong>${esc(p.name)}</strong><br><small>ฝ่าย${esc(departments[p.department])} · ${p.fiscal_year} · ${esc(p.owner_names||'ยังไม่กำหนดผู้รับผิดชอบ')}</small></summary><form data-project="${p.id}">
    <label class="wide">ชื่อโครงการ<input name="name" required maxlength="300" value="${esc(p.name)}"></label>
    <label>ฝ่ายงาน<select name="department">${Object.entries(departments).map(([k,v])=>`<option value="${k}" ${p.department===k?'selected':''}>${v}</option>`).join('')}</select></label>
    <label>ปีงบประมาณ<input name="fiscal_year" type="number" min="2500" max="3000" required value="${p.fiscal_year}"></label>
    <label>สถานะ<select name="status">${Object.entries({ongoing:'กำลังดำเนินการ',completed:'เสร็จสิ้น',cancelled:'ยกเลิก'}).map(([k,v])=>`<option value="${k}" ${p.status===k?'selected':''}>${v}</option>`).join('')}</select></label>
    <label class="wide">รายละเอียด<textarea name="description" maxlength="3000">${esc(p.description)}</textarea></label>
    <fieldset class="wide"><legend>บัญชีผู้รับผิดชอบโครงการ</legend><div class="project-owner-options">${[...state.users,...p.owner_ids.filter(id=>!state.users.some(u=>u.id===id)).map(id=>({id,full_name:'บัญชี '+id+' (ไม่พร้อมใช้งาน กรุณาตรวจสอบ)'}))].map(u=>`<label><input type="checkbox" name="owner_ids" value="${u.id}" ${p.owner_ids.includes(u.id)?'checked':''}>${esc(u.full_name)}</label>`).join('')}</div></fieldset>
    <p class="wide" role="status" data-result></p><div class="wide settings-actions"><button class="btn btn-primary" type="submit">บันทึก</button><button class="btn" type="button" data-delete="${p.id}">ลบโครงการ</button></div></form></details>`).join('')||'<p class="sub">ไม่พบโครงการ</p>';
    $('projectSettingsList').querySelectorAll('form').forEach(form=>{
      const draft=drafts.get(form.dataset.project);
      if(draft){for(const [key,value] of Object.entries(draft.fields)){if(key!=='owner_ids'&&form.elements[key])form.elements[key].value=value;}form.querySelectorAll('[name=owner_ids]').forEach(i=>i.checked=draft.owners.includes(i.value));form.dataset.dirty='1';}
      form.oninput=form.onchange=()=>{form.dataset.dirty='1';};
      form.onsubmit=async event=>{
      event.preventDefault();const result=form.querySelector('[data-result]'), buttons=[...form.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);result.textContent='กำลังบันทึก…';
      try{
        const body=Object.fromEntries(new FormData(form));body.owner_ids=[...form.querySelectorAll('[name=owner_ids]:checked')].map(c=>Number(c.value));
        const save=()=>apiRequest('/api/projects/'+form.dataset.project,{method:'PATCH',body});
        try{await save();}catch(e){if(e.data?.code!=='duplicate_project'||!confirm('ข้อมูลตรงกับโครงการอื่น ต้องการบันทึกซ้ำหรือไม่?'))throw e;body.confirm_duplicate=true;await save();}
        delete form.dataset.dirty;await window.loadProjectSettings();status('บันทึกแล้ว');window.dispatchEvent(new Event('school-data-changed'));
      }catch(e){result.textContent=e.message;result.classList.add('settings-error');}finally{buttons.forEach(b=>b.disabled=false);}
    };});
    $('projectSettingsList').querySelectorAll('[data-delete]').forEach(button=>button.onclick=async()=>{
      const p=state.projects.find(p=>p.id===Number(button.dataset.delete));if(!confirm(`ลบโครงการ “${p.name}” หรือไม่?`))return;button.disabled=true;
      try{await apiRequest('/api/projects/'+p.id,{method:'DELETE'});await window.loadProjectSettings();status('ลบโครงการแล้ว');window.dispatchEvent(new Event('school-data-changed'));}
      catch(e){const r=button.closest('form').querySelector('[data-result]');r.textContent=e.message;r.classList.add('settings-error');}finally{button.disabled=false;}
    });
    $('projectSettingsSearch').oninput?.();
  }
  window.loadProjectSettings=async()=>{if(loading)return;loading=true;try{state=await apiRequest('/api/projects/settings');render();status('');}catch(e){status(e.message,true);}finally{loading=false;}};
  $('projectSettingsSearch').oninput=()=>{const term=$('projectSettingsSearch').value.trim().toLowerCase();$('projectSettingsList').querySelectorAll('details').forEach(d=>{const p=state?.projects.find(p=>String(p.id)===d.dataset.id);d.hidden=!p||![p.name,p.owner_names,p.fiscal_year,departments[p.department]].join(' ').toLowerCase().includes(term);});};
  $('projectSettingsGroup').addEventListener('toggle',()=>{if($('projectSettingsGroup').open&&!state)window.loadProjectSettings();});
})();
