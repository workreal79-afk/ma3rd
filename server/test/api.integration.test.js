import Database from "better-sqlite3";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* ------------------------------------------------------------------ */
/* إعداد بيئة اختبار معزولة (قاعدة بيانات مستقلة + إيقاف النسخ التلقائي) */
/* ------------------------------------------------------------------ */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");
const dbName = `qa-integration-${process.pid}-${Date.now()}.sqlite`;
process.env.SHOWROOM_DB = dbName;
process.env.SHOWROOM_AUTO_BACKUP = "0";
process.env.NODE_ENV = "test";
process.env.SHOWROOM_SEED_DEMO = "1";
delete process.env.SHOWROOM_AUTH_USER;
delete process.env.SHOWROOM_AUTH_PASS;
delete process.env.SHOWROOM_API_TOKEN;

const { createApp } = await import("../src/app.js");
const { app, context } = createApp();
const { db } = context;

const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;
const API = `${BASE}/api`;

test.after(() => {
  try { server.close(); } catch (_) {}
  try { db.close(); } catch (_) {}
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.rmSync(path.join(dataDir, dbName + suffix), { force: true }); } catch (_) {}
  }
});

/* ------------------------------------------------------------------ */
/* أدوات المساعدة                                                       */
/* ------------------------------------------------------------------ */
async function call(method, url, body, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  let payload;
  if (body instanceof Uint8Array) {
    headers["Content-Type"] = opts.contentType || "application/octet-stream";
    payload = body;
  } else if (body !== undefined) {
    if (!opts.rawBody) headers["Content-Type"] = "application/json";
    payload = opts.rawBody ? body : JSON.stringify(body);
  }
  const res = await fetch(`${API}${url}`, { method, headers, body: payload });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch (_) { /* يبقى نصًا (HTML) */ }
  return { status: res.status, ok: res.ok, data, text, headers: res.headers, json: typeof data === "object" && !Array.isArray(data) && data !== null ? data : null };
}
const get = (u, o) => call("GET", u, undefined, o);
const post = (u, b, o) => call("POST", u, b, o);
const put = (u, b, o) => call("PUT", u, b, o);
const del = (u, o) => call("DELETE", u, undefined, o);

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const shiftDays = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const sum = (arr, key) => arr.reduce((a, x) => a + Number(x[key] || 0), 0);
const restoreTempFiles = () => fs.readdirSync(dataDir)
  .filter((name) => /^restore-.*\.sqlite(?:-(?:wal|shm|journal))?$/.test(name))
  .sort();

// حالة مشتركة تتراكم عبر الاختبارات (تشغيل تسلسلي مقصود)
const S = {};

/* ================================================================== */
/* 1) الإقلاع والصحة والثبات                                            */
/* ================================================================== */

test("health: /api/health يعيد ok وتاريخ اليوم بصيغة YYYY-MM-DD", async () => {
  const r = await get("/health");
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.match(r.data.time, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(r.data.time, today());
});

test("health: حالة النسخ الاحتياطي التلقائي تُقرأ من متغيرات البيئة", async () => {
  const r = await get("/backup/status");
  assert.equal(r.status, 200);
  assert.equal(r.data.enabled, false); // SHOWROOM_AUTO_BACKUP=0 في الاختبار
  assert.equal(r.data.trigger, "after-action");
  assert.equal(r.data.retention, 30);
  assert.equal(typeof r.data.count, "number");
});

test("backup: ينشئ نسخة بعد التعديلات الناجحة فقط", async () => {
  const original = context.autoBackup;
  const requests = [];
  let createdId = null;
  context.autoBackup = {
    enabled: true,
    afterAction() {
      requests.push("action");
      return Promise.resolve(null);
    },
  };
  try {
    const created = await post("/customers", { name: "نسخة بعد الإجراء", national_id: `89${Date.now() % 100000000}` });
    assert.equal(created.ok, true);
    createdId = created.data?.id;
    assert.equal(requests.length, 1);

    const rejected = await post("/customers", {});
    assert.equal(rejected.status, 400);
    assert.equal(requests.length, 1);

    await get("/customers");
    assert.equal(requests.length, 1);
  } finally {
    if (createdId) db.prepare("DELETE FROM customers WHERE id=?").run(createdId);
    context.autoBackup = original;
  }
});

test("routing: مسار API غير معروف يعيد 404", async () => {
  const r = await get("/does-not-exist");
  assert.equal(r.status, 404);
});

test("routing: مسار API غير معروف يجب أن يعيد JSON وليس HTML", async () => {
  const r = await get("/does-not-exist");
  assert.equal(r.headers.get("content-type")?.includes("application/json"), true);
  assert.equal(typeof r.json?.error, "string");
});

test("static: الواجهة المبنية تُخدم من الجذر مع دعم الروابط العميقة", async (t) => {
  const dist = path.join(__dirname, "..", "..", "client", "dist", "index.html");
  if (!fs.existsSync(dist)) return t.skip("client/dist غير مبني — نفّذ npm run build");
  const root = await fetch(`${BASE}/`);
  assert.equal(root.status, 200);
  assert.match(root.headers.get("content-type"), /text\/html/);
  const deep = await fetch(`${BASE}/sales`);
  assert.equal(deep.status, 200);
  const body = await deep.text();
  assert.match(body, /<div id="root">/);
});

test("security: التشغيل المحلي الاختباري يعمل؛ منع الإنتاج غير المهيأ مغطى في security.production.test.js", async () => {
  assert.equal(process.env.NODE_ENV, "test");
  assert.equal((await get("/dashboard")).status, 200);
});

test("security: CORS مغلق افتراضيًا ولا يسمح لنطاق عشوائي بقراءة البيانات", async () => {
  const r = await get("/health");
  assert.equal(r.headers.get("access-control-allow-origin"), null);
  const foreign = await fetch(`${API}/health`, { headers: { Origin: "https://untrusted.example" } });
  assert.equal(foreign.headers.get("access-control-allow-origin"), null);
});

test("security: رأس X-Powered-By معطّل", async () => {
  const r = await get("/health");
  assert.equal(r.headers.get("x-powered-by"), null);
});

/* ================================================================== */
/* 2) البيانات الأولية (seed)                                          */
/* ================================================================== */

test("seed: قاعدة جديدة تُهيّأ بـ 3 سيارات وعميلين وكفيل وتسلسلات مرقّمة", async () => {
  const vehicles = (await get("/vehicles")).data;
  const customers = (await get("/customers")).data;
  const guarantors = (await get("/guarantors")).data;
  const sellers = (await get("/sellers")).data;
  assert.equal(vehicles.length, 3);
  assert.equal(customers.length, 2);
  assert.equal(guarantors.length, 1);
  assert.equal(sellers.length, 0);
  assert.ok(vehicles.every((v) => v.status === "IN_STOCK"));
  assert.equal(sum(vehicles, "price"), 235000);
  const seq = db.prepare("SELECT name,value FROM sequences ORDER BY name").all();
  assert.ok(seq.some((x) => x.name === "seller_receipt"), "التسلسل seller_receipt غير مُهيّأ");
});

test("seed: كل عدادات الأرقام يجب أن تُهيّأ عند إنشاء قاعدة جديدة", async () => {
  const seq = db.prepare("SELECT name FROM sequences").all().map((x) => x.name);
  for (const name of ["sale", "contract", "bill", "note", "receipt"]) {
    assert.ok(seq.includes(name), `العداد ${name} غير مُهيّأ (nextNumber يعالجه لاحقًا لكن البذرة لا تعمل)`);
  }
});

test("seed: مخطط قاعدة البيانات يحتوي كل الجداول المطلوبة والفهارس", () => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
  for (const t of ["customers", "vehicles", "guarantors", "sellers", "sales", "contracts", "installments", "payments", "bills", "promissory_notes", "sequences", "expenses", "audit_log", "seller_payments", "schema_migrations"]) {
    assert.ok(tables.includes(t), `الجدول ${t} مفقود`);
  }
  const migrations = db.prepare("SELECT COUNT(*) c FROM schema_migrations").get().c;
  assert.equal(migrations, 15, "يجب تطبيق 15 هجرة بما فيها جداول المراسلة");
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_bills_installment_unique'").get();
  assert.ok(idx, "الفهرس الفريد على bills.installment_id مفقود");
  assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
  assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
});

test("dashboard: يعكس بيانات المخزون الأولية بدقة", async () => {
  const r = await get("/dashboard");
  assert.equal(r.status, 200);
  const d = r.data;
  assert.equal(d.vehicles, 3);
  assert.equal(d.available, 3);
  assert.equal(d.reserved, 0);
  assert.equal(d.sold, 0);
  assert.equal(d.customers, 2);
  assert.equal(d.inventory_value, 235000);
  assert.equal(d.outstanding, 0);
  assert.equal(d.overdue_amount, 0);
  assert.deepEqual(d.upcoming, []);
});

/* ================================================================== */
/* 3) وحدة السيارات                                                     */
/* ================================================================== */

test("vehicles: إنشاء سيارة بالحد الأدنى من البيانات مع القيم الافتراضية", async () => {
  const r = await post("/vehicles", { plate_number: "QA-1000", make: "فورد", model: "تورس" });
  assert.equal(r.status, 200);
  S.vehicleBasic = r.data;
  assert.equal(r.data.condition, "USED");
  assert.equal(r.data.ownership_type, "SHOWROOM");
  assert.equal(r.data.status, "IN_STOCK");
  assert.equal(r.data.images_json, "[]");
  assert.equal(r.data.price, 0);
  assert.equal(r.data.owner_seller_id, null);
});

test("vehicles: رفض إنشاء سيارة بدون لوحة/ماركة/موديل", async () => {
  assert.equal((await post("/vehicles", { make: "فورد", model: "تورس" })).status, 400);
  assert.equal((await post("/vehicles", { plate_number: "X", model: "تورس" })).status, 400);
  assert.equal((await post("/vehicles", { plate_number: "X", make: "فورد" })).status, 400);
  assert.equal((await post("/vehicles", {})).status, 400);
});

test("vehicles: رفض سعر سالب أو غير رقمي", async () => {
  const r = await post("/vehicles", { plate_number: "QA-BAD", make: "فورد", model: "تورس", price: -5 });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /سعر السيارة غير صحيح/);
  const r2 = await post("/vehicles", { plate_number: "QA-BAD", make: "فورد", model: "تورس", price: "abc" });
  assert.equal(r2.status, 400);
});

test("vehicles: حالة جديد/مستعمل تُحفظ وتُرفض القيمة الشاذة على مستوى القاعدة", async () => {
  const r = await post("/vehicles", { plate_number: "QA-NEW", make: "تويوتا", model: "لاندكروزر", condition: "NEW", price: 250000 });
  assert.equal(r.status, 200);
  assert.equal(r.data.condition, "NEW");
  // قيمة غير مسموحة يجب أن تُرفض (CHECK في المخطط)
  const bad = await post("/vehicles", { plate_number: "QA-BADC", make: "تويوتا", model: "x", condition: "BROKEN" });
  assert.equal(bad.status, 400);
});

test("vehicles: ملكية الغير تنشئ بائعًا جديدًا داخل نفس المعاملة", async () => {
  const r = await post("/vehicles", {
    plate_number: "QA-TP-1", make: "هيونداي", model: "أكسنت", price: 45000,
    ownership_type: "THIRD_PARTY",
    owner_seller: { name: "بائع الاختبار الأول", national_id: "9000000001", phone: "0500000011", city: "القنفذة" },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.ownership_type, "THIRD_PARTY");
  assert.equal(r.data.owner_seller_name, "بائع الاختبار الأول");
  S.tpVehicle = r.data;
  const sellers = (await get("/sellers")).data;
  S.seller = sellers.find((x) => x.national_id === "9000000001");
  assert.ok(S.seller, "لم يتم إنشاء سجل البائع");
});

test("vehicles: ملكية الغير بدون بيانات بائع مرفوضة", async () => {
  const r = await post("/vehicles", { plate_number: "QA-TP-2", make: "كيا", model: "ريو", ownership_type: "THIRD_PARTY" });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /يجب إدخال بيانات البائع/);
});

