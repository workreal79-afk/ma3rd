import { InputError } from "../../shared/errors.js";
import { asDate, asPositiveMoney, optionalText, positiveId, requireText } from "../../shared/validation.js";
import { billSerialNumber } from "../../utils/format.js";

const roundCents = (value) => Math.round(Number(value || 0) * 100);
const PEOPLE = {
  customers: { table: "customers", label: "المشتري", refs: "SELECT COUNT(*) n FROM sales WHERE customer_id=?" },
  guarantors: { table: "guarantors", label: "الكفيل", refs: "SELECT COUNT(*) n FROM sales WHERE guarantor_id=?" },
  sellers: { table: "sellers", label: "البائع/مالك السيارة", refs: "SELECT (SELECT COUNT(*) FROM sales WHERE seller_id=? OR broker_seller_id=?) + (SELECT COUNT(*) FROM vehicles WHERE owner_seller_id=?) n" },
};

export function registerLifecycleRoutes(app, ctx) {
  const { db, audit, syncInstallmentStatus, syncSaleRemaining, nextNumber, localDateString } = ctx;
  const actor = req => req.user?.username || "system";
  const requireAdmin = req => { if (req.user?.role !== "ADMIN") throw new InputError("الحذف النهائي الشامل متاح للمدير فقط", 403); };
  const requirePermanentConfirmation = req => { if (req.body?.confirmation !== "حذف نهائي") throw new InputError("اكتب «حذف نهائي» في خانة التأكيد لإتمام العملية", 400); };

  // يمسح بيانات العملية التابعة فقط وبترتيب يحترم مفاتيح SQLite الأجنبية.
  // لا يمسح ملف المشتري أو السيارة أو الكفيل المشترك تلقائيًا؛ فقد يستخدمها سجل آخر.
  const permanentlyDeleteSale = (saleId, req) => {
    const sale = db.prepare("SELECT * FROM sales WHERE id=?").get(saleId);
    if (!sale) throw new InputError("المبايعة غير موجودة", 404);
    if (sale.status !== "CANCELLED") throw new InputError("يجب إلغاء المبايعة أولًا قبل حذفها نهائيًا", 409);
    const contract = db.prepare("SELECT id FROM contracts WHERE sale_id=?").get(sale.id);
    const contractId = contract?.id ?? null;
    const installmentIds = contractId ? db.prepare("SELECT id FROM installments WHERE contract_id=?").all(contractId).map(x => x.id) : [];
    const paymentIds = installmentIds.length ? db.prepare(`SELECT id FROM payments WHERE installment_id IN (${installmentIds.map(()=>'?').join(',')})`).all(...installmentIds).map(x=>x.id) : [];
    const noteIds = contractId ? db.prepare("SELECT id FROM promissory_notes WHERE contract_id=?").all(contractId).map(x=>x.id) : [];
    const billIds = contractId ? db.prepare("SELECT id FROM bills WHERE contract_id=?").all(contractId).map(x=>x.id) : [];
    const sellerPaymentIds = db.prepare("SELECT id FROM seller_payments WHERE sale_id=?").all(sale.id).map(x=>x.id);
    const brokerPaymentIds = db.prepare("SELECT id FROM broker_commission_payments WHERE sale_id=?").all(sale.id).map(x=>x.id);
    const counts = { payments:paymentIds.length, installments:installmentIds.length, notes:noteIds.length, bills:billIds.length, sellerPayments:sellerPaymentIds.length, brokerPayments:brokerPaymentIds.length };
    if (paymentIds.length) db.prepare(`DELETE FROM payment_refunds WHERE payment_id IN (${paymentIds.map(()=>'?').join(',')})`).run(...paymentIds);
    if (installmentIds.length) {
      db.prepare(`DELETE FROM payments WHERE installment_id IN (${installmentIds.map(()=>'?').join(',')})`).run(...installmentIds);
      db.prepare(`DELETE FROM message_log WHERE entity_type='INSTALLMENT' AND entity_id IN (${installmentIds.map(()=>'?').join(',')})`).run(...installmentIds);
    }
    db.prepare("DELETE FROM seller_payments WHERE sale_id=?").run(sale.id);
    db.prepare("DELETE FROM broker_commission_payments WHERE sale_id=?").run(sale.id);
    if (contractId) {
      db.prepare("DELETE FROM bills WHERE contract_id=?").run(contractId);
      db.prepare("DELETE FROM promissory_notes WHERE contract_id=?").run(contractId);
      db.prepare("DELETE FROM installments WHERE contract_id=?").run(contractId);
      db.prepare("DELETE FROM contracts WHERE id=?").run(contractId);
      db.prepare("DELETE FROM message_log WHERE entity_type='CONTRACT' AND entity_id=?").run(contractId);
    }
    db.prepare("DELETE FROM sale_vehicle_replacements WHERE sale_id=?").run(sale.id);
    db.prepare("DELETE FROM sale_correction_history WHERE sale_id=?").run(sale.id);
    db.prepare("DELETE FROM message_log WHERE entity_type='SALE' AND entity_id=?").run(sale.id);
    db.prepare("DELETE FROM audit_log WHERE entity_type='SALE' AND entity_id=?").run(sale.id);
    if (contractId) db.prepare("DELETE FROM audit_log WHERE entity_type='CONTRACT' AND entity_id=?").run(contractId);
    if (installmentIds.length) db.prepare(`DELETE FROM audit_log WHERE entity_type='INSTALLMENT' AND entity_id IN (${installmentIds.map(()=>'?').join(',')})`).run(...installmentIds);
    if (paymentIds.length) db.prepare(`DELETE FROM audit_log WHERE entity_type='PAYMENT' AND entity_id IN (${paymentIds.map(()=>'?').join(',')})`).run(...paymentIds);
    if (noteIds.length) db.prepare(`DELETE FROM audit_log WHERE entity_type IN ('NOTE','PROMISSORY_NOTE') AND entity_id IN (${noteIds.map(()=>'?').join(',')})`).run(...noteIds);
    if (billIds.length) db.prepare(`DELETE FROM audit_log WHERE entity_type IN ('BILL','PROMISSORY_BILL') AND entity_id IN (${billIds.map(()=>'?').join(',')})`).run(...billIds);
    if (sellerPaymentIds.length) db.prepare(`DELETE FROM audit_log WHERE entity_type='SELLER_PAYMENT' AND entity_id IN (${sellerPaymentIds.map(()=>'?').join(',')})`).run(...sellerPaymentIds);
    if (brokerPaymentIds.length) db.prepare(`DELETE FROM audit_log WHERE entity_type IN ('BROKER_PAYMENT','BROKER_COMMISSION_PAYMENT') AND entity_id IN (${brokerPaymentIds.map(()=>'?').join(',')})`).run(...brokerPaymentIds);
    db.prepare("DELETE FROM sales WHERE id=?").run(sale.id);
    // لا نترك السيارة بحالة مباعة إذا لم يعد لها بيع نشط.
    db.prepare("UPDATE vehicles SET status=CASE WHEN archived_at IS NULL THEN 'IN_STOCK' ELSE status END WHERE id=? AND NOT EXISTS(SELECT 1 FROM sales WHERE vehicle_id=? AND status='ACTIVE')").run(sale.vehicle_id, sale.vehicle_id);
    audit("PERMANENT_DELETE", "SALE", sale.id, JSON.stringify({sale_number:sale.sale_number,customer_id:sale.customer_id,vehicle_id:sale.vehicle_id,contract_id:contractId,deleted:counts}), actor(req));
    return { sale_id:sale.id, sale_number:sale.sale_number, deleted:counts };
  };

  // Lifecycle of people: soft-delete, restore, and conservative merge.
  for (const [route, cfg] of Object.entries(PEOPLE)) {
    app.delete(`/api/${route}/:id`, (req, res) => {
      const record = db.prepare(`SELECT * FROM ${cfg.table} WHERE id=?`).get(req.params.id);
      if (!record) return res.status(404).json({ error: `${cfg.label} غير موجود` });
      if (record.archived_at) return res.json({ ok: true, archived: true, alreadyArchived: true });
      const reason = requireText(req.body?.reason, `سبب أرشفة ${cfg.label}`);
      db.prepare(`UPDATE ${cfg.table} SET archived_at=CURRENT_TIMESTAMP,archive_reason=? WHERE id=?`).run(reason, record.id);
      audit("ARCHIVE", route.toUpperCase().replace(/S$/, ""), record.id, JSON.stringify({ name: record.name, reason }), actor(req));
      res.json({ ok: true, archived: true, message: "تمت الأرشفة مع الاحتفاظ بالعقود والسجلات التاريخية" });
    });
    // الحذف النهائي المتسلسل للسجلات المؤرشفة. كل المبيعات التابعة يجب أن تكون ملغاة أولًا.
    app.delete(`/api/${route}/:id/permanent`, (req, res) => {
      requireAdmin(req); requirePermanentConfirmation(req);
      const record = db.prepare(`SELECT * FROM ${cfg.table} WHERE id=?`).get(req.params.id);
      if (!record) return res.status(404).json({ error: `${cfg.label} غير موجود` });
      if (!record.archived_at) throw new InputError("يجب أرشفة السجل أولًا قبل الحذف النهائي", 409);
      const tx = db.transaction(() => {
        let deletedSales = [];
        if (route === "customers") {
          const sales = db.prepare("SELECT id,status FROM sales WHERE customer_id=? ORDER BY id").all(record.id);
          if (sales.some(x => x.status !== "CANCELLED")) throw new InputError("للمشتري مبايعات نشطة. ألغِ كل مبايعاته أولًا ثم أعد الحذف النهائي", 409);
          for (const sale of sales) deletedSales.push(permanentlyDeleteSale(sale.id, req));
          const unallocatedIds = db.prepare("SELECT id FROM unallocated_receipts WHERE customer_id=?").all(record.id).map(x=>x.id);
          if (unallocatedIds.length) db.prepare(`DELETE FROM audit_log WHERE entity_type IN ('UNALLOCATED_RECEIPT','RECEIPT') AND entity_id IN (${unallocatedIds.map(()=>'?').join(',')})`).run(...unallocatedIds);
          db.prepare("DELETE FROM unallocated_receipts WHERE customer_id=?").run(record.id);
        } else if (route === "sellers") {
          const sales = db.prepare(`SELECT DISTINCT s.id,s.status FROM sales s LEFT JOIN vehicles v ON v.id=s.vehicle_id WHERE s.seller_id=? OR s.broker_seller_id=? OR v.owner_seller_id=? ORDER BY s.id`).all(record.id,record.id,record.id);
          if (sales.some(x => x.status !== "CANCELLED")) throw new InputError("للبائع مبايعات نشطة. ألغِ المبايعات المرتبطة به أولًا ثم أعد الحذف النهائي", 409);
          for (const sale of sales) deletedSales.push(permanentlyDeleteSale(sale.id, req));
          db.prepare("UPDATE vehicles SET owner_seller_id=NULL WHERE owner_seller_id=?").run(record.id);
        } else if (route === "guarantors") {
          // حذف ما يخص الكفيل فقط، مع الحفاظ على مبايعة المشتري ومدفوعاته.
          const contractIds = db.prepare("SELECT c.id FROM contracts c JOIN sales s ON s.id=c.sale_id WHERE s.guarantor_id=? OR c.guarantor_id=?").all(record.id,record.id).map(x=>x.id);
          if (contractIds.length) {
            const guarantorNoteIds = db.prepare(`SELECT id FROM promissory_notes WHERE party_type='GUARANTOR' AND contract_id IN (${contractIds.map(()=>'?').join(',')})`).all(...contractIds).map(x=>x.id);
            if (guarantorNoteIds.length) {
              db.prepare(`DELETE FROM audit_log WHERE entity_type IN ('NOTE','PROMISSORY_NOTE') AND entity_id IN (${guarantorNoteIds.map(()=>'?').join(',')})`).run(...guarantorNoteIds);
              db.prepare(`DELETE FROM promissory_notes WHERE id IN (${guarantorNoteIds.map(()=>'?').join(',')})`).run(...guarantorNoteIds);
            }
          }
          db.prepare("UPDATE sales SET guarantor_id=NULL WHERE guarantor_id=?").run(record.id);
          db.prepare("UPDATE contracts SET guarantor_id=NULL WHERE guarantor_id=?").run(record.id);
        }
        db.prepare("DELETE FROM audit_log WHERE entity_type=? AND entity_id=?").run(route.toUpperCase().replace(/S$/, ""), record.id);
        db.prepare(`DELETE FROM ${cfg.table} WHERE id=?`).run(record.id);
        audit("PERMANENT_DELETE", route.toUpperCase().replace(/S$/, ""), record.id, JSON.stringify({ name: record.name, archived_at: record.archived_at, cascaded_sales: deletedSales.map(x=>x.sale_number), guarantor_documents_removed: route === "guarantors" }), actor(req));
        return deletedSales;
      });
      const deletedSales = tx.immediate();
      res.json({ ok: true, permanentlyDeleted: true, deletedSales: deletedSales.length, details: deletedSales });
    });
    app.post(`/api/${route}/:id/restore`, (req, res) => {
      const record = db.prepare(`SELECT * FROM ${cfg.table} WHERE id=?`).get(req.params.id);
      if (!record) return res.status(404).json({ error: `${cfg.label} غير موجود` });
      if (!record.archived_at) return res.json({ ok: true, restored: false });
      const duplicate = record.national_id ? db.prepare(`SELECT name FROM ${cfg.table} WHERE national_id=? AND id<>? AND archived_at IS NULL`).get(record.national_id, record.id) : null;
      if (duplicate) throw new InputError(`لا يمكن الاستعادة؛ رقم الهوية مستخدم باسم ${duplicate.name}`, 409);
      db.prepare(`UPDATE ${cfg.table} SET archived_at=NULL,archive_reason=NULL,merged_into_id=NULL WHERE id=?`).run(record.id);
      audit("RESTORE", route.toUpperCase().replace(/S$/, ""), record.id, "استعادة ملف مؤرشف", actor(req));
      res.json({ ok: true, restored: true });
    });
    app.post(`/api/${route}/:id/merge`, (req, res) => {
      const sourceId = positiveId(req.params.id, "الملف المصدر"), targetId = positiveId(req.body?.target_id, "الملف الرئيسي");
      if (sourceId === targetId) throw new InputError("اختر ملفين مختلفين للدمج");
      const source = db.prepare(`SELECT * FROM ${cfg.table} WHERE id=? AND archived_at IS NULL`).get(sourceId);
      const target = db.prepare(`SELECT * FROM ${cfg.table} WHERE id=? AND archived_at IS NULL`).get(targetId);
      if (!source || !target) throw new InputError("يجب أن يكون الملفان موجودين وغير مؤرشفين", 404);
      const refs = Number(db.prepare(cfg.refs).get(...(route === "sellers" ? [sourceId, sourceId, sourceId] : [sourceId])).n || 0);
      if (refs) throw new InputError("الملف المصدر مرتبط بعقود أو سيارات؛ أرشفه بدل تغيير هوية المستندات السابقة. الدمج الكامل لهذه الحالة يحتاج مراجعة يدوية.", 409);
      const reason = requireText(req.body?.reason, "سبب الدمج");
      const fields = ["phone", "address", "city", "national_id", "national_id_date", "national_id_source", "notes"];
      const copied = fields.filter(key => (!target[key] || !String(target[key]).trim()) && source[key]);
      db.transaction(() => {
        if (copied.length) db.prepare(`UPDATE ${cfg.table} SET ${copied.map(key => `${key}=?`).join(",")} WHERE id=?`).run(...copied.map(key => source[key]), targetId);
        db.prepare(`UPDATE ${cfg.table} SET archived_at=CURRENT_TIMESTAMP,archive_reason=?,merged_into_id=? WHERE id=?`).run(`دمج في الملف ${targetId}: ${reason}`, targetId, sourceId);
        audit("MERGE", route.toUpperCase().replace(/S$/, ""), sourceId, JSON.stringify({ target_id: targetId, copied_fields: copied, reason }), actor(req));
      }).immediate();
      res.json({ ok: true, source_id: sourceId, target_id: targetId, copied_fields: copied, archived: true });
    });
  }

  app.delete("/api/sales/:id/permanent", (req, res) => {
    requireAdmin(req); requirePermanentConfirmation(req);
    const reason = requireText(req.body?.reason, "سبب الحذف النهائي");
    const sale = db.prepare("SELECT * FROM sales WHERE id=?").get(req.params.id);
    if (!sale) return res.status(404).json({ error: "المبايعة غير موجودة" });
    const result = db.transaction(() => {
      const deleted = permanentlyDeleteSale(sale.id, req);
      audit("PERMANENT_DELETE_REASON", "SALE", sale.id, JSON.stringify({ sale_number: sale.sale_number, reason }), actor(req));
      return deleted;
    }).immediate();
    res.json({ ok: true, permanentlyDeleted: true, ...result, message: "تم حذف المبايعة ومستنداتها وتحصيلاتها التابعة. لم تُحذف ملفات الأطراف أو السيارة المشتركة إذا كانت مستخدمة في سجلات أخرى." });
  });

  // Vehicle archive/restore keeps historical sales and expenses intact.
  app.delete("/api/vehicles/:id", (req, res) => {
    const v = db.prepare("SELECT * FROM vehicles WHERE id=?").get(req.params.id);
    if (!v) return res.status(404).json({ error: "السيارة غير موجودة" });
    if (v.archived_at) return res.json({ ok: true, archived: true, alreadyArchived: true });
    const reason = requireText(req.body?.reason, "سبب أرشفة السيارة");
    if (db.prepare("SELECT 1 FROM sales WHERE vehicle_id=? AND status='ACTIVE' LIMIT 1").get(v.id)) throw new InputError("لا يمكن أرشفة سيارة عليها بيع نشط؛ ألغِ البيع أولًا", 409);
    if (db.prepare("SELECT 1 FROM vehicle_reservations WHERE vehicle_id=? AND status='ACTIVE' LIMIT 1").get(v.id)) throw new InputError("لا يمكن أرشفة سيارة عليها حجز نشط", 409);
    db.prepare("UPDATE vehicles SET archived_at=CURRENT_TIMESTAMP,archive_reason=? WHERE id=?").run(reason, v.id);
    audit("ARCHIVE", "VEHICLE", v.id, JSON.stringify({ plate_number: v.plate_number, reason }), actor(req));
    res.json({ ok: true, archived: true });
  });
  app.delete("/api/vehicles/:id/permanent", (req, res) => {
    requireAdmin(req); requirePermanentConfirmation(req);
    const v = db.prepare("SELECT * FROM vehicles WHERE id=?").get(req.params.id);
    if (!v) return res.status(404).json({ error: "السيارة غير موجودة" });
    if (!v.archived_at) throw new InputError("يجب أرشفة السيارة أولًا قبل الحذف النهائي", 409);
    const tx = db.transaction(() => {
      const sales = db.prepare("SELECT id,status FROM sales WHERE vehicle_id=? ORDER BY id").all(v.id);
      if (sales.some(x => x.status !== "CANCELLED")) throw new InputError("للسيارة مبايعات نشطة. ألغِ كل المبايعات المرتبطة بها أولًا ثم أعد الحذف النهائي", 409);
      const deletedSales = sales.map(x => permanentlyDeleteSale(x.id, req));
      const expenseIds = db.prepare("SELECT id FROM expenses WHERE vehicle_id=?").all(v.id).map(x=>x.id);
      if (expenseIds.length) db.prepare(`DELETE FROM audit_log WHERE entity_type='EXPENSE' AND entity_id IN (${expenseIds.map(()=>'?').join(',')})`).run(...expenseIds);
      db.prepare("DELETE FROM sale_vehicle_replacements WHERE old_vehicle_id=? OR new_vehicle_id=?").run(v.id,v.id);
      db.prepare("DELETE FROM vehicle_reservations WHERE vehicle_id=?").run(v.id);
      db.prepare("DELETE FROM expenses WHERE vehicle_id=?").run(v.id);
      db.prepare("DELETE FROM audit_log WHERE entity_type='VEHICLE' AND entity_id=?").run(v.id);
      db.prepare("DELETE FROM vehicles WHERE id=?").run(v.id);
      audit("PERMANENT_DELETE", "VEHICLE", v.id, JSON.stringify({ plate_number: v.plate_number, vin: v.vin, archived_at: v.archived_at, cascaded_sales: deletedSales.map(x=>x.sale_number) }), actor(req));
      return deletedSales;
    });
    const deletedSales = tx.immediate();
    res.json({ ok: true, permanentlyDeleted: true, deletedSales: deletedSales.length });
  });
  app.post("/api/vehicles/:id/restore", (req, res) => {
    const v = db.prepare("SELECT * FROM vehicles WHERE id=?").get(req.params.id);
    if (!v) return res.status(404).json({ error: "السيارة غير موجودة" });
    if (db.prepare("SELECT 1 FROM sales WHERE vehicle_id=? AND status='ACTIVE' LIMIT 1").get(v.id)) throw new InputError("السيارة مرتبطة ببيع نشط", 409);
    db.prepare("UPDATE vehicles SET archived_at=NULL,archive_reason=NULL WHERE id=?").run(v.id);
    audit("RESTORE", "VEHICLE", v.id, v.plate_number, actor(req));
    res.json({ ok: true, restored: true });
  });

  // Reservations are separate records; a deposit mentioned here is an agreement only, never a cash entry.
  app.get("/api/reservations", (req, res) => {
    db.prepare(`UPDATE vehicle_reservations SET status='EXPIRED',released_at=CURRENT_TIMESTAMP,reason=COALESCE(reason,'انتهت مدة الحجز') WHERE status='ACTIVE' AND expires_at IS NOT NULL AND expires_at<?`).run(localDateString());
    db.prepare(`UPDATE vehicles SET status='IN_STOCK' WHERE status='RESERVED' AND NOT EXISTS(SELECT 1 FROM vehicle_reservations r WHERE r.vehicle_id=vehicles.id AND r.status='ACTIVE') AND NOT EXISTS(SELECT 1 FROM sales s WHERE s.vehicle_id=vehicles.id AND s.status='ACTIVE')`).run();
    res.json(db.prepare(`SELECT r.*,v.plate_number,v.make,v.model,c.name customer_name FROM vehicle_reservations r JOIN vehicles v ON v.id=r.vehicle_id LEFT JOIN customers c ON c.id=r.customer_id WHERE (?=1 OR r.status='ACTIVE') ORDER BY r.id DESC`).all(Number(req.query.all || 0)));
  });
  app.post("/api/vehicles/:id/reservations", (req, res) => {
    const v = db.prepare("SELECT * FROM vehicles WHERE id=? AND archived_at IS NULL").get(req.params.id);
    if (!v) return res.status(404).json({ error: "السيارة غير موجودة أو مؤرشفة" });
    if (v.status !== "IN_STOCK" || db.prepare("SELECT 1 FROM sales WHERE vehicle_id=? AND status='ACTIVE'").get(v.id) || db.prepare("SELECT 1 FROM vehicle_reservations WHERE vehicle_id=? AND status='ACTIVE'").get(v.id)) throw new InputError("السيارة ليست متاحة للحجز", 409);
    const customerId = req.body.customer_id ? positiveId(req.body.customer_id, "المشتري") : null;
    if (customerId && !db.prepare("SELECT 1 FROM customers WHERE id=? AND archived_at IS NULL").get(customerId)) throw new InputError("المشتري غير موجود أو مؤرشف");
    let reservedAt, expiresAt = null;
    try { reservedAt = req.body.reserved_at ? asDate(req.body.reserved_at, "تاريخ الحجز") : localDateString(); expiresAt = req.body.expires_at ? asDate(req.body.expires_at, "انتهاء الحجز") : null; }
    catch (e) { return res.status(400).json({ error: e.message }); }
    if (expiresAt && expiresAt < reservedAt) throw new InputError("انتهاء الحجز لا يمكن أن يسبق بدايته");
    const deposit = req.body.deposit_amount == null || req.body.deposit_amount === "" ? 0 : asPositiveMoney(req.body.deposit_amount, "العربون المتفق عليه");
    const id = db.transaction(() => {
      const r = db.prepare("INSERT INTO vehicle_reservations(vehicle_id,customer_id,reserved_at,expires_at,deposit_amount,status,reason) VALUES(?,?,?,?,?,'ACTIVE',?)").run(v.id, customerId, reservedAt, expiresAt, deposit, optionalText(req.body.reason, "ملاحظات", 2000));
      db.prepare("UPDATE vehicles SET status='RESERVED' WHERE id=?").run(v.id);
      audit("RESERVE", "VEHICLE", v.id, JSON.stringify({ reservation_id: Number(r.lastInsertRowid), customer_id: customerId, expires_at: expiresAt, agreed_deposit: deposit }), actor(req));
      return Number(r.lastInsertRowid);
    }).immediate();
    res.json({ ok: true, id, message: "تم الحجز. قيمة العربون هنا اتفاق فقط وليست تحصيلًا ماليًا مسجلًا." });
  });
  app.post("/api/reservations/:id/release", (req, res) => {
    const r = db.prepare("SELECT * FROM vehicle_reservations WHERE id=?").get(req.params.id);
    if (!r) return res.status(404).json({ error: "الحجز غير موجود" });
    if (r.status !== "ACTIVE") return res.json({ ok: true, alreadyClosed: true });
    const reason = requireText(req.body?.reason, "سبب إلغاء الحجز");
    db.transaction(() => {
      db.prepare("UPDATE vehicle_reservations SET status='CANCELLED',released_at=CURRENT_TIMESTAMP,reason=? WHERE id=?").run(reason, r.id);
      db.prepare("UPDATE vehicles SET status='IN_STOCK' WHERE id=? AND status='RESERVED' AND NOT EXISTS(SELECT 1 FROM sales WHERE vehicle_id=? AND status='ACTIVE')").run(r.vehicle_id, r.vehicle_id);
      audit("RELEASE_RESERVATION", "VEHICLE", r.vehicle_id, JSON.stringify({ reservation_id: r.id, reason }), actor(req));
    }).immediate();
    res.json({ ok: true });
  });

  // I01/I02: replace schedule only for wholly unpaid installments. Existing payments and partial installments remain intact.
  app.put("/api/sales/:id/installment-schedule", (req, res) => {
    const sale = db.prepare("SELECT * FROM sales WHERE id=?").get(req.params.id);
    if (!sale) return res.status(404).json({ error: "البيع غير موجود" });
    if (sale.status !== "ACTIVE" || sale.sale_type !== "INSTALLMENT") throw new InputError("يمكن تعديل جدول عقد تقسيط نشط فقط", 409);
    if (req.body.documents_reviewed !== true) throw new InputError("أكد مراجعة أثر التغيير على الكمبيالات والمستندات", 400);
    const reason = requireText(req.body.reason, "سبب تعديل جدول الأقساط");
    if (!Array.isArray(req.body.schedule) || !req.body.schedule.length || req.body.schedule.length > 240) throw new InputError("جدول الأقساط غير صحيح");
    const contract = db.prepare("SELECT * FROM contracts WHERE sale_id=?").get(sale.id);
    if (!contract || contract.closed_at) throw new InputError("العقد غير موجود أو مغلق", 409);
    const replaceable = db.prepare("SELECT * FROM installments WHERE contract_id=? AND status<>'CANCELLED' AND paid_amount=0 ORDER BY installment_number").all(contract.id);
    if (!replaceable.length) throw new InputError("لا توجد أقساط غير مسددة بالكامل لإعادة جدولتها", 409);
    const oldTotal = replaceable.reduce((sum, row) => sum + Number(row.amount), 0);
    const schedule = req.body.schedule.map((item, i) => ({ amount: asPositiveMoney(item.amount, `مبلغ القسط ${i + 1}`), due_date: asDate(item.due_date, `تاريخ القسط ${i + 1}`) }));
    const newTotal = schedule.reduce((sum, row) => sum + row.amount, 0);
    if (roundCents(oldTotal) !== roundCents(newTotal)) throw new InputError(`إجمالي الجدول الجديد يجب أن يساوي ${oldTotal.toFixed(2)} ريال؛ لم يتغير الرصيد`, 409);
    const before = replaceable.map(({ id, installment_number, due_date, amount }) => ({ id, installment_number, due_date, amount }));
    const tx = db.transaction(() => {
      const start = Number(db.prepare("SELECT COALESCE(MAX(installment_number),0) n FROM installments WHERE contract_id=?").get(contract.id).n || 0);
      const openNotes = db.prepare("SELECT * FROM promissory_notes WHERE contract_id=? AND status='OPEN'").all(contract.id);
      db.prepare("UPDATE message_log SET status='CANCELLED_CHANGE',error=COALESCE(error,'تم إيقاف التذكيرات بسبب إعادة جدولة الأقساط') WHERE entity_type='INSTALLMENT' AND entity_id IN (SELECT i.id FROM installments i JOIN contracts c ON c.id=i.contract_id WHERE c.sale_id=?) AND status IN ('QUEUED','SCHEDULED','PLANNED')").run(sale.id);
      for (const row of replaceable) {
        db.prepare("UPDATE installments SET status='CANCELLED' WHERE id=?").run(row.id);
        db.prepare("UPDATE bills SET status='CANCELLED' WHERE installment_id=?").run(row.id);
      }
      const created = [];
      for (let i = 0; i < schedule.length; i++) {
        const entry = schedule[i], number = start + i + 1;
        const ins = db.prepare("INSERT INTO installments(contract_id,installment_number,due_date,amount,paid_amount,status) VALUES(?,?,?,?,0,'UPCOMING')").run(contract.id, number, entry.due_date, entry.amount);
        const bill = `BILL-${contract.id}-${billSerialNumber(contract.bill_start_serial, number)}`;
        db.prepare("INSERT INTO bills(contract_id,installment_id,bill_number,amount,issue_date,due_date,status) VALUES(?,?,?,?,?,?, 'OPEN')").run(contract.id, ins.lastInsertRowid, bill, entry.amount, localDateString(), entry.due_date);
        created.push({ id: Number(ins.lastInsertRowid), installment_number: number, ...entry });
      }
      const outstanding = Number(db.prepare("SELECT COALESCE(SUM(amount-paid_amount),0) n FROM installments WHERE contract_id=? AND status<>'CANCELLED'").get(contract.id).n || 0);
      const lastDue = db.prepare("SELECT MAX(due_date) d FROM installments WHERE contract_id=? AND status<>'CANCELLED'").get(contract.id).d;
      for (const oldNote of openNotes) {
        db.prepare("UPDATE promissory_notes SET status='REPLACED',voided_at=CURRENT_TIMESTAMP,void_reason=? WHERE id=?").run(`إعادة جدولة: ${reason}`, oldNote.id);
        const number = nextNumber("note", "NOTE");
        const replacement = db.prepare("INSERT INTO promissory_notes(contract_id,note_number,amount,issue_date,due_date,party_type,status) VALUES(?,?,?,?,?,?, 'OPEN')").run(contract.id, number, outstanding, localDateString(), lastDue, oldNote.party_type);
        db.prepare("UPDATE promissory_notes SET replaced_by_id=? WHERE id=?").run(replacement.lastInsertRowid, oldNote.id);
      }
      db.prepare("UPDATE contracts SET installments_count=(SELECT COUNT(*) FROM installments WHERE contract_id=? AND status<>'CANCELLED') WHERE id=?").run(contract.id, contract.id);
      syncSaleRemaining(sale.id);
      audit("RESCHEDULE", "SALE", sale.id, JSON.stringify({ reason, before, after: created, documents_reissued: openNotes.length }), actor(req));
      return created;
    });
    res.json({ ok: true, replaced_count: replaceable.length, schedule: tx.immediate(), message: "تم إنشاء جدول جديد، مع الاحتفاظ بالأقساط والسندات القديمة الملغاة في السجل. اطبع المستندات البديلة وراجعها قبل توقيعها." });
  });

  app.post("/api/sales/:id/settle", (req, res) => {
    const sale = db.prepare("SELECT * FROM sales WHERE id=?").get(req.params.id);
    if (!sale) return res.status(404).json({ error: "البيع غير موجود" });
    if (sale.status !== "ACTIVE" || sale.sale_type !== "INSTALLMENT") throw new InputError("السداد المبكر متاح لعقد تقسيط نشط فقط", 409);
    if (req.body.confirmed !== true) throw new InputError("أكد استلام مبلغ التسوية فعليًا", 400);
    const reason = requireText(req.body.reason, "سبب التسوية");
    let amount, date;
    try { amount = asPositiveMoney(req.body.amount, "مبلغ التسوية"); date = req.body.payment_date ? asDate(req.body.payment_date, "تاريخ التسوية") : localDateString(); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    const contract = db.prepare("SELECT * FROM contracts WHERE sale_id=?").get(sale.id);
    if (contract?.closed_at) throw new InputError("العقد مغلق بالفعل", 409);
    const unpaid = db.prepare("SELECT * FROM installments WHERE contract_id=? AND status<>'CANCELLED' AND amount>paid_amount ORDER BY due_date,installment_number").all(contract.id);
    const outstanding = unpaid.reduce((sum, row) => sum + Number(row.amount) - Number(row.paid_amount), 0);
    if (roundCents(amount) !== roundCents(outstanding)) throw new InputError(`مبلغ السداد يجب أن يساوي الرصيد الحالي ${outstanding.toFixed(2)} ريال؛ الخصومات تحتاج تسوية منفصلة`, 409);
    const receipts = [];
    db.transaction(() => {
      for (const ins of unpaid) {
        const value = Number((Number(ins.amount) - Number(ins.paid_amount)).toFixed(2));
        if (value <= 0) continue;
        const receipt = nextNumber("receipt", "REC");
        const p = db.prepare("INSERT INTO payments(installment_id,receipt_number,amount,payment_date,payment_method,notes,status) VALUES(?,?,?,?,?,?, 'ACTIVE')").run(ins.id, receipt, value, date, optionalText(req.body.payment_method, "طريقة الدفع", 100) || "BANK", `سداد مبكر مؤكد: ${reason}`);
        db.prepare("UPDATE installments SET paid_amount=ROUND(paid_amount+?,2) WHERE id=?").run(value, ins.id);
        syncInstallmentStatus(ins.id); receipts.push({ id: Number(p.lastInsertRowid), receipt_number: receipt, amount: value });
      }
      syncSaleRemaining(sale.id);
      audit("EARLY_SETTLEMENT", "SALE", sale.id, JSON.stringify({ reason, amount, date, receipts }), actor(req));
    }).immediate();
    res.json({ ok: true, amount, receipts, message: "تم تسجيل المبلغ الذي أكدت استلامه وتوزيعه على الأقساط. لم يُطبق أي خصم." });
  });

  app.post("/api/sales/:id/close-contract", (req, res) => {
    const sale = db.prepare("SELECT * FROM sales WHERE id=?").get(req.params.id);
    if (!sale) return res.status(404).json({ error: "البيع غير موجود" });
    if (sale.status !== "ACTIVE") throw new InputError("لا يمكن إغلاق عقد بيع ملغى", 409);
    const c = db.prepare("SELECT * FROM contracts WHERE sale_id=?").get(sale.id);
    if (!c) throw new InputError("العقد غير موجود", 409);
    if (c.closed_at) return res.json({ ok: true, alreadyClosed: true, closed_at: c.closed_at });
    const outstanding = Number(db.prepare("SELECT COALESCE(SUM(MAX(0,amount-paid_amount)),0) n FROM installments WHERE contract_id=? AND status<>'CANCELLED'").get(c.id).n || 0);
    if (outstanding > 0.009) throw new InputError(`لا يمكن إغلاق العقد؛ المتبقي ${outstanding.toFixed(2)} ريال`, 409);
    const reason = requireText(req.body?.reason, "سبب إغلاق العقد");
    db.prepare("UPDATE contracts SET closed_at=CURRENT_TIMESTAMP,close_reason=? WHERE id=?").run(reason, c.id);
    audit("CLOSE", "CONTRACT", c.id, JSON.stringify({ sale_id: sale.id, reason }), actor(req));
    res.json({ ok: true, closed_at: db.prepare("SELECT closed_at FROM contracts WHERE id=?").get(c.id).closed_at });
  });

  // Unallocated receipts are only created after explicit confirmation that cash actually arrived.
  app.get("/api/unallocated-receipts", (_req, res) => res.json(db.prepare("SELECT u.*,c.name customer_name,ROUND(u.amount-u.allocated_amount,2) remaining_amount FROM unallocated_receipts u JOIN customers c ON c.id=u.customer_id ORDER BY u.payment_date DESC,u.id DESC").all()));
  app.post("/api/unallocated-receipts", (req, res) => {
    if (req.body.confirmed !== true) throw new InputError("أكد استلام المبلغ فعليًا قبل التسجيل", 400);
    const customerId = positiveId(req.body.customer_id, "المشتري");
    if (!db.prepare("SELECT 1 FROM customers WHERE id=? AND archived_at IS NULL").get(customerId)) throw new InputError("المشتري غير موجود أو مؤرشف");
    let amount, date;
    try { amount = asPositiveMoney(req.body.amount, "المبلغ المستلم"); date = req.body.payment_date ? asDate(req.body.payment_date, "تاريخ الاستلام") : localDateString(); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    const receipt = nextNumber("unallocated_receipt", "UR");
    const r = db.prepare("INSERT INTO unallocated_receipts(receipt_number,customer_id,amount,payment_date,payment_method,notes) VALUES(?,?,?,?,?,?)").run(receipt, customerId, amount, date, optionalText(req.body.payment_method, "طريقة الدفع", 100) || "CASH", optionalText(req.body.notes, "البيان", 2000));
    audit("CREATE", "UNALLOCATED_RECEIPT", r.lastInsertRowid, JSON.stringify({ receipt, amount, date, confirmed: true }), actor(req));
    res.json(db.prepare("SELECT * FROM unallocated_receipts WHERE id=?").get(r.lastInsertRowid));
  });
  app.put("/api/unallocated-receipts/:id/customer", (req, res) => {
    const receipt = db.prepare("SELECT * FROM unallocated_receipts WHERE id=?").get(req.params.id);
    if (!receipt) return res.status(404).json({ error: "الإيصال غير الموزع غير موجود" });
    if (receipt.status === "CANCELLED" || Number(receipt.allocated_amount || 0) > 0) throw new InputError("لا يمكن تغيير المشتري بعد توزيع أي جزء من الإيصال أو إلغائه؛ حافظ على الإسناد التاريخي", 409);
    const customerId = positiveId(req.body.customer_id, "المشتري الجديد");
    if (!db.prepare("SELECT 1 FROM customers WHERE id=? AND archived_at IS NULL").get(customerId)) throw new InputError("المشتري الجديد غير موجود أو مؤرشف", 409);
    const reason = requireText(req.body.reason, "سبب تصحيح المشتري");
    db.transaction(() => {
      db.prepare("UPDATE unallocated_receipts SET customer_id=? WHERE id=?").run(customerId, receipt.id);
      audit("CORRECT_CUSTOMER", "UNALLOCATED_RECEIPT", receipt.id, JSON.stringify({ receipt: receipt.receipt_number, before_customer_id: receipt.customer_id, after_customer_id: customerId, amount: receipt.amount, reason }), actor(req));
    }).immediate();
    res.json({ ok: true, message: "تم تصحيح إسناد الإيصال غير الموزع؛ لم يتم تسجيل تحصيل جديد أو رد أموال." });
  });
  app.post("/api/unallocated-receipts/:id/cancel", (req, res) => {
    const receipt = db.prepare("SELECT * FROM unallocated_receipts WHERE id=?").get(req.params.id);
    if (!receipt) return res.status(404).json({ error: "الإيصال غير الموزع غير موجود" });
    if (receipt.status === "CANCELLED") return res.json({ ok: true, alreadyCancelled: true });
    if (Number(receipt.allocated_amount || 0) > 0) throw new InputError("تم توزيع جزء من الإيصال؛ لا يمكن إلغاء السجل بالكامل", 409);
    if (req.body.confirmed_not_received !== true) throw new InputError("أكد أن هذا التسجيل لم يقابله مبلغ مستلم فعليًا؛ هذا الإجراء ليس رد أموال", 400);
    const reason = requireText(req.body.reason, "سبب إلغاء تسجيل الإيصال");
    db.prepare("UPDATE unallocated_receipts SET status='CANCELLED',cancelled_at=CURRENT_TIMESTAMP,cancel_reason=? WHERE id=? AND status<>'CANCELLED'").run(reason, receipt.id);
    audit("CANCEL_NOT_RECEIVED", "UNALLOCATED_RECEIPT", receipt.id, JSON.stringify({ receipt: receipt.receipt_number, amount: receipt.amount, reason, confirmed_not_received: true, refund_recorded: false }), actor(req));
    res.json({ ok: true, status: "CANCELLED", message: "تم إلغاء تسجيل مبلغ لم يُستلم؛ لم يُسجل رد مالي." });
  });

  app.post("/api/unallocated-receipts/:id/allocate", (req, res) => {
    const receipt = db.prepare("SELECT * FROM unallocated_receipts WHERE id=?").get(req.params.id);
    if (!receipt || receipt.status === "CANCELLED") return res.status(404).json({ error: "الإيصال غير الموزع غير موجود أو ملغى" });
    const installmentId = positiveId(req.body.installment_id, "القسط");
    const ins = db.prepare("SELECT i.*,c.sale_id,c.closed_at,s.status sale_status,s.customer_id FROM installments i JOIN contracts c ON c.id=i.contract_id JOIN sales s ON s.id=c.sale_id WHERE i.id=?").get(installmentId);
    if (!ins || ins.customer_id !== receipt.customer_id || ins.sale_status !== "ACTIVE" || ins.closed_at || ins.status === "CANCELLED") throw new InputError("القسط غير صالح أو لا يخص هذا المشتري", 409);
    const amount = asPositiveMoney(req.body.amount, "مبلغ التوزيع"), remainingReceipt = Number(receipt.amount)-Number(receipt.allocated_amount), remainingInstallment = Number(ins.amount)-Number(ins.paid_amount);
    if (roundCents(amount)>roundCents(remainingReceipt)||roundCents(amount)>roundCents(remainingInstallment)) throw new InputError("المبلغ أكبر من رصيد الإيصال أو المتبقي من القسط", 409);
    const reason = requireText(req.body.reason, "بيان التوزيع");
    const result = db.transaction(() => {
      const number = nextNumber("receipt", "REC");
      const p = db.prepare("INSERT INTO payments(installment_id,receipt_number,amount,payment_date,payment_method,notes,status) VALUES(?,?,?,?,?,?, 'ACTIVE')").run(ins.id, number, amount, receipt.payment_date, receipt.payment_method, `توزيع من ${receipt.receipt_number}: ${reason}`);
      const allocated = Number((Number(receipt.allocated_amount)+amount).toFixed(2));
      const updateReceipt = db.prepare("UPDATE unallocated_receipts SET allocated_amount=?,status=? WHERE id=? AND status NOT IN ('CANCELLED','ALLOCATED') AND allocated_amount=? AND ROUND(amount-allocated_amount,2)>=ROUND(?,2)").run(allocated, roundCents(allocated)>=roundCents(receipt.amount)?"ALLOCATED":"PARTIAL",receipt.id,receipt.allocated_amount,amount);
      if (!updateReceipt.changes) throw new InputError("تغيّر رصيد الإيصال؛ لم يتم التوزيع. حدّث الشاشة وحاول مرة أخرى", 409);
      const updateInstallment = db.prepare("UPDATE installments SET paid_amount=ROUND(paid_amount+?,2) WHERE id=? AND status<>'CANCELLED' AND ROUND(amount-paid_amount,2)>=ROUND(?,2)").run(amount, ins.id, amount);
      if (!updateInstallment.changes) throw new InputError("تغير المتبقي في القسط؛ لم يتم التوزيع", 409);
      syncInstallmentStatus(ins.id); syncSaleRemaining(ins.sale_id);
      audit("ALLOCATE", "UNALLOCATED_RECEIPT", receipt.id, JSON.stringify({ receipt: receipt.receipt_number, payment: number, installment_id: ins.id, amount, reason }), actor(req));
      return { id: Number(p.lastInsertRowid), receipt_number: number };
    });
    res.json({ ok: true, payment: result.immediate() });
  });

  app.get("/api/sales/:id/promissory-notes", (req, res) => {
    const saleId = positiveId(req.params.id, "رقم البيع");
    const sale = db.prepare("SELECT id,sale_number,status FROM sales WHERE id=?").get(saleId);
    if (!sale) return res.status(404).json({ error: "البيع غير موجود" });
    const notes = db.prepare(`SELECT pn.*,c.contract_number,c.promissory_due_mode,c.promissory_due_date,cu.name customer_name,g.name guarantor_name
      FROM promissory_notes pn JOIN contracts c ON c.id=pn.contract_id
      JOIN sales s ON s.id=c.sale_id JOIN customers cu ON cu.id=s.customer_id
      LEFT JOIN guarantors g ON g.id=s.guarantor_id
      WHERE s.id=? ORDER BY pn.id DESC`).all(saleId);
    res.json({ sale, notes: notes.map(n => ({...n, display_due_date: n.promissory_due_mode === "ON_DEMAND" ? "لدى الاطلاع" : n.promissory_due_mode === "DATE" ? n.promissory_due_date : ""})) });
  });

  app.post("/api/promissory-notes/:id/void", (req, res) => {
    const note = db.prepare("SELECT * FROM promissory_notes WHERE id=?").get(req.params.id);
    if (!note) return res.status(404).json({ error: "السند غير موجود" });
    if (note.status !== "OPEN") throw new InputError("السند ليس مفتوحًا", 409);
    const reason = requireText(req.body?.reason, "سبب إلغاء السند");
    db.prepare("UPDATE promissory_notes SET status='VOIDED',voided_at=CURRENT_TIMESTAMP,void_reason=? WHERE id=?").run(reason,note.id);
    audit("VOID", "PROMISSORY_NOTE", note.id, JSON.stringify({ note_number: note.note_number, reason }), actor(req));
    res.json({ ok: true, status: "VOIDED" });
  });
  app.post("/api/promissory-notes/:id/replace", (req, res) => {
    const note = db.prepare("SELECT * FROM promissory_notes WHERE id=?").get(req.params.id);
    if (!note) return res.status(404).json({ error: "السند الأصلي غير موجود" });
    if (note.status !== "OPEN") throw new InputError("لا يمكن استبدال سند غير مفتوح",409);
    const reason = requireText(req.body?.reason,"سبب استبدال السند");
    let amount,dueDate; try { amount=asPositiveMoney(req.body.amount ?? note.amount,"مبلغ السند البديل"); dueDate=req.body.due_date?asDate(req.body.due_date,"تاريخ الاستحقاق"):note.due_date; } catch(e) { return res.status(400).json({error:e.message}); }
    const result = db.transaction(()=>{
      const serial=nextNumber("note","NOTE");
      const created=db.prepare("INSERT INTO promissory_notes(contract_id,note_number,amount,issue_date,due_date,party_type,status) VALUES(?,?,?,?,?,?, 'OPEN')").run(note.contract_id,serial,amount,localDateString(),dueDate,note.party_type);
      db.prepare("UPDATE promissory_notes SET status='REPLACED',voided_at=CURRENT_TIMESTAMP,void_reason=?,replaced_by_id=? WHERE id=?").run(reason,created.lastInsertRowid,note.id);
      audit("REPLACE","PROMISSORY_NOTE",note.id,JSON.stringify({old:note.note_number,new:serial,amount,dueDate,reason}),actor(req));
      return {id:Number(created.lastInsertRowid),note_number:serial};
    });
    res.json({ok:true,replacement:result.immediate()});
  });

  // عمولات الوسيط القديمة محفوظة في قاعدة البيانات لأغراض الأرشيف فقط؛ لا توجد واجهات تشغيلية جديدة لها.

  // V03: controlled correction. The caller must review documents; financial history is never rewritten.
  app.put("/api/sales/:id/correct", (req, res) => {
    const sale = db.prepare("SELECT * FROM sales WHERE id=?").get(req.params.id);
    if (!sale) return res.status(404).json({ error: "البيع غير موجود" });
    if (sale.status !== "ACTIVE") throw new InputError("لا يمكن تصحيح بيع ملغى؛ استعد البيع أولًا", 409);
    if (req.body.documents_reviewed !== true) throw new InputError("أكد مراجعة العقد والكمبيالات والمستندات التي يلزم إعادة إصدارها", 400);
    const reason = requireText(req.body.reason, "سبب تصحيح البيع");
    const before = { customer_id: sale.customer_id, seller_id: sale.seller_id, guarantor_id: sale.guarantor_id, sale_price: sale.sale_price, down_payment: sale.down_payment, remaining_amount: sale.remaining_amount };
    const next = { ...before };
    const has = (key) => Object.prototype.hasOwnProperty.call(req.body, key);
    if (has("customer_id")) {
      next.customer_id = positiveId(req.body.customer_id, "المشتري");
      if (!db.prepare("SELECT 1 FROM customers WHERE id=? AND archived_at IS NULL").get(next.customer_id)) throw new InputError("المشتري غير موجود أو مؤرشف", 409);
    }
    if (has("guarantor_id")) {
      next.guarantor_id = req.body.guarantor_id == null || req.body.guarantor_id === "" ? null : positiveId(req.body.guarantor_id, "الكفيل");
      if (next.guarantor_id && !db.prepare("SELECT 1 FROM guarantors WHERE id=? AND archived_at IS NULL").get(next.guarantor_id)) throw new InputError("الكفيل غير موجود أو مؤرشف", 409);
    }
    if (has("seller_id")) {
      if (sale.transaction_mode !== "INTERMEDIARY") throw new InputError("تغيير البائع المستحق متاح فقط لبيع سيارة مملوكة للغير؛ بيانات المالك مستقلة", 409);
      next.seller_id = req.body.seller_id == null || req.body.seller_id === "" ? null : positiveId(req.body.seller_id, "البائع");
      if (!next.seller_id || !db.prepare("SELECT 1 FROM sellers WHERE id=? AND archived_at IS NULL").get(next.seller_id)) throw new InputError("اختر بائعًا موجودًا وغير مؤرشف", 409);
    }
    const changesAmounts = has("sale_price") || has("down_payment");
    if (changesAmounts) {
      if (sale.sale_type !== "CASH") throw new InputError("لا تعدّل إجمالي عقد التقسيط من هذه الشاشة؛ استخدم إعادة جدولة الأقساط بعد مراجعة أثرها", 409);
      const movements = Number(db.prepare("SELECT COUNT(*) n FROM payments p JOIN installments i ON i.id=p.installment_id JOIN contracts c ON c.id=i.contract_id WHERE c.sale_id=?").get(sale.id).n || 0)
        + Number(db.prepare("SELECT COUNT(*) n FROM seller_payments WHERE sale_id=?").get(sale.id).n || 0);
      if (movements) throw new InputError("لا يمكن تغيير مبالغ بيع له تاريخ حركات مالية؛ استخدم تسوية منفصلة للحفاظ على السجل", 409);
      if (has("sale_price")) next.sale_price = asPositiveMoney(req.body.sale_price, "قيمة البيع");
      if (has("down_payment")) {
        const down = Number(req.body.down_payment);
        if (!Number.isFinite(down) || down < 0) throw new InputError("المقدم يجب أن يكون صفرًا أو أكثر");
        next.down_payment = Number(down.toFixed(2));
      }
      if (roundCents(next.down_payment) > roundCents(next.sale_price)) throw new InputError("المقدم لا يمكن أن يتجاوز قيمة البيع");
      next.remaining_amount = Number(Math.max(0, next.sale_price - next.down_payment).toFixed(2));
    }
    const partyChanged = next.customer_id !== before.customer_id || next.guarantor_id !== before.guarantor_id || next.seller_id !== before.seller_id;
    const priorPayments = Number(db.prepare("SELECT COUNT(*) n FROM payments p JOIN installments i ON i.id=p.installment_id JOIN contracts c ON c.id=i.contract_id WHERE c.sale_id=?").get(sale.id).n || 0)
      + Number(db.prepare("SELECT COUNT(*) n FROM seller_payments WHERE sale_id=?").get(sale.id).n || 0);
    const financiallySensitivePartyChanged = next.customer_id !== before.customer_id || next.seller_id !== before.seller_id;
    if (financiallySensitivePartyChanged && priorPayments) throw new InputError("لا يمكن تغيير المشتري أو البائع في بيع له إيصالات أو سدادات سابقة؛ تغيير الكفيل فقط مسموح مع حفظ السند القديم وإصدار سند بديل", 409);
    if (!partyChanged && !changesAmounts) throw new InputError("لم يتم تحديد أي بيانات لتصحيحها");
    const contract = db.prepare("SELECT * FROM contracts WHERE sale_id=?").get(sale.id);
    const tx = db.transaction(() => {
      db.prepare("UPDATE sales SET customer_id=?,seller_id=?,guarantor_id=?,sale_price=?,down_payment=?,remaining_amount=? WHERE id=?")
        .run(next.customer_id, next.seller_id, next.guarantor_id, next.sale_price, next.down_payment, next.remaining_amount, sale.id);
      if (contract) db.prepare("UPDATE contracts SET guarantor_id=? WHERE id=?").run(next.guarantor_id, contract.id);
      // Existing signed notes are never edited in place. Supersede open notes and make replacement drafts.
      if (partyChanged && sale.sale_type === "INSTALLMENT" && contract) {
        const oldNotes = db.prepare("SELECT * FROM promissory_notes WHERE contract_id=? AND status='OPEN'").all(contract.id);
        const total = Number(db.prepare("SELECT COALESCE(SUM(MAX(0,amount-paid_amount)),0) n FROM installments WHERE contract_id=? AND status<>'CANCELLED'").get(contract.id).n || 0);
        const lastDue = db.prepare("SELECT MAX(due_date) d FROM installments WHERE contract_id=? AND status<>'CANCELLED'").get(contract.id).d;
        const neededTypes = ["CUSTOMER", ...(next.guarantor_id ? ["GUARANTOR"] : [])];
        for (const old of oldNotes) db.prepare("UPDATE promissory_notes SET status='REPLACED',voided_at=CURRENT_TIMESTAMP,void_reason=?,replaced_by_id=NULL WHERE id=?").run(`تصحيح بيانات البيع: ${reason}`, old.id);
        const replacements = new Map();
        for (const partyType of neededTypes) {
          const source = oldNotes.find(n => n.party_type === partyType);
          const amount = source ? Number(source.amount) : total;
          const due = source?.due_date || lastDue;
          const serial = nextNumber("note", "NOTE");
          const created = db.prepare("INSERT INTO promissory_notes(contract_id,note_number,amount,issue_date,due_date,party_type,status) VALUES(?,?,?,?,?,?, 'OPEN')")
            .run(contract.id, serial, amount, localDateString(), due, partyType);
          replacements.set(partyType, Number(created.lastInsertRowid));
        }
        for (const old of oldNotes) if (replacements.has(old.party_type)) db.prepare("UPDATE promissory_notes SET replaced_by_id=? WHERE id=?").run(replacements.get(old.party_type), old.id);
      }
      if (partyChanged) db.prepare("UPDATE message_log SET status='CANCELLED_CHANGE',error=COALESCE(error,'تم إيقاف التذكيرات لمراجعة بيانات أطراف العقد') WHERE entity_type='INSTALLMENT' AND entity_id IN (SELECT i.id FROM installments i JOIN contracts c ON c.id=i.contract_id WHERE c.sale_id=?) AND status IN ('QUEUED','SCHEDULED','PLANNED')").run(sale.id);
      const after = { customer_id: next.customer_id, seller_id: next.seller_id, guarantor_id: next.guarantor_id, sale_price: next.sale_price, down_payment: next.down_payment, remaining_amount: next.remaining_amount };
      db.prepare("INSERT INTO sale_correction_history(sale_id,reason,before_json,after_json,actor) VALUES(?,?,?,?,?)").run(sale.id, reason, JSON.stringify(before), JSON.stringify(after), actor(req));
      audit("CORRECT", "SALE", sale.id, JSON.stringify({ reason, before, after, documents_reviewed: true }), actor(req));
    });
    tx.immediate();
    res.json({ ok: true, before, after: next, message: "تم التصحيح وتسجيل القيم السابقة والجديدة. راجع وأعد إصدار المستندات قبل استخدامها للتوقيع." });
  });

  // V05: replace the vehicle association only after an explicit document review.
  // Any receipt or seller-payment history blocks it because printed receipts resolve vehicle data from the sale.
  app.post("/api/sales/:id/replace-vehicle", (req, res) => {
    const sale = db.prepare("SELECT * FROM sales WHERE id=?").get(req.params.id);
    if (!sale) return res.status(404).json({ error: "البيع غير موجود" });
    if (sale.status !== "ACTIVE") throw new InputError("لا يمكن استبدال سيارة في بيع ملغى", 409);
    if (req.body.documents_reviewed !== true) throw new InputError("أكد مراجعة العقد والسندات وإيصال الاستلام وإعادة إصدار المستندات", 400);
    const reason = requireText(req.body.reason, "سبب استبدال السيارة");
    const newVehicleId = positiveId(req.body.vehicle_id, "السيارة البديلة");
    if (newVehicleId === sale.vehicle_id) throw new InputError("السيارة البديلة هي نفسها السيارة الحالية");
    const newVehicle = db.prepare("SELECT * FROM vehicles WHERE id=? AND archived_at IS NULL").get(newVehicleId);
    if (!newVehicle) throw new InputError("السيارة البديلة غير موجودة أو مؤرشفة", 409);
    if (newVehicle.status !== "IN_STOCK" || db.prepare("SELECT 1 FROM sales WHERE vehicle_id=? AND status='ACTIVE' LIMIT 1").get(newVehicleId) || db.prepare("SELECT 1 FROM vehicle_reservations WHERE vehicle_id=? AND status='ACTIVE' LIMIT 1").get(newVehicleId)) throw new InputError("السيارة البديلة ليست متاحة في المخزون", 409);
    const movementCount = Number(db.prepare("SELECT COUNT(*) n FROM payments p JOIN installments i ON i.id=p.installment_id JOIN contracts c ON c.id=i.contract_id WHERE c.sale_id=?").get(sale.id).n || 0)
      + Number(db.prepare("SELECT COUNT(*) n FROM seller_payments WHERE sale_id=?").get(sale.id).n || 0);
    if (movementCount) throw new InputError("لا يمكن تغيير ارتباط السيارة بعد وجود إيصالات مالية؛ الإيصالات الحالية تستند إلى بيانات السيارة المرتبطة بالبيع. عالج هذا السيناريو يدويًا مع الاحتفاظ بالمستندات الأصلية", 409);
    const contract = db.prepare("SELECT * FROM contracts WHERE sale_id=?").get(sale.id);
    const tx = db.transaction(() => {
      db.prepare("INSERT INTO sale_vehicle_replacements(sale_id,old_vehicle_id,new_vehicle_id,reason,actor) VALUES(?,?,?,?,?)").run(sale.id, sale.vehicle_id, newVehicleId, reason, actor(req));
      db.prepare("UPDATE vehicles SET status='IN_STOCK' WHERE id=? AND archived_at IS NULL").run(sale.vehicle_id);
      db.prepare("UPDATE vehicles SET status='SOLD' WHERE id=?").run(newVehicleId);
      db.prepare("UPDATE sales SET vehicle_id=? WHERE id=?").run(newVehicleId, sale.id);
      db.prepare("UPDATE message_log SET status='CANCELLED_CHANGE',error=COALESCE(error,'تم إيقاف التذكيرات لمراجعة بيانات السيارة بعد الاستبدال') WHERE entity_type='INSTALLMENT' AND entity_id IN (SELECT i.id FROM installments i JOIN contracts c ON c.id=i.contract_id WHERE c.sale_id=?) AND status IN ('QUEUED','SCHEDULED','PLANNED')").run(sale.id);
      if (contract) {
        const notes = db.prepare("SELECT * FROM promissory_notes WHERE contract_id=? AND status='OPEN'").all(contract.id);
        for (const note of notes) {
          const serial = nextNumber("note", "NOTE");
          const r = db.prepare("INSERT INTO promissory_notes(contract_id,note_number,amount,issue_date,due_date,party_type,status) VALUES(?,?,?,?,?,?, 'OPEN')").run(contract.id, serial, note.amount, localDateString(), note.due_date, note.party_type);
          db.prepare("UPDATE promissory_notes SET status='REPLACED',voided_at=CURRENT_TIMESTAMP,void_reason=?,replaced_by_id=? WHERE id=?").run(`استبدال السيارة: ${reason}`, r.lastInsertRowid, note.id);
        }
      }
      audit("REPLACE_VEHICLE", "SALE", sale.id, JSON.stringify({ old_vehicle_id: sale.vehicle_id, new_vehicle_id: newVehicleId, reason, documents_reviewed: true }), actor(req));
    });
    tx.immediate();
    res.json({ ok: true, old_vehicle_id: sale.vehicle_id, new_vehicle_id: newVehicleId, message: "تم ربط السيارة البديلة وحفظ تاريخ الاستبدال. أعد إصدار العقد وإيصال الاستلام وأي سندات قبل استخدامها." });
  });

  app.get("/api/sales/:id/change-history", (req, res) => {
    const id = positiveId(req.params.id, "رقم البيع");
    res.json({ corrections: db.prepare("SELECT * FROM sale_correction_history WHERE sale_id=? ORDER BY id DESC").all(id), vehicle_replacements: db.prepare("SELECT h.*,ov.plate_number old_plate_number,ov.make old_make,ov.model old_model,nv.plate_number new_plate_number,nv.make new_make,nv.model new_model FROM sale_vehicle_replacements h JOIN vehicles ov ON ov.id=h.old_vehicle_id JOIN vehicles nv ON nv.id=h.new_vehicle_id WHERE h.sale_id=? ORDER BY h.id DESC").all(id) });
  });

  // S01: non-destructive quality scan. It reports duplicate active identifiers without guessing which record to delete.
  app.get("/api/data-quality", (_req, res) => {
    const issues = [];
    const addDuplicates = (table, field, label) => {
      const groups = db.prepare(`SELECT lower(trim(${field})) value,COUNT(*) count FROM ${table} WHERE trim(COALESCE(${field},''))<>'' AND archived_at IS NULL GROUP BY lower(trim(${field})) HAVING COUNT(*)>1`).all();
      for (const group of groups) {
        const identity = table === "vehicles" ? "TRIM(COALESCE(make,'')) || ' ' || TRIM(COALESCE(model,''))" : "name";
        const matches = db.prepare(`SELECT id,${identity} AS name,${field} value,archived_at FROM ${table} WHERE lower(trim(${field}))=? AND archived_at IS NULL ORDER BY id`).all(group.value);
        issues.push({ type: `DUPLICATE_${label}`, field, value: group.value, count: Number(group.count), records: matches });
      }
    };
    addDuplicates("vehicles", "plate_number", "PLATE");
    addDuplicates("vehicles", "vin", "VIN");
    addDuplicates("customers", "national_id", "CUSTOMER_ID");
    addDuplicates("guarantors", "national_id", "GUARANTOR_ID");
    addDuplicates("sellers", "national_id", "SELLER_ID");
    res.json({ checked_at: new Date().toISOString(), issues_count: issues.length, issues });
  });

  app.get("/api/reconciliation",(req,res)=>{
    const issues=[];
    for(const r of db.prepare(`SELECT i.id,i.installment_number,i.amount,i.paid_amount,c.sale_id,c.contract_number,
      COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.installment_id=i.id AND p.status='ACTIVE'),0)-COALESCE((SELECT SUM(x.amount) FROM payment_refunds x JOIN payments p ON p.id=x.payment_id WHERE p.installment_id=i.id AND p.status='ACTIVE'),0) expected
      FROM installments i JOIN contracts c ON c.id=i.contract_id WHERE i.status<>'CANCELLED'`).all()){
      const diff=Number((Number(r.expected)-Number(r.paid_amount)).toFixed(2));if(Math.abs(diff)>0.009)issues.push({type:"INSTALLMENT_PAID_MISMATCH",entity_id:r.id,sale_id:r.sale_id,reference:r.contract_number,details:`القسط ${r.installment_number}: المسجل ${r.paid_amount}، المحسوب ${r.expected}`,difference:diff});
    }
    for(const r of db.prepare(`SELECT s.id,s.sale_number,s.remaining_amount,COALESCE((SELECT SUM(i.amount-i.paid_amount) FROM installments i JOIN contracts c ON c.id=i.contract_id WHERE c.sale_id=s.id AND i.status<>'CANCELLED'),MAX(0,s.sale_price-s.down_payment)) expected FROM sales s WHERE s.sale_type='INSTALLMENT' AND s.status='ACTIVE'`).all()){
      const diff=Number((Number(r.remaining_amount)-Number(r.expected)).toFixed(2));if(Math.abs(diff)>0.009)issues.push({type:"SALE_REMAINING_MISMATCH",entity_id:r.id,reference:r.sale_number,details:`المتبقي ${r.remaining_amount}، المحسوب ${r.expected}`,difference:diff});
    }
    for(const r of db.prepare(`SELECT s.id,s.sale_number,s.seller_paid_amount,COALESCE((SELECT SUM(sp.amount) FROM seller_payments sp WHERE sp.sale_id=s.id AND sp.status='ACTIVE'),0) expected FROM sales s WHERE s.transaction_mode='INTERMEDIARY' AND s.status='ACTIVE'`).all()){
      const diff=Number((Number(r.seller_paid_amount)-Number(r.expected)).toFixed(2));if(Math.abs(diff)>0.009)issues.push({type:"SELLER_PAID_MISMATCH",entity_id:r.id,reference:r.sale_number,details:`المسدد ${r.seller_paid_amount}، المحسوب ${r.expected}`,difference:diff});
    }
    if(String(req.query.format||"").toLowerCase()==="csv"){
      const cell=v=>`"${String(v??"").replaceAll('"','""')}"`;const csv=["type,entity_id,sale_id,reference,details,difference",...issues.map(i=>[i.type,i.entity_id,i.sale_id,i.reference,i.details,i.difference].map(cell).join(","))].join("\r\n");res.setHeader("Content-Type","text/csv; charset=utf-8");res.setHeader("Content-Disposition","attachment; filename=showroom-reconciliation.csv");return res.send(`\uFEFF${csv}`);
    }
    res.json({checked_at:new Date().toISOString(),issues_count:issues.length,issues});
  });
  app.get("/api/security/capabilities",(_req,res)=>res.json({
    model:"role-based-access-control",
    roles:[
      {role:"ADMIN",label:"مدير النظام",capabilities:["all"]},
      {role:"ACCOUNTANT",label:"محاسب",capabilities:["collections","reversals","refunds-confirmed","seller-payments","expenses","installment-schedules","settlement","contract-close","promissory-notes","unallocated-receipts","broker-commissions","backup-view"]},
      {role:"SALES",label:"مبيعات",capabilities:["sales-create","people-create-edit","vehicles-create-edit","reservations"]},
      {role:"VIEWER",label:"مشاهدة فقط",capabilities:["read-only"]}
    ],
    audit:true,
    financialEntriesHardDeleted:false,
    refundsRequireExplicitConfirmation:true,
    note:"تُراجع الصلاحيات على الخادم؛ تغيير دور الموظف أو تعطيله يُنهي جلساته الحالية. عمليات القراءة متاحة لكل الأدوار حاليًا."
  }));
}
