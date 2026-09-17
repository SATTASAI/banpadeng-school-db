# ระบบจัดการงานและข้อมูลโรงเรียนบ้านป่าเด็ง — Foundation (ล็อกอิน/สิทธิ์)

ชุดนี้คือ **เฟสที่ 1 (ระบบพื้นฐาน)**: สมัครสมาชิก, ล็อกอิน, และหน้าจัดการสิทธิ์ผู้ใช้งาน
สร้างด้วย **Cloudflare Workers** (โค้ดฝั่งเซิร์ฟเวอร์ + เสิร์ฟหน้าเว็บในตัวเดียว) + **D1** (ฐานข้อมูล SQL)

> หมายเหตุ: เดิมออกแบบเป็น Cloudflare Pages + Pages Functions แต่ Cloudflare ได้รวมระบบ
> Pages เข้ากับ Workers ใหม่ ทำให้ต้องปรับมาใช้โครงสร้าง Worker เดียว (`src/index.js`)
> ที่ทำหน้าที่ทั้งรับ API และเสิร์ฟไฟล์หน้าเว็บจากโฟลเดอร์ `public/`

## โครงสร้างไฟล์
```
public/            → หน้าเว็บ (HTML/CSS/JS) ที่ผู้ใช้เห็น
src/index.js       → โค้ดฝั่งเซิร์ฟเวอร์ทั้งหมด (สมัคร/ล็อกอิน/จัดการผู้ใช้) + เสิร์ฟหน้าเว็บ
src/lib/           → ฟังก์ชันช่วย (เข้ารหัสรหัสผ่าน, session)
schema.sql         → คำสั่งสร้างตารางฐานข้อมูล
wrangler.jsonc     → ไฟล์ตั้งค่าโปรเจกต์ (จำเป็นต้องมี ห้ามลบ)
```

## วิธี Deploy (ผ่าน Cloudflare Dashboard + GitHub)

### ขั้นตอนที่ 1: สร้างฐานข้อมูล D1 (ถ้ายังไม่ได้ทำ)
1. Cloudflare Dashboard → **Workers & Pages** → แท็บ **D1**
2. **Create database** ตั้งชื่อ `banpadeng_school_db`
3. เปิดฐานข้อมูล → แท็บ **Console** → วางคำสั่งจากไฟล์ `schema.sql` → **Execute**

### ขั้นตอนที่ 2: อัปโหลดโค้ดขึ้น GitHub
1. สร้าง repository บน GitHub (private ก็ได้)
2. อัปโหลดไฟล์ทั้งหมดในโฟลเดอร์นี้เข้า repo (ลาก-วางทั้งโฟลเดอร์ผ่านหน้า "Upload files" ของ GitHub ได้เลย)
3. **สำคัญ:** ต้องมีไฟล์ `wrangler.jsonc` อยู่ที่รากของ repo ด้วย (ไม่ใช่แค่โฟลเดอร์ `public` และ `src`)

### ขั้นตอนที่ 3: สร้างโปรเจกต์ใน Cloudflare เชื่อมกับ GitHub
1. **Workers & Pages** → **Create application** → เชื่อมต่อกับ GitHub → เลือก repository ที่อัปโหลดไว้
2. ปล่อยค่า Build command / Deploy command เป็นค่าเริ่มต้น (ระบบจะรัน `npx wrangler deploy` ซึ่งจะอ่านค่าจาก `wrangler.jsonc` ให้เอง)
3. กด **Save and Deploy**

### ขั้นตอนที่ 4: ผูกฐานข้อมูล D1
1. ในโปรเจกต์ที่สร้าง → **Settings → Bindings → Add**
2. เลือก **D1 database**, Variable name = `DB`, เลือกฐานข้อมูล `banpadeng_school_db`
3. Save

### ขั้นตอนที่ 5: ตั้งค่า JWT_SECRET
1. **Settings → Variables and secrets → Add**
2. Type = **Secret**, Name = `JWT_SECRET`, Value = ข้อความสุ่มยาวๆ อย่างน้อย 32 ตัวอักษร
3. Save แล้วกด **Create deployment** ใหม่อีกครั้งให้ค่ามีผล

### ขั้นตอนที่ 6: ทดสอบใช้งาน
1. เปิดโดเมนของโปรเจกต์ (เช่น `xxx.workers.dev` หรือชื่อที่ตั้งไว้)
2. สมัครสมาชิกคนแรก — จะได้สิทธิ์ **ผู้ดูแลระบบ (superadmin)** อัตโนมัติ
3. คนถัดไปที่สมัครจะรอที่หน้า "รอกำหนดสิทธิ์" จนกว่าแอดมินจะเข้าไปที่หน้า **จัดการผู้ใช้งาน** แล้วกำหนดบทบาทให้

### การจัดเก็บไฟล์ใน Google Drive (แนะนำสำหรับระบบโรงเรียน)

