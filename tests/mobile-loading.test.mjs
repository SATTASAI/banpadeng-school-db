import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const apiSource=fs.readFileSync(new URL('../public/js/api.js',import.meta.url),'utf8').split('const ROLE_LABELS')[0];
const tick=()=>new Promise(r=>setImmediate(r));
function client(fetch){
 const timers=new Map(),listeners={},storage=new Map();let id=0,now=10000;
 const window={addEventListener(n,fn){(listeners[n]??=[]).push(fn);},dispatchEvent(e){for(const fn of listeners[e.type]||[])fn(e);}};
 window.parent=window;
 const document={hidden:false,addEventListener:window.addEventListener,activeElement:null};
 const context=vm.createContext({window,document,fetch,AbortController,FormData,CustomEvent,Date:class extends Date{static now(){return now;}},
  sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
  setTimeout(fn,ms){const n=++id;timers.set(n,{fn,ms});return n;},clearTimeout:n=>timers.delete(n)});
 vm.runInContext(apiSource,context);
 return {context,window,document,request:context.apiRequest,timers,
  fire(ms){const entry=[...timers].find(([,v])=>v.ms===ms);assert(entry,`timer ${ms}`);timers.delete(entry[0]);entry[1].fn();},
  advance(ms){now+=ms;},event(type,extra={}){window.dispatchEvent({type,...extra});}};
}
const response=(data,status=200)=>({ok:status<400,status,json:async()=>data});
test('a hung GET is bounded, retried once, and releases every timer',async()=>{
 let calls=0;const c=client(()=>{calls++;return new Promise(()=>{});});
 const p=c.request('/api/overview');const check=assert.rejects(p,e=>e.code==='REQUEST_TIMEOUT');
 c.fire(15000);await tick();assert.equal(calls,2);c.fire(15000);await check;assert.equal(c.timers.size,0);
});
test('the timeout includes an unresponsive response body',async()=>{
 const c=client(async()=>({ok:true,status:200,json:()=>new Promise(()=>{})}));
 const p=c.request('/api/data',{timeoutMs:20});const check=assert.rejects(p,e=>e.code==='REQUEST_TIMEOUT');
 await tick();c.fire(20);await tick();c.fire(20);await check;
});
test('POST requests are never retried and duplicate submissions share one result',async()=>{
 let calls=0;const c=client(()=>{calls++;return new Promise(()=>{});});
 const p=c.request('/api/save',{method:'POST',body:{value:1}});
 assert.equal(c.request('/api/save',{method:'POST',body:{value:1}}),p);
 const check=assert.rejects(p,e=>e.code==='REQUEST_TIMEOUT');c.fire(120000);await check;assert.equal(calls,1);
});
test('external cancellation is preserved and never retried',async()=>{
 let calls=0;const c=client(()=>{calls++;return new Promise(()=>{});}),controller=new AbortController();
 const p=c.request('/api/data',{signal:controller.signal});const check=assert.rejects(p,e=>e.name==='AbortError');
 controller.abort();await check;assert.equal(calls,1);assert.equal(c.timers.size,0);
});
test('resume releases a hung read even when fetch ignores abort, then permits a new read',async()=>{
 let calls=0;const c=client(()=>++calls===1?new Promise(()=>{}):Promise.resolve(response({ready:true})));
 const p=c.request('/api/data');const check=assert.rejects(p,e=>e.code==='APP_RESUMED');
 c.document.hidden=true;c.event('visibilitychange');c.advance(5000);c.document.hidden=false;c.event('visibilitychange');
 await check;c.fire(0);assert.equal((await c.request('/api/data')).ready,true);assert.equal(calls,2);
});
test('resume cancels reads without cancelling a write in progress',async()=>{
 let finish;const c=client(()=>new Promise(r=>finish=r));
 const p=c.request('/api/save',{method:'POST',body:{value:2}});
 c.document.hidden=true;c.event('visibilitychange');c.advance(5000);c.document.hidden=false;c.event('visibilitychange');
 finish(response({saved:true}));assert.equal((await p).saved,true);
});
test('a brief app switch still reconnects and duplicate focus events do not repeat resume',async()=>{
 const c=client(()=>new Promise(()=>{}));let resumed=0;
 c.window.addEventListener('school-app-resume',()=>resumed++);
 c.document.hidden=true;c.event('visibilitychange');c.advance(100);c.document.hidden=false;c.event('visibilitychange');
 c.fire(0);c.event('focus');assert.equal(resumed,1);assert.equal(c.timers.size,0);
 c.document.hidden=true;c.event('visibilitychange');c.advance(100);c.document.hidden=false;c.event('visibilitychange');
 c.fire(0);assert.equal(resumed,2);
});
test('network failures retry reads, but authentication and database quota errors do not',async()=>{
 let calls=0;const c=client(async()=>{if(++calls===1)throw new TypeError('network');return response({ready:true});});
 assert.equal((await c.request('/api/data')).ready,true);assert.equal(calls,2);
 for(const [status,data] of [[401,{error:'login'}],[503,{error:'quota',code:'DATABASE_DAILY_QUOTA_EXCEEDED'}]]){
  let n=0;const d=client(async()=>{n++;return response(data,status);});
  await assert.rejects(d.request('/api/data'),e=>e.status===status);assert.equal(n,1);
 }
});

