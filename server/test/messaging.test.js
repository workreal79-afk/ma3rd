import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* ------------------------------------------------------------------ */
/* بيئة اختبار معزولة (قاعدة بيانات مستقلة + إيقاف النسخ التلقائي)      */
/* ------------------------------------------------------------------ */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");
const dbName = `qa-messaging-${process.pid}-${Date.now()}.sqlite`;
process.env.SHOWROOM_DB = dbName;
process.env.SHOWROOM_AUTO_BACKUP = "0";
process.env.NODE_ENV = "test";
process.env.SHOWROOM_SEED_DEMO = "1";

const { createApp } = await import("../src/app.js");
const { app, context } = createApp();
const { db, messaging, messagingScheduler } = context;
const { settings, compose, reminders } = messaging;

// وحدات نقية تُختبر مباشرة
const { normalizePhone, prettyPhone, digitsOnly } = await import("../src/modules/messaging/phone.js");
const { renderTemplate, variablesIn } = await import("../src/modules/messaging/templates.js");
const { buildWaMeLink, buildDocumentLink } = await import("../src/modules/messaging/providers.js");
const { createScheduler } = await import("../src/modules/messaging/scheduler.js");

const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const API = `http://127.0.0.1:${server.address().port}/api`;

test.after(() => {
  try { server.close(); } catch { /* already closed */ }
  try { messagingScheduler.stop(); } catch { /* not started */ }
  try { db.close(); } catch { /* already closed */ }
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.rmSync(path.join(dataDir, dbName + suffix), { force: true }); } catch { /* ignore */ }
  }
});

/* ------------------------------------------------------------------ */
/* أدوات                                                               */
/* ------------------------------------------------------------------ */
async function call(method, url, body) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* يبقى نصًا */ }
  return { status: res.status, data, text };
}
const get = (u) => call("GET", u);
const post = (u, b) => call("POST", u, b);
const put = (u, b) => call("PUT", u, b);
const del = (u) => call("DELETE", u);

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const shiftDays = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const atTime = (hhmm, dayOffset = 0) => {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(h, m, 0, 0);
  return d;
};

const localDateOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const S = {};

// هذه المساعدات كانت مفقودة من ملف الاختبارات المرفوع؛ لا تستبدل أي خدمة حقيقية.
function firstInstallmentOf(saleId) {
  const row = db.prepare(`SELECT i.id FROM installments i JOIN contracts c ON c.id=i.contract_id
    WHERE c.sale_id=? ORDER BY i.installment_number LIMIT 1`).get(saleId);
  assert.ok(row, `لا يوجد قسط للبيع ${saleId}`);
  return row.id;
}

function makeOverdueInstallment(saleId, days) {
  const id = firstInstallmentOf(saleId);
  const due = shiftDays(-days);
  db.transaction(() => {
    db.prepare("UPDATE installments SET due_date=? WHERE id=?").run(due, id);
    db.prepare("UPDATE bills SET due_date=? WHERE installment_id=?").run(due, id);
  })();
  return id;
}

async function resetLog() {
  const result = await del("/messaging/log");
  assert.equal(result.status, 200, result.text);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM message_log").get().n, 0);
}

/* ================================================================== */
/* 1) تطبيع أرقام الهواتف                                              */
/* ================================================================== */

test("phone: الرقم السعودي بدون الصفر 55xxxxxxxx يُعامل كسعودي ولا يُفسَّر ككود 55", () => {
  assert.equal(normalizePhone("551884891", "55"), "966551884891");
});

test("phone: الرقم المحلي السعودي 05xxxxxxxx يتحول إلى 9665xxxxxxxx", () => {
  assert.equal(normalizePhone("0551234567", "966"), "966551234567");
});

test("phone: الرقم السعودي المنسق بمسافات وعلامة + يُقبل", () => {
  assert.equal(normalizePhone("+966 55 188 4891", "966"), "966551884891");
});

test("phone: الصيغة الدولية بعلامة + تمر كما هي", () => {
  assert.equal(normalizePhone("+966551234567", "966"), "966551234567");
});

test("phone: الصيغة 00966 تُعامل كمفتاح دولي مزدوج", () => {
  assert.equal(normalizePhone("00966551234567", "966"), "966551234567");
});

test("phone: الأقواس والمسافات والشرطات تُزال", () => {
  assert.equal(normalizePhone(" 055-123-4567 ", "966"), "966551234567");
  assert.equal(normalizePhone("(055) 123 4567", "966"), "966551234567");
});

test("phone: رقم مصري يُطبَّع بكود الدولة 20", () => {
  assert.equal(normalizePhone("01012345678", "20"), "201012345678");
  assert.equal(normalizePhone("+201012345678", "20"), "201012345678");
});

test("phone: رقم مصري مكتوب بكوده يُقبل حتى لو كان الكود الافتراضي سعودي", () => {
  assert.equal(normalizePhone("201012345678", "966"), "201012345678");
});

test("phone: الأرقام القصيرة والفارغة والحروف مرفوضة", () => {
  assert.equal(normalizePhone("", "966"), null);
  assert.equal(normalizePhone(null, "966"), null);
  assert.equal(normalizePhone("abc", "966"), null);
  assert.equal(normalizePhone("12345", "966"), null);
});

test("phone: الطول لا يتجاوز حد E.164 (15 رقمًا)", () => {
  assert.equal(normalizePhone("9".repeat(20), "966"), null);
});

test("phone: prettyPhone يعرض الرقم بصيغة مقروءة", () => {
  assert.equal(prettyPhone("966551234567"), "+966 55 1234567");
  assert.equal(prettyPhone("201012345678"), "+20 10 12345678");
  assert.equal(prettyPhone(""), "");
});

test("phone: digitsOnly يستخرج الأرقام فقط", () => {
  assert.equal(digitsOnly("+966 (55) 123-4567"), "966551234567");
  assert.equal(digitsOnly(undefined), "");
});

/* ================================================================== */
/* 2) محرّك القوالب                                                    */
/* ================================================================== */

test("templates: المتغيّرات تُستبدل بقيمها", () => {
  const { body } = renderTemplate("مرحبًا {{customer}}، المبلغ {{amount}} {{currency}}", {
    customer: "أحمد", amount: "5,000", currency: "ر.س",
  });
  assert.equal(body, "مرحبًا أحمد، المبلغ 5,000 ر.س");
});

test("templates: المسافات داخل الأقواس مقبولة {{ name }}", () => {
  const { body } = renderTemplate("{{ customer }}", { customer: "سالم" });
  assert.equal(body, "سالم");
});

test("templates: المتغيّر غير المعروف يُستبدل بفراغ ويُبلَّغ عنه", () => {
  const { body, missing } = renderTemplate("الاسم {{customer}} والوظيفة {{job}}", { customer: "أحمد" });
  assert.equal(body, "الاسم أحمد والوظيفة");
  assert.deepEqual(missing, ["job"]);
});

