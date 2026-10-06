/* XLSX row mapping is independent of the workbook library and never writes records. */
(function(root){
 const clean=v=>String(v??'').normalize('NFC').trim().replace(/\s+/g,' ');
 const grade=v=>clean(v).replace(/\s|\./g,'');
 const person=v=>clean(v).replace(/^(นางสาว|นาง|นาย|ครู)\s*/,'');
 const fields={grade_level:['ชั้น','ระดับชั้น','grade_level'],classroom:['ห้อง','ห้องเรียน','ชั้น/ห้อง','classroom'],subject:['วิชา','รายวิชา','subject'],teacher:['ครูผู้สอน','ชื่อครู','ครู','teacher_name'],teacher_id:['รหัสครู','teacher_id'],periods_per_week:['คาบ/สัปดาห์','จำนวนคาบต่อสัปดาห์','จำนวนคาบ','periods_per_week'],max_per_day:['สูงสุด/วัน','สูงสุดต่อวัน','max_per_day'],block_size:['คาบต่อเนื่อง','block_size'],room_name:['ห้องสอนเฉพาะ','room_name']};
 const headers=['ชั้น','ห้อง','วิชา','ครูผู้สอน','คาบ/สัปดาห์','สูงสุด/วัน','ห้องสอนเฉพาะ','คาบต่อเนื่อง'];
 function parseRows(rows,setup){
  if(!Array.isArray(rows)||rows.length<2)throw Error('ไฟล์ไม่มีแถวภาระสอน');
  if(rows.length>1001)throw Error('รองรับภาระสอนไม่เกิน 1,000 แถว');
  const header=rows[0].map(clean),column={};for(const [name,aliases] of Object.entries(fields)){const matches=header.map((v,i)=>aliases.includes(v)?i:-1).filter(i=>i>=0);if(matches.length>1)throw Error(`หัวคอลัมน์ ${name} ซ้ำ`);column[name]=matches[0]??-1;}
  for(const name of ['classroom','subject','periods_per_week'])if(column[name]<0)throw Error('หัวคอลัมน์ไม่ตรงแม่แบบ ดาวน์โหลดแม่แบบ Excel แล้วแยกหนึ่งแถวต่อครู–วิชา–ห้อง');
  if(column.teacher<0&&column.teacher_id<0)throw Error('ต้องมีคอลัมน์ครูผู้สอนหรือรหัสครู');
  const assignments=[],errors=[],seen=new Set(),selected=new Map();
  rows.slice(1).forEach((row,i)=>{
   if(!row.some(v=>clean(v)))return;
   try{
    if(row.some(v=>typeof v==='object'&&v!==null))throw Error('รูปแบบเซลล์ไม่ถูกต้อง');
    const get=k=>column[k]<0?'':clean(row[column[k]]);let g=get('grade_level'),room=get('classroom');
    if(room.includes('/')){const n=room.lastIndexOf('/'),inferred=room.slice(0,n);if(g&&grade(g)!==grade(inferred))throw Error('ชั้นกับห้องไม่ตรงกัน');g=g||inferred;room=room.slice(n+1);}
    const classes=setup.classes.filter(c=>grade(c.grade_level)===grade(g)&&(clean(c.classroom)===room||clean(c.classroom)===`${g}/${room}`));
    if(classes.length!==1)throw Error(`ไม่พบห้อง ${g}/${room} ในภาคเรียนนี้`);
    const teacherId=get('teacher_id'),name=get('teacher');let teachers;
    if(teacherId){const id=Number(teacherId);if(!Number.isSafeInteger(id)||id<1)throw Error('รหัสครูไม่ถูกต้อง');teachers=setup.teachers.filter(t=>t.id===id);if(name&&teachers.length===1&&person(teachers[0].full_name)!==person(name))throw Error('ชื่อครูไม่ตรงกับรหัสครู');}
    else{teachers=setup.teachers.filter(t=>person(t.full_name)===person(name));if(!teachers.length&&name&&!person(name).includes(' '))teachers=setup.teachers.filter(t=>person(t.full_name).split(' ')[0]===person(name));}
    if(teachers.length!==1)throw Error(teachers.length?'ชื่อครูซ้ำ กรุณาระบุชื่อ–นามสกุลหรือรหัสครู':`ไม่พบครู ${name||teacherId} ในทะเบียน`);
    const subject=get('subject'),weekly=Number(get('periods_per_week')),daily=get('max_per_day')?Number(get('max_per_day')):Math.ceil(weekly/5),roomName=get('room_name');
    if(!subject||subject.length>120||/[=\n]/.test(subject))throw Error('แยกวิชาละหนึ่งแถว และชื่อวิชาไม่เกิน 120 ตัวอักษร');
    if(!Number.isInteger(weekly)||weekly<1||weekly>30)throw Error('คาบ/สัปดาห์ต้องเป็นจำนวนเต็ม 1–30');
    if(!Number.isInteger(daily)||daily<1||daily>6)throw Error('สูงสุด/วันต้องเป็นจำนวนเต็ม 1–6');
    if(roomName.length>100)throw Error('ชื่อห้องสอนเฉพาะยาวเกินกำหนด');
    const block=Number(get('block_size')||1);if(!Number.isInteger(block)||block<1||block>3||weekly%block||daily<block)throw Error('คาบต่อเนื่องต้องเป็น 1–3 หารคาบ/สัปดาห์ลงตัว และไม่เกินสูงสุด/วัน');
    const c=classes[0],a={grade_level:c.grade_level,classroom:c.classroom,subject,teacher_id:teachers[0].id,periods_per_week:weekly,max_per_day:daily,room_name:roomName,block_size:block},k=JSON.stringify([a.grade_level,a.classroom,a.subject,a.teacher_id]);
    if(seen.has(k))throw Error('ภาระสอนครู–วิชา–ห้องซ้ำ');seen.add(k);selected.set(JSON.stringify([c.grade_level,c.classroom]),{grade_level:c.grade_level,classroom:c.classroom});assignments.push(a);
   }catch(e){errors.push(`แถว ${i+2}: ${e.message}`);}
  });
  if(errors.length)throw Error(errors.slice(0,20).join('\n')+(errors.length>20?`\nและอีก ${errors.length-20} แถว`:''));
  if(!assignments.length)throw Error('ไม่มีภาระสอนในไฟล์');
  return {classes:[...selected.values()],assignments};
 }
 function parseFixedRows(rows,setup){
  if(!rows||rows.length<2)return [];
  const h=rows[0].map(clean),day=h.indexOf('วัน'),period=h.indexOf('คาบ');
  if(day<0||period<0)throw Error('ชีตคาบล็อกต้องมีคอลัมน์ วัน และ คาบ');
  const seen=new Set(),days=['จันทร์','อังคาร','พุธ','พฤหัสบดี','ศุกร์'];
  return rows.slice(1).filter(r=>r.some(v=>clean(v))).map((r,i)=>{
    const a=parseRows([[...rows[0],'คาบ/สัปดาห์','สูงสุด/วัน'],[...r,1,1]],setup).assignments[0];
    const value=clean(r[day]).replace(/^วัน/,'');const d=days.includes(value)?days.indexOf(value)+1:Number(value),p=Number(r[period]);
    if(!Number.isInteger(d)||d<1||d>5||!Number.isInteger(p)||p<1||p>6)throw Error(`คาบล็อกแถว ${i+2}: วันหรือคาบไม่ถูกต้อง`);
    const k=JSON.stringify([a.grade_level,a.classroom,d,p]);if(seen.has(k))throw Error(`คาบล็อกแถว ${i+2}: ห้อง–วัน–คาบซ้ำ ต้องตรวจฉบับแก้ไขหรือการสอนร่วมก่อน`);seen.add(k);
    return {grade_level:a.grade_level,classroom:a.classroom,subject:a.subject,teacher_id:a.teacher_id,room_name:a.room_name,weekday:d,period:p};
  });
 }
 root.TimetableWorkbook={headers,parseRows,parseFixedRows};
})(typeof window==='undefined'?globalThis:window);
