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
   note:r.applicant_note||'',substitute:r.leave_type==='lenient'?'มอบหมายคาบสอนแทนให้แก่ '+(r.substitute_teacher||dotted):'',
   signature:['ขอแสดงความนับถือ','(ลงชื่อ) '+dotted,'('+(r.full_name||dotted)+')'],
   stats:(r.stats||[]).map(s=>[labels[s.type]||s.type,String(s.previous_count),String(s.previous_days),String(s.current_days),String(s.total_count),String(s.total_days)]),
   checker:['ลงชื่อ '+dotted+' ผู้ตรวจสอบ','('+(r.deputy_name||r.reviewer_name||dotted)+')','ตำแหน่ง '+(r.deputy_position||r.reviewer_position||'รองผู้อำนวยการโรงเรียนบ้านป่าเด็ง'),'วันที่ '+eventDate(r.reviewer_at)],
   opinion:'ความเห็นผู้บังคับบัญชา',comment:r.reviewer_comment||dotted+dotted,
   decision:'คำสั่ง',decisionChoice:(r.status==='approved'?'( / )':'(   )')+' อนุญาต    '+(r.status==='rejected'?'( / )':'(   )')+' ไม่อนุญาต',
   director:['(ลงชื่อ) '+dotted,'('+(r.decision_name||r.director_name||dotted)+')','ตำแหน่ง '+(r.decision_position||r.director_position||'ผู้อำนวยการโรงเรียนบ้านป่าเด็ง'),'วันที่ '+eventDate(r.approved_at)],decisionNote:r.decision_note||''};
 }

 function formRows(r,m){
  return [['ชื่อ–สกุล',r.full_name||dotted],['ตำแหน่ง / สังกัด',(r.position||dotted)+' / โรงเรียนบ้านป่าเด็ง'],
   ['ประเภทการลา','ลา'+(labels[r.leave_type]||r.leave_type)],['เหตุผล',r.reason||dotted],
   ['ระยะเวลาการลา',m.period],['ที่อยู่ระหว่างลา',r.contact_address||dotted],['เบอร์โทรศัพท์',r.contact_phone||dotted],
   ...(m.substitute?[['มอบหมายคาบสอนแทนให้แก่',r.substitute_teacher||dotted]]:[]),['หมายเหตุ',m.note||'—']];
 }
 function signatureData(r){return {teacher:r.teacher_signature||null,deputy:r.status==='approved'?r.deputy_signature||null:null,approver:r.status==='approved'?r.approver_signature||null:null};}
 function pngBytes(data){return Uint8Array.from(atob(data.split(',')[1]),c=>c.charCodeAt(0));}
 function docxFiles(r){
  const m=model(r),signatures=signatureData(r),media={},rels=[];
  const p=(t,{bold=false,align='both',after=60,before=0,size=32}={})=>'<w:p><w:pPr><w:jc w:val="'+align+'"/><w:spacing w:before="'+before+'" w:after="'+after+'" w:line="320" w:lineRule="atLeast"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="TH Sarabun PSK" w:hAnsi="TH Sarabun PSK" w:cs="TH Sarabun PSK"/>'+(bold?'<w:b/>':'')+'<w:sz w:val="'+size+'"/><w:szCs w:val="'+size+'"/></w:rPr><w:t xml:space="preserve">'+xml(t)+'</w:t></w:r></w:p>';
  function image(key){
   if(!signatures[key])return p('(ลงชื่อ) '+dotted,{align:'center',before:140});
   const bytes=pngBytes(signatures[key]),view=new DataView(bytes.buffer),w=view.getUint32(16),h=view.getUint32(20),scale=Math.min(145/w,38/h),cx=Math.round(w*scale*12700),cy=Math.round(h*scale*12700),id=rels.length+1;
   media['word/media/'+key+'.png']=bytes;rels.push('<Relationship Id="sig'+id+'" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/'+key+'.png"/>');
   return '<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="100" w:after="0"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="'+cx+'" cy="'+cy+'"/><wp:docPr id="'+id+'" name="ลายเซ็น '+key+'"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="'+id+'" name="'+key+'.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="sig'+id+'"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="'+cx+'" cy="'+cy+'"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
  }
  const tc=(body,width,span=1)=>'<w:tc><w:tcPr><w:tcW w:w="'+width+'" w:type="dxa"/>'+(span>1?'<w:gridSpan w:val="'+span+'"/>':'')+'<w:vAlign w:val="center"/></w:tcPr>'+body+'</w:tc>';
  const table=(rows,widths,border=false)=>'<w:tbl><w:tblPr><w:tblW w:w="9638" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="80" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar><w:tblBorders>'+['top','left','bottom','right','insideH','insideV'].map(k=>'<w:'+k+' w:val="'+(border?'single':'nil')+'" w:sz="4" w:color="777777"/>').join('')+'</w:tblBorders></w:tblPr><w:tblGrid>'+widths.map(w=>'<w:gridCol w:w="'+w+'"/>').join('')+'</w:tblGrid>'+rows.map(row=>'<w:tr><w:trPr><w:cantSplit/></w:trPr>'+row.join('')+'</w:tr>').join('')+'</w:tbl>';
  const fields=table(formRows(r,m).map(([label,value])=>[tc(p(label,{bold:true}),2200),tc(p(value),7438)]),[2200,7438]);
  const widths=[2438,1440,1440,1440,1440,1440],stats=table([
   [tc(p('ประเภทลา',{align:'center',bold:true}),2438),tc(p('ลามาแล้ว',{align:'center'}),2880,2),tc(p('ลาครั้งนี้',{align:'center'}),1440),tc(p('รวมเป็น',{align:'center'}),2880,2)],
   ['', '(ครั้ง)','(วัน)','(วัน)','(ครั้ง)','(วัน)'].map((v,i)=>tc(p(v,{align:'center'}),widths[i])),
   ...m.stats.map(row=>row.map((v,i)=>tc(p(v,{align:i?'center':'left'}),widths[i])))],widths,true);
  const teacher=p('ขอแสดงความนับถือ',{align:'center',before:100})+image('teacher')+p('('+(r.full_name||dotted)+')',{align:'center'});
  const checker=image('deputy')+m.checker.slice(1).map(t=>p(t,{align:'center',size:30})).join('');
  const decision=p(m.decision,{align:'center',bold:true})+p(m.decisionChoice,{align:'center'})+(m.decisionNote?p(m.decisionNote,{align:'center'}):'')+image('approver')+m.director.slice(1).map(t=>p(t,{align:'center',size:30})).join('');
  const body=p(m.title,{bold:true,align:'center',size:38,after:200})+m.written.map(t=>p(t,{align:'right',after:0})).join('')+p(m.subject,{before:180})+p(m.to)+fields+p(m.last)+p(m.lastEnd)+table([[tc(p(''),4819),tc(teacher,4819)]],[4819,4819])+p(r.leave_type==='lenient'?'สถิติลาอนุโลม (แยกต่างหาก ไม่นับรวมปีงบประมาณ)':'สถิติการลาจริงประจำปีงบประมาณ',{bold:true,before:120})+stats+p(m.opinion,{bold:true,before:120})+p(m.comment)+table([[tc(checker,4819),tc(decision,4819)]],[4819,4819]);
  const files={'[Content_Types].xml':'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
   '_rels/.rels':'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
   'word/document.xml':'<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>'+body+'<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="850" w:right="1134" w:bottom="850" w:left="1134"/></w:sectPr></w:body></w:document>'};
  if(rels.length){files['word/_rels/document.xml.rels']='<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+rels.join('')+'</Relationships>';Object.assign(files,media);}
  return files;
 }
 function pdfDefinition(r){
  const m=model(r),signatures=signatureData(r),line=(text,extra={})=>({text,...extra}),center=t=>line(t,{alignment:'center'});
  const image=key=>signatures[key]?{image:signatures[key],fit:[145,38],alignment:'center',margin:[0,5,0,2]}:line('(ลงชื่อ) '+dotted,{alignment:'center',margin:[0,15,0,2]});
  const fieldTable={table:{widths:[105,'*'],body:formRows(r,m).map(([label,value])=>[{text:label,bold:true},line(value)])},layout:{hLineWidth:()=>0,vLineWidth:()=>0,paddingLeft:()=>4,paddingRight:()=>4,paddingTop:()=>1,paddingBottom:()=>1},margin:[0,8,0,8]};
  const stats={table:{widths:['*',40,40,45,40,40],body:[[{text:'ประเภทลา',rowSpan:2},{text:'ลามาแล้ว',colSpan:2},{},{text:'ลาครั้งนี้'},{text:'รวมเป็น',colSpan:2},{}],['','(ครั้ง)','(วัน)','(วัน)','(ครั้ง)','(วัน)'],...m.stats].map(row=>row.map(c=>typeof c==='string'?center(c):c))},fontSize:14,layout:{paddingLeft:()=>4,paddingRight:()=>4,paddingTop:()=>2,paddingBottom:()=>2}};
  return {pageSize:'A4',pageMargins:[56.7,34,56.7,34],defaultStyle:{font:'Sarabun',fontSize:16,lineHeight:0.9,alignment:'justify'},content:[
   line(m.title,{bold:true,alignment:'center',fontSize:19,margin:[0,0,0,10]}),...m.written.map(t=>line(t,{alignment:'right'})),line(m.subject,{margin:[0,12,0,0]}),line(m.to),fieldTable,line(m.last),line(m.lastEnd),
   {columns:[{width:'*',text:''},{width:'*',stack:[center('ขอแสดงความนับถือ'),image('teacher'),center('('+(r.full_name||dotted)+')')]}],margin:[0,8,0,8]},
   line(r.leave_type==='lenient'?'สถิติลาอนุโลม (แยกต่างหาก ไม่นับรวมปีงบประมาณ)':'สถิติการลาจริงประจำปีงบประมาณ',{bold:true,margin:[0,5,0,3]}),stats,
   line(m.opinion,{bold:true,margin:[0,8,0,0]}),line(m.comment),
   {unbreakable:true,columns:[{width:'*',stack:[image('deputy'),...m.checker.slice(1).map(center)]},{width:'*',stack:[center(m.decision),center(m.decisionChoice),...(m.decisionNote?[center(m.decisionNote)]:[]),image('approver'),...m.director.slice(1).map(center)]}],columnGap:16}
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
