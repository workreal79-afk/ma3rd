import { InputError } from "../../shared/errors.js";
import { billSerialNumber } from "../../utils/format.js";
import { asPositiveMoney, asMoney, asDate, personInput, positiveId, requireText, optionalText } from "../../shared/validation.js";
export function registerSalesRoutes(app, { db, audit, nextNumber, localDateString, addMonths, statusFromInstallment, syncInstallmentStatus, syncSaleRemaining, syncSellerPaid, calculateInstallmentPlan }) {
app.get("/api/sales", (_, res) => {
  const rows = db.prepare(`
    SELECT s.*, cu.name customer_name, v.make, v.model, v.plate_number, v.ownership_type, v.owner_seller_id, owner.name owner_seller_name,
           se.name seller_name, g.name guarantor_name, c.contract_number
    FROM sales s
    JOIN customers cu ON cu.id=s.customer_id
    JOIN vehicles v ON v.id=s.vehicle_id
    LEFT JOIN sellers se ON se.id=s.seller_id
    LEFT JOIN sellers owner ON owner.id=v.owner_seller_id
    LEFT JOIN guarantors g ON g.id=s.guarantor_id
    LEFT JOIN contracts c ON c.sale_id=s.id
    ORDER BY s.id DESC
  `).all();
  res.json(rows);
});

app.get("/api/installments", (req,res) => {
  const rows = db.prepare(`
    SELECT i.*, c.contract_number, s.sale_number, s.customer_id, cu.name customer_name,
           v.make, v.model, v.plate_number
    FROM installments i
    JOIN contracts c ON c.id=i.contract_id
    JOIN sales s ON s.id=c.sale_id
    JOIN customers cu ON cu.id=s.customer_id
    JOIN vehicles v ON v.id=s.vehicle_id
    WHERE s.status='ACTIVE' AND i.status<>'CANCELLED'
    ORDER BY i.due_date ASC, i.installment_number ASC
  `).all().map(x => ({...x, status: statusFromInstallment(x), bill_status: x.paid_amount >= x.amount ? "PAID" : (x.paid_amount > 0 ? "PARTIAL" : (x.due_date < localDateString() ? "OVERDUE" : (x.due_date === localDateString() ? "DUE" : "OPEN"))), overdue_days: x.due_date < localDateString() && x.paid_amount < x.amount ? Math.floor((new Date(localDateString())-new Date(x.due_date))/86400000) : 0}));
  res.json(rows);
});

app.get("/api/sales/:id", (req,res) => {
  const sale = db.prepare(`
    SELECT s.*, cu.name customer_name, cu.national_id customer_national_id, cu.national_id_date customer_national_id_date, cu.national_id_source customer_national_id_source, cu.phone customer_phone,
           cu.address customer_address, v.make, v.model, v.model_year, v.color, v.plate_number, v.vin,
           se.name seller_name, se.national_id seller_national_id, se.national_id_date seller_national_id_date, se.national_id_source seller_national_id_source, se.phone seller_phone, se.address seller_address,
           g.name guarantor_name, g.national_id guarantor_national_id, g.national_id_date guarantor_national_id_date, g.national_id_source guarantor_national_id_source, g.phone guarantor_phone, g.address guarantor_address,
           c.id contract_id, c.contract_number, c.creditor_name
    FROM sales s
    JOIN customers cu ON cu.id=s.customer_id
    JOIN vehicles v ON v.id=s.vehicle_id
    LEFT JOIN sellers se ON se.id=s.seller_id
    LEFT JOIN guarantors g ON g.id=s.guarantor_id
    LEFT JOIN contracts c ON c.sale_id=s.id
    WHERE s.id=?
  `).get(req.params.id);
  if (!sale) return res.status(404).json({error:"البيع غير موجود"});
  const installments = db.prepare(`
    SELECT i.*, b.bill_number, c.bill_start_serial
    FROM installments i JOIN contracts c ON c.id=i.contract_id LEFT JOIN bills b ON b.installment_id=i.id
    WHERE i.contract_id=? AND i.status<>'CANCELLED'
    ORDER BY i.installment_number
  `).all(sale.contract_id).map(x => ({...x, bill_number: `BILL-${billSerialNumber(x.bill_start_serial, x.installment_number)}`, status: statusFromInstallment(x), bill_status:x.paid_amount>=x.amount?"PAID":(x.paid_amount>0?"PARTIAL":(x.due_date<localDateString()?"OVERDUE":(x.due_date===localDateString()?"DUE":"OPEN")))}));
  const note = db.prepare("SELECT * FROM promissory_notes WHERE contract_id=? AND status='OPEN' ORDER BY id DESC").get(sale.contract_id);
  res.json({sale, installments, note});
});

app.get("/api/sales/:id/cancellation-preview", (req,res)=>{
  const sale=db.prepare("SELECT s.*,cu.name customer_name,v.plate_number,v.make,v.model FROM sales s JOIN customers cu ON cu.id=s.customer_id JOIN vehicles v ON v.id=s.vehicle_id WHERE s.id=?").get(req.params.id);
  if(!sale) return res.status(404).json({error:"البيع غير موجود"});
  const contract=db.prepare("SELECT id,contract_number FROM contracts WHERE sale_id=?").get(sale.id);
  const collections=db.prepare(`SELECT COUNT(*) count,COALESCE(SUM(CASE WHEN p.status='ACTIVE' THEN p.amount-COALESCE(r.refunded,0) ELSE 0 END),0) net_amount,COALESCE(SUM(CASE WHEN p.status='ACTIVE' THEN COALESCE(r.refunded,0) ELSE 0 END),0) refunded_amount FROM payments p JOIN installments i ON i.id=p.installment_id JOIN contracts c ON c.id=i.contract_id LEFT JOIN (SELECT payment_id,SUM(amount) refunded FROM payment_refunds GROUP BY payment_id) r ON r.payment_id=p.id WHERE c.sale_id=?`).get(sale.id);
  const sellerPayments=db.prepare("SELECT COUNT(*) count,COALESCE(SUM(CASE WHEN status='ACTIVE' THEN amount ELSE 0 END),0) active_amount FROM seller_payments WHERE sale_id=?").get(sale.id);
  const installments=db.prepare("SELECT COUNT(*) count,COALESCE(SUM(MAX(0,amount-paid_amount)),0) outstanding FROM installments WHERE contract_id=? AND status<>'CANCELLED'").get(contract?.id||0);
  const notes=db.prepare("SELECT status,COUNT(*) count FROM promissory_notes WHERE contract_id=? GROUP BY status").all(contract?.id||0);
  const bills=db.prepare("SELECT status,COUNT(*) count FROM bills WHERE contract_id=? GROUP BY status").all(contract?.id||0);
  const reservations=db.prepare("SELECT COUNT(*) count FROM vehicle_reservations WHERE vehicle_id=? AND status='ACTIVE'").get(sale.vehicle_id);
  res.json({sale:{id:sale.id,sale_number:sale.sale_number,status:sale.status,customer_name:sale.customer_name,vehicle:[sale.make,sale.model,sale.plate_number].filter(Boolean).join(" — "),sale_price:sale.sale_price,remaining_amount:sale.remaining_amount},contract:contract||null,collections:{count:Number(collections.count||0),net_amount:Number(collections.net_amount||0),refunded_amount:Number(collections.refunded_amount||0)},seller_payments:{count:Number(sellerPayments.count||0),active_amount:Number(sellerPayments.active_amount||0)},installments:{count:Number(installments.count||0),outstanding:Number(installments.outstanding||0)},notes:Object.fromEntries(notes.map(x=>[x.status,Number(x.count)])),bills:Object.fromEntries(bills.map(x=>[x.status,Number(x.count)])),active_reservations:Number(reservations.count||0),warning:"إلغاء البيع لا يرد أموالًا تلقائيًا ولا يعكس التحصيلات أو سداد البائع. تتم معالجة أي حركة مالية فعليًا في إجراء مستقل."});
});

app.put("/api/sales/:id/cancel", (req,res)=>{
  const sale=db.prepare("SELECT * FROM sales WHERE id=?").get(req.params.id);
  if(!sale) return res.status(404).json({error:"البيع غير موجود"});
  if(sale.status === "CANCELLED") return res.json({ok:true,alreadyCancelled:true});
  const reason=optionalText(req.body?.reason,"سبب إلغاء البيع",3000);
  if(!reason) throw new InputError("سبب إلغاء البيع مطلوب");
  const payments=db.prepare(`SELECT COALESCE(SUM(p.amount),0) amount FROM payments p JOIN installments i ON i.id=p.installment_id JOIN contracts c ON c.id=i.contract_id WHERE c.sale_id=? AND p.status='ACTIVE'`).get(sale.id).amount||0;
  const sellerPayments=db.prepare("SELECT COALESCE(SUM(amount),0) amount FROM seller_payments WHERE sale_id=? AND status='ACTIVE'").get(sale.id).amount||0;
  const tx=db.transaction(()=>{
    db.prepare("UPDATE sales SET status='CANCELLED',cancelled_at=CURRENT_TIMESTAMP,cancel_reason=? WHERE id=?").run(reason,sale.id);
    db.prepare("UPDATE vehicles SET status=CASE WHEN archived_at IS NOT NULL THEN status WHEN EXISTS(SELECT 1 FROM sales WHERE vehicle_id=? AND status='ACTIVE' AND id<>?) THEN 'SOLD' ELSE 'IN_STOCK' END WHERE id=?").run(sale.vehicle_id,sale.id,sale.vehicle_id);
    // Stop financial documents from being issued as active after cancellation, without deleting them.
    db.prepare("UPDATE promissory_notes SET status='VOIDED',voided_at=CURRENT_TIMESTAMP,void_reason=? WHERE contract_id IN (SELECT id FROM contracts WHERE sale_id=?) AND status='OPEN'").run(`إلغاء البيع: ${reason}`,sale.id);
    db.prepare("UPDATE bills SET status='CANCELLED' WHERE contract_id IN (SELECT id FROM contracts WHERE sale_id=?) AND status<>'PAID'").run(sale.id);
    db.prepare("UPDATE message_log SET status='CANCELLED_SALE',error=COALESCE(error,'تم إيقاف التذكيرات بسبب إلغاء البيع') WHERE entity_type='INSTALLMENT' AND entity_id IN (SELECT i.id FROM installments i JOIN contracts c ON c.id=i.contract_id WHERE c.sale_id=?) AND status IN ('QUEUED','SCHEDULED','PLANNED')").run(sale.id);
    audit("CANCEL","SALE",sale.id,JSON.stringify({sale_number:sale.sale_number,reason,active_collections_retained:Number(payments),active_seller_payments_retained:Number(sellerPayments),open_notes_voided:true,unpaid_bills_cancelled:true,refund_recorded:false}),req.user?.username||"system");
  });
  tx.immediate();
  res.json({ok:true,message:"أُلغي البيع وأوقفت التذكيرات مع الحفاظ على الإيصالات والسدادات السابقة. لم يتم عكس الحركات المالية أو تسجيل رد أموال؛ عالج أي مبالغ فعلية في مساراتها المستقلة.",active_collections_retained:Number(payments),active_seller_payments_retained:Number(sellerPayments)});
});

app.put("/api/sales/:id/reopen", (req,res)=>{
  const sale=db.prepare("SELECT * FROM sales WHERE id=?").get(req.params.id);
  if(!sale) return res.status(404).json({error:"البيع غير موجود"});
  if(sale.status!=='CANCELLED') throw new InputError("يمكن استعادة البيع الملغى فقط",409);
  if(db.prepare("SELECT 1 FROM vehicles WHERE id=? AND archived_at IS NULL").get(sale.vehicle_id)===undefined) throw new InputError("السيارة غير موجودة أو مؤرشفة",409);
  if(db.prepare("SELECT 1 FROM vehicle_reservations WHERE vehicle_id=? AND status='ACTIVE' LIMIT 1").get(sale.vehicle_id)) throw new InputError("السيارة محجوزة حاليًا؛ ألغِ الحجز قبل الاستعادة",409);
  const contract=db.prepare("SELECT * FROM contracts WHERE sale_id=?").get(sale.id);
  if(contract?.closed_at) throw new InputError("العقد مغلق بالفعل؛ لا يمكن استعادة البيع تلقائيًا",409);
  const reason=optionalText(req.body?.reason,"سبب استعادة البيع",3000);
  if(!reason) throw new InputError("سبب استعادة البيع مطلوب");
  db.transaction(()=>{
    db.prepare("UPDATE sales SET status='ACTIVE',cancelled_at=NULL,cancel_reason=NULL WHERE id=?").run(sale.id);
    db.prepare("UPDATE vehicles SET status='SOLD' WHERE id=?").run(sale.vehicle_id);
    // Only notes voided automatically by this sale cancellation can be restored; independently voided notes stay voided.
    db.prepare("UPDATE promissory_notes SET status='OPEN',voided_at=NULL,void_reason=NULL WHERE contract_id IN (SELECT id FROM contracts WHERE sale_id=?) AND status='VOIDED' AND void_reason LIKE 'إلغاء البيع: %'").run(sale.id);
    const installments=db.prepare("SELECT id FROM installments WHERE contract_id IN (SELECT id FROM contracts WHERE sale_id=?) AND status<>'CANCELLED'").all(sale.id);
    for (const item of installments) syncInstallmentStatus(item.id);
    audit("REOPEN","SALE",sale.id,JSON.stringify({reason,previous_cancel_reason:sale.cancel_reason,restored_sale_cancellation_notes:true}),req.user?.username||"system");
  }).immediate();
  res.json({ok:true});
});

app.post("/api/sales", (req,res) => {
  const {
    customer_id, customer, seller_id, vehicle_id, vehicle_mode, manual_vehicle, sale_type, transaction_mode, sale_price, down_payment,
    installment_count, installment_amount, installment_interval_months, installment_interval_value, installment_interval_unit, first_due_date, guarantor_id, guarantor, bill_start_serial, combine_small_remainder, promissory_due_mode, promissory_due_date, bill_date_calendar
  } = req.body;

  if (sale_type && !["CASH", "INSTALLMENT"].includes(sale_type)) throw new InputError("نوع البيع غير صحيح");
  if (transaction_mode && !["DIRECT", "INTERMEDIARY"].includes(transaction_mode)) throw new InputError("نوع العملية غير صحيح");
  if (vehicle_mode && !["MANUAL", "EXISTING"].includes(vehicle_mode)) throw new InputError("طريقة اختيار السيارة غير صحيحة");
  const customerData = customer?.name ? personInput(customer, "اسم المشتري") : null;
  if (customer_id && !customerData && !db.prepare("SELECT id FROM customers WHERE id=? AND archived_at IS NULL").get(positiveId(customer_id, "المشتري"))) throw new InputError("المشتري المحدد غير موجود");
  // الكفيل اختياري في التقسيط. اعتبر أي كائن فارغ كأنه لا يوجد كفيل.
  const guarantorData = guarantor?.name ? personInput(guarantor, "اسم الكفيل") : null;
  if ((!customer_id && !customerData?.name) || !sale_type || !sale_price)
    return res.status(400).json({error:"بيانات المشتري ونوع البيع وقيمة البيع مطلوبة"});
  if (vehicle_mode !== "MANUAL" && !vehicle_id)
    return res.status(400).json({error:"اختر سيارة موجودة أو اختر إدخال بيانات سيارة جديدة"});
  if (vehicle_mode === "MANUAL" && (!manual_vehicle?.make || !manual_vehicle?.model || !manual_vehicle?.plate_number))
    return res.status(400).json({error:"أدخل رقم اللوحة والماركة والموديل للسيارة الجديدة"});
  const mode = transaction_mode === "INTERMEDIARY" ? "INTERMEDIARY" : "DIRECT";
  if (sale_type === "INSTALLMENT" && guarantor_id && !guarantorData) positiveId(guarantor_id, "الكفيل");
  if (mode === "INTERMEDIARY" && seller_id) positiveId(seller_id, "البائع");
  if (sale_type === "INSTALLMENT" && guarantor_id && !guarantorData && !db.prepare("SELECT id FROM guarantors WHERE id=? AND archived_at IS NULL").get(guarantor_id))
    return res.status(400).json({error:"الكفيل المحدد غير موجود"});

  let vehicle = null;
  if (vehicle_mode !== "MANUAL") {
    vehicle = db.prepare("SELECT id,status,owner_seller_id FROM vehicles WHERE id=? AND archived_at IS NULL").get(positiveId(vehicle_id, "السيارة"));
    if (!vehicle) return res.status(400).json({error:"السيارة غير موجودة أو مؤرشفة"});
  }

  let price, down;
  try { price = asPositiveMoney(sale_price, "قيمة البيع"); down = asMoney(down_payment ?? 0, "المقدم"); } catch (error) { return res.status(400).json({error:error.message}); }

  if (down > price + 0.01) return res.status(400).json({error:"المقدم لا يمكن أن يكون أكبر من قيمة البيع"});
  const remaining = Math.max(0, Math.round((price - down) * 100) / 100);

  let firstDue = first_due_date || null;
  let intervalMonths = Number(installment_interval_months || 0);
  if (sale_type === "INSTALLMENT") {
    const unit = String(installment_interval_unit || "MONTH").toUpperCase();
    const value = Number(installment_interval_value || 0);
    if (Number.isFinite(value) && value > 0) intervalMonths = unit === "YEAR" ? value * 12 : value;
    if (intervalMonths === 0) intervalMonths = 1;
    if (!Number.isInteger(intervalMonths) || intervalMonths < 1 || intervalMonths > 120) {
      return res.status(400).json({error:"حدد دورية الاستحقاق بشكل صحيح (من 1 شهر إلى 10 سنوات)"});
    }
  } else {
    intervalMonths = 1;
  }
  if (sale_type === "INSTALLMENT") {
    if (!first_due_date || remaining <= 0) return res.status(400).json({error:"في التقسيط يجب تحديد أول استحقاق وأن يكون هناك مبلغ متبقٍ"});
    try { firstDue = asDate(first_due_date, "تاريخ أول استحقاق"); } catch (error) { return res.status(400).json({error:error.message}); }
  }

  // قيمة القسط يحددها المستخدم، وعدد الأقساط يُحسب تلقائيًا.
  // إذا تبقى جزء بعد الأقساط الكاملة، يُنشأ قسط أخير مستقل بقيمة الجزء المتبقي.
  let monthly = sale_type === "CASH" ? 0 : Number(installment_amount || 0);
  if (sale_type === "INSTALLMENT") {
    try { monthly = asPositiveMoney(installment_amount, "قيمة القسط"); } catch (error) { return res.status(400).json({error:error.message}); }
  }
  if (sale_type === "INSTALLMENT" && monthly > remaining + 0.01)
    return res.status(400).json({error:"قيمة القسط لا يمكن أن تكون أكبر من المبلغ المتبقي"});
  const plan = sale_type === "INSTALLMENT" ? calculateInstallmentPlan({ total: remaining, monthlyAmount: monthly, combineSmallRemainder: combine_small_remainder === true }) : { count: 0, amounts: [] };
  const count = plan.count;
  if (count && !addMonths(firstDue, (count - 1) * intervalMonths)) throw new InputError("نهاية جدول الأقساط تتجاوز نطاق التواريخ المسموح");
  const dueMode = ["BLANK", "ON_DEMAND", "DATE"].includes(String(promissory_due_mode || "BLANK").toUpperCase()) ? String(promissory_due_mode || "BLANK").toUpperCase() : null;
  if (!dueMode) throw new InputError("اختر طريقة استحقاق السند بشكل صحيح");
  let promissoryDueDate = null;
  if (dueMode === "DATE") {
    if (!promissory_due_date) throw new InputError("حدد تاريخ استحقاق السند");
    promissoryDueDate = asDate(promissory_due_date, "تاريخ استحقاق السند");
  }
  const billCalendar = ["GREGORIAN", "HIJRI"].includes(String(bill_date_calendar || "GREGORIAN").toUpperCase()) ? String(bill_date_calendar || "GREGORIAN").toUpperCase() : null;
  if (!billCalendar) throw new InputError("اختر تقويم تاريخ الكمبيالات بشكل صحيح");
  const billStart = bill_start_serial ? positiveId(bill_start_serial, "بداية تسلسل الكمبيالات") : 1;

  const effectiveSellerId = mode === "INTERMEDIARY" ? (Number(seller_id || vehicle?.owner_seller_id || 0) || null) : null;
  if (mode === "INTERMEDIARY" && !effectiveSellerId) return res.status(400).json({error:"في حالة السيارة المملوكة للغير يجب تحديد البائع أو تسجيل مالك السيارة أولًا"});
  if (effectiveSellerId && !db.prepare("SELECT id FROM sellers WHERE id=? AND archived_at IS NULL").get(effectiveSellerId)) throw new InputError("البائع المحدد غير موجود");
  let saleNumber, contractNumber;
  const issueDate = localDateString();

  const tx = db.transaction(() => {
    saleNumber = nextNumber("sale", "SALE");
    contractNumber = nextNumber("contract", "CON");
    let resolvedCustomerId = customer_id || null;
    let resolvedGuarantorId = guarantor_id || null;
    let resolvedVehicleId = vehicle_id || null;
    if (vehicle_mode !== "MANUAL") {
      const source = db.prepare("SELECT * FROM vehicles WHERE id=? AND archived_at IS NULL").get(positiveId(vehicle_id, "السيارة"));
      if (!source) throw new InputError("السيارة غير موجودة أو مؤرشفة", 409);
      const activeReservation = db.prepare("SELECT id FROM vehicle_reservations WHERE vehicle_id=? AND status='ACTIVE' LIMIT 1").get(source.id);
      if (activeReservation) throw new InputError("السيارة محجوزة حاليًا؛ ألغِ الحجز قبل استخدامها في مبايعة جديدة", 409);
      // يحتفظ سجل السيارة الواحد بتاريخ عدة مبايعات. كل مبايعة وعقدها
      // وأقساطها وكمبيالاتها مرتبطة برقم المبايعة الخاص بها، فلا ننسخ سجل السيارة.
      resolvedVehicleId = source.id;
    }
    if (vehicle_mode === "MANUAL") {
      const mv = manual_vehicle || {};
      const plate = requireText(mv.plate_number, "رقم اللوحة", 100), vinRaw = optionalText(mv.vin, "رقم الهيكل", 100), vin = vinRaw ? vinRaw.replace(/[^A-Za-z0-9]/g, "") : null;
      if (vinRaw && !vin) throw new InputError("رقم الهيكل يجب أن يحتوي على أحرف وأرقام إنجليزية فقط");
      const vr = db.prepare(`INSERT INTO vehicles(plate_number,vin,make,model,model_year,color,condition,price,ownership_type,owner_seller_id,status,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        plate, vin, requireText(mv.make, "الماركة", 100), requireText(mv.model, "الموديل", 100), Number(mv.model_year||0)||null, optionalText(mv.color, "اللون", 100)||null,
        mv.condition === "NEW" ? "NEW" : "USED", price, mode === "INTERMEDIARY" ? "THIRD_PARTY" : "SHOWROOM", effectiveSellerId, "SOLD", "أضيفت مباشرة أثناء عملية البيع"
      );
      resolvedVehicleId = Number(vr.lastInsertRowid);
      audit("CREATE", "VEHICLE", resolvedVehicleId, manual_vehicle.plate_number);
    }

    // بيانات المشتري والكفيل تُدخل لأول مرة أثناء عملية البيع، ثم تُحفظ
    // في جداولهم حتى تظل متاحة للأقساط والتحصيل والمستندات.
    if (customerData?.name) {
      if (String(customerData.national_id||"").trim()) {
        const duplicate=db.prepare("SELECT id,name FROM customers WHERE national_id=?").get(String(customerData.national_id).trim());
        if (duplicate) throw new InputError(`رقم هوية المشتري مسجل بالفعل باسم ${duplicate.name}`);
      }
      const r = db.prepare(`
        INSERT INTO customers(name,national_id,national_id_date,national_id_source,phone,address,city,notes)
        VALUES(?,?,?,?,?,?,?,?)
      `).run(
        customerData.name.trim(), customerData.national_id || null, customerData.national_id_date || null,
        customerData.national_id_source || null, customerData.phone || null, customerData.address || null,
        customerData.city || null, customerData.notes || null
      );
      resolvedCustomerId = Number(r.lastInsertRowid);
      audit("CREATE", "CUSTOMER", resolvedCustomerId, customerData.name);
    }

    if (sale_type === "INSTALLMENT" && guarantorData?.name) {
      if (String(guarantorData.national_id||"").trim()) {
        const duplicate=db.prepare("SELECT id,name FROM guarantors WHERE national_id=?").get(String(guarantorData.national_id).trim());
        if (duplicate) throw new InputError(`رقم هوية الكفيل مسجل بالفعل باسم ${duplicate.name}`);
      }
      const r = db.prepare(`
        INSERT INTO guarantors(name,national_id,national_id_date,national_id_source,phone,address,city)
        VALUES(?,?,?,?,?,?,?)
      `).run(
        guarantorData.name.trim(), guarantorData.national_id || null, guarantorData.national_id_date || null,
        guarantorData.national_id_source || null, guarantorData.phone || null, guarantorData.address || null,
        guarantorData.city || null
      );
      resolvedGuarantorId = Number(r.lastInsertRowid);
      audit("CREATE", "GUARANTOR", resolvedGuarantorId, guarantorData.name);
    }

    if (!resolvedCustomerId) throw new InputError("بيانات المشتري مطلوبة");

    const sale = db.prepare(`
      INSERT INTO sales(sale_number,customer_id,seller_id,vehicle_id,sale_type,transaction_mode,sale_price,down_payment,remaining_amount,
                        installment_count,installment_amount,installment_interval_months,first_due_date,guarantor_id,sale_date,seller_paid_amount,seller_due_amount)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      saleNumber, resolvedCustomerId, effectiveSellerId, resolvedVehicleId, sale_type, mode, price, down, remaining,
      count, monthly, intervalMonths, firstDue || null, resolvedGuarantorId || null, issueDate, 0, mode === 'INTERMEDIARY' ? price : 0
    );

    if (vehicle_mode !== "MANUAL") {
      db.prepare("UPDATE vehicles SET status='SOLD' WHERE id=?").run(resolvedVehicleId);
      db.prepare("UPDATE vehicle_reservations SET status='CONVERTED',released_at=CURRENT_TIMESTAMP WHERE vehicle_id=? AND status='ACTIVE'").run(resolvedVehicleId);
    }

    const contract = db.prepare(`
      INSERT INTO contracts(contract_number,sale_id,issue_date,creditor_name,installment_amount,installments_count,installment_interval_months,first_due_date,bill_start_serial,promissory_due_mode,promissory_due_date,bill_date_calendar,guarantor_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(contractNumber, sale.lastInsertRowid, issueDate, mode === "INTERMEDIARY" ? (db.prepare("SELECT name FROM sellers WHERE id=?").get(effectiveSellerId)?.name || "") : "أحمد متعب علي الزبيدي", monthly, count, intervalMonths, firstDue || null, billStart, dueMode, promissoryDueDate, billCalendar, resolvedGuarantorId || null);

    if (sale_type === "INSTALLMENT") {
      for (let i=1;i<=count;i++) {
        const due = addMonths(firstDue, (i - 1) * intervalMonths);
        const amount = plan.amounts[i - 1];
        const inst = db.prepare(`
          INSERT INTO installments(contract_id,installment_number,due_date,amount)
          VALUES(?,?,?,?)
        `).run(contract.lastInsertRowid, i, due, amount);
        const billSerial = billSerialNumber(billStart, i);
        // bill_number داخلي وفريد، بينما الرقم الظاهر للمستخدم هو billSerial.
        // هذا يمنع تداخل عداد الكمبيالات بين المبايعات المختلفة.
        const billNumber = `BILL-${contract.lastInsertRowid}-${billSerial}`;
        db.prepare(`
          INSERT INTO bills(contract_id,installment_id,bill_number,amount,issue_date,due_date)
          VALUES(?,?,?,?,?,?)
        `).run(contract.lastInsertRowid, inst.lastInsertRowid, billNumber, amount, issueDate, due);
      }
      const noteNumber = nextNumber("note","NOTE");
      db.prepare(`
        INSERT INTO promissory_notes(contract_id,note_number,amount,issue_date,due_date,party_type)
        VALUES(?,?,?,?,?,?)
      `).run(contract.lastInsertRowid, noteNumber, remaining, issueDate, addMonths(firstDue, (count - 1) * intervalMonths), "CUSTOMER");
      if (resolvedGuarantorId) {
        const guarantorNoteNumber = nextNumber("note","NOTE");
        db.prepare(`
          INSERT INTO promissory_notes(contract_id,note_number,amount,issue_date,due_date,party_type)
          VALUES(?,?,?,?,?,?)
        `).run(contract.lastInsertRowid, guarantorNoteNumber, remaining, issueDate, addMonths(firstDue, (count - 1) * intervalMonths), "GUARANTOR");
      }
    }

    syncSaleRemaining(sale.lastInsertRowid);
    audit("CREATE","SALE",sale.lastInsertRowid,`${saleNumber} — ${sale_type}`);
    return sale.lastInsertRowid;
  });

  res.json({id: tx.immediate(), sale_number: saleNumber, contract_number: contractNumber});
});

}
