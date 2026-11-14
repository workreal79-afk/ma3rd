import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* ------------------------------------------------------------------ */
/* بيئة اختبار معزولة مع تفعيل المصادقة (يجب ضبط المتغيرات قبل استيراد app) */
/* ------------------------------------------------------------------ */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");
const dbName = `qa-auth-${process.pid}-${Date.now()}.sqlite`;
process.env.SHOWROOM_DB = dbName;
process.env.SHOWROOM_AUTO_BACKUP = "0";
process.env.SHOWROOM_API_TOKEN = "qa-secret-token";
process.env.SHOWROOM_CORS_ORIGIN = "https://example.com";
process.env.NODE_ENV = "production";
// محاكاة وكيل موثوق واحد؛ التشغيل المباشر لا يثق بـ X-Forwarded-For افتراضيًا.
process.env.SHOWROOM_TRUST_PROXY = "1";

const { createApp } = await import("../src/app.js");
const { authEnabled } = await import("../src/config/env.js");
const { basicAuthOk, authLimits, clearFailures } = await import("../src/middlewares/auth.js");
const { app, context } = createApp();
const { db } = context;

const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const API = `http://127.0.0.1:${server.address().port}/api`;

test.after(() => {
  try { server.close(); } catch (_) {}
  try { db.close(); } catch (_) {}
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.rmSync(path.join(dataDir, dbName + suffix), { force: true }); } catch (_) {}
  }
});

async function call(url, opts = {}) {
  const res = await fetch(`${API}${url}`, { method: opts.method || "GET", headers: opts.headers || {}, body: opts.body });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch (_) {}
  return { status: res.status, headers: res.headers, data, text };
}

/* ================================================================== */
/* DEFECT-SEC1: المصادقة على نقاط النهاية الحساسة                       */
/* ================================================================== */

test("auth: المصادقة مفعّلة عند ضبط SHOWROOM_API_TOKEN", () => {
  assert.equal(authEnabled, true);
});

test("auth: /api/health مستثنى حتى يعمل فحص الصحة في Render وDocker", async () => {
  const r = await call("/health");
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
});

test("auth: البيانات المالية مرفوضة بدون رمز وصول", async () => {
  for (const url of ["/dashboard", "/customers", "/vehicles", "/sales", "/installments", "/payments", "/expenses", "/audit-log", "/reports/summary", "/messaging/settings", "/messaging/log", "/messaging/reminders"]) {
    const r = await call(url);
    assert.equal(r.status, 401, `${url} يجب أن يُرفض بدون رمز`);
    assert.equal(typeof r.data.error, "string", `${url} يجب أن يعيد رسالة JSON`);
  }
});

test("auth: أخطر نقطتين (تنزيل القاعدة واسترجاعها) محميتان", async () => {
  const backup = await call("/backup");
  assert.equal(backup.status, 401, "تنزيل قاعدة البيانات يجب أن يتطلب رمزًا");

  const restore = await call("/restore", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: Buffer.from("x".repeat(200)),
  });
  assert.equal(restore.status, 401, "استرجاع نسخة (يمحو القاعدة) يجب أن يتطلب رمزًا");

  // ويجب ألا تتغيّر البيانات فعلًا
  const before = db.prepare("SELECT COUNT(*) c FROM customers").get().c;
  const restore2 = await call("/restore", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-API-Token": "qa-secret-token" },
    body: Buffer.from("not-a-real-sqlite-file-but-long-enough-to-pass-the-size-guard-xxxxxxxxxxxxxxxxxxxx"),
  });
  assert.equal(restore2.status, 400, "ملف غير صالح يجب أن يُرفض برسالة واضحة لا 500");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM customers").get().c, before, "الرفض يجب ألا يمسّ البيانات");
});

test("auth: الرمز الصحيح في الرأس X-API-Token يمرّر الطلب", async () => {
  const r = await call("/dashboard", { headers: { "X-API-Token": "qa-secret-token" } });
  assert.equal(r.status, 200);
  assert.equal(typeof r.data.vehicles, "number");
});

test("auth: الرمز في URL مرفوض لمنع تسريبه في history أو الروابط", async () => {
  assert.equal((await call("/dashboard?token=qa-secret-token")).status, 401);
});

test("auth: Bearer الصحيح يمرر الطلب دون تضمين الرمز في الرابط", async () => {
  assert.equal((await call("/dashboard", { headers: { Authorization: "Bearer qa-secret-token" } })).status, 200);
});

