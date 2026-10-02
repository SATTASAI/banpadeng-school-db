(async()=>{
 const $=id=>document.getElementById(id),dept=new URLSearchParams(location.search).get('dept')||'academic';
 const api=`/api/department-staff/${encodeURIComponent(dept)}`;
 document.body.classList.toggle('administration-directory',dept==='administration');
 let data,photoUrl=null,busy=false,headIntent=false;
 const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function error(id,message){$(id).textContent=message;$(id).hidden=!message}
 async function load(){
 try{data=await apiRequest(api);$('departmentTitle').textContent=data.label;document.title=`${data.label} — บุคลากร`;$('staffCount').textContent=`บุคลากร ${data.people.length} คน`;$('addPerson').hidden=!data.permissions.can_manage;
 const card=p=>`<article class="person-card">${p.photo_url?`<img class="person-portrait" src="${esc(p.photo_url)}" alt="${esc(p.full_name)}" loading="lazy">`:`<div class="person-initial" aria-hidden="true">${esc([...p.full_name.trim()][0]||'ครู')}</div>`}<div class="person-details"><h2>${esc(p.full_name)}</h2><p>${esc(p.position||'ยังไม่ระบุตำแหน่ง')}</p><p class="homeroom">${esc(p.homeroom_classroom?'ประจำชั้น '+p.homeroom_classroom:'ไม่ระบุชั้นประจำ')}</p>${data.permissions.can_manage?`<button class="btn btn-ghost edit-person" data-person="${p.id}">แก้ไขข้อมูล</button>`:''}</div></article>`;
 const heads=data.people.filter(p=>p.is_head),members=data.people.filter(p=>!p.is_head),administration=dept==='administration';
 $('headsSection').hidden=false;$('headsTitle').textContent=administration?'ผู้อำนวยการโรงเรียน':'หัวหน้าฝ่าย';
 $('headsGrid').innerHTML=heads.length?heads.map(card).join(''):`<div class="empty-state">${administration?'ยังไม่มีข้อมูลผู้อำนวยการ':'ยังไม่ได้กำหนดหัวหน้าฝ่าย'}${data.permissions.can_manage&&!administration?'<button class="btn btn-ghost" id="chooseHead">กำหนดหัวหน้าฝ่าย</button>':''}</div>`;
 $('membersTitle').hidden=false;$('membersTitle').textContent=administration?'คณะผู้บริหาร':'ครูและบุคลากรในฝ่าย';
 $('peopleGrid').innerHTML=members.length?members.map(card).join(''):`<div class="empty-state">${administration?'ยังไม่มีข้อมูลผู้บริหารท่านอื่น':'ยังไม่มีบุคลากรในฝ่ายนี้'}${data.permissions.can_manage?' · กด “เพิ่มบุคลากร” เพื่อเพิ่มข้อมูล':''}</div>`;
 document.querySelectorAll('[data-person]').forEach(b=>b.onclick=()=>open(Number(b.dataset.person)));
 if($('chooseHead'))$('chooseHead').onclick=()=>open(undefined,true);
 error('pageError','');
 }catch(e){$('departmentTitle').textContent='บุคลากรฝ่ายงาน';error('pageError',e.message)}finally{$('peopleGrid').setAttribute('aria-busy','false')}
 }
 function preview(url){$('photoPreview').hidden=!url;$('photoPlaceholder').hidden=!!url;if(url)$('photoPreview').src=url;else $('photoPreview').removeAttribute('src')}
 function selectPerson(){const p=data.choices.find(p=>p.id===Number($('personChoice').value));$('personName').value=p?.full_name||'';$('personName').readOnly=!!p;$('personPosition').value=p?.position||'';$('personClassroom').value=p?.homeroom_classroom||'';$('personIsHead').checked=headIntent||!!p?.is_head;$('personPhoto').value='';if(photoUrl){URL.revokeObjectURL(photoUrl);photoUrl=null}preview(data.people.find(x=>x.id===p?.id)?.photo_url)}
 function open(id,head=false){headIntent=head;$('personForm').reset();error('formError','');$('dialogTitle').textContent=id?'แก้ไขบุคลากร':'เพิ่มบุคลากร';$('personChoice').innerHTML='<option value="">เพิ่มบุคลากรใหม่</option>'+data.choices.map(p=>`<option value="${p.id}">${esc(p.full_name)}</option>`).join('');$('personChoice').value=id||'';$('personChoice').disabled=!!id;selectPerson();$('headField').hidden=dept==='administration';if(head)$('personIsHead').checked=true;$('personDialog').showModal()}
 const close=()=>{if(!busy)$('personDialog').close()};$('closeDialog').onclick=close;$('cancelDialog').onclick=close;$('addPerson').onclick=()=>open();$('personChoice').onchange=selectPerson;
 $('personDialog').addEventListener('cancel',e=>{if(busy)e.preventDefault()});
 $('personPhoto').onchange=()=>{error('formError','');const file=$('personPhoto').files[0];if(photoUrl){URL.revokeObjectURL(photoUrl);photoUrl=null}if(!file)return;if(file.size>2*1024*1024||!['image/jpeg','image/png','image/webp'].includes(file.type)){$('personPhoto').value='';error('formError','เลือกรูป JPEG, PNG หรือ WebP ไม่เกิน 2 MB');return}photoUrl=URL.createObjectURL(file);preview(photoUrl)};
 async function compress(file){const bitmap=await createImageBitmap(file);try{const canvas=document.createElement('canvas'),ratio=Math.min(1,512/Math.max(bitmap.width,bitmap.height));canvas.width=Math.max(1,Math.round(bitmap.width*ratio));canvas.height=Math.max(1,Math.round(bitmap.height*ratio));const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(bitmap,0,0,canvas.width,canvas.height);for(const quality of [.85,.7,.5,.3]){const blob=await new Promise(r=>canvas.toBlob(r,'image/jpeg',quality));if(blob&&blob.size<=131072)return blob}throw new Error('รูปยังมีขนาดใหญ่เกินไป กรุณาเลือกรูปอื่น')}finally{bitmap.close()}}
 $('personForm').onsubmit=async e=>{e.preventDefault();if(busy)return;busy=true;$('savePerson').disabled=true;$('savePerson').textContent='กำลังบันทึก…';error('formError','');let saved=false;
 try{const file=$('personPhoto').files[0],blob=file?await compress(file):null;const result=await apiRequest(api,{method:'POST',body:{personnel_id:$('personChoice').value?Number($('personChoice').value):null,full_name:$('personName').value,position:$('personPosition').value,homeroom_classroom:$('personClassroom').value,is_head:$('personIsHead').checked}});saved=true;
 if(blob){const response=await fetch(`${api}/${result.id}/photo`,{method:'PUT',body:blob,credentials:'same-origin',headers:{'Content-Type':'image/jpeg'}});if(!response.ok){const detail=await response.json();throw new Error(detail.error||'บันทึกรูปไม่สำเร็จ')}}
 $('personDialog').close();await load();
 }catch(e){error('formError',(saved?'บันทึกชื่อและตำแหน่งแล้ว แต่ยังบันทึกรูปไม่สำเร็จ: ':'')+e.message);if(saved)await load()}finally{busy=false;$('savePerson').disabled=false;$('savePerson').textContent='บันทึก'}
 };
 await load();
})();