บัญชี Google Drive เป้าหมายของโรงเรียนคือ `bbdschool2016@gmail.com` ระบบเก็บไฟล์จริงใน Google Drive ได้โดยตรง ส่วน D1 จะเก็บชื่อไฟล์ ขนาดไฟล์ สิทธิ์ และ `Drive File ID`
เท่านั้น ไฟล์จะไม่ถูกเปิดเป็นสาธารณะ ระบบ Worker จะตรวจสิทธิ์ผู้ใช้ก่อนเปิดไฟล์ทุกครั้ง

#### เตรียม Google Drive

1. สร้างโฟลเดอร์หลักใน Google Drive ของโรงเรียน เช่น `School Management Files`
2. คัดลอก Folder ID จาก URL ของโฟลเดอร์ (ค่าหลัง `/folders/`)
3. ใน Google Cloud Console สร้าง Project และเปิด **Google Drive API**
4. สร้าง OAuth Client (Web application) และเพิ่ม Authorized redirect URI เป็น `http://127.0.0.1:8787/oauth2callback`
5. ขอ refresh token โดยรัน `node scripts/google-drive-oauth.mjs CLIENT_ID CLIENT_SECRET` แล้วลงชื่อเข้าใช้ด้วย `bbdschool2016@gmail.com`
6. ใน Cloudflare Worker → **Settings → Variables and secrets** เพิ่มค่าเหล่านี้เป็น Secret:

   - `FILE_STORAGE_PROVIDER` = `drive`
   - `GOOGLE_DRIVE_CLIENT_ID`
   - `GOOGLE_DRIVE_CLIENT_SECRET`
   - `GOOGLE_DRIVE_REFRESH_TOKEN`
   - `GOOGLE_DRIVE_FOLDER_ID` = Folder ID ของโฟลเดอร์หลัก

ระบบจะสร้างโฟลเดอร์ย่อยให้อัตโนมัติตามปีการศึกษา ฝ่ายงาน และโมดูล เช่น
`เอกสารและคลังไฟล์/2569/ฝ่ายวิชาการ` หรือ `พัสดุและครุภัณฑ์/การตรวจสอบ`

หากยังไม่ตั้งค่า Drive ระบบยังรองรับ R2 เดิมเพื่อเปิดไฟล์เก่าหรือใช้เป็นโหมดชั่วคราว โดยกำหนด
`FILE_STORAGE_PROVIDER` เป็น `r2` และผูก R2 binding ชื่อ `FILES`:
1. Cloudflare Dashboard → **R2 Object Storage** → **Create bucket** ตั้งชื่อ เช่น `banpadeng-school-files`
2. เปิด Worker → **Settings → Bindings → Add → R2 bucket**
3. Variable name ต้องเป็น `FILES` และเลือก bucket ที่สร้างไว้
4. Save แล้วสร้าง deployment ใหม่ จากนั้นระบบคลังเอกสารและงานพัสดุจะอัปโหลด/เปิดไฟล์ผ่าน Worker ได้

ข้อจำกัดที่ระบบตรวจทั้งหน้าเว็บและ API:
- PDF ไม่เกิน 1 MB
- JPG, PNG, WEBP และ GIF ไม่เกิน 2 MB
- แนะนำสแกนเอกสารประมาณ 150 DPI ใช้ขาวดำ/Grayscale ตัดหน้าว่าง และเลือก PDF แบบบีบอัด

## บทบาท (Role) ในระบบ
- `teacher` — ครู
- `executive` — ผู้บริหาร (เข้าหน้าจัดการผู้ใช้งานได้)
- `staff` — เจ้าหน้าที่ธุรการ
- `superadmin` — ผู้ดูแลระบบ (เข้าหน้าจัดการผู้ใช้งานได้ สิทธิ์สูงสุด)

## โครงสร้างระบบปัจจุบัน

หน้าแดชบอร์ดจัดหมวดการทำงานไว้ 12 หมวด ได้แก่ แดชบอร์ดภาพรวม, ข้อมูลนักเรียน,
ข้อมูลครูและบุคลากร, ฝ่ายบริหารงานวิชาการ, ฝ่ายบริหารงานงบประมาณ,
ฝ่ายบริหารงานบุคคล, ฝ่ายบริหารงานทั่วไป, ระบบดูแลช่วยเหลือนักเรียน,
เอกสารและคลังไฟล์, รายงานและการส่งออกข้อมูล, ผู้ใช้งานและสิทธิ์
และระบบสำรองข้อมูลและความปลอดภัย

หัวข้อที่มีฐานข้อมูลและหน้าดำเนินการแล้วจะแสดงสถานะ `เปิดใช้งานแล้ว` ส่วนหัวข้อที่ยังไม่มี
workflow หรือฐานข้อมูลเฉพาะจะแสดงสถานะ `วางโครงสร้างแล้ว` เพื่อใช้เป็นแผนพัฒนาระยะถัดไป
โดยข้อมูลการมาเรียนยังคงอ้างอิงจาก Q-info เพื่อไม่บันทึกข้อมูลซ้ำ
