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
async function apiRequest(path, options = {}) {
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
};

// Shared notification bar uses the same authenticated API as the current page.
(() => { const css=document.createElement('link');css.rel='stylesheet';css.href='/css/global-notifications.css';document.head.append(css);
 const script=document.createElement('script');script.src='/js/global-notifications.js';document.head.append(script); })();

// Admin-only test cleanup controls across the workspace.
(() => {const css=document.createElement("link");css.rel="stylesheet";css.href="/css/admin-cleanup.css";document.head.append(css);const script=document.createElement("script");script.src="/js/admin-cleanup.js";document.head.append(script);})();

// Portrait phone layout shared by standalone pages and iframe modules.
(() => {const css=document.createElement("link");css.rel="stylesheet";css.href="/css/mobile.css";document.head.append(css);})();
