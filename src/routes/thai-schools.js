// รายชื่อโรงเรียน สพฐ. ทั้งประเทศ (รหัสสถานศึกษา 10 หลัก) — ใช้ค้นหาโรงเรียนเดิม/ปลายทางในทะเบียนย้าย
// นำเข้าจากไฟล์ Excel ของ สพฐ. ผ่านหน้า "นำเข้าข้อมูล" (superadmin เท่านั้น)
import { getCurrentUser, jsonResponse } from "../lib/auth.js";

const ready = new WeakSet();
const response = (data, status = 200) =>
  jsonResponse(data, status, { "Cache-Control": "no-store" });

export async function ensureThaiSchools(env) {
  if (ready.has(env.DB)) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS thai_schools (
      school_code TEXT PRIMARY KEY CHECK(length(school_code)=10),
      smis_code TEXT NOT NULL DEFAULT '', name TEXT NOT NULL,
      subdistrict TEXT NOT NULL DEFAULT '', district TEXT NOT NULL DEFAULT '',
      province TEXT NOT NULL DEFAULT '', area_name TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    env.DB.prepare(
      "CREATE INDEX IF NOT EXISTS idx_thai_schools_name ON thai_schools(name)",
    ),
  ]);
  ready.add(env.DB);
}

const clean = (value, max) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
// ตัด "โรงเรียน"/"ร.ร." นำหน้า เพื่อให้ค้นและแสดงผลสม่ำเสมอ
const schoolName = (value) =>
  clean(value, 200).replace(/^(โรงเรียน|ร\.ร\.)\s*/, "");

export async function handleThaiSchools(request, env, pathname, method) {
  if (!pathname.startsWith("/api/thai-schools")) return null;
  const user = await getCurrentUser(request, env);
  if (!user?.role) return response({ error: "กรุณาเข้าสู่ระบบ" }, 401);
  await ensureThaiSchools(env);

  if (pathname === "/api/thai-schools/verify" && method === "GET") {
    const params = new URL(request.url).searchParams;
    const code = params.get("code")?.trim();
    const name = schoolName(params.get("name"));
    if (!code)
      return response({ error: "กรุณาระบุรหัสสถานศึกษา" }, 400);

    const row = await env.DB.prepare(
      `WITH lookup(code, name) AS (VALUES (?, ?))
       SELECT CASE
         WHEN EXISTS (
           SELECT 1 FROM thai_schools
           WHERE (lookup.name = '' OR name = lookup.name)
             AND (school_code = lookup.code OR smis_code = lookup.code)
         ) THEN CASE WHEN lookup.name = '' THEN 'code_match' ELSE 'match' END
         WHEN EXISTS (
           SELECT 1 FROM thai_schools
           WHERE name = lookup.name OR school_code = lookup.code OR smis_code = lookup.code
         ) THEN 'mismatch'
         ELSE 'unknown'
       END AS status FROM lookup`,
    )
      .bind(code, name)
      .first();
    return response({ status: row.status });
  }

  if (pathname === "/api/thai-schools" && method === "GET") {
    const q = clean(new URL(request.url).searchParams.get("q"), 100)
      .replace(/^(โรงเรียน|ร\.ร\.)\s*/, "");
    if (!q) {
      const stats = await env.DB.prepare(
        "SELECT COUNT(*) total, MAX(updated_at) updated_at FROM thai_schools",
      ).first();
      return response({ schools: [], total: Number(stats.total), updated_at: stats.updated_at });
    }
    const digits = /^\d+$/.test(q);
    const rows = await env.DB.prepare(
      digits
        ? `SELECT school_code,smis_code,name,subdistrict,district,province FROM thai_schools
           WHERE school_code LIKE ? OR smis_code LIKE ?
           ORDER BY (school_code = ? OR smis_code = ?) DESC, school_code LIMIT 20`
        : `SELECT school_code,smis_code,name,subdistrict,district,province FROM thai_schools
           WHERE name LIKE ? ORDER BY (name=?) DESC, (name LIKE ?) DESC, length(name), name LIMIT 20`,
    )
      .bind(...(digits ? [q + "%", q + "%", q, q] : [`%${q}%`, q, q + "%"]))
      .all();
    return response({ schools: rows.results });
  }

  if (pathname === "/api/thai-schools/import" && method === "POST") {
    if (user.role !== "superadmin")
      return response({ error: "นำเข้ารายชื่อโรงเรียนได้เฉพาะผู้ดูแลระบบ" }, 403);
    const origin = request.headers.get("Origin");
    if (origin && origin !== new URL(request.url).origin)
      return response({ error: "ไม่อนุญาตคำขอจากเว็บไซต์อื่น" }, 403);
    const body = await request.json().catch(() => null);
    const rows = Array.isArray(body?.rows) ? body.rows.slice(0, 1000) : [];
    if (!rows.length) return response({ error: "ไม่มีข้อมูลให้นำเข้า" }, 400);
    const skipped = [],
      statements = [];
    rows.forEach((row, index) => {
      const code = clean(row?.school_code, 20).replace(/\D/g, ""),
        name = schoolName(row?.name);
      if (code.length !== 10 || !name) {
        skipped.push({ row: index + 1, reason: "รหัส 10 หลักหรือชื่อโรงเรียนไม่ถูกต้อง" });
        return;
      }
      statements.push(
        env.DB.prepare(
          `INSERT INTO thai_schools(school_code,smis_code,name,subdistrict,district,province,area_name)
           VALUES (?,?,?,?,?,?,?) ON CONFLICT(school_code) DO UPDATE SET smis_code=excluded.smis_code,
           name=excluded.name,subdistrict=excluded.subdistrict,district=excluded.district,
           province=excluded.province,area_name=excluded.area_name,updated_at=datetime('now')`,
        ).bind(
          code,
          clean(row.smis_code, 20).replace(/\D/g, ""),
          name,
          clean(row.subdistrict, 100).replace(/^(ตำบล|ต\.)\s*/, ""),
          clean(row.district, 100).replace(/^(อำเภอ|อ\.)\s*/, ""),
          clean(row.province, 100).replace(/^(จังหวัด|จ\.)\s*/, ""),
          clean(row.area_name, 150),
        ),
      );
    });
    if (statements.length) await env.DB.batch(statements);
    return response({ saved: statements.length, skipped });
  }
  return response({ error: "ไม่พบเส้นทาง" }, 404);
}
