# AGENTS.md — ระบบบริหารโรงเรียนบ้านป่าเด็ง (system)

ระบบหลักของโรงเรียน: บัญชีผู้ใช้/สิทธิ์ นักเรียน บุคลากร งานฝ่าย โครงการ งบประมาณ พัสดุ ใบลา สารบรรณ ประเมิน และเจ้าของฐาน D1 กลางที่ระบบอื่นใช้ร่วม

## ข้อมูลระบบ

- Cloudflare Worker `banpadeng-school-db` ตัวเดียว ทำทั้ง API และเสิร์ฟ `public/` (`run_worker_first: true`) · โดเมน `system.banpadengschool.ac.th`
- D1 `DB` = `banpadeng_school_db` (ฐานกลาง) และ `BANK_DB` = `banpadeng-school-bank-db` (ฐานธนาคารโรงเรียน)
- R2 `FILES` (`banpadeng-school-files`) + Google Drive (`FILE_STORAGE_PROVIDER=drive`) สำหรับไฟล์
- cron ทุก 2 นาที (`*/2 * * * *`) สำหรับงานคิว แจ้งเตือน และสำรอง — โค้ดใน `scheduled()` ต้องเร็วและไม่ scan หนัก
- แจ้งเตือนผ่าน school-notify (`NOTIFY_ORIGIN`, `NOTIFY_API_KEY`) และ LINE; passkey ด้วย `@simplewebauthn/server`
- JavaScript (ES modules) ไม่มี build step · Node 24 ใน CI

## วิธีทำงานในรีโปนี้ (สำหรับ agent)

1. อ่านไฟล์นี้, `README.md` และเอกสารใน `docs/` (ถ้ามี) ก่อนแก้ทุกครั้ง
2. ทำเฉพาะขอบเขตที่ได้รับมอบหมาย ไม่ refactor, ไม่เปลี่ยนชื่อไฟล์/ตาราง/endpoint และไม่อัปเกรด dependency ถ้าไม่ได้สั่ง
3. ถ้างานกระทบข้อมูลจริง สิทธิ์ผู้ใช้ เงิน หรือระบบอื่น ให้หยุดถามก่อนลงมือ
4. แก้ให้น้อยที่สุดที่ทำให้งานสำเร็จ และเขียน/ปรับ test ที่ครอบคลุมพฤติกรรมที่เปลี่ยน
5. รันคำสั่งตรวจในหัวข้อ "คำสั่ง" ให้ผ่านทั้งหมดก่อน commit
6. ตอบผู้ใช้เป็นภาษาไทย กระชับ ข้อความ UI ทั้งหมดเป็นภาษาไทย

## คำสั่ง

```sh
npm ci --ignore-scripts
node --check src/index.js            # syntax check (CI ทำเหมือนกัน)
node --test tests/*.test.mjs         # = npm test (95+ ไฟล์ test)
```

- CI: `.github/workflows/test-worker.yml` (test), `cloudflare-deploy.yml` และ `cloudflare-status.yml` (deploy/สถานะเมื่อ push `main`)
- เพิ่ม route ใหม่ให้เพิ่ม `node --check` ของไฟล์นั้นถ้าเป็นไฟล์เสี่ยง และเพิ่ม test ใน `tests/`

## โครงสร้างไฟล์

```
src/index.js        → router หลัก + เสิร์ฟหน้าเว็บ + scheduled()
src/routes/         → API แยกตามงาน (47 ไฟล์)
src/lib/            → auth, crypto, session, สิทธิ์, ข้อมูลบุคลากร/ใบลา/การเงิน
src/evaluation/     → โมดูลประเมิน (ใช้ร่วมกับ evaluatesystem)
src/data/           → ข้อมูลคงที่
public/             → หน้า HTML/CSS/JS (ไม่มี framework)
schema.sql          → โครงสร้างตารางหลัก
docs/               → เอกสารรายโมดูล — อ่านก่อนแก้โมดูลนั้น
tests/              → node:test (*.test.mjs)
CHANGELOG.md        → บันทึกเลขแพทช์กลางของทุกรีโปที่เชื่อมกัน
```

## ฐานข้อมูลกลาง `banpadeng_school_db` (ใช้ร่วมหลายระบบ)

ฐาน D1 นี้ใช้ร่วมกับ banpadeng-school-db (system), students-report, publicservice, bpdactivity,
teaching-media, evaluatesystem และ school-cooperative ความผิดพลาดที่นี่กระทบทุกระบบ