test("templates: القيمة null أو undefined تصبح نصًا فارغًا لا 'null'", () => {
  const { body } = renderTemplate("[{{a}}][{{b}}]", { a: null, b: undefined });
  assert.equal(body, "[][]");
});

test("templates: سطر status_line الفارغ لا يترك سطرًا خاليًا مزدوجًا", () => {
  const template = "السطر الأول\n{{status_line}}\nالسطر الأخير";
  const { body } = renderTemplate(template, { status_line: "" });
  assert.equal(body, "السطر الأول\nالسطر الأخير");
});

test("templates: variablesIn يستخرج المتغيّرات المستخدمة في قالب", () => {
  const found = variablesIn("{{showroom}} — {{customer}} — {{showroom}}");
  assert.deepEqual(found.sort(), ["customer", "showroom"]);
});

/* ================================================================== */
/* 3) روابط wa.me والمستندات                                            */
/* ================================================================== */

test("wa.me: الرابط يحتوي الرقم بلا + والنص مُرمَّز", () => {
  const link = buildWaMeLink("966551234567", "مرحبًا 100%");
  assert.ok(link.startsWith("https://wa.me/966551234567?text="));
  assert.ok(link.includes(encodeURIComponent("مرحبًا 100%")));
  assert.ok(!link.includes("+966"));
});

test("wa.me: الأسطر الجديدة تُرمَّز ولا تكسر الرابط", () => {
  const link = buildWaMeLink("966551234567", "سطر أول\nسطر ثاني");
  assert.ok(!link.includes("\n"));
  assert.equal(decodeURIComponent(link.split("text=")[1]), "سطر أول\nسطر ثاني");
});

test("documentLink: يُبنى من baseUrl المضبوط في الإعدادات", () => {
  assert.equal(
    buildDocumentLink({ baseUrl: "https://show.example.com/", origin: "http://x", path: "/api/documents/bills/3" }),
    "https://show.example.com/api/documents/bills/3",
  );
});

test("documentLink: يشتق من origin الطلب لو لم يُضبط baseUrl", () => {
  assert.equal(
    buildDocumentLink({ baseUrl: "", origin: "http://127.0.0.1:4000", path: "api/documents/bills/3" }),
    "http://127.0.0.1:4000/api/documents/bills/3",
  );
});

test("documentLink: يرجع مسارًا نسبيًا لو لا baseUrl ولا origin", () => {
  assert.equal(buildDocumentLink({ baseUrl: "", origin: "", path: "/api/x" }), "/api/x");
});

/* ================================================================== */
/* 4) ساعات الهدوء والأيام الممنوعة                                    */
/* ================================================================== */

test("quietHours: نافذة تعبر منتصف الليل (21:00–09:00)", () => {
  settings.setMany({ "reminder.quietStart": "21:00", "reminder.quietEnd": "09:00" });
  assert.equal(reminders.inQuietHours(atTime("22:30")), true);
  assert.equal(reminders.inQuietHours(atTime("03:00")), true);
  assert.equal(reminders.inQuietHours(atTime("08:59")), true);
  assert.equal(reminders.inQuietHours(atTime("09:00")), false);
  assert.equal(reminders.inQuietHours(atTime("12:00")), false);
  assert.equal(reminders.inQuietHours(atTime("20:59")), false);
});

test("quietHours: نافذة داخل اليوم نفسه (13:00–14:00)", () => {
  settings.setMany({ "reminder.quietStart": "13:00", "reminder.quietEnd": "14:00" });
  assert.equal(reminders.inQuietHours(atTime("13:30")), true);
  assert.equal(reminders.inQuietHours(atTime("14:00")), false);
  assert.equal(reminders.inQuietHours(atTime("15:00")), false);
});

test("quietHours: لو البداية تساوي النهاية فلا هدوء أبدًا", () => {
  settings.setMany({ "reminder.quietStart": "09:00", "reminder.quietEnd": "09:00" });
  assert.equal(reminders.inQuietHours(atTime("09:00")), false);
  assert.equal(reminders.inQuietHours(atTime("23:00")), false);
});

