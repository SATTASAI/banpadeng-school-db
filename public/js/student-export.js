/* Student roster exports: all matching rows, independent of list pagination. */
(function (root) {
  'use strict';
  const statuses = { enrolled: 'กำลังศึกษาอยู่', transferred: 'ย้ายโรงเรียน', graduated: 'จบการศึกษา', withdrawn: 'ออกกลางคัน' };
  const columns = [['number','ลำดับ'],['student_code','เลขประจำตัว'],['full_name','ชื่อ–นามสกุล'],['gender','เพศ'],['grade_level','ชั้น'],['classroom','ห้อง'],['status','สถานะ']];
  const compare = (a,b) => String(a ?? '').localeCompare(String(b ?? ''),'th',{numeric:true});
  function gender(value) {
    const v=String(value ?? '').trim().toLowerCase();
    if (['ชาย','male','m','เด็กชาย','ช','1'].includes(v)) return 'ชาย';
    if (['หญิง','female','f','เด็กหญิง','ญ','2'].includes(v)) return 'หญิง';
    return v && !['-','–','—'].includes(v) ? 'อื่นๆ' : 'ไม่ระบุ';
  }
  function select(rows,o={}) {
    const q=String(o.query||'').trim().toLowerCase();
    const list=rows.filter(s => (!o.grade||String(s.grade_level||'').trim()===o.grade) && (!o.classroom||String(s.classroom||'').trim()===o.classroom) && (!o.gender||gender(s.gender)===o.gender) && (!o.status||s.status===o.status) && (!q||[s.full_name,s.student_code,s.grade_level,s.classroom].join(' ').toLowerCase().includes(q)));
    const keys={name:['full_name','student_code'],code:['student_code','full_name'],status:['status','full_name'],grade:['grade_level','classroom','full_name']}[o.sort]||['grade_level','classroom','full_name'];
    return list.sort((a,b) => {
      for(const k of keys) { const d=k==='status' ? Object.keys(statuses).indexOf(a[k])-Object.keys(statuses).indexOf(b[k]) : compare(a[k],b[k]); if(d) return o.direction==='desc'?-d:d; }
      return compare(a.id,b.id);
    });
  }
  function groups(rows,key) {
    if(!key) return [['รายชื่อนักเรียน',rows]];
    const map=new Map();
    for(const s of rows) { const name=key==='gender'?gender(s.gender):key==='classroom'?`${s.grade_level||'ไม่ระบุชั้น'} / ${s.classroom||'ไม่ระบุห้อง'}`:String(s[key]||'ไม่ระบุ'); if(!map.has(name)) map.set(name,[]); map.get(name).push(s); }
    return [...map].sort((a,b)=>compare(a[0],b[0]));
  }
  function table(rows,keys) { return [keys.map(k=>columns.find(c=>c[0]===k)[1]),...rows.map((s,i)=>keys.map(k=>k==='number'?String(i+1):k==='gender'?gender(s.gender):k==='status'?(statuses[s.status]||s.status||'ไม่ระบุ'):String(s[k]??'')))]; }
  const xml=v=>String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
  function docxFiles(data,keys) {
    const p=(text,bold=false)=>`<w:p><w:pPr><w:spacing w:after="80"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="TH SarabunPSK" w:hAnsi="TH SarabunPSK" w:cs="TH SarabunPSK"/>${bold?'<w:b/>':''}<w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`;
    let body=p('โรงเรียนบ้านป่าเด็ง — รายชื่อนักเรียน',true);
    for(const [name,rows] of data) { body+=p(`${name} (${rows.length} คน)`,true)+'<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>'+['top','left','bottom','right','insideH','insideV'].map(s=>`<w:${s} w:val="single" w:sz="4" w:color="B8C9D6"/>`).join('')+'</w:tblBorders></w:tblPr><w:tblGrid>'+keys.map(()=>'<w:gridCol w:w="'+Math.floor(14400/keys.length)+'"/>').join('')+'</w:tblGrid>'; table(rows,keys).forEach((r,i)=>{body+='<w:tr>'+(i===0?'<w:trPr><w:tblHeader/></w:trPr>':'')+r.map(t=>'<w:tc><w:tcPr><w:tcW w:w="'+Math.floor(14400/keys.length)+'" w:type="dxa"/></w:tcPr>'+p(t,i===0)+'</w:tc>').join('')+'</w:tr>';}); body+='</w:tbl>'+p(''); }
    return {
      '[Content_Types].xml':'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      '_rels/.rels':'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      'word/document.xml':'<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+body+'<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr></w:body></w:document>'
    };
  }
  function pdfDefinition(data,keys) {
    return {pageSize:'A4',pageOrientation:'landscape',pageMargins:[28,32,28,32],defaultStyle:{font:'Sarabun',fontSize:14},content:[{text:'โรงเรียนบ้านป่าเด็ง — รายชื่อนักเรียน',bold:true,fontSize:20},...data.flatMap(([name,rows])=>[{text:`${name} (${rows.length} คน)`,bold:true,margin:[0,12,0,6]},{table:{headerRows:1,widths:keys.map(k=>k==='full_name'?'*':'auto'),body:table(rows,keys).map((r,i)=>r.map(text=>({text,bold:i===0,fillColor:i===0?'#e2edf4':null})))},layout:'lightHorizontalLines'}])],footer:(page,total)=>({text:`หน้า ${page} / ${total}`,alignment:'center',fontSize:12})};
  }
  const loading=new Map();
  function library(name,url) {
    if(root[name]) return Promise.resolve(root[name]);
    if(!loading.has(name)) loading.set(name,new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=url;s.onload=()=>root[name]?resolve(root[name]):reject(new Error('โหลดเครื่องมือไม่สำเร็จ'));s.onerror=()=>{loading.delete(name);s.remove();reject(new Error('โหลดเครื่องมือส่งออกไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองอีกครั้ง'));};document.head.append(s);}));
    return loading.get(name);
  }
  function download(blob,name) {const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
  async function exportFile(rows,o,keys) {
    const data=groups(rows,o.group),name='students-'+new Date().toISOString().slice(0,10);
    if(o.format==='xlsx') {
      const x=await library('XLSX','https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'),book=x.utils.book_new();
      data.forEach(([label,list],i)=>{const sheet=x.utils.aoa_to_sheet(table(list,keys));sheet['!cols']=keys.map(k=>({wch:k==='full_name'?36:18}));x.utils.book_append_sheet(book,sheet,`${i+1} ${label}`.replace(/[\\/*?:\[\]]/g,' ').slice(0,31));});
      download(new Blob([x.write(book,{type:'array',bookType:'xlsx'})],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}),name+'.xlsx');
    } else if(o.format==='docx') {
      const Zip=await library('JSZip','https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'),zip=new Zip();
      Object.entries(docxFiles(data,keys)).forEach(([path,content])=>zip.file(path,content));
      download(await zip.generateAsync({type:'blob',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}),name+'.docx');
    } else {
      const pdf=await library('pdfMake','https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.12/pdfmake.min.js');
      const fontNames=['THSarabunPSK-Regular.ttf','THSarabunPSK-Bold.ttf'];
      const fontEntries=await Promise.all(fontNames.map(async font=>{const response=await fetch('/fonts/'+font);if(!response.ok)throw new Error('โหลดฟอนต์ภาษาไทยไม่สำเร็จ');const bytes=new Uint8Array(await response.arrayBuffer());let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return [font,btoa(text)];}));
      pdf.vfs=Object.fromEntries(fontEntries);
      pdf.fonts={Sarabun:{normal:fontNames[0],bold:fontNames[1]}};
      const blob=await new Promise((resolve,reject)=>{try{pdf.createPdf(pdfDefinition(data,keys)).getBlob(resolve);}catch(err){reject(err);}});
      download(blob,name+'.pdf');
    }
  }
  function open(rows,defaults={}) {
    const backdrop=document.createElement('div');backdrop.className='modal-backdrop';backdrop.style.display='flex';
    backdrop.innerHTML='<div class="modal" role="dialog" aria-modal="true" aria-labelledby="exportTitle" style="max-width:760px;max-height:90vh;overflow:auto"><h2 id="exportTitle">ดาวน์โหลดข้อมูลนักเรียน</h2><p>เลือกตัวกรองและรูปแบบไฟล์ จะส่งออกทุกคนที่ตรงเงื่อนไข</p><form><div class="student-filter-grid" id="exportFields"></div><fieldset style="margin:16px 0"><legend>ข้อมูลที่ต้องการ</legend><div id="exportColumns" style="display:flex;gap:14px;flex-wrap:wrap"></div></fieldset><p id="exportCount" aria-live="polite"></p><p id="exportError" role="alert" style="color:#b42318"></p><div class="modal-actions"><button type="button" class="btn btn-ghost" id="exportClose">ยกเลิก</button><button type="submit" class="btn btn-primary" id="exportDownload">ดาวน์โหลด</button></div></form></div>';
    const fields=backdrop.querySelector('#exportFields');
    const options=(values)=>values.map(v=>[v,v]);
    const unique=k=>[...new Set(rows.map(s=>String(s[k]||'').trim()).filter(Boolean))].sort(compare);
    const configs=[['query','ค้นหา',null],['grade','ชั้น',[['','ทุกชั้น'],...options(unique('grade_level'))]],['classroom','ห้อง',[['','ทุกห้อง'],...options(unique('classroom'))]],['gender','เพศ',[['','ทุกเพศ'],...options(['ชาย','หญิง','อื่นๆ','ไม่ระบุ'])]],['status','สถานะ',[['','ทุกสถานะ'],...Object.entries(statuses)]],['sort','เรียงตาม',[['grade','ชั้น ห้อง และชื่อ'],['name','ชื่อ'],['code','เลขประจำตัว'],['status','สถานะ']]],['direction','ลำดับ',[['asc','น้อยไปมาก / ก–ฮ'],['desc','มากไปน้อย / ฮ–ก']]],['group','แยกรายการ',[['','รวมรายการ'],['grade_level','แยกชั้น'],['classroom','แยกห้อง'],['gender','แยกเพศ']]],['format','รูปแบบไฟล์',[['xlsx','Excel (.xlsx)'],['docx','Word (.docx)'],['pdf','PDF (.pdf)']]]];
    for(const [key,label,choices] of configs) {const box=document.createElement('div');box.className='filter-field';const l=document.createElement('label');l.textContent=label;l.htmlFor='export-'+key;const input=document.createElement(choices?'select':'input');input.id='export-'+key;input.name=key;input.className='filter-select';if(choices) choices.forEach(([v,t])=>input.add(new Option(t,v)));else input.type='search';if(defaults[key]!=null)input.value=defaults[key];box.append(l,input);fields.append(box);}
    columns.forEach(([key,label])=>{const l=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.name='column';input.value=key;input.checked=true;l.append(input,document.createTextNode(' '+label));backdrop.querySelector('#exportColumns').append(l);});
    const form=backdrop.querySelector('form'),read=()=>Object.fromEntries(new FormData(form)),update=()=>{const count=select(rows,read()).length;backdrop.querySelector('#exportCount').textContent=`พบ ${count} คน • Excel แยกเป็นชีต / Word และ PDF แยกเป็นหัวข้อ`;backdrop.querySelector('#exportDownload').disabled=!count||!form.querySelector('[name=column]:checked');};
    const previous=document.activeElement,close=()=>{backdrop.remove();previous?.focus();};
    backdrop.querySelector('#exportClose').onclick=close;
    backdrop.addEventListener('keydown',e=>{if(e.key==='Escape')close();if(e.key==='Tab'){const controls=[...backdrop.querySelectorAll('input,select,button')].filter(c=>!c.disabled),first=controls[0],last=controls.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}});
    form.addEventListener('input',update);form.addEventListener('change',update);
    form.onsubmit=async e=>{e.preventDefault();const button=backdrop.querySelector('#exportDownload'),error=backdrop.querySelector('#exportError');button.disabled=true;button.textContent='กำลังสร้างไฟล์…';error.textContent='';try{const o=read(),keys=[...form.querySelectorAll('[name=column]:checked')].map(c=>c.value);await exportFile(select(rows,o),o,keys);}catch(err){error.textContent=err.message||'สร้างไฟล์ไม่สำเร็จ กรุณาลองอีกครั้ง';}finally{button.textContent='ดาวน์โหลด';update();}};
    document.body.append(backdrop);update();backdrop.querySelector('input').focus();
  }
  root.StudentExport={open,select,gender,groups,table,docxFiles,pdfDefinition};
})(typeof window==='undefined'?globalThis:window);
