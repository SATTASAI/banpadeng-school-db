import { jsonResponse } from "../lib/auth.js";
const reply = (data, status = 200) =>
  jsonResponse(data, status, { "Cache-Control": "no-store" });
const MAX_ROWS = 200;
const rowKey = (r) =>
  JSON.stringify([r.student_code, r.direction, r.academic_year, r.term]);
async function validateRows(env, rows, batchRef, user, normalize) {
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_ROWS)
    return {
      errors: [{ row: 0, error: "นำเข้าได้ครั้งละ 1–200 รายการ" }],
      records: [],
    };
  const errors = [],
    candidates = [],
    records = [],
    seen = new Set();
  for (let i = 0; i < rows.length; i++) {
    const result = normalize({
      ...rows[i],
      client_ref: "import:" + batchRef + ":" + i,
    });
    if (result.error) {
      errors.push({ row: i + 1, error: result.error });
      continue;
    }
    const key = rowKey(result.record);
    if (seen.has(key)) {
      errors.push({ row: i + 1, error: "มีรายการซ้ำภายในไฟล์" });
      continue;
    }
    seen.add(key);
    candidates.push({ row: i + 1, record: result.record });
  }
  const codes = [...new Set(candidates.map((c) => c.record.student_code))],
    students = new Map(),
    existing = new Set();
  for (let i = 0; i < codes.length; i += 80) {
    const chunk = codes.slice(i, i + 80),
      ph = chunk.map(() => "?").join(",");
    const [roster, requests] = await Promise.all([
      env.DB.prepare(
        "SELECT student_code,full_name,status FROM students WHERE student_code IN (" +
          ph +
          ")",
      )
        .bind(...chunk)
        .all(),
      env.DB.prepare(
        "SELECT student_code,direction,academic_year,term FROM student_transfer_requests WHERE student_code IN (" +
          ph +
          ") AND status NOT IN ('rejected','cancelled')",
      )
        .bind(...chunk)
        .all(),
    ]);
    roster.results.forEach((r) => students.set(r.student_code, r));
    requests.results.forEach((r) => existing.add(rowKey(r)));
  }
  for (const { row, record: r } of candidates) {
    if (r.direction === "out") {
      const student = students.get(r.student_code);
      if (
        !student ||
        student.status !== "enrolled" ||
        student.full_name.trim() !== r.student_name
      ) {
        errors.push({
          row,
          error:
            "ชื่อนักเรียนย้ายออกหรือเลขประจำตัวไม่ตรงกับทะเบียนกลางที่กำลังศึกษาอยู่",
        });
        continue;
      }
    }
    if (existing.has(rowKey(r))) {
      errors.push({
        row,
        error: "มีคำร้องของนักเรียนในประเภท/ปี/ภาคเรียนนี้แล้ว",
      });
      continue;
    }
    records.push(r);
  }
  return { errors: errors.sort((a, b) => a.row - b.row), records };
}
function importStatements(env, records, userId) {
  const statements = [];
  for (let i = 0; i < records.length; i += 8) {
    const chunk = records.slice(i, i + 8);
    statements.push(
      env.DB.prepare(
        "INSERT INTO student_transfer_requests(client_ref,direction,student_code,student_name,grade_level,school_name,academic_year,term,move_date,reason,created_by) VALUES " +
          chunk.map(() => "(?,?,?,?,?,?,?,?,?,?,?)").join(","),
      ).bind(
        ...chunk.flatMap((r) => [
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
          userId,
        ]),
      ),
    );
  }
  return statements;
}
export async function handleTransferExtras(
  request,
  env,
  path,
  method,
  user,
  normalize,
) {
  const selectedStudent = path.match(
    /^\/api\/student-transfers\/students\/(\d+)$/,
  );
  if (selectedStudent && method === "GET") {
    const student = await env.DB.prepare(
      "SELECT id,student_code,full_name,grade_level,classroom,status FROM students WHERE id=?",
    )
      .bind(Number(selectedStudent[1]))
      .first();
    return student
      ? reply({ student })
      : reply({ error: "ไม่พบนักเรียนในทะเบียนกลาง" }, 404);
  }
  if (path === "/api/student-transfers/students" && method === "GET") {
    const url = new URL(request.url),
      q = (url.searchParams.get("q") || "").trim().slice(0, 100),
      status = url.searchParams.get("status") || "",
      offset = Math.floor(
        Math.max(
          0,
          Math.min(100000, Number(url.searchParams.get("offset")) || 0),
        ),
      );
    if (
      status &&
      !["enrolled", "transferred", "withdrawn", "graduated"].includes(status)
    )
      return reply({ error: "สถานะไม่ถูกต้อง" }, 400);
    const conditions = [],
      args = [];
    if (q) {
      conditions.push(
        "(full_name LIKE ? OR student_code LIKE ? OR grade_level LIKE ? OR classroom LIKE ?)",
      );
      args.push(...Array(4).fill("%" + q + "%"));
    }
    if (status) {
      conditions.push("status=?");
      args.push(status);
    }
    const where = conditions.length ? " WHERE " + conditions.join(" AND ") : "";
    const [rows, count] = await Promise.all([
      env.DB.prepare(
        `SELECT id,student_code,full_name,grade_level,classroom,status FROM students${where} ORDER BY grade_level,classroom,student_code,id LIMIT 100 OFFSET ?`,
      )
        .bind(...args, offset)
        .all(),
      env.DB.prepare(`SELECT COUNT(*) total FROM students${where}`)
        .bind(...args)
        .first(),
    ]);
    return reply({ students: rows.results, total: Number(count.total) });
  }
  if (
    ![
      "/api/student-transfers/import",
      "/api/student-transfers/import/preview",
    ].includes(path)
  )
    return null;
  if (method !== "POST") return reply({ error: "Method not allowed" }, 405);
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > 1000000)
    return reply({ error: "ข้อมูลใหญ่เกินกำหนด" }, 413);
  const body = await request.json().catch(() => null);
  if (
    !body ||
    !Array.isArray(body.rows) ||
    JSON.stringify(body).length > 1000000
  )
    return reply({ error: "รูปแบบข้อมูลนำเข้าไม่ถูกต้อง" }, 400);
  const batchRef = String(body.batch_ref || "");
  if (!/^[a-zA-Z0-9-]{16,64}$/.test(batchRef))
    return reply({ error: "รหัสชุดนำเข้าไม่ถูกต้อง" }, 400);
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS student_transfer_import_batches (
 id INTEGER PRIMARY KEY AUTOINCREMENT, batch_ref TEXT NOT NULL, user_id INTEGER NOT NULL,
 payload_hash TEXT NOT NULL, row_count INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT (datetime('now')),UNIQUE(user_id,batch_ref))`,
  ).run();
  const hash = [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(body.rows)),
      ),
    ),
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const prior = await env.DB.prepare(
    "SELECT payload_hash,row_count FROM student_transfer_import_batches WHERE user_id=? AND batch_ref=?",
  )
    .bind(user.id, batchRef)
    .first();
  if (prior) {
    if (prior.payload_hash !== hash)
      return reply({ error: "รหัสชุดนำเข้าถูกใช้กับข้อมูลชุดอื่นแล้ว" }, 409);
    return reply({ imported: prior.row_count, already_imported: true });
  }
  const result = await validateRows(env, body.rows, batchRef, user, normalize);
  if (path.endsWith("/preview"))
    return reply({
      total: body.rows.length,
      valid: result.records.length,
      errors: result.errors,
      preview: result.records,
    });
  if (result.errors.length)
    return reply(
      {
        error: "ยังไม่บันทึกข้อมูล กรุณาแก้รายการที่ไม่ถูกต้อง",
        errors: result.errors,
      },
      400,
    );
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO student_transfer_import_batches(batch_ref,user_id,payload_hash,row_count) VALUES(?,?,?,?)",
      ).bind(batchRef, user.id, hash, result.records.length),
      ...importStatements(env, result.records, user.id),
      env.DB.prepare(
        `INSERT INTO audit_logs(user_id,action,resource,details) VALUES(?,'import','student_transfer_requests',?)`,
      ).bind(
        user.id,
        JSON.stringify({ batch_ref: batchRef, count: result.records.length }),
      ),
    ]);
  } catch (error) {
    if (/UNIQUE constraint/i.test(String(error)))
      return reply(
        {
          error:
            "พบข้อมูลซ้ำหรือมีผู้นำเข้าชุดนี้แล้ว กรุณาตรวจตัวอย่างอีกครั้ง",
        },
        409,
      );
    throw error;
  }
  return reply({ imported: result.records.length }, 201);
}
