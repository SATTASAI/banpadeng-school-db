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

const officialSchoolOrigin = "https://info.bopp.go.th";
const exactSmis = /^\d{8}$/;
const sourceUnavailable = () =>
  response({ error: "ตรวจสอบกับฐานข้อมูล สพฐ. ไม่ได้ในขณะนี้" }, 502);

const htmlText = (value) =>
  clean(value, 200).replace(/&(amp|quot|apos|lt|gt|nbsp|#39);/g, (entity) =>
    ({ "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<",
       "&gt;": ">", "&nbsp;": " ", "&#39;": "'" })[entity],
  ).trim();

async function findOfficialSchool(code) {
  if (!exactSmis.test(code)) return null;
  const page = await fetch(officialSchoolOrigin + "/school/" + code, {
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (page.status === 404) return null;
  if (!page.ok) throw new Error("School directory unavailable");

  const html = await page.text();
  const fields = new Map(
    Array.from(
      html.matchAll(/<strong>([^<]+)<\/strong>\s*<div>([^<]*)<\/div>/g),
      ([, label, value]) => [htmlText(label), htmlText(value)],
    ),
  );
  const smis_code = fields.get("รหัสโรงเรียน (SMIS)");
  const school_code = fields.get("รหัสกระทรวง (10 หลัก)");
  const name = schoolName(htmlText(html.match(/<p class="school-subtitle">([^<]+)<\/p>/)?.[1]));
  if (smis_code !== code || !/^\d{10}$/.test(school_code) || !name) {
    throw new Error("Unexpected school directory response");
  }
  return {
    school_code,
    smis_code,
    name,
    subdistrict: fields.get("ตำบล") || "",
    district: fields.get("อำเภอ") || "",
    province: fields.get("จังหวัด") || "",
  };
}

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
    let matches = results;
    if (!matches.length) {
      try {
        const official = await findOfficialSchool(code);
        if (official) matches = [official];
      } catch {
        return sourceUnavailable();
      }
    }
    if (matches.length) {
      const status = !name
        ? "code_match"
        : matches.some((school) => school.name === name) ? "match" : "mismatch";
      return response({ status });
    }
    const knownName = name && await env.DB.prepare(
      "SELECT 1 FROM thai_schools WHERE name = ? LIMIT 1",
    ).bind(name).first();
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
    const schools = rows.results;
    if (exactSmis.test(q) && !schools.some((school) => school.smis_code === q)) {
      try {
        const official = await findOfficialSchool(q);
        if (official) {
          return response({
            schools: [official, ...schools.filter((school) => school.school_code !== official.school_code)].slice(0, 20),
          });
        }
      } catch {
        if (!schools.length) return sourceUnavailable();
      }
    }
    return response({ schools });
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
