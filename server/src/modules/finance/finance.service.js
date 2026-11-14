import { calculateInstallmentPlan } from "./installment.calculator.js";

export function createFinancialServices(db, { localDateString } = {}) {
  function nextNumber(name, prefix) {
    const tx = db.transaction(() => {
      const row = db.prepare("SELECT value FROM sequences WHERE name=?").get(name);
      const value = (row?.value || 0) + 1;
      db.prepare("INSERT INTO sequences(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value").run(name, value);
      return (name === "bill" || name === "note") ? `${prefix}-${value}` : `${prefix}-${String(value).padStart(6, "0")}`;
    });
    return tx();
  }

  function statusFromInstallment(row, today) {
    const effectiveToday = today || (localDateString ? localDateString() : new Date().toLocaleDateString("en-CA"));
    if (Number(row.paid_amount) >= Number(row.amount)) return "PAID";
    if (Number(row.paid_amount) > 0) return "PARTIALLY_PAID";
    return row.due_date < effectiveToday ? "OVERDUE" : row.due_date === effectiveToday ? "DUE" : "UPCOMING";
  }

  function syncInstallmentStatus(id) {
    const row = db.prepare("SELECT amount,paid_amount,status FROM installments WHERE id=?").get(id);
    if (!row || row.status === "CANCELLED") return;
    const status = Number(row.paid_amount) >= Number(row.amount) ? "PAID" : Number(row.paid_amount) > 0 ? "PARTIALLY_PAID" : "UPCOMING";
    db.prepare("UPDATE installments SET status=? WHERE id=?").run(status, id);
    db.prepare(`UPDATE bills SET status=CASE WHEN (SELECT paid_amount FROM installments WHERE id=bills.installment_id) >= amount THEN 'PAID' WHEN (SELECT paid_amount FROM installments WHERE id=bills.installment_id) > 0 THEN 'PARTIAL' ELSE 'OPEN' END WHERE installment_id=?`).run(id);
    if (Number(row.paid_amount) >= Number(row.amount)) {
      db.prepare("UPDATE message_log SET status='CANCELLED_PAID',error=COALESCE(error,'تم إيقاف التذكير لأن القسط سُدد') WHERE entity_type='INSTALLMENT' AND entity_id=? AND status IN ('QUEUED','SCHEDULED','PLANNED')").run(id);
    }
  }

  function syncSaleRemaining(saleId) {
    const sale = db.prepare("SELECT id,sale_type,sale_price,down_payment FROM sales WHERE id=?").get(saleId);
    if (!sale) return 0;
    let remaining = Math.max(0, Number(sale.sale_price || 0) - Number(sale.down_payment || 0));
    if (sale.sale_type === "INSTALLMENT") {
      const row = db.prepare(`SELECT COALESCE(SUM(amount),0) total, COALESCE(SUM(paid_amount),0) paid FROM installments i JOIN contracts c ON c.id=i.contract_id WHERE c.sale_id=? AND i.status<>'CANCELLED'`).get(saleId);
      remaining = Math.max(0, Number(row.total || 0) - Number(row.paid || 0));
    }
    db.prepare("UPDATE sales SET remaining_amount=? WHERE id=?").run(Number(remaining.toFixed(2)), saleId);
    return remaining;
  }

  function syncSellerPaid(saleId) {
    const sale = db.prepare("SELECT id,transaction_mode,seller_due_amount FROM sales WHERE id=?").get(saleId);
    if (!sale || sale.transaction_mode !== "INTERMEDIARY") return 0;
    const paid = Number(db.prepare("SELECT COALESCE(SUM(amount),0) amount FROM seller_payments WHERE sale_id=? AND status='ACTIVE'").get(saleId).amount || 0);
    const capped = Math.min(paid, Number(sale.seller_due_amount || 0));
    db.prepare("UPDATE sales SET seller_paid_amount=? WHERE id=?").run(Number(capped.toFixed(2)), saleId);
    return capped;
  }

  function audit(action, entityType, entityId, details = "", actor = "system") {
    // An audit insert is part of the business transaction, not best-effort logging.
    // If it fails, the surrounding transaction must fail rather than commit an untraceable change.
    db.prepare("INSERT INTO audit_log(action,entity_type,entity_id,details,actor) VALUES(?,?,?,?,?)")
      .run(action, entityType, entityId || null, details, actor || "system");
  }

  return { nextNumber, statusFromInstallment, syncInstallmentStatus, syncSaleRemaining, syncSellerPaid, audit, calculateInstallmentPlan };
}
