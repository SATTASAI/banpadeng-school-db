import { getCurrentUser, isAdmin, jsonResponse } from "../lib/auth.js";
import {
  mayUseTransfers,
  handleTransferAccess,
} from "../lib/transfer-access.js";
import { handleTransferExtras } from "./transfer-extras.js";

export const DOCUMENT_KINDS = ["referral", "transcript", "household"];
const ready = new WeakSet();
export async function ensureStudentTransfers(env) {
  if (ready.has(env.DB)) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS student_transfer_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT, client_ref TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('in','out')),
      student_code TEXT NOT NULL, student_name TEXT NOT NULL, grade_level TEXT NOT NULL,
      school_name TEXT NOT NULL, academic_year INTEGER NOT NULL, term INTEGER NOT NULL CHECK(term IN (1,2)),
      move_date TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','needs_documents','approved','rejected','cancelled')),
      note TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER NOT NULL REFERENCES users(id), decided_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      decided_at TEXT, UNIQUE(created_by,client_ref))`),
    env.DB
      .prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_transfer_active ON student_transfer_requests
      (student_code,direction,academic_year,term) WHERE status NOT IN ('rejected','cancelled')`),
    env.DB.prepare(
      `CREATE INDEX IF NOT EXISTS idx_transfer_status ON student_transfer_requests(status,id)`,
    ),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS student_transfer_documents (
      request_id INTEGER NOT NULL REFERENCES student_transfer_requests(id), kind TEXT NOT NULL,
      file_name TEXT NOT NULL, mime_type TEXT NOT NULL, file_size INTEGER NOT NULL, drive_file_id TEXT NOT NULL,
      verified INTEGER NOT NULL DEFAULT 0 CHECK(verified IN (0,1)), uploaded_by INTEGER NOT NULL,
      verified_by INTEGER, updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(request_id,kind))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS student_transfer_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, request_id INTEGER NOT NULL REFERENCES student_transfer_requests(id),
      action TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`),
  ]);
  ready.add(env.DB);
}

export function normalizeTransfer(input) {
  const record = {};
  for (const [key, max] of Object.entries({
    student_code: 30,
    student_name: 180,
    grade_level: 60,
    school_name: 200,
    reason: 1000,
    client_ref: 80,
  })) {
    const value = typeof input?.[key] === "string" ? input[key].trim() : "";
    if (!value || value.length > max)
      return { error: "กรุณากรอกข้อมูลให้ครบและไม่เกินความยาวที่กำหนด" };
    record[key] = value;
  }
  if (!["in", "out"].includes(input.direction))
    return { error: "กรุณาระบุย้ายเข้าหรือย้ายออก" };
  if (
    !Number.isInteger(input.academic_year) ||
    input.academic_year < 2500 ||
    input.academic_year > 2700 ||
    ![1, 2].includes(input.term)
  )
    return { error: "ปีการศึกษาหรือภาคเรียนไม่ถูกต้อง" };
  if (
    typeof input.move_date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(input.move_date) ||
    !Number.isFinite(Date.parse(input.move_date)) ||
    new Date(input.move_date).toISOString().slice(0, 10) !== input.move_date
  )
    return { error: "วันที่ย้ายไม่ถูกต้อง" };
  return {
    record: {
      ...record,
      direction: input.direction,
      academic_year: input.academic_year,
      term: input.term,
      move_date: input.move_date,
    },
  };
}

export async function transferSummary(env) {
  await ensureStudentTransfers(env);
  const row = await env.DB.prepare(
    `SELECT COUNT(*) total,
    COALESCE(SUM(status IN ('pending','needs_documents')),0) pending,
    COALESCE(SUM(status='needs_documents'),0) needs_documents,
    COALESCE(SUM(status='approved' AND direction='in'),0) approved_in,
    COALESCE(SUM(status='approved' AND direction='out'),0) approved_out
    FROM student_transfer_requests`,
  ).first();
  return row;
}

const response = (data, status = 200) =>
  jsonResponse(data, status, { "Cache-Control": "no-store" });
const mutable = (row) => ["pending", "needs_documents"].includes(row.status);
const fields =
  "id,direction,student_code,student_name,grade_level,school_name,academic_year,term,move_date,reason,status,note,version,created_at,updated_at,decided_at";
const event = (env, id, action, note, userId, version) =>
  env.DB.prepare(
    `INSERT INTO student_transfer_events(request_id,action,note,user_id)
  SELECT id,?,?,? FROM student_transfer_requests WHERE id=? AND version=? AND changes()=1`,
  ).bind(action, note, userId, id, version);

export async function handleStudentTransfers(
  request,
  env,
  pathname,
  method,
  storage,
) {
  if (!pathname.startsWith("/api/student-transfers")) return null;
  const user = await getCurrentUser(request, env);
  if (!user?.role) return response({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  const accessResponse = await handleTransferAccess(
    request,
    env,
    pathname,
    method,
    user,
  );
  if (accessResponse) return accessResponse;
  if (!(await mayUseTransfers(env, user)))
    return response(
      {
        error: "บัญชีนี้ยังไม่ได้รับสิทธิ์ใช้งานทะเบียนย้าย กรุณาติดต่อแอดมิน",
      },
      403,
    );
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    const origin = request.headers.get("Origin");
    if (origin && origin !== new URL(request.url).origin)
      return response({ error: "ไม่อนุญาตคำขอจากเว็บไซต์อื่น" }, 403);
  }
  await ensureStudentTransfers(env);
  const extraResponse = await handleTransferExtras(
    request,
    env,
    pathname,
    method,
    user,
    normalizeTransfer,
  );
  if (extraResponse) return extraResponse;
  const match = pathname.match(
    /^\/api\/student-transfers(?:\/(\d+)(?:\/(decision|note|documents)(?:\/(referral|transcript|household)(?:\/(verify))?)?)?)?$/,
  );
  if (!match) return response({ error: "ไม่พบเส้นทาง" }, 404);
  const [, rawId, action, kind, verify] = match,
    id = Number(rawId);
  if (!rawId && method === "GET") {
    const url = new URL(request.url),
      params = [],
      conditions = [];
    for (const [key, allowed] of [
      ["direction", ["in", "out"]],
      [
        "status",
        ["pending", "needs_documents", "approved", "rejected", "cancelled"],
      ],
    ]) {
      const value = url.searchParams.get(key);
      if (value) {
        if (!allowed.includes(value))
          return response({ error: "ตัวกรองไม่ถูกต้อง" }, 400);
        conditions.push(`${key}=?`);
        params.push(value);
      }
    }
    const search = url.searchParams.get("q")?.trim().slice(0, 100);
    if (search) {
      conditions.push(
        "(student_name LIKE ? OR student_code LIKE ? OR CAST(id AS TEXT)=?)",
      );
      params.push(`%${search}%`, `%${search}%`, search);
    }
    const offset = Math.floor(
      Math.max(
        0,
        Math.min(100000, Number(url.searchParams.get("offset")) || 0),
      ),
    );
    const where = conditions.length ? " WHERE " + conditions.join(" AND ") : "";
    const [rows, count, summary] = await Promise.all([
      env.DB.prepare(
        `SELECT ${fields} FROM student_transfer_requests${where} ORDER BY id DESC LIMIT 100 OFFSET ?`,
      )
        .bind(...params, offset)
        .all(),
      env.DB.prepare(
        `SELECT COUNT(*) total FROM student_transfer_requests${where}`,
      )
        .bind(...params)
        .first(),
      transferSummary(env),
    ]);
    return response({
      requests: rows.results,
      total: Number(count.total),
      summary,
      can_decide: isAdmin(user),
    });
  }
  if (!rawId && method === "POST") {
    const input = await request.json().catch(() => null),
      result = normalizeTransfer(input);
    if (result.error) return response({ error: result.error }, 400);
    const r = result.record;
    const prior = await env.DB.prepare(
      "SELECT id FROM student_transfer_requests WHERE created_by=? AND client_ref=?",
    )
      .bind(user.id, r.client_ref)
      .first();
    if (prior) return response({ id: prior.id });
    if (r.direction === "out") {
      const student = await env.DB.prepare(
        "SELECT full_name,status FROM students WHERE student_code=?",
      )
        .bind(r.student_code)
        .first();
      if (
        !student ||
        student.status !== "enrolled" ||
        student.full_name.trim() !== r.student_name
      )
        return response(
          {
            error:
              "ย้ายออกต้องใช้เลขประจำตัวและชื่อที่ตรงกับนักเรียนที่กำลังศึกษาในทะเบียนกลาง",
          },
          400,
        );
    }
    const duplicate = await env.DB.prepare(
      `SELECT id FROM student_transfer_requests WHERE student_code=? AND direction=? AND academic_year=? AND term=? AND status NOT IN ('rejected','cancelled')`,
    )
      .bind(r.student_code, r.direction, r.academic_year, r.term)
      .first();
    if (duplicate)
      return response(
        {
          error: "มีคำร้องของนักเรียนในภาคเรียนและประเภทนี้แล้ว",
          id: duplicate.id,
        },
        409,
      );
    try {
      const inserted = await env.DB.prepare(
        `INSERT INTO student_transfer_requests(client_ref,direction,student_code,student_name,grade_level,school_name,academic_year,term,move_date,reason,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
        .bind(
          r.client_ref,
          r.direction,
          r.student_code,
          r.student_name,
          r.grade_level,
          r.school_name,
          r.academic_year,
          r.term,
          r.move_date,
          r.reason,
          user.id,
        )
        .run();
      return response({ id: inserted.meta.last_row_id }, 201);
    } catch (error) {
      if (/UNIQUE constraint/i.test(String(error)))
        return response(
          { error: "คำร้องนี้ถูกบันทึกแล้ว กรุณาโหลดข้อมูลใหม่" },
          409,
        );
      throw error;
    }
  }
  if (!rawId) return response({ error: "Method not allowed" }, 405);
  const row = await env.DB.prepare(
    `SELECT ${fields} FROM student_transfer_requests WHERE id=?`,
  )
    .bind(id)
    .first();
  if (!row) return response({ error: "ไม่พบคำร้อง" }, 404);
  if (!action && method === "GET") {
    const [docs, events] = await Promise.all([
      env.DB.prepare(
        `SELECT kind,file_name,mime_type,file_size,verified,updated_at FROM student_transfer_documents WHERE request_id=?`,
      )
        .bind(id)
        .all(),
      env.DB.prepare(
        `SELECT e.action,e.note,e.created_at,u.full_name user_name FROM student_transfer_events e LEFT JOIN users u ON u.id=e.user_id WHERE e.request_id=? ORDER BY e.id DESC LIMIT 50`,
      )
        .bind(id)
        .all(),
    ]);
    return response({
      request: row,
      documents: docs.results,
      events: events.results,
      can_decide: isAdmin(user),
    });
  }
  if (action === "documents" && kind && !verify && method === "GET") {
    const doc = await env.DB.prepare(
      "SELECT * FROM student_transfer_documents WHERE request_id=? AND kind=?",
    )
      .bind(id, kind)
      .first();
    if (!doc) return response({ error: "ยังไม่มีเอกสาร" }, 404);
    const stream = await storage.read(env, doc.drive_file_id);
    return new Response(stream, {
      headers: {
        "Content-Type": doc.mime_type,
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(doc.file_name)}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  if (!mutable(row))
    return response({ error: "คำร้องสิ้นสุดแล้ว ไม่สามารถแก้ไขได้" }, 409);
  if (action === "documents" && kind && !verify && method === "POST") {
    const form = await request.formData().catch(() => null),
      file = form?.get("file");
    const expected = Number(form?.get("version"));
    if (expected !== row.version)
      return response({ error: "ข้อมูลเปลี่ยนแล้ว กรุณาโหลดใหม่" }, 409);
    const validation = await storage.validate(file, "student_transfer");
    if (validation.error) return response({ error: validation.error }, 400);
    const name = String(file.name)
      .replace(/[\r\n/\\]/g, "_")
      .slice(0, 180);
    const drive = await storage.upload(
      env,
      file,
      id,
      name,
      validation.mimeType,
    );
    const previous = await env.DB.prepare(
      "SELECT drive_file_id FROM student_transfer_documents WHERE request_id=? AND kind=?",
    )
      .bind(id, kind)
      .first();
    let batch;
    try {
      batch = await env.DB.batch([
        env.DB.prepare(
          `UPDATE student_transfer_requests SET version=version+1,updated_at=datetime('now') WHERE id=? AND version=? AND status IN ('pending','needs_documents')`,
        ).bind(id, expected),
        env.DB.prepare(
          `INSERT INTO student_transfer_documents(request_id,kind,file_name,mime_type,file_size,drive_file_id,uploaded_by)
        SELECT id,?,?,?,?,?,? FROM student_transfer_requests WHERE id=? AND version=? AND changes()=1
        ON CONFLICT(request_id,kind) DO UPDATE SET file_name=excluded.file_name,mime_type=excluded.mime_type,file_size=excluded.file_size,drive_file_id=excluded.drive_file_id,uploaded_by=excluded.uploaded_by,verified=0,verified_by=NULL,updated_at=datetime('now')`,
        ).bind(
          kind,
          name,
          validation.mimeType,
          file.size,
          drive.id,
          user.id,
          id,
          expected + 1,
        ),
        event(env, id, "upload", kind, user.id, expected + 1),
      ]);
    } catch (error) {
      await storage.remove(env, drive.id).catch(() => {});
      throw error;
    }
    if (!batch[0].meta.changes) {
      await storage.remove(env, drive.id).catch(() => {});
      return response({ error: "ข้อมูลเปลี่ยนแล้ว กรุณาโหลดใหม่" }, 409);
    }
    if (previous?.drive_file_id)
      await storage.remove(env, previous.drive_file_id).catch(() => {});
    return response({ ok: true }, 201);
  }
  const body = await request.json().catch(() => null);
  if (!body || body.version !== row.version)
    return response({ error: "ข้อมูลเปลี่ยนแล้ว กรุณาโหลดใหม่" }, 409);
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (note.length > 2000)
    return response({ error: "บันทึกยาวเกิน 2,000 ตัวอักษร" }, 400);
  let statement, eventAction;
  if (action === "note" && method === "PATCH") {
    statement = env.DB.prepare(
      `UPDATE student_transfer_requests SET note=?,version=version+1,updated_at=datetime('now') WHERE id=? AND version=? AND status IN ('pending','needs_documents')`,
    ).bind(note, id, body.version);
    eventAction = "note";
  } else if (action === "documents" && kind && verify && method === "PATCH") {
    if (typeof body.verified !== "boolean")
      return response({ error: "สถานะตรวจเอกสารไม่ถูกต้อง" }, 400);
    const doc = await env.DB.prepare(
      "SELECT kind FROM student_transfer_documents WHERE request_id=? AND kind=?",
    )
      .bind(id, kind)
      .first();
    if (!doc) return response({ error: "กรุณาแนบเอกสารก่อนตรวจสอบ" }, 400);
    const result = await env.DB.batch([
      env.DB.prepare(
        `UPDATE student_transfer_requests SET version=version+1,updated_at=datetime('now') WHERE id=? AND version=? AND status IN ('pending','needs_documents')`,
      ).bind(id, body.version),
      env.DB.prepare(
        `UPDATE student_transfer_documents SET verified=?,verified_by=?,updated_at=datetime('now') WHERE request_id=? AND kind=? AND changes()=1 AND EXISTS(SELECT 1 FROM student_transfer_requests WHERE id=? AND version=?)`,
      ).bind(body.verified ? 1 : 0, user.id, id, kind, id, body.version + 1),
      event(
        env,
        id,
        body.verified ? "verify" : "unverify",
        kind,
        user.id,
        body.version + 1,
      ),
    ]);
    return response(
      result[0].meta.changes
        ? { ok: true }
        : { error: "ข้อมูลเปลี่ยนแล้ว กรุณาโหลดใหม่" },
      result[0].meta.changes ? 200 : 409,
    );
  } else if (action === "decision" && method === "POST") {
    if (
      !["approved", "rejected", "needs_documents", "cancelled"].includes(
        body.status,
      )
    )
      return response({ error: "สถานะไม่ถูกต้อง" }, 400);
    if (["approved", "rejected"].includes(body.status) && !isAdmin(user))
      return response(
        {
          error: "ผู้บริหารหรือผู้ดูแลระบบเท่านั้นที่อนุมัติหรือไม่อนุมัติได้",
        },
        403,
      );
    if (
      ["rejected", "needs_documents", "cancelled"].includes(body.status) &&
      !note
    )
      return response({ error: "กรุณาระบุเหตุผลประกอบ" }, 400);
    if (body.status === "approved") {
      const docs = await env.DB.prepare(
        "SELECT kind FROM student_transfer_documents WHERE request_id=? AND verified=1",
      )
        .bind(id)
        .all();
      if (!DOCUMENT_KINDS.every((k) => docs.results.some((d) => d.kind === k)))
        return response(
          { error: "กรุณาแนบและตรวจสอบเอกสารให้ครบทั้ง 3 รายการก่อนอนุมัติ" },
          400,
        );
    }
    statement = env.DB.prepare(
      `UPDATE student_transfer_requests SET status=?,note=?,decided_by=?,decided_at=datetime('now'),version=version+1,updated_at=datetime('now') WHERE id=? AND version=? AND status IN ('pending','needs_documents')`,
    ).bind(body.status, note, user.id, id, body.version);
    eventAction = body.status;
  } else return response({ error: "Method not allowed" }, 405);
  const results = await env.DB.batch([
    statement,
    event(env, id, eventAction, note, user.id, body.version + 1),
  ]);
  return response(
    results[0].meta.changes
      ? { ok: true }
      : { error: "ข้อมูลเปลี่ยนแล้ว กรุณาโหลดใหม่" },
    results[0].meta.changes ? 200 : 409,
  );
}
