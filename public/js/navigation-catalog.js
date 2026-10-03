/* Canonical menu destinations. Legacy module pages use these same routes. */
(function(root){
 'use strict';
 const labels={overview:'ภาพรวม',students:'นักเรียน',staff:'บุคลากร','academic-periods':'ปีการศึกษา',academic:'ฝ่ายวิชาการ',early_childhood:'ฝ่ายปฐมวัย',budget:'ฝ่ายงบประมาณ',personnel:'ฝ่ายบุคคล',general:'ฝ่ายทั่วไป',administration:'ฝ่ายบริหาร',maintenance:'อาคารและแจ้งซ่อม','student-support':'ดูแลนักเรียน',documents:'เอกสาร',reports:'รายงาน',users:'ผู้ใช้และสิทธิ์',security:'สำรองและตรวจสอบ','system-status':'สถานะระบบ','line-settings':'ตั้งค่า LINE','admin-cleanup':'ล้างข้อมูลทดสอบ',tasks:'งานมอบหมาย',leave:'การลา'};
 const directory=dept=>'/department-staff.html?dept='+dept;
 const routes={students:'/students.html',staff:'/staff.html','academic-periods':'/academic-years.html',academic:directory('academic'),early_childhood:directory('early_childhood'),budget:directory('budget'),personnel:directory('personnel'),general:directory('general'),administration:directory('administration'),maintenance:'/maintenance.html','student-support':'/support.html',documents:'/documents.html',reports:'/reports.html',users:'/admin-users.html',security:'/security.html','system-status':'/system-status.html','line-settings':'/line-settings.html','admin-cleanup':'/admin-cleanup.html',tasks:'/tasks.html',leave:'/leave.html'};
 const workScopes={
  'personnel-duties':{label:'คำสั่งและเวร',area:'personnel',topic:'1,3',contexts:{personnel:['1','3'],staff:['3','5']}},
  'personnel-development':{label:'พัฒนาและผลงาน',area:'personnel',topic:'6,7',contexts:{personnel:['6','7'],staff:['4','7','8']}}
 };
 const scopeUrl=key=>{const s=workScopes[key];return `/work-center.html?area=${s.area}&topic=${s.topic}&scope=${key}`;};
 function workScopeFor(area,topics){const keys=String(topics||'').split(',').filter(Boolean);if(!keys.length)return null;return Object.entries(workScopes).find(([,s])=>s.contexts[area]&&keys.every(k=>s.contexts[area].includes(k)))?.[0]||null;}
 const item=(label,url)=>({label,url});
 const groups={
  students:[item('วิเคราะห์ผู้เรียน','/learner-analysis.html')],
  academic:[item('หลักสูตรและแผนสอน','/work-center.html?area=academic&topic=0,2'),item('โครงการ','/department.html?dept=academic'),item('จัดตารางสอน','/timetable.html'),item('ครูสอนแทน','/substitutes.html'),item('บันทึกงานตาราง','/work-center.html?area=academic&topic=3,8,9,10,11,12,13,14,15'),item('สอบและวัดผล','/work-center.html?area=academic&topic=4,6'),item('นิเทศและคุณภาพ','/work-center.html?area=academic&topic=7'),{label:'Q-Info',url:'https://qinfo.co/',external:true},{label:'ภาพรวม Q-Info',url:'https://qinfo.co/dashboard/index.html?information',external:true}],
  early_childhood:[item('โครงการ','/department.html?dept=early_childhood'),item('หลักสูตรและแผน','/work-center.html?area=early_childhood&topic=0,1'),item('พัฒนาการเด็ก','/work-center.html?area=early_childhood&topic=2'),item('กิจกรรมอนุบาล','/work-center.html?area=early_childhood&topic=3'),item('สื่อและสุขภาวะ','/work-center.html?area=early_childhood&topic=4,5'),item('ผู้ปกครองและคุณภาพ','/work-center.html?area=early_childhood&topic=6,7')],
  budget:[item('คำขอใช้งบ','/budget.html?view=requests'),item('เบิกจ่าย','/budget.html?view=disbursements'),item('โครงการในฝ่าย','/budget.html?view=plans'),item('โครงการฝ่ายอื่น','/budget.html?view=otherProjects'),item('แหล่งเงินและรายรับ','/budget.html?view=income'),item('รายงานการเงิน','/budget.html?view=reports'),item('พัสดุและครุภัณฑ์','/inventory.html'),item('ธนาคารโรงเรียน','/school-bank.html')],
  personnel:[item('ภาพรวมงานบุคคล','/personnel.html'),item('โครงการ','/department.html?dept=personnel'),item('คำสั่งและเวร',scopeUrl('personnel-duties')),item('การลา','/leave.html'),item('งานมอบหมาย','/tasks.html'),item('ประเมิน PA','/work-center.html?area=personnel&topic=5'),item('พัฒนาและผลงาน',scopeUrl('personnel-development'))],
  general:[item('โครงการ','/department.html?dept=general'),item('สารบรรณ','/correspondence.html'),item('อาคารและแจ้งซ่อม','/maintenance.html'),item('ยานพาหนะ','/work-center.html?area=general&topic=5'),item('ประชาสัมพันธ์','/work-center.html?area=general&topic=6,7')],
  documents:[item('เอกสารเบิกจ่าย','/project-documents.html'),item('นำเข้าข้อมูล','/import-center.html')]
 };
 const parents={maintenance:'general',tasks:'personnel',leave:'personnel'};
 function canonicalUrl(url){const u=new URL(url,'https://school.invalid');if(u.pathname==='/modules.html'||u.pathname==='/modules'){const route=routes[u.searchParams.get('module')];if(route)return route;}if(u.pathname==='/work-center.html'){const scope=workScopeFor(u.searchParams.get('area'),u.searchParams.get('topic'));if(scope){const target=new URL(scopeUrl(scope),'https://school.invalid');for(const [key,value] of u.searchParams)if(!target.searchParams.has(key))target.searchParams.set(key,value);return target.pathname+'?'+target.searchParams.toString()+u.hash;}}return url;}
 function parentFor(key,url){
  const u=new URL(url||routes[key]||'/','https://school.invalid'),path=u.pathname.replace(/\.html$/,'');
  if(path==='/department'||path==='/department-staff'){const dept=u.searchParams.get('dept');if(routes[dept])return dept;}
  if(path==='/work-center'){if(workScopeFor(u.searchParams.get('area'),u.searchParams.get('topic')))return 'personnel';const area=u.searchParams.get('area');if(routes[area])return area;}
  const owners={'/maintenance':'general','/tasks':'personnel','/leave':'personnel','/project-documents':'documents','/import-center':'documents','/inventory':'budget','/school-bank':'budget','/budget':'budget','/correspondence':'general','/timetable':'academic','/substitutes':'academic','/learner-analysis':'students','/personnel':'personnel'};
  if(owners[path])return owners[path];
  return Object.entries(routes).find(([,route])=>new URL(route,'https://school.invalid').pathname.replace(/\.html$/,'')===path)?.[0]||parents[key]||key;
 }
 function destinationKey(url){const u=new URL(canonicalUrl(url),'https://school.invalid');u.searchParams.delete('record');u.searchParams.sort();return u.origin+u.pathname+'?'+u.searchParams;}
 root.SchoolNavigation={labels,routes,groups,parents,workScopes,workScopeFor,scopeUrl,canonicalUrl,parentFor,destinationKey};
})(typeof window==='undefined'?globalThis:window);
