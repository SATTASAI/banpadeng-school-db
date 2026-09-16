// หน้าจัดการงาน: มอบหมาย/ติดตามสถานะ (ใช้ apiRequest และ ROLE_LABELS จาก api.js)

const PRIORITY_LABELS = { low: "ต่ำ", normal: "ปกติ", high: "สูง", urgent: "เร่งด่วน" };
const ASSIGNEE_STATUS_LABELS = { pending: "รอดำเนินการ", in_progress: "กำลังทำ", done: "เสร็จแล้ว" };

let currentUser = null;
let currentView = "assigned";
let allUsers = [];

function formatDate(d) {
  if (!d) return "";
  return new Date(`${d}T00:00:00`).toLocaleDateString("th-TH", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function isOverdue(task) {
  if (!task.due_date || task.status === "closed") return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(`${task.due_date}T00:00:00`) < today;
}

function buildAssigneeChip(a) {
  const chip = document.createElement("span");
  chip.className = "assignee-chip";
  const dot = document.createElement("span");
  dot.className = `dot dot-${a.status}`;
  chip.appendChild(dot);
  chip.appendChild(document.createTextNode(a.full_name));
  return chip;
}

function buildTaskCard(task) {
  const card = document.createElement("div");
  card.className = "task-card" + (task.status === "closed" ? " closed" : "");
  card.addEventListener("click", () => openDetail(task));

  const top = document.createElement("div");
  top.className = "task-card-top";

  const left = document.createElement("div");
  const h3 = document.createElement("h3");
  h3.textContent = task.title;
  left.appendChild(h3);

  const meta = document.createElement("div");
  meta.className = "task-meta" + (isOverdue(task) ? " overdue" : "");
  const parts = [];
  if (currentView !== "created") parts.push(`มอบหมายโดย ${task.creator_name}`);
  if (task.due_date) parts.push(`กำหนดส่ง ${formatDate(task.due_date)}${isOverdue(task) ? " (เลยกำหนด)" : ""}`);
  if (task.status === "closed") parts.push("ปิดงานแล้ว");
  meta.textContent = parts.join(" · ");
  left.appendChild(meta);
  top.appendChild(left);

  const badge = document.createElement("span");
  badge.className = `badge badge-${task.priority}`;
  badge.textContent = PRIORITY_LABELS[task.priority] || task.priority;
  top.appendChild(badge);

  card.appendChild(top);

  const chips = document.createElement("div");
  chips.className = "assignee-chips";
  task.assignees.forEach((a) => chips.appendChild(buildAssigneeChip(a)));
  card.appendChild(chips);

  return card;
}

async function loadTasks() {
  const { tasks } = await apiRequest(`/api/tasks?view=${currentView}`);
  const list = document.getElementById("taskList");
  const emptyState = document.getElementById("emptyState");
  list.innerHTML = "";

  if (tasks.length === 0) {
    emptyState.style.display = "block";
    return;
  }
  emptyState.style.display = "none";
  tasks.forEach((t) => list.appendChild(buildTaskCard(t)));
}

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentView = btn.dataset.view;
    loadTasks();
  });
});

// ---------- สร้างงานใหม่ ----------
function buildCheckboxList(container, users, checkedIds = []) {
  container.innerHTML = "";
  users.forEach((u) => {
    const row = document.createElement("label");
    row.className = "checkbox-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = u.id;
    cb.checked = checkedIds.includes(u.id);
    row.appendChild(cb);
    row.appendChild(document.createTextNode(`${u.full_name} (${ROLE_LABELS[u.role] || u.role})`));
    container.appendChild(row);
  });
}

function openCreateModal() {
  document.getElementById("fTitle").value = "";
  document.getElementById("fDescription").value = "";
  document.getElementById("fPriority").value = "normal";
  document.getElementById("fDueDate").value = "";
  document.getElementById("modalError").classList.remove("visible");
  buildCheckboxList(document.getElementById("assigneeList"), allUsers, [currentUser.id]);
  document.getElementById("taskModal").classList.add("visible");
}

document.getElementById("newTaskBtn").addEventListener("click", openCreateModal);
document.getElementById("cancelTaskBtn").addEventListener("click", () => {
  document.getElementById("taskModal").classList.remove("visible");
});

document.getElementById("saveTaskBtn").addEventListener("click", async () => {
  const title = document.getElementById("fTitle").value.trim();
  const description = document.getElementById("fDescription").value.trim();
  const priority = document.getElementById("fPriority").value;
  const due_date = document.getElementById("fDueDate").value || null;
  const assignee_ids = Array.from(document.querySelectorAll("#assigneeList input:checked")).map((cb) =>
    Number(cb.value)
  );

  const errorBox = document.getElementById("modalError");
  errorBox.classList.remove("visible");

  try {
    await apiRequest("/api/tasks", {
      method: "POST",
      body: { title, description, priority, due_date, assignee_ids },
    });
    document.getElementById("taskModal").classList.remove("visible");
    await loadTasks();
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.classList.add("visible");
  }
});

