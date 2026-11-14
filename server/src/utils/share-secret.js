import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

// سر توقيع روابط مشاركة المستندات. يُحفظ في مجلد البيانات بصلاحيات خاصة حتى تبقى الروابط صالحة بعد
// إعادة التشغيل. لإبطال كل الروابط الصادرة: احذف الملف .share-secret ثم أعد تشغيل النظام.
export function loadOrCreateShareSecret(dataDir) {
  const file = path.join(dataDir, ".share-secret");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch { /* الملف غير موجود بعد */ }
  fs.mkdirSync(dataDir, { recursive: true });
  const secret = randomBytes(32).toString("hex");
  fs.writeFileSync(file, secret, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* ويندوز لا يدعم chmod كاملًا */ }
  return secret;
}