test("auth: رمز خاطئ مرفوض ولا يسرّب بيانات", async () => {
  const r = await call("/customers", { headers: { "X-API-Token": "wrong" } });
  assert.equal(r.status, 401);
  assert.ok(!Array.isArray(r.data), "يجب ألا تعود أي بيانات مع الرفض");
});

test("auth: الكتابة محمية أيضًا (POST/PUT/DELETE)", async () => {
  const post = await call("/customers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "محاولة غير مصرّح بها" }) });
  assert.equal(post.status, 401);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM customers WHERE name=?").get("محاولة غير مصرّح بها").c, 0);

  const put = await call("/vehicles/1/status", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "SOLD" }) });
  assert.equal(put.status, 401);

  const del = await call("/expenses/1", { method: "DELETE" });
  assert.equal(del.status, 401);
});

test("auth: وضع Basic Auth — نافذة دخول ورفض وتقبّل", async () => {
  // الدالة الصرفة خلف Basic Auth (تُستخدم عندما يُضبط SHOWROOM_AUTH_USER/PASS بدل الرمز)
  const credentials = Buffer.from("manager:s3cret").toString("base64");
  assert.equal(basicAuthOk(`Basic ${credentials}`, "manager", "s3cret"), true);
  assert.equal(basicAuthOk(`Basic ${Buffer.from("manager:bad").toString("base64")}`, "manager", "s3cret"), false);
  assert.equal(basicAuthOk(`Basic ${Buffer.from("other:s3cret").toString("base64")}`, "manager", "s3cret"), false);
  assert.equal(basicAuthOk("", "manager", "s3cret"), false);
  assert.equal(basicAuthOk("Bearer abc", "manager", "s3cret"), false);
  // كلمة مرور تحتوي ":" تُقرأ بشكل صحيح (التقسيم عند أول ":" فقط)
  const withColon = Buffer.from("manager:pa:ss").toString("base64");
  assert.equal(basicAuthOk(`Basic ${withColon}`, "manager", "pa:ss"), true);
});

test("auth: حدّ محاولات الدخول الفاشلة يمنع التخمين بالقوة الغاشمة", async () => {
  const attacker = { "X-Forwarded-For": "203.0.113.9" };
  let blocked = 0;
  for (let i = 0; i < authLimits.MAX_FAILED + 2; i += 1) {
    const r = await call("/customers", { headers: attacker });
    if (r.status === 429) blocked += 1;
  }
  assert.ok(blocked >= 2, `المتوقع 429 بعد ${authLimits.MAX_FAILED} محاولة فاشلة — عدد مرات المنع: ${blocked}`);
  const stillBlocked = await call("/customers", { headers: attacker });
  assert.equal(stillBlocked.status, 429);
  assert.match(stillBlocked.data.error, /تجاوز عدد محاولات الدخول/);

  // المنع لكل عنوان على حدة — لا يعاقب بقية المستخدمين
  const other = await call("/dashboard", { headers: { "X-Forwarded-For": "203.0.113.10", "X-API-Token": "qa-secret-token" } });
  assert.equal(other.status, 200);

  // والدخول الصحيح بعد رفع المنع يمرّ ويصفّر العدّاد
  clearFailures("203.0.113.9");
  const okAgain = await call("/dashboard", { headers: { "X-Forwarded-For": "203.0.113.9", "X-API-Token": "qa-secret-token" } });
  assert.equal(okAgain.status, 200);
});

/* ================================================================== */
/* CORS ورؤوس الأمان                                                    */
/* ================================================================== */

test("cors: SHOWROOM_CORS_ORIGIN يقيّد النطاق بدل السماح للجميع", async () => {
  const allowed = await call("/health", { headers: { Origin: "https://example.com" } });
  assert.equal(allowed.headers.get("access-control-allow-origin"), "https://example.com");

  const blocked = await call("/health", { headers: { Origin: "https://evil.example" } });
  assert.equal(blocked.headers.get("access-control-allow-origin"), null, "نطاق غير مدرج يجب ألا يحصل على رأس CORS");
});

test("security: رؤوس الحماية موجودة مع تفعيل المصادقة", async () => {
  const r = await call("/health");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  assert.equal(r.headers.get("x-powered-by"), null);
});
