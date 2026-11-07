import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
// Install jsdom for local tests, or provide its module URL through JSDOM_MODULE.
const {JSDOM}=await import(process.env.JSDOM_MODULE || 'jsdom');
const dom=new JSDOM('<!doctype html><body><div id="schoolNotifications"><button class="sn-toggle"></button><b class="sn-count">4</b></div></body>',{url:'https://system.test/dashboard.html'});
const w=dom.window,doc=w.document;
Object.defineProperty(doc,'hidden',{configurable:true,writable:true,value:false});
const phone={matches:true,addEventListener(){}};w.matchMedia=()=>phone;
const intervals=[],location={href:'https://system.test/dashboard.html'},requests=[];
let unread=false,error=null,pause=null;
const source=await readFile(new URL('../public/js/mobile-shell.js',import.meta.url),'utf8');
vm.runInNewContext(source,{window:w,document:doc,location,history:{replaceState(){}},navigator:{vibrate(){}},MutationObserver:w.MutationObserver,
  setInterval(fn,ms){intervals.push({fn,ms});return intervals.length;},clearInterval(){},setTimeout(){},
  async apiRequest(path){requests.push(path);if(pause)await pause;if(error)throw error;return {unread};},
});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
await flush();
const bar=doc.querySelector('.mobile-tabbar'),button=bar.querySelector('[data-tab=messages]');
assert.deepEqual([...bar.querySelectorAll('[data-tab]')].map(b=>b.dataset.tab),['home','search','messages','notify','account','menu']);
assert.equal(button.textContent.trim(),'ข้อความ');assert.equal(button.querySelector('.mt-dot'),null);
assert.deepEqual(requests,['/api/push/chat-unread']);
unread=true;w.dispatchEvent(new w.Event('focus'));await flush();assert(button.querySelector('.mt-dot'));assert.match(button.getAttribute('aria-label'),/ยังไม่อ่าน/);
button.click();assert.equal(location.href,'/notify-chat.html');assert(button.querySelector('.mt-dot'),'clicking does not mark the conversation read');
w.dispatchEvent(new w.Event('school-notifications'));assert.equal(bar.querySelector('.mt-badge').textContent,'4');assert(button.querySelector('.mt-dot'),'bell and chat states are independent');
error={status:502};w.dispatchEvent(new w.Event('focus'));await flush();assert(button.querySelector('.mt-dot'),'connection errors preserve the last known badge');
error=null;unread=false;w.dispatchEvent(new w.Event('pageshow'));await flush();assert.equal(button.querySelector('.mt-dot'),null,'returning after chat read clears the badge');assert.equal(bar.querySelector('.mt-badge').textContent,'4');
const poll=intervals.find(x=>x.ms===30000).fn;
let before=requests.length;doc.hidden=true;await poll();assert.equal(requests.length,before);
doc.hidden=false;phone.matches=false;await poll();assert.equal(requests.length,before);
phone.matches=true;let release;pause=new Promise(resolve=>release=resolve);w.dispatchEvent(new w.Event('focus'));w.dispatchEvent(new w.Event('pageshow'));assert.equal(requests.length,before+1,'overlapping refresh events must share the in-flight request');release();await flush();pause=null;
unread=true;await poll();assert(button.querySelector('.mt-dot'));
error={status:401};await poll();assert.equal(button.querySelector('.mt-dot'),null,'a signed-out session cannot retain the previous account badge');
dom.window.close();
console.log('✓ Mobile messages: exact tab position, chat navigation, independent red dot, read return, failures, visibility and overlapping refreshes');
