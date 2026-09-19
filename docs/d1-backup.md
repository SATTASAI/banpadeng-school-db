# สำรองฐานข้อมูล D1 ของโรงเรียน

หน้า **ความปลอดภัยและสำรองข้อมูล** เปิดให้ผู้บริหารดูสถานะได้ แต่ปุ่มส่งออกไฟล์ SQL ใช้ได้เฉพาะ `superadmin` เท่านั้น

## ตั้งค่าก่อนใช้ปุ่มส่งออก

1. สร้าง Cloudflare API Token สำหรับบัญชีที่เป็นเจ้าของฐานข้อมูล D1 โดยให้สิทธิ์ **D1 Edit** เฉพาะบัญชีนี้ และเก็บ Token เป็นความลับ
2. ที่ Worker `banpadeng-school-db` เพิ่ม `CLOUDFLARE_ACCOUNT_ID` เป็น **Variable** โดยใช้ Account ID จริงจากหน้า Cloudflare Dashboard
3. เพิ่ม `CLOUDFLARE_D1_BACKUP_TOKEN` เป็น **Secret** โดยใส่ Token ที่สร้างในข้อแรก ห้ามบันทึกลง GitHub หรือไฟล์ `wrangler.jsonc`
4. หลังบันทึกและให้ Worker ใช้ค่าดังกล่าว เปิดหน้า `/security.html` ด้วยบัญชีผู้ดูแลระบบ ตรวจว่าขึ้น “พร้อมส่งออกฐานข้อมูล” แล้วกดปุ่มดาวน์โหลด
5. ตรวจขนาดไฟล์และเปิดดูว่า SQL มี `CREATE TABLE` และ `INSERT INTO` ก่อนนำไปเก็บในพื้นที่ที่โรงเรียนกำหนด

การส่งออกใช้ API ของ Cloudflare และอาจทำให้ D1 ตอบคำขออื่นชั่วคราวไม่ได้ขณะส่งออก จึงควรเลือกเวลาที่มีผู้ใช้งานน้อย ประวัติในระบบบันทึกว่าเริ่มดาวน์โหลดแล้ว แต่ไม่ได้ยืนยันว่าผู้ใช้เก็บไฟล์สำเร็จ ต้องตรวจไฟล์บนเครื่องด้วย

ไฟล์ SQL นี้มีเฉพาะฐานข้อมูล D1 **ไม่รวมเอกสารและรูปภาพใน Google Drive** การสำรองไฟล์ Drive ต้องทำแยกต่างหาก การกู้คืนให้ทดลองนำเข้าในฐานข้อมูลทดสอบและตรวจข้อมูลก่อนแตะฐานข้อมูลจริง

เอกสาร Cloudflare: [D1 export](https://developers.cloudflare.com/d1/best-practices/import-export-data/) และ [D1 export API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/)
