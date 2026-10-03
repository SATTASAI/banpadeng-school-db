import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const context=vm.createContext({});vm.runInContext(fs.readFileSync('public/js/substitute-order-export.js','utf8'),context);const e=context.SubstituteOrderExport;
const rows=[{period:3,grade_level:'ป.4',classroom:'1',subject:'ภาษาไทย & อ่าน',absent_name:'ครู ก',substitute_name:'ครู ข <ทดสอบ>'},{period:1,grade_level:'ป.3',classroom:'2',subject:'วิทยาศาสตร์',absent_name:'ครู ค',substitute_name:'ครู ง'}];
const meta={date:'2026-10-05',issue_date:'2026-10-03',order_number:'123/2569',director_name:'ผู้อำนวยการตัวอย่าง'};
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
