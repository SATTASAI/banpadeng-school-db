# ตรวจสถานะ deployment ของ Cloudflare ผ่าน GitHub Actions

Workflow นี้อ่านรายการ deployment ล่าสุดของ Worker `banpadeng-school-db` ผ่าน Cloudflare API โดยไม่แก้ไขการตั้งค่าหรือ deploy โค้ด และไม่แสดง token ในผลลัพธ์

## ตั้งค่าใน GitHub repository

ที่ `SATTASAI/banpadeng-school-db` ไปที่ **Settings → Secrets and variables → Actions**

1. แท็บ **Secrets**: สร้าง repository secret ชื่อ `CLOUDFLARE_STATUS_TOKEN` ด้วย Cloudflare API Token ที่จำกัดบัญชีโรงเรียนและสิทธิ์ `Workers Scripts: Read`
2. แท็บ **Variables**: สร้าง repository variable ชื่อ `CLOUDFLARE_ACCOUNT_ID` ด้วย Account ID 32 ตัวอักษรของบัญชีที่เป็นเจ้าของ Worker ค่านี้คือ Account ID เดียวกับที่ตั้งใน Worker สำหรับการสำรอง D1

ห้ามบันทึก token ใน repository หรือส่งในแชต หากตั้งค่าเพียง secret แต่ยังไม่มี variable งานตรวจจะหยุดพร้อมข้อความบอกสิ่งที่ขาด

## ใช้งาน

เปิดแท็บ **Actions → Check Cloudflare Worker deployment → Run workflow** หรือดูงานที่รันอัตโนมัติเมื่อมีการ push เข้า `main` แล้วอ่านผลใน **Summary** ของงาน

Cloudflare API รายงาน deployment ที่กำลังให้บริการเป็นลำดับแรก พร้อมเวลาและ version ID การที่ GitHub Actions ผ่านยืนยันได้ว่าคำขออ่าน deployment สำเร็จ แต่ **ไม่ได้ยืนยันว่า commit ที่ทำให้ workflow รันถูก deploy แล้ว** เนื่องจากการ build อาจใช้เวลาหรือถูกตั้งให้ upload version โดยยังไม่ promote ใช้หน้า Deployments ของ Cloudflare เพื่อยืนยัน commit/build หรือทดสอบหน้าจริงเมื่อจำเป็น

เอกสาร: [List Worker Deployments](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/) และ [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)