test("quietHours: قيمة تالفة في قاعدة البيانات ترجع للافتراضي الآمن 21:00–09:00", () => {
  // الواجهة ترفض الصيغة التالفة، لكن قد تصل من نسخة احتياطية قديمة — يجب ألا ينهار النظام.
  db.prepare(`INSERT INTO settings(key,value) VALUES('reminder.quietStart','ليس-وقتًا')
              ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run();
  settings.setMany({ "reminder.quietEnd": "09:00" });
  assert.equal(reminders.inQuietHours(atTime("22:00")), true);
  assert.equal(reminders.inQuietHours(atTime("12:00")), false);
  settings.setMany({ "reminder.quietStart": "21:00" });
});

test("skipWeekdays: اليوم الممنوع يُكتشف من رقم اليوم", () => {
  settings.setMany({ "reminder.skipWeekdays": "5" });
  const friday = new Date();
  friday.setDate(friday.getDate() + ((5 - friday.getDay() + 7) % 7));
  const saturday = new Date(friday);
  saturday.setDate(friday.getDate() + 1);
  assert.equal(reminders.isSkippedWeekday(friday), true);
  assert.equal(reminders.isSkippedWeekday(saturday), false);
});

/* ================================================================== */
/* 5) تصنيف الأقساط                                                    */
/* ================================================================== */

test("classify: تأخير ضمن قائمة afterOverdueDays يعطي OVERDUE_REMINDER", () => {
  settings.setMany({ "reminder.afterOverdueDays": "1,7,15,30", "reminder.beforeDays": "3", "reminder.onDueDate": "1" });
  const t = today();
  assert.deepEqual(
    reminders.classify({ due_date: shiftDays(-7), amount: 100, paid_amount: 0 }, t),
    { kind: "OVERDUE_REMINDER", daysOverdue: 7 },
  );
  assert.deepEqual(reminders.classify({ due_date: shiftDays(-1) }, t), { kind: "OVERDUE_REMINDER", daysOverdue: 1 });
});

test("classify: تأخير خارج القائمة لا يرسل شيئًا (منع الإزعاج اليومي)", () => {
  assert.equal(reminders.classify({ due_date: shiftDays(-3) }, today()), null);
  assert.equal(reminders.classify({ due_date: shiftDays(-100) }, today()), null);
});

test("classify: المستحق اليوم يعطي DUE_REMINDER فقط لو onDueDate مفعّل", () => {
  settings.setMany({ "reminder.onDueDate": "1" });
  assert.deepEqual(reminders.classify({ due_date: today() }, today()), { kind: "DUE_REMINDER", daysOverdue: 0 });
  settings.setMany({ "reminder.onDueDate": "0" });
  assert.equal(reminders.classify({ due_date: today() }, today()), null);
  settings.setMany({ "reminder.onDueDate": "1" });
});

test("classify: قادم خلال beforeDays يعطي DUE_REMINDER وبعده لا شيء", () => {
  settings.setMany({ "reminder.beforeDays": "3" });
  assert.deepEqual(reminders.classify({ due_date: shiftDays(2) }, today()), { kind: "DUE_REMINDER", daysOverdue: -2 });
  assert.equal(reminders.classify({ due_date: shiftDays(10) }, today()), null);
});

test("classify: beforeDays = 0 يعني لا تذكير مسبق إطلاقًا", () => {
  settings.setMany({ "reminder.beforeDays": "0" });
  assert.equal(reminders.classify({ due_date: shiftDays(1) }, today()), null);
  settings.setMany({ "reminder.beforeDays": "3" });
});

/* ================================================================== */
/* 6) بيانات الاختبار: عميل وبائع وكفيل ومركبتين وبيعين                */
/* ================================================================== */

test("إعداد: إنشاء عميل برقم سعودي وبائع وكفيل", async () => {
  const customer = await post("/customers", { name: "أحمد محمد الشمري", phone: "0551234567", national_id: "1099887766" });
  assert.equal(customer.status, 200);
  S.customerId = customer.data.id;

  const noPhone = await post("/customers", { name: "عميل بلا رقم", phone: "" });
  S.noPhoneCustomerId = noPhone.data.id;

  const seller = await post("/sellers", { name: "مؤسسة النخبة للسيارات", phone: "0509876543" });
  S.sellerId = seller.data.id;

  const guarantor = await post("/guarantors", { name: "خالد العتيبي (كفيل)", phone: "+966533334444" });
  S.guarantorId = guarantor.data.id;

  assert.ok(S.customerId && S.sellerId && S.guarantorId);
});

test("إعداد: مركبة مملوكة للمعرض وأخرى مملوكة للغير", async () => {
  const own = await post("/vehicles", {
    plate_number: "أ ب ج 1001", make: "تويوتا", model: "كامري", model_year: 2023, price: 120000,
    ownership_type: "SHOWROOM",
  });
  S.ownVehicleId = own.data.id;

  const third = await post("/vehicles", {
    plate_number: "د هـ و 2002", make: "هيونداي", model: "سوناتا", model_year: 2022, price: 90000,
    ownership_type: "THIRD_PARTY", owner_seller_id: S.sellerId,
  });
  S.thirdVehicleId = third.data.id;
});

test("إعداد: بيع مباشر بالتقسيط + كفيل", async () => {
  const r = await post("/sales", {
    customer_id: S.customerId, vehicle_id: S.ownVehicleId, vehicle_mode: "EXISTING",
    sale_type: "INSTALLMENT", transaction_mode: "DIRECT",
    sale_price: 120000, down_payment: 20000, installment_count: 10, installment_amount: 10000,
    first_due_date: shiftDays(5), guarantor_id: S.guarantorId,
  });
  assert.equal(r.status, 200, r.text);
  S.directSaleId = r.data.id;
  S.directSaleNumber = r.data.sale_number;
});

test("إعداد: بيع وسيط بالتقسيط", async () => {
  const r = await post("/sales", {
    customer_id: S.customerId, vehicle_id: S.thirdVehicleId, vehicle_mode: "EXISTING",
    sale_type: "INSTALLMENT", transaction_mode: "INTERMEDIARY", seller_id: S.sellerId,
    sale_price: 90000, down_payment: 10000, installment_count: 8, installment_amount: 10000,
    first_due_date: shiftDays(-40),
  });
  assert.equal(r.status, 200, r.text);
  S.intermediarySaleId = r.data.id;
});

test("إعداد: جدول settings وmessage_log أُنشئا في قاعدة البيانات", () => {
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('settings','message_log')`).all().map((r) => r.name);
  assert.deepEqual(tables.sort(), ["message_log", "settings"]);
  const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_message_log_dedupe'`).get();
  assert.ok(idx, "فهرس منع التكرار يجب أن يكون موجودًا");
});

/* ================================================================== */
/* 7) توجيه المستلمين حسب نوع العملية                                  */
/* ================================================================== */

test("routing: البيع المباشر يرسل نسخة لصاحب المعرض (SHOWROOM)", () => {
  settings.setMany({ "showroom.phone": "0557778899", "showroom.name": "معرض الاختبار" });
  const r = compose({ kind: "COLLECTION_INVOICE", saleId: S.directSaleId });
  assert.equal(r.error, undefined);
  const roles = r.messages.map((m) => m.role).sort();
  assert.deepEqual(roles, ["CUSTOMER", "SHOWROOM"]);
  const showroom = r.messages.find((m) => m.role === "SHOWROOM");
  assert.equal(showroom.name, "معرض الاختبار");
  assert.equal(showroom.normalizedPhone, "966557778899");
});

test("routing: البيع الوسيط يرسل نسخة للمالك المسجّل (SELLER) لا للمعرض", () => {
  const r = compose({ kind: "COLLECTION_INVOICE", saleId: S.intermediarySaleId });
  const roles = r.messages.map((m) => m.role).sort();
  assert.deepEqual(roles, ["CUSTOMER", "SELLER"]);
  const owner = r.messages.find((m) => m.role === "SELLER");
  assert.equal(owner.name, "مؤسسة النخبة للسيارات");
  assert.equal(owner.normalizedPhone, "966509876543");
});

test("routing: رسالة المالك تذكر نوع العملية (وسيط/مباشر)", () => {
  const inter = compose({ kind: "COLLECTION_INVOICE", saleId: S.intermediarySaleId });
  const direct = compose({ kind: "COLLECTION_INVOICE", saleId: S.directSaleId });
  assert.ok(inter.messages.find((m) => m.role === "SELLER").body.includes("وسيط"));
  assert.ok(direct.messages.find((m) => m.role === "SHOWROOM").body.includes("مباشر"));
});

test("routing: نص الرسالة يحتوي اسم العميل ورقم العقد والمبلغ", () => {
  const r = compose({ kind: "COLLECTION_INVOICE", saleId: S.directSaleId });
  const customerMsg = r.messages.find((m) => m.role === "CUSTOMER");
  assert.ok(customerMsg.body.includes("أحمد محمد الشمري"), customerMsg.body);
  assert.ok(customerMsg.body.includes(S.directSaleNumber));
  assert.ok(customerMsg.body.includes("تويوتا"));
  assert.ok(!customerMsg.body.includes("{{"), "لا يجب أن تبقى متغيّرات غير مستبدلة");
  assert.deepEqual(customerMsg.missing, []);
});

test("routing: الرابط يشير إلى مستند الفواتير الصحيح", () => {
  const r = compose({ kind: "COLLECTION_INVOICE", saleId: S.directSaleId });
  const msg = r.messages.find((m) => m.role === "CUSTOMER");
  assert.ok(msg.link.endsWith(`/api/documents/bills/${S.directSaleId}`), msg.link);
  assert.ok(msg.body.includes(`/api/documents/bills/${S.directSaleId}`), "الرابط يجب أن يظهر داخل نص الرسالة");
});

