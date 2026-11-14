import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = fileURLToPath(new URL("../data/", import.meta.url));
const dbName = `qa-basic-${process.pid}-${Date.now()}.sqlite`;
process.env.SHOWROOM_DB = dbName;
process.env.SHOWROOM_AUTO_BACKUP = "0";
process.env.SHOWROOM_AUTH_USER = "qa-manager";
process.env.SHOWROOM_AUTH_PASS = "qa:password";
process.env.SHOWROOM_AUTH_MAX_FAILED = "3";
process.env.NODE_ENV = "production";
delete process.env.SHOWROOM_API_TOKEN;
delete process.env.SHOWROOM_CORS_ORIGIN;
delete process.env.SHOWROOM_TRUST_PROXY;

const { createApp } = await import("../src/app.js");
const { clearFailures } = await import("../src/middlewares/auth.js");
const { app, context } = createApp();
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const credentials = { Authorization: `Basic ${Buffer.from("qa-manager:qa:password").toString("base64")}` };

test.beforeEach(() => clearFailures("127.0.0.1"));
test.after(async () => {
  context.messagingScheduler.stop();
  await new Promise((resolve) => server.close(resolve));
  context.db.close();
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(path.join(dataDir, dbName + suffix), { force: true });
});

test("basic: صفحة الواجهة والـ API تطلبان تسجيل الدخول لكن فحص الصحة عام", async () => {
  for (const url of ["/", "/health", "/api/dashboard"]) {
    const response = await fetch(`${base}${url}`);
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate"), /^Basic /);
  }
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
});

test("basic: الاعتماد الصحيح يفتح البيانات وكلمة المرور التي تحتوي نقطتين تعمل", async () => {
  const response = await fetch(`${base}/api/dashboard`, { headers: credentials });
  assert.equal(response.status, 200);
  assert.equal(typeof (await response.json()).vehicles, "number");
  const backup = await fetch(`${base}/api/backup`, { headers: credentials });
  assert.equal(backup.status, 200);
  const content = Buffer.from(await backup.arrayBuffer());
  assert.equal(content.subarray(0, 16).toString(), "SQLite format 3\0");
});

test("basic: كلمة مرور خاطئة مرفوضة ولا تعيد بيانات العملاء", async () => {
  const response = await fetch(`${base}/api/customers`, {
    headers: { Authorization: `Basic ${Buffer.from("qa-manager:wrong").toString("base64")}` },
  });
  assert.equal(response.status, 401);
  assert.equal(typeof (await response.json()).error, "string");
});

test("proxy: التشغيل المباشر لا يسمح بتجاوز حد الدخول عبر تزوير X-Forwarded-For", async () => {
  assert.equal(app.get("trust proxy"), false);
  for (let i = 0; i < 3; i += 1) {
    const response = await fetch(`${base}/api/customers`, { headers: { "X-Forwarded-For": `203.0.113.${i + 1}` } });
    assert.equal(response.status, 401);
  }
  const blocked = await fetch(`${base}/api/customers`, { headers: { "X-Forwarded-For": "203.0.113.99" } });
  assert.equal(blocked.status, 429);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
});
