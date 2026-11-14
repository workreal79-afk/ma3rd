import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { initializeSchema } from "../src/db/schema.js";
import { runMigrations } from "../src/db/migrations.js";
import { createSettingsService } from "../src/modules/messaging/settings.service.js";

const migration = "015_messaging_settings_and_log";

test("migration: ترقية قاعدة قبل واتساب تضيف الجداول دون تغيير بيانات العملاء والسيارات", () => {
  const db = new Database(":memory:");
  try {
    initializeSchema(db);
    runMigrations(db);
    // نحاكي مخطط الإصدار السابق مع سجل الهجرات الحقيقي، لا قاعدة فارغة فقط.
    db.exec(`DROP TABLE message_log; DROP TABLE settings;
      DELETE FROM schema_migrations WHERE version='${migration}';`);
    db.prepare("INSERT INTO customers(name,phone) VALUES(?,?)").run("عميل محفوظ", "0551234567");
    db.prepare("INSERT INTO vehicles(plate_number,make,model) VALUES(?,?,?)").run("LEGACY-1", "تويوتا", "كامري");

    runMigrations(db);
    assert.equal(db.prepare("SELECT name FROM customers").get().name, "عميل محفوظ");
    assert.equal(db.prepare("SELECT plate_number FROM vehicles").get().plate_number, "LEGACY-1");
    assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(migration));
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='idx_message_log_dedupe'").get());
    const settings = createSettingsService(db);
    assert.equal(settings.setMany({ "showroom.name": "اسم محفوظ" }).ok, true);
    assert.equal(settings.get("showroom.name"), "اسم محفوظ");
  } finally {
    db.close();
  }
});

test("migration: تكرار التهيئة والهجرات يحتفظ بالإعدادات وسجل الرسائل", () => {
  const db = new Database(":memory:");
  try {
    initializeSchema(db);
    runMigrations(db);
    const settings = createSettingsService(db);
    settings.setMany({ "reminder.beforeDays": "5" });
    db.prepare(`INSERT INTO message_log(provider,kind,recipient_role,entity_type,status)
      VALUES('LINK','DUE_REMINDER','CUSTOMER','INSTALLMENT','LINK_READY')`).run();
    initializeSchema(db);
    runMigrations(db);
    runMigrations(db);
    assert.equal(settings.get("reminder.beforeDays"), "5");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM message_log").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM schema_migrations").get().n, 15);
  } finally {
    db.close();
  }
});
