import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { signJWT } from "../src/lib/crypto.js";
import {
  ensureStudentTransfers,
  handleStudentTransfers,
} from "../src/routes/student-transfers.js";
import {
  ensureDashboardRevision,
  dashboardRevision,
} from "../src/lib/dashboard-summary.js";
export async function fixture() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  raw.exec(`INSERT INTO users(id,email,password_hash,password_salt,full_name,role) VALUES
 (1,'admin@example.test','x','x','ผู้ดูแลทดสอบ','superadmin'),(2,'staff@example.test','x','x','เจ้าหน้าที่ทดสอบ','staff'),(3,'teacher@example.test','x','x','ครูทดสอบ','teacher');
 INSERT INTO students(student_code,full_name,grade_level,status) VALUES('1001','เด็กชายทดสอบ ย้ายออก','ม.1','enrolled');`);
  function prepare(sql) {
    let values = [];
    return {
      bind(...v) {
        values = v;
        return this;
      },
      async first() {
        return raw.prepare(sql).get(...values) || null;
      },
      async all() {
        return { results: raw.prepare(sql).all(...values) };
      },
      async run() {
        const statement = raw.prepare(sql);
        if (statement.columns().length) return { results: statement.all(...values) };
        const r = statement.run(...values);
        return {
          meta: {
            changes: Number(r.changes),
            last_row_id: Number(r.lastInsertRowid),
          },
        };
      },
    };
  }
  let tail = Promise.resolve();
  const env = {
    raw,
    JWT_SECRET: "local-tests-only",
    DB: {
      prepare,
      batch(statements) {
        const task = tail.then(async () => {
          raw.exec("BEGIN");
          try {
            const out = [];
            for (const s of statements) out.push(await s.run());
            raw.exec("COMMIT");
            return out;
          } catch (e) {
            raw.exec("ROLLBACK");
            throw e;
          }
        });
        tail = task.catch(() => {});
        return task;
      },
    },
  };
  await ensureStudentTransfers(env);
  await ensureDashboardRevision(env);
  const files = new Map();
  const storage = {
    async validate(file) {
      if (!file?.size) return { error: "ไม่มีไฟล์" };
      return { mimeType: "application/pdf" };
    },
    async upload(env, file) {
      const id = crypto.randomUUID();
      files.set(id, new Uint8Array(await file.arrayBuffer()));
      return { id };
    },
    async read(env, id) {
      return files.get(id);
    },
    async remove(env, id) {
      files.delete(id);
    },
  };
  async function call(path = "", method = "GET", body, user = 1) {
    const token = user ? await signJWT({ sub: user }, env.JWT_SECRET) : null;
    const form = body instanceof FormData;
    const headers = { ...(token ? { Cookie: `bpd_session=${token}` } : {}) };
    if (!form) headers["Content-Type"] = "application/json";
    const request = new Request(
      "http://localhost/api/student-transfers" + path,
      {
        method,
        headers,
        body: body ? (form ? body : JSON.stringify(body)) : undefined,
      },
    );
    return handleStudentTransfers(
      request,
      env,
      new URL(request.url).pathname,
      method,
      storage,
    );
  }
  // Explicit fixture grant; production accounts receive no default grant.
  await call("/permissions/2", "PUT", { allowed: true });
  return { env, storage, files, call, revision: () => dashboardRevision(env) };
}
export const form = (extra = {}) => ({
  client_ref: crypto.randomUUID(),
  direction: "in",
  student_code: "2001",
  student_name: "เด็กหญิงณิชา พัฒนกิจ",
  grade_level: "มัธยมศึกษาปีที่ 2",
  school_name: "โรงเรียนวัฒนศึกษา",
  academic_year: 2569,
  term: 2,
  move_date: "2026-11-10",
  reason: "ย้ายที่อยู่ตามผู้ปกครอง",
  ...extra,
});