test("vehicles: رقم هوية بائع مكرر مرفوض", async () => {
  const r = await post("/vehicles", {
    plate_number: "QA-TP-3", make: "كيا", model: "ريو", ownership_type: "THIRD_PARTY",
    owner_seller: { name: "مكرر", national_id: "9000000001" },
  });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /مسجل بالفعل/);
  // المعاملة يجب أن تتراجع: لا سيارة جديدة
  const v = (await get("/vehicles?search=QA-TP-3")).data;
  assert.equal(v.length, 0);
});

test("vehicles: بائع محدد غير موجود مرفوض", async () => {
  const r = await post("/vehicles", { plate_number: "QA-TP-4", make: "كيا", model: "ريو", ownership_type: "THIRD_PARTY", owner_seller_id: 999999 });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /البائع المحدد غير موجود/);
});

test("vehicles: ربط بائع مسجل مسبقًا", async () => {
  const r = await post("/vehicles", { plate_number: "QA-TP-5", make: "نيسان", model: "صني", ownership_type: "THIRD_PARTY", owner_seller_id: S.seller.id, price: 33000 });
  assert.equal(r.status, 200);
  assert.equal(r.data.owner_seller_id, S.seller.id);
  assert.equal(r.data.owner_seller_name, S.seller.name);
});

test("vehicles: الصور تُخزن كـ JSON حتى 5 صور وتُسترجع سليمة", async () => {
  const images = [`data:image/png;base64,AAA${"x".repeat(20)}`, "data:image/png;base64,BBB"];
  const r = await post("/vehicles", { plate_number: "QA-IMG", make: "ميتسوبيشي", model: "لانسر", images });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.data.images_json), images);
  const summary = (await get("/vehicles?search=QA-IMG")).data.find((v) => v.id === r.data.id);
  assert.equal(summary.image_count, images.length);
  assert.equal(Object.hasOwn(summary, "images_json"), false, "الصور لا تُحمَّل في القائمة");
  const detail = await get(`/vehicles/${r.data.id}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(JSON.parse(detail.data.images_json), images);
  assert.equal((await get("/vehicles/999999")).status, 404);
  assert.equal((await get("/vehicles/not-an-id")).status, 404);
  const updated = await put(`/vehicles/${r.data.id}`, { plate_number: "QA-IMG", make: "ميتسوبيشي", model: "لانسر" });
  assert.equal(updated.status, 200);
  assert.deepEqual(JSON.parse(updated.data.images_json), images, "تعديل البيانات لا يحذف الصور إذا لم يُرسل images");
  // غير مصفوفة تُعامل كمصفوفة فارغة
  const r2 = await post("/vehicles", { plate_number: "QA-IMG2", make: "ميتسوبيشي", model: "لانسر", images: "ليس-مصفوفة" });
  assert.equal(r2.data.images_json, "[]");
});

test("vehicles: التعديل يحدّث الحقول ويعيد 404 للسجل غير الموجود", async () => {
  const id = S.vehicleBasic.id;
  const r = await put(`/vehicles/${id}`, { plate_number: "QA-1000-M", make: "فورد", model: "تورس", model_year: 2025, color: "أبيض", condition: "NEW", price: 70000, status: "IN_STOCK", images: [], ownership_type: "SHOWROOM" });
  assert.equal(r.status, 200);
  assert.equal(r.data.plate_number, "QA-1000-M");
  assert.equal(r.data.condition, "NEW");
  assert.equal(r.data.price, 70000);
  assert.equal(r.data.model_year, 2025);
  assert.equal((await put("/vehicles/999999", { plate_number: "x", make: "y", model: "z" })).status, 404);
  assert.equal((await put(`/vehicles/${id}`, { make: "y", model: "z" })).status, 400);
});

test("vehicles: التعديل بدون حقل الحالة يجب ألا يعيد سيارة مباعة إلى المخزون", async () => {
  const v = (await post("/vehicles", { plate_number: "QA-STATUS", make: "فورد", model: "فيوجن", price: 50000 })).data;
  await put(`/vehicles/${v.id}/status`, { status: "SOLD" });
  const r = await put(`/vehicles/${v.id}`, { plate_number: "QA-STATUS-2", make: "فورد", model: "فيوجن", price: 50000 });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, "SOLD", "الحالة يجب أن تبقى SOLD");
});

test("vehicles: تبديل الحالة يقبل القيم الثلاث ويرفض غيرها", async () => {
  const v = (await post("/vehicles", { plate_number: "QA-ST", make: "فورد", model: "إكسبلورر" })).data;
  for (const status of ["RESERVED", "SOLD", "IN_STOCK"]) {
    const r = await put(`/vehicles/${v.id}/status`, { status });
    assert.equal(r.status, 200);
    assert.equal((await get(`/vehicles?search=QA-ST`)).data[0].status, status);
  }
  assert.equal((await put(`/vehicles/${v.id}/status`, { status: "BROKEN" })).status, 400);
  assert.equal((await put(`/vehicles/${v.id}/status`, {})).status, 400);
  assert.equal((await put(`/vehicles/999999/status`, { status: "IN_STOCK" })).status, 404);
});

test("vehicles: فلتر available=1 يعيد السيارات المتاحة فقط", async () => {
  const sold = (await post("/vehicles", { plate_number: "QA-AVAIL-SOLD", make: "فورد", model: "تورس" })).data;
  const reserved = (await post("/vehicles", { plate_number: "QA-AVAIL-RES", make: "فورد", model: "تورس" })).data;
  await put(`/vehicles/${sold.id}/status`, { status: "SOLD" });
  await put(`/vehicles/${reserved.id}/status`, { status: "RESERVED" });

  const all = (await get("/vehicles")).data;
  const avail = (await get("/vehicles?available=1")).data;
  assert.ok(avail.length <= all.length - 2, "يجب أن يستبعد الفلتر المباعة والمحجوزة");
  assert.ok(avail.every((v) => String(v.status).toUpperCase() === "IN_STOCK"));
  assert.ok(!avail.some((v) => v.id === sold.id || v.id === reserved.id));
});

test("vehicles: البحث يشمل اللوحة والهيكل والماركة والموديل واسم البائع", async () => {
  assert.equal((await get("/vehicles?search=QA-1000-M")).data.length, 1);
  assert.equal((await get("/vehicles?search=فورد")).data.length > 0, true);
  assert.equal((await get("/vehicles?search=بائع الاختبار الأول")).data.length, 2); // QA-TP-1 و QA-TP-5
  assert.equal((await get("/vehicles?search=VIN-DEMO-002")).data.length, 1);
  assert.equal((await get("/vehicles?search=لا-يوجد-أبدا")).data.length, 0);
});

/* ================================================================== */
/* 4) الأشخاص: مشترون / كفلاء / بائعون                                  */
/* ================================================================== */

for (const kind of ["customers", "guarantors", "sellers"]) {
  const label = { customers: "المشتري", guarantors: "الكفيل", sellers: "البائع" }[kind];

  test(`${kind}: إنشاء ${label} والتحقق من تكرار رقم الهوية`, async () => {
    const nid = `71${kind.length}${Date.now() % 100000}`;
    const created = await post(`/${kind}`, { name: `اسم ${label} QA`, national_id: nid, phone: "0555000000", city: "جدة", address: "حي الروضة" });
    assert.equal(created.status, 200);
    assert.equal(created.data.name, `اسم ${label} QA`);
    S[`${kind}New`] = created.data;

    const dup = await post(`/${kind}`, { name: "مكرر", national_id: nid });
    assert.equal(dup.status, 409);
    assert.match(dup.data.error, /مسجل بالفعل/);

    const noName = await post(`/${kind}`, { national_id: "1" });
    assert.equal(noName.status, 400);
  });

  test(`${kind}: تعديل ${label} مع منع تكرار الهوية مع سجل آخر`, async () => {
    const id = S[`${kind}New`].id;
    const r = await put(`/${kind}/${id}`, { name: `معدّل ${label}`, national_id: S[`${kind}New`].national_id, phone: "0555111111", city: "مكة", address: "حي العزيزية" });
    assert.equal(r.status, 200);
    assert.equal(r.data.name, `معدّل ${label}`);
    assert.equal(r.data.city, "مكة");
    // نفس الهوية لنفس السجل مسموح
    assert.equal((await put(`/${kind}/${id}`, { name: "معدّل", national_id: S[`${kind}New`].national_id })).status, 200);
    assert.equal((await put(`/${kind}/999999`, { name: "x" })).status, 404);
    assert.equal((await put(`/${kind}/${id}`, { name: "  " })).status, 400);
  });

  test(`${kind}: البحث وقائمة ${label}`, async () => {
    const all = await get(`/${kind}`);
    assert.equal(all.status, 200);
    assert.ok(Array.isArray(all.data));
    const found = await get(`/${kind}?search=${encodeURIComponent("معدّل")}`);
    assert.ok(found.data.length >= 1);
    const none = await get(`/${kind}?search=zzz-no-match-zzz`);
    assert.equal(none.data.length, 0);
  });

  test(`${kind}: معرّف غير رقمي يعيد 404 وليس 500`, async () => {
    assert.equal((await get(`/${kind}/abc/profile`)).status, 404);
    assert.equal((await put(`/${kind}/abc`, { name: "x" })).status, 404);
  });
}

test("customers: ملف المشتري يعيد البنية الكاملة", async () => {
  const r = await get(`/customers/${S.customersNew.id}/profile`);
  assert.equal(r.status, 200);
  assert.ok(r.data.customer);
  assert.deepEqual(r.data.sales, []);
  assert.deepEqual(r.data.installments, []);
  assert.deepEqual(r.data.payments, []);
  assert.equal((await get("/customers/999999/profile")).status, 404);
});

test("guarantors: ملف الكفيل يعيد السندات والعقود المكفولة", async () => {
  const r = await get(`/guarantors/${S.guarantorsNew.id}/profile`);
  assert.equal(r.status, 200);
  assert.ok(r.data.guarantor);
  assert.deepEqual(r.data.notes, []);
  assert.deepEqual(r.data.sales, []);
});

test("sellers: ملف البائع يعيد ملخص المستحقات", async () => {
  const r = await get(`/sellers/${S.seller.id}/profile`);
  assert.equal(r.status, 200);
  assert.ok(r.data.seller);
  assert.equal(r.data.vehicles.length, 2); // QA-TP-1 و QA-TP-5
  assert.deepEqual(r.data.sales, []);
  assert.deepEqual(r.data.payments, []);
  assert.deepEqual(r.data.summary, { due: 0, paid: 0, totalSales: 0 });
});

/* ================================================================== */
/* 5) المبيعات — كاش                                                    */
/* ================================================================== */

test("sales: بيع كاش ينشئ بيعًا وعقدًا ويحوّل السيارة إلى مباعة", async () => {
  const vehicles = (await get("/vehicles?available=1")).data;
  const vehicle = vehicles.find((v) => v.vin === "VIN-DEMO-001");
  const customer = (await get("/customers")).data.find((c) => c.national_id === "1020304050");
  const r = await post("/sales", {
    customer_id: customer.id, vehicle_id: vehicle.id, vehicle_mode: "EXISTING",
    sale_type: "CASH", transaction_mode: "DIRECT", sale_price: 95000, down_payment: 95000,
  });
  assert.equal(r.status, 200);
  S.cashSale = r.data;
  assert.match(r.data.sale_number, /^SALE-\d{6}$/);
  assert.match(r.data.contract_number, /^CON-\d{6}$/);

  const detail = await get(`/sales/${r.data.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.sale.sale_type, "CASH");
  assert.equal(detail.data.sale.status, "ACTIVE");
  assert.equal(detail.data.sale.remaining_amount, 0);
  assert.equal(detail.data.sale.seller_id, null);
  assert.equal(detail.data.sale.installment_count, 0);
  assert.deepEqual(detail.data.installments, []);
  assert.equal(detail.data.note ?? null, null, "لا يجب إنشاء سند أمر في البيع الكاش");
  assert.equal(detail.data.sale.customer_name, customer.name);
  assert.equal(detail.data.sale.contract_number, r.data.contract_number);

  const after = (await get(`/vehicles?search=VIN-DEMO-001`)).data[0];
  assert.equal(after.status, "SOLD");
  assert.equal(after.sold_customer_name, customer.name);
});

