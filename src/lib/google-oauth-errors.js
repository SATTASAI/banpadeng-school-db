// Only known OAuth codes are exposed; provider payloads can contain sensitive data.
const messages={
 invalid_grant:'โทเคนเชื่อมต่อหมดอายุหรือถูกยกเลิก ต้องเชื่อมต่อบัญชี Google Drive ใหม่',
 invalid_client:'Client ID หรือ Client Secret ไม่ถูกต้อง กรุณาตรวจการตั้งค่าแอป Google',
 unauthorized_client:'แอป Google ไม่ได้รับอนุญาตให้ใช้วิธีขอโทเคนนี้',
 invalid_scope:'ขอบเขตสิทธิ์ Google Drive ไม่ถูกต้อง',
 access_denied:'Google ปฏิเสธสิทธิ์เชื่อมต่อบัญชี',
 invalid_request:'คำขอโทเคน Google ไม่สมบูรณ์ กรุณาตรวจการตั้งค่าเชื่อมต่อ'
};
export function googleOAuthTokenError(status,data){const code=typeof data?.error==='string'&&Object.hasOwn(messages,data.error)?data.error:null;return `เชื่อมต่อ Google Drive ไม่สำเร็จ (${Number(status)||0})${code?` · ${code}: ${messages[code]}`:''}`;}
