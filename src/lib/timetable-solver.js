// Pure, bounded constraint search. No persistence and no partial success on failure.
const key = (a) => JSON.stringify([a.grade_level,a.classroom]);
const slot = (a) => JSON.stringify([a.grade_level,a.classroom,a.weekday,a.period]);
const resource = (id,d,p) => JSON.stringify([id,d,p]);
export function solveTimetable(input, {maxNodes=40000, maxMs=150}={}) {
  const errors=[], assignments=input.assignments||[], classes=input.classes||[];
  const periods=input.periods_per_day||[6,5,5,5,5];
  if(!Array.isArray(periods)||periods.length!==5||periods.some(n=>!Number.isInteger(n)||n<1||n>6))return {ok:false,errors:['จำนวนคาบรายวิชาต่อวันต้องอยู่ระหว่าง 1–6']};
  if(!classes.length||classes.length>60||assignments.length>1000)return {ok:false,errors:['เลือกห้องเรียน 1–60 ห้องและภาระสอนไม่เกิน 1,000 รายการ']};
  const selected=new Set(classes.map(key));
  if(selected.size!==classes.length)return {ok:false,errors:['ห้องเรียนซ้ำ']};
  const groups=new Map(), usedClass=new Set(),usedTeacher=new Set(),usedRoom=new Set(), daily=new Map(), blocked=new Set();
  for(const a of assignments){
    const k=JSON.stringify([a.grade_level,a.classroom,a.subject,a.teacher_id]);
    if(!selected.has(key(a))||!a.subject?.trim()||a.subject.length>120||!Number.isSafeInteger(a.teacher_id)||a.teacher_id<1||!Number.isInteger(a.periods_per_week)||a.periods_per_week<1||a.periods_per_week>30||!Number.isInteger(a.max_per_day)||a.max_per_day<1||a.max_per_day>6||typeof (a.room_name||'')!=='string'||(a.room_name||'').length>100){errors.push('ภาระสอนไม่ถูกต้อง');continue;}
    if(groups.has(k)){errors.push('ภาระสอนครู–วิชา–ห้องซ้ำ');continue;}
    if(a.periods_per_week>periods.reduce((n,p)=>n+Math.min(p,a.max_per_day),0))errors.push(`${a.grade_level}/${a.classroom} ${a.subject}: จำนวนคาบเกินข้อจำกัดต่อวัน`);
    groups.set(k,{...a,k,remaining:a.periods_per_week});
  }
  for(const c of classes){const total=assignments.filter(a=>key(a)===key(c)).reduce((n,a)=>n+a.periods_per_week,0);if(total>periods.reduce((n,p)=>n+p,0))errors.push(`${c.grade_level}/${c.classroom}: ภาระสอนเกินช่องรายวิชา`);}
  if(!groups.size)errors.push('เพิ่มภาระสอนก่อนจัดตาราง');
  for(const b of input.unavailable||[]){if(!Number.isSafeInteger(b.teacher_id)||b.teacher_id<1||!Number.isInteger(b.weekday)||b.weekday<1||b.weekday>5||!Number.isInteger(b.period)||b.period<1||b.period>6)errors.push('คาบไม่ว่างของครูไม่ถูกต้อง');else blocked.add(resource(b.teacher_id,b.weekday,b.period));}
  const locked=[], generated=[];
  function occupy(e,add){for(const [set,k] of [[usedClass,slot(e)],[usedTeacher,resource(e.teacher_id,e.weekday,e.period)],...(e.room_name?[[usedRoom,resource(e.room_name,e.weekday,e.period)]]:[])])add?set.add(k):set.delete(k);}
  for(const e of input.existing||[]){
    if(selected.has(key(e))&&!input.keep_existing&&e.period<=periods[e.weekday-1])continue;
    if(usedClass.has(slot(e))||usedTeacher.has(resource(e.teacher_id,e.weekday,e.period))||(e.room_name&&usedRoom.has(resource(e.room_name,e.weekday,e.period)))){errors.push('คาบเดิมมีครู ห้องเรียน หรือห้องสอนชนกัน');continue;}
    occupy(e,true);
    if(!selected.has(key(e)))continue;
    locked.push(e);
    // Reserved learner-development periods remain locked but do not count toward subject loads.
    if(e.period>periods[e.weekday-1])continue;
    const g=groups.get(JSON.stringify([e.grade_level,e.classroom,e.subject,e.teacher_id]));
    if(!g||(g.room_name||'')!==(e.room_name||'')){errors.push(`คาบที่ล็อกไม่ตรงภาระสอน: ${e.subject}`);continue;}
    if(blocked.has(resource(e.teacher_id,e.weekday,e.period)))errors.push(`คาบที่ล็อกตรงกับเวลาครูไม่ว่าง: ${e.subject}`);
    g.remaining--;const dk=JSON.stringify([g.grade_level,g.classroom,g.subject,e.weekday]);daily.set(dk,(daily.get(dk)||0)+1);
    if(g.remaining<0||daily.get(dk)>g.max_per_day)errors.push(`คาบที่ล็อกเกินภาระสอนหรือเพดานต่อวัน: ${e.subject}`);
  }
  if(errors.length)return {ok:false,errors:[...new Set(errors)]};
  const options=g=>{const out=[];for(let d=1;d<=5;d++){const dk=JSON.stringify([g.grade_level,g.classroom,g.subject,d]),count=daily.get(dk)||0;if(count>=g.max_per_day)continue;for(let p=1;p<=periods[d-1];p++){const e={grade_level:g.grade_level,classroom:g.classroom,subject:g.subject,teacher_id:g.teacher_id,room_name:g.room_name||'',weekday:d,period:p};if(!usedClass.has(slot(e))&&!usedTeacher.has(resource(g.teacher_id,d,p))&&!blocked.has(resource(g.teacher_id,d,p))&&(!g.room_name||!usedRoom.has(resource(g.room_name,d,p))))out.push({e,dk,score:count*100+p});}}return out.sort((a,b)=>a.score-b.score);};
  let nodes=0,timedOut=false;const start=Date.now();
  function search(){if(++nodes>maxNodes||Date.now()-start>maxMs){timedOut=true;return false;}let chosen,choices;
    for(const g of groups.values()){if(!g.remaining)continue;const opts=options(g);if(opts.length<g.remaining)return false;if(!choices||opts.length<choices.length){chosen=g;choices=opts;}}
    if(!chosen)return true;
    for(const {e,dk} of choices){occupy(e,true);chosen.remaining--;daily.set(dk,(daily.get(dk)||0)+1);generated.push(e);if(search())return true;generated.pop();daily.set(dk,daily.get(dk)-1);chosen.remaining++;occupy(e,false);if(timedOut)return false;}return false;
  }
  if(!search())return {ok:false,errors:[timedOut?'ค้นหาไม่ทันในรอบนี้ ลองลดจำนวนห้องหรือผ่อนข้อจำกัด ยังสรุปไม่ได้ว่าไม่มีคำตอบ':'จัดไม่ได้ภายใต้เงื่อนไขนี้ ตรวจคาบที่ล็อก เวลาครูไม่ว่าง และภาระสอน'],nodes};
  const entries=[...locked,...generated];
  const summary=classes.map(c=>({...c,required:assignments.filter(a=>key(a)===key(c)).reduce((n,a)=>n+a.periods_per_week,0),unfilled:periods.reduce((n,p)=>n+p,0)-entries.filter(e=>key(e)===key(c)&&e.period<=periods[e.weekday-1]).length}));
  return {ok:true,entries,summary,nodes,generated:generated.length};
}
