/* ส่งออกรายชื่อผู้ได้รับทุนการศึกษาเป็น PDF (pdfmake + TH Sarabun PSK) และ Excel (.xlsx)
   ScholarshipExport.pdf(report) / .xlsx(report)
   report = {title, subtitle, fileName, rows:[{student_code, full_name, room, amount, notes}], rooms:[{room, count, sum}]} */
(function(root){
 'use strict';
 let fontCache=null;
 const loading=new Map();
 function script(name,src){
  if(root[name])return Promise.resolve(root[name]);
  if(!loading.has(name))loading.set(name,new Promise((ok,no)=>{const s=document.createElement('script');s.src=src;s.onload=()=>root[name]?ok(root[name]):no(new Error('โหลดเครื่องมือส่งออกไม่สำเร็จ'));s.onerror=()=>{loading.delete(name);no(new Error('โหลดเครื่องมือส่งออกไม่สำเร็จ'))};document.head.appendChild(s)}));
  return loading.get(name);
 }
 async function pdfLib(){
  const pdf=await script('pdfMake','/js/pdfmake.min.js');
  if(!fontCache)fontCache=Object.fromEntries(await Promise.all(['THSarabunPSK-Regular.ttf','THSarabunPSK-Bold.ttf'].map(async name=>{
   const r=await fetch('/fonts/'+name);if(!r.ok)throw Error('โหลดฟอนต์ภาษาไทยไม่สำเร็จ');
   const bytes=new Uint8Array(await r.arrayBuffer());let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return [name,btoa(text)];
  })));
  pdf.vfs={...(pdf.vfs||{}),...fontCache};
  pdf.fonts={...(pdf.fonts||{}),Sarabun:{normal:'THSarabunPSK-Regular.ttf',bold:'THSarabunPSK-Bold.ttf',italics:'THSarabunPSK-Regular.ttf',bolditalics:'THSarabunPSK-Bold.ttf'}};
  return pdf;
 }
 const money=n=>n==null||n===''?'-':Number(n).toLocaleString('th-TH',{minimumFractionDigits:2,maximumFractionDigits:2});
 const sum=rows=>rows.reduce((s,r)=>s+(Number(r.amount)||0),0);
 const safe=s=>String(s||'ทุนการศึกษา').replace(/[\\/:*?"<>|]+/g,' ').trim();

 // เนื้อหา PDF แยกเป็นฟังก์ชันเพื่อทดสอบได้
 function pdfDoc(rep){
  const hd={bold:true,fillColor:'#e8f0f8',alignment:'center'};
  const body=[[{...hd,text:'ที่'},{...hd,text:'เลขประจำตัว'},{...hd,text:'ชื่อ – นามสกุล'},{...hd,text:'ชั้น/ห้อง'},{...hd,text:'ยอดเงิน (บาท)'},{...hd,text:'หมายเหตุ'}]];
  rep.rows.forEach((r,i)=>body.push([{text:String(i+1),alignment:'center'},{text:r.student_code||'',alignment:'center'},r.full_name||'',{text:r.room||'',alignment:'center'},{text:money(r.amount),alignment:'right'},r.notes||'']));
  body.push([{text:'รวม',colSpan:4,bold:true,alignment:'right'},{},{},{},{text:money(sum(rep.rows)),bold:true,alignment:'right'},{text:`${rep.rows.length} คน`,bold:true}]);
  const roomBody=[[{...hd,text:'ชั้น/ห้อง'},{...hd,text:'จำนวน (คน)'},{...hd,text:'ยอดเงิน (บาท)'}],
   ...(rep.rooms||[]).map(r=>[r.room,{text:String(r.count),alignment:'center'},{text:money(r.sum),alignment:'right'}]),
   [{text:'รวม',bold:true},{text:String(rep.rows.length),bold:true,alignment:'center'},{text:money(sum(rep.rows)),bold:true,alignment:'right'}]];
  return {pageSize:'A4',pageMargins:[40,40,40,40],defaultStyle:{font:'Sarabun',fontSize:14},
   footer:(p,n)=>({text:`หน้า ${p}/${n}`,alignment:'right',margin:[0,8,40,0],fontSize:11}),
   content:[{text:'โรงเรียนบ้านป่าเด็ง',alignment:'center',bold:true,fontSize:16},{text:rep.title,alignment:'center',bold:true,fontSize:18},{text:rep.subtitle||'',alignment:'center',margin:[0,0,0,10]},
    {table:{headerRows:1,widths:[24,64,'*',58,74,90],body},layout:{hLineColor:'#9aa9b8',vLineColor:'#9aa9b8'}},
    ...(rep.rooms?.length?[{text:'สรุปรายห้อง',bold:true,fontSize:16,margin:[0,16,0,6]},{table:{headerRows:1,widths:['*',90,110],body:roomBody},layout:{hLineColor:'#9aa9b8',vLineColor:'#9aa9b8'}}]:[])]};
 }
 function sheets(rep){
  const list=[['ที่','เลขประจำตัว','ชื่อ – นามสกุล','ชั้น/ห้อง','ยอดเงิน (บาท)','หมายเหตุ'],...rep.rows.map((r,i)=>[i+1,r.student_code||'',r.full_name||'',r.room||'',r.amount==null?'':Number(r.amount),r.notes||'']),['','','รวม '+rep.rows.length+' คน','',sum(rep.rows),'']];
  const rooms=[['ชั้น/ห้อง','จำนวน (คน)','ยอดเงิน (บาท)'],...(rep.rooms||[]).map(r=>[r.room,r.count,r.sum]),['รวม',rep.rows.length,sum(rep.rows)]];
  return {title:[[rep.title],[rep.subtitle||''],[]],list,rooms};
 }
 function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000)}
 async function pdf(rep){const lib=await pdfLib();lib.createPdf(pdfDoc(rep)).download(safe(rep.fileName)+'.pdf')}
 async function xlsx(rep){
  const X=await script('XLSX','https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'),s=sheets(rep),book=X.utils.book_new();
  const a=X.utils.aoa_to_sheet([...s.title,...s.list]);a['!cols']=[{wch:6},{wch:14},{wch:36},{wch:12},{wch:16},{wch:30}];X.utils.book_append_sheet(book,a,'รายชื่อ');
  const b=X.utils.aoa_to_sheet([...s.title,...s.rooms]);b['!cols']=[{wch:20},{wch:14},{wch:16}];X.utils.book_append_sheet(book,b,'สรุปรายห้อง');
  download(new Blob([X.write(book,{type:'array',bookType:'xlsx'})],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}),safe(rep.fileName)+'.xlsx');
 }
 root.ScholarshipExport={pdf,xlsx,pdfDoc,sheets};
})(typeof window==='undefined'?globalThis:window);
