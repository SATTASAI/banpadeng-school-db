(function(root){
 'use strict';
 const dotted='........................................';
 const labels={sick:'ป่วย',personal:'กิจส่วนตัว',maternity:'คลอดบุตร',lenient:'อนุโลม',other:'อื่น ๆ'};
 const xml=v=>String(v??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
 function date(value){if(!/^\d{4}-\d{2}-\d{2}$/.test(value||''))return dotted;return new Date(value+'T12:00:00Z').toLocaleDateString('th-TH',{day:'numeric',month:'long',year:'numeric',timeZone:'Asia/Bangkok'});}
 function eventDate(value){if(!value||Number.isNaN(Date.parse(value)))return dotted;return date(new Date(value).toLocaleDateString('sv-SE',{timeZone:'Asia/Bangkok'}));}
 function model(r){
  const tick=type=>r.leave_type===type?'( / )':'(   )',last=r.last_leave;
  return {title:r.leave_type==='lenient'?'แบบใบลาอนุโลม':r.leave_type==='other'?'แบบใบลาอื่น ๆ':'แบบใบลาป่วย ลาคลอดบุตร ลากิจส่วนตัว',
   written:['เขียนที่ โรงเรียนบ้านป่าเด็ง','อำเภอแก่งกระจาน จังหวัดเพชรบุรี','วันที่ '+date(r.request_date)],
   subject:'เรื่อง   ขอลา'+(labels[r.leave_type]||''),to:'เรียน   ผู้อำนวยการโรงเรียนบ้านป่าเด็ง',
   name:'ข้าพเจ้า '+(r.full_name||dotted)+'   ตำแหน่ง '+(r.position||dotted),
   agency:'สังกัด  สำนักงานเขตพื้นที่การศึกษาประถมศึกษาเพชรบุรี เขต 2',
   choices:[tick('sick')+' ป่วย         เนื่องจาก '+(r.leave_type==='sick'?r.reason:dotted),tick('personal')+' กิจส่วนตัว  เนื่องจาก '+(r.leave_type==='personal'?r.reason:dotted),tick('maternity')+' คลอดบุตร'+(r.leave_type==='maternity'?'  เนื่องจาก '+r.reason:'')],
   other:r.leave_type==='lenient'?'( / ) อนุโลม  เนื่องจาก '+r.reason:r.leave_type==='other'?'( / ) อื่น ๆ  เนื่องจาก '+r.reason:null,
   period:'ตั้งแต่วันที่ '+date(r.start_date)+' ถึงวันที่ '+date(r.end_date)+' มีกำหนด '+r.leave_days+' วัน',
   last:last?'ข้าพเจ้าได้ลา '+(labels[last.leave_type]||'')+' ครั้งสุดท้ายตั้งแต่วันที่ '+date(last.start_date):'ข้าพเจ้าได้ลา (   ) ป่วย (   ) กิจส่วนตัว (   ) คลอดบุตร ครั้งสุดท้ายตั้งแต่วันที่ '+dotted,
   lastEnd:last?'ถึงวันที่ '+date(last.end_date)+' มีกำหนด '+(last.leave_days??(Math.round((Date.parse(last.end_date)-Date.parse(last.start_date))/86400000)+1))+' วัน':'ถึงวันที่ '+dotted+' มีกำหนด ........ วัน',
   contact:'ในระหว่างลาจะติดต่อข้าพเจ้าได้ที่ '+(r.contact_address||dotted),phone:'เบอร์โทรศัพท์ที่สามารถติดต่อได้ '+(r.contact_phone||dotted),
   signature:['ขอแสดงความนับถือ','(ลงชื่อ) '+dotted,'('+(r.full_name||dotted)+')'],
   stats:(r.stats||[]).map(s=>[labels[s.type]||s.type,String(s.previous_count),String(s.previous_days),String(s.current_days),String(s.total_count),String(s.total_days)]),
   checker:['ลงชื่อ '+dotted+' ผู้ตรวจสอบ','('+(r.reviewer_name||r.deputy_name||dotted)+')','ตำแหน่ง '+(r.reviewer_position||r.deputy_position||'รองผู้อำนวยการโรงเรียนบ้านป่าเด็ง'),'วันที่ '+eventDate(r.reviewer_at)],
   opinion:'ความเห็นผู้บังคับบัญชา',comment:r.reviewer_comment||dotted+dotted,
   decision:'คำสั่ง',decisionChoice:(r.status==='approved'?'( / )':'(   )')+' อนุญาต    '+(r.status==='rejected'?'( / )':'(   )')+' ไม่อนุญาต',
   director:['(ลงชื่อ) '+dotted,'('+(r.decision_name||r.director_name||dotted)+')','ตำแหน่ง '+(r.decision_position||r.director_position||'ผู้อำนวยการโรงเรียนบ้านป่าเด็ง'),'วันที่ '+eventDate(r.approved_at)],decisionNote:r.decision_note||''};
 }
 function docxFiles(r){
  const m=model(r),p=(t,{bold=false,align='left',after=0,before=0,size=32}={})=>`<w:p><w:pPr><w:jc w:val="${align}"/><w:spacing w:before="${before}" w:after="${after}" w:line="350" w:lineRule="exact"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="TH Sarabun PSK" w:hAnsi="TH Sarabun PSK" w:cs="TH Sarabun PSK"/>${bold?'<w:b/>':''}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr><w:t xml:space="preserve">${xml(t)}</w:t></w:r></w:p>`;
  const tc=(body,width,span=1)=>`<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${span>1?`<w:gridSpan w:val="${span}"/>`:''}<w:vAlign w:val="center"/></w:tcPr>${body}</w:tc>`;
  const widths=[1250,700,700,1050,650,650];
  const stats='<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders>'+['top','left','bottom','right','insideH','insideV'].map(k=>`<w:${k} w:val="single" w:sz="4"/>`).join('')+'</w:tblBorders></w:tblPr><w:tblGrid>'+widths.map(w=>`<w:gridCol w:w="${w}"/>`).join('')+'</w:tblGrid><w:tr>'+tc(p('ประเภทลา',{align:'center',size:28}),1250)+tc(p('ลามาแล้ว',{align:'center',size:28}),1400,2)+tc(p('ลาครั้งนี้',{align:'center',size:28}),1050)+tc(p('รวมเป็น',{align:'center',size:28}),1300,2)+'</w:tr><w:tr>'+['','(ครั้ง)','(วัน)','(วัน)','(ครั้ง)','(วัน)'].map((s,i)=>tc(p(s,{align:'center',size:28}),widths[i])).join('')+'</w:tr>'+m.stats.map(row=>'<w:tr>'+row.map((s,i)=>tc(p(s,{align:i===0?'left':'center',size:28}),widths[i])).join('')+'</w:tr>').join('')+'</w:tbl>';
  const outer=(left,right)=>`<w:tbl><w:tblPr><w:tblW w:w="9350" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders>${['top','left','bottom','right','insideH','insideV'].map(k=>`<w:${k} w:val="nil"/>`).join('')}</w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="5150"/><w:gridCol w:w="4200"/></w:tblGrid><w:tr>${tc(left,5150)}${tc(right,4200)}</w:tr></w:tbl>`;
  const body=p(m.title,{bold:true,align:'center',after:360,size:36})+m.written.map(t=>p(t,{align:'right'})).join('')+p('',{after:100})+p(m.subject)+p(m.to)+p(m.name,{before:200})+p(m.agency)+p('ขอลา')+m.choices.map(t=>p(t)).join('')+(m.other?p(m.other):'')+p(m.period)+p(m.last)+p(m.lastEnd)+p(m.contact)+p(m.phone)+m.signature.map((t,i)=>p(t,{align:'right',before:i<2?240:0})).join('')+p('สถิติการลา',{bold:true,before:120})+outer(stats+p(''),p('',{before:300})+m.checker.map(t=>p(t,{align:'center',size:30})).join(''))+p(m.opinion,{before:180})+p(m.comment)+outer(p(''),p(m.decision,{align:'center'})+p(m.decisionChoice,{align:'center'})+(m.decisionNote?p(m.decisionNote,{align:'center'}):'')+m.director.map((t,i)=>p(t,{align:'center',before:i===0?240:0,size:30})).join(''));
  return {'[Content_Types].xml':'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
   '_rels/.rels':'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
   'word/document.xml':'<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+body+'<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="850" w:right="1080" w:bottom="850" w:left="1440"/></w:sectPr></w:body></w:document>'};
 }
 function pdfDefinition(r){
  const m=model(r),line=(text,extra={})=>({text,...extra}),right=(text,extra={})=>line(text,{alignment:'right',...extra});
  const table={table:{widths:[64,28,28,32,28,28],body:[[{text:'ประเภทลา',rowSpan:2},{text:'ลามาแล้ว',colSpan:2},{},{text:'ลาครั้งนี้'},{text:'รวมเป็น',colSpan:2},{}],['','(ครั้ง)','(วัน)','(วัน)','(ครั้ง)','(วัน)'],...m.stats].map(row=>row.map(c=>typeof c==='string'?{text:c,alignment:'center'}:c))},fontSize:14,layout:{paddingLeft:()=>3,paddingRight:()=>3,paddingTop:()=>2,paddingBottom:()=>2}};
  return {pageSize:'A4',pageMargins:[62,42,48,42],defaultStyle:{font:'Sarabun',fontSize:16,lineHeight:0.84},content:[
   line(m.title,{bold:true,alignment:'center',fontSize:18,margin:[0,0,0,14]}),...m.written.map(t=>right(t)),line(m.subject,{margin:[0,16,0,0]}),line(m.to),line(m.name,{margin:[0,14,0,0]}),line(m.agency),
   {columns:[{text:'ขอลา',width:58},{stack:m.choices.map(t=>line(t)),width:'*'}]},...(m.other?[line(m.other)]:[]),line(m.period),line(m.last),line(m.lastEnd),line(m.contact),line(m.phone),
   ...m.signature.map((t,i)=>right(t,{margin:[0,i<2?10:0,0,0]})),line('สถิติการลา',{bold:true,margin:[0,10,0,3]}),
   {columns:[{width:260,stack:[table]},{width:'*',stack:m.checker.map(t=>line(t,{alignment:'center',fontSize:15})),margin:[0,26,0,0]}],columnGap:12},
   line(m.opinion,{margin:[0,14,0,0]}),line(m.comment),
   {columns:[{width:250,text:''},{width:'*',stack:[line(m.decision,{alignment:'center'}),line(m.decisionChoice,{alignment:'center'}),...(m.decisionNote?[line(m.decisionNote,{alignment:'center'})]:[]),...m.director.map((t,i)=>line(t,{alignment:'center',fontSize:15,margin:[0,i===0?20:0,0,0]}))]}],columnGap:12}
  ]};
 }
 const loading=new Map();
 function library(name,url){if(root[name])return Promise.resolve(root[name]);if(!loading.has(name))loading.set(name,new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=url;s.onload=()=>resolve(root[name]);s.onerror=()=>{loading.delete(name);s.remove();reject(Error('โหลดเครื่องมือส่งออกไม่สำเร็จ กรุณาลองใหม่'));};document.head.append(s);}));return loading.get(name);}
 function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
 async function exportFile(format,r){
  const name='ใบลา-'+r.id+'-'+r.start_date;
  if(format==='docx'){const Zip=await library('JSZip','https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'),zip=new Zip();for(const [path,text] of Object.entries(docxFiles(r)))zip.file(path,text);download(await zip.generateAsync({type:'blob',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}),name+'.docx');return;}
  if(format!=='pdf')throw Error('รูปแบบไฟล์ไม่ถูกต้อง');
  const pdf=await library('pdfMake','https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.12/pdfmake.min.js');
  const fonts=Object.fromEntries(await Promise.all(['THSarabunPSK-Regular.ttf','THSarabunPSK-Bold.ttf'].map(async name=>{const response=await fetch('/fonts/'+name);if(!response.ok)throw Error('โหลดฟอนต์ภาษาไทยไม่สำเร็จ');const bytes=new Uint8Array(await response.arrayBuffer());let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return [name,btoa(text)];})));
  pdf.vfs={...(pdf.vfs||{}),...fonts};pdf.fonts={...(pdf.fonts||{}),Sarabun:{normal:'THSarabunPSK-Regular.ttf',bold:'THSarabunPSK-Bold.ttf'}};
  const blob=await new Promise((resolve,reject)=>{try{pdf.createPdf(pdfDefinition(r)).getBlob(resolve);}catch(e){reject(e);}});download(blob,name+'.pdf');
 }
 root.LeaveFormExport={model,docxFiles,pdfDefinition,exportFile};
})(typeof window==='undefined'?globalThis:window);
