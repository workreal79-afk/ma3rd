import test from "node:test";
import assert from "node:assert/strict";

import { addMonths, isValidDateString, localDateString } from "../src/utils/date.js";
import { asMoney, asPositiveMoney, asDate, optionalDate, requireText } from "../src/shared/validation.js";
import { escapeHtml, money, serialNumber } from "../src/utils/format.js";
import {
  amountInWordsArabic,
  formatDateArabic,
  tafqeet,
  toArabicDigits,
  hijriFromGregorian,
  documentPage,
} from "../src/utils/documents.js";
import { calculateInstallmentPlan } from "../src/modules/finance/installment.calculator.js";

// ملاحظة للمختبر: الاختبارات المعلَّمة بـ { todo: "DEFECT-..." } توثّق سلوكًا حاليًا
// يعتبر خللًا مسجلًا في تقرير الاختبار. تبقى معلَّمة حتى يتم إصلاح الخلل،
// وعندها يجب إزالة todo لأنها ستتحول تلقائيًا إلى اختبار ناجح.

// يحوّل الأرقام العربية-هندية إلى لاتينية ويوحّد فواصل الآلاف/العشرية
const stripSeparators = (value) => String(value)
  .replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d))
  .replace(/[٬،]/g, "")   // فاصلة الآلاف العربية
  .replace(/[٫]/g, ".")   // الفاصلة العشرية العربية
  .replace(/[^\d.]/g, "");

/* ------------------------------------------------------------------ */
/* utils/date.js                                                       */
/* ------------------------------------------------------------------ */

test("date: localDateString يعيد صيغة YYYY-MM-DD محلية بدون إزاحة توقيت", () => {
  const now = new Date();
  const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  assert.equal(localDateString(), expected);
  assert.equal(localDateString(new Date(2026, 0, 5, 0, 30)), "2026-01-05");
  assert.equal(localDateString(new Date(2026, 11, 31, 23, 59)), "2026-12-31");
});

test("date: isValidDateString يقبل التواريخ الصحيحة ويرفض المستحيلة", () => {
  assert.equal(isValidDateString("2026-09-27"), true);
  assert.equal(isValidDateString("2026-02-28"), true);
  assert.equal(isValidDateString("2028-02-29"), true); // سنة كبيسة
  assert.equal(isValidDateString("2026-02-29"), false);
  assert.equal(isValidDateString("2026-02-30"), false);
  assert.equal(isValidDateString("2026-04-31"), false);
  assert.equal(isValidDateString("2026-13-01"), false);
  assert.equal(isValidDateString("2026-00-10"), false);
  assert.equal(isValidDateString("2026-1-5"), false); // يحتاج أصفارًا
  assert.equal(isValidDateString("27-09-2026"), false);
  assert.equal(isValidDateString("2026/09/27"), false);
  assert.equal(isValidDateString(""), false);
  assert.equal(isValidDateString(null), false);
  assert.equal(isValidDateString(undefined), false);
});

test("date: addMonths يثبّت آخر يوم صالح في الشهر الهدف", () => {
  assert.equal(addMonths("2026-09-01", 1), "2026-10-01");
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonths("2028-01-31", 1), "2028-02-29");
  assert.equal(addMonths("2026-03-31", 1), "2026-04-30");
  assert.equal(addMonths("2026-05-31", 2), "2026-07-31");
  assert.equal(addMonths("2026-01-31", 13), "2027-02-28");
});

test("date: addMonths يعبر حدود السنة للأمام والخلف", () => {
  assert.equal(addMonths("2026-12-15", 1), "2027-01-15");
  assert.equal(addMonths("2026-12-15", 24), "2028-12-15");
  assert.equal(addMonths("2026-01-15", -1), "2025-12-15");
  assert.equal(addMonths("2026-03-31", -1), "2026-02-28");
  assert.equal(addMonths("2026-03-31", -12), "2025-03-31");
  assert.equal(addMonths("2026-09-27", 0), "2026-09-27");
});