- เขียนได้เฉพาะตารางของรีโปนี้: ตารางหลักของ system ทั้งหมด (รีโปนี้เป็นเจ้าของ) — แต่ห้ามแตะตารางที่ระบบอื่นเป็นเจ้าของ: `gr_*`, `ps_*`, `activity_*`, `tm_*`, `coop_*`, `evaluation_*`
- ตารางของระบบอื่นอ่านอย่างเดียว: ตาราง prefix ของระบบอื่นตามรายการข้างต้น (อ่านได้เมื่อจำเป็น ไม่เขียน)
- ตาราง passkey กลาง (`auth_passkeys`, `auth_passkey_users`, `auth_passkey_challenges`, `auth_passkey_rates`) ใช้ร่วมทุกระบบ ห้ามเปลี่ยนโครงสร้าง
- schema สร้างอัตโนมัติด้วย `CREATE TABLE IF NOT EXISTS`/เพิ่มคอลัมน์แบบตรวจก่อน ห้าม `DROP`, `RENAME`, ลบคอลัมน์ หรือเปลี่ยนชนิดข้อมูล
- ห้ามรันคำสั่งเขียน/ลบบนฐานจริง (`--remote`) เพื่อทดสอบ; ใช้ฐาน local/shim หรือ fixture
- ระวังโควต้า D1: query ต้องใช้ index, จำกัดจำนวนแถว, ไม่ scan ทั้งตารางใน cron

## ฐานข้อมูล

- ระบบอื่นอ่าน `users`, `students`, `student_enrollments`, `academic_*`, `personnel_records` โดยตรง: ห้ามเปลี่ยนชื่อ/ชนิดคอลัมน์ หรือความหมายของ `role`/`status`
- `BANK_DB` เป็นข้อมูลเงินจริงของธนาคารโรงเรียน: อ่านเป็นหลัก การเขียนต้องได้รับคำสั่งชัดเจน
- การสำรองข้อมูล D1/Drive อธิบายใน `docs/d1-backup.md`, `docs/drive-backup.md`

## กติกาเฉพาะของระบบ (business rules)

- บทบาท `superadmin`, `executive` เป็นผู้ดูแลในหลายระบบโดยอัตโนมัติ — การเปลี่ยนความหมายกระทบทุกรีโป
- SSO ไประบบอื่นใช้รหัสใช้ครั้งเดียวอายุสั้น (เช่น `/api/publicservice-sso`) ห้ามยืดอายุหรือทำให้ใช้ซ้ำได้
- การ view-as, รีเซ็ตรหัสผ่าน, passkey, ความปลอดภัยบัญชี: ทำตาม `docs/view-as.md`, `docs/password-reset.md`, `docs/passkeys.md`, `docs/account-security.md`
- ขั้นตอนใบลา โครงการ การเบิกจ่าย พัสดุ: ทำตามเอกสารใน `docs/` ของแต่ละโมดูล ไม่เปลี่ยน workflow การอนุมัติโดยไม่ได้สั่ง

## ข้อตกลงการเขียนโค้ด

- เวลาและวันที่อิงเวลาไทย `Asia/Bangkok` (UTC+7) ทุกจุด ทั้งการคำนวณวัน ตัดรอบ และ cron; แสดงปีเป็น พ.ศ. แต่เก็บเป็น ISO/ค.ศ.
- SQL ใช้ prepared statement + `.bind()` เท่านั้น ห้ามต่อสตริงจากค่าที่ผู้ใช้ส่งมา
- ตรวจสิทธิ์ฝั่งเซิร์ฟเวอร์ทุก endpoint (role/status/session ปัจจุบันจากฐาน) อย่าเชื่อค่าจากหน้าเว็บ
- งานที่เขียนหลายแถวต้องเป็น atomic (`db.batch()`) และกันกดซ้ำ (idempotency key) เมื่อเป็นรายการเงินหรือรายการสำคัญ
- การลบข้อมูลสำคัญใช้ soft delete/ยกเลิกพร้อมเหตุผล และบันทึก audit แทนการลบแถว
- หน้าเว็บต้องใช้ได้บนมือถือ (iPhone Safari/PWA) และจอกว้าง ใช้ฟอนต์และสไตล์เดิมของรีโป
- escape ข้อความก่อนใส่ลง HTML เสมอ (กัน XSS) และอย่าเพิ่ม CDN/สคริปต์ภายนอกใหม่ถ้าไม่จำเป็น

## ความปลอดภัยและ secrets

