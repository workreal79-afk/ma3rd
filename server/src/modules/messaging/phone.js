// تطبيع أرقام الهواتف إلى الصيغة الدولية بدون «+» كما يطلبها wa.me وWhatsApp Cloud API.
// الأرقام تُدخل يدويًا في المعرض فتأتي بأشكال مختلفة: 0551234567 / +966551234567 /
// 00966551234567 / 966551234567، وكلها يجب أن تنتهي إلى 966551234567.

// أطوال الأرقام المحلية (بدون كود الدولة) للدول الأكثر احتمالًا في الاستخدام.
const LOCAL_LENGTHS = { "966": 9, "20": 10, "971": 9, "974": 8, "973": 8, "965": 8, "968": 8, "962": 9 };
const DEFAULT_SA_CODE = "966";

export function latinDigits(value) {
  return String(value ?? "").replace(/[٠-٩۰-۹]/g, (digit) => {
    const index = "٠١٢٣٤٥٦٧٨٩".indexOf(digit);
    return String(index < 0 ? "۰۱۲۳۴۵۶۷۸۹".indexOf(digit) : index);
  });
}
export function digitsOnly(value) { return latinDigits(value).replace(/[^\d]/g, ""); }

export function normalizePhone(raw, defaultCountryCode = "966") {
  const cc = latinDigits(defaultCountryCode).trim();
  if (!/^[1-9]\d{0,3}$/.test(cc)) return null;
  let value = String(raw ?? "")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
    .trim();
  if (!value) return null;

  // بعض حقول Windows/RTL تُدخل «+» مرتين (أو + مع مسافات مخفية)، مثل:
  // +‏‪+966 55 188 4891‬‏. نطبعها إلى علامة + واحدة بدل رفض الرقم.
  value = value.replace(/[\s().-]/g, "");
  value = value.replace(/^\++/, "+");
  const hadPlus = value.startsWith("+");
  if (value.includes("+") && !(hadPlus && value.slice(1).indexOf("+") === -1)) return null;
  if (!/^[+0-9٠-٩۰-۹]+$/.test(value)) return null;
  let digits = digitsOnly(value);
  if (!digits) return null;

  const international = hadPlus || digits.startsWith("00");
  // 00966... → 966...
  if (digits.startsWith("00")) digits = digits.slice(2);
  // 0551234567 → 551234567 (رقم محلي بصفر سابق)
  else if (digits.startsWith("0")) digits = digits.replace(/^0+/, "");

  // داخل المعرض السعودي: أي رقم جوال محلي مكتوب بدون الصفر مثل 551234567
  // أو 0551234567 يُعتبر سعوديًا حتى لو كانت قيمة كود الدولة القديمة خاطئة.
  // هذا يمنع تفسير 55 على أنه مفتاح دولة (البرازيل).
  if (!international && digits.length === 9 && digits.startsWith("5")) {
    digits = DEFAULT_SA_CODE + digits;
  }

  // لو الرقم بدأ بكود الدولة بالفعل نتركه، وإلا نضيف الكود الافتراضي.
  if (!international && !digits.startsWith(cc) && !digits.startsWith(DEFAULT_SA_CODE)) {
    // قد يكون مكتوبًا بكود دولة آخر (مثل رقم مصري 201...) — نقبله لو طوله منطقي.
    const knownCc = Object.keys(LOCAL_LENGTHS).find((code) => digits.startsWith(code) && digits.length === code.length + LOCAL_LENGTHS[code]);
    if (!knownCc) digits = cc + digits;
  }

  // الطول النهائي المقبول: 8 أرقام على الأقل و15 كحد أقصى (حد E.164).
  if (digits.length < 8 || digits.length > 15 || digits.startsWith("0")) return null;

  // تحقق إضافي: لو أضفنا كود الدولة الافتراضي، يجب أن يكون طول الجزء المحلي
  // منطقيًا لتلك الدولة. بدونه «12345» كان يصبح 9661234567 ويُقبل وهو رقم ناقص.
  const matchedCc = Object.keys(LOCAL_LENGTHS).find((code) => digits.startsWith(code));
  if (matchedCc) {
    const localPart = digits.slice(matchedCc.length);
    const expected = LOCAL_LENGTHS[matchedCc];
    // نتسامح برقم واحد أقل (بعض الدول فيها أرقام أرضية أقصر من المحمولة).
    if (localPart.length < expected - 1 || localPart.length > expected + 1) return null;
  }
  return digits;
}

export function isValidPhone(raw, defaultCountryCode = "966") {
  return normalizePhone(raw, defaultCountryCode) !== null;
}

// عرض الرقم بشكل مقروء في السجلات: ‎+966 55 1234567
export function prettyPhone(digits) {
  if (!digits) return "";
  const cc = Object.keys(LOCAL_LENGTHS).find((code) => String(digits).startsWith(code) && String(digits).length >= code.length + LOCAL_LENGTHS[code] - 1);
  if (!cc) return `+${digits}`;
  const rest = String(digits).slice(cc.length);
  // نفصل كود الشبكة (رقمان في السعودية ومصر) ثم نترك الباقي كتلة واحدة
  // حتى لا يتفتت الرقم إلى مجموعات غير مألوفة للقارئ.
  const head = rest.slice(0, 2);
  const tail = rest.slice(2);
  return tail ? `+${cc} ${head} ${tail}` : `+${cc} ${head}`;
}
