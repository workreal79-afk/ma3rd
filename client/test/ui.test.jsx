import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..", "..", "..");
const serverEntry = path.join(repoRoot, "server", "src", "index.js");
const dbName = `qa-ui-${process.pid}-${Date.now()}.sqlite`;
const dataDir = path.join(repoRoot, "server", "data");

/* ================================================================== */
/* 1) خادم حقيقي معزول للاختبار                                         */
/* ================================================================== */
const PORT = 4599 + (process.pid % 300);
const BASE = `http://127.0.0.1:${PORT}`;
const child = spawn(process.execPath, [serverEntry], {
  cwd: path.join(repoRoot, "server"),
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", SHOWROOM_DB: dbName, SHOWROOM_AUTO_BACKUP: "0", NODE_ENV: "test", SHOWROOM_SEED_DEMO: "1", SHOWROOM_AUTH_USER: "", SHOWROOM_AUTH_PASS: "", SHOWROOM_API_TOKEN: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
const serverLog = [];
child.stdout.on("data", (d) => serverLog.push(d.toString()));
child.stderr.on("data", (d) => serverLog.push(d.toString()));

const realFetch = globalThis.fetch;
async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await realFetch(`${BASE}/api/health`)).ok) return; } catch (_) {}
    if (child.exitCode !== null) throw new Error(`الخادم خرج مبكرًا (${child.exitCode}):\n${serverLog.join("")}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`انتهت مهلة بدء الخادم:\n${serverLog.join("")}`);
}
await waitForServer();

test.after(async () => {
  try { child.kill("SIGTERM"); } catch (_) {}
  await new Promise((r) => setTimeout(r, 250));
  try { child.kill("SIGKILL"); } catch (_) {}
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.rmSync(path.join(dataDir, dbName + suffix), { force: true }); } catch (_) {}
  }
});

// واجهة برمجة مباشرة للخادم (لتهيئة البيانات دون المرور بالواجهة)
const backend = {
  get: (u) => realFetch(`${BASE}/api${u}`).then((r) => r.json()),
  send: (m, u, b) => realFetch(`${BASE}/api${u}`, { method: m, headers: { "Content-Type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) })),
};

/* ================================================================== */
/* 2) بيئة DOM                                                         */
/* ================================================================== */
const dom = new JSDOM(`<!doctype html><html lang="ar" dir="rtl"><body><div id="root"></div></body></html>`, {
  url: `${BASE}/`, pretendToBeVisual: true,
});
const { window } = dom;
const defineGlobal = (name, value) => Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
for (const name of ["window", "document", "navigator", "location", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "Element", "Node", "Event", "CustomEvent", "MouseEvent", "FileReader", "FormData"]) {
  defineGlobal(name, name === "window" ? window : name === "document" ? window.document : name === "navigator" ? window.navigator : name === "location" ? window.location : window[name]);
}
defineGlobal("getComputedStyle", window.getComputedStyle.bind(window));
defineGlobal("requestAnimationFrame", (cb) => setTimeout(() => cb(Date.now()), 0));
defineGlobal("cancelAnimationFrame", (id) => clearTimeout(id));
defineGlobal("IS_REACT_ACT_ENVIRONMENT", true);

// مراقبات التفاعلات الجانبية — الكود يستخدم alert/confirm/open مجرّدة (globalThis)
const opened = [];
const alerts = [];
const confirms = [];
let confirmAnswer = false;
const stub = (name, fn) => { window[name] = fn; defineGlobal(name, fn); };
stub("open", (url) => { opened.push(String(url)); return { focus() {}, close() {}, closed: false }; });
stub("alert", (m) => { alerts.push(String(m)); });
stub("confirm", (m) => { confirms.push(String(m)); return confirmAnswer; });

// كل طلبات الواجهة يجب أن تكون نسبية — أي localhost يُعد خلل نشر
const requestedUrls = [];
const fetchSpy = (input, init) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  requestedUrls.push(url);
  assert.equal(/^https?:\/\/(localhost|127\.0\.0\.1)/.test(url), false, `الواجهة تستخدم عنوانًا مطلقًا (${url}) — يكسر النشر`);
  return realFetch(new URL(url, BASE), init);
};
defineGlobal("fetch", fetchSpy);
window.fetch = fetchSpy;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { App } = await import("../src/app/App.jsx");
const { NAV_ITEMS } = await import("../src/app/navigation.js");

let S_saleId = null;
let S_saleNumber = null;

const root = createRoot(document.getElementById("root"));
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const text = () => document.body.textContent;
const moneyAr = (n) => Number(n).toLocaleString("ar-SA", { maximumFractionDigits: 2 });

const tick = async (ms = 40) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
const byText = (sel, t) => $$(sel).find((el) => el.textContent.includes(t));
const buttonByText = (t) => byText("button", t);
const rowsOf = () => $$("section.panel tbody tr");
const hasData = () => rowsOf().length > 0 && !text().includes("لا توجد بيانات");

async function click(el, ms = 60) {
  assert.ok(el, "العنصر المطلوب غير موجود في الصفحة");
  await act(async () => { el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true })); });
  await tick(ms);
}
async function press(el, key) {
  assert.ok(el, "العنصر المطلوب غير موجود للضغط على المفتاح");
  await act(async () => { el.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
  await tick(20);
}

// انتظار حتمي بدل التخمين في التوقيتات (يبدّد تحذيرات overlapping act)
async function waitFor(predicate, message = "شرط", timeout = 6000) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    await tick(35);
    try { const v = await predicate(); if (v) return v; } catch (e) { lastError = e; }
  }
  throw new Error(`انتهت المهلة في انتظار: ${message}${lastError ? ` (${lastError.message})` : ""}`);
}

async function goto(navLabel, waitPredicate, waitMessage) {
  await click(buttonByText(navLabel));
  await waitFor(() => $("header h1")?.textContent.includes(navLabel), `الوصول إلى صفحة ${navLabel}`);
  if (waitPredicate) await waitFor(waitPredicate, waitMessage || `تحميل بيانات ${navLabel}`);
}

async function setValue(el, value) {
  assert.ok(el, "حقل الإدخال غير موجود");
  const proto = el instanceof window.HTMLSelectElement ? window.HTMLSelectElement.prototype
    : el instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, String(value));
  const eventName = el instanceof window.HTMLSelectElement ? "change" : "input";
  await act(async () => { el.dispatchEvent(new window.Event(eventName, { bubbles: true })); });
  await tick(20);
}
const fieldInput = (scope, label) => {
  const fields = Array.from(scope.querySelectorAll("label.field"));
  const field = fields.find((f) => (f.querySelector("span")?.textContent || "").trim().startsWith(label));
  assert.ok(field, `الحقل «${label}» غير موجود`);
  return field.querySelector("input,select");
};
const modal = () => $$(".overlay .modal").at(-1);
const closeModal = async () => { await click(modal().querySelector(".iconBtn")); await tick(60); };

/* ================================================================== */
/* 3) الاختبارات                                                       */
/* ================================================================== */

test("ui: التطبيق يقلع ويعرض الهوية والقائمة الجانبية كاملة", async () => {
  await act(async () => { root.render(React.createElement(App)); });
  await waitFor(() => $$("aside button.nav").length === NAV_ITEMS.length, "اكتمال القائمة الجانبية");

  assert.match(text(), /معرض الزبيدي/);
  for (const label of ["الرئيسية", "السيارات", "المشترون", "البائعون", "الكفلاء", "المبيعات", "الأقساط والتحصيل", "المصروفات", "التقارير", "سجل الحركات", "واتساب والتنبيهات"]) {
    assert.ok(byText("aside button.nav", label), `عنصر القائمة «${label}» مفقود`);
  }
  assert.equal($("aside nav")?.getAttribute("aria-label"), "التنقل الرئيسي");
  assert.equal(byText("aside button.nav", "الرئيسية")?.getAttribute("aria-current"), "page");
  assert.equal($(".globalSearch input")?.getAttribute("aria-label"), "بحث سريع عن عميل أو سيارة أو عملية بيع");
  assert.equal($(".skipLink")?.getAttribute("href"), "#main-content");
  assert.ok(buttonByText("نسخة احتياطية"), "زر النسخة الاحتياطية مفقود");
  assert.ok(buttonByText("استرجاع"), "زر الاسترجاع مفقود");
  assert.match(text(), /المدير/);
});

test("ui: زر القائمة يبدّل ظهور التنقل ويحدّث حالة الوصول", async () => {
  const toggle = $(".sidebarToggle");
  assert.equal(toggle?.getAttribute("aria-expanded"), "true");
  assert.equal(toggle?.getAttribute("aria-controls"), "main-navigation");

  await click(toggle);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal($("aside").getAttribute("aria-hidden"), "true");
  assert.equal($("aside").hasAttribute("inert"), true);

  await click(toggle);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal($("aside").getAttribute("aria-hidden"), "false");
  assert.equal($("aside").hasAttribute("inert"), false);
});

test("ui: لوحة التحكم تعرض 10 بطاقات إحصائية بلوحة الوساطة واليوم", async () => {
  await waitFor(() => text().includes(moneyAr(235000)), `قيمة المخزون ${moneyAr(235000)}`);
  assert.equal($$(".cards .stat").length, 10, "عدد البطاقات");
  assert.equal($$(".cards .stat .statIcon[aria-hidden='true'] svg[aria-hidden='true']").length, 10, "يجب عرض رمز رسومي زخرفي لكل مؤشر دون إضافته لقراءة الشاشة");
  for (const label of ["قيمة المخزون", "السيارات المتاحة", "المحجوزة", "المباعة", "الأقساط المستحقة", "المتأخرات", "تحصيل اليوم", "تحصيل الشهر", "مصروفات الشهر", "مستحقات البائعين"]) {
    assert.ok(text().includes(label), `البطاقة «${label}» مفقودة`);
  }
  assert.ok(text().includes("ملخص الوساطة"));
  assert.ok(text().includes("أقرب الاستحقاقات والمتأخرات"));
  assert.equal($$(".dashboardPanels section.panel").length, 3);
  assert.ok(text().includes("توزيع السيارات"));
});

test("ui: صفحة السيارات تعرض البيانات المبدئية في بطاقات منظمة", async () => {
  await goto("السيارات", () => rowsOf().length === 3, "3 سيارات مبدئية");
  assert.equal($(".sidebarToggle")?.getAttribute("aria-expanded"), "false", "القائمة الجانبية تُغلق تلقائيًا بعد اختيار الصفحة");
  const headers = $$("section.panel thead th").map((th) => th.textContent.trim());
  assert.deepEqual(headers, ["بيانات السجل", "الإجراءات"]);
  assert.match(text(), /تويوتا/);
  assert.match(text(), /كامري/);
  assert.match(text(), /أ ب ج 1234/);
  assert.match(text(), /مستعمل/);
  assert.ok(buttonByText("إضافة سيارة"));
});

test("ui: شارة حالة السيارة يجب أن تعرض متاح/محجوز/مباع", async () => {
  const badge = $("section.panel tbody tr .vehicleCardStatus .badge");
  assert.ok(badge, "لا توجد شارة حالة");
  assert.ok(["متاحة", "محجوزة", "مباعة"].includes(badge.textContent.trim()), `الشارة تعرض «${badge.textContent.trim()}»`);
});

test("ui: البحث في السيارات يصفّي النتائج ثم يستعيدها", async () => {
  const input = $(".searchBar input");
  await setValue(input, "سوناتا");
  await waitFor(() => rowsOf().length === 1, "تصفية النتائج إلى سيارة واحدة");
  assert.match(text(), /سوناتا/);
  await setValue(input, "");
  await waitFor(() => rowsOf().length === 3, "استعادة كل السيارات");
});

test("ui: زر الحجز يغيّر حالة السيارة في الخادم ثم يلغي الحجز", async () => {
  const plate = rowsOf()[0].querySelector(".vehicleCardPlate")?.textContent.replace("اللوحة:", "").trim();
  const rowButton = (label) => Array.from(rowsOf().find((r) => r.textContent.includes(plate)).querySelectorAll("button")).find((b) => b.textContent.trim() === label);

  await click(rowButton("حجز"));
  await waitFor(async () => (await backend.get("/vehicles")).some((v) => v.plate_number === plate && v.status === "RESERVED"), "تحول السيارة إلى محجوزة في الخادم");
  await waitFor(() => rowButton("إلغاء الحجز"), "تحديث الواجهة لتعرض زر إلغاء الحجز");

  await click(rowButton("إلغاء الحجز"));
  await waitFor(async () => (await backend.get("/vehicles")).some((v) => v.plate_number === plate && v.status === "IN_STOCK"), "عودة السيارة إلى متاحة");
  await waitFor(() => rowButton("حجز"), "تحديث الواجهة لتعرض زر حجز");
});

test("ui: نموذج إضافة سيارة يرفض الحقول الناقصة برسالة الخادم العربية", async () => {
  await click(buttonByText("إضافة سيارة"));
  await waitFor(() => modal() && text().includes("إضافة سيارة"), "فتح نافذة إضافة سيارة");
  assert.equal(modal().querySelectorAll(".fieldRequired").length, 3, "يجب تمييز الحقول الأساسية بصريًا");
  assert.equal(modal().querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow"), "0");

  alerts.length = 0;
  await click(buttonByText("حفظ السيارة"));
  await waitFor(() => alerts.length >= 1, "تنبيه المستخدم عند فشل الحفظ");
  assert.match(alerts[0], /اللوحة والماركة والموديل مطلوبة/);
  assert.ok(modal(), "النافذة يجب أن تبقى مفتوحة بعد الفشل");

  await setValue(fieldInput(modal(), "رقم اللوحة"), "QA-UI-1");
  assert.equal(modal().querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow"), "33");
  await setValue(fieldInput(modal(), "الماركة"), "نيسان");
  await setValue(fieldInput(modal(), "الموديل"), "ألتيما");
  assert.equal(modal().querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow"), "100");
  await setValue(fieldInput(modal(), "سعر البيع"), "51000");
  alerts.length = 0;
  await click(buttonByText("حفظ السيارة"));
  await waitFor(() => !$(".overlay"), "إغلاق النافذة بعد الحفظ");
  assert.deepEqual(alerts, [], `لم يكن متوقعًا تنبيه: ${alerts.join("|")}`);
  const list = await backend.get("/vehicles?search=QA-UI-1");
  assert.equal(list.length, 1);
  assert.equal(list[0].price, 51000);
});

test("ui: ملكية الغير تُظهر حقول البائع وتشترط اسمه", async () => {
  await click(buttonByText("إضافة سيارة"));
  await waitFor(() => modal(), "فتح النافذة");
  const ownership = Array.from(modal().querySelectorAll("select")).find((s) => Array.from(s.options).some((o) => o.textContent.includes("تخص بائع")));
  await setValue(ownership, "THIRD_PARTY");
  await waitFor(() => text().includes("بيانات مالك السيارة"), "ظهور قسم البائع");

  await setValue(fieldInput(modal(), "رقم اللوحة"), "QA-UI-TP");
  await setValue(fieldInput(modal(), "الماركة"), "كيا");
  await setValue(fieldInput(modal(), "الموديل"), "ريو");
  alerts.length = 0;
  await click(buttonByText("حفظ السيارة"));
  await waitFor(() => alerts.some((a) => /بيانات البائع/.test(a)), `تنبيه عن بيانات البائع (${alerts.join("|")})`);

  await setValue(fieldInput(modal(), "اسم البائع"), "بائع من الواجهة");
  await setValue(fieldInput(modal(), "رقم الهوية"), `77${Date.now() % 1000000}`);
  await setValue(fieldInput(modal(), "سعر البيع"), "40000");
  alerts.length = 0;
  await click(buttonByText("حفظ السيارة"));
  await waitFor(() => !$(".overlay"), "إغلاق النافذة بعد الحفظ");
  const created = (await backend.get("/vehicles?search=QA-UI-TP"))[0];
  assert.equal(created.ownership_type, "THIRD_PARTY");
  assert.equal(created.owner_seller_name, "بائع من الواجهة");
});

test("ui: تعديل سيارة من النافذة المخصصة", async () => {
  await goto("السيارات", () => hasData(), "بيانات السيارات");
  const row = rowsOf().find((r) => r.textContent.includes("QA-UI-1"));
  await click(Array.from(row.querySelectorAll("button")).find((b) => b.textContent.trim() === "تعديل"));
  await waitFor(() => modal() && text().includes("تعديل بيانات السيارة"), "فتح نافذة التعديل");
  await setValue(fieldInput(modal(), "اللون"), "أزرق");
  await click(buttonByText("حفظ التعديل"));
  await waitFor(() => !$(".overlay"), "إغلاق النافذة");
  const updated = (await backend.get("/vehicles?search=QA-UI-1"))[0];
  assert.equal(updated.color, "أزرق");
});

test("ui: صفحة المشترون تعرض القائمة وتتيح الإضافة", async () => {
  await goto("المشترون", () => rowsOf().length >= 2, "المشترون المبدئيون");
  const before = rowsOf().length;
  assert.ok($(".recordCardsPanel[aria-label='سجل المشترين']"), "قائمة المشترين يجب أن تستخدم تخطيط البطاقات");
  assert.match(text(), /محمد علي الغامدي/);

  await click(buttonByText("إضافة مشتري"));
  await waitFor(() => modal(), "فتح نافذة إضافة مشتري");
  await setValue(fieldInput(modal(), "اسم المشتري"), "مشتري من الواجهة");
  await setValue(fieldInput(modal(), "رقم الهوية"), "777000111");
  await setValue(fieldInput(modal(), "الجوال"), "0555777888");
  await click(buttonByText("حفظ"));
  await waitFor(() => rowsOf().length === before + 1, "إضافة الصف الجديد");
  assert.match(text(), /مشتري من الواجهة/);
});

test("ui: رقم هوية مكرر يعرض رسالة الخادم للمستخدم وتبقى النافذة مفتوحة", async () => {
  await click(buttonByText("إضافة مشتري"));
  await waitFor(() => modal(), "فتح النافذة");
  assert.equal(document.activeElement?.getAttribute("aria-label"), "إغلاق", "يجب نقل التركيز إلى زر إغلاق النافذة");
  await setValue(fieldInput(modal(), "اسم المشتري"), "مكرر");
  await setValue(fieldInput(modal(), "رقم الهوية"), "777000111");
  alerts.length = 0;
  await click(buttonByText("حفظ"));
  await waitFor(() => alerts.length === 1, "ظهور تنبيه التكرار");
  assert.match(alerts[0], /مسجل بالفعل باسم/);
  assert.ok(modal(), "النافذة يجب أن تبقى مفتوحة");
  await press(modal(), "Escape");
  await waitFor(() => !$(".overlay"), "إغلاق النافذة بزر Escape");
});

test("ui: تعديل بيانات مشتري من القائمة", async () => {
  const row = rowsOf().find((r) => r.textContent.includes("مشتري من الواجهة"));
  await click(Array.from(row.querySelectorAll("button")).find((b) => b.textContent.trim() === "تعديل"));
  await waitFor(() => modal() && text().includes("تعديل بيانات المشتري"), "فتح نافذة التعديل");
  await setValue(fieldInput(modal(), "المدينة"), "القنفذة");
  await click(buttonByText("حفظ التعديل"));
  await waitFor(() => !$(".overlay"), "إغلاق النافذة");
  const list = await backend.get("/customers?search=مشتري من الواجهة");
  assert.equal(list[0].city, "القنفذة");
});

test("ui: ملف المشتري يعرض العقود والأقساط ورابط كشف الحساب النسبي", async () => {
  const row = rowsOf().find((r) => r.textContent.includes("مشتري من الواجهة"));
  await click(Array.from(row.querySelectorAll("button")).find((b) => b.textContent.trim() === "الملف"));
  await waitFor(() => text().includes("ملف المشتري"), "فتح ملف المشتري");
  assert.match(text(), /العقود والمبيعات/);
  assert.match(text(), /جدول الأقساط والكمبيالات/);
  assert.match(text(), /التحصيلات/);

  const link = byText("a", "طباعة كشف الحساب");
  assert.ok(link, "رابط طباعة كشف الحساب مفقود");
  assert.match(link.getAttribute("href"), /^\/api\/documents\/customer-statement\/\d+$/, "الرابط يجب أن يكون نسبيًا");
  opened.length = 0;
  await click(link);
  // الرابط <a target="_blank"> وليس window.open — نتحقق من صحة المسار فقط
  assert.deepEqual(opened, [], "لا يجب فتح نافذة إضافية لأن الرابط anchor");
  await closeModal();
});

test("ui: المبيعات — حساب عدد الأقساط والمتبقي تلقائيًا في الواجهة", async () => {
  await goto("المبيعات", () => text().includes("بيع سيارة"), "صفحة المبيعات");
  assert.ok($(".salesPanel"), "قائمة المبيعات يجب أن تستخدم تخطيط البطاقات");
  assert.deepEqual($$(".salesTable thead th").map((th) => th.textContent.trim()), ["تفاصيل المبايعة", "الملخص والإجراءات"]);
  await click(buttonByText("بيع سيارة"));
  await waitFor(() => text().includes("بيع سيارة — إدخال أطراف العملية"), "فتح نافذة البيع");

  const saleType = Array.from(modal().querySelectorAll("select")).find((s) => Array.from(s.options).some((o) => o.value === "INSTALLMENT"));
  await setValue(saleType, "INSTALLMENT");
  await waitFor(() => text().includes("يوجد كفيل"), "ظهور خيار الكفيل مع التقسيط");

  const vehicleSelect = Array.from(modal().querySelectorAll("select")).find((s) => Array.from(s.options).some((o) => o.textContent.includes("QA-UI-1")));
  assert.ok(vehicleSelect, "قائمة السيارات المتاحة مفقودة");
  const option = Array.from(vehicleSelect.options).find((o) => o.textContent.includes("QA-UI-1"));
  await setValue(vehicleSelect, option.value);
  await waitFor(() => fieldInput(modal(), "قيمة السيارة").value === "51000", "تعبئة السعر من السيارة المختارة");

  await setValue(fieldInput(modal(), "المقدم"), "10000");
  await setValue(fieldInput(modal(), "قيمة القسط"), "1500");
  await waitFor(() => text().includes(moneyAr(41000)), `المتبقي ${moneyAr(41000)}`);
  // 41000 / 1500 = 27 قسطًا (40500) + باقي 500
  await waitFor(() => Array.from(modal().querySelectorAll(".box b")).some((b) => b.textContent.trim() === "28"), "عدد الأقساط المحسوب = 28");
  assert.match(text(), /عدد الأقساط المحسوب تلقائيًا/);
  assert.match(text(), /القسط الأخير/, "يجب عرض تنبيه القسط الأخير");
  await closeModal();
});

test("ui: المبيعات — التحقق من اختيار المشتري قبل الاعتماد", async () => {
  await click(buttonByText("بيع سيارة"));
  await waitFor(() => modal(), "فتح نافذة البيع");
  alerts.length = 0;
  await click(buttonByText("اعتماد البيع وحفظ بيانات الأطراف"));
  await waitFor(() => alerts.some((a) => /اختر مشتريًا/.test(a)), `تنبيه عن المشتري (${alerts.join("|")})`);
  await closeModal();
});

test("ui: المبيعات — تنفيذ بيع تقسيط كامل من الواجهة", async () => {
  await click(buttonByText("بيع سيارة"));
  await waitFor(() => modal(), "فتح نافذة البيع");

  const customerSelect = Array.from(modal().querySelectorAll("select")).find((s) => Array.from(s.options).some((o) => o.textContent.includes("مشتري من الواجهة")));
  const custOption = Array.from(customerSelect.options).find((o) => o.textContent.includes("مشتري من الواجهة"));
  await setValue(customerSelect, custOption.value);
  await waitFor(() => text().includes("تم اختيار"), "تأكيد اختيار المشتري");

  const saleType = Array.from(modal().querySelectorAll("select")).find((s) => Array.from(s.options).some((o) => o.value === "INSTALLMENT"));
  await setValue(saleType, "INSTALLMENT");
  await waitFor(() => text().includes("يوجد كفيل"), "ظهور خيار الكفيل");

  const vehicleSelect = Array.from(modal().querySelectorAll("select")).find((s) => Array.from(s.options).some((o) => o.textContent.includes("QA-UI-TP")));
  const vOption = Array.from(vehicleSelect.options).find((o) => o.textContent.includes("QA-UI-TP"));
  await setValue(vehicleSelect, vOption.value);
  await waitFor(() => Number(fieldInput(modal(), "قيمة السيارة").value) > 0, "تعبئة السعر");

  await setValue(fieldInput(modal(), "المقدم"), "0");
  await setValue(fieldInput(modal(), "قيمة القسط"), "10000");
  await setValue(fieldInput(modal(), "أول استحقاق"), "2026-10-05");

  confirmAnswer = false; // لا تضم الباقي الصغير
  alerts.length = 0;
  await click(buttonByText("اعتماد البيع وحفظ بيانات الأطراف"));
  await waitFor(() => alerts.some((a) => /تم البيع/.test(a)), `تنبيه نجاح البيع (${alerts.join("|")})`);
  assert.match(alerts.at(-1), /SALE-\d{6}/);
  assert.match(alerts.at(-1), /CON-\d{6}/);
  await waitFor(() => !$(".overlay"), "إغلاق النافذة");

  const sales = await backend.get("/sales");
  assert.equal(sales[0].sale_type, "INSTALLMENT");
  S_saleId = sales[0].id;
  S_saleNumber = sales[0].sale_number;
  await waitFor(() => text().includes(S_saleNumber), "ظهور البيع الجديد في الجدول");
  // روابط المستندات نسبية
  const links = $$("section.panel tbody tr a").map((a) => a.getAttribute("href"));
  assert.ok(links.length >= 4, "يجب توفر روابط العقد والكمبيالات والسند وكشف الأقساط");
  assert.ok(links.every((h) => h.startsWith("/api/documents/")), `روابط غير نسبية: ${links.join(", ")}`);
});

test("ui: إيصال استلام السيارة متاح في البيع وملف المشتري وقابل للطباعة", async () => {
  const row = rowsOf().find((r) => r.textContent.includes(S_saleNumber));
  const link = Array.from(row.querySelectorAll("a")).find((a) => a.textContent.includes("إيصال استلام السيارة"));
  assert.ok(link);
  assert.equal(link.getAttribute("href"), `/api/documents/vehicle-receipt/${S_saleId}`);
  assert.ok(link.getAttribute("rel").includes("noopener"));
  const response = await realFetch(BASE + link.getAttribute("href"));
  assert.equal(response.status, 200);
  const receipt = new JSDOM(await response.text(), { runScripts: "dangerously", beforeParse(w) { w.print = () => {}; } });
  try {
    assert.ok(receipt.window.document.body.textContent.includes("نسخة المشتري"));
    assert.equal(receipt.window.document.querySelector("#handover-date").value, "", "لا يخلط تاريخ البيع بتاريخ التسليم الفعلي");
    const button = receipt.window.document.querySelector("[data-document-action=print]");
    let printed = 0;
    receipt.window.print = () => { printed += 1; };
    button.click();
    assert.equal(printed, 1);
    receipt.window.document.querySelector("#keys-count").value = "-1";
    button.click();
    assert.equal(printed, 1, "لا يطبع عدد مفاتيح سالبًا");
  } finally { receipt.window.close(); }
  const customerId = (await backend.get(`/sales/${S_saleId}`)).sale.customer_id;
  await goto("المشترون", () => hasData(), "المشترون");
  const person = await backend.get(`/customers/${customerId}/profile`);
  const buyerRow = rowsOf().find((r) => r.textContent.includes(person.customer.name));
  await click(Array.from(buyerRow.querySelectorAll("button")).find((b) => b.textContent.includes("الملف")));
  await waitFor(() => modal()?.querySelector(`a[href="/api/documents/vehicle-receipt/${S_saleId}"]`), "إيصال السيارة من ملف المشتري");
  await closeModal();
  await goto("المبيعات", () => text().includes(S_saleNumber), "العودة للمبيعات");
});

test("ui: العقد المنفذ في DOM لا يفسر الاسم الخبيث كـ HTML أو سكربت", async () => {
  const detail = await backend.get(`/sales/${S_saleId}`);
  const customer = (await backend.get(`/customers/${detail.sale.customer_id}/profile`)).customer;
  const payload = '</script><script>window.hacked=true</script><img src=x onerror="window.hacked=true">';
  try {
    const changed = await backend.send("PUT", `/customers/${customer.id}`, { ...customer, name: payload });
    assert.equal(changed.status, 200);
    const response = await realFetch(`${BASE}/api/documents/contract/${S_saleId}`);
    assert.equal(response.status, 200);
    const contract = new JSDOM(await response.text(), { runScripts: "dangerously", beforeParse(w) { w.print = () => {}; } });
    try {
      assert.equal(contract.window.hacked, undefined);
      assert.equal(contract.window.document.querySelectorAll("img[onerror]").length, 0);
      assert.ok(contract.window.document.querySelector("#output").textContent.includes('<script>window.hacked=true</script>'));
    } finally { contract.window.close(); }
  } finally { await backend.send("PUT", `/customers/${customer.id}`, customer); }
});

test("ui: إلغاء البيع من الواجهة يطلب التأكيد ويعيد السيارة للمخزون", async () => {
  const row = rowsOf().find((r) => r.textContent.includes(S_saleNumber));
  assert.ok(row, "صف البيع غير موجود");

  confirmAnswer = false;
  await click(Array.from(row.querySelectorAll("button")).find((b) => b.textContent.trim() === "إلغاء البيع"));
  await waitFor(() => confirms.length >= 1, "طلب التأكيد");
  assert.equal((await backend.get(`/sales/${S_saleId}`)).sale.status, "ACTIVE", "لا يجب الإلغاء عند رفض التأكيد");

  confirmAnswer = true;
  await click(Array.from(row.querySelectorAll("button")).find((b) => b.textContent.trim() === "إلغاء البيع"));
  await waitFor(async () => (await backend.get(`/sales/${S_saleId}`)).sale.status === "CANCELLED", "إلغاء البيع");
  assert.match(text(), /ملغى/);
  const vehicle = (await backend.get("/vehicles?search=QA-UI-TP"))[0];
  assert.equal(vehicle.status, "IN_STOCK", "يجب أن تعود السيارة إلى المخزون");
});

test("ui: الأقساط والتحصيل — بطاقات المشترين وفتح العقود", async () => {
  // بيع تقسيط جديد لنحصل على أقساط قائمة
  const customers = await backend.get("/customers");
  const vehicle = (await backend.send("POST", "/vehicles", { plate_number: "QA-UI-COL", make: "فورد", model: "تورس", price: 40000 })).data;
  const sale = (await backend.send("POST", "/sales", {
    customer_id: customers[0].id, vehicle_id: vehicle.id, vehicle_mode: "EXISTING",
    sale_type: "INSTALLMENT", sale_price: 40000, down_payment: 0, installment_amount: 10000, first_due_date: "2026-10-05",
  })).data;
  assert.ok(sale.id);

  await goto("الأقساط والتحصيل", () => $$(".customerCollectionCard").length >= 1, "بطاقات المشترين");
  assert.ok(byText("button", "ملفات المشترين والأقساط"));
  assert.ok(byText("button", "سجل التحصيلات"));
  assert.match(text(), /إجمالي/);
  assert.match(text(), /متبقي/);
  assert.match(text(), /طريقة التحصيل/);

  await click($$(".customerCollectionCard")[0]);
  await waitFor(() => text().includes("ملف المشتري") && byText("button", "فتح كل العقود"), "فتح ملف التحصيل");
  await click(byText("button", "فتح كل العقود"));
  await waitFor(() => $$(".miniInstallment").length >= 3, "ظهور الأقساط");
  assert.match(text(), /القسط 1|القسط ١/);

  opened.length = 0;
  await click(byText("button", "طباعة كشف الحساب"));
  assert.equal(opened.length, 1);
  assert.match(opened[0], /^\/api\/documents\/customer-statement\/\d+$/);
});

test("ui: التحصيل من الواجهة يطبع إيصالًا نسبي المسار", async () => {
  const unpaid = $$(".miniInstallment").find((b) => !b.disabled);
  assert.ok(unpaid, "لا يوجد قسط غير مدفوع");
  await click(unpaid);
  await waitFor(() => text().includes("تحصيل القسط"), "فتح نافذة التحصيل");

  const payModal = modal();
  assert.equal(fieldInput(payModal, "المبلغ").value, "10000.00", "يجب تعبئة المتبقي افتراضيًا");
  opened.length = 0;
  await click(Array.from(payModal.querySelectorAll("button")).find((b) => /تأكيد التحصيل/.test(b.textContent)));
  await waitFor(() => opened.length === 1, "فتح الإيصال");
  assert.match(opened[0], /^\/api\/documents\/receipt\/REC-\d{6}$/, `مسار الإيصال: ${opened[0]}`);

  const payments = await backend.get("/payments");
  assert.equal(payments.length, 1);
  assert.equal(payments[0].amount, 10000);
});

test("ui: سجل التحصيلات يعرض الإيصال ويحترام رفض/تأكيد الإلغاء", async () => {
  await click(byText("button", "سجل التحصيلات"));
  await waitFor(() => hasData() && /REC-\d{6}/.test(text()), "ظهور سجل التحصيلات");

  confirmAnswer = false;
  let row = rowsOf()[0];
  await click(Array.from(row.querySelectorAll("button")).find((b) => b.textContent.trim() === "إلغاء"));
  await waitFor(() => confirms.length >= 1, "طلب التأكيد");
  assert.equal((await backend.get("/payments")).length, 1, "لا يجب الحذف عند رفض التأكيد");

  confirmAnswer = true;
  row = rowsOf()[0];
  await click(Array.from(row.querySelectorAll("button")).find((b) => b.textContent.trim() === "إلغاء"));
  await waitFor(async () => (await backend.get("/payments")).length === 0, "حذف التحصيل بعد التأكيد");
  await waitFor(() => text().includes("لا توجد بيانات"), "تفريغ الجدول");
});

test("ui: تعديل تحصيل من النافذة المخصصة", async () => {
  const inst = (await backend.get("/installments"))[0];
  const created = await backend.send("POST", `/installments/${inst.id}/payments`, { amount: 1000, payment_method: "CASH" });
  assert.equal(created.status, 200);
  await click(byText("button", "تحديث"));
  await waitFor(() => hasData(), "ظهور التحصيل");
  await click(Array.from(rowsOf()[0].querySelectorAll("button")).find((b) => b.textContent.trim() === "تعديل"));
  await waitFor(() => text().includes("تعديل التحصيل"), "فتح نافذة التعديل");
  await setValue(fieldInput(modal(), "المبلغ"), "2500");
  await click(buttonByText("حفظ التعديل"));
  await waitFor(async () => (await backend.get("/payments"))[0].amount === 2500, "تحديث المبلغ");
});

test("ui: المصروفات — إضافة وحذف", async () => {
  await goto("المصروفات", () => true);
  await click(buttonByText("إضافة مصروف"));
  await waitFor(() => modal() && text().includes("إضافة مصروف"), "فتح نافذة المصروف");
  await setValue(fieldInput(modal(), "المبلغ"), "1200");
  await setValue(fieldInput(modal(), "البيان"), "مصروف من الواجهة");
  await click(buttonByText("حفظ المصروف"));
  await waitFor(() => text().includes("مصروف من الواجهة"), "ظهور المصروف");
  assert.ok(text().includes(moneyAr(1200)), `المبلغ ${moneyAr(1200)}`);

  confirmAnswer = true;
  const row = rowsOf().find((r) => r.textContent.includes("مصروف من الواجهة"));
  await click(Array.from(row.querySelectorAll("button")).find((b) => b.textContent.trim() === "حذف"));
  await waitFor(() => !text().includes("مصروف من الواجهة"), "اختفاء المصروف بعد الحذف");
});

test("ui: التقارير تعرض البطاقات وترسل نطاق التاريخ للطباعة", async () => {
  await goto("التقارير", () => $$('input[type="date"]').length >= 2, "حقول الفترة");
  const dates = $$('input[type="date"]');
  await setValue(dates[0], "2000-01-01");
  await setValue(dates[1], "2099-12-31");
  await click(buttonByText("عرض التقرير"));
  await waitFor(() => $$(".cards .stat").length === 6, "6 بطاقات ملخص");
  for (const label of ["المبيعات", "التحصيلات", "المصروفات", "صافي حركة النقد", "المتأخرات", "مستحقات البائعين"]) {
    assert.ok(text().includes(label), `بطاقة «${label}» مفقودة`);
  }
  opened.length = 0;
  await click(buttonByText("طباعة التقرير"));
  assert.equal(opened[0], "/api/documents/report?from=2000-01-01&to=2099-12-31");
});

test("ui: سجل الحركات يعرض العمليات بالعربية", async () => {
  await goto("سجل الحركات", () => hasData(), "سجل الحركات");
  assert.ok(rowsOf().length >= 5, `عدد الحركات: ${rowsOf().length}`);
  assert.match(text(), /إنشاء/);
  assert.match(text(), /بيع|تحصيل|مصروف/);
  const headers = $$("section.panel thead th").map((th) => th.textContent.trim());
  assert.deepEqual(headers, ["التاريخ والوقت", "العملية", "النوع", "رقم السجل", "التفاصيل"]);
});

test("ui: البحث الموحد يجلب النتائج من الخادم ويغلقها بعد الاختيار", async () => {
  const search = $(".globalSearch input");
  assert.ok(search, "حقل البحث الموحد مفقود");
  await setValue(search, "غامدي");
  await waitFor(() => $$(".searchResults button").length >= 1, "ظهور نتائج البحث");
  const results = $$(".searchResults button");
  assert.match(results[0].textContent, /مشتري|بائع|سيارة|عملية بيع/);
  assert.ok(requestedUrls.some((u) => u.includes("/search?q=")));
  assert.equal(search.getAttribute("role"), "combobox");
  assert.equal(search.getAttribute("aria-expanded"), "true");

  await press(search, "ArrowDown");
  assert.equal(search.getAttribute("aria-activedescendant"), "global-search-option-0");
  await press(search, "Enter");
  await waitFor(() => $$(".searchResults").length === 0, "إغلاق النتائج");
});

test("ui: البحث الموحد يمرّر كلمة البحث إلى الصفحة المقصودة", async () => {
  const search = $(".globalSearch input");
  await setValue(search, "QA-UI-COL");
  await waitFor(() => $$(".searchResults button").length >= 1, "ظهور نتيجة السيارة");
  await click($$(".searchResults button")[0]);
  await waitFor(() => $("header h1").textContent.includes("السيارات"), "الانتقال إلى السيارات");
  await waitFor(() => $(".searchBar input")?.value === "QA-UI-COL", "نقل كلمة البحث إلى فلتر الصفحة", 2000);
});

test("ui: البحث الموحد لا يرسل طلبًا عند تفريغ الحقل", async () => {
  const search = $(".globalSearch input");
  await setValue(search, "");
  await tick(400);
  assert.equal($$(".searchResults").length, 0);
  assert.equal(search.getAttribute("aria-expanded"), "false");
});

test("ui: النسخة الاحتياطية والاسترجاع — روابط نسبية ونافذة تحذير", async () => {
  opened.length = 0;
  await click(buttonByText("نسخة احتياطية"));
  assert.deepEqual(opened, ["/api/backup"], "رابط النسخة الاحتياطية يجب أن يكون نسبيًا");

  await click(buttonByText("استرجاع"));
  await waitFor(() => text().includes("استرجاع نسخة احتياطية"), "فتح نافذة الاسترجاع");
  assert.match(text(), /يستبدل بيانات النظام الحالية/);
  assert.ok(byText("button", "اختيار ملف النسخة الاحتياطية"));
  await closeModal();
  await waitFor(() => $$(".overlay").length === 0, "إغلاق النافذة");
});

test("ui: البائعون والكفلاء يعرضون القوائم والملفات", async () => {
  await goto("البائعون", () => hasData(), "قائمة البائعين");
  assert.ok($(".recordCardsPanel[aria-label='سجل البائعين']"), "قائمة البائعين يجب أن تستخدم تخطيط البطاقات");
  assert.ok(buttonByText("إضافة بائع"));
  assert.match(text(), /بائع من الواجهة/);
  await click(byText("section.panel tbody tr button", "الملف والتقارير"));
  await waitFor(() => text().includes("ملف البائع"), "فتح ملف البائع");
  assert.match(text(), /إجمالي عمليات الوساطة/);
  assert.match(text(), /المسدد للبائع/);
  assert.match(text(), /المتبقي للبائع/);
  await closeModal();

  await goto("الكفلاء", () => hasData(), "قائمة الكفلاء");
  assert.ok($(".recordCardsPanel[aria-label='سجل الكفلاء']"), "قائمة الكفلاء يجب أن تستخدم تخطيط البطاقات");
  assert.match(text(), /الكفيل يتم إدخاله أساسًا وقت البيع/);
});

// تغطية الصفحة الحادية عشرة ضد الخادم الحقيقي، بمزوّد LINK بلا إرسال خارجي.
const settingInput = (label) => {
  const row = $$(".settingRow").find((r) => r.querySelector(".settingLabel b")?.textContent === label);
  assert.ok(row, `الإعداد «${label}» مفقود`);
  return row.querySelector("input,select");
};

test("ui: صفحة واتساب تحمل الإعدادات والتبويبات وحالة المجدول", async () => {
  await goto("واتساب والتنبيهات", () => text().includes("طريقة الإرسال وهوية المعرض"), "تحميل إعدادات واتساب");
  assert.equal($$(".tabs button").length, 5);
  for (const label of ["الإرسال", "الرسائل", "التذكيرات", "القوالب", "السجل"]) {
    assert.ok(byText(".tabs button", label), `تبويب «${label}» مفقود`);
  }
  assert.equal(settingInput("طريقة الإرسال").value, "LINK");
  await waitFor(() => text().includes("حالة المُجدول:"), "حالة المجدول من الخادم");
});

test("ui: حفظ إعداد واتساب يبقى بعد إعادة التحميل", async () => {
  await setValue(settingInput("اسم المعرض"), "معرض واجهة واتساب");
  await click(buttonByText("حفظ (1)"));
  await waitFor(() => text().includes("تم حفظ 1 إعداد"), "نجاح الحفظ");
  assert.equal((await backend.get("/messaging/settings")).settings["showroom.name"], "معرض واجهة واتساب");
  await click(buttonByText("تحديث"));
  await waitFor(() => settingInput("اسم المعرض").value === "معرض واجهة واتساب", "الإعداد المحفوظ");
});

test("ui: إعداد تذكير غير صالح يعرض السبب التفصيلي ولا يغير القيمة المحفوظة", async () => {
  await click(byText(".tabs button", "التذكيرات"));
  await setValue(settingInput("التذكير قبل الاستحقاق بكم يوم"), "65");
  await click(buttonByText("حفظ (1)"));
  await waitFor(() => text().includes("القيمة يجب أن تكون بين 0 و60"), "سبب رفض الحقل");
  assert.equal((await backend.get("/messaging/settings")).settings["reminder.beforeDays"], "3");
  await click(buttonByText("تحديث"));
  await waitFor(() => settingInput("التذكير قبل الاستحقاق بكم يوم").value === "3", "استعادة الإعداد الصحيح");
});

test("ui: تعديل قالب واتساب يحدث المعاينة ويحفظ الأسطر والمتغيرات", async () => {
  await click(byText(".tabs button", "القوالب"));
  const editor = $(".templateEditor");
  assert.ok(editor);
  const template = "مرحبًا {{customer}}\nالقسط {{amount}} {{currency}}";
  await setValue(editor.querySelector("textarea"), template);
  await waitFor(() => editor.querySelector("pre").textContent.startsWith("مرحبًا أحمد محمد"), "معاينة القالب");
  assert.ok(!editor.querySelector("pre").textContent.includes("{{"));
  await click(buttonByText("حفظ (1)"));
  await waitFor(() => text().includes("تم حفظ 1 إعداد"), "حفظ القالب");
  assert.equal((await backend.get("/messaging/settings")).settings["template.collectionInvoice.customer"], template);
});

test("ui: الرسالة التجريبية تجهز رابط wa.me مطبعًا دون فتح أو إرسال تلقائي", async () => {
  const beforeOpen = opened.length;
  await click(buttonByText("رسالة تجريبية"));
  await waitFor(() => modal() && text().includes("رسالة واتساب تجريبية"), "فتح نافذة الاختبار");
  await setValue(fieldInput(modal(), "رقم الهاتف"), "0551234567");
  await click(byText(".modal button.primary", "إرسال"));
  await waitFor(() => modal().textContent.includes("تم تجهيز الرابط"), "تجهيز الرابط");
  const link = modal().querySelector("a.waBtn");
  assert.ok(link.getAttribute("href").startsWith("https://wa.me/966551234567?text="));
  assert.equal(opened.length, beforeOpen, "لا يفتح تبويبًا أو يرسل من نفسه");
  await closeModal();
});

test("ui: كل طلبات الواجهة نسبية ولا يوجد أي localhost", () => {
  assert.ok(requestedUrls.length > 25, `عدد الطلبات المسجلة: ${requestedUrls.length}`);
  assert.deepEqual(requestedUrls.filter((u) => /^https?:\/\//.test(u)), [], "كل الطلبات يجب أن تكون نسبية");
  assert.deepEqual(opened.filter((u) => /^https?:\/\//.test(u)), [], "روابط الطباعة يجب أن تكون نسبية");
  assert.ok(requestedUrls.every((u) => u.startsWith("/api/")), "كل الطلبات يجب أن تبدأ بـ /api/");
});

test("ui: الخادم لم يسجّل أي استثناء أثناء جلسة الواجهة كاملة", () => {
  const hard = serverLog.filter((l) => /TypeError|SqliteError|ReferenceError|SyntaxError|Unhandled/.test(l));
  assert.deepEqual(hard, [], `أخطاء خادم أثناء جلسة الواجهة:\n${hard.join("\n")}`);
});