- secret ที่ใช้: `JWT_SECRET`, `GOOGLE_DRIVE_*`, `LINE_*`, `RESEND_API_KEY`, `TURNSTILE_SECRET_KEY`, `NOTIFY_API_KEY`, `SCHOOL_SYNC_TOKEN`, `CLOUDFLARE_D1_BACKUP_TOKEN` — อ้างผ่าน `env` เท่านั้น
- `JWT_SECRET` ถูกใช้ร่วมโดย students-report, publicservice, school-cooperative — ห้ามเปลี่ยนจากรีโปนี้
- ห้าม commit secret, token, รหัสผ่าน, `.env`, `.dev.vars`, ไฟล์สำรองฐานข้อมูล หรือข้อมูลนักเรียน/บุคลากรจริงลง Git
- secret ตั้งผ่าน Cloudflare dashboard หรือ `wrangler secret put` เท่านั้น (`keep_vars: true` ทำให้ค่าที่ตั้งใน dashboard ไม่ถูกทับ)
- ข้อมูลนักเรียนเป็นข้อมูลส่วนบุคคลของผู้เยาว์: ห้าม log ชื่อ เลขประจำตัว ที่อยู่ หรือข้อมูลผู้ปกครองลง console/observability
- ห้ามปิดหรือผ่อนการตรวจสิทธิ์ การจำกัดความถี่ล็อกอิน Turnstile หรือ passkey เพื่อให้ทดสอบง่าย

## ห้ามแตะ / ต้องระวังเป็นพิเศษ

- `wrangler.jsonc` (ห้ามลบ; ห้ามแก้ `database_id`, ชื่อ bucket, cron โดยไม่ได้สั่ง)
- `schema.sql` และ migration ของตารางที่ระบบอื่นอ่าน
- logic สิทธิ์ใน `src/lib/auth*.js`, `*-permissions.js`, `*-access.js`
- เส้นทาง SSO/API ที่ระบบอื่นเรียก (school sync ของ bpd_timetable, SSO ของ publicservice/teaching-media/bpdactivity/evaluatesystem)

## ระบบที่เชื่อมกัน

- students-report, publicservice, bpdactivity, teaching-media, evaluatesystem, school-cooperative: ใช้ D1 และบัญชีร่วม
- school-notify: ส่งแจ้งเตือนมือถือ · bpd_timetable: service binding `SCHOOL_API` มาที่ Worker นี้
- แก้ API/ตารางที่ระบบอื่นใช้ ต้องตรวจโค้ดฝั่งรีโปนั้นด้วยและทำเป็นชุดแพทช์เดียวกัน

## Deploy

- push/merge เข้า `main` → GitHub Actions deploy ขึ้นจริงทันที ถือว่า `main` = production
- ห้าม push งานที่ test ไม่ผ่านเข้า `main`

## เลขเวอร์ชันกลาง (แพทช์ข้ามรีโป)

รีโปนี้เชื่อมกับระบบบริหารโรงเรียน (รีโปหลัก — เจ้าของ CHANGELOG กลาง) จึงอยู่ในขอบเขตแพทช์กลาง:

- ทุกชุดการแก้ไขที่ merge/push เข้า `main` ต้องออกเลขแพทช์ใหม่ใน
  [`SATTASAI/banpadeng-school-db/CHANGELOG.md`](https://github.com/SATTASAI/banpadeng-school-db/blob/main/CHANGELOG.md) รวมงานเอกสาร
- อ่านเลขล่าสุดจาก CHANGELOG นั้นก่อนเสมอ ห้ามนับเลขแยกในรีโปนี้
- งานเล็ก/กลางเพิ่มเลขส่วนที่สาม งานใหญ่เพิ่มเลขส่วนที่สอง งานหลายรีโปในชุดเดียวใช้เลขเดียวและลิงก์ PR ทุกรีโป
- รายละเอียดกติกาอยู่ใน `README.md` ของ banpadeng-school-db หัวข้อ "เวอร์ชันและบันทึก Patch Update"

## Checklist ก่อนเปิด PR / merge

- [ ] เพิ่มรายการแพทช์ใน `CHANGELOG.md` และอัปเดตเลขเวอร์ชันใน `README.md`
- [ ] test และ syntax check ทั้งหมดผ่าน
- [ ] ไม่มี secret/ข้อมูลจริงใน diff (`git diff --cached` ตรวจก่อน commit)
- [ ] ไม่แก้ `database_id`, `routes`, `services` และชื่อ Worker ใน wrangler config โดยไม่ได้สั่ง
- [ ] schema เปลี่ยนแบบเพิ่มเท่านั้น (add table/column) และรันซ้ำได้ ไม่ทำให้ข้อมูลเดิมหรือระบบอื่นพัง
- [ ] อัปเดต `README.md`/`docs/` เมื่อพฤติกรรมหรือขั้นตอนติดตั้งเปลี่ยน และบันทึกการตัดสินใจถาวรของผู้ใช้ลงไฟล์นี้
- [ ] commit/PR อธิบายเป็นภาษาไทยว่าเปลี่ยนอะไร เพราะอะไร และทดสอบอย่างไร
