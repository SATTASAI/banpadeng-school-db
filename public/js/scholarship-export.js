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
 // rep.roundCols = [1,2,3] → มุมมองรวมทั้งปี: คอลัมน์ยอดรายครั้ง + รวม (r.by[ครั้ง])
 function pdfDoc(rep){
  const hd={bold:true,fillColor:'#e8f0f8',alignment:'center'},rc=rep.roundCols||null,R={alignment:'right'};
  const head=[{...hd,text:'ที่'},{...hd,text:'เลขประจำตัว'},{...hd,text:'ชื่อ – นามสกุล'},{...hd,text:'ชั้น/ห้อง'},...(rc?[...rc.map(r=>({...hd,text:'ครั้งที่ '+r})),{...hd,text:'รวม (บาท)'}]:[{...hd,text:'ยอดเงิน (บาท)'},{...hd,text:'หมายเหตุ'}])];
  const body=[head];
  rep.rows.forEach((r,i)=>body.push([{text:String(i+1),alignment:'center'},{text:r.student_code||'',alignment:'center'},r.full_name||'',{text:r.room||'',alignment:'center'},
   ...(rc?[...rc.map(k=>({...R,text:r.by?.[k]!=null?money(r.by[k]):'-'})),{...R,bold:true,text:money(r.amount)}]:[{...R,text:money(r.amount)},r.notes||''])]));
  const roundSum=k=>rep.rows.reduce((s,r)=>s+(Number(r.by?.[k])||0),0);
  body.push([{text:`รวม ${rep.rows.length} คน`,colSpan:4,bold:true,alignment:'right'},{},{},{},...(rc?[...rc.map(k=>({...R,bold:true,text:money(roundSum(k))})),{...R,bold:true,text:money(sum(rep.rows))}]:[{...R,bold:true,text:money(sum(rep.rows))},''])]);
  const widths=rc?[22,60,'*',52,...rc.map(()=>52),60]:[24,64,'*',58,74,90];
  const roomBody=[[{...hd,text:'ชั้น/ห้อง'},{...hd,text:'จำนวน (คน)'},{...hd,text:'ยอดเงิน (บาท)'}],
   ...(rep.rooms||[]).map(r=>[r.room,{text:String(r.count),alignment:'center'},{...R,text:money(r.sum)}]),
   [{text:'รวม',bold:true},{text:String(rep.rows.length),bold:true,alignment:'center'},{...R,bold:true,text:money(sum(rep.rows))}]];
  return {pageSize:'A4',pageMargins:[36,40,36,40],defaultStyle:{font:'Sarabun',fontSize:14},
   footer:(p,n)=>({text:`หน้า ${p}/${n}`,alignment:'right',margin:[0,8,36,0],fontSize:11}),
   content:[{text:'โรงเรียนบ้านป่าเด็ง',alignment:'center',bold:true,fontSize:16},{text:rep.title,alignment:'center',bold:true,fontSize:18},{text:rep.subtitle||'',alignment:'center',margin:[0,0,0,10]},
    {table:{headerRows:1,widths,body},layout:{hLineColor:'#9aa9b8',vLineColor:'#9aa9b8'}},
    ...(rep.rooms?.length?[{text:'สรุปรายห้อง',bold:true,fontSize:16,margin:[0,16,0,6]},{table:{headerRows:1,widths:['*',90,110],body:roomBody},layout:{hLineColor:'#9aa9b8',vLineColor:'#9aa9b8'}}]:[])]};
 }
 function sheets(rep){
  const rc=rep.roundCols||null,num=v=>v==null||v===''?'':Number(v);
  const list=[['ที่','เลขประจำตัว','ชื่อ – นามสกุล','ชั้น/ห้อง',...(rc?[...rc.map(k=>'ครั้งที่ '+k),'รวม (บาท)']:['ยอดเงิน (บาท)']),'หมายเหตุ'],
   ...rep.rows.map((r,i)=>[i+1,r.student_code||'',r.full_name||'',r.room||'',...(rc?[...rc.map(k=>num(r.by?.[k])),num(r.amount)]:[num(r.amount)]),r.notes||'']),
   ['','','รวม '+rep.rows.length+' คน','',...(rc?[...rc.map(k=>rep.rows.reduce((s,r)=>s+(Number(r.by?.[k])||0),0)),sum(rep.rows)]:[sum(rep.rows)]),'']];
  const rooms=[['ชั้น/ห้อง','จำนวน (คน)','ยอดเงิน (บาท)'],...(rep.rooms||[]).map(r=>[r.room,r.count,r.sum]),['รวม',rep.rows.length,sum(rep.rows)]];
  return {title:[[rep.title],[rep.subtitle||''],[]],list,rooms};
 }
 function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000)}
 async function pdf(rep){const lib=await pdfLib();lib.createPdf(pdfDoc(rep)).download(safe(rep.fileName)+'.pdf')}
 async function xlsx(rep){
  const X=await script('XLSX','https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'),s=sheets(rep),book=X.utils.book_new();
  const a=X.utils.aoa_to_sheet([...s.title,...s.list]);a['!cols']=s.list[0].map((h,i)=>({wch:i===2?36:i===s.list[0].length-1?30:i===0?6:14}));X.utils.book_append_sheet(book,a,'รายชื่อ');
  const b=X.utils.aoa_to_sheet([...s.title,...s.rooms]);b['!cols']=[{wch:20},{wch:14},{wch:16}];X.utils.book_append_sheet(book,b,'สรุปรายห้อง');
  download(new Blob([X.write(book,{type:'array',bookType:'xlsx'})],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}),safe(rep.fileName)+'.xlsx');
 }
 root.ScholarshipExport={pdf,xlsx,pdfDoc,sheets};
})(typeof window==='undefined'?globalThis:window);
