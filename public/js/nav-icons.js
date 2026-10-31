/* ไอคอนเส้นของเมนูด้านซ้าย (แทนตัวย่อเดิม) — วาดด้วย SVG สีตามตัวอักษร */
(function () {
  "use strict";
  const P = {
    overview: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    students: '<path d="M22 9 12 4 2 9l10 5 10-5Z"/><path d="M6 11.5V16c0 1.7 2.7 3 6 3s6-1.3 6-3v-4.5"/><path d="M22 9v5"/>',
    staff: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.2c2.8.4 5 2.8 5 5.8"/>',
    "academic-periods": '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/><path d="M8 14h3M8 17h6"/>',
    bank: '<path d="M3 10l9-6 9 6"/><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8"/><path d="M3 20h18"/>',
    activity: '<rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="M4 17l5-4.5 3.5 3 3-2.5L20 17"/>',
    "padeng-model": '<path d="M12 3 3 8l9 5 9-5Z"/><path d="M7 10.5V16c0 1.7 2.2 3 5 3s5-1.3 5-3v-5.5"/>',
    "classroom-research": '<circle cx="10.5" cy="10.5" r="6"/><path d="m20 20-5-5"/><path d="M8 10.5h5M10.5 8v5"/>',
    grades: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M9 17v-3M12 17v-6M15 17v-2"/>',
    administration: '<path d="M3 21h18"/><path d="M5 21V10M19 21V10M9 21v-7M15 21v-7"/><path d="M12 3 3 8h18Z"/>',
    academic: '<path d="M2 5c3-1.3 6.3-1.3 10 1 3.7-2.3 7-2.3 10-1v14c-3-1.3-6.3-1.3-10 1-3.7-2.3-7-2.3-10-1Z"/><path d="M12 6v14"/>',
    early_childhood: '<rect x="3" y="12" width="8" height="8" rx="1.5"/><rect x="13" y="12" width="8" height="8" rx="1.5"/><rect x="8" y="3" width="8" height="8" rx="1.5"/>',
    budget: '<path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3"/><path d="M21 9h-5a3 3 0 0 0 0 6h5Z"/><circle cx="16.5" cy="12" r=".6"/>',
    personnel: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="11" r="2.5"/><path d="M5.5 17c.6-1.8 2-3 3.5-3s2.9 1.2 3.5 3"/><path d="M15 10h3M15 14h3"/>',
    general: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/><path d="M3 13h18"/>',
    imports: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
    "student-support": '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z"/>',
    insurance: '<path d="M12 3 4 6v5c0 5 3.4 8.6 8 10 4.6-1.4 8-5 8-10V6Z"/><path d="M12 8v8M8 12h8"/>',
    leave: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/><path d="m9.5 13.5 5 5M14.5 13.5l-5 5"/>',
    maintenance: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3.5 17.5a1.8 1.8 0 0 0 2.5 2.5l5.8-5.8a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.4-.4-2.4Z"/>',
    "finance-requests": '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M9.5 15.5c.5.9 1.4 1.3 2.5 1.3 1.3 0 2.2-.6 2.2-1.6 0-2.2-4.4-1.2-4.4-3.4 0-.9.9-1.6 2.2-1.6 1 0 1.8.4 2.2 1.1"/><path d="M12 9.5v1M12 16.8v1"/>',
    supervision: '<path d="M9 4h6a1 1 0 0 1 1 1v1H8V5a1 1 0 0 1 1-1Z"/><path d="M16 5h2a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2"/><path d="m8.5 13.5 2.5 2.5 4.5-5"/>',
    substitutes: '<path d="M4 8h13"/><path d="m14 5 3 3-3 3"/><path d="M20 16H7"/><path d="m10 13-3 3 3 3"/>',
    documents: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h6"/>',
    reports: '<path d="M3 3v18h18"/><path d="M8 16v-4M12 16V8M16 16v-6M20 16V5"/>',
    users: '<circle cx="10" cy="8" r="3.5"/><path d="M3.5 20c0-3.6 2.9-6.5 6.5-6.5 1.4 0 2.7.4 3.7 1.2"/><path d="M19 13.5v7M15.5 17h7"/>',
    approvers: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.8 2.8L16.5 9.5"/>',
    security: '<path d="M12 3 4 6v6c0 4.6 3.4 8 8 9 4.6-1 8-4.4 8-9V6Z"/><path d="m9 12 2 2 4-4"/>',
    "system-status": '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    "usage": '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    web: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z"/>',
    "admin-cleanup": '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4h6v3"/>',
    "line-settings": '<path d="M21 11.5c0 4.1-4 7.5-9 7.5-1 0-2-.1-2.9-.4L4 20l1.2-3.6C3.8 15.1 3 13.4 3 11.5 3 7.4 7 4 12 4s9 3.4 9 7.5Z"/>',
  };
  const keyFor = (link) => link.dataset.page
    || (link.id === "overviewNav" && "overview")
    || (link.classList.contains("nav-grades") && "grades")
    || (link.classList.contains("nav-activity") && "activity")
    || (link.classList.contains("nav-bank") && "bank")
    || (/banpadengschool\.ac\.th\/admin/.test(link.getAttribute("href") || "") && "web");
  function apply(root = document) {
    root.querySelectorAll(".sidebar nav a .nav-number").forEach((badge) => {
      const key = keyFor(badge.closest("a")), path = P[key];
      if (!path || badge.dataset.icon === key) return;
      badge.dataset.icon = key;
      badge.setAttribute("aria-hidden", "true");
      badge.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
    });
  }
  window.SchoolNavIcons = { apply, icons: P };
  if (typeof document !== "undefined") apply();
})();