test("sales: عقد البيع الكاش يحمل الدائن الافتراضي للمعرض", () => {
  const c = db.prepare("SELECT * FROM contracts WHERE sale_id=?").get(S.cashSale.id);
  assert.equal(c.creditor_name, "أحمد متعب علي الزبيدي");
  assert.equal(c.installments_count, 0);
  assert.equal(c.installment_amount, 0);
});

test("sales: التحقق من المدخلات — حالات مرفوضة", async () => {
  const v = (await get("/vehicles?available=1")).data[0];
  const c = (await get("/customers")).data[0];
  const cases = [
    [{ vehicle_id: v.id, sale_type: "CASH", sale_price: 1000 }, /بيانات المشتري/],
    [{ customer_id: c.id, sale_type: "CASH", sale_price: 1000 }, /سيارة/],
    [{ customer_id: c.id, vehicle_id: v.id, sale_price: 1000 }, /بيانات المشتري|مطلوبة/],
    [{ customer_id: c.id, vehicle_id: v.id, sale_type: "CASH" }, /مطلوبة/],
    [{ customer_id: c.id, vehicle_id: v.id, sale_type: "CASH", sale_price: 0 }, /أكبر من صفر|مطلوبة/],
    [{ customer_id: c.id, vehicle_id: v.id, sale_type: "CASH", sale_price: -1 }, /غير صحيح/],
    [{ customer_id: c.id, vehicle_id: v.id, sale_type: "CASH", sale_price: 1000, down_payment: 2000 }, /المقدم لا يمكن/],
    [{ customer_id: c.id, vehicle_id: 999999, vehicle_mode: "EXISTING", sale_type: "CASH", sale_price: 1000 }, /غير متاحة/],
    [{ customer_id: c.id, vehicle_mode: "MANUAL", manual_vehicle: { make: "x" }, sale_type: "CASH", sale_price: 1000 }, /رقم اللوحة/],
  ];
  for (const [body, pattern] of cases) {
    const r = await post("/sales", body);
    assert.equal(r.status, 400, `الحالة ${JSON.stringify(body)} أعادت ${r.status} — ${r.text.slice(0, 120)}`);
    assert.match(r.data.error, pattern);
  }
});

test("sales: سيارة محجوزة أو مباعة لا يمكن بيعها", async () => {
  const sold = (await get("/vehicles?search=VIN-DEMO-001")).data[0];
  const c = (await get("/customers")).data[0];
  const r1 = await post("/sales", { customer_id: c.id, vehicle_id: sold.id, vehicle_mode: "EXISTING", sale_type: "CASH", sale_price: 1000 });
  assert.equal(r1.status, 400);
  assert.match(r1.data.error, /غير متاحة للبيع/);

  const res = (await post("/vehicles", { plate_number: "QA-RES", make: "فورد", model: "فوكس" })).data;
  await put(`/vehicles/${res.id}/status`, { status: "RESERVED" });
  const r2 = await post("/sales", { customer_id: c.id, vehicle_id: res.id, vehicle_mode: "EXISTING", sale_type: "CASH", sale_price: 1000 });
  assert.equal(r2.status, 400);
  await put(`/vehicles/${res.id}/status`, { status: "IN_STOCK" });
});

test("sales: مشتري غير موجود يعيد خطأ واضحًا وليس 500", async () => {
  const v = (await get("/vehicles?available=1")).data[0];
  const r = await post("/sales", { customer_id: 999999, vehicle_id: v.id, vehicle_mode: "EXISTING", sale_type: "CASH", sale_price: 1000 });
  assert.equal(r.status, 400);
});

test("sales: سيارة غير موجودة (وضع MANUAL معطّل) يعيد خطأ واضحًا", async () => {
  const c = (await get("/customers")).data[0];
  const r = await post("/sales", { customer_id: c.id, vehicle_id: 999999, sale_type: "CASH", sale_price: 1000 });
  assert.equal(r.status, 400);
});

test("sales: إدخال سيارة جديدة أثناء البيع (MANUAL) يسجّلها كمباعة مباشرة", async () => {
  const c = (await get("/customers")).data[0];
  const r = await post("/sales", {
    customer_id: c.id, vehicle_mode: "MANUAL",
    manual_vehicle: { plate_number: "QA-MAN-1", vin: "VIN-MAN-1", make: "شيفروليه", model: "كابرس", model_year: 2022, color: "أسود", condition: "USED" },
    sale_type: "CASH", transaction_mode: "DIRECT", sale_price: 40000, down_payment: 40000,
  });
  assert.equal(r.status, 200);
  S.manualSale = r.data;
  const v = (await get("/vehicles?search=QA-MAN-1")).data[0];
  assert.equal(v.status, "SOLD");
  assert.equal(v.price, 40000);
  assert.equal(v.make, "شيفروليه");
  assert.match(v.notes, /أثناء عملية البيع/);
});

/* ================================================================== */
/* 6) المبيعات — تقسيط وخطة الأقساط                                     */
/* ================================================================== */

test("sales: تقسيط بدون باقي — جدول الأقساط والكمبيالات والسند", async () => {
  const v = (await get("/vehicles?available=1")).data.find((x) => x.vin === "VIN-DEMO-002");
  const c = (await get("/customers")).data.find((x) => x.national_id === "1098765432");
  const firstDue = "2026-11-01";
  const r = await post("/sales", {
    customer_id: c.id, vehicle_id: v.id, vehicle_mode: "EXISTING", sale_type: "INSTALLMENT",
    transaction_mode: "DIRECT", sale_price: 78000, down_payment: 18000,
    installment_amount: 5000, first_due_date: firstDue,
  });
  assert.equal(r.status, 200);
  S.simplePlan = r.data;
  const detail = (await get(`/sales/${r.data.id}`)).data;
  // 60000 / 5000 = 12 قسطًا بالضبط
  assert.equal(detail.sale.installment_count, 12);
  assert.equal(detail.installments.length, 12);
  assert.equal(sum(detail.installments, "amount"), 60000);
  assert.ok(detail.installments.every((i) => i.amount === 5000));
  assert.equal(detail.installments[0].due_date, "2026-11-01");
  assert.equal(detail.installments[11].due_date, "2027-10-01");
  assert.equal(detail.sale.remaining_amount, 60000);
  // كمبيالة واحدة لكل قسط
  const bills = db.prepare("SELECT b.* FROM bills b JOIN contracts c ON c.id=b.contract_id WHERE c.sale_id=?").all(r.data.id);
  assert.equal(bills.length, 12);
  assert.equal(new Set(bills.map((b) => b.bill_number)).size, 12, "أرقام الكمبيالات يجب أن تكون فريدة");
  // سند أمر للمشتري بقيمة المتبقي
  assert.equal(detail.note.amount, 60000);
  assert.equal(detail.note.party_type, "CUSTOMER");
  assert.equal(detail.note.due_date, "2027-10-01");
});

test("sales: أرقام الكمبيالات الجديدة بدون أصفار بادئة (متطلب V47)", async () => {
  const bills = db.prepare("SELECT bill_number FROM bills ORDER BY id").all();
  assert.ok(bills.length >= 12);
  assert.match(bills[0].bill_number, /^BILL-\d+$/);
  assert.equal(/^BILL-0/.test(bills[0].bill_number), false, "يجب ألا يحتوي رقم الكمبيالة على أصفار بادئة");
});

test("sales: تقسيط بباقي صغير ينشئ قسطًا أخيرًا مستقلًا", async () => {
  const v = (await get("/vehicles?available=1")).data.find((x) => x.vin === "VIN-DEMO-003");
  const c = (await get("/customers")).data[0];
  const r = await post("/sales", {
    customer_id: c.id, vehicle_id: v.id, vehicle_mode: "EXISTING", sale_type: "INSTALLMENT",
    sale_price: 62000, down_payment: 10000, installment_amount: 1500, first_due_date: "2026-12-15",
  });
  assert.equal(r.status, 200);
  S.remainderPlan = r.data;
  const detail = (await get(`/sales/${r.data.id}`)).data;
  // 52000 / 1500 = 34 قسطًا (51000) + باقي 1000
  assert.equal(detail.sale.installment_count, 35);
  assert.equal(detail.installments.length, 35);
  assert.equal(detail.installments[34].amount, 1000);
  assert.equal(sum(detail.installments, "amount"), 52000);
});

test("sales: ضم الباقي الصغير إلى القسط الأخير عند الطلب", async () => {
  const v = (await post("/vehicles", { plate_number: "QA-COMB", make: "تويوتا", model: "هايلكس", price: 99500 })).data;
  const c = (await get("/customers")).data[0];
  const r = await post("/sales", {
    customer_id: c.id, vehicle_id: v.id, vehicle_mode: "EXISTING", sale_type: "INSTALLMENT",
    sale_price: 99500, down_payment: 0, installment_amount: 1500, first_due_date: "2027-01-10",
    combine_small_remainder: true,
  });
  assert.equal(r.status, 200);
  const detail = (await get(`/sales/${r.data.id}`)).data;
  // 99500 / 1500 = 66 قسطًا (99000) + باقي 500 (أقل من 1000) → يُضم إلى الأخير
  assert.equal(detail.sale.installment_count, 66);
  assert.equal(detail.installments.length, 66);
  assert.equal(detail.installments[65].amount, 2000);
  assert.equal(sum(detail.installments, "amount"), 99500);
});

test("sales: تواريخ الاستحقاق تُثبَّت على آخر يوم من الشهر (31 يناير)", async () => {
  const v = (await post("/vehicles", { plate_number: "QA-CLAMP", make: "كيا", model: "سبورتاج", price: 60000 })).data;
  const c = (await get("/customers")).data[1];
  const r = await post("/sales", {
    customer_id: c.id, vehicle_id: v.id, vehicle_mode: "EXISTING", sale_type: "INSTALLMENT",
    sale_price: 60000, down_payment: 0, installment_amount: 20000, first_due_date: "2028-01-31",
  });
  assert.equal(r.status, 200);
  const detail = (await get(`/sales/${r.data.id}`)).data;
  assert.deepEqual(detail.installments.map((i) => i.due_date), ["2028-01-31", "2028-02-29", "2028-03-31"]);
});

test("sales: دورية الاستحقاق اليدوية كل 4 أشهر تضبط الأقساط والكمبيالات", async () => {
  const v = (await post("/vehicles", { plate_number: "QA-4MONTH", make: "تويوتا", model: "كامري", price: 40000 })).data;
  const c = (await get("/customers")).data[0];
  const r = await post("/sales", {
    customer_id: c.id, vehicle_id: v.id, vehicle_mode: "EXISTING", sale_type: "INSTALLMENT",
    sale_price: 40000, down_payment: 0, installment_amount: 10000, first_due_date: "2027-01-31",
    installment_interval_value: 4, installment_interval_unit: "MONTH",
  });
  assert.equal(r.status, 200, r.text);
  const detail = (await get(`/sales/${r.data.id}`)).data;
  assert.equal(detail.sale.installment_interval_months, 4);
  assert.deepEqual(detail.installments.map((i) => i.due_date), ["2027-01-31", "2027-05-31", "2027-09-30", "2028-01-31"]);
});

