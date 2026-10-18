# การเชื่อมระบบโรงเรียนกับ evaluatesystem

ระบบประเมินย้ายไป repo `SATTASAI/evaluatesystem` และ Worker `evaluatesystem` ที่ https://evaluate.banpadengschool.ac.th/ แล้ว แยกโค้ด หน้าเว็บ build และ deploy จาก `banpadeng-school-db`

ระบบโรงเรียนเหลือ:
- เมนูฝ่ายบริหารเปิดเว็บไซต์ประเมิน
- `GET /evaluation-connect` แสดงบัญชีโรงเรียนเพื่อยืนยันเข้าใช้ระบบประเมิน
- `POST /api/evaluation-link/authorize` ออกรหัสใช้ครั้งเดียวอายุ 120 วินาที
- `GET /api/evaluation/permissions` ตรวจสิทธิ์แสดงเมนู
- `GET /api/evaluation/results` อ่านเฉพาะผลที่ผู้บริหารยืนยันแล้วเพื่อแสดงในฝ่ายบุคลากร ครูเห็นเฉพาะผลที่ผูกกับบุคลากรของตนเอง
- `/evaluate` และ `/evaluate.html` เดิมส่งต่อไปเว็บไซต์ประเมิน
- API การสร้างรอบ/กรรมการ/เกณฑ์/บันทึกคะแนนบนระบบโรงเรียนเดิมตอบ 410 ให้ไป evaluatesystem

## การเชื่อมข้อมูล

ทั้งสอง Worker ผูก D1 `banpadeng_school_db` เดิมเพื่อเชื่อมด้วยรหัสบัญชีและบุคลากร ไม่คัดลอกทะเบียน ผู้ใช้ หรือคะแนนไปอีกชุด ตารางประเมินเดิมใช้ต่อได้ และการสำรองฐานเดิมครอบคลุมตารางเหล่านี้ด้วย

Worker ประเมินอ่าน `users`, `personnel_records`, `personnel_accounts`, `department_staff` เพื่อตรวจบัญชีและสิทธิ์ปัจจุบัน เขียนเฉพาะตารางประเมินและ session ของตนเอง ไม่มีหน้าแก้ทะเบียนโรงเรียนหรือ API งบประมาณ/นักเรียน/การลาใน Worker ประเมิน

ตารางประเมิน: `evaluation_templates`, `evaluation_cases`, `evaluation_assignments`, `evaluation_ballots`, `evaluation_events` เป็นของ evaluatesystem
ตารางเชื่อมบัญชี: `evaluation_login_requests`, `evaluation_login_sessions` ใช้ protocol `evaluation-link-v1`

## เข้าสู่ระบบ

1. ผู้ใช้เปิด evaluatesystem และกดเข้าสู่ระบบด้วยบัญชีโรงเรียน
2. evaluatesystem สร้าง state สุ่ม 256 บิต เก็บเฉพาะ hash ใน D1 และ host-only HttpOnly/Secure cookie อายุ 5 นาที
3. ส่งผู้ใช้ไปยืนยันบัญชีที่ `system.banpadengschool.ac.th/evaluation-connect` หากยังไม่เข้าโรงเรียนให้เข้าสู่ระบบปกติแล้วกลับหน้ายืนยัน
4. ระบบโรงเรียนตรวจ role/หัวหน้าฝ่ายล่าสุด และให้ผู้ใช้กดยืนยันด้วย POST จาก origin โรงเรียนเท่านั้น
5. ออกรหัสสุ่มใช้ครั้งเดียว 120 วินาที ผูกกับ state และ session_version ของบัญชี ส่งกลับ callback ที่กำหนดตายตัวบน evaluate hostname
6. evaluatesystem ตรวจ code/state/host cookie ให้ตรงกัน ใช้ code ได้ครั้งเดียว แล้วออก session ของตนเองสูงสุด 7 วัน

ไม่ส่งรหัสผ่านหรือ JWT โรงเรียนไป Worker ใหม่ และไม่ตั้ง cookie ร่วมทั้งโดเมน รหัสอนุมัติไม่ปรากฏใน logs และหน้าตอบตั้ง Referrer-Policy: no-referrer / Cache-Control: no-store

การเปลี่ยน session_version, ระงับบัญชี หรือเปลี่ยนหัวหน้าฝ่ายมีผลในการเข้าระบบประเมินทันที การออกจากระบบประเมินไม่ออกจากระบบโรงเรียน

กรรมการภายนอกใช้ลิงก์เชิญรายกรณีของ evaluatesystem ไม่ต้องมีบัญชีโรงเรียน และไม่มีสิทธิ์เข้าส่วนอื่นของโรงเรียน สิทธิ์สูงสุด 7 วันเพิกถอนได้ทันที

## Deploy และโดเมน

- repo โรงเรียน deploy เฉพาะ Worker `banpadeng-school-db` ตามเดิม
- repo `evaluatesystem` เชื่อม Worker `evaluatesystem` root `/`, deploy command `npx wrangler deploy`
- wrangler ของ repo ใหม่ระบุ Worker evaluatesystem, assets เฉพาะระบบประเมิน, D1 เดิม และ Custom Domain evaluate.banpadengschool.ac.th
- ลบ workflow ผูกโดเมนเข้ากับ Worker โรงเรียนเดิมแล้ว เพื่อไม่ให้สั่งเชื่อมผิดตัวในอนาคต

ก่อนเปิดรอบจริงยังต้องใส่เกณฑ์ ก.ค.ศ. ฉบับโรงเรียนให้ครบ โดยเฉพาะรายการย่อยครูผู้ช่วย ว19/2568 ระบบใหม่ยังห้ามยืนยันเกณฑ์ที่มีรายการชั่วคราว

## ทดสอบ

repo โรงเรียน: `node --test tests/*.test.mjs` รวมการเชื่อมบัญชี code ใช้ซ้ำ/หมดอายุ/คนละ browser/CSRF/เปลี่ยน session_version/ระงับบัญชี และผลเฉพาะเจ้าของ
repo ประเมิน: `node --test tests/*.test.mjs` ครอบคลุมสิทธิ์ เกณฑ์ คะแนน การล็อกผล กรรมการภายนอก และไม่ยอมรับ school cookie แทน session ของตนเอง
