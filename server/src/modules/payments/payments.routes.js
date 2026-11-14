import { InputError } from "../../shared/errors.js";
import { asPositiveMoney, asDate, optionalText, positiveId, requireText } from "../../shared/validation.js";

function cents(value) { return Math.round(Number(value || 0) * 100); }
const CLOSED_CONTRACT_MESSAGE = "العقد مغلق؛ لا يمكن تعديل أو عكس أو نقل تحصيل عليه لأن ذلك يغيّر رصيدًا مغلقًا. راجع مدير النظام.";

export function registerPaymentsRoutes(app, { db, audit, syncInstallmentStatus, syncSaleRemaining, nextNumber, localDateString }) {
  app.get("/api/payments", (_req, res) => {
    const rows = db.prepare(`SELECT p.*, i.installment_number, c.contract_number, s.customer_id, cu.name customer_name,
      COALESCE(r.refund_total,0) refund_total,
      CASE WHEN p.status='ACTIVE' THEN MAX(0,p.amount-COALESCE(r.refund_total,0)) ELSE 0 END net_amount
      FROM payments p JOIN installments i ON i.id=p.installment_id JOIN contracts c ON c.id=i.contract_id
      JOIN sales s ON s.id=c.sale_id JOIN customers cu ON cu.id=s.customer_id
      LEFT JOIN (SELECT payment_id,SUM(amount) refund_total FROM payment_refunds GROUP BY payment_id) r ON r.payment_id=p.id
      ORDER BY p.payment_date DESC,p.id DESC`).all();
    res.json(rows);
  });

  app.post("/api/installments/:id/payments", (req, res) => {
    const { amount, payment_method, payment_date, notes } = req.body;
    const installment = db.prepare(`SELECT i.*,c.sale_id,c.closed_at,s.status sale_status FROM installments i
      JOIN contracts c ON c.id=i.contract_id JOIN sales s ON s.id=c.sale_id WHERE i.id=?`).get(req.params.id);
    if (!installment) return res.status(404).json({ error: "القسط غير موجود" });
    if (installment.sale_status !== "ACTIVE" || installment.closed_at) throw new InputError("لا يمكن التحصيل على بيع ملغى أو عقد مغلق", 409);
    if (installment.status === "CANCELLED") throw new InputError("لا يمكن التحصيل على قسط ملغى أو مستبدل", 409);
    let value;
    try { value = asPositiveMoney(amount, "قيمة التحصيل"); } catch (error) { return res.status(400).json({ error: error.message }); }
    const remaining = Number(installment.amount) - Number(installment.paid_amount);
    if (cents(value) > cents(remaining)) return res.status(400).json({ error: "قيمة التحصيل تتجاوز المتبقي من القسط" });
    let receipt, payDate;
    try { payDate = payment_date ? asDate(payment_date, "تاريخ التحصيل") : localDateString(); } catch (error) { return res.status(400).json({ error: error.message }); }
    const tx = db.transaction(() => {
      receipt = nextNumber("receipt", "REC");
      const result = db.prepare(`INSERT INTO payments(installment_id,receipt_number,amount,payment_date,payment_method,notes,status)
        VALUES(?,?,?,?,?,?, 'ACTIVE')`).run(req.params.id, receipt, value, payDate,
          optionalText(payment_method, "طريقة السداد", 100) || "CASH", optionalText(notes, "الملاحظات", 5000));
      db.prepare("UPDATE installments SET paid_amount=ROUND(paid_amount+?,2) WHERE id=?").run(value, req.params.id);
      syncInstallmentStatus(req.params.id);
      syncSaleRemaining(installment.sale_id);
      audit("CREATE", "PAYMENT", result.lastInsertRowid, JSON.stringify({ receipt, amount: value, installment_id: Number(req.params.id) }), req.user?.username || "system");
    });
    tx.immediate();
    res.json({ ok: true, receipt_number: receipt, receipt_url: `/api/documents/receipt/${receipt}` });
  });

  // Correct a mistaken collection. Keep the original receipt and append a reversal reason.
  app.delete("/api/payments/:id", (req, res) => {
    const reason = requireText(req.body?.reason, "سبب عكس التحصيل");
    const payment = db.prepare(`SELECT p.*,i.installment_number,i.paid_amount,c.sale_id,c.closed_at,s.status sale_status
      FROM payments p JOIN installments i ON i.id=p.installment_id JOIN contracts c ON c.id=i.contract_id
      JOIN sales s ON s.id=c.sale_id WHERE p.id=?`).get(req.params.id);
    if (!payment) return res.status(404).json({ error: "التحصيل غير موجود" });
    if (payment.status !== "ACTIVE") return res.status(409).json({ error: "التحصيل معكوس بالفعل" });
    if (payment.closed_at) throw new InputError(CLOSED_CONTRACT_MESSAGE, 409);
    const refunds = Number(db.prepare("SELECT COALESCE(SUM(amount),0) n FROM payment_refunds WHERE payment_id=?").get(payment.id).n || 0);
    if (refunds > 0) return res.status(409).json({ error: "تم رد جزء من هذا التحصيل بالفعل؛ لا يمكن عكس الإيصال بالكامل. سجّل تسوية محاسبية معتمدة." });
    const tx = db.transaction(() => {
      const update = db.prepare("UPDATE payments SET status='REVERSED',reversed_at=CURRENT_TIMESTAMP,reversal_reason=? WHERE id=? AND status='ACTIVE'").run(reason, payment.id);
      if (!update.changes) throw new InputError("تم تغيير حالة التحصيل بواسطة عملية أخرى؛ حدّث الشاشة وحاول مجددًا", 409);
      db.prepare("UPDATE installments SET paid_amount=MAX(0,ROUND(paid_amount-?,2)) WHERE id=?").run(payment.amount, payment.installment_id);
      syncInstallmentStatus(payment.installment_id);
      syncSaleRemaining(payment.sale_id);
      audit("REVERSE", "PAYMENT", payment.id, JSON.stringify({ receipt: payment.receipt_number, amount: payment.amount, reason, installment_id: payment.installment_id }), req.user?.username || "system");
    });
    tx.immediate();
    res.json({ ok: true, status: "REVERSED", receipt_number: payment.receipt_number, message: "تم عكس القيد مع الاحتفاظ بالإيصال الأصلي. لم يتم تسجيل رد أموال." });
  });

  // Editing an active receipt remains supported, but the before/after values are immutable in the audit trail.
  app.put("/api/payments/:id", (req, res) => {
    let value;
    try { value = asPositiveMoney(req.body.amount, "قيمة التحصيل"); } catch (error) { return res.status(400).json({ error: error.message }); }
    const payment = db.prepare(`SELECT p.*,i.amount installment_amount,i.paid_amount,i.id installment_id,c.sale_id,c.closed_at,s.status sale_status
      FROM payments p JOIN installments i ON i.id=p.installment_id JOIN contracts c ON c.id=i.contract_id
      JOIN sales s ON s.id=c.sale_id WHERE p.id=?`).get(req.params.id);
    if (!payment) return res.status(404).json({ error: "التحصيل غير موجود" });
    if (payment.status !== "ACTIVE") throw new InputError("لا يمكن تعديل تحصيل معكوس؛ احتفظ به وأدخل تحصيلًا صحيحًا جديدًا", 409);
    if (payment.closed_at) throw new InputError(CLOSED_CONTRACT_MESSAGE, 409);
    if (payment.sale_status !== "ACTIVE") throw new InputError("لا يمكن تعديل تحصيل على بيع ملغى", 409);
    const refund = Number(db.prepare("SELECT COALESCE(SUM(amount),0) n FROM payment_refunds WHERE payment_id=?").get(payment.id).n || 0);
    if (refund > 0) throw new InputError("لا يمكن تعديل إيصال تم رد جزء منه؛ استخدم تسوية مستقلة", 409);
    const newPaid = Math.round((Number(payment.paid_amount) - Number(payment.amount) + value) * 100) / 100;
    if (cents(newPaid) > cents(Number(payment.installment_amount))) return res.status(400).json({ error: "القيمة الجديدة تتجاوز إجمالي القسط" });
    let paymentDate;
    try { paymentDate = req.body.payment_date ? asDate(req.body.payment_date, "تاريخ التحصيل") : payment.payment_date; } catch (error) { return res.status(400).json({ error: error.message }); }
    const next = { amount: value, payment_date: paymentDate, payment_method: req.body.payment_method === undefined ? payment.payment_method : optionalText(req.body.payment_method, "طريقة السداد", 100), notes: req.body.notes === undefined ? payment.notes : optionalText(req.body.notes, "الملاحظات", 5000) };
    const previous = { amount: payment.amount, payment_date: payment.payment_date, payment_method: payment.payment_method, notes: payment.notes };
    const tx = db.transaction(() => {
      db.prepare("UPDATE payments SET amount=?,payment_date=?,payment_method=?,notes=? WHERE id=?").run(next.amount, next.payment_date, next.payment_method, next.notes, payment.id);
      db.prepare("UPDATE installments SET paid_amount=? WHERE id=?").run(newPaid, payment.installment_id);
      syncInstallmentStatus(payment.installment_id);
      syncSaleRemaining(payment.sale_id);
      audit("UPDATE", "PAYMENT", payment.id, JSON.stringify({ receipt: payment.receipt_number, before: previous, after: next }), req.user?.username || "system");
    });
    tx.immediate();
    res.json({ ok: true });
  });

  // Move a genuine payment to the correct installment. This is a reversal + a new allocation, not a refund.
  app.post("/api/payments/:id/transfer", (req, res) => {
    const reason = requireText(req.body.reason, "سبب نقل التحصيل");
    const targetId = positiveId(req.body.target_installment_id, "القسط الجديد");
    const source = db.prepare(`SELECT p.*,i.id installment_id,i.paid_amount,c.sale_id source_sale_id,c.closed_at source_closed_at,s.status sale_status,s.customer_id source_customer_id
      FROM payments p JOIN installments i ON i.id=p.installment_id JOIN contracts c ON c.id=i.contract_id
      JOIN sales s ON s.id=c.sale_id WHERE p.id=?`).get(req.params.id);
    if (!source) return res.status(404).json({ error: "التحصيل الأصلي غير موجود" });
    if (source.status !== "ACTIVE") throw new InputError("التحصيل الأصلي معكوس بالفعل", 409);
    if (source.source_closed_at) throw new InputError(CLOSED_CONTRACT_MESSAGE, 409);
    if (source.sale_status !== "ACTIVE") throw new InputError("لا يمكن نقل تحصيل من بيع ملغى", 409);
    if (db.prepare("SELECT 1 FROM payment_refunds WHERE payment_id=?").get(source.id)) throw new InputError("لا يمكن نقل تحصيل تم رد جزء منه", 409);
    const target = db.prepare(`SELECT i.*,ct.sale_id,s.status sale_status,ct.closed_at,s.customer_id target_customer_id FROM installments i
      JOIN contracts ct ON ct.id=i.contract_id JOIN sales s ON s.id=ct.sale_id WHERE i.id=?`).get(targetId);
    if (!target) return res.status(404).json({ error: "القسط المستهدف غير موجود" });
    if (target.sale_status !== "ACTIVE" || target.closed_at || target.status === "CANCELLED") throw new InputError("القسط المستهدف غير نشط أو عقده مغلق", 409);
    if (Number(target.target_customer_id) !== Number(source.source_customer_id)) throw new InputError("لا يمكن نقل تحصيل بين مشترين مختلفين؛ استخدم إيصالًا غير موزع وتسوية معتمدة", 409);
    if (Number(target.id) === Number(source.installment_id)) throw new InputError("اختر قسطًا مختلفًا لنقل التحصيل إليه", 409);
    const targetRemaining = Number(target.amount) - Number(target.paid_amount);
    if (cents(source.amount) > cents(targetRemaining)) throw new InputError("المبلغ أكبر من المتبقي في القسط المستهدف؛ استخدم رصيدًا غير موزع أو قسّم التوزيع", 409);
    let newReceipt;
    const tx = db.transaction(() => {
      db.prepare("UPDATE payments SET status='REVERSED',reversed_at=CURRENT_TIMESTAMP,reversal_reason=? WHERE id=?").run(`نقل إلى القسط ${target.installment_number} — ${reason}`, source.id);
      db.prepare("UPDATE installments SET paid_amount=MAX(0,ROUND(paid_amount-?,2)) WHERE id=?").run(source.amount, source.installment_id);
      newReceipt = nextNumber("receipt", "REC");
      const created = db.prepare(`INSERT INTO payments(installment_id,receipt_number,amount,payment_date,payment_method,notes,status)
        VALUES(?,?,?,?,?,?, 'ACTIVE')`).run(targetId, newReceipt, source.amount, source.payment_date, source.payment_method,
        `نقل من الإيصال ${source.receipt_number}. السبب: ${reason}`);
      db.prepare("UPDATE payments SET replaced_by_payment_id=? WHERE id=?").run(created.lastInsertRowid, source.id);
      const targetUpdate = db.prepare("UPDATE installments SET paid_amount=ROUND(paid_amount+?,2) WHERE id=? AND status<>'CANCELLED' AND ROUND(amount-paid_amount,2)>=ROUND(?,2)").run(source.amount, targetId, source.amount);
      if (!targetUpdate.changes) throw new InputError("تغير المتبقي في القسط المستهدف؛ لم يتم نقل التحصيل", 409);
      syncInstallmentStatus(source.installment_id); syncInstallmentStatus(targetId);
      syncSaleRemaining(source.source_sale_id); syncSaleRemaining(target.sale_id);
      audit("TRANSFER", "PAYMENT", source.id, JSON.stringify({ from_receipt: source.receipt_number, to_receipt: newReceipt, from_installment: source.installment_id, to_installment: targetId, amount: source.amount, reason }), req.user?.username || "system");
    });
    tx.immediate();
    res.json({ ok: true, source_receipt: source.receipt_number, receipt_number: newReceipt, receipt_url: `/api/documents/receipt/${newReceipt}` });
  });

  // This endpoint records a real refund only when the operator explicitly confirms it.
  app.post("/api/payments/:id/refunds", (req, res) => {
    if (req.body.confirmed !== true) throw new InputError("يجب تأكيد أن رد المبلغ تم فعليًا قبل تسجيله", 400);
    const reason = requireText(req.body.reason, "سبب رد المبلغ");
    const payment = db.prepare(`SELECT p.*,i.id installment_id,i.paid_amount,c.sale_id FROM payments p
      JOIN installments i ON i.id=p.installment_id JOIN contracts c ON c.id=i.contract_id WHERE p.id=?`).get(req.params.id);
    if (!payment || payment.status !== "ACTIVE") return res.status(404).json({ error: "التحصيل الفعال غير موجود" });
    let amount, date;
    try { amount = asPositiveMoney(req.body.amount, "مبلغ الرد"); date = req.body.refund_date ? asDate(req.body.refund_date, "تاريخ الرد") : localDateString(); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    const previousRefund = Number(db.prepare("SELECT COALESCE(SUM(amount),0) n FROM payment_refunds WHERE payment_id=?").get(payment.id).n || 0);
    if (cents(previousRefund + amount) > cents(payment.amount)) throw new InputError("إجمالي المبالغ المردودة لا يمكن أن يتجاوز التحصيل الأصلي", 409);
    const tx = db.transaction(() => {
      const current = db.prepare("SELECT status,amount FROM payments WHERE id=?").get(payment.id);
      if (!current || current.status !== "ACTIVE") throw new InputError("تغيّرت حالة التحصيل؛ حدّث الشاشة قبل تسجيل الرد", 409);
      const priorNow = Number(db.prepare("SELECT COALESCE(SUM(amount),0) n FROM payment_refunds WHERE payment_id=?").get(payment.id).n || 0);
      if (cents(priorNow + amount) > cents(current.amount)) throw new InputError("إجمالي المبالغ المردودة لا يمكن أن يتجاوز التحصيل الأصلي", 409);
      const refundNumber = nextNumber("refund", "RF");
      const result = db.prepare(`INSERT INTO payment_refunds(payment_id,refund_number,amount,refund_date,payment_method,reason,confirmed)
        VALUES(?,?,?,?,?,?,1)`).run(payment.id, refundNumber, amount, date,
        optionalText(req.body.payment_method, "طريقة الرد", 100) || "CASH", reason);
      db.prepare("UPDATE installments SET paid_amount=MAX(0,ROUND(paid_amount-?,2)) WHERE id=?").run(amount, payment.installment_id);
      syncInstallmentStatus(payment.installment_id); syncSaleRemaining(payment.sale_id);
      audit("REFUND", "PAYMENT", payment.id, JSON.stringify({ receipt: payment.receipt_number, refund_number: refundNumber, amount, date, reason, confirmed: true }), req.user?.username || "system");
      return result.lastInsertRowid;
    });
    const refundId = tx.immediate();
    res.json({ ok: true, id: refundId, message: "تم تسجيل رد مالي مؤكد حسب إقرار المستخدم" });
  });
}
