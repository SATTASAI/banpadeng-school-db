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


 const PAGE={width:595.3,height:841.9},TEMPLATE='/forms/personnel-leave-original.pdf',TEMPLATE_PNG='/forms/personnel-leave-original.png';
 const advances={"32":0.216,"33":0.147,"34":0.208,"35":0.403,"36":0.361,"37":0.585,"38":0.423,"39":0.12,"40":0.19,"41":0.19,"42":0.285,"43":0.411,"44":0.162,"45":0.216,"46":0.162,"47":0.27,"48":0.362,"49":0.362,"50":0.362,"51":0.362,"52":0.362,"53":0.362,"54":0.362,"55":0.362,"56":0.362,"57":0.362,"58":0.162,"59":0.162,"60":0.411,"61":0.411,"62":0.411,"63":0.283,"64":0.536,"65":0.4,"66":0.378,"67":0.406,"68":0.431,"69":0.351,"70":0.351,"71":0.425,"72":0.441,"73":0.147,"74":0.264,"75":0.376,"76":0.353,"77":0.548,"78":0.441,"79":0.486,"80":0.378,"81":0.487,"82":0.379,"83":0.352,"84":0.379,"85":0.466,"86":0.39,"87":0.588,"88":0.418,"89":0.366,"90":0.424,"91":0.196,"92":0.262,"93":0.196,"94":0.412,"95":0.352,"96":0.204,"97":0.344,"98":0.401,"99":0.331,"100":0.401,"101":0.374,"102":0.206,"103":0.311,"104":0.39,"105":0.143,"106":0.155,"107":0.316,"108":0.2,"109":0.601,"110":0.39,"111":0.398,"112":0.401,"113":0.401,"114":0.217,"115":0.282,"116":0.238,"117":0.39,"118":0.341,"119":0.507,"120":0.318,"121":0.337,"122":0.321,"123":0.208,"124":0.153,"125":0.208,"126":0.416,"3584":0,"3585":0.386,"3586":0.378,"3587":0.382,"3588":0.393,"3589":0.393,"3590":0.408,"3591":0.294,"3592":0.367,"3593":0.377,"3594":0.38,"3595":0.384,"3596":0.519,"3597":0.519,"3598":0.425,"3599":0.425,"3600":0.343,"3601":0.461,"3602":0.532,"3603":0.543,"3604":0.391,"3605":0.391,"3606":0.378,"3607":0.43,"3608":0.335,"3609":0.42,"3610":0.428,"3611":0.428,"3612":0.381,"3613":0.381,"3614":0.447,"3615":0.447,"3616":0.425,"3617":0.4,"3618":0.375,"3619":0.322,"3620":0.378,"3621":0.381,"3622":0.425,"3623":0.335,"3624":0.393,"3625":0.438,"3626":0.381,"3627":0.427,"3628":0.454,"3629":0.387,"3630":0.372,"3631":0.391,"3632":0.357,"3633":0,"3634":0.316,"3635":0.316,"3636":0,"3637":0,"3638":0,"3639":0,"3640":0,"3641":0,"3642":0,"3647":0.411,"3648":0.203,"3649":0.377,"3650":0.237,"3651":0.242,"3652":0.244,"3653":0.205,"3654":0.399,"3655":0,"3656":0,"3657":0,"3658":0,"3659":0,"3660":0,"3661":0,"3662":0,"3663":0.45,"3664":0.449,"3665":0.449,"3666":0.449,"3667":0.449,"3668":0.449,"3669":0.449,"3670":0.449,"3671":0.449,"3672":0.449,"3673":0.449,"3674":0.522,"3675":0.697};
 const widthOf=(text,size)=>Array.from(String(text)).reduce((sum,c)=>sum+(advances[c.codePointAt(0)]??0.5)*size,0);
 const shortDate=s=>/^\d{4}-\d{2}-\d{2}$/.test(s||'')?date(s):'';
 const parts=s=>/^\d{4}-\d{2}-\d{2}$/.test(s||'')?[String(Number(s.slice(8))),new Date(s+'T12:00:00Z').toLocaleDateString('th-TH',{month:'long',timeZone:'Asia/Bangkok'}),String(Number(s.slice(0,4))+543)]:['','',''];
 const signedParts=s=>s&&!Number.isNaN(Date.parse(s))?parts(new Date(s).toLocaleDateString('sv-SE',{timeZone:'Asia/Bangkok'})):['','',''];
 function filledForm(r){
  const fields=[],images=[],appendix=[];
  function text(key,value,x,y,width,size=16){
   if(value===undefined||value===null||String(value)==='')return;
   const full=String(value).replace(/\s+/g,' ').trim();if(!full)return;
   let fontSize=Math.min(size,(width-4)/Math.max(widthOf(full,1),0.1)),display=full;
   if(fontSize<11){
    fontSize=11;const chars=typeof Intl.Segmenter==='function'?Array.from(new Intl.Segmenter('th',{granularity:'grapheme'}).segment(full),s=>s.segment):Array.from(full);
    while(chars.length&&widthOf(chars.join('')+' (ต่อใบแนบ)',fontSize)>width-4)chars.pop();
    display=chars.join('')+' (ต่อใบแนบ)';appendix.push([key,full]);
   }
   fields.push({key,text:display,x,y:y+(size-fontSize)*0.7,width,fontSize});
  }
  function mark(key,x,y){fields.push({key,text:'/',x,y,width:11,fontSize:16});}
  function signature(key,data,x,y,width,height){if(data)images.push({key,data,x,y,width,height});}
  const requested=parts(r.request_date);
  text('วันที่เขียน',requested[0],354,121,36);text('เดือนที่เขียน',requested[1],411,121,68);text('ปีที่เขียน',requested[2],494,121,43);
  text('เรื่อง','ขอลา'+(labels[r.leave_type]||''),115,146,176);
  text('ชื่อผู้ลา',r.full_name,161,193.3,228);text('ตำแหน่ง',r.position,423,193.3,103);
  if(['sick','personal','maternity'].includes(r.leave_type))mark('ประเภทลา',158,r.leave_type==='sick'?225:r.leave_type==='personal'?241:257);
  if(r.leave_type==='sick'||r.leave_type==='personal')text('เหตุผล',r.reason,263,r.leave_type==='sick'?225:241,264);
  else if(r.reason)appendix.push(['เหตุผลการลา'+(labels[r.leave_type]||''),r.reason]);
  text('ตั้งแต่วันที่',shortDate(r.start_date),116,272.4,124);text('ถึงวันที่',shortDate(r.end_date),275,272.4,128);text('จำนวนวัน',r.leave_days,448,272.4,66);
  const last=r.last_leave;
  if(last){
   const x={sick:134,personal:183,maternity:252}[last.leave_type];if(x)mark('ประเภทลาครั้งล่าสุด',x,288.2);
   text('วันที่ลาครั้งล่าสุด',shortDate(last.start_date),395,288.2,138);text('วันสิ้นสุดการลาครั้งล่าสุด',shortDate(last.end_date),107,304,198);text('จำนวนวันลาครั้งล่าสุด',last.leave_days,341,304,48);
  }
  text('ที่อยู่ระหว่างลา',r.contact_address,79,319.8,216);text('เบอร์โทรศัพท์',r.contact_phone,399,319.8,135);
  text('ชื่อใต้ลายเซ็นครู',r.full_name,350,410.7,129);
  signature('teacher',r.teacher_signature,350,379,131,24);
  const cols=[133.5,163.8,197.4,239.8,275.4],widths=[29.8,33,41.5,35,27.7];
  for(const [type,y] of [['sick',495.5],['personal',511.9],['maternity',528.2]]){
   const stat=(r.stats||[]).find(s=>s.type===type);
   if(stat)[stat.previous_count,stat.previous_days,stat.current_days,stat.total_count,stat.total_days].forEach((value,i)=>text(type+'-'+i,value,cols[i],y,widths[i]));
  }
  text('ความเห็นผู้บังคับบัญชา',r.reviewer_comment||r.personnel_note,90,570.8,454);
  if(r.status==='approved')mark('อนุญาต',413,602.5);if(r.status==='rejected')mark('ไม่อนุญาต',471,602.5);
  // The source prints the incumbent names. Never put another person's signature
  // under those printed names; preserve the form and record that signatory in an annex.
  const normalized=s=>String(s||'').replace(/\s|นางสาว|นาง|นาย|ว่าที่ร้อยตรีหญิง|\.|\(|\)/g,'');
  const deputyName=r.deputy_name||r.reviewer_name,approverName=r.decision_name||r.director_name;
  if(r.status==='approved'){
   if(normalized(deputyName)==='วริศรานวมนิ่ม')signature('deputy',r.deputy_signature,380,459,117,22);
   else if(r.deputy_signature)appendix.push(['ลายเซ็นรองผู้รับผิดชอบ',deputyName||'รองผู้อำนวยการที่กำหนดไว้','deputy',r.deputy_signature]);
   if(normalized(approverName)==='จิราพรสุขวงศ์')signature('approver',r.approver_signature,462,619.5,80,22);
   else if(r.approver_signature)appendix.push(['ลายเซ็นผู้อนุมัติจริง',approverName||'ผู้อนุมัติตามบันทึกระบบ','approver',r.approver_signature]);
  }
  const decision=signedParts(r.approved_at),review=signedParts(r.reviewer_at);
  decision.forEach((v,i)=>text('วันที่พิจารณา-'+i,v,[400,446,499][i],681.6,[43,50,51][i]));
  review.forEach((v,i)=>text('วันที่ให้ความเห็น-'+i,v,[384,430,483][i],520.6,[43,50,51][i]));
  if(r.applicant_note)appendix.push(['หมายเหตุของผู้ลา',r.applicant_note]);
  if(r.decision_note)appendix.push(['หมายเหตุผู้อนุมัติ',r.decision_note]);
  if(r.leave_type==='lenient'){
   appendix.push(['ประเภทการลา','ลาอนุโลม - แยกต่างหาก ไม่นับรวมปีงบประมาณ']);
   appendix.push(['มอบหมายคาบสอนแทนให้แก่',r.substitute_teacher||'ยังไม่ได้ระบุในรายการเดิม']);
   for(const stat of r.stats||[])appendix.push(['สถิติลาอนุโลม','ลามาแล้ว '+stat.previous_count+' ครั้ง '+stat.previous_days+' วัน / ลาครั้งนี้ '+stat.current_days+' วัน / รวม '+stat.total_count+' ครั้ง '+stat.total_days+' วัน']);
  }
  return {fields,images,appendix};
 }
 function pngBytes(data){return Uint8Array.from(atob(data.split(',')[1]),c=>c.charCodeAt(0));}
 function docxFiles(r,background){
  if(!background)throw Error('ไม่พบภาพแบบฟอร์มต้นฉบับ กรุณาลองใหม่');
  const form=filledForm(r),media={'word/media/original-form.png':background},rels=[];let id=0;
  const image=(key,bytes,x,y,width,height,behind=false)=>{
   const n=++id,emu=v=>Math.round(v*12700);media['word/media/'+key+'.png']=bytes;
   rels.push('<Relationship Id="image'+n+'" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/'+key+'.png"/>');
   return '<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="'+n+'" behindDoc="'+(behind?1:0)+'" locked="1" layoutInCell="0" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>'+emu(x)+'</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>'+emu(y)+'</wp:posOffset></wp:positionV><wp:extent cx="'+emu(width)+'" cy="'+emu(height)+'"/><wp:wrapNone/><wp:docPr id="'+n+'" name="'+key+'"/><wp:cNvGraphicFramePr/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="'+n+'" name="'+key+'.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="image'+n+'"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="'+emu(width)+'" cy="'+emu(height)+'"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>';
  };
  const font=(size=16)=>'<w:rPr><w:rFonts w:ascii="TH Sarabun PSK" w:hAnsi="TH Sarabun PSK" w:cs="TH Sarabun PSK"/><w:sz w:val="'+Math.round(size*2)+'"/><w:szCs w:val="'+Math.round(size*2)+'"/></w:rPr>';
  const textBox=f=>'<w:r><w:pict><v:shape id="field'+(++id)+'" type="#_x0000_t202" style="position:absolute;margin-left:'+f.x+'pt;margin-top:'+f.y+'pt;width:'+f.width+'pt;height:20pt;mso-position-horizontal-relative:page;mso-position-vertical-relative:page;z-index:10" filled="f" stroked="f"><v:textbox inset="0,0,0,0"><w:txbxContent><w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="0" w:line="'+Math.round(f.fontSize*20)+'" w:lineRule="exact"/></w:pPr><w:r>'+font(f.fontSize)+'<w:t xml:space="preserve">'+xml(f.text)+'</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></w:r>';
  const fittedImage=i=>{const bytes=pngBytes(i.data),v=new DataView(bytes.buffer),w=v.getUint32(16),h=v.getUint32(20),scale=Math.min(i.width/w,i.height/h);return image(i.key,bytes,i.x+(i.width-w*scale)/2,i.y+i.height-h*scale,w*scale,h*scale);};
  let body='<w:p><w:pPr><w:spacing w:before="0" w:after="0"/><w:rPr><w:sz w:val="2"/></w:rPr></w:pPr>'+image('original-form',background,0,0,PAGE.width,PAGE.height,true)+form.fields.map(textBox).join('')+form.images.map(fittedImage).join('')+'</w:p>';
  if(form.appendix.length){
   body+='<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
   for(const line of ['ใบแนบข้อมูลประกอบใบลา เลขที่ '+r.id,...form.appendix.map(([label,value])=>label+': '+value)])body+='<w:p><w:r>'+font()+'<w:t xml:space="preserve">'+xml(line)+'</w:t></w:r></w:p>';
   const attached=form.appendix.filter(a=>a[3]);attached.forEach((a,i)=>{body+='<w:p>'+fittedImage({key:a[2],data:a[3],x:90+i*235,y:400,width:180,height:42})+'</w:p>';});
  }
  return {'[Content_Types].xml':'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
   '_rels/.rels':'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="doc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
   'word/document.xml':'<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:v="urn:schemas-microsoft-com:vml"><w:body>'+body+'<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="850" w:right="1134" w:bottom="850" w:left="1134"/></w:sectPr></w:body></w:document>',
   'word/_rels/document.xml.rels':'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+rels.join('')+'</Relationships>',...media};
 }
 function pdfDefinition(r){
  const form=filledForm(r);
  const content=[{text:'',absolutePosition:{x:0,y:0}},...form.fields.map(f=>({columns:[{text:f.text,width:f.width,fontSize:f.fontSize,alignment:'center',noWrap:true}],absolutePosition:{x:f.x,y:f.y}})),
   ...form.images.map(i=>({columns:[{width:i.width,stack:[{image:i.data,fit:[i.width,i.height],alignment:'center'}]}],absolutePosition:{x:i.x,y:i.y}}))];
  if(form.appendix.length)content.push({pageBreak:'before',margin:[56.7,45,56.7,45],stack:[{text:'ใบแนบข้อมูลประกอบใบลา เลขที่ '+r.id,bold:true,alignment:'center',margin:[0,0,0,16]},...form.appendix.flatMap(([label,value,key,data])=>[{text:label+': '+value,margin:[0,0,0,8]},...(data?[{image:data,fit:[160,42],margin:[0,0,0,12]}]:[])])]});
  return {pageSize:PAGE,pageMargins:[0,0,0,0],defaultStyle:{font:'Sarabun',fontSize:16},content};
 }
 async function mergeTemplate(templateBytes,overlayBytes,pdfLib){
  const original=await pdfLib.PDFDocument.load(templateBytes),overlay=await pdfLib.PDFDocument.load(overlayBytes);
  const first=original.getPages()[0],overlayPages=overlay.getPages(),embedded=await original.embedPage(overlayPages[0]);
  first.drawPage(embedded,{x:0,y:0,width:first.getWidth(),height:first.getHeight()});
  if(overlayPages.length>1){const copies=await original.copyPages(overlay,overlayPages.slice(1).map((_,i)=>i+1));copies.forEach(page=>original.addPage(page));}
  return original.save();
 }
 const loading=new Map();
 function library(name,url){if(root[name])return Promise.resolve(root[name]);if(!loading.has(name))loading.set(name,new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=url;s.onload=()=>resolve(root[name]);s.onerror=()=>{loading.delete(name);s.remove();reject(Error('โหลดเครื่องมือส่งออกไม่สำเร็จ กรุณาลองใหม่'));};document.head.append(s);}));return loading.get(name);}
 function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
 async function exportFile(format,r){
  const name='ใบลา-'+r.id+'-'+r.start_date;
  if(format==='docx'){const template=await fetch(TEMPLATE_PNG);if(!template.ok)throw Error('โหลดแบบฟอร์มต้นฉบับไม่สำเร็จ');const background=new Uint8Array(await template.arrayBuffer());const Zip=await library('JSZip','https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'),zip=new Zip();for(const [path,text] of Object.entries(docxFiles(r,background)))zip.file(path,text);download(await zip.generateAsync({type:'blob',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}),name+'.docx');return;}
  if(format!=='pdf')throw Error('รูปแบบไฟล์ไม่ถูกต้อง');
  const pdf=await library('pdfMake','/js/pdfmake.min.js');
  const fonts=Object.fromEntries(await Promise.all(['THSarabunPSK-Regular.ttf','THSarabunPSK-Bold.ttf'].map(async name=>{const response=await fetch('/fonts/'+name);if(!response.ok)throw Error('โหลดฟอนต์ภาษาไทยไม่สำเร็จ');const bytes=new Uint8Array(await response.arrayBuffer());let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return [name,btoa(text)];})));
  pdf.vfs={...(pdf.vfs||{}),...fonts};pdf.fonts={...(pdf.fonts||{}),Sarabun:{normal:'THSarabunPSK-Regular.ttf',bold:'THSarabunPSK-Bold.ttf'}};
  const overlay=await new Promise((resolve,reject)=>{try{pdf.createPdf(pdfDefinition(r)).getBuffer(resolve);}catch(e){reject(e);}});
  const template=await fetch(TEMPLATE);if(!template.ok)throw Error('โหลดแบบฟอร์มต้นฉบับไม่สำเร็จ');
  const pdfLib=await library('PDFLib','/js/pdf-lib.min.js'),filled=await mergeTemplate(await template.arrayBuffer(),overlay,pdfLib);download(new Blob([filled],{type:'application/pdf'}),name+'.pdf');
 }
 root.LeaveFormExport={model,filledForm,docxFiles,pdfDefinition,mergeTemplate,exportFile};
})(typeof window==='undefined'?globalThis:window);
