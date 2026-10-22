/* แถบแท็บร่วมของเมนู ฝ่ายงบประมาณ › บันทึกเบิกจ่ายและจัดซื้อจัดจ้าง
   ใช้ในหน้า finance-register, procurement (มุมเจ้าหน้าที่) และทะเบียนเบิกจ่ายแบบลงนามเดิม */
(function(){
  'use strict';
  const TABS=[
    {key:'register',label:'รับคำขอเบิกจ่าย',url:'/finance-register.html'},
    {key:'procurement',label:'งานจัดซื้อจัดจ้าง',url:'/procurement.html'},
    {key:'disbursements',label:'ทะเบียนเบิกจ่าย (แบบลงนามเดิม)',url:'/budget.html?view=disbursements'}
  ];
  function current(){
    const q=new URLSearchParams(location.search);
    if(location.pathname.startsWith('/finance-register'))return 'register';
    if(location.pathname.startsWith('/procurement'))return q.get('mine')==='1'?null:'procurement';
    if(location.pathname.startsWith('/budget')&&q.get('view')==='disbursements')return 'disbursements';
    return null;
  }
  function mount(){
    const active=current();if(!active||document.querySelector('.finance-desk-tabs'))return;
    const css=document.createElement('style');
    css.textContent='.finance-desk-tabs{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 16px;padding:4px;border:1px solid var(--color-border,#d5e2ed);border-radius:14px;background:rgba(255,255,255,.7)}.finance-desk-tabs a{flex:1 1 auto;padding:9px 14px;border-radius:10px;text-align:center;text-decoration:none;color:#245f93;font-size:14px;font-weight:600}.finance-desk-tabs a[aria-current="page"]{background:#245f93;color:#fff}.finance-desk-tabs small{display:block;font-weight:400;font-size:12px;opacity:.85}';
    document.head.append(css);
    const nav=document.createElement('nav');nav.className='finance-desk-tabs';nav.setAttribute('aria-label','บันทึกเบิกจ่ายและจัดซื้อจัดจ้าง');
    for(const tab of TABS){const a=document.createElement('a');a.href=tab.url;a.textContent=tab.label;if(tab.key===active)a.setAttribute('aria-current','page');nav.append(a);}
    const main=document.querySelector('main');if(!main)return;
    const anchor=main.querySelector('.finance-desk-anchor')||main.firstElementChild;
    main.insertBefore(nav,anchor&&anchor.classList?.contains('pc-back')?anchor.nextSibling:anchor);
    // ให้เมนูด้านซ้ายไฮไลต์ "บันทึกเบิกจ่ายและจัดซื้อจัดจ้าง" ทุกแท็บ
    if(window.parent!==window)window.parent.postMessage({type:'budget-navigation',url:'/finance-register.html'},location.origin);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount);else mount();
})();