test("sales: أرقام الكمبيالات تتسلسل حسب الأقساط ولا تتأثر بعداد المبيعات الأخرى", async () => {
  const v = (await post("/vehicles", { plate_number: "QA-BILLSEQ", make: "تويوتا", model: "يارس", price: 40000 })).data;
  const c = (await get("/customers")).data[0];
  const r = await post("/sales", {
    customer_id: c.id, vehicle_id: v.id, vehicle_mode: "EXISTING", sale_type: "INSTALLMENT",
    sale_price: 40000, down_payment: 0, installment_amount: 10000, first_due_date: "2027-01-31",
    installment_interval_value: 4, installment_interval_unit: "MONTH", bill_start_serial: 7,
  });
  assert.equal(r.status, 200, r.text);
  const detail = (await get(`/sales/${r.data.id}`)).data;
  assert.deepEqual(detail.installments.map((i) => i.bill_number), ["BILL-7", "BILL-8", "BILL-9", "BILL-10"]);
  const doc = await get(`/documents/bills/${r.data.id}`);
  assert.equal(doc.status, 200);
  assert.match(doc.text, /٧ \/ ٤/);
  assert.match(doc.text, /٨ \/ ٤/);
  assert.match(doc.text, /٩ \/ ٤/);
  assert.match(doc.text, /١٠ \/ ٤/);
});

test("sales: دورية الاستحقاق السنوية تضبط كل سنة", async () => {
  const v = (await post("/vehicles", { plate_number: "QA-YEAR", make: "هيونداي", model: "سوناتا", price: 30000 })).data;
  const c = (await get("/customers")).data[0];
  const r = await post("/sales", {
    customer_id: c.id, vehicle_id: v.id, vehicle_mode: "EXISTING", sale_type: "INSTALLMENT",
    sale_price: 30000, down_payment: 0, installment_amount: 10000, first_due_date: "2027-02-28",
    installment_interval_value: 1, installment_interval_unit: "YEAR",
  });
  assert.equal(r.status, 200, r.text);
  const detail = (await get(`/sales/${r.data.id}`)).data;
  assert.equal(detail.sale.installment_interval_months, 12);
  assert.deepEqual(detail.installments.map((i) => i.due_date), ["2027-02-28", "2028-02-28", "2029-02-28"]);
});

test("sales: تحقق التقسيط — أول استحقاق وقيمة القسط والمتبقي", async () => {
  const v = (await post("/vehicles", { plate_number: "QA-VAL", make: "فورد", model: "رينجر", price: 50000 })).data;
  const c = (await get("/customers")).data[0];
  const base = { customer_id: c.id, vehicle_id: v.id, vehicle_mode: "EXISTING", sale_type: "INSTALLMENT", sale_price: 50000 };

  assert.equal((await post("/sales", { ...base, down_payment: 10000, installment_amount: 5000 })).status, 400); // بدون أول استحقاق
  const noFirst = await post("/sales", { ...base, down_payment: 10000, installment_amount: 5000 });
  assert.match(noFirst.data.error, /أول استحقاق/);

  const badDate = await post("/sales", { ...base, down_payment: 10000, installment_amount: 5000, first_due_date: "2026-02-30" });
  assert.equal(badDate.status, 400);
  assert.match(badDate.data.error, /غير صحيح/);

  const fullDown = await post("/sales", { ...base, down_payment: 50000, installment_amount: 5000, first_due_date: "2026-12-01" });
  assert.equal(fullDown.status, 400);
  assert.match(fullDown.data.error, /مبلغ متبقٍ/);

  const bigMonthly = await post("/sales", { ...base, down_payment: 10000, installment_amount: 999999, first_due_date: "2026-12-01" });
  assert.equal(bigMonthly.status, 400);
  assert.match(bigMonthly.data.error, /أكبر من المبلغ المتبقي/);

  const zeroMonthly = await post("/sales", { ...base, down_payment: 10000, installment_amount: 0, first_due_date: "2026-12-01" });
  assert.equal(zeroMonthly.status, 400);
  assert.match(zeroMonthly.data.error, /أكبر من صفر/);

  // السيارة ما زالت متاحة لأن كل العمليات فشلت
  assert.equal((await get(`/vehicles?search=QA-VAL`)).data[0].status, "IN_STOCK");
});

test("sales: كفيل اختياري — بدون كفيل لا يُنشأ أي سجل كفيل", async () => {
  const v = (await post("/vehicles", { plate_number: "QA-NOG", make: "نيسان", model: "باترول", price: 90000 })).data;
  const c = (await get("/customers")).data[0];
  const before = (await get("/guarantors")).data.length;
  const r = await post("/sales", {
    customer_id: c.id, vehicle_id: v.id, vehicle_mode: "EXISTING", sale_type: "INSTALLMENT",
    sale_price: 90000, down_payment: 30000, installment_amount: 10000, first_due_date: "2026-12-01",
    guarantor: { name: "", national_id: "", phone: "" }, // كائن فارغ
  });
  assert.equal(r.status, 200);
  S.noGuarantorSale = r.data;
  const detail = (await get(`/sales/${r.data.id}`)).data;
  assert.equal(detail.sale.guarantor_id, null);
  assert.equal((await get("/guarantors")).data.length, before, "لا يجب إنشاء سجل كفيل");
  const notes = db.prepare("SELECT * FROM promissory_notes p JOIN contracts c ON c.id=p.contract_id WHERE c.sale_id=?").all(r.data.id);
  assert.equal(notes.length, 1, "سند واحد للمشتري فقط");
  assert.equal((await get(`/documents/guarantor-note/${r.data.id}`)).status, 404);
});

test("sales: كفيل جديد يُنشأ داخل معاملة البيع مع سند كفالة", async () => {
  const v = (await post("/vehicles", { plate_number: "QA-GRN", make: "تويوتا", model: "برادو", price: 120000 })).data;
  const c = (await get("/customers")).data[1];
  const nid = `81${Date.now() % 1000000}`;
  const r = await post("/sales", {
    customer_id: c.id, vehicle_id: v.id, vehicle_mode: "EXISTING", sale_type: "INSTALLMENT",
    sale_price: 120000, down_payment: 20000, installment_amount: 10000, first_due_date: "2026-12-01",
    guarantor: { name: "كفيل من عملية بيع", national_id: nid, phone: "0566666666", city: "القنفذة" },
  });
  assert.equal(r.status, 200);
  S.guarantorSale = r.data;
  const detail = (await get(`/sales/${r.data.id}`)).data;
  assert.ok(detail.sale.guarantor_id);
  assert.equal(detail.sale.guarantor_name, "كفيل من عملية بيع");
  const notes = db.prepare("SELECT party_type,amount FROM promissory_notes p JOIN contracts c ON c.id=p.contract_id WHERE c.sale_id=? ORDER BY p.id").all(r.data.id);
  assert.deepEqual(notes.map((n) => n.party_type), ["CUSTOMER", "GUARANTOR"]);
  assert.ok(notes.every((n) => n.amount === 100000));
  const g = (await get(`/guarantors?search=${encodeURIComponent("كفيل من عملية بيع")}`)).data[0];
  assert.equal(g.national_id, nid);
  assert.equal((await get(`/documents/guarantor-note/${r.data.id}`)).status, 200);
});

test("sales: كفيل محدد برقم غير موجود مرفوض", async () => {
  const v = (await post("/vehicles", { plate_number: "QA-GBAD", make: "كيا", model: "سيراتو", price: 50000 })).data;
  const c = (await get("/customers")).data[0];
  const r = await post("/sales", {
    customer_id: c.id, vehicle_id: v.id, vehicle_mode: "EXISTING", sale_type: "INSTALLMENT",
    sale_price: 50000, down_payment: 0, installment_amount: 5000, first_due_date: "2026-12-01", guarantor_id: 999999,
  });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /الكفيل المحدد غير موجود/);
});

test("sales: هوية مشتري مكررة داخل البيع يجب أن تعيد 409/400 وليس 500", async () => {
  const v = (await post("/vehicles", { plate_number: "QA-DUPC", make: "فورد", model: "موستانج", price: 80000 })).data;
  const existing = (await get("/customers")).data.find((x) => x.national_id === "1020304050");
  const r = await post("/sales", {
    vehicle_mode: "EXISTING", vehicle_id: v.id, sale_type: "CASH", sale_price: 80000, down_payment: 80000,
    customer: { name: "محاولة تكرار", national_id: existing.national_id },
  });
  assert.equal([400, 409].includes(r.status), true, `المتوقع 400/409 لكن وصلت ${r.status}`);
  assert.match(String(r.data.error || ""), /مسجل بالفعل/);
});

test("sales: مشتري جديد يُنشأ ضمن عملية البيع", async () => {
  const v = (await post("/vehicles", { plate_number: "QA-NEWC", make: "هوندا", model: "أكورد", price: 70000 })).data;
  const nid = `61${Date.now() % 1000000}`;
  const r = await post("/sales", {
    vehicle_mode: "EXISTING", vehicle_id: v.id, sale_type: "CASH", sale_price: 70000, down_payment: 70000,
    customer: { name: "مشتري جديد من البيع", national_id: nid, phone: "0577777777", city: "الرياض" },
  });
  assert.equal(r.status, 200);
  S.newCustomerSale = r.data;
  const created = (await get(`/customers?search=${encodeURIComponent("مشتري جديد من البيع")}`)).data[0];
  assert.equal(created.national_id, nid);
  const detail = (await get(`/sales/${r.data.id}`)).data;
  assert.equal(detail.sale.customer_id, created.id);
});

/* ================================================================== */
/* 7) الوساطة ومستحقات البائعين                                         */
/* ================================================================== */

test("sales: وساطة مع بائع محدد — المستحق للبائع يساوي قيمة البيع والدائن هو البائع", async () => {
  const v = (await post("/vehicles", { plate_number: "QA-INT1", make: "تويوتا", model: "كامري", price: 88000, ownership_type: "THIRD_PARTY", owner_seller_id: S.seller.id })).data;
  const c = (await get("/customers")).data[0];
  const r = await post("/sales", {
    customer_id: c.id, vehicle_id: v.id, vehicle_mode: "EXISTING", sale_type: "CASH",
    transaction_mode: "INTERMEDIARY", seller_id: S.seller.id, sale_price: 88000, down_payment: 88000,
  });
  assert.equal(r.status, 200);
  S.intermediarySale = r.data;
  const sale = db.prepare("SELECT * FROM sales WHERE id=?").get(r.data.id);
  assert.equal(sale.transaction_mode, "INTERMEDIARY");
  assert.equal(sale.seller_id, S.seller.id);
  assert.equal(sale.seller_due_amount, 88000);
  assert.equal(sale.seller_paid_amount, 0);
  const contract = db.prepare("SELECT creditor_name FROM contracts WHERE sale_id=?").get(r.data.id);
  assert.equal(contract.creditor_name, S.seller.name);
});

test("sales: وساطة تعتمد على مالك السيارة المسجل على السيارة", async () => {
  const v = (await post("/vehicles", { plate_number: "QA-INT2", make: "هيونداي", model: "إلنترا", price: 55000, ownership_type: "THIRD_PARTY", owner_seller_id: S.seller.id })).data;
  const c = (await get("/customers")).data[1];
  const r = await post("/sales", {
    customer_id: c.id, vehicle_id: v.id, vehicle_mode: "EXISTING", sale_type: "CASH",
    transaction_mode: "INTERMEDIARY", sale_price: 55000, down_payment: 55000, // بدون seller_id
  });
  assert.equal(r.status, 200);
  const sale = db.prepare("SELECT seller_id,seller_due_amount FROM sales WHERE id=?").get(r.data.id);
  assert.equal(sale.seller_id, S.seller.id);
  assert.equal(sale.seller_due_amount, 55000);
});

test("sales: وساطة بدون بائع محدد أو مالك مسجل مرفوضة", async () => {
  const v = (await post("/vehicles", { plate_number: "QA-INT3", make: "نيسان", model: "ألتيما", price: 60000 })).data;
  const c = (await get("/customers")).data[0];
  const r = await post("/sales", {
    customer_id: c.id, vehicle_id: v.id, vehicle_mode: "EXISTING", sale_type: "CASH",
    transaction_mode: "INTERMEDIARY", sale_price: 60000, down_payment: 60000,
  });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /يجب تحديد البائع/);
});

