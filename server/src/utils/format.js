export function money(value) { const n = Number(value ?? 0); return Number.isFinite(n) ? n.toLocaleString("ar-SA", { maximumFractionDigits: 2 }) : "0"; }
export function formatAmountDigits(n) { return money(n); }
export function escapeHtml(s="") { return String(s ?? "").replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[ch])); }

export function serialNumber(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const match = raw.match(/(\d+)$/);
  if (!match) return raw;
  const prefix = raw.slice(0, match.index);
  const digits = String(Number(match[1]));
  return `${prefix}${digits}`;
}

// رقم الكمبيالة الظاهر للمستخدم يُحسب من بداية التسلسل ورقم القسط،
// وليس من عداد عالمي، حتى تكون الأرقام داخل كل مبايعة 1،2،3... بالترتيب.
export function billSerialNumber(billStartSerial, installmentNumber) {
  const start = Number(billStartSerial);
  const n = Number(installmentNumber);
  if (!Number.isInteger(start) || start < 1 || !Number.isInteger(n) || n < 1) return null;
  return start + n - 1;
}

// JSON داخل <script> ليس HTML عاديًا: نهرب < حتى لا يُغلق المهاجم الوسم.
export function safeJson(value) {
  return (JSON.stringify(value) ?? "null").replace(/[<>&\u2028\u2029]/g, (ch) => ({
    "<": "\\u003c", ">": "\\u003e", "&": "\\u0026", "\u2028": "\\u2028", "\u2029": "\\u2029",
  }[ch]));
}
