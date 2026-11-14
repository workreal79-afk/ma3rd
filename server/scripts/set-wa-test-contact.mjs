import { db } from "../src/db/index.js";

const demoName = "خالد أحمد الزهراني";
const demoId = "1098765432";
const demoOldPhone = "0551111111";
const testPhone = "0551884891";

const row = db.prepare(`SELECT id,name,national_id,phone FROM customers WHERE name=? AND national_id=?`).get(demoName, demoId);
if (!row) {
  console.error("لم أجد عميل الاختبار التجريبي. لم يتم تعديل أي بيانات.");
  process.exitCode = 1;
} else if (row.phone && row.phone !== demoOldPhone) {
  console.error(`عميل الاختبار موجود لكن رقمه الحالي (${row.phone}) ليس الرقم التجريبي المتوقع؛ لن أغيره.`);
  process.exitCode = 1;
} else {
  db.prepare(`UPDATE customers SET phone=? WHERE id=?`).run(testPhone, row.id);
  console.log(`تم ضبط ${row.name} على رقم اختبار سعودي: ${testPhone}`);
  console.log(`الصيغة الدولية المتوقعة: +966 55 1884891`);
}
db.close();
