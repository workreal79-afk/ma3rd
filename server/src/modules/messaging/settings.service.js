import { latinDigits } from "./phone.js";
// إعدادات ميزة واتساب. كل قيمة تُخزَّن نصًا في جدول settings، وتُقرأ هنا بأنواعها.
// أي مفتاح غير محفوظ يرجع إلى قيمته الافتراضية، فلا يفشل النظام على قاعدة بيانات قديمة.

export const MESSAGE_KINDS = [
  "COLLECTION_INVOICE",
  "OVERDUE_REMINDER",
  "DUE_REMINDER",
  "PAYMENT_RECEIPT",
  "GUARANTOR_NOTICE",
];

export const PROVIDERS = ["LINK", "WEB", "CLOUD"];
export const COUNTRY_CODES = ["966", "20", "971", "974", "973", "965", "968", "962"];

const T = {
  collectionCustomer: `{{showroom}}
فاتورة تحصيل — عقد {{sale}}

العميل: {{customer}}
المركبة: {{vehicle}}
القسط: {{installment}} من {{installments}}
تاريخ الاستحقاق: {{due}}
قيمة القسط: {{amount}} {{currency}}
المدفوع: {{paid}} {{currency}}
المتبقي: {{remaining}} {{currency}}
إجمالي المتأخر عليكم: {{total_due}} {{currency}}

📄 المستند: {{link}}`,

  collectionOwner: `{{showroom}} — إشعار تحصيل
عقد {{sale}} ({{mode}})

العميل: {{customer}}
المالك: {{owner}}
المركبة: {{vehicle}}
القسط: {{installment}} من {{installments}}
المستحق في: {{due}}
قيمة القسط: {{amount}} {{currency}}
المتبقي على العميل: {{remaining}} {{currency}}
مستحق المالك: {{seller_due}} {{currency}}

📄 المستند: {{link}}`,

  reminderCustomer: `{{showroom}}
تذكير بموعد سداد

العميل: {{customer}}
العقد: {{sale}}
القسط: {{installment}} من {{installments}}
تاريخ الاستحقاق: {{due}}
المبلغ المطلوب: {{remaining}} {{currency}}
{{status_line}}
برجاء السداد في الموعد المقرر تجنّبًا لاتخاذ الإجراءات المنصوص عليها في العقد.

📄 التفاصيل: {{link}}`,

  reminderGuarantor: `{{showroom}}
إشعار للكفيل

الكفيل: {{guarantor}}
المكفول: {{customer}}
العقد: {{sale}}
القسط: {{installment}} من {{installments}}
تاريخ الاستحقاق: {{due}}
المبلغ المتأخر: {{remaining}} {{currency}}
مدة التأخير: {{days}} يوم

نأمل التكرم بالتواصل مع المكفول لسداد المبلغ المستحق، وذلك بموجب كفالتكم الموقّعة في العقد.

📄 التفاصيل: {{link}}`,

  receiptCustomer: `{{showroom}}
إيصال سداد {{receipt}}

العميل: {{customer}}
العقد: {{sale}}
المركبة: {{vehicle}}
المبلغ المسدد: {{amount}} {{currency}}
طريقة السداد: {{method}}
تاريخ السداد: {{date}}
المتبقي بعد السداد: {{remaining}} {{currency}}

شكرًا لتعاملكم معنا.
📄 الإيصال: {{link}}`,

  receiptOwner: `{{showroom}} — نسخة تحصيل
إيصال {{receipt}} — عقد {{sale}} ({{mode}})

العميل: {{customer}}
المالك: {{owner}}
المبلغ المحصّل: {{amount}} {{currency}}
تاريخ السداد: {{date}}
مستحق المالك المتبقي: {{seller_due}} {{currency}}

📄 الإيصال: {{link}}`,
};

