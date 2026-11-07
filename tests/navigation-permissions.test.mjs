import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../public/js/navigation-permissions.js',import.meta.url),'utf8');
function setup(apiRequest) {
 const notices=[],events={};
 const context=vm.createContext({apiRequest,AbortController,
  setTimeout(fn,ms){if(ms<12000)queueMicrotask(fn);return 1;},clearTimeout(){},
  document:{createElement(){return {style:{},setAttribute(){},append(...children){this.children=children;}};},querySelector(){return {prepend(n){notices.push(n);}};}},
  window:{addEventListener(name,fn){events[name]=fn;}}
 });
 vm.runInContext(source,context);
 return {load:context.window.loadNavigationPermission,notices,events};
}
test('a transient permissions failure restores supervision menus without a page reload',async()=>{
 let calls=0;
 const p=setup(async()=>{if(++calls===1)throw Object.assign(Error('unavailable'),{status:503});return {evaluate:true,view_all:false};});
 const link={dataset:{supervisionOnly:'evaluate|view_all'},style:{},hidden:true};
 // Run the actual dashboard callback so this verifies menu restoration, not only retries.
 const html=fs.readFileSync(new URL('../public/dashboard.html',import.meta.url),'utf8');
 const line=html.split('\n').find(l=>l.includes("loadNavigationPermission('/api/supervision/permissions'"));
 await vm.runInNewContext(line,{loadNavigationPermission:p.load,document:{querySelectorAll:()=>[link]}});
 assert.equal(calls,2);assert.equal(link.hidden,false);assert.equal(link.style.display,'');assert.equal(p.notices.length,0);
});
test('persistent failure offers a retry, keeps other menu permissions working, and clears the notice on recovery',async()=>{
 let offline=true,calls=0,applied=0;
 const p=setup(async path=>{if(path==='supervision'){calls++;if(offline)throw TypeError('offline');}return {view_all:true};});
 await p.load('supervision',()=>applied++);
 assert.equal(calls,3);assert.equal(applied,0);assert.equal(p.notices[0].hidden,false);
 await p.load('other',()=>applied++);assert.equal(applied,1);assert.equal(p.notices[0].hidden,false);
 offline=false;
 await p.notices[0].children[1].onclick();
 // The click handler starts the async work without waiting for it.
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(applied,2);assert.equal(p.notices[0].hidden,true);
});
test('online recovery retries failed permissions without granting access on a denied response',async()=>{
 let denied=true,calls=0,applied=0;
 const p=setup(async()=>{calls++;if(denied)throw Object.assign(Error('denied'),{status:403});return {view_all:false};});
 await p.load('permissions',data=>{applied++;assert.equal(data.view_all,false);});
 assert.equal(calls,1);assert.equal(applied,0);
 denied=false;p.events.online();p.events.online();
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(calls,2);assert.equal(applied,1);assert.equal(p.notices[0].hidden,true);
});
test('database daily quota errors do not cause repeated requests',async()=>{
 let calls=0;const p=setup(async()=>{calls++;throw Object.assign(Error('quota'),{status:503,data:{code:'DATABASE_DAILY_QUOTA_EXCEEDED'}});});
 await p.load('permissions',()=>assert.fail('must not apply failed permissions'));
 assert.equal(calls,1);assert.equal(p.notices[0].hidden,false);
});
test('dashboard scripts compile and all permission-gated menu groups use the resilient loader',()=>{
 const html=fs.readFileSync(new URL('../public/dashboard.html',import.meta.url),'utf8');
 for(const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g))new vm.Script(match[1]);
 assert(html.indexOf('/js/navigation-permissions.js')<html.indexOf("loadNavigationPermission('/api/supervision/permissions'"));
 for(const path of ['supervision/permissions','timetable/permissions','lesson-plans/permissions','teaching-works/permissions','evaluation/permissions','navigation/departments','substitutes/permissions'])assert(html.includes(`loadNavigationPermission('/api/${path}'`));
});