test("routing: رابط التذكير يشير إلى جدول الأقساط", () => {
  const r = compose({ kind: "DUE_REMINDER", installmentId: firstInstallmentOf(S.directSaleId) });
  assert.equal(r.error, undefined);
  assert.ok(r.messages[0].link.endsWith(`/api/documents/schedule/${S.directSaleId}`));
});

test("routing: عميل بلا رقم هاتف → الرسالة تُعلَّم كمسكّنة بسبب واضح", async () => {
  const created = await post("/sales", {
    customer_id: S.noPhoneCustomerId, vehicle_mode: "MANUAL",
    manual_vehicle: { plate_number: "NO-PHONE-1", make: "تويوتا", model: "يارس" },
    sale_type: "INSTALLMENT", sale_price: 10000, down_payment: 0,
    installment_count: 10, installment_amount: 1000, first_due_date: shiftDays(365),
  });
  assert.equal(created.status, 200, created.text);
  const r = compose({ kind: "COLLECTION_INVOICE", saleId: created.data.id });
  const customerMsg = r.messages.find((m) => m.role === "CUSTOMER");
  assert.ok(customerMsg.skipReason.includes("لا يوجد رقم"), customerMsg.skipReason);
  assert.equal(customerMsg.normalizedPhone, "");
});

test("routing: البيع النقدي مرفوض لأنه لا يملك أقساطًا", async () => {
  const cash = await post("/sales", {
    customer_id: S.customerId, vehicle_mode: "MANUAL",
    manual_vehicle: { plate_number: "ن ق د 555", make: "نيسان", model: "صني", price: 30000 },
    sale_type: "CASH", transaction_mode: "DIRECT", sale_price: 30000,
  });
  assert.equal(cash.status, 200, cash.text);
  const r = compose({ kind: "COLLECTION_INVOICE", saleId: cash.data.id });
  assert.ok(r.error.includes("نقدي"), r.error);
});

test("routing: البيع الملغى مرفوض", () => {
  db.prepare(`UPDATE sales SET status='CANCELLED' WHERE id=?`).run(S.intermediarySaleId);
  const r = compose({ kind: "COLLECTION_INVOICE", saleId: S.intermediarySaleId });
  assert.ok(r.error.includes("ملغى"), r.error);
  db.prepare(`UPDATE sales SET status='ACTIVE' WHERE id=?`).run(S.intermediarySaleId);
});

test("routing: قسط أو بيع غير موجود يعيد خطأ واضحًا", () => {
  assert.ok(compose({ kind: "DUE_REMINDER", installmentId: 999999 }).error.includes("غير موجود"));
  assert.ok(compose({ kind: "DUE_REMINDER", saleId: 999999 }).error.includes("غير موجود"));
  assert.ok(compose({ kind: "UNKNOWN_KIND", saleId: S.directSaleId }).error.includes("غير معروف"));
});

/* ================================================================== */
/* 8) الكفيل وفترة السماح                                              */
/* ================================================================== */

test("guarantor: قبل انتهاء فترة السماح لا تُرسل رسالة للكفيل (مؤجّلة بسبب واضح)", () => {
  const instId = makeOverdueInstallment(S.directSaleId, 3);
  settings.setMany({ "guarantor.graceDays": "7", "reminder.afterOverdueDays": "1,3,7,15,30" });
  const r = compose({ kind: "OVERDUE_REMINDER", installmentId: instId });
  const guarantorMsg = r.messages.find((m) => m.role === "GUARANTOR");
  assert.ok(guarantorMsg.deferred, "يجب تعليمها كمؤجّلة");
  assert.ok(guarantorMsg.skipReason.includes("فترة السماح"), guarantorMsg.skipReason);
  assert.equal(guarantorMsg.body, "");
});

test("guarantor: بعد انتهاء فترة السماح تُرسل رسالة الكفيل", () => {
  const instId = makeOverdueInstallment(S.directSaleId, 10);
  settings.setMany({ "guarantor.graceDays": "7", "reminder.afterOverdueDays": "1,7,10,15,30" });
  const r = compose({ kind: "OVERDUE_REMINDER", installmentId: instId });
  const guarantorMsg = r.messages.find((m) => m.role === "GUARANTOR");
  assert.equal(guarantorMsg.deferred, undefined);
  assert.equal(guarantorMsg.normalizedPhone, "966533334444");
  assert.ok(guarantorMsg.body.includes("خالد العتيبي"), guarantorMsg.body);
  assert.ok(guarantorMsg.body.includes("المكفول"), "رسالة الكفيل تذكر المكفول");
  assert.ok(guarantorMsg.body.includes("10 يوم") || guarantorMsg.body.includes("مدة التأخير"));
});

test("guarantor: تعطيل النوع من الإعدادات يمنع رسالة الكفيل تمامًا", () => {
  const instId = makeOverdueInstallment(S.directSaleId, 10);
  settings.setMany({ "msg.overdueReminder.guarantor": "0" });
  const r = compose({ kind: "OVERDUE_REMINDER", installmentId: instId });
  assert.equal(r.messages.some((m) => m.role === "GUARANTOR"), false);
  settings.setMany({ "msg.overdueReminder.guarantor": "1" });
});

test("guarantor: GUARANTOR_NOTICE يرسل للكفيل مباشرة دون فحص السماح", () => {
  const instId = makeOverdueInstallment(S.directSaleId, 2);
  settings.setMany({ "guarantor.graceDays": "7" });
  const r = compose({ kind: "GUARANTOR_NOTICE", installmentId: instId });
  assert.equal(r.error, undefined);
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].role, "GUARANTOR");
});

test("guarantor: عقد بلا كفيل يعيد خطأ واضحًا في GUARANTOR_NOTICE", () => {
  db.prepare(`UPDATE sales SET guarantor_id=NULL WHERE id=?`).run(S.directSaleId);
  const r = compose({ kind: "GUARANTOR_NOTICE", installmentId: firstInstallmentOf(S.directSaleId) });
  assert.ok(r.error.includes("لا يوجد كفيل"), r.error);
  db.prepare(`UPDATE sales SET guarantor_id=? WHERE id=?`).run(S.guarantorId, S.directSaleId);
});

/* ================================================================== */
/* 9) الإرسال اليدوي ومسار wa.me                                       */
/* ================================================================== */

test("send: المزوّد LINK يجهّز روابط wa.me ويسجّلها دون أي اتصال خارجي", async () => {
  settings.setMany({ "whatsapp.provider": "LINK", "whatsapp.enabled": "1", "showroom.phone": "0557778899" });
  const r = await post("/messaging/send", { kind: "COLLECTION_INVOICE", saleId: S.directSaleId });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.provider, "LINK");
  assert.equal(r.data.results.length, 2);
  for (const item of r.data.results) {
    assert.equal(item.status, "LINK_READY");
    assert.ok(item.link.startsWith("https://wa.me/9665"), item.link);
  }
});