test("date: addMonths يعيد نصًا فارغًا للمدخلات غير الصالحة", () => {
  assert.equal(addMonths("", 1), "");
  assert.equal(addMonths("2026-02-30", 1), "");
  assert.equal(addMonths("2026-09-27", 1.5), ""); // كسور غير مدعومة
});

test("date: addMonths يرفض NaN بدل معاملته كصفر", () => {
  assert.equal(addMonths("2026-09-27", NaN), "");
});

/* ------------------------------------------------------------------ */
/* shared/validation.js                                                */
/* ------------------------------------------------------------------ */

test("validation: requireText يتجاهل المسافات ويرفض الفارغ", () => {
  assert.equal(requireText("  أحمد  "), "أحمد");
  assert.throws(() => requireText("", "الاسم"), /الاسم مطلوب/);
  assert.throws(() => requireText("   ", "الاسم"), /الاسم مطلوب/);
  assert.throws(() => requireText(null, "الاسم"), /الاسم مطلوب/);
});

test("validation: asMoney يقبل الصفر ويرفض السالب وغير الرقمي", () => {
  assert.equal(asMoney(0), 0);
  assert.equal(asMoney("1500"), 1500);
  assert.equal(asMoney(1500.456), 1500.46); // تقريب لمنزلتين
  assert.throws(() => asMoney(-1), /غير صحيح/);
  assert.throws(() => asMoney("abc"), /غير صحيح/);
  assert.throws(() => asMoney(Infinity), /غير صحيح/);
  assert.throws(() => asMoney(NaN), /غير صحيح/);
  assert.throws(() => asMoney(undefined), /غير صحيح/);
});

test("validation: asMoney يرفض null", () => {
  assert.throws(() => asMoney(null), /غير صحيح/);
});

test("validation: asPositiveMoney يرفض الصفر والسالب", () => {
  assert.equal(asPositiveMoney(10), 10);
  assert.equal(asPositiveMoney(0.01), 0.01);
  assert.throws(() => asPositiveMoney(0), /أكبر من صفر/);
  assert.throws(() => asPositiveMoney(-5), /غير صحيح/);
  assert.throws(() => asPositiveMoney(""), /أكبر من صفر/);
});

test("validation: asDate و optionalDate", () => {
  assert.equal(asDate("2026-09-27"), "2026-09-27");
  assert.throws(() => asDate("2026-02-30"), /غير صحيح/);
  assert.throws(() => asDate(""), /غير صحيح/);
  assert.equal(optionalDate(""), null);
  assert.equal(optionalDate(null), null);
  assert.equal(optionalDate("2026-09-27"), "2026-09-27");
  assert.throws(() => optionalDate("30-09-2026"), /غير صحيح/);
});

/* ------------------------------------------------------------------ */
/* utils/format.js                                                     */
/* ------------------------------------------------------------------ */

test("format: serialNumber يزيل الأصفار البادئة ويحفظ البادئة النصية", () => {
  assert.equal(serialNumber("BILL-000123"), "BILL-123");
  assert.equal(serialNumber("REC-000001"), "REC-1");
  assert.equal(serialNumber("SALE-000012"), "SALE-12");
  assert.equal(serialNumber("0007"), "7");
  assert.equal(serialNumber("7"), "7");
  assert.equal(serialNumber(""), "");
  assert.equal(serialNumber(null), "");
  assert.equal(serialNumber(undefined), "");
  assert.equal(serialNumber("بدون-أرقام"), "بدون-أرقام");
});