// ---------- รายละเอียดงาน ----------
async function openDetail(task) {
  document.getElementById("detailTitle").textContent = task.title;
  document.getElementById("detailPriority").className = `badge badge-${task.priority}`;
  document.getElementById("detailPriority").textContent = PRIORITY_LABELS[task.priority] || task.priority;

  const metaParts = [`มอบหมายโดย ${task.creator_name}`];
  if (task.due_date) metaParts.push(`กำหนดส่ง ${formatDate(task.due_date)}`);
  if (task.status === "closed") metaParts.push("ปิดงานแล้ว");
  document.getElementById("detailMeta").textContent = metaParts.join(" · ");
  document.getElementById("detailDescription").textContent =
    task.description || "(ไม่มีรายละเอียดเพิ่มเติม)";

  const isOwner = currentUser.is_admin || task.created_by === currentUser.id;

  const assigneesBox = document.getElementById("detailAssignees");
  assigneesBox.innerHTML = "";
  task.assignees.forEach((a) => {
    const row = document.createElement("div");
    row.style.cssText =
      "display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--color-border);gap:10px;flex-wrap:wrap;";

    const nameSpan = document.createElement("span");
    nameSpan.textContent = `${a.full_name} (${ROLE_LABELS[a.role] || a.role})`;
    row.appendChild(nameSpan);

    const controls = document.createElement("div");
    controls.style.cssText = "display:flex;align-items:center;gap:8px;";

    const canEditStatus = isOwner || a.user_id === currentUser.id;
    if (canEditStatus) {
      const select = document.createElement("select");
      select.style.width = "auto";
      Object.entries(ASSIGNEE_STATUS_LABELS).forEach(([val, label]) => {
        const opt = document.createElement("option");
        opt.value = val;
        opt.textContent = label;
        if (a.status === val) opt.selected = true;
        select.appendChild(opt);
      });
      select.addEventListener("change", async () => {
        select.disabled = true;
        try {
          const { task: updated } = await apiRequest(`/api/tasks/${task.id}/assignees/${a.user_id}`, {
            method: "PATCH",
            body: { status: select.value },
          });
          await loadTasks();
          openDetail(updated);
        } catch (err) {
          alert(err.message);
          select.disabled = false;
        }
      });
      controls.appendChild(select);
    } else {
      controls.appendChild(buildAssigneeChip(a));
    }

    if (isOwner) {
      const removeBtn = document.createElement("button");
      removeBtn.className = "btn btn-ghost";
      removeBtn.style.cssText = "width:auto;padding:4px 10px;font-size:12px;";
      removeBtn.textContent = "นำออก";
      removeBtn.addEventListener("click", async () => {
        if (!confirm(`นำ ${a.full_name} ออกจากงานนี้?`)) return;
        try {
          const { task: updated } = await apiRequest(`/api/tasks/${task.id}/assignees/${a.user_id}`, {
            method: "DELETE",
          });
          await loadTasks();
          openDetail(updated);
        } catch (err) {
          alert(err.message);
        }
      });
      controls.appendChild(removeBtn);
    }

    row.appendChild(controls);
    assigneesBox.appendChild(row);
  });

  const ownerActions = document.getElementById("ownerActions");
  ownerActions.style.display = isOwner ? "block" : "none";

  if (isOwner) {
    const assignedIds = task.assignees.map((a) => a.user_id);
    const remainingUsers = allUsers.filter((u) => !assignedIds.includes(u.id));
    const addList = document.getElementById("addAssigneeList");
    addList.innerHTML = "";
    if (remainingUsers.length === 0) {
      addList.innerHTML =
        '<div style="color:var(--color-text-muted);font-size:13px;">มอบหมายให้ทุกคนแล้ว</div>';
    } else {
      remainingUsers.forEach((u) => {
        const row = document.createElement("label");
        row.className = "checkbox-row";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.value = u.id;
        row.appendChild(cb);
        row.appendChild(document.createTextNode(`${u.full_name} (${ROLE_LABELS[u.role] || u.role})`));
        row.addEventListener("change", async () => {
          try {
            const { task: updated } = await apiRequest(`/api/tasks/${task.id}/assignees`, {
              method: "POST",
              body: { assignee_ids: [u.id] },
            });
            await loadTasks();
            openDetail(updated);
          } catch (err) {
            alert(err.message);
          }
        });
        addList.appendChild(row);
      });
    }

    const toggleBtn = document.getElementById("toggleStatusBtn");
    toggleBtn.textContent = task.status === "open" ? "ปิดงาน" : "เปิดงานอีกครั้ง";
    toggleBtn.onclick = async () => {
      try {
        await apiRequest(`/api/tasks/${task.id}`, {
          method: "PATCH",
          body: { status: task.status === "open" ? "closed" : "open" },
        });
        document.getElementById("detailModal").classList.remove("visible");
        await loadTasks();
      } catch (err) {
        alert(err.message);
      }
    };

    document.getElementById("deleteTaskBtn").onclick = async () => {
      if (!confirm("ยืนยันลบงานนี้? ไม่สามารถกู้คืนได้")) return;
      try {
        await apiRequest(`/api/tasks/${task.id}`, { method: "DELETE" });
        document.getElementById("detailModal").classList.remove("visible");
        await loadTasks();
      } catch (err) {
        alert(err.message);
      }
    };
  }

  document.getElementById("detailModal").classList.add("visible");
}

document.getElementById("closeDetailBtn").addEventListener("click", () => {
  document.getElementById("detailModal").classList.remove("visible");
});

[document.getElementById("taskModal"), document.getElementById("detailModal")].forEach((overlay) => {
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.classList.remove("visible");
  });
});

// ---------- เริ่มต้นหน้า ----------
(async () => {
  const { user } = await apiRequest("/api/auth/me");
  if (!user) {
    window.location.href = "/login.html";
    return;
  }
  if (!user.role) {
    window.location.href = "/pending.html";
    return;
  }
  currentUser = user;

  if (user.is_admin) {
    document.getElementById("allTab").style.display = "inline-block";
  }

  const { users } = await apiRequest("/api/users");
  allUsers = users;

  await loadTasks();
})();