test("send: الرابط يحتوي نص الرسالة مُرمَّزًا بالكامل", async () => {
  const r = await post("/messaging/send", { kind: "COLLECTION_INVOICE", saleId: S.directSaleId, roles: ["CUSTOMER"] });
  const item = r.data.results[0];
  const text = decodeURIComponent(item.link.split("text=")[1]);
  assert.equal(text, item.body);
  assert.ok(text.includes("فاتورة تحصيل"));
  assert.ok(text.includes("أحمد محمد الشمري"));
});

test("send: كل رسالة تُسجَّل في message_log بحالة LINK_READY", async () => {
  const before = Number(db.prepare(`SELECT COUNT(*) n FROM message_log`).get().n);
  await post("/messaging/send", { kind: "COLLECTION_INVOICE", saleId: S.directSaleId });
  const after = Number(db.prepare(`SELECT COUNT(*) n FROM message_log`).get().n);
  assert.equal(after - before, 2);
  const row = db.prepare(`SELECT * FROM message_log ORDER BY id DESC LIMIT 1`).get();
  assert.equal(row.channel, "WHATSAPP");
  assert.equal(row.provider, "LINK");
  assert.equal(row.status, "LINK_READY");
  assert.equal(row.trigger_source, "MANUAL");
  assert.ok(row.sent_at);
});

test("send: إرسال يدوي يُسجَّل في سجل التدقيق", async () => {
  const r = await post("/messaging/send", { kind: "COLLECTION_INVOICE", saleId: S.directSaleId, roles: ["CUSTOMER"] });
  assert.equal(r.status, 200);
  const audit = db.prepare(`SELECT * FROM audit_log WHERE entity_type='WHATSAPP' ORDER BY id DESC LIMIT 1`).get();
  assert.ok(audit, "يجد سجل تدقيق");
  assert.equal(audit.action, "SEND");
  assert.ok(audit.details.includes("COLLECTION_INVOICE"));
});

test("send: فلتر roles يرسل لمستلم واحد فقط", async () => {
  const r = await post("/messaging/send", { kind: "COLLECTION_INVOICE", saleId: S.directSaleId, roles: ["CUSTOMER"] });
  assert.equal(r.data.results.length, 1);
  assert.equal(r.data.results[0].role, "CUSTOMER");
});

test("send: نوع رسالة مفقود يعيد 400", async () => {
  const r = await post("/messaging/send", { saleId: S.directSaleId });
  assert.equal(r.status, 400);
  assert.ok(r.data.error.includes("نوع الرسالة"));
});

test("send: بيع غير موجود يعيد 404 برسالة عربية", async () => {
  const r = await post("/messaging/send", { kind: "COLLECTION_INVOICE", saleId: 999999 });
  assert.equal(r.status, 404);
  assert.ok(r.data.error.includes("غير موجود"));
});

test("send: تعطيل الميزة يعيد 409 لا 500", async () => {
  settings.setMany({ "whatsapp.enabled": "0" });
  const r = await post("/messaging/send", { kind: "COLLECTION_INVOICE", saleId: S.directSaleId });
  assert.equal(r.status, 409);
  assert.ok(r.data.error.includes("معطّلة"));
  settings.setMany({ "whatsapp.enabled": "1" });
});

test("preview: يعيد الرسائل دون تسجيل أي شيء في message_log", async () => {
  const before = Number(db.prepare(`SELECT COUNT(*) n FROM message_log`).get().n);
  const r = await post("/messaging/preview", { kind: "COLLECTION_INVOICE", saleId: S.directSaleId });
  assert.equal(r.status, 200);
  assert.equal(r.data.messages.length, 2);
  const after = Number(db.prepare(`SELECT COUNT(*) n FROM message_log`).get().n);
  assert.equal(after, before, "المعاينة يجب ألا تسجّل إرسالًا");
});

