// แปลงจำนวนเงินเป็นตัวอักษรภาษาไทย (แบบ BAHTTEXT) ใช้ในเอกสารจัดซื้อจัดจ้าง
import { cents } from "./project-finance.js";

const DIGITS = ["ศูนย์", "หนึ่ง", "สอง", "สาม", "สี่", "ห้า", "หก", "เจ็ด", "แปด", "เก้า"];
const PLACES = ["", "สิบ", "ร้อย", "พัน", "หมื่น", "แสน"];

function readChunk(text, hasHigher) {
  const digits = text.replace(/^0+/, "");
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    const d = Number(digits[i]), place = digits.length - i - 1;
    if (!d) continue;
    if (place === 1 && d === 1) out += "สิบ";
    else if (place === 1 && d === 2) out += "ยี่สิบ";
    else if (place === 0 && d === 1 && (hasHigher || digits.length > 1)) out += "เอ็ด";
    else out += DIGITS[d] + PLACES[place];
  }
  return out;
}

export function readThaiNumber(value) {
  const text = String(BigInt(value));
  if (text === "0") return DIGITS[0];
  if (text.length <= 6) return readChunk(text, false);
  const high = text.slice(0, -6), low = text.slice(-6);
  return readThaiNumber(high) + "ล้าน" + readChunk(low, true);
}

export function bahtText(amount) {
  const total = cents(amount);
  if (!Number.isSafeInteger(total) || total < 0) return "";
  const baht = Math.floor(total / 100), satang = total % 100;
  if (!baht && !satang) return "ศูนย์บาทถ้วน";
  return (baht ? readThaiNumber(baht) + "บาท" : "") + (satang ? readThaiNumber(satang) + "สตางค์" : "ถ้วน");
}
