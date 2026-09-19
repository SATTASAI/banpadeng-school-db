#!/usr/bin/env node
// Verify a local Drive backup; --restore-to copies it into a new isolated directory.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile } from "node:fs/promises";
import { resolve, join, sep } from "node:path";

const usage = "Usage: node scripts/verify-drive-backup.mjs BACKUP_FOLDER [--restore-to NEW_EMPTY_FOLDER]";
const args = process.argv.slice(2);
if ((args.length !== 1 && args.length !== 3) || (args.length === 3 && args[1] !== "--restore-to")) {
  console.error(usage);process.exit(2);
}

async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

const backupDir = resolve(args[0]);
const restoreDir = args[2] ? resolve(args[2]) : null;
if (restoreDir && (restoreDir === backupDir || restoreDir.startsWith(backupDir + sep) || backupDir.startsWith(restoreDir + sep))) {
  throw new Error("พื้นที่ทดสอบต้องอยู่นอกโฟลเดอร์สำรอง");
}
const report = JSON.parse(await readFile(join(backupDir, "manifest.json"), "utf8"));
if (report.schema_version !== 1 || report.source !== "banpadeng-school-db" || !Array.isArray(report.files)) {
  throw new Error("รูปแบบ manifest ไม่ถูกต้อง");
}
if (!report.complete || !Number.isSafeInteger(report.expected_total) || report.files.length !== report.expected_total) {
  throw new Error("การสำรองยังไม่ครบ ตรวจ manifest.json และทำรายการใหม่");
}
const seen = new Set();
if (!(await lstat(join(backupDir, "files"))).isDirectory()) throw new Error("ไม่พบโฟลเดอร์ files ที่ถูกต้อง");
for (const file of report.files) {
  if (!Number.isSafeInteger(file.id) || file.id <= 0 || seen.has(file.id)) throw new Error("รหัสไฟล์ซ้ำหรือไม่ถูกต้อง");
  seen.add(file.id);
  const pathMatch = typeof file.local_path === "string" && file.local_path.match(/^files\/attachment-([1-9]\d*)(\.[A-Za-z0-9]{1,12})?$/);
  if (file.status !== "ok" || !pathMatch || Number(pathMatch[1]) !== file.id
    || !/^[a-f0-9]{64}$/.test(file.actual_sha256)) throw new Error(`รายการไฟล์ ${file.id} ไม่ถูกต้อง`);
  const source = join(backupDir, file.local_path);
  const info = await lstat(source);
  if (!info.isFile() || !Number.isSafeInteger(file.actual_size) || info.size !== file.actual_size
    || info.size !== Number(file.file_size)) throw new Error(`ขนาดไฟล์ ${file.id} ไม่ตรง`);
  const hash = await digest(source);
  if (hash !== file.actual_sha256 || file.sha256 && hash !== file.sha256) throw new Error(`SHA-256 ของไฟล์ ${file.id} ไม่ตรง`);
}
console.log(`Verified ${report.files.length} files in ${backupDir}`);

if (restoreDir) {
  // Exclusive mkdir: never overwrite an existing directory or production data.
  await mkdir(restoreDir);
  await mkdir(join(restoreDir, "files"));
  for (const file of report.files) {
    const target = join(restoreDir, file.local_path);
    await copyFile(join(backupDir, file.local_path), target);
    if (await digest(target) !== file.actual_sha256) throw new Error(`ทดสอบกู้คืนไฟล์ ${file.id} ไม่ผ่าน`);
  }
  await copyFile(join(backupDir, "manifest.json"), join(restoreDir, "manifest.json"));
  console.log(`Restore drill passed: ${restoreDir}`);
}
