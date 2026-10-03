import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const ctx=vm.createContext({});vm.runInContext(fs.readFileSync('public/js/student-export.js','utf8'),ctx);const e=ctx.StudentExport;
const rows=[{id:1,student_code:'0012',full_name:'เด็กหญิง ก & ข',gender:'female',grade_level:'ป.2',classroom:'2',status:'enrolled'},{id:2,student_code:'0002',full_name:'เด็กชาย ค',gender:'ชาย',grade_level:'ป.10',classroom:'10',status:'enrolled'},{id:3,student_code:'=1+1',full_name:'ทดสอบ',gender:null,grade_level:'ป.2',classroom:'2',status:'graduated'}];
test('export filters gender grade status and natural sorts without mutating roster',()=>{
 assert.equal(e.select(rows,{gender:'หญิง',grade:'ป.2',status:'enrolled'})[0].id,1);
 assert.equal(e.select(rows,{gender:'ไม่ระบุ'})[0].id,3);
 assert.equal(e.select(rows.filter(s=>s.id!==3),{sort:'code'})[0].id,2);
 assert.equal(e.select(rows,{sort:'grade',direction:'desc'})[0].id,2);
 assert.equal(rows[0].id,1);
 assert.equal(e.select(Array.from({length:105},()=>rows[0]),{}).length,105);
});
test('exports preserve codes as text and split complete roster into groups',()=>{
 const groups=e.groups(rows,'grade_level');assert.equal(groups.length,2);assert.equal(groups[0][1].length,2);
 const table=e.table(rows,['student_code','gender']);assert.equal(table[1][0],'0012');assert.equal(table[3][0],'=1+1');assert.equal(table[1][1],'หญิง');
});
test('Word escapes XML and PDF repeats table headers with Thai font',()=>{
 const data=e.groups(rows,''),files=e.docxFiles(data,['full_name','student_code']);assert.match(files['word/document.xml'],/ก &amp; ข/);assert.match(files['word/document.xml'],/w:tblHeader/);assert.equal(Object.keys(files).length,3);
 const pdf=e.pdfDefinition(data,['full_name','student_code']);assert.equal(pdf.defaultStyle.font,'Sarabun');assert.equal(pdf.content[2].table.headerRows,1);assert.equal(pdf.content[2].table.body.length,4);
});
