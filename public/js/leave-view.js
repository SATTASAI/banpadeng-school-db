(async()=>{
 const target=document.getElementById('content');
 const token=new URLSearchParams(location.search).get('token');
 history.replaceState(null,'','/leave-view.html');
 if(!token){target.textContent='ไม่พบลิงก์ใบลา กรุณาเปิดลิงก์จากข้อความ LINE อีกครั้ง';return;}
 try{
  const response=await fetch('/api/leave-view',{method:'POST',headers:{'Content-Type':'application/json'},
   credentials:'omit',cache:'no-store',body:JSON.stringify({token})});
  if(!response.ok){target.textContent='ลิงก์นี้ไม่ถูกต้องหรือหมดอายุแล้ว กรุณาขอลิงก์ใหม่';return;}
  const {leave:r}=await response.json();
  const types={sick:'ลาป่วย',personal:'ลากิจส่วนตัว',maternity:'ลาคลอดบุตร',lenient:'ลาอนุโลม',other:'อื่น ๆ'};
  const status=r.status==='approved'?'อนุญาตแล้ว':r.status==='rejected'?'ไม่อนุญาต':
   ({submitted:'รอหัวหน้าฝ่ายบุคลากรรับทราบ',acknowledged:'หัวหน้าฝ่ายรับทราบแล้ว',forwarded:'ส่งต่อผู้บริหารแล้ว'})[r.workflow_stage]||'รอดำเนินการ';
  target.textContent='';
  for(const [label,value] of [['เลขที่ใบลา',r.id],['ผู้ยื่น',r.full_name],['ประเภท',types[r.leave_type]||r.leave_type],
   ['วันที่ลา',`${r.start_date} ถึง ${r.end_date}`],['จำนวนวัน',r.leave_days??'—'],['เหตุผล',r.reason||'—'],['สถานะ',status]]){
   const row=document.createElement('div'),name=document.createElement('span'),data=document.createElement('span');
   row.className='row';name.className='label';data.className='value';name.textContent=label;data.textContent=String(value);
   row.append(name,data);target.append(row);
  }
 }catch{target.textContent='โหลดข้อมูลไม่ได้ กรุณาลองเปิดลิงก์อีกครั้ง';}
})();
