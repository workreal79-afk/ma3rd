import { InputError } from "../../shared/errors.js";
import { personInput } from "../../shared/validation.js";
import { asPositiveMoney, asDate, optionalText } from "../../shared/validation.js";
export function registerSellersRoutes(app, { db, audit, syncSellerPaid, nextNumber, money, formatAmountDigits, amountInWordsArabic, localDateString, escapeHtml, formatDateArabic, documentPage }) {
app.get("/api/sellers", (req, res) => {
  const q=String(req.query.search||"").trim(); if(!q) return res.json(db.prepare("SELECT * FROM sellers WHERE (?=1 OR archived_at IS NULL) ORDER BY id DESC").all(String(req.query.includeArchived||"0")==="1"?1:0));
  const like=`%${q}%`; res.json(db.prepare("SELECT * FROM sellers WHERE (?=1 OR archived_at IS NULL) AND (name LIKE ? OR national_id LIKE ? OR phone LIKE ? OR city LIKE ?) ORDER BY id DESC").all(String(req.query.includeArchived||"0")==="1"?1:0,like,like,like,like));
});

app.put("/api/sellers/:id", (req,res) => {
  const existing=db.prepare("SELECT * FROM sellers WHERE id=?").get(req.params.id);
  if(!existing) return res.status(404).json({error:"البائع غير موجود"});
  if(existing.archived_at) throw new InputError("لا يمكن تعديل ملف مؤرشف؛ استعده أولًا", 409);
  const {name,national_id,national_id_date,national_id_source,phone,address,city,notes}= personInput({ ...existing, ...req.body, name: req.body.name }, "اسم البائع");
  if(!name?.trim()) return res.status(400).json({error:"اسم البائع مطلوب"});
  if (String(national_id||"").trim()) {
    const duplicate=db.prepare("SELECT id,name FROM sellers WHERE national_id=? AND id<>?").get(String(national_id).trim(), req.params.id);
    if (duplicate) return res.status(409).json({error:`رقم الهوية مسجل بالفعل باسم ${duplicate.name}`});
  }
  const r=db.prepare(`UPDATE sellers SET name=?,national_id=?,national_id_date=?,national_id_source=?,phone=?,address=?,city=?,notes=? WHERE id=?`).run(name.trim(),national_id||"",national_id_date||"",national_id_source||"",phone||"",address||"",city||"",notes||"",req.params.id);
  if(!r.changes) return res.status(404).json({error:"البائع غير موجود"}); const after={name,national_id,national_id_date,national_id_source,phone,address,city,notes}; audit("UPDATE","SELLER",req.params.id,JSON.stringify({before:{name:existing.name,national_id:existing.national_id,national_id_date:existing.national_id_date,national_id_source:existing.national_id_source,phone:existing.phone,address:existing.address,city:existing.city,notes:existing.notes},after}),req.user?.username||"system"); res.json(db.prepare("SELECT * FROM sellers WHERE id=?").get(req.params.id));
});

app.get("/api/sellers/:id/profile", (req,res) => {
  const seller=db.prepare("SELECT * FROM sellers WHERE id=?").get(req.params.id); if(!seller) return res.status(404).json({error:"البائع غير موجود"});
  const vehicles=db.prepare("SELECT id,plate_number,vin,make,model,model_year,color,condition,price,ownership_type,owner_seller_id,status,notes,created_at FROM vehicles WHERE owner_seller_id=? ORDER BY id DESC").all(req.params.id);
  const sales=db.prepare(`SELECT s.*,cu.name customer_name,v.make,v.model,v.plate_number FROM sales s JOIN customers cu ON cu.id=s.customer_id JOIN vehicles v ON v.id=s.vehicle_id WHERE s.seller_id=? ORDER BY s.id DESC`).all(req.params.id);
  for (const sale of sales) syncSellerPaid(sale.id);
  const salesFresh=db.prepare(`SELECT s.*,cu.name customer_name,v.make,v.model,v.plate_number FROM sales s JOIN customers cu ON cu.id=s.customer_id JOIN vehicles v ON v.id=s.vehicle_id WHERE s.seller_id=? ORDER BY s.id DESC`).all(req.params.id);
  const payments=db.prepare(`SELECT sp.*,s.sale_number,cu.name customer_name,v.make,v.model,v.plate_number FROM seller_payments sp JOIN sales s ON s.id=sp.sale_id JOIN customers cu ON cu.id=s.customer_id LEFT JOIN vehicles v ON v.id=s.vehicle_id WHERE sp.seller_id=? ORDER BY sp.payment_date DESC,sp.id DESC`).all(req.params.id);
  const due=salesFresh.reduce((a,x)=>a+Math.max(0,Number(x.seller_due_amount||0)-Number(x.seller_paid_amount||0)),0);
  const paid=salesFresh.reduce((a,x)=>a+Number(x.seller_paid_amount||0),0);
  return res.json({seller,vehicles,sales:salesFresh,payments,summary:{due,paid,totalSales:salesFresh.reduce((a,x)=>a+Number(x.sale_price||0),0)}});
});

app.post("/api/sales/:id/seller-payments", (req,res) => {
  const sale=db.prepare("SELECT s.*,se.name seller_name FROM sales s JOIN sellers se ON se.id=s.seller_id WHERE s.id=? AND s.transaction_mode='INTERMEDIARY'").get(req.params.id);
  if(!sale) return res.status(404).json({error:"عملية البيع أو البائع غير موجود"});
  if (sale.status !== "ACTIVE") throw new InputError("لا يمكن السداد على بيع ملغى", 409);
  syncSellerPaid(sale.id);
  const fresh=db.prepare("SELECT seller_due_amount,seller_paid_amount,seller_id FROM sales WHERE id=?").get(sale.id);
  let value;
  try { value=asPositiveMoney(req.body.amount,"مبلغ السداد للبائع"); } catch (error) { return res.status(400).json({error:error.message}); }
  const remaining=Math.max(0,Number(fresh.seller_due_amount||0)-Number(fresh.seller_paid_amount||0));
  if(Math.round(value*100)>Math.round(remaining*100)) return res.status(400).json({error:`المبلغ أكبر من المتبقي للبائع (${money(remaining)} ريال)`});
  let receipt;
  let payDate;
  try { payDate=req.body.payment_date ? asDate(req.body.payment_date,"تاريخ السداد") : localDateString(); } catch (error) { return res.status(400).json({error:error.message}); }
  const tx=db.transaction(()=>{
    receipt=nextNumber("seller_receipt","SPAY");
    const r=db.prepare(`INSERT INTO seller_payments(sale_id,seller_id,receipt_number,amount,payment_date,payment_method,notes) VALUES(?,?,?,?,?,?,?)`).run(sale.id,fresh.seller_id,receipt,value,payDate,optionalText(req.body.payment_method,"طريقة السداد",100)||"CASH",optionalText(req.body.notes,"الملاحظات",5000));
    syncSellerPaid(sale.id);
    audit("CREATE","SELLER_PAYMENT",r.lastInsertRowid,`${receipt} — ${sale.seller_name} — ${value} — ${sale.sale_number}`);
    return r.lastInsertRowid;
  });
  res.json({ok:true,id:tx.immediate(),receipt_number:receipt,sale_id:sale.id});
});

app.put("/api/seller-payments/:id", (req,res) => {
  const payment=db.prepare(`SELECT sp.*,s.seller_due_amount,s.seller_id,s.status sale_status FROM seller_payments sp JOIN sales s ON s.id=sp.sale_id WHERE sp.id=?`).get(req.params.id);
  if(!payment) return res.status(404).json({error:"سداد البائع غير موجود"});
  if(payment.status!=="ACTIVE") throw new InputError("لا يمكن تعديل سداد معكوس",409);
  if (payment.sale_status !== "ACTIVE") throw new InputError("لا يمكن تعديل السداد على بيع ملغى؛ يمكن عكسه فقط", 409);
  syncSellerPaid(payment.sale_id);
  const current=db.prepare("SELECT seller_due_amount,seller_paid_amount FROM sales WHERE id=?").get(payment.sale_id);
  let value;
  try { value=asPositiveMoney(req.body.amount,"مبلغ السداد الجديد"); } catch (error) { return res.status(400).json({error:error.message}); }
  const allowed=Math.max(0,Number(current.seller_due_amount||0)-Number(current.seller_paid_amount||0)+Number(payment.amount||0));
  if(Math.round(value*100)>Math.round(allowed*100)) return res.status(400).json({error:"مبلغ السداد الجديد يتجاوز المستحق للبائع"});
  let paymentDate;
  try { paymentDate=req.body.payment_date ? asDate(req.body.payment_date,"تاريخ السداد") : payment.payment_date; } catch (error) { return res.status(400).json({error:error.message}); }
  const updated={amount:value,payment_date:paymentDate,payment_method:req.body.payment_method === undefined ? payment.payment_method : optionalText(req.body.payment_method,"طريقة السداد",100),notes:req.body.notes === undefined ? payment.notes : optionalText(req.body.notes,"الملاحظات",5000)};
  const before={amount:payment.amount,payment_date:payment.payment_date,payment_method:payment.payment_method,notes:payment.notes};
  const tx=db.transaction(()=>{
    db.prepare("UPDATE seller_payments SET amount=?,payment_date=?,payment_method=?,notes=? WHERE id=?").run(updated.amount,updated.payment_date,updated.payment_method,updated.notes,req.params.id);
    syncSellerPaid(payment.sale_id);
    audit("UPDATE","SELLER_PAYMENT",payment.id,JSON.stringify({receipt:payment.receipt_number,before,after:updated}),req.user?.username||"system");
  });
  tx.immediate(); res.json({ok:true});
});

app.delete("/api/seller-payments/:id", (req,res) => {
  const payment=db.prepare("SELECT * FROM seller_payments WHERE id=?").get(req.params.id);
  if(!payment) return res.status(404).json({error:"سداد البائع غير موجود"});
  if(payment.status!=="ACTIVE") return res.status(409).json({error:"سداد البائع معكوس بالفعل"});
  const reason=optionalText(req.body?.reason,"سبب عكس السداد",2000);
  if(!reason) return res.status(400).json({error:"سبب عكس السداد مطلوب"});
  const tx=db.transaction(()=>{
    db.prepare("UPDATE seller_payments SET status='REVERSED',reversed_at=CURRENT_TIMESTAMP,reversal_reason=? WHERE id=? AND status='ACTIVE'").run(reason,payment.id);
    syncSellerPaid(payment.sale_id);
    audit("REVERSE","SELLER_PAYMENT",payment.id,JSON.stringify({receipt:payment.receipt_number,amount:payment.amount,reason}),req.user?.username||"system");
  });
  tx.immediate(); res.json({ok:true,status:"REVERSED",message:"تم عكس القيد مع الاحتفاظ بالإيصال؛ لم يتم تسجيل رد أموال."});
});

app.get("/api/documents/seller-payment/:receipt", (req,res)=>{
  const p=db.prepare(`
    SELECT sp.*,
           s.sale_number,s.sale_price,s.seller_due_amount,
           se.name seller_name,se.national_id seller_national_id,se.phone seller_phone,
           cu.name customer_name,cu.national_id customer_national_id,
           v.make,v.model,v.model_year,v.plate_number,v.vin
    FROM seller_payments sp
    JOIN sales s ON s.id=sp.sale_id
    JOIN sellers se ON se.id=sp.seller_id
    JOIN customers cu ON cu.id=s.customer_id
    LEFT JOIN vehicles v ON v.id=s.vehicle_id
    WHERE sp.receipt_number=?
  `).get(req.params.receipt);
  if(!p) return res.status(404).send('إيصال سداد البائع غير موجود');

  const totalPaid=Number(db.prepare("SELECT COALESCE(SUM(amount),0) amount FROM seller_payments WHERE sale_id=? AND status='ACTIVE'").get(p.sale_id)?.amount||0);
  const due=Math.max(0,Number(p.seller_due_amount||0));
  const remaining=Math.max(0,due-totalPaid);
  const amountWords=amountInWordsArabic(p.amount);
  const vehicle=[p.make,p.model,p.model_year].filter(Boolean).join(' — ') || '-';

  const body=`
    <div class="receipt-card">
      <div class="receipt-top">
        <div>
          <div class="receipt-brand">معرض الزبيدي لبيع وشراء السيارات</div>
          <small class="receipt-brand">إيصال سداد مستحقات بائع</small>
        </div>
        <div class="receipt-number">
          <div>رقم الإيصال: <span>${escapeHtml(p.receipt_number)}</span></div>
          <div style="margin-top:6px">تاريخ السداد: <span>${formatDateArabic(p.payment_date)}</span></div>
        </div>
      </div>
      ${p.status !== 'ACTIVE' ? `<div style="margin:12px 0;padding:12px;border:2px solid #b91c1c;color:#991b1b;background:#fff1f2;font-weight:800;text-align:center">إيصال ملغى محاسبيًا — لا يثبت سدادًا فعالًا. السبب: ${escapeHtml(p.reversal_reason||'غير محدد')}</div>` : ''}

      <div class="receipt-info">
        <div class="cell"><b>البائع:</b> ${escapeHtml(p.seller_name)}</div>
        <div class="cell"><b>رقم الهوية:</b> ${escapeHtml(p.seller_national_id||'-')}</div>
        <div class="cell"><b>المشتري:</b> ${escapeHtml(p.customer_name)}</div>
        <div class="cell"><b>رقم البيع:</b> ${escapeHtml(p.sale_number)}</div>
        <div class="cell"><b>السيارة:</b> ${escapeHtml(vehicle)}</div>
        <div class="cell"><b>اللوحة:</b> ${escapeHtml(p.plate_number||'-')}</div>
        <div class="cell"><b>رقم الهيكل:</b> ${escapeHtml(p.vin||'-')}</div>
        <div class="cell"><b>طريقة الدفع:</b> ${escapeHtml(p.payment_method||'CASH')}</div>
      </div>

      <div class="amount-highlight">
        <div class="label">المبلغ المسدد للبائع</div>
        <div class="amount">${formatAmountDigits(p.amount)} ريال سعودي</div>
        <div class="words">فقط ${escapeHtml(amountWords)} لا غير</div>
      </div>

      <div class="summary-grid" style="padding:0 14px">
        <div class="summary-card"><span>إجمالي المستحق للبائع</span><strong>${formatAmountDigits(due)} ريال</strong></div>
        <div class="summary-card"><span>إجمالي المسدد حتى الآن</span><strong>${formatAmountDigits(totalPaid)} ريال</strong></div>
        <div class="summary-card"><span>المتبقي للبائع</span><strong>${formatAmountDigits(remaining)} ريال</strong></div>
        <div class="summary-card"><span>قيمة البيع</span><strong>${formatAmountDigits(p.sale_price)} ريال</strong></div>
      </div>

      <div class="receipt-notes">
        <div class="line"><b>بيان السداد:</b> تم سداد المبلغ الموضح أعلاه للبائع عن عملية البيع رقم <b>${escapeHtml(p.sale_number)}</b>.</div>
        ${p.notes ? `<div class="line"><b>ملاحظات:</b> ${escapeHtml(p.notes)}</div>` : ''}
      </div>

      <div class="signature-grid">
        <div class="signature-box">مسؤول السداد / المعرض</div>
        <div class="signature-box">استلمت من المعرض<br/><b>${escapeHtml(p.seller_name)}</b></div>
        <div class="signature-box">الختم والتوقيع</div>
      </div>
      <div class="receipt-footer"><span>إيصال محفوظ ضمن سجل المستحقات المالية للبائع</span><span>رقم الإيصال: ${escapeHtml(p.receipt_number)}</span></div>
    </div>`;
  res.type('html').send(documentPage('إيصال سداد مستحقات البائع',body));
});

app.post("/api/sellers", (req,res) => {
  const {name,national_id,national_id_date,national_id_source,phone,address,city,notes} = personInput(req.body, "اسم البائع");
  if (!name) return res.status(400).json({error:"اسم البائع مطلوب"});
  if (String(national_id||"").trim()) {
    const duplicate=db.prepare("SELECT id,name FROM sellers WHERE national_id=?").get(String(national_id).trim());
    if (duplicate) return res.status(409).json({error:`رقم الهوية مسجل بالفعل باسم ${duplicate.name}`});
  }
  const r = db.prepare(`
    INSERT INTO sellers(name,national_id,national_id_date,national_id_source,phone,address,city,notes)
    VALUES(?,?,?,?,?,?,?,?)
  `).run(name,national_id||"",national_id_date||"",national_id_source||"",phone||"",address||"",city||"",notes||"");
  audit("CREATE","SELLER",r.lastInsertRowid,name);
  res.json(db.prepare("SELECT * FROM sellers WHERE id=?").get(r.lastInsertRowid));
});

}
