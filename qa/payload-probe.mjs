// قياس أثر تخزين الصور Base64 داخل قاعدة البيانات على حجم استجابة قائمة السيارات
process.env.SHOWROOM_DB = `qa-perf-${process.pid}.sqlite`;
process.env.SHOWROOM_AUTO_BACKUP = "0";
const path = await import("node:path"); const fs = await import("node:fs");
const { createApp } = await import("../server/src/app.js");
const { app, context } = createApp();
const srv = app.listen(0, "127.0.0.1"); await new Promise(r => srv.once("listening", r));
const API = `http://127.0.0.1:${srv.address().port}/api`;
const j = (m, u, b) => fetch(`${API}${u}`, { method: m, headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }).then(r => r.json());
const raw = (u) => fetch(`${API}${u}`).then(async r => ({ size: (await r.text()).length, t: r.headers }));

const KB = (n) => (n / 1024).toFixed(1) + " KB";
const MB = (n) => (n / 1048576).toFixed(2) + " MB";

// صورة وهمية بحجم واقعي (~1.2MB قبل الترميز)
const oneImage = "data:image/jpeg;base64," + "A".repeat(Math.round(1_200_000 * 4 / 3));
console.log("حجم صورة واحدة بعد الترميز:", KB(oneImage.length));

let t0 = Date.now();
for (let i = 1; i <= 5; i++) {
  await j("POST", "/vehicles", { plate_number: `PERF-${i}`, make: "تويوتا", model: "كامري", price: 90000, images: [oneImage, oneImage, oneImage, oneImage, oneImage] });
}
console.log("زمن إضافة 5 سيارات × 5 صور:", (Date.now() - t0) + "ms");

const before = await raw("/vehicles");
console.log("حجم GET /api/vehicles بعد 5 سيارات مصوّرة:", MB(before.size));

for (let i = 6; i <= 20; i++) {
  await j("POST", "/vehicles", { plate_number: `PERF-${i}`, make: "هوندا", model: "أكورد", price: 70000, images: [oneImage, oneImage, oneImage, oneImage, oneImage] });
}
const after = await raw("/vehicles");
console.log("حجم GET /api/vehicles بعد 20 سيارة مصوّرة:", MB(after.size));

t0 = Date.now();
for (let n = 0; n < 5; n++) await raw("/vehicles");
console.log("متوسط زمن استجابة /api/vehicles (20 سيارة):", ((Date.now() - t0) / 5) + "ms");

const dbSize = fs.statSync(path.default.join(process.cwd(), "server", "data", process.env.SHOWROOM_DB)).size;
console.log("حجم ملف قاعدة البيانات:", MB(dbSize));

// نقاط نهاية أخرى بدون صور
for (const u of ["/dashboard", "/sales", "/installments", "/payments", "/reports/summary?from=2000-01-01&to=2099-12-31", "/audit-log?limit=500"]) {
  const r = await raw(u);
  console.log("  ", u.padEnd(52), KB(r.size));
}

srv.close(); context.db.close();
for (const s of ["", "-wal", "-shm"]) { try { fs.default.rmSync(path.default.join(process.cwd(), "server", "data", process.env.SHOWROOM_DB + s), { force: true }); } catch (_) {} }
process.exit(0);
