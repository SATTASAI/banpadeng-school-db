window.ProjectAllocationChart=(()=>{
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 // Ocean palette shared by the pie slices and their legend, stable by project ID.
 const palette=['#247BAC','#68B9CF','#379B9D','#8BA7CF','#195B79','#99CDD5','#557AA8','#78ADA9','#B1C7DE','#3B688D','#4EA9C2','#A3C4C3'];
 const money=v=>Number(v||0).toLocaleString('th-TH',{minimumFractionDigits:2,maximumFractionDigits:2});
 function render(root,projects,scope='ทุกโครงการ'){
  if(!root)return;
  const rows=projects.map(p=>({...p,cents:Math.max(0,Math.round(Number(p.budget_amount||0)*100))})).sort((a,b)=>b.cents-a.cents||a.id-b.id);
  const total=rows.reduce((s,p)=>s+p.cents,0);let end=0;
  const shares=rows.map(p=>total?p.cents/total*100:0),hundredths=shares.map(p=>Math.floor(p*100));
  if(total){let remaining=10000-hundredths.reduce((s,p)=>s+p,0);const order=shares.map((p,i)=>({i,f:p*100-hundredths[i]})).sort((a,b)=>b.f-a.f||a.i-b.i);for(let n=0;n<remaining;n++)hundredths[order[n%order.length].i]++;}
  const segments=rows.map((p,i)=>{p.color=palette[Math.abs(Number(p.id)-1)%palette.length];const start=end;end+=shares[i];return `${p.color} ${start}% ${end}%`;});
  root.innerHTML=`<section class="allocation-chart"><h3>สัดส่วนงบประมาณที่แต่ละโครงการได้รับ</h3><p class="ac-caption">${esc(scope)} · งบจัดสรรรวม ${money(total/100)} บาท</p>
    ${rows.length?`<div class="ac-layout"><div class="ac-pie" role="img" aria-label="แผนภูมิวงกลมสัดส่วนงบจัดสรร ${esc(scope)} รายละเอียดและเปอร์เซ็นต์อยู่ในตาราง" style="background:${total?'conic-gradient('+segments.join(',')+')':'#e3ebf2'}"></div><div class="ac-table"><table><thead><tr><th>โครงการ</th><th>งบที่ได้รับ (บาท)</th><th>สัดส่วน</th></tr></thead><tbody>${rows.map((p,i)=>`<tr data-allocation-project="${p.id}"><td><span class="ac-dot" style="background:${p.color}"></span>${esc(p.name)}<small>ปี ${p.fiscal_year||'—'} · รหัสโครงการ ${p.id}</small></td><td>${money(p.cents/100)}</td><td>${(hundredths[i]/100).toFixed(2)}%</td></tr>`).join('')}</tbody></table></div></div>${!total?'<p class="ac-caption">ยังไม่มีงบจัดสรร จึงยังคำนวณสัดส่วนไม่ได้</p>':''}`:'<p class="ac-caption">ยังไม่มีโครงการ</p>'}
    <p class="ac-caption">คำนวณจากงบจัดสรรของโครงการ · รวมโครงการทุกสถานะ · เปอร์เซ็นต์ปัดทศนิยม 2 ตำแหน่ง</p></section>`;
 }
 return {render};
})();