test("format: escapeHtml يمنع تسريب HTML", () => {
  assert.equal(escapeHtml('<script>alert("x")</script>'), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  assert.equal(escapeHtml("a & b"), "a &amp; b");
  assert.equal(escapeHtml("it's"), "it&#039;s");
  assert.equal(escapeHtml("عادي"), "عادي");
  assert.equal(escapeHtml(""), "");
  assert.equal(escapeHtml(undefined), "");
});

test("format: escapeHtml(null) يعيد نصًا فارغًا", () => {
  assert.equal(escapeHtml(null), "");
});

test("format: money يعيد أرقامًا عربية-هندية صالحة للقراءة", () => {
  assert.equal(stripSeparators(money(1234.5)), "1234.5");
  assert.equal(stripSeparators(money(0)), "0");
  assert.equal(stripSeparators(money(null)), "0");
  assert.equal(stripSeparators(money(95000)), "95000");
  assert.equal(stripSeparators(money(1500.25)), "1500.25");
});

test("format: money يعيد صفرًا للقيمة غير الرقمية", () => {
  assert.equal(stripSeparators(money("abc")), "0");
  assert.equal(stripSeparators(money(NaN)), "0");
  assert.equal(stripSeparators(money(Infinity)), "0");
});

test("format: money في الخادم والواجهة يجب أن تتطابقا", () => {
  // نسخة طبق الأصل من client/src/services/api.js
  const clientMoney = (value) => {
    const n = Number(value ?? 0);
    if (!Number.isFinite(n)) return "0";
    return n.toLocaleString("ar-SA", { maximumFractionDigits: 2 });
  };
  for (const value of [0, 1500, 1500.5, 95000, "abc", null, undefined, NaN]) {
    assert.equal(money(value), clientMoney(value), `اختلاف عند القيمة ${String(value)}`);
  }
});

/* ------------------------------------------------------------------ */
/* finance/installment.calculator.js                                   */
/* ------------------------------------------------------------------ */

test("plan: قسمة صحيحة بدون باقي", () => {
  const plan = calculateInstallmentPlan({ total: 12000, monthlyAmount: 1000 });
  assert.equal(plan.fullCount, 12);
  assert.equal(plan.remainder, 0);
  assert.equal(plan.count, 12);
  assert.equal(plan.amounts.length, 12);
  assert.deepEqual(plan.amounts, new Array(12).fill(1000));
  assert.equal(plan.amounts.reduce((a, b) => a + b, 0), 12000);
});

test("plan: باقي صغير يصبح قسطًا مستقلًا افتراضيًا", () => {
  const plan = calculateInstallmentPlan({ total: 12500, monthlyAmount: 1000 });
  assert.equal(plan.remainder, 500);
  assert.equal(plan.smallRemainder, true);
  assert.equal(plan.count, 13);
  assert.equal(plan.amounts.at(-1), 500);
  assert.equal(plan.amounts.reduce((a, b) => a + b, 0), 12500);
});

test("plan: باقي صغير يمكن ضمه للقسط الأخير", () => {
  const plan = calculateInstallmentPlan({ total: 12500, monthlyAmount: 1000, combineSmallRemainder: true });
  assert.equal(plan.useCombined, true);
  assert.equal(plan.count, 12);
  assert.equal(plan.amounts.at(-1), 1500);
  assert.equal(plan.amounts.reduce((a, b) => a + b, 0), 12500);
});

test("plan: حد الضم هو 1000 ريال — 999 تُضم و1000 لا تُضم", () => {
  // 5499 = 3 × 1500 + 999  → باقي صغير يُضم
  const a = calculateInstallmentPlan({ total: 5499, monthlyAmount: 1500, combineSmallRemainder: true });
  assert.equal(a.remainder, 999);
  assert.equal(a.smallRemainder, true);
  assert.equal(a.count, 3);
  assert.equal(a.amounts.at(-1), 2499);
  assert.equal(a.amounts.reduce((x, y) => x + y, 0), 5499);

  // 5500 = 3 × 1500 + 1000 → الباقي ليس "صغيرًا" فلا يُضم
  const b = calculateInstallmentPlan({ total: 5500, monthlyAmount: 1500, combineSmallRemainder: true });
  assert.equal(b.remainder, 1000);
  assert.equal(b.smallRemainder, false);
  assert.equal(b.useCombined, false);
  assert.equal(b.count, 4);
  assert.equal(b.amounts.at(-1), 1000);
  assert.equal(b.amounts.reduce((x, y) => x + y, 0), 5500);
});

test("plan: باقي كبير (>= 1000) لا يُضم أبدًا", () => {
  const plan = calculateInstallmentPlan({ total: 12000, monthlyAmount: 5000, combineSmallRemainder: true });
  assert.equal(plan.remainder, 2000);
  assert.equal(plan.smallRemainder, false);
  assert.equal(plan.useCombined, false);
  assert.equal(plan.count, 3);
  assert.deepEqual(plan.amounts, [5000, 5000, 2000]);
});

test("plan: مبلغ يساوي القسط تمامًا يعيد قسطًا واحدًا", () => {
  const plan = calculateInstallmentPlan({ total: 1500, monthlyAmount: 1500 });
  assert.equal(plan.count, 1);
  assert.deepEqual(plan.amounts, [1500]);
});

test("plan: قسط أكبر من الإجمالي ينتج قسطًا واحدًا بقيمة الإجمالي (سلوك الحاسبة)", () => {
  // الطبقة العليا (POST /api/sales) ترفض هذه الحالة برسالة 400 قبل الوصول للحاسبة.
  const plan = calculateInstallmentPlan({ total: 1000, monthlyAmount: 5000 });
  assert.equal(plan.count, 1);
  assert.deepEqual(plan.amounts, [1000]);
});

test("plan: مدخلات غير صالحة مرفوضة", () => {
  assert.throws(() => calculateInstallmentPlan({ total: 0, monthlyAmount: 100 }), /غير صحيح/);
  assert.throws(() => calculateInstallmentPlan({ total: -100, monthlyAmount: 100 }), /غير صحيح/);
  assert.throws(() => calculateInstallmentPlan({ total: 1000, monthlyAmount: 0 }), /أكبر من صفر/);
  assert.throws(() => calculateInstallmentPlan({ total: 1000, monthlyAmount: -1 }), /أكبر من صفر/);
  assert.throws(() => calculateInstallmentPlan({ total: "abc", monthlyAmount: 100 }), /غير صحيح/);
  assert.throws(() => calculateInstallmentPlan({ total: 1000, monthlyAmount: "abc" }), /أكبر من صفر/);
});

test("plan: دقة عشرية — لا ينشأ قسط زائف من أخطاء الفاصلة العائمة", () => {
  const plan = calculateInstallmentPlan({ total: 0.3, monthlyAmount: 0.1 });
  assert.equal(plan.count, 3);
  assert.deepEqual(plan.amounts, [0.1, 0.1, 0.1]);

  const plan2 = calculateInstallmentPlan({ total: 100000.01, monthlyAmount: 10000 });
  assert.equal(plan2.fullCount, 10);
  assert.equal(plan2.count, 11);
  assert.equal(plan2.amounts.at(-1), 0.01);

  const plan3 = calculateInstallmentPlan({ total: 155000, monthlyAmount: 1500 });
  assert.equal(plan3.amounts.reduce((a, b) => a + b, 0), 155000);
});

test("plan: الباقي صفر موجب وليس -0", () => {
  const plan = calculateInstallmentPlan({ total: 0.3, monthlyAmount: 0.1 });
  assert.equal(Object.is(plan.remainder, 0), true);
});

/* ------------------------------------------------------------------ */
/* utils/documents.js                                                  */
/* ------------------------------------------------------------------ */

test("documents: toArabicDigits يحوّل الأرقام", () => {
  assert.equal(toArabicDigits("2026"), "٢٠٢٦");
  assert.equal(toArabicDigits("0123456789"), "٠١٢٣٤٥٦٧٨٩");
  assert.equal(toArabicDigits("ABC"), "ABC");
  assert.equal(toArabicDigits(""), "");
});

test("documents: formatDateArabic", () => {
  assert.equal(formatDateArabic("2026-09-27"), "٢٧ / ٠٩ / ٢٠٢٦ م");
  assert.equal(formatDateArabic(""), "-");
  assert.equal(formatDateArabic(null), "-");
  assert.equal(formatDateArabic("قيمة-خاطئة"), "قيمة-خاطئة");
});

test("documents: hijriFromGregorian يعيد تاريخًا هجريًا صالحًا", () => {
  const hijri = hijriFromGregorian("2026-09-27");
  assert.equal(typeof hijri, "string");
  assert.ok(hijri.length > 0, "التاريخ الهجري يجب ألا يكون فارغًا");
  assert.match(hijri, /هـ$/, "يجب أن ينتهي بعلامة هـ");
  assert.match(hijri, /[٠-٩]/, "يجب أن يحتوي أرقامًا عربية-هندية");
});

test("documents: tafqeet يكتب المبلغ بالأرقام العربية", () => {
  assert.match(tafqeet(1500, 0), /ريال$/);
  assert.match(tafqeet(1500, 50), /و٥٠ هللة$/);
  assert.equal(tafqeet(0, 0), "٠ ريال");
  assert.equal(tafqeet(95000, 0).replace(/\D/g, ""), "");
});

test("documents: tafqeet يستخدم فواصل وأرقامًا عربية متسقة", () => {
  assert.equal(tafqeet(1500, 0), "١٬٥٠٠ ريال");
});

test("documents: amountInWordsArabic — مفرد/مثنى/جمع وآلاف وملايين", () => {
  assert.equal(amountInWordsArabic(0), "صفر ريال سعودي");
  assert.equal(amountInWordsArabic(1), "واحد ريال سعودي");
  assert.equal(amountInWordsArabic(2), "اثنان ريال سعودي");
  assert.equal(amountInWordsArabic(10), "عشرة ريال سعودي");
  assert.equal(amountInWordsArabic(21), "واحد وعشرون ريال سعودي");
  assert.equal(amountInWordsArabic(100), "مائة ريال سعودي");
  assert.equal(amountInWordsArabic(1000), "ألف ريال سعودي");
  assert.equal(amountInWordsArabic(2000), "ألفان ريال سعودي");
  assert.equal(amountInWordsArabic(3000), "ثلاثة آلاف ريال سعودي");
  assert.equal(amountInWordsArabic(11000), "أحد عشر ألف ريال سعودي");
  assert.equal(amountInWordsArabic(1000000), "مليون ريال سعودي");
  assert.equal(amountInWordsArabic(2000000), "مليونان ريال سعودي");
  assert.equal(amountInWordsArabic(95000), "خمسة وتسعون ألف ريال سعودي");
});

test("documents: amountInWordsArabic — الهللة والسالب والمدخلات الشاذة", () => {
  const withHalala = amountInWordsArabic(1500.5);
  assert.match(withHalala, /^ألف/, "يجب أن تبدأ بألف");
  assert.match(withHalala, /خمسمائة/, "يجب أن تتضمن خمسمائة");
  assert.match(withHalala, /ريال سعودي/, "يجب أن تتضمن ريال سعودي");
  assert.match(withHalala, /وخمسون هللة$/, "يجب أن تنتهي بالهللة");
  assert.equal(amountInWordsArabic(-5), "سالب خمسة ريال سعودي");
  assert.equal(amountInWordsArabic(null), "صفر ريال سعودي");
  assert.equal(amountInWordsArabic("abc"), "صفر ريال سعودي");
  assert.equal(amountInWordsArabic(undefined), "صفر ريال سعودي");
  assert.ok(amountInWordsArabic(1e12).length > 0);
});

test("documents: documentPage ينتج صفحة A4 عربية RTL ويهرّب العنوان", () => {
  const html = documentPage("<b>عنوان</b>", "<div>المحتوى</div>");
  assert.ok(html.startsWith("<!doctype html>"));
  assert.match(html, /lang="ar" dir="rtl"/);
  assert.match(html, /&lt;b&gt;عنوان&lt;\/b&gt;/);
  assert.match(html, /<div>المحتوى<\/div>/);
  assert.match(html, /@page\{size:A4 portrait/);
});
