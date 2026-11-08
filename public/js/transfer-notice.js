const form=document.querySelector('#notice-form'),error=document.querySelector('#error'),submit=document.querySelector('#submit');
let clientRef=crypto.randomUUID(),pending=null;
const thaiDate=value=>new Date(value.replace(' ','T')+'Z').toLocaleString('th-TH',{timeZone:'Asia/Bangkok',dateStyle:'long',timeStyle:'medium'});
form.addEventListener('change',()=>{const out=form.elements.direction.value==='out';document.querySelector('#destination').hidden=!out;form.elements.destination_school.required=out;});
form.addEventListener('submit',async event=>{
 event.preventDefault();if(!form.reportValidity())return;
 error.textContent='';submit.disabled=true;submit.textContent='กำลังบันทึก…';
 // Keep the exact submission on retry if a response was lost after the server saved it.
 const body=pending||{...Object.fromEntries(new FormData(form)),client_ref:clientRef};pending=body;
 try{const response=await fetch('/api/public/transfer-notices',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await response.json();if(!response.ok){if(response.status===400)pending=null;throw new Error(data.error||'บันทึกไม่สำเร็จ');}
 document.querySelector('#receipt').textContent=data.receipt;
 document.querySelector('#received-at').textContent='วันเวลารับแจ้ง: '+thaiDate(data.created_at);
 document.querySelector('#submitted-details').textContent=`นักเรียน: ${body.student_name}\nประเภท: ${body.direction==='in'?'ย้ายเข้า':'ย้ายออก'}${body.direction==='out'?'\nโรงเรียนปลายทาง: '+body.destination_school:''}\nเบอร์ติดต่อ: ${body.contact_phone}\nที่อยู่: ${body.contact_address}`;
 form.hidden=true;document.querySelector('#success').hidden=false;document.querySelector('#success').scrollIntoView({behavior:'smooth'});
 }catch(e){error.textContent=e.message==='Failed to fetch'?'เชื่อมต่อไม่ได้ กรุณากดบันทึกอีกครั้ง ระบบจะไม่สร้างรายการซ้ำ':e.message;}
 finally{submit.disabled=false;submit.textContent='บันทึกแจ้งย้ายเบื้องต้น';}
});
document.querySelector('#print').onclick=()=>window.print();
document.querySelector('#another').onclick=()=>{form.reset();pending=null;clientRef=crypto.randomUUID();document.querySelector('#destination').hidden=true;form.elements.destination_school.required=false;document.querySelector('#success').hidden=true;form.hidden=false;form.elements.student_name.focus();};
