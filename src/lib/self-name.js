// แยก/รวมชื่อ–นามสกุล สำหรับหน้าบัญชีของฉัน (ครูแก้ชื่อตัวเอง) — คำนำหน้าเดิมคงไว้
const PREFIXES = ["ว่าที่ร้อยตรีหญิง", "ว่าที่ร.ต.หญิง", "ว่าที่ร้อยตรี", "ว่าที่ร.ต.", "นางสาว", "นาง", "นาย", "ดร.", "น.ส."];

const tidy = (v) => String(v ?? "").normalize("NFC").replace(/[​-‏⁠﻿]/g, "").replace(/\s+/g, " ").trim();

export function splitName(fullName, prefixHint = null) {
  let rest = tidy(fullName);
  let prefix = tidy(prefixHint) || "";
  if (prefix && rest.startsWith(prefix)) rest = rest.slice(prefix.length).trim();
  else if (!prefix) {
    const hit = PREFIXES.find((p) => rest.startsWith(p) && rest.length > p.length);
    if (hit) { prefix = hit; rest = rest.slice(hit.length).trim(); }
  }
  const i = rest.indexOf(" ");
  return { prefix: prefix || null, first_name: i < 0 ? rest : rest.slice(0, i), last_name: i < 0 ? "" : rest.slice(i + 1) };
}

// ชื่อที่ได้ต้องต่อคำนำหน้าแบบเดียวกับเดิม (มีเว้นวรรคหรือไม่มี)
export function joinName(prefix, first, last, spacedPrefix = true) {
  const body = [first, last].filter(Boolean).join(" ");
  if (!prefix) return body;
  return spacedPrefix ? `${prefix} ${body}` : `${prefix}${body}`;
}

export function hasSpacedPrefix(fullName, prefix) {
  if (!prefix) return true;
  const s = tidy(fullName);
  return !s.startsWith(prefix) || s.charAt(prefix.length) === " ";
}

export function validateNamePart(value, label) {
  const v = tidy(value);
  if (!v) return { error: `กรุณากรอก${label}` };
  if (v.length > 60 || /[\u0000-\u001f<>]/.test(v)) return { error: `${label}ต้องยาวไม่เกิน 60 ตัวอักษร และไม่มีอักขระ < >` };
  return { value: v };
}