const server=fs.readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
const serverStart=server.indexOf('async function loadOverviewDetails');
const serverEnd=server.indexOf('\nasync function ',server.indexOf('async function handleOverview')+10);
function overviewServer(overrides={}){
 const calls=[];const statement=sql=>({sql,bind(...values){this.values=values;return this;}});
 const env={DB:{prepare:statement,async batch(queries){calls.push(queries);return queries.map((q,i)=>({results:[0,1,2,3,4,5,6,7].includes(i)?[{count:1}]:[]}));}}};
 const context=vm.createContext({URL,Map,Promise,console,DEPARTMENTS:[],
  getCurrentUser:async()=>({role:'teacher',id:1}),jsonResponse:(data,status=200)=>({data,status}),
  ensurePersonnelData:async()=>{},ensureAcademicData:async()=>{},ensureDashboardRevision:async()=>{},dashboardRevision:async()=>'1:today',
  dashboardActivitySummary:async()=>({leave_summary:{pending:1}}),getCurrentAcademicPeriod:async()=>null,
  projectVisibility:()=>({sql:'1=1',values:[]}),projectFinancialRows:async()=>[],visibleFinancialRows:async(_e,_u,rows)=>rows,
  financialTotals:()=>({}),sumMoney:arr=>arr.reduce((a,b)=>a+b,0),projectFundingSummary:async()=>({}),
  substituteDashboardSummary:async()=>({week_total:3}),attendanceDashboard:async()=>({available:true}),transferSummary:async()=>({total:2}),...overrides});
 vm.runInContext(server.slice(serverStart,serverEnd),context);
 return {calls,load:section=>context.handleOverview({url:'https://school.test/api/overview'+(section?'?section='+section:'')},env)};
}
test('core overview batches 11 queries and returns without waiting for expensive statistics',async()=>{
 const s=overviewServer({attendanceDashboard:()=>assert.fail('core must not read attendance'),substituteDashboardSummary:()=>assert.fail('core must not read substitutes'),transferSummary:()=>assert.fail('core must not read transfers')});
 const r=await s.load('core');assert.equal(r.status,200);assert.equal(r.data.students_enrolled,1);assert.equal(r.data.details_pending,true);
 assert.equal(s.calls.length,1);assert.equal(s.calls[0].length,11);
});
test('details start independent aggregates concurrently without repeating core queries',async()=>{
 const pending=[],started=[];const aggregate=name=>()=>{started.push(name);return new Promise(r=>pending.push(()=>r({name})));};
 const s=overviewServer({attendanceDashboard:aggregate('attendance'),substituteDashboardSummary:aggregate('substitute'),transferSummary:aggregate('transfer')});
 const p=s.load('details');await tick();assert.equal(started.length,3);assert.equal(s.calls.length,0);pending.forEach(f=>f());
 const r=await p;assert.equal(r.data.attendance_summary.name,'attendance');assert.equal(r.data.details_pending,false);
});
test('overview read batches wait for lazy schema initialization to finish',async()=>{
 let ready=false,finish;
 const s=overviewServer({dashboardActivitySummary:()=>new Promise(resolve=>{finish=()=>{ready=true;resolve({leave_summary:{pending:0}});};})});
 const pending=s.load('core');await tick();assert.equal(ready,false);assert.equal(s.calls.length,0);
 finish();const result=await pending;assert.equal(result.status,200);assert.equal(s.calls.length,1);
});
test('legacy full overview retains every section; invalid selectors and unauthenticated users are rejected',async()=>{
 const s=overviewServer();const r=await s.load();assert.equal(r.data.substitute_summary.week_total,3);assert.equal(r.data.student_transfer_summary.total,2);
 assert.equal((await s.load('unknown')).status,400);
 const guest=overviewServer({getCurrentUser:async()=>null});assert.equal((await guest.load('details')).status,401);assert.equal(guest.calls.length,0);
});

const dashboard=fs.readFileSync(new URL('../public/dashboard.html',import.meta.url),'utf8');
test('dashboard displays core before details and can recover after cancellation',async()=>{
 let finishDetails,detailSignal;const rendered=[],elements=new Map();
 const element=id=>{if(!elements.has(id))elements.set(id,{value:'all',style:{},classList:{remove(){},add(){}},addEventListener(){}});return elements.get(id);};
 const context=vm.createContext({AbortController,Date,console,document:{hidden:false,getElementById:element,addEventListener(){}},
  window:{addEventListener(){},location:{replace(){assert.fail('unexpected login');}}},setInterval(){},setTimeout,
  dashboardUser:{id:1},renderOverviewData:data=>rendered.push(data),resumedReadError:()=>Object.assign(Error('resume'),{name:'AbortError'}),
  apiRequest:async(path,options)=>{if(path.includes('section=core'))return {data_revision:'1',students_enrolled:9};detailSignal=options.signal;return new Promise((r,j)=>{finishDetails=r;options.signal.addEventListener('abort',()=>j(options.signal.reason));});}});
 const start=dashboard.indexOf('  let overviewController'),end=dashboard.indexOf('  let bootstrapInFlight');
 vm.runInContext(dashboard.slice(start,end),context);
 const first=context.loadOverview();await tick();assert.equal(rendered.length,1);assert.equal(rendered[0].students_enrolled,9);
 detailSignal.throwIfAborted();vm.runInContext('overviewController.abort(resumedReadError())',context);await first;
 assert.equal(element('refreshOverviewBtn').disabled,false);
 const second=context.loadOverview();await tick();finishDetails({attendance_summary:{available:true}});await second;
 assert.equal(rendered.at(-1).attendance_summary.available,true);
});
test('all dashboard inline scripts compile',()=>{
 for(const match of dashboard.matchAll(/<script>([\s\S]*?)<\/script>/g))new vm.Script(match[1]);
});
