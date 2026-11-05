/* อ่านตารางรายชื่อจากไฟล์ PDF (ทั้ง PDF ข้อความ และ PDF สแกน/ภาพ ด้วย OCR ภาษาไทย)
   ScholarshipPdf.read(file,{onProgress}) → {columns:[{label}], rows:[[cell...]], meta:{term,year,kind,total,title}, ocrPages, pages}
   ScholarshipPdf.parsePages([{items:[{str,x,y,w,h}]}]) — แกนการแยกตาราง (ใช้ทดสอบได้) y นับจากบนลงล่าง
   ScholarshipPdf.guessMapping(columns, rows) → ['name'|'first'|'last'|'prefix'|'national_id'|'student_code'|'amount'|'notes'|'fail'|'room'|'' ...]
   ScholarshipPdf.toRecords(rows, mapping) → [{name, national_id, student_code, room, amount, notes, raw}]
   รองรับแบบฟอร์ม "รายชื่อนักเรียนที่มีสิทธิ์ได้รับเงินอุดหนุนยากจนพิเศษ กสศ." (หัวตาราง 2 บรรทัด, ช่องสถานะโอนสำเร็จ/ไม่สำเร็จ, เลขประจำตัว G…) */
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
 const idOf=v=>String(v??'').toUpperCase().replace(/[^0-9A-Z]/g,'');
 // เลขบัตรประชาชน 13 หลัก หรือเลขประจำตัว G/0 ของนักเรียนไม่มีสัญชาติ (G + 12 หลัก)
 const ID_RE=/(?:^|[^0-9A-Z])([0-9G](?:[\s-]?\d){12})(?![0-9])/i;
 const findId=t=>{const m=String(t??'').toUpperCase().match(ID_RE);return m?idOf(m[1]):''};

 // แยกชิ้นข้อความที่มีช่องว่างเป็นคำ ๆ (ประมาณตำแหน่งตามสัดส่วนตัวอักษร) — ให้หัวตารางที่ติดกันแยกคอลัมน์ได้
 function splitWords(items){
  const out=[];
  for(const it of items){const s=String(it.str??'');if(!s.trim())continue;
   const parts=s.split(/(\s+)/),len=s.length||1;let pos=0;
   for(const p of parts){if(p.trim())out.push({str:p,x:it.x+it.w*pos/len,w:Math.max(1,it.w*p.length/len),y:it.y,h:it.h});pos+=p.length}}
  return out;
 }
 // รวมชิ้นข้อความเป็นบรรทัด (ตามแนวตั้ง) แล้วเป็นช่อง (ตามช่องว่างแนวนอน)
 function linesOf(items){
  const list=items.filter(i=>i.str&&String(i.str).trim()).sort((a,b)=>a.y-b.y||a.x-b.x);
  if(!list.length)return [];
  const hs=list.map(i=>i.h).sort((a,b)=>a-b),mh=hs[Math.floor(hs.length/2)]||10;
  const lines=[];
  for(const it of list){const cy=it.y+it.h/2;const line=lines.find(l=>Math.abs(l.cy-cy)<=mh*0.55);if(line){line.items.push(it);line.cy=(line.cy*(line.items.length-1)+cy)/line.items.length}else lines.push({cy,items:[it]})}
  lines.sort((a,b)=>a.cy-b.cy);
  return lines.map(l=>{
   const its=l.items.sort((a,b)=>a.x-b.x),cells=[];
   for(const it of its){const last=cells[cells.length-1];const gap=last?it.x-(last.x+last.w):Infinity;
    if(last&&gap<Math.max(mh*0.75,3)){last.str+=(gap>Math.max(1.2,mh*0.12)&&!/^[ัิ-ฺ็-๎]/.test(it.str)?' ':'')+it.str;last.w=Math.max(last.w,it.x+it.w-last.x)}
    else cells.push({str:it.str,x:it.x,w:it.w})}
   const out=cells.map(c=>({...c,str:fix(c.str)})).filter(c=>c.str);out.cy=l.cy;out.mh=mh;out.words=its;return out;
  });
 }

 const HEAD=[
  ['national_id',/(ประชาชน|บัตร|ปชช|citizen)/i],
  ['student_code',/(ประจำตัวนักเรียน|รหัสนักเรียน|student\s*id)/i],
  ['fail',/ไม่สำเร็จ/],
  ['amount',/(จัดสรร|จำนวนเงิน|ยอดเงิน|งบประมาณ|จำนวน\s*\(?บาท|amount)/i],
  ['notes',/(หมายเหตุ|สาเหตุ|note)/i],
  ['prefix',/^(คำนำหน้า|คำนำหน้าชื่อ)$/],
  ['last',/^(นามสกุล|สกุล)$/],
  ['first',/^(ชื่อ)$/],
  ['name',/(ชื่อ|name)/i],
  ['room',/(ชั้น|ห้อง|class)/i],
  ['skip',/(วิธีการ|สถานะ|โอนสำเร็จ|^รอบ|^ที่$|^ลำดับ|^no\.?$)/i],
  ['student_code',/(เลขประจำตัว|รหัส)/],
 ];
 const KEYWORD=/(ชื่อ|นามสกุล|เลขประจำตัว|ประชาชน|บัตร|รหัส|จำนวน|เงิน|บาท|ชั้น|ห้อง|หมายเหตุ|ลำดับ|^ที่$|งบประมาณ|จัดสรร|สถานะ|name|amount)/i;
 const isHeader=cells=>cells.length>=3&&cells.filter(c=>KEYWORD.test(c.str)).length>=3&&!cells.some(c=>/\d{5,}/.test(c.str));
 const isData=cells=>cells.length>=2&&(cells.some(c=>findId(c.str))||(/^\d{1,4}\.?$/.test(cells[0].str)&&cells.some(c=>/[฀-๿a-z]{2,}/i.test(c.str))));

 // คอลัมน์จากแถวข้อมูล: ช่วงแกน x ที่มีข้อความอย่างน้อย 1 แถว = คอลัมน์ ช่องว่างตลอดแนว = เส้นแบ่ง
 function binsOf(dataLines){
  const iv=dataLines.flatMap(l=>l.map(c=>[c.x,c.x+c.w])).sort((a,b)=>a[0]-b[0]),bins=[];
  for(const [a,b] of iv){const last=bins[bins.length-1];if(last&&a<=last.x1+2)last.x1=Math.max(last.x1,b);else bins.push({x0:a,x1:b})}
  return bins;
 }
 function nearestBin(bins,x0,x1,maxDist){
  const mid=(x0+x1)/2;let best=-1,bd=Infinity;
  bins.forEach((b,i)=>{const ov=Math.min(x1,b.x1)-Math.max(x0,b.x0);const d=ov>0?-ov:(mid<b.x0?b.x0-mid:mid-b.x1);if(d<bd){bd=d;best=i}});
  return bd<=maxDist?best:-1;
 }
 function headerLabels(bins,headerLines){
  const labels=bins.map(()=>[]);
  for(const line of headerLines)for(const w of splitWords(line.words)){const i=nearestBin(bins,w.x,w.x+w.w,28);if(i>=0)labels[i].push(fix(w.str))}
  return labels.map(a=>a.join(' '));
 }
 function metaOf(lines){
  const text=lines.map(l=>l.map(c=>c.str).join(' ')).join(' ');
  const term=text.match(/ภาคเรียนที่\s*([12])/)?.[1],year=text.match(/ปีการศึกษา\s*(25\d\d)/)?.[1];
  const kind=/กสศ|ยากจนพิเศษ|ปัจจัยพื้นฐาน/.test(text)?'eef':/อุดหนุน/.test(text)?'subsidy':'';
  return {term:term?Number(term):null,year:year?Number(year):null,kind,title:fix(lines[0]?.map(c=>c.str).join(' ')||'')};
 }

 // แกนการแยกตาราง: หาหัวตาราง (อาจหลายบรรทัด) ต่อหน้า → คอลัมน์จากแถวข้อมูล → ชื่อคอลัมน์จากคำในหัวตาราง
 function parsePages(pages){
  const columns=[],rows=[];let meta=null,total=null,prevBins=null,prevMap=null;
  for(const page of pages){
   const lines=linesOf(page.items||[]);
   const hi=lines.findIndex(isHeader);
   if(!meta&&lines.length)meta=metaOf(hi>0?lines.slice(0,hi):lines.slice(0,1));
   let start=0,headers=[];
   if(hi>=0){
    let end=hi+1;const lim=lines[hi].cy+lines[hi].mh*3.2;
    while(end<lines.length&&!isData(lines[end])&&lines[end].cy<=lim)end++;
    headers=lines.slice(hi,end);start=end;
   }
   const data=[];
   for(const l of lines.slice(start)){
    if(isData(l)){data.push(l);continue}
    if(/^รวม/.test(l[0]?.str||'')||l.some(c=>/^รวม(ทั้งสิ้น)?$/.test(c.str))){const nums=l.map(c=>c.str).filter(s=>/\d{1,3}(,\d{3})+(\.\d+)?$|^\d{4,}(\.\d+)?$/.test(s));if(nums.length)total=Number(nums[nums.length-1].replace(/,/g,''))}
   }
   if(!data.length)continue;
   let bins=binsOf(data),map;
   if(headers.length){
    const labels=headerLabels(bins,headers);
    map=labels.map((label,i)=>{let k=columns.findIndex(c=>c.label===label&&label);if(k<0){k=columns.length;columns.push({label:label||`คอลัมน์ ${columns.length+1}`})}return k});
   }else if(prevBins){bins=prevBins;map=prevMap}
   else{map=bins.map(()=>{columns.push({label:`คอลัมน์ ${columns.length+1}`});return columns.length-1})}
   prevBins=bins;prevMap=map;
   for(const l of data){const vals=[];for(const c of l){const i=nearestBin(bins,c.x,c.x+c.w,Infinity);const k=map[i];vals[k]=vals[k]?vals[k]+' '+c.str:c.str}rows.push(vals)}
  }
  if(!rows.length)throw new Error('อ่านตารางจากไฟล์ไม่ได้ (ไม่พบแถวข้อมูลนักเรียน)');
  const out=rows.map(r=>columns.map((_,i)=>r[i]||''));
  // ตัดคอลัมน์ว่างทั้งคอลัมน์ทิ้ง
  const keep=columns.map((_,i)=>out.some(r=>r[i]&&r[i]!=='-'));
  return {columns:columns.filter((_,i)=>keep[i]),rows:out.map(r=>r.filter((_,i)=>keep[i])),meta:{...(meta||{}),total}};
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
  const pages=[];let ocrPages=0;
  for(let p=1;p<=doc.numPages;p++){
   progress(`กำลังอ่านหน้า ${p}/${doc.numPages}`);
   const page=await doc.getPage(p),vp=page.getViewport({scale:1});
   const tc=await page.getTextContent();
   let items=tc.items.map(i=>{const h=Math.abs(i.transform[3]||i.height||10);return {str:i.str,x:i.transform[4],y:vp.height-i.transform[5]-h,w:i.width||0,h}});
   const chars=items.reduce((n,i)=>n+String(i.str).replace(/\s/g,'').length,0);
   if(chars<30){ocrPages++;progress(`หน้า ${p}/${doc.numPages} เป็นภาพสแกน — กำลังอ่านด้วย OCR (อาจใช้เวลาสักครู่)`);items=await ocrPage(page,m=>progress(`หน้า ${p}/${doc.numPages} · ${m}`))}
   pages.push({items});
  }
  return {...parsePages(pages),ocrPages,pages:doc.numPages};
 }

 function guessMapping(columns,rows=[]){
  const used=new Set();
  const map=columns.map(c=>{const t=fix(c.label);
   for(const [key,re] of HEAD){if(!re.test(t))continue;if(key==='skip')return '';
    if(['notes','fail'].includes(key))return key;
    if(!used.has(key)){used.add(key);return key}return ''}
   return ''});
  // เดาจากข้อมูลเมื่อหัวตารางไม่ชัด: คอลัมน์เลข 13 หลัก = เลขบัตร, คอลัมน์ตัวเลขมีจุลภาค/≥100 = ยอดเงิน, ข้อความไทยยาว = ชื่อ
  const share=(i,fn)=>{const v=rows.map(r=>r[i]).filter(x=>x&&x!=='-');return v.length?v.filter(fn).length/v.length:0};
  if(!map.includes('national_id')){const i=columns.findIndex((_,i)=>!map[i]&&share(i,x=>findId(x)===idOf(x)&&idOf(x).length===13)>0.8);if(i>=0)map[i]='national_id'}
  if(!map.includes('amount')){const i=[...columns.keys()].reverse().find(i=>!map[i]&&share(i,x=>/^\d{1,3}(,\d{3})*(\.\d{1,2})?$|^\d{3,6}(\.\d{1,2})?$/.test(x)&&Number(x.replace(/,/g,''))>=100)>0.8);if(i!==undefined)map[i]='amount'}
  if(!map.some(m=>['name','first'].includes(m))){const i=columns.findIndex((_,i)=>!map[i]&&share(i,x=>/[฀-๿]{3,}\s+\S/.test(x))>0.7);if(i>=0)map[i]='name'}
  return map;
 }
 const digits=v=>String(v??'').replace(/\D/g,'');
 function toRecords(rows,mapping){
  return rows.map(r=>{const vals=k=>mapping.map((m,i)=>m===k?r[i]:'').filter(v=>v&&v!=='-');const get=k=>vals(k).join(' ').trim();
   let name=get('name');const parts=[get('prefix'),get('first'),get('last')].filter(Boolean);if(parts.length>1||!name)name=[name,...parts].filter(Boolean).join(' ').trim();
   name=name.replace(/\s+-$/,'');
   let nid=idOf(get('national_id'));if(nid.length!==13)nid=findId(r.join(' '))||'';
   const code=digits(get('student_code'));
   const amtRaw=get('amount').replace(/[^\d.,]/g,'').replace(/,/g,'');const amount=amtRaw&&Number.isFinite(Number(amtRaw))?Number(amtRaw):null;
   const notes=[vals('fail').length?'โอนไม่สำเร็จ':'',...vals('notes')].filter(Boolean).join(' · ');
   return {name:fix(name),national_id:nid,student_code:code.length&&code.length<=10?code:'',room:get('room'),amount,notes,raw:r};
  }).filter(x=>x.name||x.national_id||x.student_code);
 }
 root.ScholarshipPdf={read,parsePages,guessMapping,toRecords,_linesOf:linesOf,_isHeader:isHeader};
})(typeof window==='undefined'?globalThis:window);
