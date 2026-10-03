(function(root){
 'use strict';
 const headers=['คาบ','ชั้น/ห้อง','วิชา','ครูที่ไม่อยู่','ครูสอนแทน'];
 const xml=v=>String(v??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
 function thaiDate(value){if(!/^\d{4}-\d{2}-\d{2}$/.test(value||''))return '........................';return new Date(value+'T12:00:00Z').toLocaleDateString('th-TH',{day:'numeric',month:'long',year:'numeric',timeZone:'Asia/Bangkok'});}
 function order(rows,meta){
  if(!rows.length)throw Error('ยังไม่มีรายการสอนแทนสำหรับส่งออก');
  return {title:'คำสั่งโรงเรียนบ้านป่าเด็ง',number:'ที่ '+(meta.order_number?.trim()||'........ / ........'),subject:'เรื่อง มอบหมายให้ปฏิบัติหน้าที่สอนแทน',
   introduction:'เพื่อให้การจัดการเรียนการสอนดำเนินไปอย่างต่อเนื่อง โรงเรียนบ้านป่าเด็งจึงมอบหมายให้ครูปฏิบัติหน้าที่สอนแทนในวันที่ '+thaiDate(meta.date)+' ตามรายละเอียดดังต่อไปนี้',
   rows:[...rows].sort((a,b)=>Number(a.period)-Number(b.period)||String(a.grade_level).localeCompare(String(b.grade_level),'th')).map(r=>[String(r.period),[r.grade_level,r.classroom].filter(Boolean).join('/'),r.subject||'',r.absent_name||'',r.substitute_name||'']),
   issued:'สั่ง ณ วันที่ '+thaiDate(meta.issue_date||meta.date),signature:'('+(meta.director_name?.trim()||'........................................')+')',position:'ผู้อำนวยการโรงเรียนบ้านป่าเด็ง'};
 }
 function docxFiles(rows,meta){
  const data=order(rows,meta),p=(text,bold=false,center=false)=>`<w:p><w:pPr>${center?'<w:jc w:val="center"/>':''}<w:spacing w:after="120"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="TH SarabunPSK" w:hAnsi="TH SarabunPSK" w:cs="TH SarabunPSK"/>${bold?'<w:b/>':''}<w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`;
  const widths=[600,1200,1800,2400,2400];
  const table=[headers,...data.rows].map((row,i)=>'<w:tr>'+(i===0?'<w:trPr><w:tblHeader/></w:trPr>':'')+row.map((text,j)=>`<w:tc><w:tcPr><w:tcW w:w="${widths[j]}" w:type="dxa"/></w:tcPr>${p(text,i===0)}</w:tc>`).join('')+'</w:tr>').join('');
  const body=p(data.title,true,true)+p(data.number,false,true)+p(data.subject,true,true)+p('')+p(data.introduction)+`<w:tbl><w:tblPr><w:tblW w:w="8400" w:type="dxa"/><w:tblBorders>${['top','left','bottom','right','insideH','insideV'].map(k=>`<w:${k} w:val="single" w:sz="4" w:color="777777"/>`).join('')}</w:tblBorders></w:tblPr><w:tblGrid>${widths.map(w=>`<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${table}</w:tbl>`+p('')+p(data.issued,false,true)+p('')+p(data.signature,false,true)+p(data.position,false,true);
  return {'[Content_Types].xml':'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
   '_rels/.rels':'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
   'word/document.xml':'<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+body+'<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1080" w:right="1440" w:bottom="1080" w:left="1440"/></w:sectPr></w:body></w:document>'};
 }
 function pdfDefinition(rows,meta){const data=order(rows,meta);return {pageSize:'A4',pageMargins:[50,50,50,50],defaultStyle:{font:'Sarabun',fontSize:16},content:[{text:data.title,bold:true,alignment:'center',fontSize:20},{text:data.number,alignment:'center'},{text:data.subject,bold:true,alignment:'center',margin:[0,6,0,18]},{text:data.introduction,margin:[0,0,0,12]},{table:{headerRows:1,widths:[25,55,85,'*','*'],body:[headers,...data.rows].map((r,i)=>r.map(text=>({text,bold:i===0})))},layout:'lightHorizontalLines'},{text:data.issued,alignment:'center',margin:[0,20,0,30]},{text:data.signature,alignment:'center'},{text:data.position,alignment:'center'}],footer:(p,n)=>({text:`หน้า ${p} / ${n}`,alignment:'center',fontSize:12})};}
 const loading=new Map();
 function library(name,url){if(root[name])return Promise.resolve(root[name]);if(!loading.has(name))loading.set(name,new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=url;script.onload=()=>resolve(root[name]);script.onerror=()=>{loading.delete(name);script.remove();reject(Error('โหลดเครื่องมือส่งออกไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ต'));};document.head.append(script);}));return loading.get(name);}
 function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
 async function exportFile(format,rows,meta){
  order(rows,meta);const name='คำสั่งสอนแทน-'+meta.date;
  if(format==='docx'){const Zip=await library('JSZip','https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'),zip=new Zip();for(const [path,text] of Object.entries(docxFiles(rows,meta)))zip.file(path,text);download(await zip.generateAsync({type:'blob',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}),name+'.docx');}
  else if(format==='pdf'){const pdf=await library('pdfMake','https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.12/pdfmake.min.js');let fonts=root.SubstituteOrderFonts;
   if(!fonts){fonts=Object.fromEntries(await Promise.all(['THSarabunPSK-Regular.ttf','THSarabunPSK-Bold.ttf'].map(async name=>{const r=await fetch('/fonts/'+name);if(!r.ok)throw Error('โหลดฟอนต์ภาษาไทยไม่สำเร็จ');const bytes=new Uint8Array(await r.arrayBuffer());let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return [name,btoa(text)];})));}
   pdf.vfs={...(pdf.vfs||{}),...fonts};pdf.fonts={...(pdf.fonts||{}),Sarabun:{normal:'THSarabunPSK-Regular.ttf',bold:'THSarabunPSK-Bold.ttf'}};
   const blob=await new Promise((resolve,reject)=>{try{pdf.createPdf(pdfDefinition(rows,meta)).getBlob(resolve);}catch(e){reject(e);}});download(blob,name+'.pdf');
  }else throw Error('รูปแบบไฟล์ไม่ถูกต้อง');
 }
 root.SubstituteOrderExport={order,docxFiles,pdfDefinition,exportFile};
})(typeof window==='undefined'?globalThis:window);
