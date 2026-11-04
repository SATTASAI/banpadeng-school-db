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

 // ---- เค้าโครงตามแบบฟอร์มโรงเรียน: ข้อมูลอยู่บนเส้นจุด จัดแบบ Thai distribute ชนขอบขวา ----
 const SIZE=16,WIDTH=481.9,NB=' ',tick=on=>on?'( / )':'(   )';
 // ประมาณความกว้างตัวอักษร TH Sarabun PSK (หน่วย pt ที่ 16pt) เพื่อเติมเส้นจุดให้พอดีบรรทัด
 function pt(text){let w=0;for(const ch of String(text??'')){const c=ch.codePointAt(0);
  if(c===0xE31||(c>=0xE34&&c<=0xE3A)||(c>=0xE47&&c<=0xE4E))continue;
  w+=ch===' '||ch===NB?.216:ch==='.'?.162:/[0-9๐-๙]/.test(ch)?.362:ch==='('||ch===')'?.19:ch==='/'?.27:ch==='เ'?.203:'โใไ'.includes(ch)?.24:'าำ'.includes(ch)?.316:ch==='แ'?.377:c>=0xE00&&c<=0xE7F?.41:c<128?.45:.5;}
  return w*SIZE;}
 const F=(v,w=1)=>({v:v==null?'':String(v),w});
 // แปลงบรรทัด (ข้อความ + ช่องข้อมูล) เป็นช่วงพร้อมความกว้างช่องข้อมูลที่เติมจนเต็มบรรทัด
 function fit(segs,width){
  const items=segs.map(x=>typeof x==='string'?{label:x}:x),gap=pt(' ')*(items.length-1);
  const fixed=items.reduce((t,x)=>t+(x.label!=null?pt(x.label):pt(x.v)+2*pt(NB)),gap),weight=items.reduce((t,x)=>t+(x.label!=null?0:x.w),0)||1;
  const extra=width*0.975-fixed;
  return items.map(x=>{if(x.label!=null)return x;
   const own=pt(x.v)+2*pt(NB),slot=extra>=0?own+extra*x.w/weight:Math.max(own,30);
   return {...x,slot,pad:Math.max(1,Math.round((slot-pt(x.v))/pt(NB)))};});
 }
 function padded(f){const left=Math.max(1,Math.floor(f.pad/2));return NB.repeat(left)+f.v+NB.repeat(Math.max(1,f.pad-left))+'\u200b';}
 const date3=v=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(v||''))return ['','',''];const d=new Date(v+'T12:00:00Z'),o={timeZone:'Asia/Bangkok'};return [d.toLocaleDateString('th-TH',{...o,day:'numeric'}),d.toLocaleDateString('th-TH',{...o,month:'long'}),String(Number(v.slice(0,4))+543)];};
 function layout(r){
  const m=model(r),last=r.last_leave,isType=t=>r.leave_type===t,reason=t=>isType(t)?r.reason:'',[d,mo,y]=date3(r.request_date);
  const lastDays=last?(last.leave_days??(Math.round((Date.parse(last.end_date)-Date.parse(last.start_date))/86400000)+1)):'';
  const choices=[[tick(isType('sick'))+' ป่วย','เนื่องจาก',F(reason('sick'))],[tick(isType('personal'))+' กิจส่วนตัว','เนื่องจาก',F(reason('personal'))],
   isType('maternity')?[tick(true)+' คลอดบุตร','เนื่องจาก',F(r.reason)]:[tick(false)+' คลอดบุตร']];
  if(isType('lenient'))choices.push([tick(true)+' อนุโลม','เนื่องจาก',F(r.reason)]);
  if(isType('other'))choices.push([tick(true)+' อื่น ๆ','เนื่องจาก',F(r.reason)]);
  const lastKinds=r.leave_type==='lenient'?[tick(!!last)+' อนุโลม']:[tick(last?.leave_type==='sick')+' ป่วย',tick(last?.leave_type==='personal')+' กิจส่วนตัว',tick(last?.leave_type==='maternity')+' คลอดบุตร',...(last?.leave_type==='other'?[tick(true)+' อื่น ๆ']:[])];
  const body=[
   {indent:72,segs:['ข้าพเจ้า',F(r.full_name,3),'ตำแหน่ง',F(r.position,2)]},
   {segs:['สังกัด  สำนักงานเขตพื้นที่การศึกษาประถมศึกษาเพชรบุรี เขต 2']},
   {choices},
   {segs:['ตั้งแต่วันที่',F(r.start_date?date(r.start_date):'',3),'ถึงวันที่',F(r.end_date?date(r.end_date):'',3),'มีกำหนด',F(r.leave_days,1),'วัน']},
   {segs:['ข้าพเจ้าได้ลา',...lastKinds,'ครั้งสุดท้ายตั้งแต่วันที่',F(last?date(last.start_date):'')]},
   {segs:['ถึงวันที่',F(last?date(last.end_date):'',3),'มีกำหนด',F(lastDays,1),'วัน ในระหว่างลาจะติดต่อข้าพเจ้าได้ที่']},
   {segs:[F(r.contact_address,3),'เบอร์โทรที่สามารถติดต่อได้',F(r.contact_phone,2)]},
   ...(m.substitute?[{segs:['มอบหมายคาบสอนแทนให้แก่',F(r.substitute_teacher)]}]:[]),
   ...(m.note?[{segs:['หมายเหตุ',F(m.note)]}]:[])];
  return {m,date:['วันที่',{v:d,slot:34},'เดือน',{v:mo,slot:90},'พ.ศ.',{v:y,slot:44}],subject:['เรื่อง  ',{v:'ขอลา'+(labels[r.leave_type]||''),slot:230}],body,
   comment:{segs:[F(r.reviewer_comment||'')]},statsTitle:r.leave_type==='lenient'?'สถิติลาอนุโลม (แยกต่างหาก ไม่นับรวมปีงบประมาณ)':'สถิติการลา'};
 }
 function signatureData(r){return {teacher:r.teacher_signature||null,deputy:r.status==='approved'?r.deputy_signature||null:null,approver:r.status==='approved'?r.approver_signature||null:null};}
 function pngBytes(data){return Uint8Array.from(atob(data.split(',')[1]),c=>c.charCodeAt(0));}
 function docxFiles(r){
  const L=layout(r),m=L.m,signatures=signatureData(r),media={},rels=[];
  const rpr=({bold=false,u=false,size=32}={})=>'<w:rPr><w:rFonts w:ascii="TH Sarabun PSK" w:hAnsi="TH Sarabun PSK" w:cs="TH Sarabun PSK"/>'+(bold?'<w:b/><w:bCs/>':'')+(u?'<w:u w:val="dotted"/>':'')+'<w:sz w:val="'+size+'"/><w:szCs w:val="'+size+'"/></w:rPr>';
  const run=(t,o)=>'<w:r>'+rpr(o)+'<w:t xml:space="preserve">'+xml(t)+'</w:t></w:r>';
  const para=(runs,{align='left',after=0,before=0,indent=0}={})=>'<w:p><w:pPr><w:jc w:val="'+align+'"/>'+(indent?'<w:ind w:firstLine="'+Math.round(indent*20)+'"/>':'')+'<w:spacing w:before="'+before+'" w:after="'+after+'" w:line="340" w:lineRule="atLeast"/></w:pPr>'+runs+'</w:p>';
  const p=(t,{bold=false,align='left',after=0,before=0,size=32}={})=>para(run(t,{bold,size}),{align,after,before});
  const segRuns=items=>items.map(x=>typeof x==='string'?{label:x}:x).map((x,i)=>(i?run(' '):'')+(x.label!=null?run(x.label):run(x.pad!=null?padded(x):fixedPad(x),{u:true}))).join('');
  const fixedPad=x=>{const n=Math.max(2,Math.round((x.slot-pt(x.v))/pt(NB))),l=Math.floor(n/2);return NB.repeat(l)+x.v+NB.repeat(n-l)+'\u200b';};
  const line=(spec,width)=>{const hasField=spec.segs.some(x=>typeof x!=='string');return para(segRuns(fit(spec.segs,width-(spec.indent||0))),{align:hasField?'thaiDistribute':'left',indent:spec.indent});};
  function image(key){
   if(!signatures[key])return p('(ลงชื่อ) '+dotted,{align:'center',before:140});
   const bytes=pngBytes(signatures[key]),view=new DataView(bytes.buffer),w=view.getUint32(16),h=view.getUint32(20),scale=Math.min(145/w,38/h),cx=Math.round(w*scale*12700),cy=Math.round(h*scale*12700),id=rels.length+1;
   media['word/media/'+key+'.png']=bytes;rels.push('<Relationship Id="sig'+id+'" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/'+key+'.png"/>');
   return '<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="100" w:after="0"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="'+cx+'" cy="'+cy+'"/><wp:docPr id="'+id+'" name="ลายเซ็น '+key+'"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="'+id+'" name="'+key+'.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="sig'+id+'"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="'+cx+'" cy="'+cy+'"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
  }
  const tc=(body,width,span=1)=>'<w:tc><w:tcPr><w:tcW w:w="'+width+'" w:type="dxa"/>'+(span>1?'<w:gridSpan w:val="'+span+'"/>':'')+'<w:vAlign w:val="center"/></w:tcPr>'+body+'</w:tc>';
  const table=(rows,widths,border=false,margin=80)=>'<w:tbl><w:tblPr><w:tblW w:w="'+widths.reduce((a,b)=>a+b,0)+'" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="20" w:type="dxa"/><w:left w:w="'+margin+'" w:type="dxa"/><w:bottom w:w="20" w:type="dxa"/><w:right w:w="'+margin+'" w:type="dxa"/></w:tblCellMar><w:tblBorders>'+['top','left','bottom','right','insideH','insideV'].map(k=>'<w:'+k+' w:val="'+(border?'single':'nil')+'" w:sz="4" w:color="000000"/>').join('')+'</w:tblBorders></w:tblPr><w:tblGrid>'+widths.map(w=>'<w:gridCol w:w="'+w+'"/>').join('')+'</w:tblGrid>'+rows.map(row=>'<w:tr><w:trPr><w:cantSplit/></w:trPr>'+row.join('')+'</w:tr>').join('')+'</w:tbl>';
  const bodyXml=L.body.map(spec=>{
   if(!spec.choices)return line(spec,WIDTH);
   const inner=WIDTH-65;return table(spec.choices.map((segs,i)=>[tc(p(i===1?'ขอลา':''),1300),tc(line({segs},inner),8338)]),[1300,8338],false,0);
  }).join('');
  const sw=[1059,720,720,720,720,720],stats=table([
   [tc(p('ประเภทลา',{align:'center'}),sw[0]),tc(p('ลามาแล้ว',{align:'center'}),1440,2),tc(p('ลาครั้งนี้',{align:'center'}),720),tc(p('รวมเป็น',{align:'center'}),1440,2)],
   ['','(ครั้ง)','(วัน)','(วัน)','(ครั้ง)','(วัน)'].map((v,i)=>tc(p(v,{align:'center',size:28}),sw[i])),
   ...m.stats.map(row=>row.map((v,i)=>tc(p(v,{align:i?'center':'left',size:28}),sw[i])))],sw,true,60);
  const teacher=p('ขอแสดงความนับถือ',{align:'center',before:160})+image('teacher')+p('('+(r.full_name||dotted)+')',{align:'center'});
  const checker=(signatures.deputy?image('deputy')+p('ผู้ตรวจสอบ',{align:'center'}):p(m.checker[0],{align:'center'}))+m.checker.slice(1).map(t=>p(t,{align:'center'})).join('');
  const decision=p(m.decision,{align:'center',before:60})+p(m.decisionChoice,{align:'center'})+(m.decisionNote?p(m.decisionNote,{align:'center'}):'')+image('approver')+m.director.slice(1).map(t=>p(t,{align:'center'})).join('');
  const body=p(m.title,{bold:true,align:'center',size:36,after:200})
   +table([[tc(p(''),5638),tc(p(m.written[0])+p(m.written[1]),4000)]],[5638,4000],false,0)
   +para(segRuns(L.date),{align:'right',before:120})
   +para(segRuns(L.subject),{before:160})+p(m.to,{after:120})+bodyXml
   +table([[tc(p(''),4819),tc(teacher,4819)]],[4819,4819])
   +table([[tc(p(L.statsTitle,{bold:true})+stats+p('',{size:8}),4819),tc(checker,4819)]],[4819,4819])
   +p(m.opinion,{before:120})+line(L.comment,WIDTH)
   +table([[tc(p(''),4819),tc(decision,4819)]],[4819,4819]);
  const files={'[Content_Types].xml':'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
   '_rels/.rels':'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
   'word/document.xml':'<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>'+body+'<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="850" w:right="1134" w:bottom="680" w:left="1134"/></w:sectPr></w:body></w:document>'};
  if(rels.length){files['word/_rels/document.xml.rels']='<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+rels.join('')+'</Relationships>';Object.assign(files,media);}
  return files;
 }
 function pdfDefinition(r){
  const L=layout(r),m=L.m,signatures=signatureData(r),text=(t,extra={})=>({text:t,...extra}),center=t=>text(t,{alignment:'center'});
  const image=key=>signatures[key]?{image:signatures[key],fit:[145,38],alignment:'center',margin:[0,5,0,2]}:text('(ลงชื่อ) '+dotted,{alignment:'center',margin:[0,15,0,2]});
  const dots={defaultBorder:false,hLineWidth:()=>0.7,hLineStyle:()=>({dash:{length:0.8,space:1.6}}),paddingLeft:()=>1.6,paddingRight:()=>1.6,paddingTop:()=>0,paddingBottom:()=>0};
  const cells=items=>items.map(x=>x.label!=null?{text:x.label,noWrap:true}:{text:x.v||' ',alignment:'center',border:[false,false,false,true]});
  // บรรทัดที่มีช่องข้อมูล: ช่องสุดท้ายยืดชนขอบขวาเสมอ
  function line(spec,width){
   const items=fit(spec.segs,width-(spec.indent||0)),lastField=items.map(x=>x.label==null).lastIndexOf(true);
   if(lastField<0)return text(items.map(x=>x.label).join(' '),{margin:[spec.indent||0,0,0,1]});
   const widths=items.map((x,i)=>x.label!=null?'auto':i===lastField?'*':Math.max(24,x.slot));
   return {table:{widths,body:[cells(items)]},layout:dots,margin:[spec.indent||0,0,0,2]};
  }
  const fixed=segs=>{const items=segs.map(x=>typeof x==='string'?{label:x}:x);return {widths:items.map(x=>x.label!=null?'auto':x.slot),body:[cells(items)]};};
  const date=fixed(L.date),subject=fixed(L.subject);
  const body=L.body.map(spec=>spec.choices?{table:{widths:[55,'*'],body:spec.choices.map((segs,i)=>[text(i===1?'ขอลา':''),line({segs},WIDTH-55)])},layout:'noBorders',margin:[0,0,0,0]}:line(spec,WIDTH));
  const stats={table:{widths:[58,32,32,40,32,32],body:[[{text:'ประเภทลา',rowSpan:2},{text:'ลามาแล้ว',colSpan:2},{},{text:'ลาครั้งนี้'},{text:'รวมเป็น',colSpan:2},{}],['','(ครั้ง)','(วัน)','(วัน)','(ครั้ง)','(วัน)'],...m.stats].map(row=>row.map((c,i)=>typeof c==='string'?text(c,{alignment:i?'center':'left'}):c.text?{alignment:'center',...c}:c))},fontSize:14,layout:{paddingLeft:()=>3,paddingRight:()=>3,paddingTop:()=>1,paddingBottom:()=>1}};
  const checker=[...(signatures.deputy?[image('deputy'),center('ผู้ตรวจสอบ')]:[center(m.checker[0])]),...m.checker.slice(1).map(center)];
  return {pageSize:'A4',pageMargins:[56.7,34,56.7,30],defaultStyle:{font:'Sarabun',fontSize:SIZE,lineHeight:0.92},content:[
   text(m.title,{bold:true,alignment:'center',fontSize:18,margin:[0,0,0,10]}),
   {columns:[{width:'*',text:''},{width:200,stack:m.written.slice(0,2).map(t=>text(t))}]},
   {columns:[{width:'*',text:''},{width:'auto',table:date,layout:dots}],margin:[0,8,0,8]},
   {table:subject,layout:dots},text(m.to,{margin:[0,0,0,8]}),...body,
   {columns:[{width:'*',text:''},{width:'*',stack:[center('ขอแสดงความนับถือ'),image('teacher'),center('('+(r.full_name||dotted)+')')]}],margin:[0,10,0,8]},
   {unbreakable:true,columns:[{width:240,stack:[text(L.statsTitle,{bold:true,margin:[0,0,0,2]}),stats]},{width:'*',stack:checker,margin:[0,22,0,0]}],columnGap:10},
   text(m.opinion,{margin:[0,10,0,0]}),line(L.comment,WIDTH),
   {unbreakable:true,columns:[{width:'*',text:''},{width:'*',stack:[center(m.decision),center(m.decisionChoice),...(m.decisionNote?[center(m.decisionNote)]:[]),image('approver'),...m.director.slice(1).map(center)]}],margin:[0,4,0,0]}
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
