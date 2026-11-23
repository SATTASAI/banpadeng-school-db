import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const c=vm.createContext({});vm.runInContext(fs.readFileSync('public/js/thai-abbreviations.js','utf8'),c);const A=c.ThaiAbbreviations;
const fix=t=>A.find(t).filter(x=>x.suggestion).reduceRight((v,x)=>A.apply(v,x),t);
test('known Thai abbreviations get full-word suggestions, including attached prefixes and education areas',()=>{
 assert.equal(fix('ไปรพ.แก่งกระจาน'),'ไปโรงพยาบาลแก่งกระจาน');
 assert.equal(fix('ไป ร.พ. ด่วน'),'ไป โรงพยาบาล ด่วน');
 assert.equal(fix('ประชุมที่ สพป.พบ.2 วันที่ 1 ต.ค. 2569'),'ประชุมที่ สำนักงานเขตพื้นที่การศึกษาประถมศึกษาเพชรบุรี เขต 2 วันที่ 1 ตุลาคม 2569');
 assert.equal(fix('ต.ป่าเด็ง อ.แก่งกระจาน จ.เพชรบุรี ม.3'),'ตำบลป่าเด็ง อำเภอแก่งกระจาน จังหวัดเพชรบุรี หมู่ 3');
 assert.equal(fix('ไปร.พ.สต.'),'ไปโรงพยาบาลส่งเสริมสุขภาพตำบล');
});
test('unknown abbreviations are still reported, and normal text, decimals and ฯ pass',()=>{
 const u=A.find('ไปประชุม ศ.ษ.ร.');assert.equal(u.length,1);assert.equal(u[0].suggestion,'');
 for(const t of ['ไปโรงพยาบาล ลา 1.5 วัน','บ้านเลขที่ 12 หมู่ 3','กรุงเทพฯ'])assert.equal(A.find(t).length,0);
});
