// تحويل القالب النصي إلى رسالة نهائية باستبدال المتغيّرات {{name}}.
// المتغيّر غير المعروف يُستبدل بسطر فارغ (بدل ترك {{x}} ظاهرة للعميل) ويُبلَّغ عنه
// حتى تعرضه الواجهة كتحذير لمن يعدّل القالب.

export const TEMPLATE_VARIABLES = [
  ["showroom", "اسم المعرض"],
  ["currency", "العملة (مثل ر.س)"],
  ["customer", "اسم العميل/المشتري"],
  ["guarantor", "اسم الكفيل"],
  ["owner", "اسم مالك المركبة أو صاحب المعرض"],
  ["sale", "رقم عقد البيع"],
  ["mode", "نوع العملية: مباشر أو سيارة مملوكة للغير"],
  ["vehicle", "بيانات المركبة (الماركة/الموديل/اللوحات)"],
  ["installment", "رقم القسط الحالي"],
  ["installments", "إجمالي عدد الأقساط"],
  ["due", "تاريخ الاستحقاق"],
  ["amount", "قيمة القسط أو المبلغ المسدد"],
  ["paid", "المدفوع من القسط"],
  ["remaining", "المتبقي على القسط"],
  ["total_due", "إجمالي المتأخر على العميل"],
  ["seller_due", "مستحق المالك المتبقي"],
  ["days", "عدد أيام التأخير أو المتبقية"],
  ["status_line", "سطر الحالة (متأخر منذ ... / باقي ...)"],
  ["receipt", "رقم الإيصال"],
  ["method", "طريقة السداد"],
  ["date", "تاريخ السداد"],
  ["link", "رابط المستند في التطبيق"],
];

const VAR_RE = /\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi;

export function renderTemplate(template, vars = {}) {
  const missing = new Set();
  const substitute = (text) => String(text ?? "").replace(VAR_RE, (_match, key) => {
    const known = Object.prototype.hasOwnProperty.call(vars, key);
    if (!known) missing.add(key);
    const value = known ? vars[key] : "";
    return value === null || value === undefined ? "" : String(value);
  });

  // نُعالج سطرًا سطرًا: لو كان السطر في القالب غير فارغ (يحمل متغيّرات) وطلع فارغًا
  // بعد الاستبدال — مثل status_line اختيارية — نحذف السطر كله حتى لا يبقى فراغ
  // في منتصف الرسالة.
  const lines = String(template ?? "").split("\n").map((line) => {
    const rendered = substitute(line);
    if (rendered.trim() === "" && line.trim() !== "") return null;
    return rendered;
  });

  const body = lines
    .filter((line) => line !== null)
    // لا نترك سطرين فارغين متتاليين (قد تأتي من القالب نفسه)
    .filter((line, index, all) => !(line.trim() === "" && all[index - 1]?.trim() === ""))
    .join("\n")
    .trim();

  return { body, missing: [...missing] };
}

// المتغيّرات الموجودة فعليًا داخل قالب معيّن — تستخدمها الواجهة لعرض المتاح فقط.
export function variablesIn(template) {
  const found = new Set();
  for (const match of String(template ?? "").matchAll(VAR_RE)) found.add(match[1].toLowerCase());
  return [...found];
}
