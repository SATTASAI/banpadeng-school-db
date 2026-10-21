# ความปลอดภัยบัญชี (system + grades)

ระบบบริหารโรงเรียน (`banpadeng-school-db`) และระบบรายงานผลการเรียน (`students-report`) ใช้ตาราง `users` และ D1 เดียวกัน
โค้ดส่วนนี้อยู่ใน `src/lib/auth-sessions.js` ซึ่ง **ต้องเหมือนกันทั้งสอง repo** (เทสต์ของ grades ตรวจให้เมื่อ clone สอง repo ไว้ข้างกัน)

## อุปกรณ์ที่เข้าสู่ระบบ (`auth_sessions`)
- เข้าสู่ระบบ/สมัครสำเร็จ → สร้าง session (`sid` สุ่ม 192 บิต) เก็บอุปกรณ์ (เบราว์เซอร์ + ระบบปฏิบัติการ) IP ประเทศ เวลาเริ่ม/ใช้ล่าสุด และระบบที่เข้า (`system`/`grades`)
- token มี `sid` → ทุกคำขอตรวจว่า session ยังไม่ถูกยกเลิก (อัปเดตเวลาใช้ล่าสุดทุก 5 นาที)
- token รุ่นเก่าที่ไม่มี `sid` ใช้ได้จนหมดอายุ 7 วัน · token งานเฉพาะ (`purpose`) ใช้แทนการเข้าสู่ระบบไม่ได้
- หน้า **บัญชีและความปลอดภัย** (`/account.html#devices`): ดูอุปกรณ์ของทั้งสองระบบ ออกจากระบบรายเครื่อง หรือทุกเครื่องยกเว้นเครื่องนี้
  ระบบผลการเรียนมีเมนู "อุปกรณ์และความปลอดภัย" ลิงก์มาหน้านี้
- ออกจากระบบ = ยกเลิก session นั้น · เปลี่ยนรหัสผ่าน/ตั้งรหัสใหม่/ออกทุกอุปกรณ์/ระงับบัญชี = ยกเลิกทุก session

API (system): `GET /api/auth/sessions`, `POST /api/auth/sessions/:id/revoke`, `POST /api/auth/sessions/revoke-others`

## แจ้งเตือนความปลอดภัย (`security_notifications`)
ส่งเข้ากระดิ่งของระบบบริหาร (`security:<id>`) และ LINE รายบุคคลผ่าน line-feed เดิม (cron ทุก 2 นาทีส่งรายการจากระบบผลการเรียนด้วย)
| เหตุการณ์ | ผู้รับ |
|---|---|
| เข้าสู่ระบบจากอุปกรณ์ที่บัญชีไม่เคยใช้ใน 180 วัน (การเข้าครั้งแรกของบัญชีไม่แจ้ง) | เจ้าของบัญชี |
| ใส่รหัสผิดครบ 5 ครั้ง → พัก 15 นาที (ไม่เกิน 1 ครั้ง/30 นาที) | เจ้าของบัญชี |
| เปลี่ยนรหัสผ่าน / ตั้งรหัสใหม่ทางอีเมล | เจ้าของบัญชี |
| เปลี่ยนบทบาท ระงับ/เปิดบัญชี (system) · ให้/ถอนสิทธิ์ทีมวัดผล (grades) | เจ้าของบัญชี + ผู้ดูแลระบบคนอื่น |

## กันบอท (Cloudflare Turnstile)
- หน้า: system `login` `register` `forgot-password` · grades `login` — Site Key อยู่ใน `public/js/turnstile.js`
- เซิร์ฟเวอร์ตรวจเมื่อตั้ง secret `TURNSTILE_SECRET_KEY` ใน Worker แล้วเท่านั้น (ยังไม่ตั้ง = ไม่บังคับ)
- Cloudflare ตอบไม่ได้ชั่วคราว → ปล่อยผ่าน (การล็อกรหัสผิด 5 ครั้งยังทำงาน) เพื่อไม่ให้ครูทั้งโรงเรียนเข้าระบบไม่ได้

## Security headers
ทุกคำตอบ: HSTS 1 ปี, `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` ปิดกล้อง/ไมค์/ตำแหน่ง
หน้า HTML: CSP อนุญาตเฉพาะเว็บตัวเอง cdnjs (xlsx/jszip/pdfmake) Google Fonts และ Turnstile · `frame-ancestors 'self'`, `object-src 'none'`
header ที่ route ตั้งเอง (เช่น `Referrer-Policy: no-referrer`) จะไม่ถูกทับ — เพิ่ม CDN ใหม่ต้องแก้ `CONTENT_SECURITY_POLICY`

## ทดสอบ
system `node --test tests/auth-sessions.test.mjs` · grades `node --test tests/security.test.mjs`
