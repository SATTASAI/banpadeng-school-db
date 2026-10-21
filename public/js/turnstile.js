/* Cloudflare Turnstile (กันบอท) สำหรับหน้าเข้าสู่ระบบ สมัครสมาชิก และลืมรหัสผ่าน
   วาง <div data-turnstile></div> ในฟอร์ม แล้วโหลดสคริปต์นี้ก่อน api.js ของ Cloudflare
   ส่ง SchoolTurnstile.token() ไปกับคำขอเป็น turnstile_token และเรียก reset() เมื่อส่งไม่สำเร็จ */
(function(){
 'use strict';
 var SITE_KEY='0x4AAAAAAFepUtQ437_xQJCH',widgets=[];
 window.onSchoolTurnstile=function(){
  document.querySelectorAll('[data-turnstile]').forEach(function(el){
   try{widgets.push(window.turnstile.render(el,{sitekey:SITE_KEY,language:'th',theme:'light',size:'flexible','refresh-expired':'auto'}));}
   catch(e){el.textContent='โหลดระบบตรวจสอบบอทไม่สำเร็จ กรุณารีเฟรชหน้า';}
  });
 };
 window.SchoolTurnstile={
  token:function(){try{return widgets.length?window.turnstile.getResponse(widgets[0])||'':'';}catch(e){return '';}},
  reset:function(){try{widgets.forEach(function(id){window.turnstile.reset(id);});}catch(e){}}
 };
})();
