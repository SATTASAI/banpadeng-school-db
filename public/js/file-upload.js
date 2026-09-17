// เตรียมไฟล์ภาพก่อนส่งขึ้นระบบ: ลดขนาดอัตโนมัติ โดยไม่แก้ไฟล์ต้นฉบับในเครื่อง
const MANAGED_IMAGE_LIMIT = 2 * 1024 * 1024;

function managedSizeText(bytes) {
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function loadManagedImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("อ่านรูปภาพไม่สำเร็จ")); };
    image.src = url;
  });
}

function canvasBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function prepareManagedImage(file) {
  if (!file || !String(file.type || "").startsWith("image/") || file.type === "image/gif" || file.size <= MANAGED_IMAGE_LIMIT) {
    return { file, originalSize: file?.size || 0, compressed: false };
  }
  if (file.size > 20 * 1024 * 1024) throw new Error("รูปภาพมีขนาดเกิน 20 MB กรุณาถ่ายใหม่หรือลดขนาดก่อนเลือกไฟล์");
  const image = await loadManagedImage(file);
  const maxSide = 1920;
  let scale = Math.min(1, maxSide / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height));
  let width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
  let height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));
  const canvas = document.createElement("canvas");
  let blob = null;
  // WebP ช่วยลดขนาดได้ดี; ถ้า browser ไม่รองรับจะ fallback เป็น JPEG
  const formats = ["image/webp", "image/jpeg"];
  for (const type of formats) {
    for (let quality = 0.82; quality >= 0.42; quality -= 0.08) {
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext("2d", { alpha: type !== "image/jpeg" });
      if (!context) break;
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      if (type === "image/jpeg") { context.fillStyle = "#ffffff"; context.fillRect(0, 0, width, height); }
      context.drawImage(image, 0, 0, width, height);
      const candidate = await canvasBlob(canvas, type, quality);
      if (candidate && candidate.size <= MANAGED_IMAGE_LIMIT) { blob = candidate; break; }
    }
    if (blob) break;
  }
  if (!blob) throw new Error("ระบบลดขนาดรูปแล้วยังเกิน 2 MB กรุณาเลือกรูปที่เล็กลง");
  const extension = blob.type === "image/webp" ? "webp" : "jpg";
  const baseName = String(file.name || "ภาพแจ้งซ่อม").replace(/\.[^.]+$/, "");
  const prepared = new File([blob], `${baseName}.${extension}`, { type: blob.type, lastModified: Date.now() });
  return { file: prepared, originalSize: file.size, compressed: true };
}
