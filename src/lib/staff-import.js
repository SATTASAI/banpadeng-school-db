function value(value, maxLength = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, maxLength) : null;
}

function identityName(name) {
  return String(name || "").normalize("NFC")
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, "")
    .replace(/^(?:ว่าที่ร้อยตรีหญิง|ว่าที่ร\.ต\.หญิง|ว่าที่ร้อยตรี|ว่าที่ร\.ต\.|นางสาว|นาง|นาย)\s*/, "")
    .replace(/[\s.]+/g, "").toLowerCase();
}

function storedName(name) {
  return String(name || "").normalize("NFC")
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, "")
    .replace(/[\s.]+/g, "").toLowerCase();
}

const PERSONNEL_TYPES = new Set(["executive", "teacher", "education_staff", "employee", "contractor", "other"]);
const EMPLOYMENT_STATUSES = new Set(["working", "leave", "transferred", "retired", "resigned"]);
const DATE_FIELDS = ["appointment_date", "service_start_date", "retirement_date", "license_issue_date", "license_expiry_date"];

function dateValue(row, field) {
  const result = value(row[field], 10);
  return !result || /^\d{4}-\d{2}-\d{2}$/.test(result) ? result : undefined;
}

export async function importStaffRows(env, rows) {
  let created = 0;
  let updated = 0;
  const skipped = [];
  const seenEmails = new Set();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || {};
    const email = String(row.email || "").trim().toLowerCase();
    const fullName = value(row.full_name, 200);
    const skip = (reason) => skipped.push({ row: i + 1, reason });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { skip("อีเมลไม่ถูกต้อง"); continue; }
    if (seenEmails.has(email)) { skip("อีเมลซ้ำในไฟล์เดียวกัน"); continue; }
    seenEmails.add(email);

    const rawPeriods = String(row.teaching_periods ?? "").trim();
    const periods = rawPeriods === "" ? null : Number(rawPeriods);
    if (rawPeriods && (!Number.isInteger(periods) || periods < 0 || periods > 100)) {
      skip("จำนวนคาบต้องเป็นจำนวนเต็ม 0–100"); continue;
    }
    const personnelType = value(row.personnel_type, 50);
    if (personnelType && !PERSONNEL_TYPES.has(personnelType)) {
      skip("ประเภทบุคลากรไม่ถูกต้อง"); continue;
    }
    const employmentStatus = value(row.employment_status, 50) || "working";
    if (!EMPLOYMENT_STATUSES.has(employmentStatus)) {
      skip("สถานะการปฏิบัติงานไม่ถูกต้อง"); continue;
    }
    const dates = Object.fromEntries(DATE_FIELDS.map((field) => [field, dateValue(row, field)]));
    if (Object.values(dates).some((item) => item === undefined)) {
      skip("วันที่ต้องอยู่ในรูปแบบ YYYY-MM-DD"); continue;
    }

    const user = await env.DB.prepare(
      "SELECT id, full_name FROM users WHERE lower(email) = ? AND status = 'active' AND role IS NOT NULL"
    ).bind(email).first();
    if (user && fullName && identityName(user.full_name) !== identityName(fullName)) {
      skip("ชื่อครูไม่ตรงกับบัญชีผู้ใช้อีเมลนี้"); continue;
    }

    let person = user ? await env.DB.prepare(
      "SELECT id, user_id, email, full_name FROM personnel_records WHERE user_id = ? AND status = 'active'"
    ).bind(user.id).first() : null;
    if (!person) person = await env.DB.prepare(
      "SELECT id, user_id, email, full_name FROM personnel_records WHERE lower(email) = ? AND status = 'active'"
    ).bind(email).first();
    const name = fullName || user?.full_name || person?.full_name;
    if (!name) { skip("ไม่มีชื่อครู"); continue; }
    if (person && (person.user_id && person.user_id !== user?.id || identityName(person.full_name) !== identityName(name))) {
      skip("ชื่อหรือบัญชีผู้ใช้ขัดกับข้อมูลบุคลากรเดิม"); continue;
    }
    if (!person) person = await env.DB.prepare(
      "SELECT id, user_id, email, full_name FROM personnel_records WHERE normalized_name = ? AND status = 'active'"
    ).bind(storedName(name)).first();
    if (person && (person.user_id && person.user_id !== user?.id ||
      person.email && person.email.trim().toLowerCase() !== email)) {
      skip("ชื่อครูตรงกับทะเบียนเดิม แต่อีเมลหรือบัญชีผู้ใช้ไม่ตรงกัน"); continue;
    }

    const fields = ["position_number", "position", "academic_rank", "subjects", "phone", "homeroom_classroom", "departments", "responsible_projects", "education_level", "major", "institution"];
    const values = fields.map((key) => value(row[key], key === "responsible_projects" ? 1500 : 500));
    try {
      if (person) {
        await env.DB.prepare(
          `UPDATE personnel_records SET user_id = COALESCE(user_id, ?), email = ?, full_name = ?,
             personnel_type = COALESCE(?, personnel_type), position_number = COALESCE(?, position_number),
             position = COALESCE(?, position), academic_rank = COALESCE(?, academic_rank),
             subjects = COALESCE(?, subjects), phone = COALESCE(?, phone),
             homeroom_classroom = COALESCE(?, homeroom_classroom), departments = COALESCE(?, departments),
             responsible_projects = COALESCE(?, responsible_projects),
             teaching_periods = COALESCE(?, teaching_periods),
             appointment_date = COALESCE(?, appointment_date), service_start_date = COALESCE(?, service_start_date),
             education_level = COALESCE(?, education_level), major = COALESCE(?, major),
             institution = COALESCE(?, institution), employment_status = COALESCE(?, employment_status),
             retirement_date = COALESCE(?, retirement_date), license_issue_date = COALESCE(?, license_issue_date),
             license_expiry_date = COALESCE(?, license_expiry_date), updated_at = datetime('now')
           WHERE id = ?`
        ).bind(user?.id || null, email, name, personnelType, values[0], values[1], values[2], values[3], values[4],
          values[5], values[6], values[7], periods, dates.appointment_date, dates.service_start_date,
          values[8], values[9], values[10], employmentStatus, dates.retirement_date,
          dates.license_issue_date, dates.license_expiry_date, person.id).run();
        updated++;
      } else {
        await env.DB.prepare(
          `INSERT INTO personnel_records
           (user_id, full_name, normalized_name, email, personnel_type, position_number, position, academic_rank,
            subjects, phone, homeroom_classroom, departments, responsible_projects, teaching_periods,
            appointment_date, service_start_date, education_level, major, institution, employment_status,
            retirement_date, license_issue_date, license_expiry_date, source_file)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'แบบฟอร์มนำเข้าข้อมูลครู')`
        ).bind(user?.id || null, name, storedName(name), email,
          personnelType, values[0], values[1], values[2], values[3], values[4], values[5], values[6], values[7], periods,
          dates.appointment_date, dates.service_start_date, values[8], values[9], values[10], employmentStatus,
          dates.retirement_date, dates.license_issue_date, dates.license_expiry_date).run();
        created++;
      }
    } catch {
      skip("บันทึกไม่สำเร็จ กรุณาตรวจข้อมูลซ้ำในทะเบียนครู");
    }
  }
  return { created, updated, skipped };
}
