import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {DatabaseSync} from 'node:sqlite';
import {WORK_SCOPES,workScopeCondition,workScopeSummary} from '../src/lib/work-scopes.js';
const ctx=vm.createContext({URL});vm.runInContext(fs.readFileSync('public/js/navigation-catalog.js','utf8'),ctx);const n=ctx.SchoolNavigation;
const plain=value=>JSON.parse(JSON.stringify(value));
test('menu destinations are unique, concise, and implemented; budget tabs remain distinct',()=>{
 const html=fs.readFileSync('public/dashboard.html','utf8'),parents=[...html.matchAll(/<a\b[^>]*data-page="([^"]+)"/g)].map(m=>m[1]),urls=parents.map(k=>n.routes[k]);
 for(const [key,links] of Object.entries(n.groups)) {assert(parents.includes(key),key);urls.push(...links.map(i=>i.url));}
 const signature=url=>{const u=new URL(url,'https://school.test');u.searchParams.sort();return u.origin+u.pathname+'?'+u.searchParams;};
 assert.equal(new Set(urls.map(signature)).size,urls.length,'duplicate destinations');
 for(const url of urls){const u=new URL(url,'https://school.test');if(u.origin==='https://school.test'){assert(fs.existsSync('public'+u.pathname),url);assert(!u.searchParams.has('section'),url);assert.notEqual(u.pathname,'/modules.html');}}
 const segmenter=new Intl.Segmenter('th',{granularity:'grapheme'});
 for(const label of [...Object.values(n.labels),...Object.values(n.groups).flatMap(links=>links.map(i=>i.label))])assert([...segmenter.segment(label)].length<=24,label);
 const views=n.groups.budget.filter(i=>i.url.startsWith('/budget.html')).map(i=>new URL(i.url,'https://school.test').searchParams.get('view'));
 for(const view of views)assert(fs.readFileSync('public/budget.html','utf8').includes(`data-view="${view}"`),view);
 assert(views.includes('requests')&&views.includes('disbursements')&&views.includes('plans')&&views.includes('otherProjects'));
});
test('legacy links reach canonical pages and keep requested records and department directories',()=>{
 assert.equal(n.canonicalUrl('/modules.html?module=students'),'/students.html');
 for(const dept of ['academic','budget','personnel','general','early_childhood','administration'])assert.equal(n.routes[dept],'/department-staff.html?dept='+dept);
 const url=new URL(n.canonicalUrl('/work-center.html?area=staff&topic=8&record=42'),'https://school.test');assert.equal(url.searchParams.get('record'),'42');assert.equal(url.searchParams.get('scope'),'personnel-development');assert.equal(n.parentFor('staff',url.href),'personnel');assert.equal(n.destinationKey(url.href),n.destinationKey(n.scopeUrl('personnel-development')));
 assert.equal(n.parentFor('project-documents','/project-documents.html?project=12'),'documents');assert.equal(n.parentFor('departments','/department.html?dept=academic&project=4'),'academic');assert.equal(n.parentFor('maintenance','/maintenance?request=4'),'general');assert.equal(n.workScopeFor('academic','8'),null);assert.equal(n.workScopeFor('staff','0'),null);
 for(const [key,s] of Object.entries(n.workScopes))assert.deepEqual(plain(s.contexts),WORK_SCOPES[key]);
});
test('merged work scopes include legacy records once and exclude unrelated topics',()=>{
 const db=new DatabaseSync(':memory:');db.exec(`CREATE TABLE work_records(id INTEGER,area TEXT,topic_key TEXT,status TEXT);
 INSERT INTO work_records VALUES(1,'staff','4','completed'),(2,'staff','8','planned'),(3,'personnel','6','planned'),(4,'personnel','7','completed'),(5,'academic','4','planned'),(6,'staff','3','planned'),(7,'personnel','1','planned');`);
 const development=workScopeCondition('personnel-development'),duties=workScopeCondition('personnel-duties');
 assert.deepEqual(db.prepare('SELECT id FROM work_records w WHERE '+development.sql+' ORDER BY id').all(...development.binds).map(r=>r.id),[1,2,3,4]);
 assert.deepEqual(db.prepare('SELECT id FROM work_records w WHERE '+duties.sql+' ORDER BY id').all(...duties.binds).map(r=>r.id),[6,7]);
 const summary=workScopeSummary(db.prepare("SELECT area,topic_key,COUNT(*) total_count,SUM(status='completed') completed_count,0 overdue_count FROM work_records GROUP BY area,topic_key").all());assert.deepEqual(summary['personnel-development'],{total:4,completed:2,overdue:0});
 assert.equal(workScopeCondition("x' OR 1=1"),null);db.close();
});

