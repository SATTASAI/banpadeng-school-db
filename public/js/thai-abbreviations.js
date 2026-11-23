// ตรวจตัวย่อภาษาไทยในข้อความที่ลงใบลา และเสนอคำเต็มสำหรับตัวย่อที่ระบบรู้จัก
(function(global){
 'use strict';
 const words={
  'รพ':'โรงพยาบาล','รพสต':'โรงพยาบาลส่งเสริมสุขภาพตำบล','รพช':'โรงพยาบาลชุมชน','รร':'โรงเรียน','ผอ':'ผู้อำนวยการ','กคศ':'คณะกรรมการข้าราชการครูและบุคลากรทางการศึกษา',
  'สพป':'สำนักงานเขตพื้นที่การศึกษาประถมศึกษา','สพม':'สำนักงานเขตพื้นที่การศึกษามัธยมศึกษา','สพฐ':'สำนักงานคณะกรรมการการศึกษาขั้นพื้นฐาน',
  'ศธ':'กระทรวงศึกษาธิการ','สนง':'สำนักงาน','สสจ':'สำนักงานสาธารณสุขจังหวัด','สสอ':'สำนักงานสาธารณสุขอำเภอ',
  'อบต':'องค์การบริหารส่วนตำบล','อบจ':'องค์การบริหารส่วนจังหวัด','กทม':'กรุงเทพมหานคร','ธกส':'ธนาคารเพื่อการเกษตรและสหกรณ์การเกษตร',
  'จนท':'เจ้าหน้าที่','นร':'นักเรียน','ปชส':'ประชาสัมพันธ์','พศ':'พุทธศักราช','คศ':'คริสต์ศักราช',
  'ต':'ตำบล','อ':'อำเภอ','จ':'จังหวัด','ม':'หมู่','ถ':'ถนน','ซ':'ซอย',
  'มค':'มกราคม','กพ':'กุมภาพันธ์','มีค':'มีนาคม','เมย':'เมษายน','พค':'พฤษภาคม','มิย':'มิถุนายน',
  'กค':'กรกฎาคม','สค':'สิงหาคม','กย':'กันยายน','ตค':'ตุลาคม','พย':'พฤศจิกายน','ธค':'ธันวาคม'
 };
 const provinces={'พบ':'เพชรบุรี','รบ':'ราชบุรี','ปข':'ประจวบคีรีขันธ์','กจ':'กาญจนบุรี','สพ':'สุพรรณบุรี','นฐ':'นครปฐม','สค':'สมุทรสาคร','สส':'สมุทรสงคราม','กท':'กรุงเทพมหานคร'};
 const pattern=/[ก-๙]+\.(?:[ก-๙]+\.)*/g;
 const expand=(key,after)=>{
  const area=key.match(/^(สพป|สพม)(.+)$/);
  if(area&&provinces[area[2]]){const n=after.match(/^\s*(\d+)/);return {text:words[area[1]]+provinces[area[2]]+(n?' เขต '+n[1]:''),eat:n?n[0].length:0};}
  if(!words[key])return null;
  return {text:words[key]+(/^\d/.test(after)?' ':''),eat:0};
 };
 // คืนรายการตัวย่อที่พบ: {abbr, index, length, suggestion} — ตัดคำนำหน้าที่ติดอยู่ เช่น "ไปรพ." → แนะนำ "โรงพยาบาล" แทน "รพ."
 function find(value){
  const text=String(value||''),out=[];
  for(const m of text.matchAll(pattern)){
   const token=m[0],parts=token.split('.').filter(Boolean),after=text.slice(m.index+token.length);
   let hit=null;
   for(let i=0;i<parts[0].length&&!hit;i++){
    const key=[parts[0].slice(i),...parts.slice(1)].join('');
    const e=expand(key,after);
    if(e)hit={start:m.index+i,abbr:token.slice(i)+after.slice(0,e.eat),suggestion:e.text};
   }
   out.push(hit?{abbr:hit.abbr,index:hit.start,length:hit.abbr.length,suggestion:hit.suggestion}:{abbr:token.length>10?'…'+token.slice(-10):token,index:m.index,length:token.length,suggestion:''});
  }
  return out;
 }
 // แทนตัวย่อหนึ่งตำแหน่งด้วยคำเต็ม
 function apply(value,item){const t=String(value||'');return t.slice(0,item.index)+item.suggestion+t.slice(item.index+item.length);}
 global.ThaiAbbreviations={find,apply};
})(typeof window!=='undefined'?window:globalThis);
