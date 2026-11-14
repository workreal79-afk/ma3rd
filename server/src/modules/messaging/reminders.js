// محرك التذكيرات: يفحص كل الأقساط النشطة ويقرّر أي الرسائل تُرسَل اليوم.
//
// قواعد الأمان المطبّقة (كلها قابلة للتعديل من صفحة الإعدادات):
//   • ساعات الهدوء: لا إرسال أوتوماتيك بين quietStart وquietEnd
//   • أيام ممنوعة: مثل الجمعة
//   • منع التكرار: نفس الرسالة لنفس الرقم خلال dedupeHours ساعة
//   • سقف لكل قسط: maxPerInstallment
//   • سقف يومي: dailyCap
//   • فترة سماح للكفيل: guarantor.graceDays بعد تأخير المشتري
//
// الإرسال اليدوي يتجاوز ساعات الهدوء والأيام الممنوعة (قرار موظف واعٍ)، لكنه يظل
// ملتزمًا بمنع التكرار والسقوف حتى لا يتحول الضغط المتكرر إلى إزعاج للعميل.

import { dispatchMessage } from "./providers.js";

const DAY_MS = 86400000;

function diffDays(fromDate, toDate) {
  const a = new Date(`${fromDate}T00:00:00`);
  const b = new Date(`${toDate}T00:00:00`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  return Math.round((b - a) / DAY_MS);
}

function parseTime(value, fallback) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || "").trim());
  if (!match) return fallback;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

