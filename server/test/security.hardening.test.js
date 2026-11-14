import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { calculateInstallmentPlan } from "../src/modules/finance/installment.calculator.js";
import { safeJson } from "../src/utils/format.js";
import { asMoney } from "../src/shared/validation.js";
import { formatDateArabic } from "../src/utils/documents.js";

const dataDir = fileURLToPath(new URL("../data/", import.meta.url));
const dbName = `qa-hardening-${process.pid}-${Date.now()}.sqlite`;
process.env.NODE_ENV = "test";
process.env.SHOWROOM_DB = dbName;
process.env.SHOWROOM_AUTO_BACKUP = "0";
process.env.SHOWROOM_SEED_DEMO = "1";
for (const key of ["SHOWROOM_AUTH_USER", "SHOWROOM_AUTH_PASS", "SHOWROOM_API_TOKEN", "SHOWROOM_TRUST_PROXY", "SHOWROOM_CORS_ORIGIN"]) delete process.env[key];
const { createApp } = await import("../src/app.js");
const { app, context } = createApp();
const db = context.db;
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let serial = 0;
async function request(route, body, headers = {}, method = body === undefined ? "GET" : "POST") {
  return fetch(base + "/api" + route, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": Buffer.isBuffer(body) ? "application/octet-stream" : "application/json" }), ...headers },
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
}
async function sale() {
  const response = await request("/sales", {
    customer_id: 1, vehicle_mode: "MANUAL", manual_vehicle: { plate_number: `HARDEN-${++serial}`, make: "تويوتا", model: "كامري", vin: "VIN-HANDOVER-TEST" },
    sale_type: "INSTALLMENT", sale_price: 30000, down_payment: 10000, installment_amount: 2000, first_due_date: "2026-10-01",
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  return { ...data, ...db.prepare("SELECT * FROM sales WHERE id=?").get(data.id), installment: db.prepare("SELECT i.id FROM installments i JOIN contracts c ON c.id=i.contract_id WHERE c.sale_id=? ORDER BY i.installment_number LIMIT 1").get(data.id).id };
}

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(path.join(dataDir, dbName + suffix), { force: true });
});

test("csrf: نموذج أو طلب من نطاق غريب لا ينشئ عميلًا ولا ينفذ تذكيرات", async () => {
  const before = db.prepare("SELECT COUNT(*) n FROM customers").get().n;
  for (const origin of ["https://evil.example", "null"]) {
    assert.equal((await request("/customers", { name: "csrf" }, { Origin: origin })).status, 403);
    assert.equal((await request("/messaging/reminders/run", {}, { Origin: origin })).status, 403);
  }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM customers").get().n, before);
  assert.equal((await request("/customers", { name: "same-origin" }, { Origin: base })).status, 200);
});

test("validation: كائنات وأسماء فارغة وتواريخ هوية غير صالحة لا ترمي 500", async () => {
  for (const body of [{ name: {} }, { name: "   " }, { name: "name", national_id_date: "not-a-date" }, { name: "name", phone: [] }]) {
    for (const route of ["/customers", "/sellers", "/guarantors"]) assert.equal((await request(route, body)).status, 400, route);
  }
});

test("images: صور SVG/روابط السكربت وخمس صور إضافية مرفوضة", async () => {
  for (const images of [["javascript:alert(1)"], ["data:image/svg+xml;base64,PHN2Zz4="], Array(6).fill("data:image/png;base64,AAA")]) {
    assert.equal((await request("/vehicles", { plate_number: "IMG", make: "make", model: "model", images })).status, 400);
  }
});

test("finance: دقة السنتات وحد عدد الأقساط يمنعان الزيادة وتعليق الخادم", () => {
  assert.equal(asMoney(1.005), 1.01);
  for (const value of [true, [], {}, null]) assert.throws(() => asMoney(value));
  assert.throws(() => calculateInstallmentPlan({ total: 1_000_000, monthlyAmount: 0.01 }), /عدد الأقساط/);
  const plan = calculateInstallmentPlan({ total: 500, monthlyAmount: 1000, combineSmallRemainder: true });
  assert.deepEqual(plan.amounts, [500]);
});

test("inventory: لا يمكن إعادة سيارة عليها بيع نشط للمخزون أو بيعها ثانية", async () => {
  const s = await sale();
  assert.equal((await request(`/vehicles/${s.vehicle_id}/status`, { status: "IN_STOCK" }, {}, "PUT")).status, 409);
  const result = await request("/sales", { customer_id: 1, vehicle_id: s.vehicle_id, sale_type: "CASH", sale_price: 30000 });
  assert.equal(result.status, 400);
});

test("payments: الزيادة بسنت واحد مرفوضة دون استهلاك رقم إيصال", async () => {
  const s = await sale();
  const sequence = db.prepare("SELECT value FROM sequences WHERE name='receipt'").get().value;
  assert.equal((await request(`/installments/${s.installment}/payments`, { amount: 2000.01 })).status, 400);
  assert.equal(db.prepare("SELECT value FROM sequences WHERE name='receipt'").get().value, sequence);
});

test("ledger: تحصيل قديم على بيع ملغى لا يختفي من السجل والتقارير ويمكن عكسه", async () => {
  const s = await sale();
  const paid = await request(`/installments/${s.installment}/payments`, { amount: 500 });
  assert.equal(paid.status, 200);
  const receipt = (await paid.json()).receipt_number;
  db.prepare("UPDATE sales SET status='CANCELLED' WHERE id=?").run(s.id); // legacy snapshot/state, not an allowed API cancellation
  const all = await (await request("/payments")).json();
  assert.ok(all.some((p) => p.receipt_number === receipt));
  const dashboard = await (await request("/dashboard")).json();
  const total = db.prepare("SELECT COALESCE(SUM(amount),0) n FROM payments WHERE payment_date=?").get(context.localDateString()).n;
  assert.equal(dashboard.collections_today, total);
  assert.equal((await request(`/installments/${s.installment}/payments`, { amount: 10 })).status, 409);
  const payment = all.find((p) => p.receipt_number === receipt);
  assert.equal((await request(`/payments/${payment.id}`, { amount: 600 }, {}, "PUT")).status, 409);
  assert.equal((await request(`/payments/${payment.id}`, undefined, {}, "DELETE")).status, 200);
});

test("restore: SQLite من تطبيق آخر لا يمحو البيانات", async () => {
  const other = new Database(":memory:");
  other.exec("CREATE TABLE unrelated(id INTEGER)");
  const buffer = other.serialize();
  other.close();
  const before = db.prepare("SELECT COUNT(*) n FROM customers").get().n;
  assert.equal((await request("/restore", buffer)).status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM customers").get().n, before);
  assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
});

test("restore: نسخة بها علاقات يتيمة تتراجع بالكامل ولا تترك ملفات مؤقتة", async () => {
  const snapshot = path.join(dataDir, `qa-orphan-${process.pid}.sqlite`);
  let clone;
  let buffer;
  try {
    await db.backup(snapshot);
    clone = new Database(snapshot);
    clone.pragma("foreign_keys = OFF");
    clone.prepare("DELETE FROM customers WHERE id=1").run();
    buffer = clone.serialize();
  } finally {
    clone?.close();
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(snapshot + suffix, { force: true });
  }
  const before = db.prepare("SELECT COUNT(*) n FROM customers").get().n;
  assert.equal((await request("/restore", buffer)).status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM customers").get().n, before);
  assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
  assert.ok(!fs.readdirSync(dataDir).some((name) => name.startsWith(`restore-${process.pid}-`)));
});

test("documents: JSON/script boundaries والتواريخ القديمة لا تعيد HTML غير مهرب", () => {
  const value = "</script><img src=x onerror=alert(1)>\u2028";
  assert.ok(!safeJson({ value }).includes("<"));
  assert.deepEqual(JSON.parse(safeJson({ value })), { value });
  assert.ok(!formatDateArabic(value).includes("<img"));
});

test("receipt: نموذج المشتري يدعم البيع النشط ويتضمن السيارة والتوقيعات دون تسليم آلي", async () => {
  const s = await sale();
  const before = db.prepare("SELECT COUNT(*) n FROM payments").get().n;
  const response = await request(`/documents/vehicle-receipt/${s.id}`);
  assert.equal(response.status, 200);
  const html = await response.text();
  for (const value of ["نسخة المشتري", "إيصال استلام السيارة", "VIN-HANDOVER-TEST", s.sale_number, "توقيع المشتري", "ختم المعرض", "لا يعتبر إيصال سداد"]) assert.ok(html.includes(value), value);
  assert.match(html, /id="handover-date"[^>]*type="date"[^>]*>/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM payments").get().n, before);
  const csp = response.headers.get("content-security-policy");
  assert.ok(csp.includes("script-src 'nonce-"));
  assert.ok(!csp.includes("script-src 'unsafe-inline'"));
  const nonce = csp.match(/nonce-([^']+)/)[1];
  assert.ok([...html.matchAll(/<script\b([^>]*)>/g)].every((m) => m[1].includes(`nonce="${nonce}"`)));
  await request(`/sales/${s.id}/cancel`, {}, {}, "PUT");
  assert.equal((await request(`/documents/vehicle-receipt/${s.id}`)).status, 409);
  assert.equal((await request("/documents/vehicle-receipt/999999")).status, 404);
});

test("receipt: أسماء العملاء والحقول الخبيثة تبقى نصوصًا لا HTML", async () => {
  const s = await sale();
  const original = db.prepare("SELECT name FROM customers WHERE id=1").get().name;
  try {
    db.prepare("UPDATE customers SET name=? WHERE id=1").run('<img src=x onerror="window.hacked=true">');
    const response = await request(`/documents/vehicle-receipt/${s.id}`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.ok(!html.includes('<img src=x'));
    assert.ok(html.includes('&lt;img'));
  } finally { db.prepare("UPDATE customers SET name=? WHERE id=1").run(original); }
});


test("cloud: طلب ميتا المعلق يلغى بالمهلة بدل ترك الإرسال مفتوحًا", async () => {
  const { dispatchMessage } = await import("../src/modules/messaging/providers.js");
  const keepAlive = setTimeout(() => {}, 200);
  try {
    const result = await dispatchMessage({
      provider: "CLOUD", phone: "0551234567", text: "mock only", timeoutMs: 5,
      cloud: { phoneId: "test-id", token: "test-token" },
      fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      }),
    });
    assert.equal(result.status, "FAILED");
    assert.match(result.error, /تعذّر الاتصال/);
  } finally { clearTimeout(keepAlive); }
});

test("settings: مفاتيح prototype والقيم الكائنية لا تدخل جدول الإعدادات", async () => {
  for (const value of [JSON.parse('{"__proto__":"bad"}'), { constructor: "bad" }, { "whatsapp.cloud.token": {} }, { "whatsapp.defaultCountryCode": "9x66" }]) {
    assert.equal((await request("/messaging/settings", value, {}, "PUT")).status, 400);
  }
});


test("phone: الأرقام العربية والدولية الصريحة لا ترسل إلى كود دولة خاطئ", async () => {
  const { normalizePhone } = await import("../src/modules/messaging/phone.js");
  assert.equal(normalizePhone("٠٥٥١٢٣٤٥٦٧", "966"), "966551234567");
  assert.equal(normalizePhone("006592345678", "966"), "6592345678");
  assert.equal(normalizePhone("+6592345678", "966"), "6592345678");
  assert.equal(normalizePhone("abc0551234567", "966"), null);
  assert.equal(normalizePhone("0551234567", "9x66"), null);
});


test("sale: حقول السيارة اليدوية أو معرفات الأطراف الكائنية تعيد 400 لا 500", async () => {
  const body = { customer_id: 1, vehicle_mode: "MANUAL", manual_vehicle: { plate_number: "BAD-FIELDS", make: "make", model: "model", vin: {} }, sale_type: "CASH", sale_price: 1000 };
  assert.equal((await request("/sales", body)).status, 400);
  const s = await sale();
  const invalid = { customer_id: 1, vehicle_id: s.vehicle_id, sale_type: "INSTALLMENT", sale_price: 30000, installment_amount: 2000, first_due_date: "2026-10-01", guarantor_id: true };
  assert.equal((await request("/sales", invalid)).status, 400);
});
