// تركيب الرسائل وتحديد المستلمين.
//
// قاعدة التوجيه (حسب طلب صاحب المعرض):
//   • فاتورة التحصيل   → المشتري + نسخة للمالك/صاحب المعرض
//   • تذكير الاستحقاق   → المشتري
//   • تذكير التأخير     → المشتري + الكفيل (بعد تجاوز فترة السماح)
//   • إيصال السداد      → المشتري + نسخة للمالك/صاحب المعرض
//
// ومالك المركبة يُحدَّد من نوع العملية: INTERMEDIARY ← المالك المسجّل في sellers،
// DIRECT ← رقم المعرض المحفوظ في الإعدادات.

import { renderTemplate } from "./templates.js";
import { normalizePhone } from "./phone.js";
import { buildDocumentLink } from "./providers.js";

const DAY_MS = 86400000;

function diffDays(fromDate, toDate) {
  const a = new Date(`${fromDate}T00:00:00`);
  const b = new Date(`${toDate}T00:00:00`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  return Math.round((b - a) / DAY_MS);
}

export function createComposeService({ db, settings, localDateString, money }) {
  const fmt = (n) => (money ? money(n) : String(Number(n || 0)));

  function vehicleLabel(v) {
    if (!v) return "";
    return [v.make, v.model, v.model_year, v.plate_number].filter(Boolean).join(" ").trim();
  }

  // المالك الفعلي للعملية: مالك خارجي ← المالك المسجّل، مباشر ← المعرض نفسه.
  function resolveOwner(sale, vehicle) {
    if (sale.transaction_mode === "INTERMEDIARY") {
      const sellerId = sale.seller_id || vehicle?.owner_seller_id || null;
      const seller = sellerId ? db.prepare(`SELECT id, name, phone FROM sellers WHERE id=?`).get(sellerId) : null;
      if (seller) return { role: "SELLER", name: seller.name, phone: seller.phone, kind: "THIRD_PARTY" };
      // مالك غير مسجّل: لا نرسل لأحد بدل إرسال لرقم خاطئ.
      return { role: "SELLER", name: "مالك غير مسجّل", phone: "", kind: "THIRD_PARTY" };
    }
    return {
      role: "SHOWROOM",
      name: settings.get("showroom.name"),
      phone: settings.get("showroom.phone"),
      kind: "SHOWROOM",
    };
  }

  function loadSale(saleId) {
    const sale = db.prepare(`SELECT * FROM sales WHERE id=?`).get(saleId);
    if (!sale) return null;
    const customer = db.prepare(`SELECT id, name, phone FROM customers WHERE id=?`).get(sale.customer_id) || {};
    const vehicle = db.prepare(`SELECT id,owner_seller_id,make,model,model_year,plate_number,vin FROM vehicles WHERE id=?`).get(sale.vehicle_id) || null;
    const guarantor = sale.guarantor_id
      ? db.prepare(`SELECT id, name, phone FROM guarantors WHERE id=?`).get(sale.guarantor_id)
      : null;
    const contract = db.prepare(`SELECT * FROM contracts WHERE sale_id=?`).get(saleId) || null;
    return { sale, customer, vehicle, guarantor, contract };
  }

  // إجمالي المتأخر على العميل عبر كل عقودهم النشطة — يظهر في فاتورة التحصيل.
  function customerOverdueTotal(customerId, today) {
    const row = db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN i.due_date < ? AND i.paid_amount < i.amount THEN i.amount - i.paid_amount ELSE 0 END),0) total
         FROM installments i
         JOIN contracts c ON c.id = i.contract_id
         JOIN sales s ON s.id = c.sale_id
        WHERE s.status='ACTIVE' AND s.customer_id=? AND i.status<>'CANCELLED'`,
    ).get(today, customerId);
    return Number(row?.total || 0);
  }

  function installmentTotals(saleId) {
    const row = db.prepare(
      `SELECT COUNT(*) count, COALESCE(SUM(amount),0) amount, COALESCE(SUM(paid_amount),0) paid, MAX(installment_number) max_number
         FROM installments i JOIN contracts c ON c.id=i.contract_id WHERE c.sale_id=? AND i.status<>'CANCELLED'`,
    ).get(saleId);
    return {
      count: Number(row?.count || 0),
      amount: Number(row?.amount || 0),
      paid: Number(row?.paid || 0),
      maxNumber: Number(row?.max_number || 0),
    };
  }

  function baseVars({ sale, customer, vehicle, guarantor }, today) {
    const owner = resolveOwner(sale, vehicle);
    const totals = installmentTotals(sale.id);
    const sellerDue = Math.max(0, Number(sale.seller_due_amount || 0) - Number(sale.seller_paid_amount || 0));
    return {
      showroom: settings.get("showroom.name"),
      currency: settings.get("showroom.currency"),
      customer: customer?.name || "",
      guarantor: guarantor?.name || "",
      owner: owner?.name || "",
      sale: sale.sale_number,
      mode: sale.transaction_mode === "INTERMEDIARY" ? "وسيط" : "مباشر",
      vehicle: vehicleLabel(vehicle),
      installments: totals.count ? String(totals.count) : String(sale.installment_count || 0),
      total_due: fmt(customerOverdueTotal(sale.customer_id, today)),
      seller_due: fmt(sellerDue),
      _owner: owner,
      _guarantor: guarantor,
      _customer: customer,
      _sale: sale,
    };
  }

  // يبني قائمة الرسائل لنوع معيّن. كل عنصر: {kind, role, name, phone, body, path, templateKey}
  function compose({ kind, saleId, installmentId, receiptNumber, origin, today }) {
    const effectiveToday = today || localDateString();
    const cc = settings.get("whatsapp.defaultCountryCode");
    const baseUrl = settings.get("whatsapp.baseUrl") || process.env.SHOWROOM_PUBLIC_URL || origin;
    const link = (path) => buildDocumentLink({ baseUrl, origin, path });
    const out = [];

    const push = (templateKey, role, person, vars, path, extra = {}) => {
      if (!settings.getBool(`msg.${templateKey}`)) return; // النوع معطّل من الواجهة
      const template = settings.get(`template.${templateKey}`);
      const phone = normalizePhone(person?.phone, cc);
      // الرابط يُحسب مرة واحدة ويُمرَّر للقالب وللسجل معًا، حتى لا يخرج {{link}} فارغًا.
      const docLink = link(path);
      const { body, missing } = renderTemplate(template, { ...vars, link: docLink });
      out.push({
        kind,
        role,
        templateKey,
        name: person?.name || "",
        phone: person?.phone || "",
        normalizedPhone: phone || "",
        body,
        vars,
        path,
        link: docLink,
        missing,
        // رقم غير صالح لا يمنع بقية الرسائل، لكنه يُعلَّم ليظهر كتحذير في الواجهة.
        skipReason: phone ? "" : !person?.phone ? "لا يوجد رقم هاتف مسجّل" : `رقم غير صالح: ${person.phone}`,
        ...extra,
      });
    };

    let context;
    if (receiptNumber) {
      const payment = db.prepare(`SELECT p.*, i.id iid, i.installment_number, i.amount inst_amount, i.paid_amount inst_paid,
                                         i.due_date, c.sale_id, c.contract_number
                                    FROM payments p JOIN installments i ON i.id=p.installment_id
                                    JOIN contracts c ON c.id=i.contract_id
                                   WHERE p.receipt_number=?`).get(receiptNumber);
      if (!payment) return { error: `الإيصال ${receiptNumber} غير موجود` };
      context = loadSale(payment.sale_id);
      if (!context) return { error: "البيع المرتبط بالإيصال غير موجود" };
      const vars = {
        ...baseVars(context, effectiveToday),
        receipt: payment.receipt_number,
        amount: fmt(payment.amount),
        method: paymentMethodLabel(payment.payment_method),
        date: payment.payment_date,
        installment: String(payment.installment_number),
        due: payment.due_date,
        remaining: fmt(Math.max(0, Number(payment.inst_amount) - Number(payment.inst_paid))),
      };
      const path = `/api/documents/receipt/${payment.receipt_number}`;
      push("paymentReceipt.customer", "CUSTOMER", vars._customer, vars, path, { receiptNumber });
      push("paymentReceipt.owner", vars._owner.role, vars._owner, vars, path, { receiptNumber });
      return finalize(out, context);
    }

    let installment = null;
    if (installmentId) {
      const row = db.prepare(`SELECT i.*, c.sale_id, c.contract_number FROM installments i
                                JOIN contracts c ON c.id=i.contract_id WHERE i.id=? AND i.status<>'CANCELLED'`).get(installmentId);
      if (!row) return { error: `القسط ${installmentId} غير موجود` };
      installment = row;
      context = loadSale(row.sale_id);
    } else if (saleId) {
      context = loadSale(saleId);
      if (!context) return { error: `البيع ${saleId} غير موجود` };
      // فاتورة التحصيل على مستوى العقد تستخدم أول قسط غير مسدَّد بالكامل.
      installment = db.prepare(`SELECT i.*, c.sale_id, c.contract_number FROM installments i
                                  JOIN contracts c ON c.id=i.contract_id
                                 WHERE c.sale_id=? AND i.status<>'CANCELLED' AND i.paid_amount < i.amount
                                 ORDER BY i.due_date ASC, i.installment_number ASC LIMIT 1`).get(saleId)
        || db.prepare(`SELECT i.*, c.sale_id, c.contract_number FROM installments i
                         JOIN contracts c ON c.id=i.contract_id WHERE c.sale_id=? AND i.status<>'CANCELLED'
                         ORDER BY i.installment_number ASC LIMIT 1`).get(saleId);
    }

    if (!context) return { error: "لا يوجد بيع أو قسط محدد" };
    const { sale, customer, vehicle, guarantor } = context;

    if (sale.status !== "ACTIVE") {
      return { error: `لا يمكن إرسال رسائل للبيع ${sale.sale_number} لأنه ملغى` };
    }
    if (sale.sale_type !== "INSTALLMENT") {
      return { error: `البيع ${sale.sale_number} نقدي وليس بالأقساط، فلا توجد فواتير تحصيل أو تذكيرات` };
    }
    if (!installment) {
      return { error: `لا توجد أقساط مسجّلة على العقد ${sale.sale_number}` };
    }

    const daysOverdue = diffDays(installment.due_date, effectiveToday);
    const remaining = Math.max(0, Number(installment.amount) - Number(installment.paid_amount));
    const schedulePath = `/api/documents/schedule/${sale.id}`;
    const billsPath = `/api/documents/bills/${sale.id}`;

    const vars = {
      ...baseVars(context, effectiveToday),
      installment: String(installment.installment_number),
      due: installment.due_date,
      amount: fmt(installment.amount),
      paid: fmt(installment.paid_amount),
      remaining: fmt(remaining),
      days: String(Math.abs(daysOverdue)),
    };

    if (kind === "COLLECTION_INVOICE") {
      push("collectionInvoice.customer", "CUSTOMER", customer, vars, billsPath, { installmentId: installment.id });
      push("collectionInvoice.owner", vars._owner.role, vars._owner, vars, billsPath, { installmentId: installment.id });
    } else if (kind === "DUE_REMINDER") {
      vars.status_line = daysOverdue > 0
        ? `⚠️ متأخر منذ ${daysOverdue} يوم`
        : daysOverdue === 0
          ? "⏰ مستحق اليوم"
          : `⏳ متبقٍ ${Math.abs(daysOverdue)} يوم على موعد الاستحقاق`;
      push("dueReminder.customer", "CUSTOMER", customer, vars, schedulePath, { installmentId: installment.id, daysOverdue });
    } else if (kind === "OVERDUE_REMINDER") {
      vars.status_line = `⚠️ متأخر منذ ${Math.max(daysOverdue, 0)} يوم`;
      push("overdueReminder.customer", "CUSTOMER", customer, vars, schedulePath, { installmentId: installment.id, daysOverdue });
      const grace = settings.getInt("guarantor.graceDays");
      const guarantorEnabled = settings.getBool("msg.overdueReminder.guarantor");
      if (guarantor && guarantorEnabled && daysOverdue >= grace) {
        push("overdueReminder.guarantor", "GUARANTOR", guarantor, vars, schedulePath, { installmentId: installment.id, daysOverdue });
      } else if (guarantor && guarantorEnabled) {
        // نُسجَّل كـ«مؤجَّل» حتى يظهر للموظف سبب عدم الإرسال للكفيل.
        out.push({
          kind, role: "GUARANTOR", templateKey: "overdueReminder.guarantor", name: guarantor.name,
          phone: guarantor.phone || "", normalizedPhone: normalizePhone(guarantor.phone, cc) || "",
          body: "", path: schedulePath, link: "", missing: [], installmentId: installment.id, daysOverdue,
          skipReason: `لم تمرّ فترة السماح (${grace} يوم) — التأخير الحالي ${Math.max(daysOverdue, 0)} يوم`,
          deferred: true,
        });
      }
    } else if (kind === "GUARANTOR_NOTICE") {
      if (!guarantor) return { error: `لا يوجد كفيل مسجّل على العقد ${sale.sale_number}` };
      vars.status_line = `⚠️ متأخر منذ ${Math.max(daysOverdue, 0)} يوم`;
      push("overdueReminder.guarantor", "GUARANTOR", guarantor, vars, schedulePath, { installmentId: installment.id, daysOverdue });
    } else {
      return { error: `نوع رسالة غير معروف: ${kind}` };
    }

    return finalize(out, context);
  }

  function finalize(messages, context) {
    return {
      messages,
      sale: {
        id: context.sale.id,
        sale_number: context.sale.sale_number,
        transaction_mode: context.sale.transaction_mode,
        customer: context.customer?.name || "",
      },
    };
  }

  function paymentMethodLabel(method) {
    const map = { CASH: "نقدًا", BANK_TRANSFER: "تحويل بنكي", CHEQUE: "شيك", CARD: "بطاقة", NETWORK: "شبكة" };
    return map[String(method || "").toUpperCase()] || method || "";
  }

  return { compose, resolveOwner, customerOverdueTotal, diffDays, vehicleLabel };
}
