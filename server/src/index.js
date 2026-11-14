import { createApp } from "./app.js";
import { createAutoBackup } from "./utils/auto-backup.js";
import { config } from "./config/env.js";
import os from "node:os";
import { needsFirstRunAdmin, createFirstRunAdmin } from "./utils/first-run-admin.js";

const { app, context } = createApp();
context.messagingScheduler.start();
if (context.messaging.settings.getBool("whatsapp.enabled") && String(context.messaging.settings.get("whatsapp.provider")).toUpperCase() === "WEB") {
  void context.messagingWeb.start().catch((error) => console.warn("[واتساب] التشغيل المحلي مؤجل:", error?.message || error));
}
const autoBackup = createAutoBackup({
  db: context.db,
  dataDir: context.dataDir,
  localDateString: context.localDateString
});
context.autoBackup = autoBackup;

// أول تشغيل بلا بيانات دخول ولا حسابات موظفين: أنشئ مديرًا بكلمة مرور عشوائية (لا كلمة افتراضية معروفة).
if (config.nodeEnv !== "test" && needsFirstRunAdmin({ db: context.db, authUser: config.authUser, authPassword: config.authPassword })) {
  const first = createFirstRunAdmin({ db: context.db, dataDir: context.dataDir });
  console.log("============================================================");
  console.log(" أول تشغيل: تم إنشاء حساب المدير");
  console.log(` اسم المستخدم : ${first.username}`);
  console.log(` كلمة المرور  : ${first.password}`);
  console.log(` محفوظة أيضًا في: ${first.file}`);
  console.log(" غيّر كلمة المرور من صفحة المستخدمين ثم احذف الملف.");
  console.log("============================================================");
}

const port = config.port;
const host = process.env.HOST || "0.0.0.0";
const server = app.listen(port, host, () => {
  console.log(`معرض الزبيدي يعمل على http://localhost:${port}`);
  // عناوين الشبكة المحلية لفتح النظام من أجهزة أخرى في المعرض (HTTP داخل الشبكة الداخلية فقط).
  const lan = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i.address);
  for (const address of lan) console.log(`من أجهزة المعرض الأخرى: http://${address}:${port}`);
  console.log("المصادقة مفعّلة على /api (عدا /api/health).");
});

function shutdown(signal) {
  console.log(`${signal}: closing showroom server...`);
  autoBackup.stop();
  context.messagingScheduler.stop();
  void context.messagingWeb.stop();
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