test("sales: وساطة + سيارة مُدخلة يدويًا بدون بائع يجب ألا تنهار الخادم", async () => {
  const c = (await get("/customers")).data[0];
  const r = await post("/sales", {
    customer_id: c.id, vehicle_mode: "MANUAL",
    manual_vehicle: { plate_number: "QA-INTMAN", make: "دودج", model: "تشارجر" },
    sale_type: "CASH", transaction_mode: "INTERMEDIARY", sale_price: 30000, down_payment: 30000,
  });
  assert.equal([400, 200].includes(r.status), true, `المتوقع 400 (أو 200) وليس ${r.status}`);
  if (r.status === 400) assert.match(r.data.error, /البائع/);
});

test("seller-payments: سداد جزئي للبائع ثم تجاوز المستحق مرفوض", async () => {
  const saleId = S.intermediarySale.id;
  const r1 = await post(`/sales/${saleId}/seller-payments`, { amount: 30000, payment_method: "CASH", notes: "دفعة أولى" });
  assert.equal(r1.status, 200);
  assert.match(r1.data.receipt_number, /^SPAY-\d{6}$/);
  S.sellerPayment = r1.data;
  assert.equal(db.prepare("SELECT seller_paid_amount FROM sales WHERE id=?").get(saleId).seller_paid_amount, 30000);

  const over = await post(`/sales/${saleId}/seller-payments`, { amount: 999999 });
  assert.equal(over.status, 400);
  assert.match(over.data.error, /أكبر من المتبقي للبائع/);

  assert.equal((await post(`/sales/${saleId}/seller-payments`, { amount: 0 })).status, 400);
  assert.equal((await post(`/sales/${saleId}/seller-payments`, { amount: -10 })).status, 400);
  assert.equal((await post(`/sales/${saleId}/seller-payments`, { amount: 10, payment_date: "bad-date" })).status, 400);
});

test("seller-payments: غير مسموح على بيع مباشر أو بيع غير موجود", async () => {
  const direct = (await get("/sales")).data.find((s) => s.transaction_mode === "DIRECT" && s.status === "ACTIVE");
  const r = await post(`/sales/${direct.id}/seller-payments`, { amount: 100 });
  assert.equal(r.status, 404);
  assert.match(r.data.error, /الوساطة أو البائع غير موجود/);
  assert.equal((await post("/sales/999999/seller-payments", { amount: 100 })).status, 404);
});

test("seller-payments: تعديل السداد يعيد حساب المستحق ويرفض التجاوز", async () => {
  const id = S.sellerPayment.id;
  const ok = await put(`/seller-payments/${id}`, { amount: 40000, payment_method: "BANK", notes: "معدّل" });
  assert.equal(ok.status, 200);
  assert.equal(db.prepare("SELECT seller_paid_amount FROM sales WHERE id=?").get(S.intermediarySale.id).seller_paid_amount, 40000);
  const over = await put(`/seller-payments/${id}`, { amount: 500000 });
  assert.equal(over.status, 400);
  assert.equal((await put("/seller-payments/999999", { amount: 1 })).status, 404);
});

test("sellers: ملف البائع يلخص المستحقات بعد السداد الجزئي", async () => {
  const r = await get(`/sellers/${S.seller.id}/profile`);
  assert.equal(r.status, 200);
  assert.equal(r.data.summary.paid, 40000);
  // للبائع عمليتا وساطة: 88000 (دُفع منها 40000) و55000 → المستحق 48000 + 55000
  assert.equal(r.data.summary.due, 103000);
  assert.equal(r.data.summary.totalSales, 88000 + 55000);
  assert.equal(r.data.payments.length, 1);
  assert.equal(r.data.sales.length >= 2, true);
});

test("seller-payments: حذف السداد يعيد المستحق بالكامل", async () => {
  const r = await del(`/seller-payments/${S.sellerPayment.id}`);
  assert.equal(r.status, 200);
  assert.equal(db.prepare("SELECT seller_paid_amount FROM sales WHERE id=?").get(S.intermediarySale.id).seller_paid_amount, 0);
  assert.equal((await del("/seller-payments/999999")).status, 404);
});

/* ================================================================== */
/* 8) التحصيلات والأقساط                                                */
/* ================================================================== */

test("installments: الحالة تُحسب (قادم/مستحق اليوم/متأخر) مع أيام التأخير", async () => {
  const rows = (await get("/installments")).data;
  assert.ok(rows.length > 0);
  const statuses = new Set(rows.map((r) => r.status));
  for (const s of statuses) {
    assert.ok(["UPCOMING", "DUE", "OVERDUE", "PARTIALLY_PAID", "PAID"].includes(s), `حالة غير معروفة: ${s}`);
  }
  // أقساط 2026-12-01 في الماضي بالنسبة لتاريخ اليوم (2026-09-27)؟ لا → UPCOMING
  const upcomingRow = rows.find((r) => r.due_date === "2026-11-01");
  assert.equal(upcomingRow.status, "UPCOMING");
  assert.equal(upcomingRow.overdue_days, 0);
  assert.ok(rows.every((r) => typeof r.bill_status === "string"));
});

test("installments: قسط في الماضي يُصنَّف متأخرًا مع أيام تأخير موجبة", async () => {
  const v = (await post("/vehicles", { plate_number: "QA-OVD", make: "فورد", model: "إدج", price: 30000 })).data;
  const c = (await get("/customers")).data[0];
  const past = shiftDays(-20);
  const r = await post("/sales", {
    customer_id: c.id, vehicle_id: v.id, vehicle_mode: "EXISTING", sale_type: "INSTALLMENT",
    sale_price: 30000, down_payment: 0, installment_amount: 15000, first_due_date: past,
  });
  assert.equal(r.status, 200);
  S.overdueSale = r.data;
  const rows = (await get("/installments")).data.filter((x) => x.sale_number === r.data.sale_number);
  assert.equal(rows[0].status, "OVERDUE");
  assert.equal(rows[0].overdue_days, 20);
  assert.equal(rows[0].bill_status, "OVERDUE");
  const dash = (await get("/dashboard")).data;
  assert.ok(dash.overdue_amount >= 15000);
  assert.ok(dash.overdue_count >= 1);
});

test("installments: قسط مستحق اليوم يُصنَّف DUE", async () => {
  const v = (await post("/vehicles", { plate_number: "QA-DUE", make: "كيا", model: "بيكانتو", price: 20000 })).data;
  const c = (await get("/customers")).data[1];
  const r = await post("/sales", {
    customer_id: c.id, vehicle_id: v.id, vehicle_mode: "EXISTING", sale_type: "INSTALLMENT",
    sale_price: 20000, down_payment: 0, installment_amount: 10000, first_due_date: today(),
  });
  assert.equal(r.status, 200);
  const rows = (await get("/installments")).data.filter((x) => x.sale_number === r.data.sale_number);
  assert.equal(rows[0].status, "DUE");
  const dash = (await get("/dashboard")).data;
  assert.ok(dash.dueToday >= 1);
});

test("payments: تحصيل جزئي ثم إكمال القسط مع تحديث الحالة والمتبقي", async () => {
  const list = (await get("/installments")).data.filter((x) => x.sale_number === S.overdueSale.sale_number);
  const inst = list[0];
  const before = db.prepare("SELECT remaining_amount FROM sales WHERE id=?").get(S.overdueSale.id).remaining_amount;

  const p1 = await post(`/installments/${inst.id}/payments`, { amount: 5000, payment_method: "CASH", notes: "جزئي" });
  assert.equal(p1.status, 200);
  assert.match(p1.data.receipt_number, /^REC-\d{6}$/);
  assert.equal(p1.data.receipt_url, `/api/documents/receipt/${p1.data.receipt_number}`);
  S.payment1 = p1.data;
  let row = db.prepare("SELECT * FROM installments WHERE id=?").get(inst.id);
  assert.equal(row.paid_amount, 5000);
  assert.equal(row.status, "PARTIALLY_PAID");
  assert.equal(db.prepare("SELECT status FROM bills WHERE installment_id=?").get(inst.id).status, "PARTIAL");
  assert.equal(db.prepare("SELECT remaining_amount FROM sales WHERE id=?").get(S.overdueSale.id).remaining_amount, before - 5000);

  const p2 = await post(`/installments/${inst.id}/payments`, { amount: 10000, payment_method: "BANK_TRANSFER" });
  assert.equal(p2.status, 200);
  row = db.prepare("SELECT * FROM installments WHERE id=?").get(inst.id);
  assert.equal(row.paid_amount, 15000);
  assert.equal(row.status, "PAID");
  assert.equal(db.prepare("SELECT status FROM bills WHERE installment_id=?").get(inst.id).status, "PAID");
  S.payment2 = p2.data;
});

test("payments: تجاوز المتبقي من القسط مرفوض", async () => {
  const inst = (await get("/installments")).data.filter((x) => x.sale_number === S.overdueSale.sale_number)[1];
  const r = await post(`/installments/${inst.id}/payments`, { amount: inst.amount + 1 });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /تتجاوز المتبقي/);
  // القسط الأول المدفوع بالكامل لا يقبل المزيد
  const paid = (await get("/installments")).data.filter((x) => x.sale_number === S.overdueSale.sale_number)[0];
  const r2 = await post(`/installments/${paid.id}/payments`, { amount: 1 });
  assert.equal(r2.status, 400);
});

test("payments: تحقق من المبلغ والتاريخ ووجود القسط", async () => {
  const inst = (await get("/installments")).data.filter((x) => x.sale_number === S.overdueSale.sale_number)[1];
  assert.equal((await post(`/installments/${inst.id}/payments`, { amount: 0 })).status, 400);
  assert.equal((await post(`/installments/${inst.id}/payments`, { amount: -50 })).status, 400);
  assert.equal((await post(`/installments/${inst.id}/payments`, { amount: "abc" })).status, 400);
  assert.equal((await post(`/installments/${inst.id}/payments`, {})).status, 400);
  const badDate = await post(`/installments/${inst.id}/payments`, { amount: 100, payment_date: "2026-02-30" });
  assert.equal(badDate.status, 400);
  assert.match(badDate.data.error, /غير صحيح/);
  assert.equal((await post("/installments/999999/payments", { amount: 100 })).status, 404);
});

test("payments: بدون تاريخ يستخدم تاريخ اليوم", async () => {
  const inst = (await get("/installments")).data.filter((x) => x.sale_number === S.overdueSale.sale_number)[1];
  const r = await post(`/installments/${inst.id}/payments`, { amount: 100 });
  assert.equal(r.status, 200);
  const row = db.prepare("SELECT payment_date FROM payments WHERE receipt_number=?").get(r.data.receipt_number);
  assert.equal(row.payment_date, today());
  S.payment3 = r.data;
});

test("payments: القائمة تعرض بيانات العميل والعقد", async () => {
  const r = await get("/payments");
  assert.equal(r.status, 200);
  assert.ok(r.data.length >= 3);
  const first = r.data[0];
  assert.ok(first.customer_name);
  assert.ok(first.contract_number);
  assert.ok(first.receipt_number);
  assert.ok(typeof first.installment_number === "number");
});

test("payments: تعديل التحصيل يعيد توزيع المدفوع ويرفض التجاوز", async () => {
  const row = db.prepare("SELECT id,amount FROM payments WHERE receipt_number=?").get(S.payment3.receipt_number);
  const inst = db.prepare("SELECT * FROM installments WHERE id=?").get(row ? db.prepare("SELECT installment_id FROM payments WHERE id=?").get(row.id).installment_id : 1);
  const r = await put(`/payments/${row.id}`, { amount: 500 });
  assert.equal(r.status, 200);
  assert.equal(db.prepare("SELECT amount FROM payments WHERE id=?").get(row.id).amount, 500);
  assert.equal(db.prepare("SELECT paid_amount FROM installments WHERE id=?").get(inst.id).paid_amount, 500);

  const over = await put(`/payments/${row.id}`, { amount: 999999 });
  assert.equal(over.status, 400);
  assert.match(over.data.error, /تتجاوز/);
  assert.equal((await put(`/payments/${row.id}`, { amount: 0 })).status, 400);
  assert.equal((await put("/payments/999999", { amount: 10 })).status, 404);
});

