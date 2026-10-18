(()=>{'use strict';
 const kindName=kind=>kind==='assistant'?'ครูผู้ช่วย':'PA';
 const number=value=>Number(value||0).toFixed(2);
 const segmenter=typeof Intl.Segmenter==='function'?new Intl.Segmenter('th',{granularity:'word'}):null;
 const thai=value=>{const text=String(value??'');return text.length>60&&segmenter?[...segmenter.segment(text)].map(part=>part.segment).join('\u200b'):text;};
 let loading,fontFiles;
 function loadLibrary(){
  if(window.pdfMake)return Promise.resolve();
  if(!loading)loading=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='/js/pdfmake.min.js';script.onload=resolve;script.onerror=()=>reject(new Error('โหลดเครื่องมือ PDF ไม่สำเร็จ กรุณาลองใหม่'));document.head.append(script);}).catch(e=>{loading=null;throw e;});
  return loading;
 }
 function definition(record){
  const result=record.result;
  if(!result?.members?.length)throw new Error('ยังไม่มีผลสรุปที่สามารถส่งออกได้');
  const content=[
   {text:'โรงเรียนบ้านป่าเด็ง',style:'school'},
   {text:'สรุปผลการประเมิน'+kindName(record.kind),style:'title'},
   {text:record.personal?'ผลการประเมินของกรรมการรายบุคคล':record.published_at?'ผลที่ผู้บริหารยืนยันเผยแพร่แล้ว':'ผลสรุปรอผู้บริหารยืนยัน',style:'status'},
   {text:'ผู้รับการประเมิน: '+thai(record.full_name),margin:[0,12,0,4]},
   {text:thai(record.title)+' · ปีงบประมาณ '+thai(record.fiscal_year)+' · ครั้งที่ '+thai(record.cycle)},
   {text:'เกณฑ์: '+thai(record.template_name),margin:[0,4,0,4]},
   ...(record.reference?[{text:'เอกสารอ้างอิง: '+thai(record.reference),fontSize:10,margin:[0,0,0,8]}]:[]),
   {text:'ผลการประเมิน: '+(result.passed?'ผ่านเกณฑ์':'ไม่ผ่านเกณฑ์'),style:'result'},
   {text:result.mode==='checklist'?'ตัดสินจากจำนวนรายการที่ผ่านตามเกณฑ์รายด้าน คะแนนร้อยละแสดงเพื่อประกอบการอ่าน':result.mode==='each'?'กรรมการแต่ละคนต้องผ่านเกณฑ์ร้อยละ '+result.threshold:'ตัดสินจากคะแนนเฉลี่ยกรรมการ',fontSize:11,margin:[0,4,0,8]},
   {text:'คะแนนเฉลี่ย '+number(result.average)+'%',margin:[0,0,0,10]},
   {table:{headerRows:1,widths:['*',75,55,55],body:[
    ['กรรมการ','คะแนน / เต็ม','ร้อยละ','ผล'],
    ...result.members.map(m=>[thai(m.name),number(m.total)+' / '+thai(m.max),number(m.percent),m.passed?'ผ่าน':'ไม่ผ่าน'])
   ]},layout:'lightHorizontalLines'}
  ];
  for(const member of result.members){if(member.groups?.length)content.push({text:'ผลรายด้าน — '+thai(member.name),bold:true,margin:[0,14,0,6]},{table:{headerRows:1,widths:['*',65,70],body:[['ด้าน','ผ่าน (ข้อ)','ต้องผ่าน (ข้อ)'],...member.groups.map(g=>[thai(g.section),String(g.passed),String(g.required)])]},layout:'lightHorizontalLines'});}
  if(record.rubric?.items&&record.mine?.scores){
   content.push({text:'รายการที่ประเมิน — '+thai(record.mine.name),bold:true,margin:[0,16,0,6]},
    {table:{headerRows:1,widths:['*',75,65],body:[['รายการประเมิน','ผล / คะแนน','คะแนนเต็ม'],...record.rubric.items.map(item=>[thai(item.section)+'\n'+thai(item.id)+' '+thai(item.label),record.mine.scores[item.id]===undefined?'ยังไม่ประเมิน':record.rubric.mode==='checklist'?(record.mine.scores[item.id]===1?'ผ่าน':'ไม่ผ่าน'):String(record.mine.scores[item.id]),String(item.max)])]},layout:'lightHorizontalLines'});
   if(record.mine.comment)content.push({text:'ข้อเสนอแนะ: '+thai(record.mine.comment),margin:[0,12,0,0]});
  }
  if(record.published_at)content.push({text:'ยืนยันเผยแพร่เมื่อ '+thai(record.published_at),fontSize:10,margin:[0,14,0,0]});
  return {pageSize:'A4',pageMargins:[40,40,40,48],defaultStyle:{font:'Sarabun',fontSize:12,lineHeight:1.25},styles:{school:{fontSize:17,bold:true,alignment:'center'},title:{fontSize:18,bold:true,alignment:'center',margin:[0,6,0,6]},status:{fontSize:11,alignment:'center',color:'#526579'},result:{fontSize:16,bold:true,margin:[0,10,0,0]}},content,footer:(page,total)=>({text:'โรงเรียนบ้านป่าเด็ง · หน้า '+page+' / '+total,alignment:'center',font:'Sarabun',fontSize:9,margin:[40,12,40,0]})};
 }
 async function exportPdf(record){
  const doc=definition(record);await loadLibrary();
  if(!fontFiles)fontFiles=Promise.all(['Sarabun-Regular.ttf','Sarabun-Bold.ttf'].map(async name=>{const response=await fetch('/fonts/'+name);if(!response.ok)throw new Error('โหลดฟอนต์ PDF ไม่สำเร็จ');const bytes=new Uint8Array(await response.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));return [name,btoa(binary)];})).then(Object.fromEntries).catch(e=>{fontFiles=null;throw e;});
  const vfs=await fontFiles,fonts={Sarabun:{normal:'Sarabun-Regular.ttf',bold:'Sarabun-Bold.ttf',italics:'Sarabun-Regular.ttf',bolditalics:'Sarabun-Bold.ttf'}};
  const filename=('ผลประเมิน-'+kindName(record.kind)+'-'+thai(record.full_name)+'-'+thai(record.fiscal_year)+'-'+thai(record.cycle)).replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_')+'.pdf';
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('สร้าง PDF ใช้เวลานานเกินไป กรุณาลองใหม่')),30000);try{window.pdfMake.createPdf(doc,undefined,fonts,vfs).getBlob(blob=>{const href=URL.createObjectURL(blob),link=document.createElement('a');link.href=href;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(href),60000);clearTimeout(timer);resolve();});}catch(e){clearTimeout(timer);reject(e);}});
 }
 window.EvaluationReport={exportPdf,definition};
})();
