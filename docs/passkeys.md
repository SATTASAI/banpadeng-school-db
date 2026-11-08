# Face ID / Passkey (protocol v1, Patch 1.2)

## การใช้งาน

1. เข้าสู่ระบบด้วยรหัสผ่านเดิม แล้วเปิด **ตั้งค่า Passkey** (ระบบหลัก: บัญชีของฉัน)
2. ตั้งชื่ออุปกรณ์ ยืนยันรหัสผ่านปัจจุบัน แล้วกด **เปิดใช้ Face ID / Passkey**
3. อุปกรณ์แสดงขั้นตอนบันทึก Passkey ใน iCloud Keychain / Google Password Manager / Windows Hello หรือผู้ให้บริการที่เลือก
4. ครั้งต่อไปกด **เข้าสู่ระบบด้วย Face ID / Passkey** โดยไม่ต้องพิมพ์อีเมลหรือรหัสผ่าน

การยืนยันจริงขึ้นกับอุปกรณ์ อาจเป็น Face ID, Touch ID, ลายนิ้วมือ หรือ PIN ไม่ได้เปิดกล้องถ่ายภาพส่งมาให้โรงเรียน รหัสผ่านเดิมยังใช้ได้ หากเปลี่ยนอุปกรณ์ ใช้ Passkey ที่ซิงก์ผ่านผู้ให้บริการเดิมหรือเข้าสู่ระบบด้วยรหัสผ่านแล้วเพิ่มใหม่ ลบ Passkey ที่ไม่ใช้ได้จากหน้าตั้งค่า (สูงสุด 10 รายการต่อบัญชี/realm)

## ขอบเขตที่ตรวจสอบจากโค้ด

| ระบบ / รีโป | วิธีใช้ |
| --- | --- |
| system / banpadeng-school-db | เพิ่มปุ่มหน้า login และการจัดการในบัญชีของฉัน |
| grades / students-report | เพิ่มปุ่มหน้า login และหน้าจัดการ Passkey |
| teachingmedia / teaching-media | เพิ่มปุ่มหน้า login และลิงก์ข้างเมนูออกจากระบบ |
| activity / bpdactivity | เพิ่มปุ่มในกล่องเข้าสู่ระบบและลิงก์ในแถบบัญชี |
| publicservice | เพิ่มปุ่มหน้า login และลิงก์ข้างเมนูออกจากระบบ |
| evaluate / evaluatesystem | ใช้ทางเข้า `/auth/start` เดิม ผ่าน login ของ system แล้วกลับระบบประเมิน สิทธิ์เดิมไม่เปลี่ยน |
| ทะเบียนย้าย / dmcreport | ใช้ session และหน้า login ของ system เดิม (client ติดตั้งใต้ system) |
| notify / school-notify | Passkey ของแอดมินแยกจากบัญชีครู ใช้ได้ทั้งหน้า admin และ inbox |
| banpadeng-school-banksaving (Cloudflare) | Passkey แยกตามบัญชีธนาคาร ใช้ session/สิทธิ์ธนาคารเดิม |

ห้าเว็บบัญชีโรงเรียนใช้ D1 `banpadeng_school_db`, namespace `school` และ RP ID `banpadengschool.ac.th` ร่วมกัน จึงลงทะเบียนครั้งเดียวแล้วเลือก Passkey เดิมในแต่ละเว็บได้ แต่แต่ละเว็บยังมี session และตรวจสิทธิ์ของตัวเอง ผู้ชมภายนอก/บัญชีรอสิทธิ์ไม่อนุญาตให้เพิ่ม Passkey ส่วนโดเมน workers.dev หรือ localhost ใช้ RP ID ของ host นั้นแยกจาก production

School Notify ใช้ namespace ที่เปลี่ยนตาม `ADMIN_PASSWORD` เมื่อเปลี่ยนรหัสแอดมิน Passkey และ session ของแอดมินเดิมใช้ต่อไม่ได้ ต้องลงทะเบียนใหม่ API_KEY ของระบบที่ส่งแจ้งเตือนยังทำงานเดิม และ API_KEY ใช้ลงทะเบียน Passkey ไม่ได้

ธนาคารใช้ฐานข้อมูลและบัญชีแยก ต้องลงทะเบียนของธนาคารต่างหาก การเปลี่ยนแปลงรีโป Cloudflare ไม่ได้ย้ายข้อมูลหรือ deploy แทน Apps Script `school-bank-appsscript` รุ่นเดิม

