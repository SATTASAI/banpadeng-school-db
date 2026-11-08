const records=document.querySelector('#records'),message=document.querySelector('#message');let offset=0;
const date=value=>new Date(value.replace(' ','T')+'Z').toLocaleString('th-TH',{timeZone:'Asia/Bangkok',dateStyle:'long',timeStyle:'medium'});
function element(tag,text,className){const node=document.createElement(tag);node.textContent=text;if(className)node.className=className;return node;}
async function load(){
 records.replaceChildren();message.textContent='กำลังโหลด…';document.querySelector('#prev').disabled=true;document.querySelector('#next').disabled=true;
 try{const response=await fetch('/api/student-transfers/notices?offset='+offset,{cache:'no-store'});const data=await response.json();if(!response.ok){if(response.status===401){message.replaceChildren(element('span','กรุณาเข้าสู่ระบบก่อน '));const link=element('a','เข้าสู่ระบบ');link.href='/login.html';message.append(link);return;}throw new Error(data.error||'โหลดไม่สำเร็จ');}
 message.textContent=`ทั้งหมด ${data.total} รายการ`;
 for(const row of data.notices){const card=element('article','','card record');card.append(element('span',row.direction==='in'?'ย้ายเข้า':'ย้ายออก','tag'),element('h2',row.student_name));const dl=document.createElement('dl');for(const [label,value]of [['เลขรับแจ้ง',row.receipt],['วันเวลารับแจ้ง',date(row.created_at)],...(row.direction==='out'?[['โรงเรียนปลายทาง',row.destination_school]]:[]),['เบอร์ติดต่อ',row.contact_phone],['ที่อยู่',row.contact_address]]){dl.append(element('dt',label),element('dd',value));}card.append(dl);
 if(row.request_id){const link=element('a','เปิดคำร้องเพื่อดำเนินการต่อ','button');link.href=`/dmcreport/?request=${row.request_id}&direction=${row.direction}`;card.append(link);}
 if(row.acknowledged_at)card.append(element('p',`ตรวจสอบแล้ว: ${row.acknowledged_name||'เจ้าหน้าที่'} · ${date(row.acknowledged_at)}`,'tag received'));
 if(!row.request_id){const button=element('button',row.acknowledged_at?'สร้างคำร้องเพื่อดำเนินการต่อ':'ตรวจสอบแล้ว');button.onclick=async()=>{button.disabled=true;try{const res=await fetch(`/api/student-transfers/notices/${row.id}/acknowledge`,{method:'POST'});const data=await res.json();if(!res.ok)throw new Error(data.error||'บันทึกไม่สำเร็จ');await load();location.href=`/dmcreport/?request=${data.request_id}&direction=${row.direction}`;}catch(e){message.textContent=e.message;button.disabled=false;}};card.append(button);}records.append(card);}
 if(!data.total)records.append(element('p','ยังไม่มีรายการแจ้งย้ายเบื้องต้น','card'));
 document.querySelector('#page').textContent=data.total?`${offset+1}–${offset+data.notices.length} / ${data.total}`:'0 รายการ';document.querySelector('#prev').disabled=offset===0;document.querySelector('#next').disabled=offset+50>=data.total;
 }catch(e){message.textContent=e.message;}
}
document.querySelector('#prev').onclick=()=>{offset=Math.max(0,offset-50);load();};document.querySelector('#next').onclick=()=>{offset+=50;load();};document.querySelector('#print-qr').onclick=()=>window.print();load();
