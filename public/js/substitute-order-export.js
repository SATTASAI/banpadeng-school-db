(function(root){
 'use strict';
 const headers=['คาบ','ชั้น/ห้อง','วิชา','ครูที่ไม่อยู่','ครูสอนแทน'];
 const xml=v=>String(v??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
 function director(staff){
  const candidates=staff.filter(p=>/ผู้อำนวยการ/.test(p.position||'')&&!/รองผู้อำนวยการ|ผู้ช่วยผู้อำนวยการ/.test((p.position||'').replace(/\s/g,''))&&p.status!=='inactive');
  if(candidates.length!==1||!candidates[0].full_name?.trim())throw Error(candidates.length>1?'พบผู้อำนวยการมากกว่าหนึ่งคน กรุณาตรวจสอบทะเบียนบุคลากร':'ไม่พบชื่อผู้อำนวยการ กรุณาระบุข้อมูลในทะเบียนบุคลากร');
  return candidates[0].full_name.trim();
 }
 function garuda(meta){const match=/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(meta.garuda_data_url||'');if(!match)throw Error('ไม่พบตราครุฑสำหรับคำสั่ง');return match[1];}
 function thaiDate(value){if(!/^\d{4}-\d{2}-\d{2}$/.test(value||''))return '........................';return new Date(value+'T12:00:00Z').toLocaleDateString('th-TH',{day:'numeric',month:'long',year:'numeric',timeZone:'Asia/Bangkok'});}
 // รายชื่อครูที่ไม่อยู่ทั้งหมดของวัน (ไม่ซ้ำ) — คำสั่งไฟล์เดียวรวมทุกคน
 function absentNames(rows){return [...new Set(rows.map(r=>String(r.absent_name||'').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'th'));}
 function weekdayDate(value){if(!/^\d{4}-\d{2}-\d{2}$/.test(value||''))return 'วันที่ ........................';return new Date(value+'T12:00:00Z').toLocaleDateString('th-TH',{weekday:'long',day:'numeric',month:'long',year:'numeric',timeZone:'Asia/Bangkok'}).replace(/(\d{4})$/,'พ.ศ. $1');}
 // สาเหตุจากเหตุผลในใบลา (หรือเหตุที่บันทึกเอง) — ครูที่เหตุเดียวกันรวมกลุ่มเดียว
 function causes(rows){const groups=new Map();for(const r of rows){const name=String(r.absent_name||'').trim();if(!name)continue;const why=String(r.leave_reason||r.absence_reason||'').trim().replace(/\s+/g,' ')||'ไม่อยู่ปฏิบัติหน้าที่';if(!groups.has(why))groups.set(why,new Set());groups.get(why).add(name);}
  return [...groups].map(([why,names])=>[...names].sort((a,b)=>a.localeCompare(b,'th')).join(', ')+' '+why);}
 const AUTHORITY='อาศัยอำนาจตามมาตรา ๓๙(๑) แห่งพระราชบัญญัติระเบียบบริหารราชการ กระทรวงศึกษาธิการ พ.ศ.๒๕๔๖ จึงแต่งตั้งข้าราชการครูและบุคลากรทางการศึกษาปฏิบัติหน้าที่สอนแทน ดังนี้';
 // เลขไทยทั้งฟอร์ม
 const thaiDigits=v=>String(v??'').replace(/\d/g,d=>'๐๑๒๓๔๕๖๗๘๙'[d]);
 function order(rows,meta){
  if(!rows.length)throw Error('ยังไม่มีรายการสอนแทนสำหรับส่งออก');
  const o={title:'คำสั่งโรงเรียนบ้านป่าเด็ง',number:'ที่ '+(meta.order_number?.trim()||'........ / ........'),subject:'เรื่อง แต่งตั้งครูเข้าสอนแทน',
   introduction:'ด้วย '+causes(rows).join(' และ ')+' ใน'+weekdayDate(meta.date)+' เพื่อให้การเรียนการสอนดำเนินไปด้วยความเรียบร้อย',
   authority:AUTHORITY,
   rows:[...rows].sort((a,b)=>Number(a.period)-Number(b.period)||String(a.grade_level).localeCompare(String(b.grade_level),'th')).map(r=>[String(r.period),[r.grade_level,r.classroom].filter(Boolean).join('/'),r.subject||'',r.absent_name||'',r.substitute_name||'']),
   effective:'ทั้งนี้ ตั้งแต่วันที่ '+thaiDate(meta.date)+' เป็นต้นไป',
   issued:'สั่ง ณ วันที่ '+thaiDate(meta.issue_date||meta.date),signature:'('+(meta.director_name?.trim()||'........................................')+')',position:'ผู้อำนวยการโรงเรียนบ้านป่าเด็ง'};
  return Object.fromEntries(Object.entries(o).map(([k,v])=>[k,Array.isArray(v)?v.map(r=>r.map(thaiDigits)):thaiDigits(v)]));
 }
 // ลายเซ็นอิเล็กทรอนิกส์ ผอ. (PNG) — ไม่มีก็เว้นที่ว่างไว้เซ็นมือ
 function signaturePng(meta){const m=/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(meta.director_signature||'');if(!m)return null;
  const A='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',bytes=[];for(let i=0;i<32;i+=4){const n=[0,1,2,3].reduce((v,k)=>v*64+A.indexOf(m[1][i+k]||'A'),0);bytes.push(n>>16&255,n>>8&255,n&255);}const u32=i=>bytes[i]*16777216+(bytes[i+1]<<16)+(bytes[i+2]<<8)+bytes[i+3];
  const w=u32(16),h=u32(20);if(!w||!h)return null;const scale=Math.min(130/w,45/h);return {base64:m[1],data_url:meta.director_signature,w:w*scale,h:h*scale};}
 function docxFiles(rows,meta){
  const data=order(rows,meta),image=garuda(meta),sig=signaturePng(meta),p=(text,bold=false,center=false,indent=false)=>`<w:p><w:pPr>${center?'<w:jc w:val="center"/>':indent?'<w:ind w:firstLine="1134"/>':''}<w:spacing w:after="120"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="TH Sarabun PSK" w:hAnsi="TH Sarabun PSK" w:cs="TH Sarabun PSK"/>${bold?'<w:b/>':''}<w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`;
  const widths=[600,1200,1800,2400,2400];
  const table=[headers,...data.rows].map((row,i)=>'<w:tr>'+(i===0?'<w:trPr><w:tblHeader/></w:trPr>':'')+row.map((text,j)=>`<w:tc><w:tcPr><w:tcW w:w="${widths[j]}" w:type="dxa"/></w:tcPr>${p(text,i===0)}</w:tc>`).join('')+'</w:tr>').join('');
  const emblem='<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="120"/></w:pPr><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="986436" cy="1080000"/><wp:docPr id="1" name="ตราครุฑ" descr="ตราครุฑสำหรับคำสั่ง"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="1" name="garuda.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rIdGaruda"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="986436" cy="1080000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
  const body=emblem+p(data.title,true,true)+p(data.number,false,true)+p(data.subject,true,true)+p('')+p(data.introduction,false,false,true)+p(data.authority,false,false,true)+`<w:tbl><w:tblPr><w:tblW w:w="8400" w:type="dxa"/><w:tblBorders>${['top','left','bottom','right','insideH','insideV'].map(k=>`<w:${k} w:val="single" w:sz="4" w:color="777777"/>`).join('')}</w:tblBorders></w:tblPr><w:tblGrid>${widths.map(w=>`<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${table}</w:tbl>`+p('')+p(data.effective,false,true)+p(data.issued,false,true)+(sig?`<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="${Math.round(sig.w*12700)}" cy="${Math.round(sig.h*12700)}"/><wp:docPr id="2" name="ลายเซ็น" descr="ลายเซ็นผู้อำนวยการ"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="2" name="signature.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rIdSignature"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${Math.round(sig.w*12700)}" cy="${Math.round(sig.h*12700)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`:p('')+p(''))+p(data.signature,false,true)+p(data.position,false,true);
  const files=
  ({'[Content_Types].xml':'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
   'word/media/garuda.png':{base64:image},
   'word/_rels/document.xml.rels':'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdGaruda" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/garuda.png"/></Relationships>',
   '_rels/.rels':'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
   'word/document.xml':'<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+body+'<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1080" w:right="1440" w:bottom="1080" w:left="1440"/></w:sectPr></w:body></w:document>'});
  if(sig){files['word/media/signature.png']={base64:sig.base64};files['word/_rels/document.xml.rels']=files['word/_rels/document.xml.rels'].replace('</Relationships>','<Relationship Id="rIdSignature" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/signature.png"/></Relationships>');}
  return files;
 }
 function pdfDefinition(rows,meta){const data=order(rows,meta),sig=signaturePng(meta);garuda(meta);return {pageSize:'A4',pageMargins:[50,50,50,50],defaultStyle:{font:'Sarabun',fontSize:16},content:[{image:meta.garuda_data_url,width:77.67,height:85.04,alignment:'center',margin:[0,0,0,8]},{text:data.title,bold:true,alignment:'center',fontSize:20},{text:data.number,alignment:'center'},{text:data.subject,bold:true,alignment:'center',margin:[0,6,0,18]},{text:data.introduction,leadingIndent:40,margin:[0,0,0,4]},{text:data.authority,leadingIndent:40,margin:[0,0,0,12]},{table:{headerRows:1,widths:[25,55,85,'*','*'],body:[headers,...data.rows].map((r,i)=>r.map(text=>({text,bold:i===0})))},layout:'lightHorizontalLines'},{text:data.effective,alignment:'center',margin:[0,20,0,0]},{text:data.issued,alignment:'center',margin:[0,0,0,6]},sig?{image:sig.data_url,width:sig.w,height:sig.h,alignment:'center'}:{text:' ',margin:[0,0,0,30]},{text:data.signature,alignment:'center'},{text:data.position,alignment:'center'}],footer:(p,n)=>({text:thaiDigits(`หน้า ${p} / ${n}`),alignment:'center',fontSize:12})};}
 const loading=new Map();
 function library(name,url){if(root[name])return Promise.resolve(root[name]);if(!loading.has(name))loading.set(name,new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=url;script.onload=()=>resolve(root[name]);script.onerror=()=>{loading.delete(name);script.remove();reject(Error('โหลดเครื่องมือส่งออกไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ต'));};document.head.append(script);}));return loading.get(name);}
 function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
 async function exportFile(format,rows,meta){
  order(rows,meta);if(!meta.director_name?.trim())throw Error('ไม่พบชื่อผู้อำนวยการ กรุณาตรวจสอบทะเบียนบุคลากร');
  const response=await fetch('/assets/garuda.png');if(!response.ok)throw Error('โหลดตราครุฑไม่สำเร็จ กรุณาลองใหม่');
  const bytes=new Uint8Array(await response.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
  meta={...meta,garuda_data_url:'data:image/png;base64,'+btoa(binary)};const name='คำสั่งสอนแทนรวม-'+meta.date;
  if(format==='docx'){const Zip=await library('JSZip','https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'),zip=new Zip();for(const [path,text] of Object.entries(docxFiles(rows,meta)))typeof text==='object'?zip.file(path,text.base64,{base64:true}):zip.file(path,text);download(await zip.generateAsync({type:'blob',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}),name+'.docx');}
  else if(format==='pdf'||format==='print'){const pdf=await library('pdfMake','https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.12/pdfmake.min.js');let fonts=root.SubstituteOrderFonts;
   if(!fonts){fonts=Object.fromEntries(await Promise.all(['THSarabunPSK-Regular.ttf','THSarabunPSK-Bold.ttf'].map(async name=>{const r=await fetch('/fonts/'+name);if(!r.ok)throw Error('โหลดฟอนต์ภาษาไทยไม่สำเร็จ');const bytes=new Uint8Array(await r.arrayBuffer());let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return [name,btoa(text)];})));}
   pdf.vfs={...(pdf.vfs||{}),...fonts};pdf.fonts={...(pdf.fonts||{}),Sarabun:{normal:'THSarabunPSK-Regular.ttf',bold:'THSarabunPSK-Bold.ttf'}};
   if(format==='print'){pdf.createPdf(pdfDefinition(rows,meta)).print();return;}
   const blob=await new Promise((resolve,reject)=>{try{pdf.createPdf(pdfDefinition(rows,meta)).getBlob(resolve);}catch(e){reject(e);}});download(blob,name+'.pdf');
  }else throw Error('รูปแบบไฟล์ไม่ถูกต้อง');
 }
 root.SubstituteOrderExport={absentNames,director,order,docxFiles,pdfDefinition,exportFile};
})(typeof window==='undefined'?globalThis:window);
