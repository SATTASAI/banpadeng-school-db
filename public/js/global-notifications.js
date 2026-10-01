/* A single notification bar in the outer workspace, shared by signed-in pages. */
(() => {
 if(window.parent!==window||/\/(login|register|forgot-password|reset-password|pending)\.html$/.test(location.pathname))return;
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function start(){
  if(document.getElementById('schoolNotifications'))return;
  const host=document.querySelector('.topbar-actions,.app-user')||document.querySelector('.app-topbar,.topbar');
  if(!host)return;
  const root=document.createElement('div');root.id='schoolNotifications';root.className='school-notifications';
  root.innerHTML=`<button class="sn-toggle" type="button" aria-label="แจ้งเตือน" aria-expanded="false" aria-controls="schoolNotificationPanel"><span aria-hidden="true">🔔</span><span class="sn-label">แจ้งเตือน</span><strong class="sn-count" hidden>0</strong></button>
   <section id="schoolNotificationPanel" class="sn-panel" hidden aria-label="รายการแจ้งเตือน"><div class="sn-head"><strong>แจ้งเตือน</strong><button type="button" data-read-all>อ่านทั้งหมด</button></div><div class="sn-list"></div><p class="sn-status" role="status" aria-live="polite"></p></section>`;
  host.prepend(root);let busy=false,dirty=false,items=[];const toggle=root.querySelector('.sn-toggle'),panel=root.querySelector('.sn-panel'),badge=root.querySelector('.sn-count'),list=root.querySelector('.sn-list'),status=root.querySelector('.sn-status');
  async function refresh(){if(document.hidden)return;if(busy){dirty=true;return;}busy=true;try{const data=await apiRequest('/api/notifications');items=data.notifications||[];badge.textContent=String(data.unread_count||0);badge.hidden=!data.unread_count;toggle.classList.toggle('has-unread',data.unread_count>0);toggle.setAttribute('aria-label',`แจ้งเตือนที่ยังไม่ได้อ่าน ${data.unread_count||0} ข้อความ`);list.innerHTML=items.length?items.map(n=>`<button type="button" class="sn-item" data-message="${esc(n.message_key)}"><strong>${esc(n.title)}</strong><span>${esc(n.message)}</span><small>${esc(n.created_at)}</small></button>`).join(''):'<p class="sn-empty">ไม่มีข้อความแจ้งเตือนที่ยังไม่ได้อ่าน</p>';status.textContent=data.unread_count>items.length?`แสดง ${items.length} จาก ${data.unread_count} ข้อความ`:'';}catch(e){if(e.status!==401)status.textContent='โหลดแจ้งเตือนไม่สำเร็จ กรุณาลองใหม่';}finally{busy=false;if(dirty){dirty=false;refresh();}}}
  toggle.onclick=()=>{const open=panel.hidden;panel.hidden=!open;toggle.setAttribute('aria-expanded',String(open));if(open)refresh();};
  document.addEventListener('click',e=>{if(!root.contains(e.target)){panel.hidden=true;toggle.setAttribute('aria-expanded','false');}});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!panel.hidden){panel.hidden=true;toggle.setAttribute('aria-expanded','false');toggle.focus();}});
  root.querySelector('[data-read-all]').onclick=async()=>{try{await apiRequest('/api/notifications/read',{method:'POST',body:{all:true}});await refresh();window.ProjectBalance?.refreshInboxes?.();}catch(e){status.textContent=e.message;}};
  list.onclick=async e=>{const key=e.target.closest('[data-message]')?.dataset.message,n=items.find(i=>i.message_key===key);if(!n)return;try{await apiRequest('/api/notifications/read',{method:'POST',body:{message_key:key}});await refresh();panel.hidden=true;toggle.setAttribute('aria-expanded','false');if(typeof window.openNotificationPage==='function')window.openNotificationPage(n.url);else location.href=n.url;}catch(e){status.textContent=e.message;}};
  window.addEventListener('school-data-changed',()=>refresh());window.addEventListener('focus',()=>refresh());document.addEventListener('visibilitychange',()=>refresh());
  window.addEventListener('message',e=>{if(e.origin===location.origin&&e.data?.type==='school-data-changed')refresh();});
  try{const channel=new BroadcastChannel('school-data-changed');channel.onmessage=()=>refresh();}catch{}
  refresh();setInterval(refresh,5000);window.SchoolNotifications={refresh};
 }
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();
})();
