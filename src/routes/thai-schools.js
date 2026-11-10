// รายชื่อ สพฐ. สำหรับทะเบียนย้าย จากข้อมูลนำเข้าและชุดอ้างอิงที่เผยแพร่พร้อมระบบ
import { getCurrentUser, jsonResponse } from "../lib/auth.js";
import schoolRows from "../data/obec-schools-2569-1.js";

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

const catalog = schoolRows.map(([school_code, smis_code, name, subdistrict, district, province]) =>
  ({ school_code, smis_code, name, subdistrict, district, province }),
);
const exactCode = (school, code) => school.school_code === code || school.smis_code === code;

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

    const { results } = await env.DB.prepare(
      "SELECT name FROM thai_schools WHERE school_code = ? OR smis_code = ?",
    ).bind(code, code).all();
    if (results.length && !name) return response({ status: "code_match" });
    if (results.some((school) => school.name === name))
      return response({ status: "match" });

    const matches = catalog.filter((school) => exactCode(school, code));
    if (matches.length && !name) return response({ status: "code_match" });
    if (matches.some((school) => school.name === name))
      return response({ status: "match" });
    if (matches.length || results.length) return response({ status: "mismatch" });

    const knownName = name && (
      catalog.some((school) => school.name === name) ||
      await env.DB.prepare("SELECT 1 FROM thai_schools WHERE name = ? LIMIT 1")
        .bind(name).first()
    );
    return response({ status: knownName ? "mismatch" : "unknown" });
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
    const query = q.toLowerCase();
    const schools = new Map();
    for (const school of catalog) {
      const matches = digits
        ? school.school_code.startsWith(q) || school.smis_code.startsWith(q)
        : school.name.toLowerCase().includes(query);
      if (matches) schools.set(school.school_code, school);
    }
    for (const school of rows.results) {
      const official = schools.get(school.school_code);
      // Keep the official SMIS when the imported row has no code or the official code was searched.
      const smis_code = official?.smis_code === q ? q : school.smis_code || official?.smis_code || "";
      schools.set(school.school_code, { ...school, smis_code });
    }

    const compare = digits
      ? (a, b) => Number(exactCode(b, q)) - Number(exactCode(a, q)) || a.school_code.localeCompare(b.school_code)
      : (a, b) => {
          const an = a.name.toLowerCase(), bn = b.name.toLowerCase();
          return Number(bn === query) - Number(an === query)
            || Number(bn.startsWith(query)) - Number(an.startsWith(query))
            || a.name.length - b.name.length
            || a.name.localeCompare(b.name, "th");
        };
    return response({ schools: [...schools.values()].sort(compare).slice(0, 20) });
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
