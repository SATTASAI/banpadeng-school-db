/* ส่งออกตารางสอน/ตารางเรียนเป็น PDF (A4 แนวนอน หนึ่งตารางต่อหน้า) ด้วย pdfmake + ฟอนต์ TH Sarabun PSK */
(function(root){
 'use strict';
 const DAYS=['จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์'],PERIODS=[1,2,3,4,5,6];
 // เวลาเรียน: คาบละ 55 นาที เริ่ม 08:30 · พักกลางวัน 11:15–12:45 (หลังคาบ 3)
 const TIMES={1:'08:30–09:25',2:'09:25–10:20',3:'10:20–11:15',4:'12:45–13:40',5:'13:40–14:35',6:'14:35–15:30'},LUNCH={after:3,label:'พักกลางวัน',time:'11:15–12:45'};
 // ลำดับคอลัมน์: คาบ 1–3, พักกลางวัน, คาบ 4–6
 const COLUMNS=[1,2,3,'lunch',4,5,6];
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
  const hd={bold:true,alignment:'center',fillColor:'#e8f0f8',fontSize:12};
  const head=[{...hd,text:'วัน / คาบ',margin:[0,5,0,0]},...COLUMNS.map(c=>c==='lunch'?{...hd,stack:[{text:LUNCH.label},{text:LUNCH.time,fontSize:10,bold:false}]}:{...hd,stack:[{text:'คาบ '+c},{text:TIMES[c],fontSize:10,bold:false}]})];
  const body=[head,...DAYS.map((day,d)=>[{text:day,bold:true,alignment:'center',fillColor:'#f4f8fb',fontSize:12,margin:[0,10,0,0]},...COLUMNS.map(c=>{
   if(c==='lunch')return d===0?{text:LUNCH.label,rowSpan:5,alignment:'center',fillColor:'#fbf6ea',color:'#8a6a1f',fontSize:12,margin:[0,88,0,0]}:{};
   const e=sheet.entries.find(x=>x.weekday===d+1&&x.period===c);
   return e?{stack:[{text:e.subject,bold:true,fontSize:12},{text:e.line||'',fontSize:10,color:'#555'}],alignment:'center',margin:[0,3,0,3]}:{text:''};
  })])];
  return [
   {text:sheet.title,bold:true,fontSize:17,alignment:'center'},
   {text:sheet.subtitle||'',fontSize:13,alignment:'center',margin:[0,0,0,8]},
   {table:{headerRows:1,widths:[52,'*','*','*',56,'*','*','*'],heights:row=>row===0?28:42,body},layout:{hLineColor:()=>'#a9bccf',vLineColor:()=>'#a9bccf',hLineWidth:()=>0.6,vLineWidth:()=>0.6}},
   {text:`รวม ${sheet.entries.length} คาบต่อสัปดาห์`,fontSize:11,margin:[0,6,0,0],...(last?{}:{pageBreak:'after'})}
  ];
 }
 async function download(sheets,filename){
  if(!sheets.length)throw Error('ไม่มีตารางให้ส่งออก');
  const pdf=await pdfLib();
  const doc={pageSize:'A4',pageOrientation:'landscape',pageMargins:[60,40,60,36],defaultStyle:{font:'Sarabun',fontSize:12},
   content:sheets.flatMap((s,i)=>sheetContent(s,i===sheets.length-1)),
   footer:(p,n)=>({text:`โรงเรียนบ้านป่าเด็ง · หน้า ${p} / ${n}`,alignment:'center',fontSize:11,color:'#777'})};
  pdf.createPdf(doc).download(filename.replace(/[\\/:*?"<>|]/g,'-')+'.pdf');
 }
 root.TimetablePDF={download,DAYS,TIMES,LUNCH,COLUMNS};
})(window);
