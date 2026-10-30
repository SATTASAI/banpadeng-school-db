// เอกสารโครงการ: pop-up แสดงไฟล์ของโครงการ (ย้อนหลัง 4 ปี) อัปโหลด/ดูตัวอย่าง/เปลี่ยนชื่อ/ย้าย/แทนที่/ลบ/สร้างโฟลเดอร์
// ใช้ได้ทุกหน้าที่โหลดสคริปต์นี้: ปุ่มใดก็ได้ที่มี data-project-files="<project id>"
(function(){
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
  const ICON={
    folder:'<svg class="pf-ico" viewBox="0 0 32 32"><path d="M3 9a3 3 0 0 1 3-3h6l3 3h11a3 3 0 0 1 3 3v11a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z" fill="#f5c451"/><path d="M3 13h26v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z" fill="#f8d779"/></svg>',
    pdf:'<svg class="pf-ico" viewBox="0 0 32 32"><path d="M7 3h13l6 6v18a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" fill="#e5484d"/><path d="M20 3v6h6" fill="#f3a0a3"/><text x="16" y="23" font-size="7.5" font-weight="700" fill="#fff" text-anchor="middle" font-family="sans-serif">PDF</text></svg>',
    docx:'<svg class="pf-ico" viewBox="0 0 32 32"><path d="M7 3h13l6 6v18a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" fill="#2f6fd6"/><path d="M20 3v6h6" fill="#9cbcf0"/><text x="16" y="23" font-size="7" font-weight="700" fill="#fff" text-anchor="middle" font-family="sans-serif">DOC</text></svg>',
    xlsx:'<svg class="pf-ico" viewBox="0 0 32 32"><path d="M7 3h13l6 6v18a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" fill="#1f9d55"/><path d="M20 3v6h6" fill="#8fd6ad"/><text x="16" y="23" font-size="7" font-weight="700" fill="#fff" text-anchor="middle" font-family="sans-serif">XLS</text></svg>',
    image:'<svg class="pf-ico" viewBox="0 0 32 32"><rect x="4" y="5" width="24" height="22" rx="3" fill="#8b5cf6"/><circle cx="12" cy="12" r="2.6" fill="#fff"/><path d="M6 24l7-8 5 5 3-3 5 6z" fill="#e3d6ff"/></svg>',
  };
  const CAT_ICON={project:'docx',appendix:'pdf',materials:'xlsx',images:'image'};
  const typeOf=m=>!m?'folder':m==='application/pdf'?'pdf':m.startsWith('image/')?'image':/sheet/.test(m)?'xlsx':/word/.test(m)?'docx':'pdf';
  const size=n=>!n?'':n<1024*1024?`${Math.max(1,Math.round(n/1024))} KB`:`${(n/1024/1024).toFixed(1)} MB`;
  const date=v=>{if(!v)return'';const d=new Date(v.replace(' ','T')+'Z');return isNaN(d)?v:d.toLocaleDateString('th-TH',{day:'numeric',month:'short',year:'2-digit'})};
  const url=(id,dl)=>`/api/project-files/${id}/content${dl?'?download=1':''}`;
  const loadScript=(src,test)=>window[test]?Promise.resolve(window[test]):new Promise((ok,no)=>{const s=document.createElement('script');s.src=src;s.onload=()=>ok(window[test]);s.onerror=()=>no(new Error('โหลดตัวแสดงตัวอย่างไม่สำเร็จ'));document.head.appendChild(s)});

  let dlg,state=null;
  function ensureDialog(){
    if(dlg)return dlg;
    dlg=document.createElement('dialog');dlg.className='pf-dialog';
    dlg.innerHTML='<div class="pf-wrap"><div class="pf-head"><div><h2 data-title>เอกสารโครงการ</h2><p data-sub></p></div><button class="pf-x" data-close aria-label="ปิด">×</button></div><div class="pf-years" data-years></div><div class="pf-toolbar" data-toolbar></div><div class="pf-body" data-body></div><div data-move></div></div>';
    document.body.appendChild(dlg);
    dlg.addEventListener('click',e=>{if(e.target===dlg)dlg.close()});
    dlg.querySelector('[data-close]').onclick=()=>dlg.close();
    return dlg;
  }
  const $=s=>dlg.querySelector(s);
  function setStatus(msg,isErr){const el=$('[data-status]');if(el){el.textContent=msg||'';el.classList.toggle('err',!!isErr)}}

  async function open(projectId){
    ensureDialog();
    state={projectId,folder:null,data:null,moving:null};
    $('[data-body]').innerHTML='<div class="pf-empty">กำลังโหลด…</div>';$('[data-years]').innerHTML='';$('[data-toolbar]').innerHTML='';$('[data-move]').innerHTML='';
    if(!dlg.open)dlg.showModal();
    await load();
  }
  async function load(){
    try{state.data=await apiRequest(`/api/projects/${state.projectId}/files`);render()}
    catch(e){$('[data-body]').innerHTML=`<div class="pf-empty">${esc(e.message)}</div>`}
  }
  const items=()=>state.data.items;
  const children=pid=>items().filter(i=>(i.parent_id??null)===pid);
  const byId=id=>items().find(i=>i.id===id);
  function countIn(id){let n=0;for(const c of children(id))n+=c.kind==='file'?1:countIn(c.id);return n}
  function path(id){const out=[];let cur=id?byId(id):null;while(cur){out.unshift(cur);cur=cur.parent_id?byId(cur.parent_id):null}return out}

  function render(){
    const d=state.data,p=d.project;
    $('[data-title]').textContent=p.name;
    $('[data-sub]').textContent=`ปีงบประมาณ ${p.fiscal_year||'-'} · ${d.can_manage?'จัดการไฟล์ได้':'ดูได้อย่างเดียว'}${d.drive_ready?'':' · ยังไม่ได้ตั้งค่า Google Drive'}`;
    $('[data-years]').innerHTML=d.years.map(y=>`<button class="pf-year" data-year="${y.project_id}" aria-selected="${y.project_id===p.id}">ปีงบ ${esc(y.fiscal_year||'-')}</button>`).join('');
    $('[data-years]').querySelectorAll('[data-year]').forEach(b=>b.onclick=()=>open(Number(b.dataset.year)));
    const crumbs=[`<button data-go="">ทั้งหมด</button>`,...path(state.folder).map(f=>`<span>›</span><button data-go="${f.id}">${esc(f.name)}</button>`)].join('');
    $('[data-toolbar]').innerHTML=`<div class="pf-crumbs">${crumbs}</div>${d.can_manage?`<button class="btn btn-primary" data-up-doc>⬆ อัปโหลดเอกสาร</button><button class="btn btn-ghost" data-up-img>🖼 อัปโหลดภาพ</button><button class="btn btn-ghost" data-mkdir>+ สร้างโฟลเดอร์</button>`:'<span class="pf-readonly">ดูและดาวน์โหลดได้</span>'}<span class="pf-status" data-status></span>
      <input type="file" hidden multiple accept=".pdf,.docx,.xlsx" data-file-doc><input type="file" hidden multiple accept="image/jpeg,image/png,image/webp,image/gif" data-file-img>`;
    $('[data-toolbar]').querySelectorAll('[data-go]').forEach(b=>b.onclick=()=>{state.folder=b.dataset.go?Number(b.dataset.go):null;render()});
    if(d.can_manage){
      $('[data-up-doc]').onclick=()=>$('[data-file-doc]').click();
      $('[data-up-img]').onclick=()=>$('[data-file-img]').click();
      $('[data-file-doc]').onchange=e=>upload([...e.target.files],state.folder);
      $('[data-file-img]').onchange=e=>{const imgFolder=state.folder??items().find(i=>i.category==='images')?.id??null;upload([...e.target.files],imgFolder)};
      $('[data-mkdir]').onclick=mkdir;
    }
    const body=$('[data-body]');
    if(state.folder===null){
      const cats=children(null).filter(i=>i.system);
      const others=children(null).filter(i=>!i.system);
      body.innerHTML=`<div class="pf-cats">${cats.map(c=>`<button class="pf-cat" data-open="${c.id}">${ICON[CAT_ICON[c.category]]||ICON.folder}<strong>${esc(c.name)}</strong><small>${countIn(c.id)} ไฟล์</small></button>`).join('')}</div>${listHtml(others,true)}`;
    } else body.innerHTML=listHtml(children(state.folder),false);
    body.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>{state.folder=Number(b.dataset.open);render()});
    body.querySelectorAll('[data-preview]').forEach(b=>b.onclick=()=>preview(byId(Number(b.dataset.preview))));
    body.querySelectorAll('[data-rename]').forEach(b=>b.onclick=()=>rename(byId(Number(b.dataset.rename))));
    body.querySelectorAll('[data-move-item]').forEach(b=>b.onclick=()=>moveUi(byId(Number(b.dataset.moveItem))));
    body.querySelectorAll('[data-replace]').forEach(b=>b.onclick=()=>replaceFile(byId(Number(b.dataset.replace))));
    body.querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>remove(byId(Number(b.dataset.del))));
    renderMove();
  }
  function listHtml(list,root){
    const m=state.data.can_manage;
    const folders=list.filter(i=>i.kind==='folder'),files=list.filter(i=>i.kind==='file');
    const images=files.filter(f=>typeOf(f.mime_type)==='image'),docs=files.filter(f=>typeOf(f.mime_type)!=='image');
    if(!list.length)return root?'':`<div class="pf-empty">ยังไม่มีไฟล์ในโฟลเดอร์นี้${m?' — กด "อัปโหลดเอกสาร" หรือ "อัปโหลดภาพ"':''}</div>`;
    const acts=i=>`<div class="pf-acts">${i.kind==='file'?`<button data-preview="${i.id}">ดู</button><a href="${url(i.id,1)}">ดาวน์โหลด</a>`:''}${m&&!i.system?`<button data-rename="${i.id}">เปลี่ยนชื่อ</button><button data-move-item="${i.id}">ย้าย</button>${i.kind==='file'?`<button data-replace="${i.id}">แทนที่</button>`:''}<button class="danger" data-del="${i.id}">ลบ</button>`:''}</div>`;
    const row=i=>`<div class="pf-row">${ICON[i.kind==='folder'?'folder':typeOf(i.mime_type)]}<div class="pf-name" ${i.kind==='folder'?`data-open="${i.id}"`:`data-preview="${i.id}"`}><strong>${esc(i.name)}</strong><small>${i.kind==='folder'?`${countIn(i.id)} ไฟล์`:`${size(i.file_size)} · ${date(i.updated_at)}${i.created_by_name?` · ${esc(i.created_by_name)}`:''}`}</small></div>${acts(i)}</div>`;
    return `<div class="pf-list">${folders.map(row).join('')}${docs.map(row).join('')}</div>${images.length?`<div class="pf-thumbs">${images.map(i=>`<div class="pf-thumb" data-preview="${i.id}" title="${esc(i.name)}"><img loading="lazy" src="${url(i.id)}" alt=""><span>${esc(i.name)}</span></div>`).join('')}</div>${m?`<div class="pf-list" style="margin-top:8px">${images.map(row).join('')}</div>`:''}`:''}`;
  }

  async function upload(files,parentId){
    if(!files.length)return;
    let done=0,failed=[];
    for(const f of files){
      setStatus(`กำลังอัปโหลด ${done+1}/${files.length}: ${f.name}`);
      const fd=new FormData();fd.append('file',f);if(parentId!=null)fd.append('parent_id',parentId);
      try{await apiRequest(`/api/projects/${state.projectId}/files`,{method:'POST',body:fd});done++}catch(e){failed.push(`${f.name}: ${e.message}`)}
    }
    await load();
    setStatus(failed.length?`อัปโหลดสำเร็จ ${done} ไฟล์ · ไม่สำเร็จ ${failed.length}: ${failed.join(' / ')}`:`อัปโหลดสำเร็จ ${done} ไฟล์`,failed.length>0);
  }
  async function mkdir(){
    const name=prompt('ชื่อโฟลเดอร์ใหม่');if(!name||!name.trim())return;
    try{await apiRequest(`/api/projects/${state.projectId}/folders`,{method:'POST',body:{name:name.trim(),parent_id:state.folder}});await load()}catch(e){setStatus(e.message,true)}
  }
  async function rename(i){
    const base=i.kind==='file'?i.name.replace(/\.[^.]+$/,''):i.name;
    const name=prompt('ชื่อใหม่',base);if(!name||!name.trim()||name.trim()===base)return;
    try{await apiRequest(`/api/project-files/${i.id}`,{method:'PATCH',body:{name:name.trim()}});await load()}catch(e){setStatus(e.message,true)}
  }
  function replaceFile(i){
    const inp=document.createElement('input');inp.type='file';inp.accept=typeOf(i.mime_type)==='image'?'image/*':'.pdf,.docx,.xlsx';
    inp.onchange=async()=>{const f=inp.files[0];if(!f)return;if(!confirm(`แทนที่ "${i.name}" ด้วย "${f.name}"?`))return;setStatus('กำลังแทนที่ไฟล์…');
      const fd=new FormData();fd.append('file',f);
      try{await apiRequest(`/api/project-files/${i.id}/replace`,{method:'POST',body:fd});await load();setStatus('แทนที่ไฟล์แล้ว')}catch(e){setStatus(e.message,true)}};
    inp.click();
  }
  async function remove(i){
    if(!confirm(`ลบ${i.kind==='folder'?'โฟลเดอร์':'ไฟล์'} "${i.name}"?`))return;
    try{await apiRequest(`/api/project-files/${i.id}`,{method:'DELETE'});await load()}catch(e){setStatus(e.message,true)}
  }
  function moveUi(i){state.moving=i;renderMove()}
  function renderMove(){
    const box=$('[data-move]');const i=state.moving;
    if(!i){box.innerHTML='';return}
    const blocked=new Set();if(i.kind==='folder'){const walk=id=>{blocked.add(id);children(id).forEach(c=>c.kind==='folder'&&walk(c.id))};walk(i.id)}
    const opts=items().filter(f=>f.kind==='folder'&&!blocked.has(f.id)).map(f=>({id:f.id,label:path(f.id).map(x=>x.name).join(' › ')})).sort((a,b)=>a.label.localeCompare(b.label,'th'));
    box.innerHTML=`<div class="pf-move"><span>ย้าย "<strong>${esc(i.name)}</strong>" ไปที่</span><select data-target><option value="">ทั้งหมด (ชั้นบนสุด)</option>${opts.map(o=>`<option value="${o.id}" ${o.id===i.parent_id?'selected':''}>${esc(o.label)}</option>`).join('')}</select><button class="btn btn-primary" data-do-move>ย้าย</button><button class="btn btn-ghost" data-cancel-move>ยกเลิก</button></div>`;
    box.querySelector('[data-cancel-move]').onclick=()=>{state.moving=null;renderMove()};
    box.querySelector('[data-do-move]').onclick=async()=>{const v=box.querySelector('[data-target]').value;
      try{await apiRequest(`/api/project-files/${i.id}`,{method:'PATCH',body:{parent_id:v?Number(v):null}});state.moving=null;await load()}catch(e){setStatus(e.message,true)}};
  }

  async function preview(i){
    if(!i)return;
    const t=typeOf(i.mime_type);
    const ov=document.createElement('div');ov.className='pf-preview';
    ov.innerHTML=`<div class="pf-preview-bar"><strong>${esc(i.name)}</strong><a href="${url(i.id,1)}">ดาวน์โหลด</a><button data-x>ปิด ✕</button></div><div class="pf-preview-body" data-pv><div style="color:#fff">กำลังโหลดตัวอย่าง…</div></div>`;
    (dlg.open?dlg:document.body).appendChild(ov);
    const close=()=>{ov.remove();document.removeEventListener('keydown',onKey,true)};
    const onKey=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close()}};
    document.addEventListener('keydown',onKey,true);
    ov.querySelector('[data-x]').onclick=close;
    const pv=ov.querySelector('[data-pv]');
    try{
      if(t==='pdf'){pv.innerHTML=`<iframe src="${url(i.id)}" title="ตัวอย่าง PDF"></iframe>`;return}
      if(t==='image'){pv.innerHTML=`<img src="${url(i.id)}" alt="${esc(i.name)}">`;return}
      const res=await fetch(url(i.id),{credentials:'same-origin'});if(!res.ok)throw new Error('เปิดไฟล์ไม่สำเร็จ');
      const buf=await res.arrayBuffer();
      const frame=html=>{const f=document.createElement('iframe');f.setAttribute('sandbox','');f.title='ตัวอย่างเอกสาร';
        f.srcdoc=`<!doctype html><meta charset="utf-8"><style>body{font-family:'Sarabun','TH Sarabun New',Tahoma,sans-serif;max-width:860px;margin:24px auto;padding:0 24px;line-height:1.6;color:#222}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:3px 6px;font-size:13px}img{max-width:100%}</style>${html}`;return f};
      if(t==='docx'){
        const mammoth=await loadScript('https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js','mammoth');
        const out=await mammoth.convertToHtml({arrayBuffer:buf});pv.innerHTML='';pv.appendChild(frame(out.value||'<p>(เอกสารว่าง)</p>'));return;
      }
      if(t==='xlsx'){
        const XLSX=await loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js','XLSX');
        const wb=XLSX.read(buf,{type:'array'});
        const show=name=>{pv.querySelectorAll('.pf-sheet-tabs button').forEach(b=>b.setAttribute('aria-selected',b.dataset.sheet===name));
          const old=pv.querySelector('iframe');if(old)old.remove();pv.appendChild(frame(XLSX.utils.sheet_to_html(wb.Sheets[name],{editable:false})))};
        pv.innerHTML=`<div class="pf-sheet-tabs">${wb.SheetNames.map(n=>`<button data-sheet="${esc(n)}">${esc(n)}</button>`).join('')}</div>`;
        pv.querySelectorAll('[data-sheet]').forEach(b=>b.onclick=()=>show(b.dataset.sheet));
        show(wb.SheetNames[0]);return;
      }
      pv.innerHTML='<div style="color:#fff">ไฟล์ชนิดนี้แสดงตัวอย่างไม่ได้ กรุณาดาวน์โหลด</div>';
    }catch(e){pv.innerHTML=`<div style="color:#fff">${esc(e.message)}</div>`}
  }

  document.addEventListener('click',e=>{const b=e.target.closest('[data-project-files]');if(!b)return;e.preventDefault();open(Number(b.dataset.projectFiles))});
  window.ProjectFiles={open};
})();
