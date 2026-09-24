import { getCurrentUser, isAdmin, jsonResponse } from "../lib/auth.js";

const TYPES = new Set(["incoming", "outgoing", "internal"]);
const URGENCY = new Set(["normal", "urgent", "very_urgent", "immediate"]);
const CONFIDENTIALITY = new Set(["normal", "confidential", "secret", "top_secret"]);
const STATUSES = new Set(["received", "routed", "in_progress", "completed", "archived"]);
const reply = (body, status = 200) => jsonResponse(body, status, { "Cache-Control": "private, no-store" });
const clean = (value, max = 1000) => typeof value === "string" ? value.trim().slice(0, max) : "";
const id = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const isoDate = (value) => !value || /^\d{4}-\d{2}-\d{2}$/.test(value);
const canManage = (user) => isAdmin(user) || user?.role === "staff";

export async function ensureCorrespondenceSchema(env) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS correspondence_counters (
      buddhist_year INTEGER NOT NULL,
      register_type TEXT NOT NULL,
      last_number INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (buddhist_year, register_type))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS correspondence_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      register_type TEXT NOT NULL CHECK(register_type IN ('incoming','outgoing','internal')),
      register_no TEXT NOT NULL UNIQUE,
      document_no TEXT,
      subject TEXT NOT NULL,
      sender TEXT,
      recipient TEXT,
      document_date TEXT,
      received_date TEXT,
      urgency TEXT NOT NULL DEFAULT 'normal',
      confidentiality TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'received',
      assigned_to INTEGER REFERENCES users(id),
      due_date TEXT,
      direction_note TEXT,
      document_id INTEGER REFERENCES documents(id),
      created_by INTEGER NOT NULL REFERENCES users(id),
      updated_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT(datetime('now')),
      updated_at TEXT NOT NULL DEFAULT(datetime('now')))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS correspondence_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      correspondence_id INTEGER NOT NULL REFERENCES correspondence_records(id) ON DELETE CASCADE,
      previous_status TEXT,
      new_status TEXT,
      note TEXT,
      assigned_to INTEGER REFERENCES users(id),
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT(datetime('now')))`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_correspondence_type_date ON correspondence_records(register_type,received_date,document_date)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_correspondence_status ON correspondence_records(status,due_date)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_correspondence_assigned ON correspondence_records(assigned_to,status)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_correspondence_updates_record ON correspondence_updates(correspondence_id,created_at DESC)"),
  ]);
}

async function auth(request, env) {
  const user = await getCurrentUser(request, env);
  if (!user || !user.role) return { error: reply({ error: "กรุณาเข้าสู่ระบบ" }, 401) };
  return { user };
}

function visibleSql(user, alias = "c") {
  if (canManage(user)) return { sql: "1=1", binds: [] };
  return { sql: `(${alias}.assigned_to=? OR ${alias}.created_by=?)`, binds: [user.id, user.id] };
}

async function nextRegisterNo(env, type, dateValue) {
  const parsed = dateValue ? new Date(`${dateValue}T00:00:00Z`) : new Date();
  const yearBe = (Number.isNaN(parsed.getTime()) ? new Date() : parsed).getUTCFullYear() + 543;
  const row = await env.DB.prepare(`INSERT INTO correspondence_counters(buddhist_year,register_type,last_number)
    VALUES (?,?,1) ON CONFLICT(buddhist_year,register_type) DO UPDATE SET last_number=last_number+1
    RETURNING last_number`).bind(yearBe, type).first();
  const prefix = { incoming: "รับ", outgoing: "ส่ง", internal: "ภายใน" }[type];
  return `${prefix}-${yearBe}-${String(row.last_number).padStart(4, "0")}`;
}

async function list(request, env, user) {
  const params = new URL(request.url).searchParams;
  const q = clean(params.get("q"), 100);
  const type = TYPES.has(params.get("type")) ? params.get("type") : "";
  const status = STATUSES.has(params.get("status")) ? params.get("status") : "";
  const where = visibleSql(user);
  const pattern = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  const { results } = await env.DB.prepare(`SELECT c.*,u.full_name assigned_name,d.title document_title
    FROM correspondence_records c
    LEFT JOIN users u ON u.id=c.assigned_to LEFT JOIN documents d ON d.id=c.document_id
    WHERE ${where.sql} AND (?='' OR c.register_type=?) AND (?='' OR c.status=?)
      AND (?='' OR c.register_no LIKE ? ESCAPE '\\' OR COALESCE(c.document_no,'') LIKE ? ESCAPE '\\'
        OR c.subject LIKE ? ESCAPE '\\' OR COALESCE(c.sender,'') LIKE ? ESCAPE '\\' OR COALESCE(c.recipient,'') LIKE ? ESCAPE '\\')
    ORDER BY COALESCE(c.received_date,c.document_date) DESC,c.id DESC LIMIT 300`)
    .bind(...where.binds,type,type,status,status,q,pattern,pattern,pattern,pattern,pattern).all();
  const summary = await env.DB.prepare(`SELECT COUNT(*) total,
    SUM(CASE WHEN status NOT IN ('completed','archived') THEN 1 ELSE 0 END) open_count,
    SUM(CASE WHEN due_date<date('now') AND status NOT IN ('completed','archived') THEN 1 ELSE 0 END) overdue_count
    FROM correspondence_records c WHERE ${where.sql}`).bind(...where.binds).first();
  return reply({ records: results, summary, can_manage: canManage(user) });
}

async function detail(env, user, recordId) {
  const where = visibleSql(user);
  const record = await env.DB.prepare(`SELECT c.*,u.full_name assigned_name,d.title document_title
    FROM correspondence_records c LEFT JOIN users u ON u.id=c.assigned_to LEFT JOIN documents d ON d.id=c.document_id
    WHERE c.id=? AND ${where.sql}`).bind(recordId,...where.binds).first();
  if (!record) return reply({ error: "ไม่พบหนังสือหรือไม่มีสิทธิ์เข้าถึง" }, 404);
  const { results } = await env.DB.prepare(`SELECT x.*,u.full_name creator_name,a.full_name assigned_name
    FROM correspondence_updates x LEFT JOIN users u ON u.id=x.created_by LEFT JOIN users a ON a.id=x.assigned_to
    WHERE x.correspondence_id=? ORDER BY x.id DESC`).bind(recordId).all();
  return reply({ record, updates: results, can_manage: canManage(user) });
}

async function create(request, env, user) {
  if (!canManage(user)) return reply({ error: "เฉพาะเจ้าหน้าที่ธุรการหรือผู้บริหาร" }, 403);
  const body = await request.json().catch(() => null);
  const type = body && TYPES.has(body.register_type) ? body.register_type : null;
  const subject = clean(body?.subject, 500);
  if (!type || !subject) return reply({ error: "กรุณาเลือกประเภทและระบุเรื่อง" }, 400);
  const documentDate = clean(body.document_date, 10) || null;
  const receivedDate = clean(body.received_date, 10) || null;
  const dueDate = clean(body.due_date, 10) || null;
  if (![documentDate, receivedDate, dueDate].every(isoDate)) return reply({ error: "รูปแบบวันที่ไม่ถูกต้อง" }, 400);
  const registerNo = await nextRegisterNo(env, type, receivedDate || documentDate);
  const result = await env.DB.prepare(`INSERT INTO correspondence_records
    (register_type,register_no,document_no,subject,sender,recipient,document_date,received_date,urgency,confidentiality,status,assigned_to,due_date,direction_note,document_id,created_by,updated_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(type,registerNo,clean(body.document_no,150)||null,subject,
      clean(body.sender,300)||null,clean(body.recipient,300)||null,documentDate,receivedDate,
      URGENCY.has(body.urgency)?body.urgency:"normal",CONFIDENTIALITY.has(body.confidentiality)?body.confidentiality:"normal",
      "received",id(body.assigned_to),dueDate,clean(body.direction_note,2000)||null,id(body.document_id),user.id,user.id).run();
  const recordId = Number(result.meta.last_row_id);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO correspondence_updates(correspondence_id,new_status,note,assigned_to,created_by)
      VALUES (?,'received','ลงทะเบียนหนังสือ',?,?)`).bind(recordId,id(body.assigned_to),user.id),
    env.DB.prepare(`INSERT INTO audit_logs(user_id,action,resource,resource_id,details,ip_address)
      VALUES (?,'create','correspondence',?,?,?)`).bind(user.id,recordId,JSON.stringify({register_no:registerNo,type}),request.headers.get("CF-Connecting-IP")||null),
  ]);
  return reply({ id: recordId, register_no: registerNo }, 201);
}

async function update(request, env, user, recordId) {
  if (!canManage(user)) return reply({ error: "เฉพาะเจ้าหน้าที่ธุรการหรือผู้บริหาร" }, 403);
  const current = await env.DB.prepare("SELECT * FROM correspondence_records WHERE id=?").bind(recordId).first();
  if (!current) return reply({ error: "ไม่พบหนังสือ" }, 404);
  const body = await request.json().catch(() => null);
  if (!body) return reply({ error: "รูปแบบข้อมูลไม่ถูกต้อง" }, 400);
  const status = STATUSES.has(body?.status) ? body.status : current.status;
  const assignedTo = body.assigned_to === undefined ? current.assigned_to
    : body.assigned_to === "" || body.assigned_to === null ? null : id(body.assigned_to);
  const dueDate = body.due_date === undefined ? current.due_date : clean(body.due_date,10)||null;
  if (!isoDate(dueDate)) return reply({ error: "รูปแบบวันที่ไม่ถูกต้อง" }, 400);
  const directionNote = body.direction_note === undefined ? current.direction_note : clean(body.direction_note,2000)||null;
  const note = clean(body?.note, 2000);
  await env.DB.batch([
    env.DB.prepare(`UPDATE correspondence_records SET status=?,assigned_to=?,due_date=?,direction_note=?,updated_by=?,updated_at=datetime('now') WHERE id=?`)
      .bind(status,assignedTo,dueDate,directionNote,user.id,recordId),
    env.DB.prepare(`INSERT INTO correspondence_updates(correspondence_id,previous_status,new_status,note,assigned_to,created_by)
      VALUES (?,?,?,?,?,?)`).bind(recordId,current.status,status,note||null,assignedTo,user.id),
    env.DB.prepare(`INSERT INTO audit_logs(user_id,action,resource,resource_id,details,ip_address)
      VALUES (?,'update','correspondence',?,?,?)`).bind(user.id,recordId,JSON.stringify({previous_status:current.status,status,assigned_to:assignedTo}),request.headers.get("CF-Connecting-IP")||null),
  ]);
  return reply({ ok: true });
}

export async function handleCorrespondenceRoute(request, env, pathname, method) {
  if (!pathname.startsWith("/api/correspondence")) return null;
  const result = await auth(request, env); if (result.error) return result.error;
  await ensureCorrespondenceSchema(env);
  if (pathname === "/api/correspondence" && method === "GET") return list(request, env, result.user);
  if (pathname === "/api/correspondence" && method === "POST") return create(request, env, result.user);
  const match = pathname.match(/^\/api\/correspondence\/(\d+)$/);
  if (match && method === "GET") return detail(env, result.user, Number(match[1]));
  if (match && method === "PATCH") return update(request, env, result.user, Number(match[1]));
  return reply({ error: "ไม่พบ endpoint" }, 404);
}
