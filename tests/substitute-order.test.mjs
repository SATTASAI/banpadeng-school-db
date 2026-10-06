import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const context=vm.createContext({});vm.runInContext(fs.readFileSync('public/js/substitute-order-export.js','utf8'),context);const e=context.SubstituteOrderExport;
const rows=[{period:3,grade_level:'ป.4',classroom:'1',subject:'ภาษาไทย & อ่าน',absent_name:'ครู ก',substitute_name:'ครู ข <ทดสอบ>'},{period:1,grade_level:'ป.3',classroom:'2',subject:'วิทยาศาสตร์',absent_name:'ครู ค',substitute_name:'ครู ง'}];
const meta={date:'2026-10-05',issue_date:'2026-10-03',order_number:'123/2569',director_name:'ผู้อำนวยการตัวอย่าง',garuda_data_url:'data:image/png;base64,'+fs.readFileSync('public/assets/garuda.png').toString('base64')};
test('substitute orders export the chosen date, sorted assignments and Thai dates in real Word/PDF structures',()=>{
 const order=e.order(rows,meta);assert.equal(order.rows[0][0],'1');assert.match(order.introduction,/2569/);assert.match(order.issued,/3 ตุลาคม/);assert.equal(order.number,'ที่ 123/2569');
 const files=e.docxFiles(rows,meta);assert(files['[Content_Types].xml'].includes('wordprocessingml.document.main+xml'));
 assert.match(files['word/document.xml'],/ภาษาไทย &amp; อ่าน/);assert.match(files['word/document.xml'],/ครู ข &lt;ทดสอบ&gt;/);assert.match(files['word/document.xml'],/w:tblHeader/);assert.match(files['word/document.xml'],/ผู้อำนวยการตัวอย่าง/);
 const pdf=e.pdfDefinition(rows,meta),table=pdf.content.find(x=>x.table).table;assert.equal(pdf.defaultStyle.font,'Sarabun');assert.equal(table.headerRows,1);assert.equal(table.body.length,3);assert.equal(table.body[1][0].text,'1');
 assert.throws(()=>e.order([],meta),/ยังไม่มีรายการ/);
 assert.equal(rows[0].period,3);
});
test('support menu owns leave and substitution, without academic substitution or budget bank entries',()=>{
 const nav=vm.createContext({URL});vm.runInContext(fs.readFileSync('public/js/navigation-catalog.js','utf8'),nav);
 const n=nav.SchoolNavigation,html=fs.readFileSync('public/dashboard.html','utf8');
 assert(!n.groups.academic.some(x=>x.url==='/substitutes.html'));assert(!n.groups.personnel.some(x=>x.url==='/leave.html'));assert(!n.groups.budget.some(x=>x.url==='/school-bank.html'));
 const support=html.split('ระบบสนับสนุน</div>')[1].split('บริหารระบบ</div>')[0];assert(support.includes('data-page="leave"'));assert(support.includes('data-page="substitutes"'));assert(support.includes('class="personnel-only"'));
 assert.equal(n.parentFor('substitutes','/substitutes.html'),'substitutes');assert.equal(n.parentFor('leave','/leave.html'),'leave');
});

test('orders embed the Garuda in Word and PDF and resolve a unique director from current personnel',()=>{
 const files=e.docxFiles(rows,meta);assert.match(files['word/_rels/document.xml.rels'],/Target="media\/garuda.png"/);assert.match(files['word/document.xml'],/r:embed="rIdGaruda"/);
 assert.deepEqual(Buffer.from(files['word/media/garuda.png'].base64,'base64'),fs.readFileSync('public/assets/garuda.png'));
 assert.equal(e.pdfDefinition(rows,meta).content[0].image,meta.garuda_data_url);
 assert.equal(e.director([{full_name:'รอง',position:'รองผู้อำนวยการโรงเรียน'},{full_name:'จิราพร สุขวงศ์',position:'ผู้อำนวยการโรงเรียน'}]),'จิราพร สุขวงศ์');
 assert.throws(()=>e.director([]),/ไม่พบชื่อ/);assert.throws(()=>e.director([{full_name:'ก',position:'ผู้อำนวยการ'},{full_name:'ข',position:'ผู้อำนวยการ'}]),/มากกว่าหนึ่ง/);
 assert.throws(()=>e.docxFiles(rows,{...meta,garuda_data_url:''}),/ตราครุฑ/);
});
test('export refreshes the director from the current roster instead of an editable or stale value',async()=>{
 const html=fs.readFileSync('public/substitutes.html','utf8');assert.match(html,/id="directorName"[^>]*readonly/);
 const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',disabled:false,textContent:'',innerHTML:'',classList:{toggle(){}},style:{}});return nodes.get(id);};
 let staffReads=0,exported;
 const sandbox=vm.createContext({document:{getElementById:node},SubstituteOrderExport:{director:e.director,exportFile:async(format,rows,meta)=>{exported=meta;}},apiRequest:async url=>{
  if(url==='/api/auth/me')return {user:{id:1}};if(url==='/api/substitutes/permissions')return {can_manage:true};
  if(url==='/api/staff')return {staff:[{id:1,full_name:++staffReads===1?'ชื่อเดิม':'ชื่อปัจจุบัน',position:'ผู้อำนวยการโรงเรียน'}]};
  return {assignments:rows};
 }});
 vm.runInContext([...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1],sandbox);
 await new Promise(resolve=>setImmediate(resolve));node('directorName').value='ชื่อที่แก้ในหน้า';
 await node('exportDocx').onclick();assert.equal(staffReads,2);assert.equal(exported.director_name,'ชื่อปัจจุบัน');
});