เว็บที่ไม่มีการล็อกอิน (`school-announcement`) และระบบที่ใช้ Google OAuth (`saitama-media`) ไม่ถูกสร้างบัญชีหรือเปลี่ยนวิธีรับรองตัวตนเพิ่ม ส่วน BPD_Timetable และ handicraftandart ใช้บัญชี/ฐานแยกและไม่ได้เชื่อมบัญชี banpadeng-school-db จึงอยู่นอกขอบเขตบัญชีโรงเรียนชุดนี้

## การติดตั้ง

- รัน `npm ci` ก่อนทดสอบหรือ build ทุกรีโป ใช้ `@simplewebauthn/server` 13.2.2 ที่ pin และ lock ไว้
- โครงสร้างตาราง `auth_passkey_users`, `auth_passkeys`, `auth_passkey_challenges`, `auth_passkey_rates` สร้างแบบ additive ในคำขอ Passkey แรก ไม่เปลี่ยนรหัสผ่าน บัญชี สิทธิ์ หรือ session เดิม
- School Notify เพิ่ม `notify_admin_sessions` (opaque bearer, เก็บ hash, อายุ 12 ชั่วโมง); logout จาก admin/inbox เพิกถอนบนเซิร์ฟเวอร์
- ไม่ต้องเพิ่ม secret หรือเปิดสิทธิ์กล้อง ต้องให้บริการ HTTPS และเปิดหน้าเข้าสู่ระบบใน Safari/Chrome ที่รองรับ WebAuthn
- ซอร์ส `src/lib/passkeys.js`, `public/passkeys-client.js` และส่วนกลางของ `public/passkeys.html` ใช้ protocol เดียวกันในทั้ง 7 รีโป `src/lib/school-passkeys.js` ใช้เหมือนกันในห้าเว็บบัญชีโรงเรียน หากเปลี่ยน protocol ต้องซิงก์สำเนาและตรวจทุก adapter

## ข้อบังคับของ protocol

- เซิร์ฟเวอร์ตรวจลายเซ็นผ่าน SimpleWebAuthn, challenge, RP ID, exact origin, user presence และ user verification; registration ใช้ discoverable credential และ attestation none
- challenge อายุ 5 นาที ผูกกับ cookie แบบ Secure/HttpOnly/SameSite=Strict, origin, purpose, namespace และบัญชี/session version สำหรับการเพิ่ม credential ใช้ `DELETE … RETURNING` เพื่อใช้ได้ครั้งเดียว
- จำกัดการขอ options ต่อ IP/namespace แบบ atomic (120 ครั้งใน 5 นาที) รวมกรณียืนยันรหัสผ่านไม่ผ่าน และจำกัดขนาด request
- ตรวจบัญชีจริงทุก login: active, ไม่ลบ, ไม่เป็นบัญชีผู้ชมภายนอก และมีบทบาทตามแอป; โหมดมุมมองบุคคลอื่นเพิ่ม Passkey แทนคนอื่นไม่ได้
- เก็บเฉพาะ credential public key, opaque user handle, counter, transports, ชื่ออุปกรณ์ และเวลาใช้งาน ไม่มีภาพใบหน้า ลายนิ้วมือ หรือ private key
- ใช้ CAS อัปเดต counter เพื่อกันการยืนยันพร้อมกันด้วย counter เดิม และตรวจ user handle ของ discoverable credential ให้ตรงบัญชี
- Password flow, การแจ้งอุปกรณ์ใหม่ และการเพิกถอน session เดิมยังทำงานตามแอปนั้น

## ผลตรวจสอบ

- Unit/integration ทดสอบลายเซ็น WebAuthn จริงด้วย authenticator จำลอง: registration, cross-origin school realms, login, ปลอม origin/signature/UV/userHandle, namespace แยก, replay, expiry, cookie binding, account version, rate cap และการลบ credential
- ทดสอบ Worker system จริง: ออก session เดิมและปฏิเสธบัญชีระงับ/ผู้ชม; Notify: API_KEY เพิ่ม credential ไม่ได้, Passkey เข้า inbox ได้, opaque session/logout/หมุนรหัสผ่าน; bank: บทบาท TELLER ไม่เปลี่ยนและบัญชีระงับเข้าไม่ได้
- ทดสอบ JavaScript browser client ด้วย DOM: แปลง binary options, serialization, bearer ของแอดมิน, ยกเลิกการสแกนแล้วปุ่มกลับมาใช้งานได้
- Wrangler deploy dry-run ผ่านทั้ง 7 รีโป การทดสอบนี้ไม่ยืนยันการ deploy production หรือการสแกน Face ID บน iPhone จริง
