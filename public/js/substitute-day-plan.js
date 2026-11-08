// จัดสอนแทนทั้งวัน — ครูที่ไม่อยู่หลายคนพร้อมกัน ระบบเสนอครูโดยไม่ชนคาบ ผู้จัดแก้แล้วบันทึกครั้งเดียว
(function(){
const $=id=>document.getElementById(id),esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
const leaveTypes={sick:"ลาป่วย",personal:"ลากิจ",maternity:"ลาคลอด",paternity:"ลาช่วยภริยาคลอดบุตร",lenient:"ลาอนุโลม",other:"ลาอื่น ๆ"};
let plan=null,extras=[],version=0,hooks={};
function say(m,err=false){const el=$("dayStatus");el.hidden=!m;el.textContent=m||'';el.classList.toggle("error",err)}
function reasonOf(){return $("dayReasonType").value==='other'?String($("dayReasonText").value||'').trim():$("dayReasonType").value}
function renderExtras(){$("dayExtras").innerHTML=extras.map((x,i)=>`<span class="chip">${esc(x.full_name)} · ${esc(x.reason)} <button type="button" data-rm="${i}" aria-label="เอาออก">×</button></span>`).join('');
 $("dayExtras").querySelectorAll("[data-rm]").forEach(b=>b.onclick=()=>{extras.splice(Number(b.dataset.rm),1);renderExtras();build()})}
// ตรวจครูซ้ำในคาบเดียวกัน (หลังผู้จัดเปลี่ยนตัวเลือก)
function checkClash(){const seen=new Map();let clash=0;$("dayPlan").querySelectorAll("select[data-entry]").forEach(s=>{s.classList.remove("clash")});
 $("dayPlan").querySelectorAll("select[data-entry]").forEach(s=>{if(!s.value)return;const k=s.value+':'+s.dataset.period;if(seen.has(k)){s.classList.add("clash");seen.get(k).classList.add("clash");clash++}else seen.set(k,s)});
 const empty=[...$("dayPlan").querySelectorAll("select[data-entry]")].filter(s=>!s.value).length,total=$("dayPlan").querySelectorAll("select[data-entry]").length;
 $("daySave").disabled=!total||clash>0||total===empty;
 say(clash?`มีครูถูกเลือกซ้ำในคาบเดียวกัน ${clash} จุด (กรอบสีแดง) — เปลี่ยนก่อนบันทึก`:empty?`ยังไม่ได้เลือกครูสอนแทน ${empty} คาบ — บันทึกเฉพาะคาบที่เลือกแล้วได้`:'',!!clash)}
function render(){const box=$("dayPlan");if(!plan){box.innerHTML='';return}
 if(!plan.teachers.length){box.innerHTML='<div class="notice">วันนี้ไม่มีครูที่ลาหรือไม่อยู่ — เพิ่มครูที่ไม่อยู่ด้านบนได้</div>';$("daySave").disabled=true;return}
 box.innerHTML=plan.teachers.map(t=>{const why=t.source==='leave'?`${leaveTypes[t.leave_type]||t.leave_type||'ลา'} · ใบลา ${t.leave_status==='approved'?'อนุมัติแล้ว':'รอพิจารณา'}`:(t.reason||'ยังไม่ระบุเหตุ');
  const rows=t.lessons.length?t.lessons.map(l=>{const where=`${esc(l.grade_level)}/${esc(l.classroom)}`;
   if(l.assignment_id)return `<tr class="done-row"><td>${l.period}</td><td>${where}</td><td>${esc(l.subject)}</td><td>✓ ${esc(l.substitute_name)} <small>(บันทึกแล้ว)</small></td></tr>`;
   const opts='<option value="">— ไม่จัด / เลือกครู —</option>'+l.options.map(o=>`<option value="${o.id}"${o.id===l.proposed_teacher_id?' selected':''}>${o.id===l.proposed_teacher_id?'★ ':''}${esc(o.full_name)}${o.same_band?'':' · ต่างช่วงชั้น'} · ภาคนี้ ${o.term_count} คาบ</option>`).join('');
   return `<tr><td>${l.period}</td><td>${where}</td><td>${esc(l.subject)}</td><td><select data-entry="${l.entry_id}" data-teacher="${t.teacher_id}" data-period="${l.period}">${opts}</select>${!l.options.length?'<small class="warn">ไม่มีครูว่างคาบนี้</small>':l.cross_band?'<small class="warn">ใช้ครูต่างช่วงชั้น</small>':''}</td></tr>`}).join(''):'<tr><td colspan="4">ไม่มีคาบสอนในวันนี้</td></tr>';
  return `<div class="day-teacher"><h3>${esc(t.full_name)} <small>${esc(why)}</small></h3><table><thead><tr><th>คาบ</th><th>ชั้น/ห้อง</th><th>วิชา</th><th>ครูสอนแทน</th></tr></thead><tbody>${rows}</tbody></table></div>`}).join('');
 box.querySelectorAll("select[data-entry]").forEach(s=>s.onchange=checkClash);checkClash();
 if(plan.unfilled)say(`มี ${plan.unfilled} คาบที่ไม่มีครูว่างเลย — เลือกเองหรือเว้นไว้`,false)}
async function build(){const date=$("date").value,v=++version;plan=null;render();$("daySave").disabled=true;if(!date)return;say('กำลังจัดสอนแทนทั้งวัน...');
 try{const data=await apiRequest('/api/substitutes/day-plan',{method:'POST',body:{date,extras:extras.map(x=>({teacher_id:x.teacher_id,reason:x.reason}))}});if(v!==version)return;plan=data;
  const inPlan=new Set(plan.teachers.map(t=>t.teacher_id));
  $("dayAddTeacher").innerHTML='<option value="">เลือกครูที่ไม่อยู่ (ไม่มีใบลา)</option>'+plan.other_teachers.filter(t=>!inPlan.has(t.id)).map(t=>`<option value="${t.id}">${esc(t.full_name)}</option>`).join('');
  say('');render();if(!plan.unfilled&&plan.teachers.length)say(`จัดให้ครบแล้ว ${plan.teachers.length} คน ไม่มีครูสอนแทนชนคาบ — ตรวจแล้วกดบันทึกทั้งหมด`)}
 catch(e){if(v===version)say(e.message,true)}}
async function save(){const items=[...$("dayPlan").querySelectorAll("select[data-entry]")].filter(s=>s.value).map(s=>({teacher_id:Number(s.dataset.teacher),entry_id:Number(s.dataset.entry),substitute_teacher_id:Number(s.value)}));
 if(!items.length)return;$("daySave").disabled=true;
 try{const r=await apiRequest('/api/substitutes/day-plan/save',{method:'POST',body:{date:$("date").value,items,extras:extras.map(x=>({teacher_id:x.teacher_id,reason:x.reason}))}});
  extras=[];renderExtras();await Promise.all([build(),hooks.reload?.()]);say(`บันทึกแล้ว ${r.saved} คาบ — ดาวน์โหลดคำสั่งรวม Word / PDF ด้านล่างได้เลย`);$("assignments")?.scrollIntoView({behavior:'smooth'})}
 catch(e){say(e.message,true);$("daySave").disabled=false}}
function init(h){hooks=h||{};
 $("dayBuild").onclick=build;$("daySave").onclick=save;
 $("dayReasonType").onchange=()=>{$("dayReasonTextWrap").hidden=$("dayReasonType").value!=='other'};
 $("dayAdd").onclick=()=>{const id=Number($("dayAddTeacher").value),reason=reasonOf();if(!id){say('เลือกครูที่ไม่อยู่',true);return}if(!reason){say('ระบุเหตุที่ไม่อยู่',true);return}
  extras.push({teacher_id:id,full_name:$("dayAddTeacher").selectedOptions[0].textContent,reason});renderExtras();build()};}
window.SubstituteDayPlan={init,build,reset(){extras=[];renderExtras();plan=null;render();say('')}};
})();