export function createRemindersService({ db, settings, compose, localDateString, getWeb = () => null }) {
  // هل اللحظة الحالية داخل ساعات الهدوء؟ (النافذة قد تعبر منتصف الليل)
  function inQuietHours(date) {
    const start = parseTime(settings.get("reminder.quietStart"), { hour: 21, minute: 0 });
    const end = parseTime(settings.get("reminder.quietEnd"), { hour: 9, minute: 0 });
    const minutes = date.getHours() * 60 + date.getMinutes();
    const s = start.hour * 60 + start.minute;
    const e = end.hour * 60 + end.minute;
    if (s === e) return false;
    return s < e ? minutes >= s && minutes < e : minutes >= s || minutes < e;
  }

  function isSkippedWeekday(date) {
    return settings.getIntList("reminder.skipWeekdays").includes(date.getDay());
  }

  function alreadySent({ kind, entityType, entityId, phone, hours }) {
    if (!hours || hours <= 0 || !phone) return false;
    const since = new Date(Date.now() - hours * 3600000).toISOString().slice(0, 19).replace("T", " ");
    const row = db.prepare(
      `SELECT 1 FROM message_log
        WHERE kind=? AND entity_type=? AND entity_id=? AND recipient_phone=?
          AND status IN ('SENT','LINK_READY') AND created_at >= ? LIMIT 1`,
    ).get(kind, entityType, entityId, phone, since);
    return Boolean(row);
  }

  function sentCountForInstallment(installmentId, phone) {
    const row = db.prepare(
      `SELECT COUNT(*) n FROM message_log
        WHERE entity_type='INSTALLMENT' AND entity_id=? AND recipient_phone=?
          AND status IN ('SENT','LINK_READY')`,
    ).get(installmentId, phone);
    return Number(row?.n || 0);
  }

  function sentToday() {
    const today = localDateString();
    const row = db.prepare(
      `SELECT COUNT(*) n FROM message_log WHERE substr(created_at,1,10)=? AND status IN ('SENT','LINK_READY')`,
    ).get(today);
    return Number(row?.n || 0);
  }

  // كل الأقساط النشطة غير المسدَّدة بالكامل، مرتّبة حسب الاستحقاق.
  // لا معاملات هنا: الاستعلام لا يحتاج تاريخ اليوم (التصنيف يحدث في classify).
  function openInstallments() {
    return db.prepare(
      `SELECT i.id, i.installment_number, i.due_date, i.amount, i.paid_amount,
              c.sale_id, c.contract_number, s.sale_number, s.transaction_mode, s.customer_id,
              cu.name customer_name, cu.phone customer_phone, s.guarantor_id
         FROM installments i
         JOIN contracts c ON c.id = i.contract_id
         JOIN sales s ON s.id = c.sale_id
         JOIN customers cu ON cu.id = s.customer_id
        WHERE s.status='ACTIVE' AND s.sale_type='INSTALLMENT' AND i.status<>'CANCELLED' AND i.paid_amount < i.amount
        ORDER BY i.due_date ASC, i.installment_number ASC`,
    ).all();
  }

  // تصنيف القسط: هل يستحق تذكيرًا اليوم؟ ولأي نوع؟
  // الإشارة: days = today − due_date، فالموجب يعني متأخرًا، والصفر اليوم، والسالب قادم.
  function classify(installment, today) {
    const days = diffDays(installment.due_date, today);
    const beforeDays = settings.getInt("reminder.beforeDays");
    const overdueDays = settings.getIntList("reminder.afterOverdueDays");

    if (days > 0) {
      // نرسل فقط في الأيام المحددة (1، 7، 15، 30) بدل كل يوم حتى لا يتحول لإزعاج.
      return overdueDays.includes(days) ? { kind: "OVERDUE_REMINDER", daysOverdue: days } : null;
    }
    if (days === 0) {
      return settings.getBool("reminder.onDueDate") ? { kind: "DUE_REMINDER", daysOverdue: 0 } : null;
    }
    const untilDue = Math.abs(days);
    return untilDue <= beforeDays ? { kind: "DUE_REMINDER", daysOverdue: -untilDue } : null;
  }

  // يبني خطة اليوم بدون إرسال — تُستخدم للمعاينة في الواجهة وللتشغيل الأوتوماتيك.
  function plan({ now = new Date(), trigger = "MANUAL" } = {}) {
    const today = localDateString(now);
    const enabled = settings.getBool("whatsapp.enabled");
    const blocks = [];
    if (!enabled) blocks.push("ميزة واتساب معطّلة من الإعدادات");
    if (trigger === "SCHEDULE" && inQuietHours(now)) blocks.push(`داخل ساعات الهدوء (${settings.get("reminder.quietStart")}–${settings.get("reminder.quietEnd")})`);
    if (trigger === "SCHEDULE" && isSkippedWeekday(now)) blocks.push("اليوم ضمن الأيام الممنوعة للإرسال الأوتوماتيك");

    const cap = settings.getInt("reminder.dailyCap");
    const dedupeHours = settings.getInt("reminder.dedupeHours");
    const maxPerInstallment = settings.getInt("reminder.maxPerInstallment");
    let remainingQuota = Math.max(0, cap - sentToday());

    const planned = [];
    const skipped = [];

    if (blocks.length) {
      return { today, trigger, blocked: true, blocks, planned, skipped, stats: stats(planned, skipped), remainingQuota };
    }

    for (const row of openInstallments()) {
      const hit = classify(row, today);
      if (!hit) continue;

      const composed = compose({ kind: hit.kind, installmentId: row.id, today });
      if (composed.error) {
        skipped.push({ installmentId: row.id, sale_number: row.sale_number, reason: composed.error });
        continue;
      }

      for (const message of composed.messages) {
        const base = {
          installmentId: row.id,
          installment_number: row.installment_number,
          sale_number: row.sale_number,
          due_date: row.due_date,
          customer_name: row.customer_name,
          daysOverdue: hit.daysOverdue,
          kind: hit.kind,
          role: message.role,
          name: message.name,
          phone: message.phone,
          normalizedPhone: message.normalizedPhone,
          body: message.body,
          vars: message.vars,
          link: message.link,
          templateKey: message.templateKey,
        };

        if (message.deferred) {
          skipped.push({ ...base, reason: message.skipReason });
          continue;
        }
        if (message.skipReason) {
          skipped.push({ ...base, reason: message.skipReason });
          continue;
        }
        if (remainingQuota <= 0) {
          skipped.push({ ...base, reason: `تم بلوغ السقف اليومي (${cap} رسالة)` });
          continue;
        }
        if (alreadySent({ kind: hit.kind, entityType: "INSTALLMENT", entityId: row.id, phone: message.normalizedPhone, hours: dedupeHours })) {
          skipped.push({ ...base, reason: `أُرسلت خلال آخر ${dedupeHours} ساعة (منع التكرار)` });
          continue;
        }
        if (sentCountForInstallment(row.id, message.normalizedPhone) >= maxPerInstallment) {
          skipped.push({ ...base, reason: `بلغت الحد الأقصى لهذا القسط (${maxPerInstallment} رسالة)` });
          continue;
        }

        planned.push(base);
        remainingQuota -= 1;
      }
    }

    return { today, trigger, blocked: false, blocks: [], planned, skipped, stats: stats(planned, skipped), remainingQuota };
  }

  function templateParamsForReminder(vars = {}) {
    const names = String(settings.get("whatsapp.cloud.params.reminder") || "").split(",").map((x) => x.trim()).filter(Boolean);
    return names.map((name) => vars[name] ?? "");
  }

  function stats(planned, skipped) {
    const byKind = {};
    for (const p of planned) byKind[p.kind] = (byKind[p.kind] || 0) + 1;
    const byRole = {};
    for (const p of planned) byRole[p.role] = (byRole[p.role] || 0) + 1;
    return { total: planned.length, skipped: skipped.length, byKind, byRole };
  }

  function logMessage(entry) {
    const info = db.prepare(
      `INSERT INTO message_log(channel,provider,kind,recipient_role,recipient_name,recipient_phone,
                               entity_type,entity_id,body,link,status,error,trigger_source,sent_at)
       VALUES('WHATSAPP',?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      entry.provider, entry.kind, entry.role, entry.name || "", entry.phone || "",
      entry.entityType || "INSTALLMENT", entry.entityId ?? null, entry.body || "", entry.link || "",
      entry.status, entry.error || null, entry.trigger || "MANUAL",
      entry.status === "SENT" || entry.status === "LINK_READY" ? new Date().toISOString() : null,
    );
    return Number(info.lastInsertRowid);
  }

  // تنفيذ الخطة: يُرسل (أو يجهّز الروابط) ويسجّل كل رسالة.
  async function execute({ now = new Date(), trigger = "MANUAL", fetchImpl } = {}) {
    const plan_ = plan({ now, trigger });
    if (plan_.blocked) return { ...plan_, sent: [], results: { SENT: 0, LINK_READY: 0, FAILED: 0 } };

    const provider = String(settings.get("whatsapp.provider")).toUpperCase();
    const cc = settings.get("whatsapp.defaultCountryCode");
    const cloud = {
      phoneId: settings.get("whatsapp.cloud.phoneId"),
      token: settings.get("whatsapp.cloud.token"),
      templateName: provider === "CLOUD" ? settings.get("whatsapp.cloud.template.reminder") : "",
    };

    const sent = [];
    const results = { SENT: 0, LINK_READY: 0, FAILED: 0 };

    for (const item of plan_.planned) {
      const dispatch = await dispatchMessage({
        provider,
        phone: item.normalizedPhone || item.phone,
        text: item.body,
        countryCode: cc,
        cloud: { ...cloud, templateParams: provider === "CLOUD" ? templateParamsForReminder(item.vars || {}) : [] },
        web: getWeb(),
        fetchImpl,
      });
      const status = dispatch.status === "SENT" ? "SENT" : dispatch.status === "LINK_READY" ? "LINK_READY" : "FAILED";
      results[status] = (results[status] || 0) + 1;
      const id = logMessage({
        provider,
        kind: item.kind,
        role: item.role,
        name: item.name,
        phone: dispatch.phone || item.normalizedPhone || item.phone,
        entityType: "INSTALLMENT",
        entityId: item.installmentId,
        body: item.body,
        link: dispatch.link || item.link,
        status,
        error: dispatch.error || "",
        trigger,
      });
      sent.push({
        id, ...item,
        // نعيد الرقم المطبَّع لا الخام حتى تتطابق الاستجابة مع ما يُخزَّن في السجل.
        rawPhone: item.phone,
        phone: dispatch.phone || item.normalizedPhone || item.phone,
        status, provider, link: dispatch.link || item.link, error: dispatch.error || "",
      });
    }

    if (sent.length) {
      try {
        db.prepare(`INSERT INTO audit_log(action,entity_type,entity_id,details) VALUES(?,?,?,?)`)
          .run("SEND", "WHATSAPP_BULK", null, `${trigger === "SCHEDULE" ? "تذكيرات مجدولة" : "تذكيرات يدوية"}: ${sent.length} رسالة`);
      } catch { /* سجل التدقيق اختياري */ }
    }

    return { ...plan_, sent, results };
  }

  return { plan, execute, inQuietHours, isSkippedWeekday, classify, openInstallments, diffDays, logMessage, sentToday };
}
