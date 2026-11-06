/* จุดแดงงานค้าง: ลิงก์/การ์ด/แท็บในหน้าใดที่ชี้ไปยังงานที่ยังค้าง จะมีจุดแดงมุมขวาบน
   จุดแดงค้างจนงานเสร็จ (ข้อมูลจาก /api/pending-work) · เมนูด้านข้างของแดชบอร์ดวาดแยกใน dashboard.html
   ระบุเองได้ด้วย data-pending-url="/path?x=y" หรือ data-pending-key="leave" */
(function(){
 'use strict';
 if(window.SchoolPending)return;
 const KEY='school-pending-work',TTL=30000,listeners=new Set();
 let items=[],inflight=null;
 function cached(){try{const c=JSON.parse(sessionStorage.getItem(KEY)||'null');if(c&&Date.now()-c.at<TTL)return c.items;}catch{}return null;}
 async function load(force){
  const c=!force&&cached();if(c){items=c;return items;}
  if(!inflight)inflight=fetch('/api/pending-work',{credentials:'same-origin',cache:'no-store'})
   .then(r=>r.ok?r.json():{items:[]}).then(d=>{items=Array.isArray(d.items)?d.items:[];try{sessionStorage.setItem(KEY,JSON.stringify({at:Date.now(),items}));}catch{}return items;})
   .catch(()=>items).finally(()=>{inflight=null;});
  return inflight;
 }
 const parse=url=>{try{return new URL(url,location.origin);}catch{return null;}};
 const norm=p=>p.replace(/\/index\.html$/,'/').replace(/\.html$/,'');
 // ลิงก์ตรงกับงาน: path เดียวกัน และมีพารามิเตอร์ครบตามที่งานกำหนด
 function matches(url,item){
  const a=parse(url),b=parse(item.url);if(!a||!b||a.origin!==location.origin)return false;
  if(norm(a.pathname)!==norm(b.pathname))return false;
  for(const [k,v] of b.searchParams)if(a.searchParams.get(k)!==v)return false;
  return true;
 }
 function countFor(el){
  const key=el.dataset.pendingKey;
  if(key)return key.split(',').reduce((n,k)=>n+items.filter(i=>i.key===k.trim()).reduce((s,i)=>s+i.count,0),0);
  const url=el.dataset.pendingUrl||el.getAttribute('href')||el.dataset.url;
  if(!url||url.startsWith('#')||url.startsWith('javascript:'))return 0;
  return items.filter(i=>matches(url,i)).reduce((s,i)=>s+i.count,0);
 }
 function paint(){
  const hosts=document.querySelectorAll('a[href],[data-url],[data-pending-url],[data-pending-key]');
  hosts.forEach(el=>{
   if(el.closest('.sidebar,#schoolNotifications,.mobile-tabbar,[data-no-pending-dot]'))return;
   const n=countFor(el),dot=el.querySelector(':scope > .pending-dot');
   if(n>0){
    if(!dot){if(getComputedStyle(el).position==='static')el.style.position='relative';const d=document.createElement('span');d.className='pending-dot';d.setAttribute('aria-hidden','true');el.appendChild(d);}
    el.classList.add('has-pending-work');el.title=el.title||('มีงานค้าง '+n+' รายการ');
   }else if(dot){dot.remove();el.classList.remove('has-pending-work');}
  });
  listeners.forEach(fn=>{try{fn(items);}catch{}});
  window.dispatchEvent(new CustomEvent('school-pending',{detail:items}));
 }
 let timer=null;
 function schedule(){clearTimeout(timer);timer=setTimeout(paint,120);}
 async function refresh(force){await load(force);paint();}
 window.SchoolPending={refresh,items:()=>items,matches,onChange(fn){listeners.add(fn);fn(items);return()=>listeners.delete(fn);}};
 function start(){
  const style=document.createElement('style');
  style.textContent='.pending-dot{position:absolute;top:6px;right:6px;width:10px;height:10px;border-radius:50%;background:#e5383b;box-shadow:0 0 0 2px #fff;pointer-events:none;z-index:2;animation:pendingPing 1.8s ease-out infinite}@keyframes pendingPing{0%{box-shadow:0 0 0 2px #fff,0 0 0 2px rgba(229,56,59,.45)}100%{box-shadow:0 0 0 2px #fff,0 0 0 9px rgba(229,56,59,0)}}@media(prefers-reduced-motion:reduce){.pending-dot{animation:none}}';
  document.head.appendChild(style);
  refresh(false);
  new MutationObserver(muts=>{if(muts.some(m=>[...m.addedNodes].some(n=>n.nodeType===1&&!n.classList?.contains('pending-dot'))))schedule();}).observe(document.body,{childList:true,subtree:true});
  setInterval(()=>refresh(true),60000);
  // ข้อมูลเปลี่ยน (อนุมัติ/บันทึก) ในหน้านี้ หน้าลูกใน iframe หรือแท็บอื่น → โหลดงานค้างใหม่
  let soon=null;const changed=()=>{clearTimeout(soon);soon=setTimeout(()=>refresh(true),600);};
  window.addEventListener('school-data-changed',changed);
  window.addEventListener('message',e=>{if(e.origin===location.origin&&e.data?.type==='school-data-changed')changed();});
  try{const ch=new BroadcastChannel('school-data-changed');ch.onmessage=changed;}catch{}
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh(true);});
 }
 if(document.body)start();else document.addEventListener('DOMContentLoaded',start);
})();
