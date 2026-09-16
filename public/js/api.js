// ทำให้หน้าที่เปิดอยู่ภายในพื้นที่ทำงานซ้อนใช้ layout แบบกะทัดรัด
if (window.parent !== window) {
  document.documentElement.classList.add("embedded");
}

async function apiRequest(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: "same-origin",
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    // ไม่มี body หรือไม่ใช่ JSON
  }

  if (!res.ok) {
    const message = (data && data.error) || "เกิดข้อผิดพลาด กรุณาลองใหม่";
    throw new Error(message);
  }
  return data;
}

const ROLE_LABELS = {
  teacher: "ครู",
  executive: "ผู้บริหาร",
  staff: "เจ้าหน้าที่ธุรการ",
  superadmin: "ผู้ดูแลระบบ",
};
