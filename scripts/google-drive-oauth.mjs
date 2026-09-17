#!/usr/bin/env node
// สร้าง refresh token สำหรับบัญชี Google Drive กลางของโรงเรียนแบบใช้ครั้งเดียว
// ใช้: node scripts/google-drive-oauth.mjs CLIENT_ID CLIENT_SECRET
import http from "node:http";
import crypto from "node:crypto";

const [clientId, clientSecret] = process.argv.slice(2);
const redirectUri = "http://127.0.0.1:8787/oauth2callback";
if (!clientId || !clientSecret) {
  console.error("กรุณาระบุ CLIENT_ID และ CLIENT_SECRET");
  process.exit(1);
}

const state = crypto.randomBytes(24).toString("hex");
const params = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: "code",
  access_type: "offline",
  prompt: "consent",
  scope: "https://www.googleapis.com/auth/drive",
  state,
});
console.log("เปิด URL นี้ แล้วลงชื่อเข้าใช้ด้วย bbdschool2016@gmail.com:");
console.log(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
console.log(`\nต้องเพิ่ม Redirect URI ใน Google Cloud เป็น ${redirectUri}`);

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, redirectUri);
  if (url.pathname !== "/oauth2callback") { response.writeHead(404); response.end("Not found"); return; }
  if (url.searchParams.get("state") !== state) { response.writeHead(400); response.end("Invalid state"); return; }
  const code = url.searchParams.get("code");
  if (!code) { response.writeHead(400); response.end("No code"); return; }
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
  });
  const data = await tokenResponse.json();
  response.writeHead(tokenResponse.ok ? 200 : 500, { "Content-Type": "text/html; charset=utf-8" });
  response.end(tokenResponse.ok ? "เชื่อมต่อสำเร็จ ปิดหน้านี้ได้ แล้วกลับไปที่ Terminal" : "ขอ Token ไม่สำเร็จ");
  if (tokenResponse.ok) {
    console.log("\nGOOGLE_DRIVE_REFRESH_TOKEN (เก็บเป็น Secret เท่านั้น):\n" + (data.refresh_token || "ไม่พบ refresh token; ลองเพิ่ม prompt=consent ใหม่"));
    setTimeout(() => server.close(() => process.exit(0)), 250);
  } else {
    console.error(data);
    setTimeout(() => server.close(() => process.exit(1)), 250);
  }
});
server.listen(8787, "127.0.0.1", () => console.log("\nกำลังรอการอนุญาตจาก Google..."));
