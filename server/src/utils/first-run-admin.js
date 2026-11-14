import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { hashPassword } from "./passwords.js";

// أول تشغيل بلا بيانات دخول: ننشئ مديرًا بكلمة مرور عشوائية بدل أي كلمة افتراضية معروفة.
// كلمة المرور تُعرض مرة واحدة في نافذة التشغيل وتُحفظ في ملف خاص ليحذفه المستخدم بعد تغييرها.
// تعمل مع better-sqlite3 (prepare/get/run فقط) ولا تحتاج transaction.
export const FIRST_RUN_FILE = "FIRST-RUN-ADMIN.txt";

export function needsFirstRunAdmin({ db, authUser, authPassword }) {
  if (authUser && authPassword) return false;
  return !db.prepare("SELECT 1 FROM staff_users WHERE status='ACTIVE' LIMIT 1").get();
}

export function createFirstRunAdmin({ db, dataDir }) {
  let username = "admin";
  if (db.prepare("SELECT 1 FROM staff_users WHERE username=? COLLATE NOCASE").get(username)) {
    username = `admin-${randomBytes(2).toString("hex")}`;
  }
  const password = randomBytes(18).toString("base64url"); // 24 حرفًا
  const { salt, hash } = hashPassword(password);
  const result = db.prepare("INSERT INTO staff_users(username,password_salt,password_hash,role,status,created_by) VALUES(?,?,?,'ADMIN','ACTIVE','system')")
    .run(username, salt, hash);
  db.prepare("INSERT INTO audit_log(action,entity_type,entity_id,details,actor) VALUES('CREATE','STAFF_USER',?,?,'system')")
    .run(Number(result.lastInsertRowid), JSON.stringify({ username, role: "ADMIN", status: "ACTIVE", source: "first-run" }));
  const file = path.join(dataDir, FIRST_RUN_FILE);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, [
    "بيانات دخول المدير — أول تشغيل",
    `اسم المستخدم: ${username}`,
    `كلمة المرور: ${password}`,
    "",
    "غيّر كلمة المرور من صفحة «المستخدمون والصلاحيات» ثم احذف هذا الملف.",
    "",
  ].join("\n"), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* ويندوز */ }
  return { username, password, file };
}
