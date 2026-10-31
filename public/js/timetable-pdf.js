/* ส่งออกตารางสอน/ตารางเรียนเป็น PDF (A4 แนวนอน หนึ่งตารางต่อหน้า) ด้วย pdfmake + ฟอนต์ TH Sarabun PSK */
(function(root){
 'use strict';
 const DAYS=['จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์'],PERIODS=[1,2,3,4,5,6];
 let fontCache=null;
 function loadScript(src){return new Promise((ok,fail)=>{const s=document.createElement('script');s.src=src;s.onload=ok;s.onerror=()=>fail(Error('โหลดตัวสร้าง PDF ไม่สำเร็จ'));document.head.appendChild(s);});}
 async function pdfLib(){
  if(!root.pdfMake)await loadScript('/js/pdfmake.min.js');
  const pdf=root.pdfMake;
  if(!fontCache)fontCache=Object.fromEntries(await Promise.all(['THSarabunPSK-Regular.ttf','THSarabunPSK-Bold.ttf'].map(async name=>{
   const r=await fetch('/fonts/'+name);if(!r.ok)throw Error('โหลดฟอนต์ภาษาไทยไม่สำเร็จ');
   const bytes=new Uint8Array(await r.arrayBuffer());let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return [name,btoa(text)];
  })));
  pdf.vfs={...(pdf.vfs||{}),...fontCache};
  pdf.fonts={...(pdf.fonts||{}),Sarabun:{normal:'THSarabunPSK-Regular.ttf',bold:'THSarabunPSK-Bold.ttf',italics:'THSarabunPSK-Regular.ttf',bolditalics:'THSarabunPSK-Bold.ttf'}};
  return pdf;
 }
 // sheet = {title, subtitle, entries:[{weekday,period,subject,line}]}
 function sheetContent(sheet,last){
  const head=[{text:'วัน / คาบ',bold:true,alignment:'center',fillColor:'#e8f0f8'},...PERIODS.map(p=>({text:'คาบ '+p,bold:true,alignment:'center',fillColor:'#e8f0f8'}))];
  const body=[head,...DAYS.map((day,d)=>[{text:day,bold:true,alignment:'center',fillColor:'#f4f8fb',margin:[0,14,0,0]},...PERIODS.map(p=>{
   const e=sheet.entries.find(x=>x.weekday===d+1&&x.period===p);
   return e?{stack:[{text:e.subject,bold:true,fontSize:15},{text:e.line||'',fontSize:13,color:'#444'}],alignment:'center',margin:[0,4,0,4]}:{text:''};
  })])];
  return [
   {text:sheet.title,bold:true,fontSize:22,alignment:'center'},
   {text:sheet.subtitle||'',fontSize:16,alignment:'center',margin:[0,0,0,10]},
   {table:{headerRows:1,widths:[70,'*','*','*','*','*','*'],heights:(row)=>row===0?22:62,body},layout:{hLineColor:()=>'#9fb3c8',vLineColor:()=>'#9fb3c8'}},
   {text:`รวม ${sheet.entries.length} คาบต่อสัปดาห์`,fontSize:14,margin:[0,8,0,0],...(last?{}:{pageBreak:'after'})}
  ];
 }
 async function download(sheets,filename){
  if(!sheets.length)throw Error('ไม่มีตารางให้ส่งออก');
  const pdf=await pdfLib();
  const doc={pageSize:'A4',pageOrientation:'landscape',pageMargins:[36,30,36,30],defaultStyle:{font:'Sarabun',fontSize:15},
   content:sheets.flatMap((s,i)=>sheetContent(s,i===sheets.length-1)),
   footer:(p,n)=>({text:`โรงเรียนบ้านป่าเด็ง · หน้า ${p} / ${n}`,alignment:'center',fontSize:11,color:'#777'})};
  pdf.createPdf(doc).download(filename.replace(/[\\/:*?"<>|]/g,'-')+'.pdf');
 }
 root.TimetablePDF={download};
})(window);