// القيم الافتراضية. المفاتيح المرتّبة: هوية المعرض ← الإرسال ← تفعيل الأنواع ←
// سياسة التذكيرات ← الكفيل ← القوالب.
export const DEFAULTS = {
  "showroom.name": "معرض الزبيدي للسيارات",
  "showroom.phone": "",
  "showroom.currency": "ر.س",

  "whatsapp.enabled": "1",
  "whatsapp.provider": "WEB",
  // WhatsApp Web المحلي: لا يحتاج API مدفوع. تُحفظ الجلسة على نفس الجهاز.
  "whatsapp.web.minDelaySeconds": "45",
  "whatsapp.web.maxDelaySeconds": "90",
  "whatsapp.defaultCountryCode": "966",
  // رابط التطبيق العام لبناء روابط المستندات. لو تُرك فارغًا يُشتق من طلب المستخدم.
  "whatsapp.baseUrl": "",
  // Meta WhatsApp Cloud API — تُملأ فقط لو اختير المزوّد CLOUD.
  "whatsapp.cloud.phoneId": "",
  "whatsapp.cloud.token": "",
  // أسماء قوالب ميتا المعتمدة (إلزامية للرسائل التي يبدأها النشاط التجاري).
  "whatsapp.cloud.template.reminder": "",
  "whatsapp.cloud.template.invoice": "",
  "whatsapp.cloud.template.receipt": "",
  // ترتيب متغيرات قالب Meta: أسماء المتغيرات مفصولة بفواصل، مثل customer,sale,amount,link.
  "whatsapp.cloud.params.reminder": "showroom,customer,sale,installment,due,remaining,link",
  "whatsapp.cloud.params.invoice": "showroom,customer,sale,installment,due,amount,remaining,link",
  "whatsapp.cloud.params.receipt": "showroom,customer,sale,amount,method,date,remaining,link",

  "msg.collectionInvoice.customer": "1",
  "msg.collectionInvoice.owner": "1",
  "msg.dueReminder.customer": "1",
  "msg.overdueReminder.customer": "1",
  "msg.overdueReminder.guarantor": "1",
  "msg.paymentReceipt.customer": "1",
  "msg.paymentReceipt.owner": "1",

  "reminder.beforeDays": "3",
  "reminder.onDueDate": "1",
  "reminder.afterOverdueDays": "1,7,15,30",
  "reminder.maxPerInstallment": "6",
  "reminder.quietStart": "21:00",
  "reminder.quietEnd": "09:00",
  // أيام الأسبوع الممنوعة (0=الأحد ... 5=الجمعة ... 6=السبت)
  "reminder.skipWeekdays": "5",
  "reminder.dailyCap": "60",
  "reminder.dedupeHours": "20",
  "reminder.autoRun": "1",
  "reminder.scheduleTime": "09:00",

  "guarantor.graceDays": "7",

  "template.collectionInvoice.customer": T.collectionCustomer,
  "template.collectionInvoice.owner": T.collectionOwner,
  "template.dueReminder.customer": T.reminderCustomer,
  "template.overdueReminder.customer": T.reminderCustomer,
  "template.overdueReminder.guarantor": T.reminderGuarantor,
  "template.paymentReceipt.customer": T.receiptCustomer,
  "template.paymentReceipt.owner": T.receiptOwner,
};

// قواعد التحقق لكل مفتاح عند الحفظ من الواجهة — تمنع إدخال قيم تكسر المنطق.
const RULES = {
  "whatsapp.enabled": (v) => boolRule(v),
  "whatsapp.provider": (v) => (PROVIDERS.includes(String(v).toUpperCase()) ? null : `المزوّد يجب أن يكون أحد: ${PROVIDERS.join(" / ")}`),
  "whatsapp.defaultCountryCode": (v) => (COUNTRY_CODES.includes(String(v)) ? null : `كود الدولة غير مدعوم. اختر أحد: ${COUNTRY_CODES.join("، ")}`),
  "whatsapp.baseUrl": (v) => (v === "" || /^https?:\/\/\S+$/i.test(String(v).trim()) ? null : "الرابط يجب أن يبدأ بـ http:// أو https://"),
  "whatsapp.web.minDelaySeconds": (v) => intRule(v, 5, 3600),
  "whatsapp.web.maxDelaySeconds": (v) => intRule(v, 5, 7200),
  "whatsapp.cloud.params.reminder": (v) => templateParamsRule(v),
  "whatsapp.cloud.params.invoice": (v) => templateParamsRule(v),
  "whatsapp.cloud.params.receipt": (v) => templateParamsRule(v),
  "showroom.name": (v) => (String(v).trim() ? null : "اسم المعرض مطلوب لأنه يظهر في كل رسالة"),
  "reminder.beforeDays": (v) => intRule(v, 0, 60),
  "reminder.onDueDate": (v) => boolRule(v),
  "reminder.afterOverdueDays": (v) => intListRule(v, 0, 365),
  "reminder.maxPerInstallment": (v) => intRule(v, 1, 100),
  "reminder.dailyCap": (v) => intRule(v, 1, 100000),
  "reminder.dedupeHours": (v) => intRule(v, 0, 720),
  "reminder.autoRun": (v) => boolRule(v),
  "reminder.skipWeekdays": (v) => intListRule(v, 0, 6),
  "guarantor.graceDays": (v) => intRule(v, 0, 365),
  "reminder.quietStart": (v) => timeRule(v),
  "reminder.quietEnd": (v) => timeRule(v),
  "reminder.scheduleTime": (v) => timeRule(v),
};

