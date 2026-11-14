import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { createAutoBackup, autoBackupOptions } from "../src/utils/auto-backup.js";

const dataDir = fileURLToPath(new URL(`../data/qa-auto-${process.pid}/`, import.meta.url));
process.env.SHOWROOM_AUTO_BACKUP = "1";
process.env.SHOWROOM_AUTO_BACKUP_RETENTION = "1";
const db = new Database(":memory:");
db.exec("CREATE TABLE sample(id INTEGER PRIMARY KEY,value TEXT)");
db.prepare("INSERT INTO sample(value) VALUES(?)").run("x".repeat(2_000_000));
const backups = createAutoBackup({ db, dataDir, localDateString: () => "2026-09-30" });
test.after(() => { backups.stop(); db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test("auto-backup: النسخ الكبيرة تكتمل وتجمع طلبات النسخ المتزامنة", { timeout: 10000 }, async () => {
  const [file, concurrent] = await Promise.all([backups.backupNow("test"), backups.backupNow("concurrent")]);
  assert.ok(file && fs.existsSync(file));
  assert.equal(concurrent, file);
  const copy = new Database(file, { readonly: true });
  try { assert.equal(copy.prepare("SELECT LENGTH(value) n FROM sample").get().n, 2_000_000); } finally { copy.close(); }
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("auto-backup: الأسماء لا تتصادم والاحتفاظ مضبوط", async () => {
  const file = await backups.afterAction();
  assert.ok(file);
  assert.equal(fs.readdirSync(backups.backupDir).filter((name) => name.endsWith(".sqlite")).length, 1);
  assert.ok(fs.existsSync(file));
  assert.equal(backups.status().lastReason, "action");
  assert.ok(backups.status().lastBackupAt);
});

test("auto-backup: يعمل عند الإجراء وليس وفق مؤقت زمني", () => {
  assert.equal(autoBackupOptions().trigger, "after-action");
  assert.equal("intervalHours" in autoBackupOptions(), false);
});

test("auto-backup: الإيقاف يمنع العمل اللاحق حتى لطلب backupNow", async () => {
  backups.stop();
  assert.equal(await backups.backupNow("after-stop"), null);
});