test("payments: إلغاء التحصيل يعيد المتبقي للقسط والبيع", async () => {
  const row = db.prepare("SELECT id,amount,installment_id FROM payments WHERE receipt_number=?").get(S.payment3.receipt_number);
  const paidBefore = db.prepare("SELECT paid_amount FROM installments WHERE id=?").get(row.installment_id).paid_amount;
  const r = await del(`/payments/${row.id}`);
  assert.equal(r.status, 200);
  assert.equal(db.prepare("SELECT paid_amount FROM installments WHERE id=?").get(row.installment_id).paid_amount, paidBefore - row.amount);
  assert.equal(db.prepare("SELECT status FROM installments WHERE id=?").get(row.installment_id).status, "UPCOMING");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM payments WHERE id=?").get(row.id).c, 0);
  assert.equal((await del("/payments/999999")).status, 404);
});

test("payments: تحصيل على قسط تابع لبيع ملغى يجب أن يُرفض", async () => {
  const v = (await post("/vehicles", { plate_number: "QA-CANPAY", make: "فورد", model: "فييستا", price: 25000 })).data;
  const c = (await get("/customers")).data[0];
  const sale = (await post("/sales", {
    customer_id: c.id, vehicle_id: v.id, vehicle_mode: "EXISTING", sale_type: "INSTALLMENT",
    sale_price: 25000, down_payment: 0, installment_amount: 5000, first_due_date: shiftDays(5),
  })).data;
  const inst = db.prepare("SELECT i.id FROM installments i JOIN contracts c ON c.id=i.contract_id WHERE c.sale_id=?").get(sale.id);
  assert.equal((await put(`/sales/${sale.id}/cancel`, {})).status, 200);
  const r = await post(`/installments/${inst.id}/payments`, { amount: 1000 });
  assert.equal([400, 409].includes(r.status), true, `المتوقع رفض التحصيل على بيع ملغى، وصلت ${r.status}`);
});

/* ================================================================== */
/* 9) إلغاء البيع                                                       */
/* ================================================================== */

test("sales: إلغاء بيع يعيد السيارة للمخزون ويحفظ السجل", async () => {
  const v = (await post("/vehicles", { plate_number: "QA-CANCEL", make: "تويوتا", model: "كورولا", price: 45000 })).data;
  const c = (await get("/customers")).data[0];
  const sale = (await post("/sales", { customer_id: c.id, vehicle_id: v.id, vehicle_mode: "EXISTING", sale_type: "CASH", sale_price: 45000, down_payment: 45000 })).data;
  const r = await put(`/sales/${sale.id}/cancel`, {});
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.equal(db.prepare("SELECT status FROM sales WHERE id=?").get(sale.id).status, "CANCELLED");
  assert.equal(db.prepare("SELECT status FROM vehicles WHERE id=?").get(v.id).status, "IN_STOCK");
  // الإلغاء الثاني لا يفشل
  assert.equal((await put(`/sales/${sale.id}/cancel`, {})).status, 200);
  assert.equal((await put("/sales/999999/cancel", {})).status, 404);
  S.cancelledSale = sale;
});

test("sales: إلغاء بيع عليه تحصيلات مرفوض", async () => {
  const r = await put(`/sales/${S.overdueSale.id}/cancel`, {});
  assert.equal(r.status, 400);
  assert.match(r.data.error, /تحصيلات مسجلة/);
});

test("sales: إلغاء بيع تم السداد للبائع فيه مرفوض", async () => {
  await post(`/sales/${S.intermediarySale.id}/seller-payments`, { amount: 1000 });
  const r = await put(`/sales/${S.intermediarySale.id}/cancel`, {});
  assert.equal(r.status, 400);
  assert.match(r.data.error, /السداد للبائع/);
  await del(`/seller-payments/${db.prepare("SELECT id FROM seller_payments WHERE sale_id=?").get(S.intermediarySale.id).id}`);
});

test("sales: المبيعات الملغاة تُستبعد من القوائم والتقارير", async () => {
  const sales = (await get("/sales")).data;
  const cancelled = sales.find((s) => s.id === S.cancelledSale.id);
  assert.equal(cancelled.status, "CANCELLED");
  const installments = (await get("/installments")).data;
  assert.ok(installments.every((i) => i.sale_number !== S.cancelledSale.sale_number));
  const summary = (await get(`/reports/summary?from=2000-01-01&to=2099-12-31`)).data;
  assert.ok(summary.sales.every((s) => s.status === "ACTIVE"));
});

test("vehicles: بيع ثم إلغاء ثم بيع مجددًا يجب ألا يكرر صف السيارة في القائمة", async () => {
  const v = (await post("/vehicles", { plate_number: "QA-DUPROW", make: "هوندا", model: "سيفيك", price: 30000 })).data;
  const c = (await get("/customers")).data[0];
  const s1 = (await post("/sales", { customer_id: c.id, vehicle_id: v.id, vehicle_mode: "EXISTING", sale_type: "CASH", sale_price: 30000, down_payment: 30000 })).data;
  await put(`/sales/${s1.id}/cancel`, {});
  await post("/sales", { customer_id: c.id, vehicle_id: v.id, vehicle_mode: "EXISTING", sale_type: "CASH", sale_price: 31000, down_payment: 31000 });
  const rows = (await get("/vehicles")).data.filter((x) => x.id === v.id);
  assert.equal(rows.length, 1, `السيارة ظهرت ${rows.length} مرات في القائمة`);
});

/* ================================================================== */
/* 10) المصروفات                                                        */
/* ================================================================== */

test("expenses: إنشاء وتعديل وحذف مصروف", async () => {
  const created = await post("/expenses", { category: "تشغيلية", amount: 1500, expense_date: today(), description: "إيجار المعرض" });
  assert.equal(created.status, 200);
  S.expense = created.data;
  assert.equal(created.data.category, "تشغيلية");
  assert.equal(created.data.amount, 1500);

  const updated = await put(`/expenses/${created.data.id}`, { category: "صيانة", amount: 2000, expense_date: today(), description: "صيانة سيارة" });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.category, "صيانة");
  assert.equal(updated.data.amount, 2000);

  const list = await get("/expenses");
  assert.equal(list.status, 200);
  assert.ok(list.data.some((x) => x.id === created.data.id));

  assert.equal((await put("/expenses/999999", { category: "x", amount: 1, expense_date: today() })).status, 404);
  assert.equal((await del(`/expenses/${created.data.id}`)).status, 200);
  assert.equal((await del(`/expenses/${created.data.id}`)).status, 404);
});

test("expenses: تحقق من اكتمال البيانات", async () => {
  assert.equal((await post("/expenses", { amount: 100, expense_date: today() })).status, 400);
  assert.equal((await post("/expenses", { category: "x", expense_date: today() })).status, 400);
  assert.equal((await post("/expenses", { category: "x", amount: 0, expense_date: today() })).status, 400);
  assert.equal((await post("/expenses", { category: "x", amount: -5, expense_date: today() })).status, 400);
  assert.equal((await post("/expenses", { category: "x", amount: 5 })).status, 400);
  assert.equal((await put("/expenses/1", { category: "", amount: 5, expense_date: today() })).status, 400);
});

test("expenses: تاريخ غير صالح يجب أن يُرفض", async () => {
  const r = await post("/expenses", { category: "اختبار", amount: 10, expense_date: "not-a-date" });
  assert.equal(r.status, 400);
});

test("expenses: ربط مصروف بسيارة غير موجودة يجب ألا يعيد 500", async () => {
  const r = await post("/expenses", { vehicle_id: 999999, category: "اختبار", amount: 10, expense_date: today() });
  assert.equal(r.status, 400);
});

/* ================================================================== */
/* 11) التقارير ولوحة التحكم والبحث                                     */
/* ================================================================== */

test("reports: الملخص يجمع المبيعات والتحصيلات والمصروفات والمتأخرات بدقة", async () => {
  const r = await get("/reports/summary?from=2000-01-01&to=2099-12-31");
  assert.equal(r.status, 200);
  const d = r.data;
  assert.equal(d.summary.sales_count, d.sales.length);
  assert.equal(d.summary.sales_total, sum(d.sales, "sale_price"));
  assert.equal(d.summary.collections_total, sum(d.payments, "amount"));
  assert.equal(d.summary.expenses_total, sum(d.expenses, "amount"));
  assert.equal(d.summary.overdue_count, d.overdue.length);
  assert.ok(d.summary.overdue_total >= 0);
  assert.ok(Array.isArray(d.sellerDue));
  // التحقق مقابل قاعدة البيانات مباشرة
  const dbSales = db.prepare("SELECT COALESCE(SUM(sale_price),0) t, COUNT(*) c FROM sales WHERE status='ACTIVE'").get();
  assert.equal(d.summary.sales_count, dbSales.c);
  assert.equal(Math.round(d.summary.sales_total), Math.round(dbSales.t));
});

test("reports: تضييق الفترة الزمنية يستبعد السجلات خارجها", async () => {
  const wide = (await get("/reports/summary?from=2000-01-01&to=2099-12-31")).data;
  const narrow = (await get("/reports/summary?from=2030-01-01&to=2030-12-31")).data;
  assert.equal(narrow.summary.sales_count, 0);
  assert.ok(wide.summary.sales_count > 0);
  assert.equal(narrow.from, "2030-01-01");
  assert.equal(narrow.to, "2030-12-31");
});

test("reports: تواريخ غير صالحة يجب أن تُرفض", async () => {
  const r = await get("/reports/summary?from=abc&to=xyz");
  assert.equal(r.status, 400);
});

test("dashboard: الأرقام تتطابق مع البيانات الفعلية بعد العمليات", async () => {
  const d = (await get("/dashboard")).data;
  const vehicles = db.prepare("SELECT status,price FROM vehicles").all();
  assert.equal(d.available, vehicles.filter((v) => v.status === "IN_STOCK").length);
  assert.equal(d.reserved, vehicles.filter((v) => v.status === "RESERVED").length);
  assert.equal(d.sold, vehicles.filter((v) => v.status === "SOLD").length);
  assert.equal(d.inventory_value, vehicles.filter((v) => v.status !== "SOLD").reduce((a, v) => a + v.price, 0));
  assert.equal(d.customers, db.prepare("SELECT COUNT(*) c FROM customers").get().c);

  const outstanding = db.prepare(`SELECT COALESCE(SUM(i.amount-i.paid_amount),0) t FROM installments i JOIN contracts c ON c.id=i.contract_id JOIN sales s ON s.id=c.sale_id WHERE s.status='ACTIVE' AND i.paid_amount<i.amount`).get().t;
  assert.equal(Math.round(d.outstanding), Math.round(outstanding));

  const collectionsToday = db.prepare(`SELECT COALESCE(SUM(p.amount),0) t FROM payments p JOIN installments i ON i.id=p.installment_id JOIN contracts c ON c.id=i.contract_id JOIN sales s ON s.id=c.sale_id WHERE s.status='ACTIVE' AND p.payment_date=?`).get(today()).t;
  assert.equal(Math.round(d.collections_today), Math.round(collectionsToday));
});

test("dashboard: لا يجب وجود تحصيلات مخفية على مبيعات ملغاة", async () => {
  const orphan = db.prepare(`SELECT COALESCE(SUM(p.amount),0) t FROM payments p JOIN installments i ON i.id=p.installment_id JOIN contracts c ON c.id=i.contract_id JOIN sales s ON s.id=c.sale_id WHERE s.status<>'ACTIVE'`).get().t;
  assert.equal(orphan, 0, "لا يجب وجود تحصيلات معلّقة على مبيعات ملغاة");

  const d = (await get("/dashboard")).data;
  assert.ok(d.upcoming.length <= 12);
  assert.ok(d.upcoming.every((u) => u.customer_name && u.sale_number));
});