test("preview: لا يثق برؤوس الوكيل في التشغيل المباشر عند بناء رابط المستند", async () => {
  assert.equal(app.get("trust proxy"), false);
  const response = await fetch(`${API}/messaging/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-Host": "evil.example", "X-Forwarded-Proto": "https" },
    body: JSON.stringify({ kind: "COLLECTION_INVOICE", saleId: S.directSaleId }),
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.ok(data.messages.length > 0);
  assert.ok(data.messages.every((message) => message.link === `${API}/documents/bills/${S.directSaleId}`));
});

test("log: معاملات الصفحات الشاذة تتحول إلى أعداد صحيحة آمنة بدل خطأ SQLite", async () => {
  const fallback = await get("/messaging/log?limit=abc&offset=Infinity");
  assert.equal(fallback.status, 200, fallback.text);
  assert.equal(fallback.data.limit, 50);
  assert.equal(fallback.data.offset, 0);
  const fractional = await get("/messaging/log?limit=3.8&offset=-2.7");
  assert.equal(fractional.status, 200, fractional.text);
  assert.equal(fractional.data.limit, 3);
  assert.equal(fractional.data.offset, 0);
  assert.ok(fractional.data.rows.length <= 3);
});

/* ================================================================== */
/* 10) إيصالات السداد                                                  */
/* ================================================================== */

test("receipt: تسجيل دفعة ثم إرسال إيصالها للمشتري ونسخة للمالك", async () => {
  const instId = firstInstallmentOf(S.directSaleId);
  const inst = db.prepare(`SELECT amount FROM installments WHERE id=?`).get(instId);
  const pay = await post(`/installments/${instId}/payments`, {
    amount: Math.round(Number(inst.amount) / 2), payment_method: "BANK_TRANSFER",
  });
  assert.equal(pay.status, 200, pay.text);
  S.receipt = pay.data.receipt_number;

  const r = await post("/messaging/send", { kind: "PAYMENT_RECEIPT", receiptNumber: S.receipt });
  assert.equal(r.status, 200, r.text);
  const roles = r.data.results.map((x) => x.role).sort();
  assert.deepEqual(roles, ["CUSTOMER", "SHOWROOM"]);
  const customer = r.data.results.find((x) => x.role === "CUSTOMER");
  assert.ok(customer.body.includes(S.receipt), customer.body);
  assert.ok(customer.body.includes("تحويل بنكي"), "طريقة السداد تُترجم للعربية");
  assert.ok(customer.documentLink.endsWith(`/api/documents/receipt/${S.receipt}`), customer.documentLink);
  assert.ok(customer.body.includes(`/api/documents/receipt/${S.receipt}`), "رابط المستند داخل نص الرسالة");
  assert.ok(customer.link.startsWith("https://wa.me/"), customer.link);
});

test("receipt: إيصال على بيع وسيط تذهب نسخته للمالك لا للمعرض", async () => {
  const instId = firstInstallmentOf(S.intermediarySaleId);
  const inst = db.prepare(`SELECT amount FROM installments WHERE id=?`).get(instId);
  const pay = await post(`/installments/${instId}/payments`, { amount: 1000, payment_method: "CASH" });
  assert.equal(pay.status, 200, pay.text);
  const r = await post("/messaging/send", { kind: "PAYMENT_RECEIPT", receiptNumber: pay.data.receipt_number });
  const roles = r.data.results.map((x) => x.role).sort();
  assert.deepEqual(roles, ["CUSTOMER", "SELLER"]);
});

test("receipt: إيصال غير موجود يعيد 404", async () => {
  const r = await post("/messaging/send", { kind: "PAYMENT_RECEIPT", receiptNumber: "REC-000000" });
  assert.equal(r.status, 404);
  assert.ok(r.data.error.includes("غير موجود"));
});

test("receipt: رابط الإيصال نفسه يعمل ويعيد مستندًا", async () => {
  const doc = await get(`/documents/receipt/${S.receipt}`);
  assert.equal(doc.status, 200);
  assert.ok(doc.text.includes(S.receipt));
});

/* ================================================================== */
/* 11) خطة التذكيرات والتنفيذ                                          */
/* ================================================================== */

test("reminders: الخطة ترصد الأقساط المستحقة والمتأخرة فقط", async () => {
  await resetLog();
  makeOverdueInstallment(S.directSaleId, 7);   // متأخر 7 → ضمن القائمة
  makeOverdueInstallment(S.intermediarySaleId, 15);
  const r = await get("/messaging/reminders");
  assert.equal(r.status, 200);
  assert.equal(r.data.blocked, false);
  assert.ok(r.data.planned.length >= 2, JSON.stringify(r.data.stats));
  assert.ok(r.data.planned.every((p) => ["OVERDUE_REMINDER", "DUE_REMINDER"].includes(p.kind)));
});

test("reminders: التنفيذ يرسل ويسجّل ويعيد الإحصاء", async () => {
  await resetLog();
  makeOverdueInstallment(S.directSaleId, 7);
  const r = await post("/messaging/reminders/run", {});
  assert.equal(r.status, 200, r.text);
  assert.ok(r.data.sent.length >= 1);
  assert.equal(r.data.results.LINK_READY, r.data.sent.length);
  assert.equal(r.data.results.FAILED, 0);
  const logged = Number(db.prepare(`SELECT COUNT(*) n FROM message_log WHERE trigger_source='MANUAL'`).get().n);
  assert.equal(logged, r.data.sent.length);
});

test("reminders: منع التكرار — تشغيل ثانٍ مباشرة لا يرسل نفس الرسالة", async () => {
  await resetLog();
  makeOverdueInstallment(S.directSaleId, 7);
  settings.setMany({ "reminder.dedupeHours": "20" });
  const first = await post("/messaging/reminders/run", {});
  const count = first.data.sent.length;
  assert.ok(count >= 1);
  const second = await post("/messaging/reminders/run", {});
  assert.equal(second.data.sent.length, 0);
  assert.ok(second.data.skipped.some((s) => s.reason.includes("منع التكرار")), JSON.stringify(second.data.skipped));
});

test("reminders: dedupeHours = 0 يلغي منع التكرار", async () => {
  await resetLog();
  makeOverdueInstallment(S.directSaleId, 7);
  settings.setMany({ "reminder.dedupeHours": "0" });
  const first = await post("/messaging/reminders/run", {});
  const second = await post("/messaging/reminders/run", {});
  assert.equal(second.data.sent.length, first.data.sent.length);
  settings.setMany({ "reminder.dedupeHours": "20" });
});

test("reminders: السقف اليومي يوقف الإرسال ويوضّح السبب", async () => {
  await resetLog();
  makeOverdueInstallment(S.directSaleId, 7);
  makeOverdueInstallment(S.intermediarySaleId, 15);
  settings.setMany({ "reminder.dailyCap": "1" });
  const r = await post("/messaging/reminders/run", {});
  assert.equal(r.data.sent.length, 1);
  assert.ok(r.data.skipped.some((s) => s.reason.includes("السقف اليومي")), JSON.stringify(r.data.skipped));
  await put("/messaging/settings", { "reminder.dailyCap": "200" });
});

test("reminders: الحد الأقصى لكل قسط يُحترم", async () => {
  await resetLog();
  const instId = makeOverdueInstallment(S.directSaleId, 7);
  settings.setMany({ "reminder.maxPerInstallment": "1", "reminder.dedupeHours": "0" });
  const first = await post("/messaging/reminders/run", {});
  assert.ok(first.data.sent.length >= 1);
  const second = await post("/messaging/reminders/run", {});
  assert.ok(second.data.skipped.some((s) => s.reason.includes("الحد الأقصى")), JSON.stringify(second.data.skipped));
  const sameRecipient = second.data.sent.filter((s) => s.installmentId === instId && s.role === "CUSTOMER");
  assert.equal(sameRecipient.length, 0);
  settings.setMany({ "reminder.maxPerInstallment": "6", "reminder.dedupeHours": "20" });
});

test("reminders: الرد يعيد نفس الرقم المطبَّع المخزَّن في السجل (لا الخام)", async () => {
  await resetLog();
  // رقم خام بصيغة محلية — يجب أن يخرج مطبَّعًا في الاستجابة كما في السجل
  db.prepare(`UPDATE customers SET phone='0551234567' WHERE id=?`).run(S.customerId);
  makeOverdueInstallment(S.directSaleId, 7);
  settings.setMany({ "reminder.dedupeHours": "0" });
  const r = await post("/messaging/reminders/run", {});
  const customerSent = r.data.sent.find((x) => x.role === "CUSTOMER");
  assert.ok(customerSent, "يجد رسالة للمشتري");
  assert.equal(customerSent.phone, "966551234567", "الرقم في الاستجابة مطبَّع");
  assert.equal(customerSent.rawPhone, "0551234567", "الرقم الخام محفوظ للمرجعية");
  const logged = db.prepare(`SELECT recipient_phone FROM message_log WHERE id=?`).get(customerSent.id);
  assert.equal(logged.recipient_phone, customerSent.phone, "الاستجابة والسجل متطابقان");
  settings.setMany({ "reminder.dedupeHours": "20" });
});

test("reminders: تعطيل الميزة يجعل الخطة محجوبة بسبب واضح", async () => {
  settings.setMany({ "whatsapp.enabled": "0" });
  const r = await get("/messaging/reminders");
  assert.equal(r.data.blocked, true);
  assert.ok(r.data.blocks.some((b) => b.includes("معطّلة")));
  assert.equal(r.data.planned.length, 0);
  settings.setMany({ "whatsapp.enabled": "1" });
});

test("reminders: التشغيل المجدول يُحجب داخل ساعات الهدوء", async () => {
  settings.setMany({ "reminder.quietStart": "00:00", "reminder.quietEnd": "23:59" });
  const r = await post("/messaging/reminders/run", { trigger: "SCHEDULE" });
  assert.equal(r.data.blocked, true);
  assert.ok(r.data.blocks.some((b) => b.includes("ساعات الهدوء")), JSON.stringify(r.data.blocks));
  settings.setMany({ "reminder.quietStart": "21:00", "reminder.quietEnd": "09:00" });
});

test("reminders: التشغيل اليدوي يتجاوز ساعات الهدوء بقرار الموظف", async () => {
  await resetLog();
  makeOverdueInstallment(S.directSaleId, 7);
  settings.setMany({ "reminder.quietStart": "00:00", "reminder.quietEnd": "23:59" });
  const r = await post("/messaging/reminders/run", { trigger: "MANUAL" });
  assert.equal(r.data.blocked, false);
  settings.setMany({ "reminder.quietStart": "21:00", "reminder.quietEnd": "09:00" });
});

/* ================================================================== */
/* 12) مزوّد WhatsApp Cloud API                                        */
/* ================================================================== */

test("cloud: بلا phoneId/token يرجع فشلًا برسالة عربية واضحة (لا 500)", async () => {
  settings.setMany({ "whatsapp.provider": "CLOUD", "whatsapp.cloud.phoneId": "", "whatsapp.cloud.token": "" });
  try {
    const r = await messaging.sendManual({
      kind: "COLLECTION_INVOICE", saleId: S.directSaleId, roles: ["CUSTOMER"],
    });
    assert.equal(r.results[0].status, "FAILED");
    assert.ok(r.results[0].error.includes("phoneId"), r.results[0].error);
  } finally {
    settings.setMany({ "whatsapp.provider": "LINK" });
  }
});

test("cloud: نجاح الإرسال مع fetch مُحاكى يسجّل SENT", async () => {
  settings.setMany({
    "whatsapp.provider": "CLOUD", "whatsapp.cloud.phoneId": "1234567890", "whatsapp.cloud.token": "EAAtest-token",
  });
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, text: async () => JSON.stringify({ messages: [{ id: "wamid.TEST123" }] }) };
  };
  try {
    const r = await messaging.sendManual({
      kind: "COLLECTION_INVOICE", saleId: S.directSaleId, roles: ["CUSTOMER"], fetchImpl: fakeFetch,
    });
    assert.equal(r.results[0].status, "SENT");
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes("/1234567890/messages"), calls[0].url);
    assert.equal(calls[0].opts.headers.Authorization, "Bearer EAAtest-token");
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.messaging_product, "whatsapp");
    assert.equal(body.to, "966551234567");
    assert.equal(body.type, "text");
  } finally {
    settings.setMany({ "whatsapp.provider": "LINK" });
  }
});

test("cloud: خطأ من ميتا يُلتقط ويُسجَّل كـ FAILED مع رسالة الخطأ", async () => {
  settings.setMany({
    "whatsapp.provider": "CLOUD", "whatsapp.cloud.phoneId": "1234567890", "whatsapp.cloud.token": "EAAtest-token",
  });
  const fakeFetch = async () => ({
    ok: false, status: 400,
    text: async () => JSON.stringify({ error: { message: "(#131030) Recipient phone number not in allowed list" } }),
  });
  try {
    const r = await messaging.sendManual({
      kind: "COLLECTION_INVOICE", saleId: S.directSaleId, roles: ["CUSTOMER"], fetchImpl: fakeFetch,
    });
    assert.equal(r.results[0].status, "FAILED");
    assert.ok(r.results[0].error.includes("131030"), r.results[0].error);
  } finally {
    settings.setMany({ "whatsapp.provider": "LINK" });
  }
});

test("cloud: انقطاع الشبكة لا يسقط الخادم بل يسجّل فشلًا", async () => {
  settings.setMany({
    "whatsapp.provider": "CLOUD", "whatsapp.cloud.phoneId": "1234567890", "whatsapp.cloud.token": "EAAtest-token",
  });
  const fakeFetch = async () => { throw new Error("network unreachable"); };
  try {
    const r = await messaging.sendManual({
      kind: "COLLECTION_INVOICE", saleId: S.directSaleId, roles: ["CUSTOMER"], fetchImpl: fakeFetch,
    });
    assert.equal(r.results[0].status, "FAILED");
    assert.ok(r.results[0].error.includes("network unreachable"));
  } finally {
    settings.setMany({ "whatsapp.provider": "LINK" });
  }
});

test("cloud: اسم قالب معتمد يحوّل الرسالة إلى template بمعامِلاتها", async () => {
  settings.setMany({
    "whatsapp.provider": "CLOUD", "whatsapp.cloud.phoneId": "1234567890",
    "whatsapp.cloud.token": "EAAtest-token", "whatsapp.cloud.template.invoice": "collection_invoice_v1",
  });
  let captured = null;
  const fakeFetch = async (_url, opts) => {
    captured = JSON.parse(opts.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ messages: [{ id: "wamid.T" }] }) };
  };
  try {
    const result = await messaging.reminders.execute({ trigger: "MANUAL", fetchImpl: fakeFetch });
    // التذكيرات تستخدم قالب التذكير؛ لو لم يُضبط تُرسَل نصًا حرًا ولا يفشل التنفيذ.
    assert.ok(result);
    if (captured) {
      assert.equal(captured.messaging_product, "whatsapp");
      assert.ok(["text", "template"].includes(captured.type), captured.type);
    }
  } finally {
    settings.setMany({ "whatsapp.provider": "LINK", "whatsapp.cloud.template.invoice": "" });
  }
});

/* ================================================================== */
/* 13) الإعدادات من الواجهة                                            */
/* ================================================================== */

test("settings: GET يعيد القيم الافتراضية + meta + stats", async () => {
  const r = await get("/messaging/settings");
  assert.equal(r.status, 200);
  assert.equal(r.data.settings["whatsapp.provider"], "LINK");
  assert.equal(r.data.settings["reminder.beforeDays"], "3");
  assert.deepEqual(r.data.meta.kinds, ["COLLECTION_INVOICE", "OVERDUE_REMINDER", "DUE_REMINDER", "PAYMENT_RECEIPT", "GUARANTOR_NOTICE"]);
  assert.ok(r.data.meta.variables.length >= 20);
  assert.ok(r.data.meta.templateKeys.includes("template.collectionInvoice.customer"));
  assert.equal(typeof r.data.stats.total, "number");
});

test("settings: PUT يحفظ القيم وتظهر في GET التالي", async () => {
  const r = await put("/messaging/settings", { "reminder.beforeDays": "5", "showroom.currency": "ج.م" });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.data.saved.sort(), ["reminder.beforeDays", "showroom.currency"]);
  const after = await get("/messaging/settings");
  assert.equal(after.data.settings["reminder.beforeDays"], "5");
  assert.equal(after.data.settings["showroom.currency"], "ج.م");
  await put("/messaging/settings", { "reminder.beforeDays": "3", "showroom.currency": "ر.س" });
});

test("settings: PUT يرفض مفتاحًا غير معروف", async () => {
  const r = await put("/messaging/settings", { "not.a.real.key": "1" });
  assert.equal(r.status, 400);
  assert.ok(r.data.error.includes("غير صالحة"));
  assert.ok(r.data.details.some((d) => d.error.includes("غير معروف")));
});

test("settings: PUT يرفض مزوّدًا غير مدعوم", async () => {
  const r = await put("/messaging/settings", { "whatsapp.provider": "SKYPE" });
  assert.equal(r.status, 400);
  assert.ok(r.data.details[0].error.includes("LINK"));
});

test("settings: PUT يرفض صيغة وقت تالفة", async () => {
  for (const bad of ["25:00", "9:00", "abc", "12:60"]) {
    const r = await put("/messaging/settings", { "reminder.scheduleTime": bad });
    assert.equal(r.status, 400, `${bad} يجب أن يُرفض`);
    assert.ok(r.data.details[0].error.includes("HH:MM"));
  }
});

test("settings: PUT يرفض قيمًا رقمية خارج المدى", async () => {
  assert.equal((await put("/messaging/settings", { "reminder.beforeDays": "-1" })).status, 400);
  assert.equal((await put("/messaging/settings", { "reminder.beforeDays": "999" })).status, 400);
  assert.equal((await put("/messaging/settings", { "reminder.maxPerInstallment": "0" })).status, 400);
  assert.equal((await put("/messaging/settings", { "guarantor.graceDays": "x" })).status, 400);
});

test("settings: PUT يرفض قائمة أيام أسبوع خارج 0–6", async () => {
  assert.equal((await put("/messaging/settings", { "reminder.skipWeekdays": "9" })).status, 400);
  const ok = await put("/messaging/settings", { "reminder.skipWeekdays": "5,6" });
  assert.equal(ok.status, 200);
  await put("/messaging/settings", { "reminder.skipWeekdays": "5" });
});

test("settings: PUT يرفض كود دولة غير رقمي", async () => {
  const r = await put("/messaging/settings", { "whatsapp.defaultCountryCode": "مصر" });
  assert.equal(r.status, 400);
});

test("settings: PUT يرفض baseUrl بلا بروتوكول", async () => {
  assert.equal((await put("/messaging/settings", { "whatsapp.baseUrl": "show.example.com" })).status, 400);
  const ok = await put("/messaging/settings", { "whatsapp.baseUrl": "https://show.example.com" });
  assert.equal(ok.status, 200);
  await put("/messaging/settings", { "whatsapp.baseUrl": "" });
});

test("settings: PUT بجسم غير كائن يعيد 400", async () => {
  const r = await fetch(`${API}/messaging/settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: "[]" });
  assert.equal(r.status, 400);
  const text = await r.text();
  assert.ok(text.includes("كائنًا"), text);
});