test('merged work API preserves filters, summaries, and record permissions',async()=>{
 const db=new DatabaseSync(':memory:');db.exec(`
 CREATE TABLE work_records(id INTEGER,area TEXT,topic_key TEXT,topic_label TEXT,title TEXT,description TEXT,notes TEXT,status TEXT,priority TEXT,due_date TEXT,updated_at TEXT,created_by INTEGER,responsible_user_id INTEGER,academic_year_id INTEGER,academic_term_id INTEGER);
 CREATE TABLE users(id INTEGER,full_name TEXT);CREATE TABLE academic_years(id INTEGER,year_be INTEGER);CREATE TABLE academic_terms(id INTEGER,name TEXT);CREATE TABLE file_attachments(id INTEGER,entity_type TEXT,entity_id INTEGER,file_name TEXT);
 INSERT INTO work_records VALUES(1,'staff','8','อบรม','Legacy training','','','planned','normal',NULL,'2026-10-01',1,1,1,1),
 (2,'personnel','6','พัฒนา','New training','','','completed','normal',NULL,'2026-10-01',2,2,1,1),
 (3,'academic','8','ตาราง','Unrelated','','','planned','normal',NULL,'2026-10-01',1,1,1,1);`);
 const source=fs.readFileSync('src/index.js','utf8'),a=source.indexOf('async function handleListWorkRecords('),b=source.indexOf('async function handleGetWorkRecord',a);
 let user={id:1,role:'teacher'};
 const context=vm.createContext({URL,workScopeCondition,getCurrentUser:async()=>user,jsonResponse:(body,status=200)=>({body,status}),cleanText:(v)=>String(v??'').trim(),WORK_RECORD_AREAS:new Set(['staff','personnel','academic']),WORK_RECORD_STATUSES:['planned','in_progress','waiting','completed','cancelled'],getCurrentAcademicPeriod:async()=>null,isAdmin:()=>false,canManageWorkRecord:(u,r)=>u.id===r.created_by});vm.runInContext(source.slice(a,b),context);
 const env={DB:{prepare(sql){let args=[];return {bind(...values){args=values;return this;},async all(){return {results:db.prepare(sql).all(...args)};},async first(){return db.prepare(sql).get(...args);}};}}};
 const call=query=>context.handleListWorkRecords({url:'https://school.test/api/work-records?area=personnel&topic=6,7&scope=personnel-development'+query},env);
 const all=await call('');assert.equal(all.status,200);assert.equal(all.body.records.length,2);assert.equal(all.body.summary.total,2);assert.equal(all.body.records.find(r=>r.id===1).can_manage,true);assert.equal(all.body.records.find(r=>r.id===2).can_manage,false);
 const planned=await call('&status=planned&academic_year_id=1');assert.equal(planned.body.records.length,1);assert.equal(planned.body.records[0].area,'staff');assert.equal(planned.body.summary.total,2);
 const found=await call('&q=Legacy');assert.equal(found.body.records.length,1);assert.equal(found.body.summary.total,1);
 user=null;assert.equal((await call('')).status,401);user={id:1,role:'teacher'};assert.equal((await context.handleListWorkRecords({url:'https://school.test/api/work-records?scope=invalid'},env)).status,400);db.close();
});

test('budget uses one sidebar navigation in the workspace and synchronizes the selected view',()=>{
 const html=fs.readFileSync('public/budget.html','utf8');
 assert(!html.includes('<nav class="tabs">'));
 assert(html.includes('.embedded .budget-page-picker{display:none}'));
 assert.equal(n.groups.budget.find(item=>item.url==='/budget.html?view=roles').adminOnly,true);
 assert(n.groups.budget.some(item=>item.url==='/budget.html?view=audit'));
 const nodes=new Map();
 const ids=['requests','disbursements','plans','otherProjects','incomeView','reports','audit','roles'];
 for(const id of [...ids,'budgetViewSelect','financeAlertCount']){
   const classes=new Set();nodes.set(id,{value:'',textContent:'',classList:{add:c=>classes.add(c),remove:c=>classes.delete(c),contains:c=>classes.has(c)}});
 }
 const messages=[],history=[];
 const context=vm.createContext({URL,location:new URL('https://school.test/budget.html?view=plans&project=42'),history:{replaceState(_a,_b,url){history.push(url)}},
  window:{parent:{postMessage(data,origin){messages.push({data,origin})}}},
  document:{querySelectorAll:()=>ids.map(id=>nodes.get(id))},$:id=>nodes.get(id)});
 const start=html.indexOf("const BUDGET_VIEWS="),end=html.indexOf('\n(async()=>',start);
 vm.runInContext(html.slice(start,end),context);
 for(const view of ['requests','disbursements','plans','otherProjects','income','reports','audit','roles']){
   context.switchBudgetView(view);
   assert.equal(ids.filter(id=>nodes.get(id).classList.contains('active')).length,1);
   assert(nodes.get(view==='income'?'incomeView':view).classList.contains('active'));
   assert.equal(nodes.get('budgetViewSelect').value,view);
   assert.equal(new URL(history.at(-1),'https://school.test').searchParams.get('view'),view);
   assert.equal(new URL(history.at(-1),'https://school.test').searchParams.get('project'),'42');
   assert.equal(messages.at(-1).data.view,view);assert.equal(messages.at(-1).origin,'https://school.test');
 }
 context.switchBudgetView('invalid');assert(nodes.get('otherProjects').classList.contains('active'));
 context.setFinanceAlertCount(3);assert.equal(nodes.get('financeAlertCount').textContent,'(3)');assert.equal(messages.at(-1).data.pendingCount,3);
});
