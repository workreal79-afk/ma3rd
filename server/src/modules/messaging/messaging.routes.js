import { requestOrigin } from "../../middlewares/request-origin.js";
// مسارات واتساب. كلها تحت /api/messaging وتخضع لنفس المصادقة العامة.

import { dispatchMessage } from "./providers.js";
import { normalizePhone } from "./phone.js";

const originOf = requestOrigin;

export function registerMessagingRoutes(app, { db, audit, messaging, messagingScheduler }) {
  const { settings, compose, reminders, publicSettings, meta, logQuery, logStats, sendManual } = messaging;
  const web = messaging.whatsAppWeb?.();

  // ── حالة المُجدول (يعمل/متى آخر تشغيل) ─────────────────────────────────────
  app.get("/api/messaging/whatsapp-web/status", (_req, res) => {
    res.json(web ? web.status() : { status: "OFFLINE", configured: false });
  });

  app.post("/api/messaging/whatsapp-web/start", async (_req, res) => {
    if (!web) return res.status(503).json({ error: "محرّك WhatsApp Web غير مهيأ" });
    try {
      const result = await web.start();
      res.json({ ok: true, status: result });
    } catch (error) {
      res.status(503).json({ error: error?.message || String(error), status: web.status() });
    }
  });

  app.post("/api/messaging/whatsapp-web/logout", async (_req, res) => {
    if (!web) return res.status(503).json({ error: "محرّك WhatsApp Web غير مهيأ" });
    await web.logout();
    res.json({ ok: true, status: web.status() });
  });

  app.get("/api/messaging/scheduler", (_req, res) => {
    if (!messagingScheduler) return res.json({ enabled: false, running: false, note: "المُجدول غير متاح في هذا التشغيل" });
    res.json(messagingScheduler.status());
  });

  // ── الإعدادات ─────────────────────────────────────────────────────────────
  app.get("/api/messaging/settings", (_req, res) => {
    res.json({ settings: publicSettings(), meta: meta(), stats: logStats() });
  });

  app.put("/api/messaging/settings", (req, res) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({ error: "جسم الطلب يجب أن يكون كائنًا من المفاتيح والقيم" });
    }
    const entries = { ...body };
    // التوكن المقنّع (••••1234) يعني «لم يتغير» — فلا نكتبه فوق الحقيقي.
    if (typeof entries["whatsapp.cloud.token"] === "string" && entries["whatsapp.cloud.token"].includes("•")) {
      delete entries["whatsapp.cloud.token"];
    }
    if (!Object.keys(entries).length) return res.status(400).json({ error: "لا توجد مفاتيح للحفظ" });

    const result = settings.setMany(entries);
    if (!result.ok) return res.status(400).json({ error: "قيم غير صالحة", details: result.errors });
    audit("UPDATE", "MESSAGING_SETTINGS", null, `حفظ ${result.saved.length} إعداد`);
    if (web && settings.getBool("whatsapp.enabled") && String(settings.get("whatsapp.provider")).toUpperCase() === "WEB") {
      void web.start().catch((error) => console.error("[واتساب] تعذّر تشغيل المحرك المحلي:", error?.message || error));
    }
    res.json({ ok: true, saved: result.saved, settings: publicSettings() });
  });

  app.post("/api/messaging/settings/reset", (req, res) => {
    const keys = Array.isArray(req.body?.keys) ? req.body.keys.map(String) : [];
    const reset = settings.resetKeys(keys);
    audit("UPDATE", "MESSAGING_SETTINGS", null, `إعادة ${reset.length || "كل"} الإعدادات للافتراضي`);
    res.json({ ok: true, reset, settings: publicSettings() });
  });

  // ── المعاينة (بدون إرسال) ───────────────────────────────────────────────────
  app.post("/api/messaging/preview", (req, res) => {
    const { kind, saleId, installmentId, receiptNumber } = req.body || {};
    if (!kind) return res.status(400).json({ error: "نوع الرسالة مطلوب" });
    const result = compose({ kind: String(kind), saleId, installmentId, receiptNumber, origin: originOf(req) });
    if (result.error) return res.status(404).json({ error: result.error });
    res.json(result);
  });

  // ── الإرسال اليدوي ─────────────────────────────────────────────────────────
  app.post("/api/messaging/send", async (req, res) => {
    const { kind, saleId, installmentId, receiptNumber, roles } = req.body || {};
    if (!kind) return res.status(400).json({ error: "نوع الرسالة مطلوب" });
    if (!settings.getBool("whatsapp.enabled")) {
      return res.status(409).json({ error: "ميزة واتساب معطّلة — فعّلها من صفحة الإعدادات أولًا" });
    }
    const result = await sendManual({ kind: String(kind), saleId, installmentId, receiptNumber, roles, origin: originOf(req) });
    if (!result.ok) return res.status(404).json({ error: result.error });
    res.json(result);
  });

  // ── رسالة تجريبية لرقم معيّن ───────────────────────────────────────────────
  app.post("/api/messaging/test", async (req, res) => {
    const { phone, text } = req.body || {};
    const cc = settings.get("whatsapp.defaultCountryCode");
    const normalized = normalizePhone(phone, cc);
    if (!normalized) return res.status(400).json({ error: `رقم غير صالح: ${phone ?? "(فارغ)"}` });
    const body = String(text || "").trim()
      || `رسالة تجريبية من ${settings.get("showroom.name")} — إذا وصلتك فالإعدادات تعمل بشكل صحيح.`;
    const provider = String(settings.get("whatsapp.provider")).toUpperCase();
    const dispatch = await dispatchMessage({
      provider,
      phone: normalized,
      text: body,
      countryCode: cc,
      cloud: {
        phoneId: settings.get("whatsapp.cloud.phoneId"),
        token: settings.get("whatsapp.cloud.token"),
        templateName: "",
      },
    });
    if (dispatch.status === "FAILED") return res.status(502).json({ error: dispatch.error, phone: normalized });
    audit("SEND", "WHATSAPP_TEST", null, `رسالة تجريبية إلى ${normalized} (${dispatch.status})`);
    res.json({ ok: true, status: dispatch.status, phone: normalized, link: dispatch.link, body });
  });

  // ── التذكيرات: خطة اليوم + التنفيذ ─────────────────────────────────────────
  app.get("/api/messaging/reminders", (_req, res) => {
    res.json(reminders.plan({ trigger: "MANUAL" }));
  });

  app.post("/api/messaging/reminders/run", async (req, res) => {
    if (!settings.getBool("whatsapp.enabled")) {
      return res.status(409).json({ error: "ميزة واتساب معطّلة — فعّلها من صفحة الإعدادات أولًا" });
    }
    const trigger = String(req.body?.trigger || "MANUAL").toUpperCase() === "SCHEDULE" ? "SCHEDULE" : "MANUAL";
    const result = await reminders.execute({ trigger });
    res.json(result);
  });

  // ── السجل ──────────────────────────────────────────────────────────────────
  app.get("/api/messaging/log", (req, res) => {
    const { limit, offset, kind, status, role, phone, search } = req.query;
    res.json(logQuery({ limit, offset, kind, status, role, phone, search }));
  });

  app.get("/api/messaging/stats", (_req, res) => {
    res.json(logStats());
  });

  app.delete("/api/messaging/log", (_req, res) => {
    const info = db.prepare(`DELETE FROM message_log`).run();
    audit("DELETE", "WHATSAPP", null, `مسح سجل الرسائل (${info.changes} سطر)`);
    res.json({ ok: true, deleted: info.changes });
  });
}