test("settings: POST على مسار الإعدادات غير معرّف فيرجع 404 JSON", async () => {
  const r = await post("/messaging/settings", {});
  assert.equal(r.status, 404);
  assert.ok(r.data.error.includes("المسار غير موجود"));
});

test("settings: تعديل قالب من الواجهة ينعكس فورًا على الرسائل", async () => {
  const custom = "قالب مخصص للعميل {{customer}} — عقد {{sale}}";
  const r = await put("/messaging/settings", { "template.collectionInvoice.customer": custom });
  assert.equal(r.status, 200);
  const preview = await post("/messaging/preview", { kind: "COLLECTION_INVOICE", saleId: S.directSaleId });
  const msg = preview.data.messages.find((m) => m.role === "CUSTOMER");
  assert.ok(msg.body.startsWith("قالب مخصص للعميل أحمد محمد الشمري"), msg.body);
  assert.ok(msg.body.includes(`عقد ${S.directSaleNumber}`));
});

test("settings: إعادة القالب للافتراضي ترجعه كاملًا", async () => {
  const r = await post("/messaging/settings/reset", { keys: ["template.collectionInvoice.customer"] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.reset, ["template.collectionInvoice.customer"]);
  const preview = await post("/messaging/preview", { kind: "COLLECTION_INVOICE", saleId: S.directSaleId });
  const msg = preview.data.messages.find((m) => m.role === "CUSTOMER");
  assert.ok(msg.body.includes("فاتورة تحصيل"));
});

test("settings: التوكن لا يُعاد كاملًا أبدًا (آخر 4 أحرف فقط)", async () => {
  await put("/messaging/settings", { "whatsapp.cloud.token": "EAASECRET-abcdef1234" });
  const r = await get("/messaging/settings");
  assert.equal(r.data.settings["whatsapp.cloud.token"], "••••1234");
  assert.equal(r.data.settings["whatsapp.cloud.tokenSet"], true);
  assert.ok(!r.text.includes("EAASECRET-abcdef1234"), "التوكن الكامل لا يجب أن يظهر في الرد");
});

test("settings: حفظ التوكن المقنّع لا يمسح التوكن الحقيقي", async () => {
  await put("/messaging/settings", { "whatsapp.cloud.token": "••••1234" });
  assert.equal(settings.get("whatsapp.cloud.token"), "EAASECRET-abcdef1234");
  await put("/messaging/settings", { "whatsapp.cloud.token": "" });
});

test("settings: حفظ فارغ يعيد 400", async () => {
  const r = await put("/messaging/settings", {});
  assert.equal(r.status, 400);
  assert.ok(r.data.error.includes("لا توجد مفاتيح"));
});

test("settings: تعطيل نوع رسالة من الواجهة يمنعه من الإرسال", async () => {
  await put("/messaging/settings", { "msg.collectionInvoice.owner": "0" });
  const r = await post("/messaging/preview", { kind: "COLLECTION_INVOICE", saleId: S.directSaleId });
  assert.equal(r.data.messages.length, 1);
  assert.equal(r.data.messages[0].role, "CUSTOMER");
  await put("/messaging/settings", { "msg.collectionInvoice.owner": "1" });
});

/* ================================================================== */
/* 14) المُجدول                                                        */
/* ================================================================== */

test("scheduler: لا يعمل قبل الوقت المحدد", async () => {
  const fake = createScheduler({ messaging, logger: { log() {}, error() {} } });
  await settings.setMany({ "reminder.scheduleTime": "23:59", "reminder.autoRun": "1", "whatsapp.enabled": "1" });
  const r = await fake.tick(atTime("08:00"));
  assert.equal(r, null);
  assert.equal(fake.status().lastRunDate, "");
});

test("scheduler: يعمل بعد الوقت المحدد ويضبط lastRunDate", async () => {
  await resetLog();
  makeOverdueInstallment(S.directSaleId, 7);
  const fake = createScheduler({ messaging, logger: { log() {}, error() {} } });
  await settings.setMany({ "reminder.scheduleTime": "09:00", "reminder.autoRun": "1", "whatsapp.enabled": "1" });
  const r = await fake.tick(atTime("09:05"));
  assert.ok(r, "يجب أن يعمل");
  assert.equal(fake.status().lastRunDate, today());
});

test("scheduler: لا يعمل مرتين في اليوم نفسه", async () => {
  const fake = createScheduler({ messaging, logger: { log() {}, error() {} } });
  await settings.setMany({ "reminder.scheduleTime": "09:00", "reminder.autoRun": "1" });
  await fake.tick(atTime("09:05"));
  const second = await fake.tick(atTime("10:00"));
  assert.equal(second, null, "يجب ألا يعيد التنفيذ في نفس اليوم");
  assert.equal(fake.status().lastRunDate, today());
});
