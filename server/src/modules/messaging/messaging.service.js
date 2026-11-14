// تجميع خدمات واتساب في واجهة واحدة تُحقن في المسارات وفي المُجدول.
// الفصل بين البناء (factory) والنسخة الافتراضية يجعل الاختبارات تبني نسخة مستقلة
// على قاعدة بيانات مؤقتة.

import { createSettingsService, DEFAULTS, MESSAGE_KINDS, PROVIDERS } from "./settings.service.js";
import { createComposeService } from "./compose.js";
import { createRemindersService } from "./reminders.js";
import { TEMPLATE_VARIABLES, variablesIn, renderTemplate } from "./templates.js";
import { providerLabel } from "./providers.js";

export function createMessagingService({ db, localDateString, money }) {
  const settings = createSettingsService(db);
  // createComposeService يرجّع كائن خدمات؛ نأخذ منه دالة التركيب وحدها.
  const composer = createComposeService({ db, settings, localDateString, money });
  let whatsappWeb = null;
  const reminders = createRemindersService({ db, settings, compose: composer.compose, localDateString, getWeb: () => whatsappWeb });

  function publicSettings() {
    const all = settings.loadAll();
    const token = all["whatsapp.cloud.token"] || "";
    return {
      ...all,
      // لا نُعيد التوكن كاملًا للواجهة أبدًا: يكفي آخر 4 أحرف للتأكد من صحته.
      "whatsapp.cloud.token": token ? `••••${token.slice(-4)}` : "",
      "whatsapp.cloud.tokenSet": Boolean(token),
    };
  }

  function meta() {
    return {
      kinds: MESSAGE_KINDS,
      providers: PROVIDERS.map((id) => ({ id, label: providerLabel(id) })),
      variables: TEMPLATE_VARIABLES.map(([id, label]) => ({ id, label })),
      templateKeys: Object.keys(DEFAULTS).filter((k) => k.startsWith("template.")),
      msgKeys: Object.keys(DEFAULTS).filter((k) => k.startsWith("msg.")),
      defaults: Object.fromEntries(
        Object.entries(DEFAULTS).filter(([k]) => k.startsWith("template.")),
      ),
      templateVariables: Object.fromEntries(
        Object.entries(DEFAULTS)
          .filter(([k]) => k.startsWith("template."))
          .map(([k, v]) => [k, variablesIn(v)]),
      ),
    };
  }

  function logQuery({ limit = 50, offset = 0, kind, status, role, phone, search }) {
    const where = [];
    const params = [];
    if (kind) { where.push("kind=?"); params.push(kind); }
    if (status) { where.push("status=?"); params.push(status); }
    if (role) { where.push("recipient_role=?"); params.push(role); }
    if (phone) { where.push("recipient_phone LIKE ?"); params.push(`%${phone}%`); }
    if (search) { where.push("(recipient_name LIKE ? OR body LIKE ? OR recipient_phone LIKE ?)"); params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const requestedLimit = Number(limit), requestedOffset = Number(offset);
    const safeLimit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 500) : 50;
    const safeOffset = Number.isFinite(requestedOffset) ? Math.min(Math.max(Math.trunc(requestedOffset), 0), Number.MAX_SAFE_INTEGER) : 0;
    const rows = db.prepare(`SELECT * FROM message_log ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, safeLimit, safeOffset);
    const total = Number(db.prepare(`SELECT COUNT(*) n FROM message_log ${clause}`).get(...params).n || 0);
    return { rows, total, limit: safeLimit, offset: safeOffset };
  }

  function logStats() {
    const today = localDateString();
    const row = db.prepare(`SELECT
        COUNT(*) total,
        SUM(CASE WHEN status='SENT' THEN 1 ELSE 0 END) sent,
        SUM(CASE WHEN status='LINK_READY' THEN 1 ELSE 0 END) link_ready,
        SUM(CASE WHEN status='FAILED' THEN 1 ELSE 0 END) failed,
        SUM(CASE WHEN substr(created_at,1,10)=? THEN 1 ELSE 0 END) today
      FROM message_log`).get(today);
    const byKind = db.prepare(`SELECT kind, COUNT(*) n FROM message_log GROUP BY kind ORDER BY n DESC`).all();
    return { ...row, byKind, dailyCap: settings.getInt("reminder.dailyCap") };
  }

  // إرسال رسالة واحدة يدويًا (من زرار واتساب جنب أي عملية).
  async function sendManual({ kind, saleId, installmentId, receiptNumber, origin, roles, fetchImpl }) {
    const composed = composer.compose({ kind, saleId, installmentId, receiptNumber, origin });
    if (composed.error) return { ok: false, error: composed.error };

    const wanted = Array.isArray(roles) && roles.length ? roles.map((r) => String(r).toUpperCase()) : null;
    const provider = String(settings.get("whatsapp.provider")).toUpperCase();
    const cc = settings.get("whatsapp.defaultCountryCode");
    const entityType = receiptNumber ? "PAYMENT" : "INSTALLMENT";

    // نستورد هنا لتجنّب دورة استيراد عند البناء.
    const { dispatchMessage } = await import("./providers.js");
    const cloud = {
      phoneId: settings.get("whatsapp.cloud.phoneId"),
      token: settings.get("whatsapp.cloud.token"),
      templateName: provider === "CLOUD" ? cloudTemplateName(kind) : "",
    };

    const results = [];
    for (const message of composed.messages) {
      if (wanted && !wanted.includes(String(message.role).toUpperCase()) && !wanted.includes(message.templateKey)) continue;
      if (message.skipReason) {
        results.push({ role: message.role, name: message.name, phone: message.phone, status: "SKIPPED", error: message.skipReason });
        continue;
      }
      const dispatch = await dispatchMessage({
        provider, phone: message.normalizedPhone || message.phone, text: message.body, countryCode: cc,
        cloud: { ...cloud, templateParams: provider === "CLOUD" ? cloudTemplateParams(kind, message.vars) : [] }, web: whatsappWeb, fetchImpl,
      });
      const status = dispatch.status === "SENT" ? "SENT" : dispatch.status === "LINK_READY" ? "LINK_READY" : "FAILED";
      const id = reminders.logMessage({
        provider, kind, role: message.role, name: message.name,
        phone: dispatch.phone || message.normalizedPhone || message.phone,
        entityType, entityId: message.installmentId ?? message.receiptNumber ?? null,
        body: message.body, link: dispatch.link || message.link, status, error: dispatch.error || "", trigger: "MANUAL",
      });
      results.push({
        id, role: message.role, name: message.name, phone: dispatch.phone || message.phone,
        // link = الرابط الذي يفتحه الموظف (wa.me في المزوّد LINK)،
        // documentLink = رابط المستند المضمّن داخل نص الرسالة.
        status, link: dispatch.link || message.link, documentLink: message.link,
        error: dispatch.error || "", body: message.body, templateKey: message.templateKey,
      });
      try {
        db.prepare(`INSERT INTO audit_log(action,entity_type,entity_id,details) VALUES(?,?,?,?)`)
          .run("SEND", "WHATSAPP", message.installmentId ?? null, `${kind} → ${message.role} ${message.name || ""} (${status})`);
      } catch { /* اختياري */ }
    }

    return { ok: true, provider, sale: composed.sale, results };
  }

  function cloudTemplateParams(kind, vars = {}) {
    const key = kind === "PAYMENT_RECEIPT" ? "whatsapp.cloud.params.receipt"
      : kind === "COLLECTION_INVOICE" ? "whatsapp.cloud.params.invoice"
      : "whatsapp.cloud.params.reminder";
    return String(settings.get(key) || "").split(",").map((x) => x.trim()).filter(Boolean).map((name) => vars[name] ?? "");
  }

  function cloudTemplateName(kind) {
    if (kind === "PAYMENT_RECEIPT") return settings.get("whatsapp.cloud.template.receipt");
    if (kind === "COLLECTION_INVOICE") return settings.get("whatsapp.cloud.template.invoice");
    return settings.get("whatsapp.cloud.template.reminder");
  }

  return {
    settings,
    // تُعرض الدالة مباشرةً لأن المسارات والاختبارات تناديها؛ والكائن الكامل تحت composer.
    compose: composer.compose,
    composer,
    reminders,
    publicSettings,
    meta,
    logQuery,
    logStats,
    sendManual,
    renderTemplate,
    setWhatsAppWeb(instance) { whatsappWeb = instance || null; },
    whatsAppWeb: () => whatsappWeb,
  };
}
