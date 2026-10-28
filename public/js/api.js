// ทำให้หน้าที่เปิดอยู่ภายในพื้นที่ทำงานซ้อนใช้ layout แบบกะทัดรัด
if (window.parent !== window) {
  document.documentElement.classList.add("embedded");

  // ลิงก์กลับแดชบอร์ดจากทุกระดับ iframe ต้องสั่งหน้าต่างบนสุดเสมอ
  // ป้องกัน dashboard.html ถูกโหลดซ้อนอยู่ภายในพื้นที่ทำงาน
  document.addEventListener("click", (event) => {
    const link = event.target.closest?.("a[href]");
    if (!link) return;
    let targetUrl;
    try {
      targetUrl = new URL(link.getAttribute("href"), window.location.href);
    } catch {
      return;
    }
    if (targetUrl.origin !== window.location.origin || targetUrl.pathname !== "/dashboard.html") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      if (typeof window.top.showOverview === "function") {
        window.top.showOverview();
      } else {
        window.top.location.href = "/dashboard.html";
      }
    } catch {
      window.location.href = "/dashboard.html";
    }
  }, true);
}

const DATABASE_QUOTA_KEY="school-database-quota";
function storedDatabaseQuota(){try{const q=JSON.parse(sessionStorage.getItem(DATABASE_QUOTA_KEY)||"null");if(q&&Date.parse(q.reset_at)>Date.now())return q;sessionStorage.removeItem(DATABASE_QUOTA_KEY);}catch{}return null;}
function setDatabaseQuota(data){try{if(data)sessionStorage.setItem(DATABASE_QUOTA_KEY,JSON.stringify(data));else sessionStorage.removeItem(DATABASE_QUOTA_KEY);}catch{}window.dispatchEvent(new CustomEvent("database-quota-changed",{detail:data}));}
// กันกดส่งซ้ำฝั่งเบราว์เซอร์: คำขอบันทึกที่เหมือนกันทุกประการขณะคำขอแรกยังไม่เสร็จ จะใช้ผลลัพธ์เดียวกัน
// (ไม่ยิงซ้ำไปเซิร์ฟเวอร์) และปิดปุ่มที่ถูกกดไว้จนกว่าจะบันทึกเสร็จ — เซิร์ฟเวอร์มีตัวกันซ้ำอีกชั้นหนึ่ง
const pendingWrites=new Map();
function apiRequest(path, options = {}) {
  const method=String(options.method||"GET").toUpperCase();
  if(["GET","HEAD","OPTIONS"].includes(method)||path.startsWith("/api/auth/"))return apiRequestNow(path,options);
  const body=options.body==null?"":typeof FormData!=="undefined"&&options.body instanceof FormData?null:typeof options.body==="string"?options.body:JSON.stringify(options.body);
  const key=body===null?null:`${method} ${path} ${body}`;
  if(key&&pendingWrites.has(key))return pendingWrites.get(key);
  const active=typeof document!=="undefined"?document.activeElement:null,button=active&&active.matches?.('button,input[type="submit"]')&&!active.disabled?active:null;
  if(button){button.disabled=true;button.setAttribute("aria-busy","true");}
  const promise=apiRequestNow(path,options).finally(()=>{if(key)pendingWrites.delete(key);if(button){button.disabled=false;button.removeAttribute("aria-busy");}});
  if(key)pendingWrites.set(key,promise);
  return promise;
}
async function apiRequestNow(path, options = {}) {
  const quota=storedDatabaseQuota();
  const retryAllowed=["/api/auth/login","/api/auth/me","/api/auth/logout"].includes(path);
  if(quota&&!retryAllowed){const error=new Error(quota.error);error.status=503;error.data=quota;throw error;}

  const isFormData = typeof FormData !== "undefined" && options.body instanceof FormData;
  const headers = isFormData ? {} : { "Content-Type": "application/json" };
  const requestBody = options.body == null
    ? undefined
    : isFormData || typeof options.body === "string"
      ? options.body
      : JSON.stringify(options.body);
  const res = await fetch(path, {
    method: options.method || "GET",
    headers: {...headers,...(options.headers||{})},
    body: requestBody,
    credentials: "same-origin",
    signal: options.signal,
    cache: "no-store",
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    // ไม่มี body หรือไม่ใช่ JSON
  }

  if (!res.ok) {
    if(data?.code==="DATABASE_DAILY_QUOTA_EXCEEDED")setDatabaseQuota(data);
    const message = (data && data.error) || "เกิดข้อผิดพลาด กรุณาลองใหม่";
    const error = new Error(message);
    error.status = res.status;
    error.data = data;
    throw error;
  }
  if(path==="/api/auth/login"||(path==="/api/auth/me"&&data?.user))setDatabaseQuota(null);
  if (!["GET","HEAD","OPTIONS"].includes(String(options.method || "GET").toUpperCase()) && !path.startsWith("/api/auth/")) {
    window.dispatchEvent(new CustomEvent("school-data-changed"));
    if (window.parent !== window) window.parent.postMessage({type:"school-data-changed"},window.location.origin);
    try { if (typeof BroadcastChannel !== "undefined") { const channel=new BroadcastChannel("school-data-changed");channel.postMessage({type:"school-data-changed"});channel.close(); } } catch {}
  }
  return data;
}

const ROLE_LABELS = {
  teacher: "ครู",
  executive: "ผู้บริหาร",
  staff: "เจ้าหน้าที่ธุรการ",
  superadmin: "ผู้ดูแลระบบ",
  viewer: "ผู้ชมภายนอก (ดูอย่างเดียว)",
};

// Shared notification bar uses the same authenticated API as the current page.
(() => { const css=document.createElement('link');css.rel='stylesheet';css.href='/css/global-notifications.css';document.head.append(css);
 const script=document.createElement('script');script.src='/js/global-notifications.js';document.head.append(script); })();

// Admin-only test cleanup controls across the workspace.
(() => {const css=document.createElement("link");css.rel="stylesheet";css.href="/css/admin-cleanup.css";document.head.append(css);const script=document.createElement("script");script.src="/js/admin-cleanup.js";document.head.append(script);})();

// Portrait phone layout shared by standalone pages and iframe modules.
(() => {const css=document.createElement("link");css.rel="stylesheet";css.href="/css/mobile.css";document.head.append(css);})();

// ปีงบประมาณเริ่มต้นของหน้าโครงการ/เบิกจ่าย/จัดซื้อ: ผูกกับปีการศึกษาปัจจุบัน
// (ปฏิทินงบประมาณขึ้นปีใหม่ 1 ต.ค. กลางภาคเรียนที่ 2 แต่โครงการของปีการศึกษายังต้องใช้ต่อจนจบปี)
function calendarFiscalYear(){const d=new Date(Date.now()+7*3600e3);return d.getUTCFullYear()+(d.getUTCMonth()>=9?544:543);}
let workingFiscalYearPromise=null;
function workingFiscalYear(){
  workingFiscalYearPromise=workingFiscalYearPromise||apiRequestNow("/api/projects/working-year").then(r=>Number(r?.fiscal_year)||calendarFiscalYear()).catch(()=>{workingFiscalYearPromise=null;return calendarFiscalYear();});
  return workingFiscalYearPromise;
}

// โหมดมุมมองบุคคลอื่น (ผู้ดูแลระบบใช้ทดสอบการมองเห็น): แถบแจ้งเตือนบนหน้าต่างหลัก
(() => {const script=document.createElement("script");script.src="/js/view-as.js";document.head.append(script);})();

// ชื่อคนในตารางอยู่บรรทัดเดียว (มือถือ: ตารางเลื่อนซ้ายขวาแทนการตัดชื่อเป็นหลายบรรทัด)
// หาข้อความในช่องตารางที่ขึ้นต้นด้วยคำนำหน้าชื่อ แล้วห่อด้วย span.nm (white-space: nowrap) — ใช้กับทุกหน้าโดยไม่ต้องแก้ทีละตาราง
(() => {
  if (typeof document === "undefined" || typeof document.addEventListener !== "function" || typeof MutationObserver === "undefined") return;
  const PREFIX = /^\s*(นางสาว|นาง|นาย|เด็กชาย|เด็กหญิง|ด\.ช\.|ด\.ญ\.|ว่าที่|ดร\.|ผศ\.|รศ\.|ครู)/;
  const mark = (root) => {
    if (!root.querySelectorAll) return;
    const cells = root.matches?.("td") ? [root] : root.querySelectorAll("td");
    for (const td of cells) {
      const walker = document.createTreeWalker(td, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!PREFIX.test(n.nodeValue) || n.parentElement?.closest(".nm, button, select, textarea, input")) continue;
        const span = document.createElement("span");
        span.className = "nm";
        n.parentNode.insertBefore(span, n);
        span.appendChild(n);
        break;
      }
    }
  };
  const start = () => {
    mark(document.body);
    new MutationObserver((list) => { for (const m of list) for (const node of m.addedNodes) if (node.nodeType === 1) mark(node); else if (node.nodeType === 3 && node.parentElement?.closest("td")) mark(node.parentElement.closest("td")); })
      .observe(document.body, { childList: true, subtree: true });
  };
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);
})();