test("search: البحث الموحد يجد العميل والبائع والسيارة ورقم البيع", async () => {
  const customer = (await get("/customers")).data[0];
  const byName = await get(`/search?q=${encodeURIComponent(customer.name.slice(0, 4))}`);
  assert.equal(byName.status, 200);
  assert.ok(byName.data.some((x) => x.type === "customer"));

  const byPlate = await get("/search?q=QA-INT1");
  assert.ok(byPlate.data.some((x) => x.type === "vehicle"));

  const bySale = await get(`/search?q=${encodeURIComponent(S.cashSale.sale_number)}`);
  assert.ok(bySale.data.some((x) => x.type === "sale"));

  const bySeller = await get(`/search?q=${encodeURIComponent(S.seller.name.slice(0, 5))}`);
  assert.ok(bySeller.data.some((x) => x.type === "seller"));

  assert.deepEqual((await get("/search?q=")).data, []);
  assert.deepEqual((await get("/search")).data, []);
  assert.ok((await get("/search?q=zzzz-nothing")).data.length === 0);
  assert.ok(byName.data.length <= 20);
});

test("search: رموز LIKE لا تكسر الاستعلام ولا تسرّب كل البيانات بشكل خاطئ", async () => {
  for (const q of ["%", "_", "' OR 1=1 --", "'; DROP TABLE customers;--", "\\", "%%"]) {
    const r = await get(`/search?q=${encodeURIComponent(q)}`);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data));
  }
  // الجدول ما زال سليمًا
  assert.ok((await get("/customers")).data.length > 0);
});

/* ================================================================== */
/* 12) المستندات المطبوعة                                               */
/* ================================================================== */

test("documents: عقد البيع يحتوي بيانات الأطراف ويعمل للمتصفح", async () => {
  const r = await get(`/documents/contract/${S.simplePlan.id}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/html/);
  const detail = (await get(`/sales/${S.simplePlan.id}`)).data.sale;
  assert.match(r.text, /<html/);
  assert.ok(r.text.includes(JSON.stringify(detail.customer_name)), "اسم المشتري يجب أن يُحقن في العقد");
  assert.match(r.text, /const data=\{/);
  assert.match(r.text, /updateHijriField/);
  assert.equal((await get("/documents/contract/999999")).status, 404);
});

test("documents: عقد الوساطة يجب أن يتضمن بيان الوساطة واسم البائع", async () => {
  const r = await get(`/documents/contract/${S.intermediarySale.id}`);
  assert.equal(r.status, 200);
  const seller = db.prepare("SELECT name FROM sellers WHERE id=?").get(S.seller.id).name;
  assert.ok(r.text.includes(`id="brokerNote"`), "يجب أن يحتوي القالب على موضع بيان الوساطة");
  assert.ok(r.text.includes(seller), "اسم البائع يجب أن يظهر في العقد");
});

test("documents: كل كمبيالة في صفحة A4 أفقية مستقلة مع اتجاه طباعة قابل للتغيير", async () => {
  const r = await get(`/documents/bills/${S.simplePlan.id}`);
  assert.equal(r.status, 200);
  const pages = (r.text.match(/class="a5-page"/g) || []).length;
  assert.equal(pages, 12, "12 كمبيالة = 12 صفحات مستقلة");
  const boxes = (r.text.match(/class="kombiala-box"/g) || []).length;
  assert.equal(boxes, 12);
  assert.match(r.text, /كمبيالة رقم/);
  assert.match(r.text, /\.a5-page,.a5-page\.landscape\{width:297mm;height:210mm/);
  assert.match(r.text, /@page\{size:auto;margin:0\}/);
  assert.match(r.text, /معرض الزبيدي لبيع وشراء السيارات/);
  assert.equal((await get("/documents/bills/999999")).status, 404);
});

test("documents: الكمبيالة الواحدة في ورقة A4 أفقية مستقلة", async () => {
  const v = (await post("/vehicles", { plate_number: "QA-ONEBILL", make: "نيسان", model: "ميكرا", price: 10000 })).data;
  const c = (await get("/customers")).data[0];
  const sale = (await post("/sales", { customer_id: c.id, vehicle_id: v.id, vehicle_mode: "EXISTING", sale_type: "INSTALLMENT", sale_price: 10000, down_payment: 0, installment_amount: 10000, first_due_date: shiftDays(30) })).data;
  const r = await get(`/documents/bills/${sale.id}`);
  assert.equal((r.text.match(/class="kombiala-box"/g) || []).length, 1);
  assert.equal((r.text.match(/class="a5-page"/g) || []).length, 1);
});

test("documents: سند أمر المشتري وسند الكفيل", async () => {
  const note = await get(`/documents/note/${S.simplePlan.id}`);
  assert.equal(note.status, 200);
  assert.match(note.text, /const D=\{/);
  assert.match(note.text, /window\.print/);

  const gnote = await get(`/documents/guarantor-note/${S.guarantorSale.id}`);
  assert.equal(gnote.status, 200);
  assert.match(gnote.text, /كفالة المشتري/);

  assert.equal((await get(`/documents/guarantor-note/${S.noGuarantorSale.id}`)).status, 404);
  assert.equal((await get("/documents/note/999999")).status, 404);
});

test("documents: كشف الأقساط يعرض الإجماليات الصحيحة", async () => {
  const r = await get(`/documents/schedule/${S.simplePlan.id}`);
  assert.equal(r.status, 200);
  assert.match(r.text, /كشف الأقساط/);
  assert.match(r.text, /doc-table/);
  const detail = (await get(`/sales/${S.simplePlan.id}`)).data;
  const rows = (r.text.match(/<tr>/g) || []).length;
  assert.ok(rows >= detail.installments.length, "يجب أن يحتوي الجدول على صف لكل قسط");
  assert.equal((await get("/documents/schedule/999999")).status, 404);
  assert.equal((await get(`/documents/schedule/${S.cashSale.id}`)).status, 200);
});

test("documents: إيصال التحصيل يتضمن المبلغ بالأرقام والحروف", async () => {
  const r = await get(`/documents/receipt/${S.payment1.receipt_number}`);
  assert.equal(r.status, 200);
  assert.match(r.text, /إيصال تحصيل/);
  assert.match(r.text, /receipt-card/);
  assert.match(r.text, /ريال/);
  assert.equal((await get("/documents/receipt/REC-999999")).status, 404);
});

test("documents: إيصال سداد البائع", async () => {
  await post(`/sales/${S.intermediarySale.id}/seller-payments`, { amount: 5000 });
  const receipt = db.prepare("SELECT receipt_number FROM seller_payments WHERE sale_id=? ORDER BY id DESC").get(S.intermediarySale.id).receipt_number;
  const r = await get(`/documents/seller-payment/${receipt}`);
  assert.equal(r.status, 200);
  assert.match(r.text, /إيصال سداد مستحقات البائع/);
  assert.ok(r.text.includes(S.seller.name));
  assert.equal((await get("/documents/seller-payment/SPAY-999999")).status, 404);
});

test("documents: كشف حساب المشتري يجمع كل عقود العميل", async () => {
  const customerId = db.prepare("SELECT customer_id FROM sales WHERE id=?").get(S.simplePlan.id).customer_id;
  const r = await get(`/documents/customer-statement/${customerId}`);
  assert.equal(r.status, 200);
  assert.match(r.text, /كشف حساب المشتري/);
  assert.match(r.text, /ملخص العقود/);
  assert.match(r.text, /سجل التحصيلات/);
  const contracts = db.prepare("SELECT COUNT(DISTINCT c.id) c FROM contracts c JOIN sales s ON s.id=c.sale_id WHERE s.customer_id=? AND s.status='ACTIVE'").get(customerId).c;
  assert.ok(contracts >= 1);
  assert.equal((await get("/documents/customer-statement/999999")).status, 404);
});

test("documents: التقرير الشامل يستخدم نفس نظام تصميم الطباعة", async () => {
  const r = await get("/documents/report?from=2000-01-01&to=2099-12-31");
  assert.equal(r.status, 200);
  assert.match(r.text, /class="doc-header"/);
  assert.match(r.text, /class="doc-table"/);
});

test("documents: المستندات المولّدة على الخادم تهرّب مدخلات المستخدم", async () => {
  const evil = `<img src=x onerror="alert(1)">`;
  const v = (await post("/vehicles", { plate_number: evil, make: evil, model: evil, price: 10000 })).data;
  const c = (await post("/customers", { name: evil, national_id: `55${Date.now() % 100000}`, address: evil })).data;
  const sale = (await post("/sales", {
    customer_id: c.id, vehicle_id: v.id, vehicle_mode: "EXISTING", sale_type: "INSTALLMENT",
    sale_price: 10000, down_payment: 0, installment_amount: 5000, first_due_date: shiftDays(10),
  })).data;
  const instId = db.prepare("SELECT i.id FROM installments i JOIN contracts ct ON ct.id=i.contract_id WHERE ct.sale_id=?").get(sale.id).id;
  await post(`/installments/${instId}/payments`, { amount: 100 });
  const receipt = db.prepare("SELECT receipt_number FROM payments ORDER BY id DESC").get().receipt_number;

  const endpoints = [
    `/documents/bills/${sale.id}`,
    `/documents/schedule/${sale.id}`,
    `/documents/customer-statement/${c.id}`,
    `/documents/report?from=2000-01-01&to=2099-12-31`,
    `/documents/receipt/${receipt}`,
  ];
  for (const url of endpoints) {
    const r = await get(url);
    assert.equal(r.status, 200, url);
    assert.equal(r.text.includes('<img src=x onerror="alert(1)">'), false, `تسريب XSS في ${url}`);
    assert.match(r.text, /&lt;img src=x onerror=/, `يجب تهريب القيمة في ${url}`);
  }
});

test("security: مستند العقد والسند يمنعان حقن </script>", async () => {
  const evilName = `</script><img src=x onerror="alert(document.domain)">`;
  const v = (await post("/vehicles", { plate_number: "QA-XSS2", make: "فورد", model: "فيوجن", price: 20000 })).data;
  const c = (await post("/customers", { name: evilName, national_id: `56${Date.now() % 100000}` })).data;
  const cash = (await post("/sales", { customer_id: c.id, vehicle_id: v.id, vehicle_mode: "EXISTING", sale_type: "CASH", sale_price: 20000, down_payment: 20000 })).data;

  const v2 = (await post("/vehicles", { plate_number: "QA-XSS3", make: "فورد", model: "إدج", price: 20000 })).data;
  const inst = (await post("/sales", { customer_id: c.id, vehicle_id: v2.id, vehicle_mode: "EXISTING", sale_type: "INSTALLMENT", sale_price: 20000, down_payment: 0, installment_amount: 10000, first_due_date: shiftDays(30) })).data;

  for (const url of [`/documents/contract/${cash.id}`, `/documents/note/${inst.id}`]) {
    const r = await get(url);
    assert.equal(r.status, 200, url);
    assert.equal(r.text.includes(`</script><img src=x onerror=`), false, `كسر حاجز السكربت في ${url}`);
  }
});

/* ================================================================== */
/* 13) سجل الحركات                                                      */
/* ================================================================== */

test("audit: يسجّل البيع والتحصيل والسداد والمصروفات بترتيب عكسي", async () => {
  const r = await get("/audit-log");
  assert.equal(r.status, 200);
  assert.ok(r.data.length > 0);
  const types = new Set(r.data.map((x) => x.entity_type));
  for (const t of ["SALE", "PAYMENT", "SELLER_PAYMENT", "EXPENSE"]) assert.ok(types.has(t), `سجل ${t} مفقود`);
  const actions = new Set(r.data.map((x) => x.action));
  assert.ok(actions.has("CREATE"));
  assert.ok(actions.has("CANCEL"));
  const ids = r.data.map((x) => x.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => b - a), "يجب أن يكون الترتيب تنازليًا");
});

test("audit: حد النتائج محصور بين 1 و500", async () => {
  assert.equal((await get("/audit-log?limit=1")).data.length, 1);
  assert.equal((await get("/audit-log?limit=99999")).data.length <= 500, true);
  assert.equal((await get("/audit-log?limit=0")).data.length, 1);
  assert.equal((await get("/audit-log?limit=-5")).status, 200);
});

test("audit: limit غير رقمي يجب ألا يعيد 500", async () => {
  const r = await get("/audit-log?limit=abc");
  assert.equal(r.status, 200);
});

test("audit: الواجهة تعرض أنواعًا لا يسجلها الخادم أبدًا", async () => {
  const before = (await get("/audit-log?limit=500")).data.length;
  await post("/vehicles", { plate_number: "QA-AUDIT", make: "فورد", model: "إسكيب" });
  await post("/customers", { name: "عميل التدقيق", national_id: `44${Date.now() % 100000}` });
  const after = (await get("/audit-log?limit=500")).data;
  const types = new Set(after.map((x) => x.entity_type));
  assert.ok(types.has("VEHICLE"), "إنشاء سيارة يجب أن يُسجَّل");
  assert.ok(types.has("CUSTOMER"), "إنشاء مشتري يجب أن يُسجَّل");
  assert.ok(after.length > before);
});

/* ================================================================== */
/* 14) متانة الخادم                                                     */
/* ================================================================== */

test("robustness: جسم JSON تالف يعيد 400 برسالة JSON", async () => {
  const res = await fetch(`${API}/customers`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"name": "غير مكتمل"' });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(typeof data.error, "string");
});

test("robustness: جسم {} لا يسقط الخادم", async () => {
  assert.equal((await post("/customers", {})).status, 400);
  assert.equal((await post("/vehicles", {})).status, 400);
  assert.equal((await post("/sales", {})).status, 400);
  assert.equal((await post("/expenses", {})).status, 400);
  assert.equal((await put("/sales/999999/cancel", {})).status, 404);
  assert.equal((await get("/health")).status, 200, "الخادم يجب أن يبقى حيًا");
});

test("robustness: POST بدون جسم أو بنوع محتوى خاطئ يجب أن يعيد 400", async () => {
  for (const url of ["/customers", "/sellers", "/guarantors", "/vehicles", "/sales", "/expenses"]) {
    const noBody = await fetch(`${API}${url}`, { method: "POST" });
    assert.equal(noBody.status, 400, `${url} بدون جسم أعاد ${noBody.status}`);
    await noBody.text();
    const wrongType = await fetch(`${API}${url}`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "نص" });
    assert.equal(wrongType.status, 400, `${url} بنوع محتوى خاطئ أعاد ${wrongType.status}`);
    await wrongType.text();
  }
});

test("robustness: حمولة أكبر من الحد (10MB) تُرفض", async () => {
  const huge = { plate_number: "QA-HUGE", make: "فورد", model: "x", images: ["y".repeat(11 * 1024 * 1024)] };
  const r = await post("/vehicles", huge);
  assert.ok([400, 413].includes(r.status), `المتوقع 413/400 وصلت ${r.status}`);
  assert.equal((await get("/health")).status, 200);
});

test("robustness: معاملات متوازية لا تنتج أرقام بيع مكررة", async () => {
  const customers = (await get("/customers")).data;
  const results = await Promise.all([1, 2, 3, 4, 5].map(async (n) => {
    const v = (await post("/vehicles", { plate_number: `QA-CONC-${n}`, make: "فورد", model: "كونكورس", price: 10000 })).data;
    return post("/sales", {
      customer_id: customers[n % customers.length].id, vehicle_id: v.id, vehicle_mode: "EXISTING",
      sale_type: "CASH", sale_price: 10000, down_payment: 10000,
    });
  }));
  assert.ok(results.every((r) => r.status === 200), results.map((r) => `${r.status}:${r.text.slice(0, 80)}`).join(" | "));
  const numbers = results.map((r) => r.data.sale_number);
  assert.equal(new Set(numbers).size, 5, "أرقام البيع يجب أن تكون فريدة");
  const contracts = results.map((r) => r.data.contract_number);
  assert.equal(new Set(contracts).size, 5);
  const all = db.prepare("SELECT sale_number FROM sales").all().map((x) => x.sale_number);
  assert.equal(new Set(all).size, all.length, "لا تكرار في أرقام البيع في القاعدة");
});

test("robustness: حقن SQL في الحقول النصية غير مؤثر", async () => {
  const payload = "'); DELETE FROM customers; --";
  const r = await post("/customers", { name: payload, national_id: `11${Date.now() % 100000}` });
  assert.equal(r.status, 200);
  assert.equal(r.data.name, payload);
  assert.ok((await get("/customers")).data.length > 1);
  const search = await get(`/search?q=${encodeURIComponent("' OR '1'='1")}`);
  assert.equal(search.status, 200);
});

test("robustness: المسارات ذات المعرّفات الشاذة لا تعيد 500", async () => {
  const urls = [
    "/sales/abc", "/vehicles/-1", "/customers/1.5", "/installments/%20/payments",
    "/documents/contract/abc", "/documents/schedule/", "/documents/receipt/", "/expenses/abc",
  ];
  for (const u of urls) {
    const r = await get(u);
    assert.ok(r.status < 500, `${u} أعاد ${r.status}`);
  }
});

/* ================================================================== */
/* 15) النسخ الاحتياطي والاسترجاع (آخرًا لأنها عمليات مدمّرة)         */
/* ================================================================== */

test("backup: التنزيل يجب أن يعيد قاعدة البيانات النشطة فعليًا", async () => {
  const marker = `QA-BACKUP-MARKER-${Date.now()}`;
  await post("/customers", { name: marker, national_id: `33${Date.now() % 100000}` });
  const res = await fetch(`${API}/backup`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition") || "", /attachment; filename="showroom-backup-.*\.sqlite"/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(0, 15).toString("latin1"), "SQLite format 3", "الملف ليس قاعدة SQLite");
  const activeSize = fs.statSync(path.join(dataDir, dbName)).size;
  assert.ok(buf.length >= Math.floor(activeSize / 2), `النسخة ${buf.length} بايت بينما القاعدة النشطة ${activeSize} بايت`);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM customers WHERE name=?").get(marker).c, 1);
});

test("restore: استرجاع لقطة سليمة يعيد البيانات ويعيد مزامنة الحالات", async () => {
  // استرجاع النسخة التي ينزّلها المستخدم فعليًا، بما فيها إعدادات وسجل واتساب.
  const { settings, reminders } = context.messaging;
  settings.setMany({ "showroom.name": "اسم محفوظ في النسخة" });
  const savedLogId = reminders.logMessage({
    provider: "LINK", kind: "DUE_REMINDER", role: "CUSTOMER", entityType: "INSTALLMENT",
    status: "LINK_READY", body: "رسالة محفوظة في النسخة",
  });
  const exported = await fetch(`${API}/backup`);
  assert.equal(exported.status, 200);
  const buf = Buffer.from(await exported.arrayBuffer());
  settings.setMany({ "showroom.name": "اسم بعد النسخة" });
  const extraLogId = reminders.logMessage({
    provider: "LINK", kind: "DUE_REMINDER", role: "CUSTOMER", entityType: "INSTALLMENT",
    status: "LINK_READY", body: "رسالة بعد النسخة",
  });

  const marker = `QA-AFTER-SNAPSHOT-${Date.now()}`;
  const created = await post("/customers", { name: marker, national_id: `34${Date.now() % 100000}` });
  assert.equal(created.status, 200);
  const before = (await get("/customers")).data.length;

  const r = await post("/restore", buf);
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.match(r.data.message, /بنجاح/);

  const after = (await get("/customers")).data;
  assert.equal(after.length, before - 1, "العميل المُضاف بعد اللقطة يجب أن يختفي");
  assert.ok(!after.some((c) => c.name === marker));
  assert.equal(settings.get("showroom.name"), "اسم محفوظ في النسخة");
  assert.equal(db.prepare("SELECT body FROM message_log WHERE id=?").get(savedLogId).body, "رسالة محفوظة في النسخة");
  assert.equal(db.prepare("SELECT 1 FROM message_log WHERE id=?").get(extraLogId), undefined);

  // المزامنة بعد الاسترجاع
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM installments WHERE paid_amount>amount`).get().c, 0);
  const badRemaining = db.prepare(`SELECT COUNT(*) c FROM sales s WHERE s.sale_type='INSTALLMENT' AND s.status='ACTIVE'
    AND ABS(s.remaining_amount - COALESCE((SELECT SUM(i.amount-i.paid_amount) FROM installments i JOIN contracts c ON c.id=i.contract_id WHERE c.sale_id=s.id),0)) > 0.02`).get().c;
  assert.equal(badRemaining, 0, "المتبقي يجب أن يتطابق مع الأقساط بعد الاسترجاع");
  assert.equal((await get("/health")).status, 200);
  assert.equal((await get("/dashboard")).status, 200);
});