function digits(v) {
  return String(v ?? "").replace(/[^\d]/g, "");
}
function boolRule(v) {
  return ["0", "1", "true", "false", ""].includes(String(v).trim().toLowerCase()) ? null : "القيمة يجب أن تكون 0 أو 1";
}
function intRule(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return "القيمة يجب أن تكون عددًا صحيحًا";
  if (n < min || n > max) return `القيمة يجب أن تكون بين ${min} و${max}`;
  return null;
}
function intListRule(v, min, max) {
  const parts = String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isFinite(n) || !Number.isInteger(n)) return "القائمة يجب أن تكون أرقامًا صحيحة مفصولة بفواصل";
    if (n < min || n > max) return `كل قيمة يجب أن تكون بين ${min} و${max}`;
  }
  return null;
}
function templateParamsRule(v) {
  const allowed = new Set(["showroom","currency","customer","guarantor","owner","sale","mode","vehicle","installments","total_due","seller_due","receipt","amount","method","date","installment","due","paid","remaining","days","status_line","link"]);
  const parts = String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  for (const part of parts) if (!allowed.has(part)) return `متغير قالب غير معروف: ${part}`;
  return null;
}
function timeRule(v) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v ?? "").trim()) ? null : "الصيغة المطلوبة HH:MM (24 ساعة)";
}

export function createSettingsService(db) {
  const ensure = db.prepare(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING`);

  function loadAll() {
    const rows = db.prepare(`SELECT key, value FROM settings`).all();
    const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const out = {};
    for (const [key, fallback] of Object.entries(DEFAULTS)) out[key] = key in stored ? stored[key] : fallback;
    // لو كانت قاعدة البيانات القديمة تحتوي مفتاح دولة غير مدعوم (مثل 55)،
    // نرجع للسعودية بدل تفسير رقم سعودي محلي على أنه رقم برازيلي.
    if (!COUNTRY_CODES.includes(String(out["whatsapp.defaultCountryCode"]))) out["whatsapp.defaultCountryCode"] = "966";
    return out;
  }

  function get(key) {
    const row = db.prepare(`SELECT value FROM settings WHERE key=?`).get(key);
    const value = row ? row.value : DEFAULTS[key] ?? "";
    if (key === "whatsapp.defaultCountryCode" && !COUNTRY_CODES.includes(String(value))) return "966";
    return value;
  }

  function getBool(key) {
    return ["1", "true", "yes"].includes(String(get(key)).trim().toLowerCase());
  }

  function getInt(key, fallback = 0) {
    const n = Number(get(key));
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
  }

  function getIntList(key) {
    return String(get(key))
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isFinite(n));
  }

  function setMany(entries) {
    const errors = [];
    const clean = [];
    for (const [key, raw] of Object.entries(entries)) {
      if (!Object.hasOwn(DEFAULTS, key)) {
        errors.push({ key, error: "مفتاح غير معروف" });
        continue;
      }
      // القوالب تُقبل كما هي (قد تحتوي أسطرًا جديدة)، وكل شيء آخر يُقلَّم.
      if (raw !== null && !["string", "number", "boolean"].includes(typeof raw)) { errors.push({ key, error: "القيمة يجب أن تكون نصًا أو رقمًا" }); continue; }
      let value = key.startsWith("template.") ? String(raw ?? "") : String(raw ?? "").trim();
      if (value.length > 10000) { errors.push({ key, error: "القيمة أطول من الحد المسموح" }); continue; }
      if (key === "whatsapp.provider") value = value.toUpperCase();
      if (key === "whatsapp.defaultCountryCode") value = latinDigits(value);
      const rule = RULES[key];
      if (rule) {
        const problem = rule(value);
        if (problem) {
          errors.push({ key, error: problem });
          continue;
        }
      }
      clean.push([key, value]);
    }
    const minDelay = Number(clean.find(([k]) => k === "whatsapp.web.minDelaySeconds")?.[1] ?? get("whatsapp.web.minDelaySeconds"));
    const maxDelay = Number(clean.find(([k]) => k === "whatsapp.web.maxDelaySeconds")?.[1] ?? get("whatsapp.web.maxDelaySeconds"));
    if (Number.isFinite(minDelay) && Number.isFinite(maxDelay) && maxDelay < minDelay) {
      errors.push({ key: "whatsapp.web.maxDelaySeconds", error: "الحد الأعلى للفاصل يجب أن يكون أكبر من أو مساويًا للحد الأدنى" });
    }
    if (errors.length) return { ok: false, errors };

    const tx = db.transaction(() => {
      for (const [key, value] of clean) {
        db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)
                    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`).run(key, value);
      }
    });
    tx();
    return { ok: true, saved: clean.map(([key]) => key) };
  }

  // إعادة مفتاح (أو كل القوالب) إلى قيمته الافتراضية.
  function resetKeys(keys) {
    const list = keys && keys.length ? keys : Object.keys(DEFAULTS);
    const tx = db.transaction(() => {
      for (const key of list) if (Object.hasOwn(DEFAULTS, key)) db.prepare(`DELETE FROM settings WHERE key=?`).run(key);
    });
    tx();
    return list.filter((k) => Object.hasOwn(DEFAULTS, k));
  }

  return { loadAll, get, getBool, getInt, getIntList, setMany, resetKeys, DEFAULTS, ensure };
}
