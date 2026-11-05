/* อ่านตารางรายชื่อจากไฟล์ PDF (ทั้ง PDF ข้อความ และ PDF สแกน/ภาพ ด้วย OCR ภาษาไทย)
   ScholarshipPdf.read(file,{onProgress}) → {columns:[{label}], rows:[[cell...]], ocrPages, pages}
   ScholarshipPdf.guessMapping(columns) → ['name'|'first'|'last'|'prefix'|'national_id'|'student_code'|'amount'|'notes'|'' ...]
   ScholarshipPdf.toRecords(rows, mapping) → [{name, national_id, student_code, amount, notes, raw}] */
(function(root){
 'use strict';
 const BASE='/vendor/ocr/';
 let pdfLib=null,ocrWorker=null;
 function script(src){return new Promise((ok,no)=>{const s=document.createElement('script');s.src=src;s.onload=ok;s.onerror=()=>no(new Error('โหลดไลบรารีไม่สำเร็จ: '+src));document.head.appendChild(s)})}
 async function loadPdf(){if(!pdfLib)pdfLib=script(BASE+'pdf.min.js').then(()=>{window.pdfjsLib.GlobalWorkerOptions.workerSrc=BASE+'pdf.worker.min.js';return window.pdfjsLib}).catch(e=>{pdfLib=null;throw e});return pdfLib}
 async function loadOcr(progress){
  if(ocrWorker)return ocrWorker;
  ocrWorker=(async()=>{
   if(!window.Tesseract)await script(BASE+'tesseract.min.js');
   return window.Tesseract.createWorker(['tha','eng'],1,{workerPath:BASE+'worker.min.js',corePath:BASE+'core',langPath:BASE+'lang',workerBlobURL:false,gzip:true,
    logger:m=>{if(m.status&&progress)progress('OCR: '+({'loading tesseract core':'โหลดตัวอ่าน','loading language traineddata':'โหลดภาษาไทย','initializing api':'เตรียมตัวอ่าน','recognizing text':'กำลังอ่านภาพ'}[m.status]||m.status)+(m.progress?` ${Math.round(m.progress*100)}%`:''))}});
  })().catch(e=>{ocrWorker=null;throw e});
  return ocrWorker;
 }
 const fix=s=>String(s??'').normalize('NFC').replace(/[​-‍﻿]/g,'').replace(/ํา/g,'ำ').replace(/\s+/g,' ').trim();

 // รวมชิ้นข้อความเป็นบรรทัด (ตามแนวตั้ง) แล้วเป็นช่อง (ตามช่องว่างแนวนอน)
 function linesOf(items){
  const list=items.filter(i=>i.str&&i.str.trim()).sort((a,b)=>a.y-b.y||a.x-b.x);
  if(!list.length)return [];
  const hs=list.map(i=>i.h).sort((a,b)=>a-b),mh=hs[Math.floor(hs.length/2)]||10;
  const lines=[];
  for(const it of list){const cy=it.y+it.h/2;const line=lines.find(l=>Math.abs(l.cy-cy)<=mh*0.55);if(line){line.items.push(it);line.cy=(line.cy*(line.items.length-1)+cy)/line.items.length}else lines.push({cy,items:[it]})}
  lines.sort((a,b)=>a.cy-b.cy);
  return lines.map(l=>{
   const its=l.items.sort((a,b)=>a.x-b.x),cells=[];
   for(const it of its){const last=cells[cells.length-1];const gap=last?it.x-(last.x+last.w):Infinity;
    if(last&&gap<Math.max(mh*0.9,4)){last.str+=(gap>mh*0.25&&!/^[ัิ-ฺ็-๎]/.test(it.str)?' ':'')+it.str;last.w=Math.max(last.w,it.x+it.w-last.x)}
    else cells.push({str:it.str,x:it.x,w:it.w})}
   return cells.map(c=>({...c,str:fix(c.str)})).filter(c=>c.str);
  });
 }

 const HEAD=[
  ['national_id',/(ประชาชน|บัตร|ปชช|citizen|เลขประจำตัว\s*13)/i],
  ['student_code',/(ประจำตัวนักเรียน|รหัสนักเรียน|เลขประจำตัว|รหัส|student\s*id)/i],
  ['prefix',/^(คำนำหน้า|คํานําหน้า|คำนำหน้าชื่อ)$/],
  ['last',/^(นามสกุล|สกุล)$/],
  ['first',/^(ชื่อ)$/],
  ['name',/(ชื่อ|name)/i],
  ['amount',/(จำนวนเงิน|จํานวนเงิน|เงิน|บาท|ยอด|amount|รับ)/i],
  ['notes',/(หมายเหตุ|note)/i],
  ['order',/^(ที่|ลำดับ|ลําดับ|ลำดับที่|no\.?)$/i],
  ['room',/(ชั้น|ห้อง|class)/i],
 ];
 const headerScore=cells=>cells.reduce((n,c)=>n+(HEAD.some(([,r])=>r.test(c.str))?1:0),0);
 const isHeader=cells=>cells.length>=2&&headerScore(cells)>=2&&!cells.some(c=>/\d{5,}/.test(c.str));

 function assign(cells,cols){
  const out=cols.map(()=>[]);
  for(const c of cells){const mid=c.x+c.w/2;let best=0,bd=Infinity;
   cols.forEach((col,i)=>{const d=mid<col.x?col.x-mid:mid>col.x+col.w?mid-(col.x+col.w):0;if(d<bd){bd=d;best=i}});out[best].push(c.str)}
  return out.map(a=>a.join(' '));
 }

 async function ocrPage(page,progress){
  const vp=page.getViewport({scale:2.4}),canvas=document.createElement('canvas');canvas.width=vp.width;canvas.height=vp.height;
  const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);
  await page.render({canvasContext:ctx,viewport:vp}).promise;
  const worker=await loadOcr(progress);
  const {data}=await worker.recognize(canvas);
  const words=[];
  for(const w of data.words||[]){if(!w.text||w.confidence<15)continue;const b=w.bbox;words.push({str:w.text,x:b.x0,y:b.y0,w:b.x1-b.x0,h:b.y1-b.y0})}
  return words;
 }

 async function read(file,{onProgress}={}){
  const progress=onProgress||(()=>{});
  progress('กำลังเปิดไฟล์ PDF…');
  const lib=await loadPdf();
  const doc=await lib.getDocument({data:await file.arrayBuffer(),isEvalSupported:false}).promise;
  let cols=null,headerLabels=null,ocrPages=0;const rows=[],allLines=[];
  for(let p=1;p<=doc.numPages;p++){
   progress(`กำลังอ่านหน้า ${p}/${doc.numPages}`);
   const page=await doc.getPage(p),vp=page.getViewport({scale:1});
   const tc=await page.getTextContent();
   let items=tc.items.map(i=>({str:i.str,x:i.transform[4],y:vp.height-i.transform[5]-Math.abs(i.transform[3]||i.height||10),w:i.width||0,h:Math.abs(i.transform[3]||i.height||10)}));
   const chars=items.reduce((n,i)=>n+String(i.str).replace(/\s/g,'').length,0);
   if(chars<30){ocrPages++;progress(`หน้า ${p}/${doc.numPages} เป็นภาพสแกน — กำลังอ่านด้วย OCR (อาจใช้เวลาสักครู่)`);items=await ocrPage(page,m=>progress(`หน้า ${p}/${doc.numPages} · ${m}`))}
   for(const cells of linesOf(items)){
    allLines.push(cells);
    if(isHeader(cells)){
     // หัวตารางซ้ำทุกหน้า: ใช้ตำแหน่งคอลัมน์ของหน้านั้น ชื่อคอลัมน์จากหัวแรก
     const hc=cells.map(c=>({x:c.x,w:c.w,label:c.str}));
     if(!cols||hc.length>=cols.length){cols=hc;if(!headerLabels)headerLabels=hc.map(c=>c.label)}
     continue;
    }
    if(!cols)continue;
    const vals=assign(cells,cols);
    if(vals.filter(Boolean).length<2)continue;
    rows.push(vals.slice(0,cols.length));
   }
  }
  if(!cols){
   // ไม่พบหัวตาราง: ใช้บรรทัดข้อมูลที่มีช่องมากที่สุดเป็นแม่แบบคอลัมน์ ให้ผู้ใช้เลือกความหมายของคอลัมน์เอง
   const data=allLines.filter(c=>c.length>=2&&c.some(x=>/\d/.test(x.str)));
   if(!data.length)throw new Error('อ่านตารางจากไฟล์ไม่ได้ (ไม่พบหัวตารางหรือแถวข้อมูล)');
   const tpl=data.reduce((a,b)=>b.length>a.length?b:a);
   cols=tpl.map(c=>({x:c.x,w:c.w}));headerLabels=cols.map((_,i)=>'คอลัมน์ '+(i+1));
   for(const cells of data)rows.push(assign(cells,cols));
  }
  const labels=(headerLabels||[]).concat(cols.slice((headerLabels||[]).length).map(c=>c.label));
  return {columns:labels.slice(0,cols.length).map(label=>({label})),rows:rows.map(r=>{while(r.length<cols.length)r.push('');return r}),ocrPages,pages:doc.numPages};
 }

 function guessMapping(columns){
  const used=new Set();
  return columns.map(c=>{const t=fix(c.label);
   for(const [key,re] of HEAD){if(['order','room'].includes(key)&&re.test(t))return '';
    if(re.test(t)&&!used.has(key)){if(key==='student_code'&&/ประชาชน|บัตร/.test(t))continue;used.add(key);return key}}
   return ''});
 }
 const digits=v=>String(v??'').replace(/\D/g,'');
 function toRecords(rows,mapping){
  return rows.map(r=>{const get=k=>mapping.map((m,i)=>m===k?r[i]:'').filter(Boolean).join(' ').trim();
   let name=get('name');const parts=[get('prefix'),get('first'),get('last')].filter(Boolean);if(parts.length>1||!name)name=[name,...parts].filter(Boolean).join(' ').trim();
   let nid=digits(get('national_id'));if(nid.length!==13){const m=r.join(' ').match(/\d[\d\s-]{11,20}\d/g)?.map(digits).find(d=>d.length===13);nid=m||''}
   const code=digits(get('student_code'));
   const amtRaw=get('amount').replace(/[^\d.,]/g,'').replace(/,/g,'');const amount=amtRaw&&Number.isFinite(Number(amtRaw))?Number(amtRaw):null;
   return {name:fix(name),national_id:nid,student_code:code.length&&code.length<=10?code:'',amount,notes:get('notes'),raw:r};
  }).filter(x=>x.name||x.national_id||x.student_code);
 }
 root.ScholarshipPdf={read,guessMapping,toRecords,_linesOf:linesOf,_isHeader:isHeader};
})(window);
