window.ProjectAllocationChart=(()=>{
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 // Ocean palette shared by the pie slices and their legend, stable by project ID.
 const palette=['#247BAC','#68B9CF','#379B9D','#8BA7CF','#195B79','#99CDD5','#557AA8','#78ADA9','#B1C7DE','#3B688D','#4EA9C2','#A3C4C3'];
 const themes={
  academic:{label:'ฝ่ายวิชาการ',colors:['#235C99','#3475B4','#5191C6','#73ADD6','#96C4E5','#B9DBEF']},
  early_childhood:{label:'ฝ่ายปฐมวัย (งานอนุบาล)',colors:['#A06A21','#B58435','#C69E54','#D6B575','#E5CD99','#EFE1BF']},
  budget:{label:'ฝ่ายงบประมาณ',colors:['#246B58','#338570','#509E87','#74B7A0','#9ACDBA','#C0E2D3']},
  personnel:{label:'ฝ่ายบุคคล',colors:['#62538F','#7C67A6','#9682BD','#AF9CD0','#C8B8E0','#E0D5EE']},
  general:{label:'ฝ่ายบริหารทั่วไป',colors:['#246D7A','#338999','#52A4B1','#79BEC8','#A0D4DB','#C5E7EB']}
 };
 const money=v=>Number(v||0).toLocaleString('th-TH',{minimumFractionDigits:2,maximumFractionDigits:2});
 function render(root,projects,scope='ทุกโครงการ',department){
  if(!root)return;
  const theme=themes[department||projects[0]?.department],colors=theme?.colors||palette;
  const rows=projects.map(p=>({...p,cents:Math.max(0,Math.round(Number(p.budget_amount||0)*100))})).sort((a,b)=>b.cents-a.cents||a.id-b.id);
  const total=rows.reduce((s,p)=>s+p.cents,0);let end=0;
  const shares=rows.map(p=>total?p.cents/total*100:0),hundredths=shares.map(p=>Math.floor(p*100));
  if(total){let remaining=10000-hundredths.reduce((s,p)=>s+p,0);const order=shares.map((p,i)=>({i,f:p*100-hundredths[i]})).sort((a,b)=>b.f-a.f||a.i-b.i);for(let n=0;n<remaining;n++)hundredths[order[n%order.length].i]++;}
  const segments=rows.map((p,i)=>{p.color=colors[Math.abs(Number(p.id)-1)%colors.length];const start=end;end+=shares[i];return `${p.color} ${start}% ${end}%`;});
  root.innerHTML=`<section class="allocation-chart" data-allocation-department="${esc(department||projects[0]?.department||'all')}" style="--ac-tone:${colors[0]}"><h3>${theme?esc(theme.label)+' · ':''}สัดส่วนงบประมาณโครงการ</h3><p class="ac-caption">${esc(scope)} · งบจัดสรรรวม ${money(total/100)} บาท</p>
    <div class="ac-layout"><div class="ac-pie" role="img" aria-label="แผนภูมิวงกลมสัดส่วนงบจัดสรร ${esc(scope)} รายละเอียดและเปอร์เซ็นต์อยู่ในตาราง" style="background:${total?'conic-gradient('+segments.join(',')+')':'#e3ebf2'}"></div><div class="ac-table"><table><thead><tr><th>โครงการ</th><th>งบที่ได้รับ (บาท)</th><th>สัดส่วน</th></tr></thead><tbody>${rows.map((p,i)=>`<tr data-allocation-project="${p.id}"><td><span class="ac-dot" style="background:${p.color}"></span>${esc(p.name)}<small>ปี ${p.fiscal_year||'—'} · รหัสโครงการ ${p.id}</small></td><td>${money(p.cents/100)}</td><td>${(hundredths[i]/100).toFixed(2)}%</td></tr>`).join('')||'<tr><td colspan="3">ยังไม่มีโครงการ</td></tr>'}</tbody></table></div></div>${!total?'<p class="ac-caption">ยังไม่มีงบจัดสรร จึงยังคำนวณสัดส่วนไม่ได้</p>':''}
    <p class="ac-caption">คำนวณจากงบจัดสรรของโครงการ${theme?'ภายในฝ่ายนี้':''} · รวมโครงการทุกสถานะ · เปอร์เซ็นต์ปัดทศนิยม 2 ตำแหน่ง</p></section>`;
 }
 function renderDepartments(root,departments,period='ทุกปีงบประมาณ'){
  if(!root)return;
  root.replaceChildren();
  for(const group of departments){const panel=document.createElement('div');root.append(panel);render(panel,group.projects||[],period,group.department);}
 }
 return {render,renderDepartments};
})();
