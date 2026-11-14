import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = fileURLToPath(new URL("../data/", import.meta.url));
const dbName = `qa-production-${process.pid}-${Date.now()}.sqlite`;
process.env.NODE_ENV = "production";
process.env.SHOWROOM_DB = dbName;
process.env.SHOWROOM_AUTO_BACKUP = "0";
for (const key of ["SHOWROOM_AUTH_USER", "SHOWROOM_AUTH_PASS", "SHOWROOM_API_TOKEN", "SHOWROOM_SEED_DEMO"]) delete process.env[key];
const { createApp } = await import("../src/app.js");
const { config } = await import("../src/config/env.js");
const { app, context } = createApp();
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  context.db.close();
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(path.join(dataDir, dbName + suffix), { force: true });
});

test("production: بدون إعدادات المصادقة يغلق التطبيق والبيانات بدل نشرها للعامة", async () => {
  for (const route of ["/", "/api/dashboard", "/api/customers", "/api/backup", "/api/messaging/settings"]) {
    const response = await fetch(base + route);
    assert.equal(response.status, 503, route);
    assert.match((await response.json()).error, /غير مهيأ للمصادقة/);
  }
});

test("production: فحص الصحة عام حتى عندما يكون الوصول مغلقًا", async () => {
  const response = await fetch(base + "/api/health");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});

test("production: الكتابة والاسترجاع مغلقان ولا يغيران البيانات", async () => {
  for (const [route, body, type] of [
    ["/api/customers", JSON.stringify({ name: "unauthorized" }), "application/json"],
    ["/api/restore", Buffer.alloc(256), "application/octet-stream"],
  ]) {
    const response = await fetch(base + route, { method: "POST", headers: { "Content-Type": type }, body });
    assert.equal(response.status, 503);
  }
  assert.equal(context.db.prepare("SELECT COUNT(*) n FROM customers").get().n, 0);
});

test("production: قاعدة جديدة لا تحصل على عملاء أو سيارات تجريبية افتراضيًا", () => {
  assert.equal(context.db.prepare("SELECT COUNT(*) n FROM vehicles").get().n, 0);
  assert.equal(context.db.prepare("SELECT COUNT(*) n FROM customers").get().n, 0);
  assert.equal(context.db.prepare("SELECT COUNT(*) n FROM sequences").get().n, 6);
});

test("auth: إعداد نصف بيانات Basic Auth لا يترك التشغيل المحلي مفتوحًا", async () => {
  try {
    config.nodeEnv = "test";
    config.authUser = "incomplete-user";
    assert.equal((await fetch(base + "/api/dashboard")).status, 503);
  } finally {
    config.authUser = "";
    config.nodeEnv = "production";
  }
});


test("development: التشغيل العادي لا يعرض قاعدة حقيقية بدون إعدادات دخول", async () => {
  try {
    config.nodeEnv = "development";
    assert.equal((await fetch(base + "/api/dashboard")).status, 503);
  } finally { config.nodeEnv = "production"; }
});

test("demo: تفعيل المعاينة لا يستخدم مسار قاعدة البيانات الحقيقية", async () => {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", "import {config} from './src/config/env.js'; console.log(JSON.stringify({file:config.databaseFile,demo:config.demoMode}))"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...process.env, NODE_ENV: "development", SHOWROOM_DEMO_MODE: "1", SHOWROOM_DB: "live-financial-data.sqlite" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { file: "showroom-demo.sqlite", demo: true });
});