test("restore: نسخة قبل إضافة واتساب تُسترجع وتعود إعدادات الرسائل إلى الافتراضي", async () => {
  const snapshot = path.join(dataDir, `qa-legacy-${process.pid}-${Date.now()}.sqlite`);
  let legacy;
  let buf;
  try {
    await db.backup(snapshot);
    legacy = new Database(snapshot);
    legacy.pragma("journal_mode = DELETE");
    legacy.exec(`DROP TABLE settings; DROP TABLE message_log;
      DELETE FROM schema_migrations WHERE version='015_messaging_settings_and_log';`);
    legacy.close();
    legacy = null;
    buf = fs.readFileSync(snapshot);
  } finally {
    if (legacy) legacy.close();
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(snapshot + suffix, { force: true });
  }
  const before = db.prepare("SELECT COUNT(*) n FROM customers").get().n;
  const r = await post("/restore", buf);
  assert.equal(r.status, 200, r.text);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM customers").get().n, before);
  assert.equal(context.messaging.settings.get("showroom.name"), context.messaging.settings.DEFAULTS["showroom.name"]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM message_log").get().n, 0);
  assert.equal((await get("/messaging/settings")).status, 200);
});

test("restore: ملف تالف مرفوض والبيانات تبقى سليمة (تراجع كامل)", async () => {
  const before = (await get("/customers")).data.length;
  const garbage = Buffer.from("هذا ليس ملف قاعدة بيانات".repeat(50), "utf8");
  const r = await post("/restore", garbage);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /تعذر استرجاع|غير صالح/);
  assert.equal((await get("/customers")).data.length, before, "يجب أن تتراجع المعاملة بالكامل");
  assert.equal((await get("/health")).status, 200);
});

test("restore: ملف صغير جدًا مرفوض", async () => {
  const r = await post("/restore", Buffer.from("صغير"));
  assert.equal(r.status, 400);
  assert.match(r.data.error, /غير صالح/);
});

test("restore: ملفات قاعدة البيانات المؤقتة وملفات WAL/SHM تُحذف بعد النجاح والفشل", async () => {
  const filesBefore = restoreTempFiles();
  const snapshot = path.join(dataDir, `qa-restore-cleanup-${process.pid}-${Date.now()}.sqlite`);
  let buf;
  try {
    await db.backup(snapshot);
    buf = fs.readFileSync(snapshot);
  } finally {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      fs.rmSync(`${snapshot}${suffix}`, { force: true });
    }
  }

  // Reproduce repeated restore operations; no customer-data copies or SQLite
  // sidecars should remain in the data directory afterward.
  for (let i = 0; i < 10; i++) {
    const result = await post("/restore", buf);
    assert.equal(result.status, 200, `محاولة الاسترجاع ${i + 1} فشلت`);
  }

  // A sufficiently large invalid database exercises cleanup after open failure.
  const invalid = await post("/restore", Buffer.alloc(256, 0x41));
  assert.equal(invalid.status, 400);
  assert.deepEqual(restoreTempFiles(), filesBefore);
});

test("restore: العملية يجب أن تُسجَّل في سجل الحركات", async () => {
  const snapshot = path.join(dataDir, `qa-snapshot2-${process.pid}.sqlite`);
  await db.backup(snapshot);
  const buf = fs.readFileSync(snapshot);
  fs.rmSync(snapshot, { force: true });
  await post("/restore", buf);
  const log = (await get("/audit-log?limit=100")).data;
  assert.ok(log.some((x) => x.action === "RESTORE"), "يجب تسجيل RESTORE");
});
