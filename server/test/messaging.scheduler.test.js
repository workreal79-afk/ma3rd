import test from "node:test";
import assert from "node:assert/strict";
import { createScheduler } from "../src/modules/messaging/scheduler.js";

const silent = { log() {}, error() {} };
const at = (day, minute = 0) => new Date(2026, 8, day, 9, minute);
function settings() {
  const values = { "whatsapp.enabled": true, "reminder.autoRun": true, "reminder.scheduleTime": "09:00", "whatsapp.provider": "LINK" };
  return { values, get: (key) => values[key], getBool: (key) => values[key] === true };
}

test("scheduler: يباعد المحاولات الفاشلة ويتوقف بعد ثلاث محاولات ثم يعيد العد في اليوم التالي", async () => {
  const config = settings();
  let calls = 0;
  const scheduler = createScheduler({
    messaging: { settings: config, reminders: { execute: async () => { calls += 1; throw new Error("simulated database failure"); } } },
    logger: silent,
  });
  await scheduler.tick(at(30));
  assert.equal(calls, 1);
  assert.equal(scheduler.status().failCount, 1);
  assert.equal(scheduler.status().lastRunDate, "");
  await scheduler.tick(at(30, 1));
  assert.equal(calls, 1, "لا نعيد الفشل كل دقيقة");
  await scheduler.tick(at(30, 5));
  await scheduler.tick(at(30, 10));
  assert.equal(calls, 3);
  assert.equal(scheduler.status().lastRunDate, "2026-09-30");
  await scheduler.tick(at(30, 15));
  assert.equal(calls, 3);
  await scheduler.tick(new Date(2026, 9, 1, 9, 0));
  assert.equal(calls, 4);
  assert.equal(scheduler.status().failCount, 1, "عداد اليوم الجديد يبدأ من واحد");
});

test("scheduler: يمنع تنفيذين متوازيين أثناء انتظار الإرسال", async () => {
  let complete;
  let calls = 0;
  const scheduler = createScheduler({
    messaging: {
      settings: settings(),
      reminders: { execute: () => { calls += 1; return new Promise((resolve) => { complete = resolve; }); } },
    },
    logger: silent,
  });
  const first = scheduler.tick(at(30));
  assert.equal(await scheduler.tick(at(30, 1)), null);
  assert.equal(calls, 1);
  complete({ blocked: false, sent: [], results: {} });
  await first;
  assert.equal(scheduler.status().lastRunDate, "2026-09-30");
});

test("scheduler: لا ينفذ عندما تكون الميزة أو الجدولة معطلة", async () => {
  const config = settings();
  let calls = 0;
  const scheduler = createScheduler({
    messaging: { settings: config, reminders: { execute: async () => { calls += 1; } } },
    logger: silent,
  });
  config.values["whatsapp.enabled"] = false;
  assert.equal(await scheduler.tick(at(30)), null);
  config.values["whatsapp.enabled"] = true;
  config.values["reminder.autoRun"] = false;
  assert.equal(await scheduler.tick(at(30)), null);
  assert.equal(calls, 0);
});

test("scheduler: بدء وإيقاف المؤقت آمنان عند التكرار", () => {
  const scheduler = createScheduler({ messaging: { settings: settings(), reminders: {} }, logger: silent });
  try {
    assert.equal(scheduler.status().running, false);
    scheduler.start();
    scheduler.start();
    assert.equal(scheduler.status().running, true);
    scheduler.stop();
    scheduler.stop();
    assert.equal(scheduler.status().running, false);
  } finally {
    scheduler.stop();
  }
});
