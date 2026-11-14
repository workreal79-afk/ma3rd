import { billSerialNumber } from "../../utils/format.js";
import { asDate } from "../../shared/validation.js";
import { InputError } from "../../shared/errors.js";

function statusLabelArabic(status) {
  return ({PAID:"مدفوع", PARTIALLY_PAID:"مدفوع جزئيًا", OVERDUE:"متأخر", DUE:"مستحق اليوم", UPCOMING:"قادم"})[status] || status || "";
}
export function registerReportsRoutes(app, { db, money, documentPage, escapeHtml, localDateString, formatDateArabic, hijriFromGregorian, toArabicDigits, tafqeet, statusFromInstallment, serialNumber }) {
app.get("/api/documents/customer-statement/:customerId", (req,res)=>{
  const cu=db.prepare("SELECT * FROM customers WHERE id=?").get(req.params.customerId);
  if(!cu) return res.status(404).send('العميل غير موجود');

  const rows=db.prepare(`
    SELECT i.*,c.contract_number,c.bill_start_serial,b.bill_number,s.sale_number,s.sale_date,
           v.make,v.model,v.plate_number
    FROM installments i
    JOIN contracts c ON c.id=i.contract_id
    LEFT JOIN bills b ON b.installment_id=i.id
    JOIN sales s ON s.id=c.sale_id
    JOIN vehicles v ON v.id=s.vehicle_id
    WHERE s.customer_id=? AND s.status='ACTIVE' AND i.status<>'CANCELLED'
    ORDER BY i.due_date,i.installment_number
  `).all(req.params.customerId);

  const payments=db.prepare(`
    SELECT * FROM (
      SELECT p.id event_id,p.receipt_number,p.amount original_amount,p.amount movement_amount,p.payment_date,
        p.payment_method,p.status movement_status,p.reversal_reason details,i.installment_number,i.due_date,
        b.bill_number,c.bill_start_serial,c.contract_number,s.sale_number,
        CASE WHEN p.status='REVERSED' THEN 'ORIGINAL_REVERSED' ELSE 'COLLECTION' END movement_type
      FROM payments p JOIN installments i ON i.id=p.installment_id LEFT JOIN bills b ON b.installment_id=i.id
      JOIN contracts c ON c.id=i.contract_id JOIN sales s ON s.id=c.sale_id WHERE s.customer_id=?
      UNION ALL
      SELECT -p.id event_id,('عكس '||p.receipt_number) receipt_number,p.amount original_amount,-p.amount movement_amount,
        substr(COALESCE(p.reversed_at,p.payment_date),1,10) payment_date,p.payment_method,'REVERSED' movement_status,
        p.reversal_reason details,i.installment_number,i.due_date,b.bill_number,c.bill_start_serial,c.contract_number,s.sale_number,'REVERSAL' movement_type
      FROM payments p JOIN installments i ON i.id=p.installment_id LEFT JOIN bills b ON b.installment_id=i.id
      JOIN contracts c ON c.id=i.contract_id JOIN sales s ON s.id=c.sale_id WHERE s.customer_id=? AND p.status='REVERSED'
      UNION ALL
      SELECT -1000000000-r.id event_id,r.refund_number receipt_number,r.amount original_amount,-r.amount movement_amount,
        r.refund_date payment_date,r.payment_method,'REFUND' movement_status,r.reason details,i.installment_number,i.due_date,
        b.bill_number,c.bill_start_serial,c.contract_number,s.sale_number,'REFUND' movement_type
      FROM payment_refunds r JOIN payments p ON p.id=r.payment_id JOIN installments i ON i.id=p.installment_id
      LEFT JOIN bills b ON b.installment_id=i.id JOIN contracts c ON c.id=i.contract_id JOIN sales s ON s.id=c.sale_id
      WHERE s.customer_id=?
      UNION ALL
      SELECT 1000000000+u.id event_id,u.receipt_number,u.amount original_amount,
        MAX(0,ROUND(u.amount-u.allocated_amount,2)) movement_amount,u.payment_date,u.payment_method,
        u.status movement_status,COALESCE(u.notes,'') details,NULL installment_number,NULL due_date,
        NULL bill_number,NULL bill_start_serial,NULL contract_number,NULL sale_number,'UNALLOCATED_RECEIPT' movement_type
      FROM unallocated_receipts u WHERE u.customer_id=? AND u.status<>'CANCELLED'
    ) ORDER BY payment_date,event_id
  `).all(req.params.customerId,req.params.customerId,req.params.customerId,req.params.customerId);

  const contracts=[...new Map(rows.map(x=>[x.contract_number,x])).values()];
  const totals={
    amount:rows.reduce((a,x)=>a+Number(x.amount||0),0),
    paid:rows.reduce((a,x)=>a+Number(x.paid_amount||0),0),
    unallocated:Number(db.prepare("SELECT COALESCE(SUM(MAX(0,amount-allocated_amount)),0) n FROM unallocated_receipts WHERE customer_id=? AND status<>'CANCELLED'").get(req.params.customerId).n||0)
  };
  totals.remaining=Math.max(0,totals.amount-totals.paid);

  const today=localDateString();
  const dueCount=rows.filter(x=>statusFromInstallment(x,today)==='DUE').length;
  const overdueRows=rows.filter(x=>statusFromInstallment(x,today)==='OVERDUE');
  const overdueTotal=overdueRows.reduce((a,x)=>a+Math.max(0,Number(x.amount||0)-Number(x.paid_amount||0)),0);
  const activeSales=[...new Map(rows.map(x=>[x.sale_number,x])).values()];
  const statusClass=s=>({PAID:'status-paid',PARTIALLY_PAID:'status-partial',OVERDUE:'status-overdue',DUE:'status-due',UPCOMING:'status-open'})[s]||'status-open';

  const body=`
    <div class="doc-header">
      <div><h1 class="brand-title">معرض الزبيدي لبيع وشراء السيارات</h1><div class="brand-sub">نظام إدارة المبيعات والأقساط والتحصيلات</div></div>
      <div style="text-align:left"><h2 class="doc-title">كشف حساب المشتري</h2><div class="doc-subtitle">كشف موحّد بنفس تصميم كشف الأقساط من عملية المبايعة</div></div>
    </div>
    <div class="doc-meta">
      <div class="meta-item"><b>العميل:</b><span>${escapeHtml(cu.name)}</span></div>
      <div class="meta-item"><b>رقم الهوية:</b><span>${escapeHtml(cu.national_id||'-')}</span></div>
      <div class="meta-item"><b>الجوال:</b><span>${escapeHtml(cu.phone||'-')}</span></div>
      <div class="meta-item"><b>عدد العقود:</b><span>${toArabicDigits(String(contracts.length))}</span></div>
      <div class="meta-item"><b>عدد المبيعات:</b><span>${toArabicDigits(String(activeSales.length))}</span></div>
      <div class="meta-item"><b>تاريخ الكشف:</b><span>${formatDateArabic(today)}</span></div>
    </div>
    <div class="summary-grid">
      <div class="summary-card"><span>إجمالي الأقساط</span><strong>${money(totals.amount)} ريال</strong></div>
      <div class="summary-card"><span>إجمالي المدفوع</span><strong>${money(totals.paid)} ريال</strong></div>
      <div class="summary-card"><span>إجمالي المتبقي</span><strong>${money(totals.remaining)} ريال</strong></div>
      <div class="summary-card"><span>المبالغ غير الموزعة</span><strong>${money(totals.unallocated)} ريال</strong></div>
      <div class="summary-card"><span>المتأخرات</span><strong>${money(overdueTotal)} ريال</strong></div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
      <span class="status-pill status-open">الأقساط: ${toArabicDigits(String(rows.length))}</span>
      <span class="status-pill status-due">مستحق اليوم: ${toArabicDigits(String(dueCount))}</span>
      <span class="status-pill status-overdue">متأخر: ${toArabicDigits(String(overdueRows.length))}</span>
    </div>
    <div class="section-title">ملخص العقود</div>
    <div class="table-wrap"><table class="doc-table"><thead><tr><th>العقد</th><th>البيع</th><th>السيارة</th><th>إجمالي الأقساط</th><th>المدفوع</th><th>المتبقي</th></tr></thead><tbody>
      ${contracts.map(seed=>{
        const rr=rows.filter(r=>r.contract_number===seed.contract_number);
        const amount=rr.reduce((a,r)=>a+Number(r.amount||0),0);
        const paid=rr.reduce((a,r)=>a+Number(r.paid_amount||0),0);
        const remaining=Math.max(0,amount-paid);
        return `<tr><td>${escapeHtml(seed.contract_number)}</td><td>${escapeHtml(seed.sale_number)}</td><td>${escapeHtml(`${seed.make||''} ${seed.model||''} — ${seed.plate_number||''}`)}</td><td>${money(amount)} ريال</td><td>${money(paid)} ريال</td><td>${money(remaining)} ريال</td></tr>`;
      }).join('')}
    </tbody></table></div>
    <div class="section-title">تفاصيل جدول الأقساط والكمبيالات</div>
    <div class="table-wrap"><table class="doc-table"><thead><tr><th>م</th><th>العقد</th><th>الاستحقاق</th><th>قيمة القسط</th><th>المدفوع</th><th>المتبقي</th><th>الكمبيالة</th><th>الحالة</th></tr></thead><tbody>
      ${rows.map(x=>{const st=statusFromInstallment(x,today);return `<tr><td>${toArabicDigits(String(x.installment_number))}</td><td>${escapeHtml(x.contract_number)}</td><td>${formatDateArabic(x.due_date)}</td><td>${money(x.amount)} ريال</td><td>${money(x.paid_amount)} ريال</td><td>${money(Math.max(0,Number(x.amount)-Number(x.paid_amount)))} ريال</td><td>${escapeHtml(toArabicDigits(String(billSerialNumber(x.bill_start_serial, x.installment_number) ?? "-").replace(/^BILL-/i,'')))}</td><td><span class="status-pill ${statusClass(st)}">${escapeHtml(statusLabelArabic(st))}</span></td></tr>`}).join('')}
      <tr class="total-row"><td colspan="3">الإجمالي</td><td>${money(totals.amount)} ريال</td><td>${money(totals.paid)} ريال</td><td>${money(totals.remaining)} ريال</td><td colspan="2"></td></tr>
    </tbody></table></div>
    <div class="section-title">سجل التحصيلات</div>
    <div class="table-wrap"><table class="doc-table"><thead><tr><th>التاريخ</th><th>الإيصال</th><th>العقد</th><th>الكمبيالة</th><th>القسط</th><th>المبلغ</th><th>طريقة الدفع</th></tr></thead><tbody>
      ${payments.map(x=>{const label=x.movement_type==='REVERSAL'?'عكس إيصال':x.movement_type==='REFUND'?'رد مبلغ فعلي':x.movement_type==='ORIGINAL_REVERSED'?'إيصال معكوس (سجل تاريخي)':x.movement_type==='UNALLOCATED_RECEIPT'?'رصيد غير موزع':'تحصيل';const color=x.movement_amount<0?'#b42318':'inherit';return `<tr><td>${formatDateArabic(x.payment_date)}</td><td>${escapeHtml(x.receipt_number||'-')}</td><td>${escapeHtml(x.contract_number||'-')}</td><td>${escapeHtml(toArabicDigits(String(billSerialNumber(x.bill_start_serial, x.installment_number) ?? "-").replace(/^BILL-/i,'')))}</td><td>${toArabicDigits(String(x.installment_number||'-'))}</td><td style="color:${color}">${x.movement_amount<0?'−':''}${money(Math.abs(Number(x.movement_amount||0)))} ريال</td><td>${escapeHtml(`${label}${x.details?` — ${x.details}`:''}`)} · ${escapeHtml(x.payment_method||'-')}</td></tr>`}).join('')}
      <tr class="total-row"><td colspan="5">صافي حركة التحصيلات والردود والعكوس</td><td>${money(payments.reduce((a,x)=>a+Number(x.movement_amount||0),0))} ريال</td><td></td></tr>
    </tbody></table></div>
    <div class="grand-total"><span>إجمالي المتبقي حتى تاريخ الكشف</span><span class="value">${money(totals.remaining)} ريال</span></div>
    <div style="display:flex;justify-content:space-between;gap:18px;margin-top:20px;font-size:10px;color:#667085"><span>تاريخ إعداد الكشف: ${formatDateArabic(today)}</span><span>هذا الكشف لأغراض المتابعة المالية ويُرجع إلى سجلات النظام عند الحاجة.</span></div>`;
  res.type('html').send(documentPage('كشف حساب المشتري',body));
});

app.get("/api/reports/summary", (req,res)=>{
  const from=asDate(req.query.from || localDateString(), "بداية الفترة");
  const to=asDate(req.query.to || localDateString(), "نهاية الفترة");
  if (from > to) throw new InputError("بداية الفترة لا يمكن أن تكون بعد نهايتها");
  const sales=db.prepare(`SELECT s.*,cu.name customer_name,v.make,v.model,v.plate_number,c.contract_number FROM sales s JOIN customers cu ON cu.id=s.customer_id JOIN vehicles v ON v.id=s.vehicle_id LEFT JOIN contracts c ON c.sale_id=s.id WHERE s.status='ACTIVE' AND s.sale_date BETWEEN ? AND ? ORDER BY s.sale_date DESC,s.id DESC`).all(from,to);
  const payments=db.prepare(`SELECT p.*,p.payment_date movement_date,p.amount movement_amount,'COLLECTION' movement_type,i.installment_number,c.contract_number,cu.name customer_name FROM payments p JOIN installments i ON i.id=p.installment_id JOIN contracts c ON c.id=i.contract_id JOIN sales s ON s.id=c.sale_id JOIN customers cu ON cu.id=s.customer_id WHERE p.status='ACTIVE' AND p.payment_date BETWEEN ? AND ?
    UNION ALL
    SELECT -r.id id, p.installment_id, r.refund_number receipt_number, -r.amount amount, r.refund_date payment_date, r.payment_method, ('رد فعلي: '||r.reason) notes, r.created_at, 'REFUND' status, NULL reversed_at, NULL reversal_reason, NULL replaced_by_payment_id, r.refund_date movement_date, -r.amount movement_amount, 'REFUND' movement_type, i.installment_number,c.contract_number,cu.name customer_name FROM payment_refunds r JOIN payments p ON p.id=r.payment_id JOIN installments i ON i.id=p.installment_id JOIN contracts c ON c.id=i.contract_id JOIN sales s ON s.id=c.sale_id JOIN customers cu ON cu.id=s.customer_id WHERE r.refund_date BETWEEN ? AND ? ORDER BY payment_date DESC,id DESC`).all(from,to,from,to);
  const expenses=db.prepare(`SELECT * FROM expenses WHERE status='ACTIVE' AND expense_date BETWEEN ? AND ? ORDER BY expense_date DESC,id DESC`).all(from,to);
  const overdue=db.prepare(`SELECT i.*,c.contract_number,s.sale_number,cu.name customer_name,v.make,v.model,v.plate_number FROM installments i JOIN contracts c ON c.id=i.contract_id JOIN sales s ON s.id=c.sale_id JOIN customers cu ON cu.id=s.customer_id JOIN vehicles v ON v.id=s.vehicle_id WHERE s.status='ACTIVE' AND i.status<>'CANCELLED' AND i.paid_amount<i.amount AND i.due_date<? ORDER BY i.due_date`).all(to);
  const sellerDue=db.prepare(`SELECT s.sale_number,se.name seller_name,s.seller_due_amount,s.seller_paid_amount,s.sale_price FROM sales s JOIN sellers se ON se.id=s.seller_id WHERE s.status='ACTIVE' AND s.transaction_mode='INTERMEDIARY' AND s.seller_due_amount>s.seller_paid_amount ORDER BY s.sale_date DESC`).all();
  res.json({from,to,summary:{sales_count:sales.length,sales_total:sales.reduce((a,x)=>a+x.sale_price,0),down_total:sales.reduce((a,x)=>a+x.down_payment,0),remaining_total:sales.reduce((a,x)=>a+x.remaining_amount,0),collections_total:payments.reduce((a,x)=>a+x.amount,0),expenses_total:expenses.reduce((a,x)=>a+x.amount,0),overdue_total:overdue.reduce((a,x)=>a+Math.max(0,x.amount-x.paid_amount),0),overdue_count:overdue.length,seller_due_total:sellerDue.reduce((a,x)=>a+Math.max(0,x.seller_due_amount-x.seller_paid_amount),0)},sales,payments,expenses,overdue,sellerDue});
});

app.get("/api/documents/report", (req,res)=>{
  const from=asDate(req.query.from || localDateString(), "بداية الفترة"), to=asDate(req.query.to || localDateString(), "نهاية الفترة");
  if (from > to) throw new InputError("بداية الفترة لا يمكن أن تكون بعد نهايتها");
  const sales=db.prepare(`SELECT s.*,cu.name customer_name,v.make,v.model,v.plate_number,c.contract_number FROM sales s JOIN customers cu ON cu.id=s.customer_id JOIN vehicles v ON v.id=s.vehicle_id LEFT JOIN contracts c ON c.sale_id=s.id WHERE s.status='ACTIVE' AND s.sale_date BETWEEN ? AND ? ORDER BY s.sale_date DESC,s.id DESC`).all(from,to);
  const payments=db.prepare(`SELECT p.*,p.payment_date movement_date,p.amount movement_amount,'COLLECTION' movement_type,i.installment_number,c.contract_number,cu.name customer_name FROM payments p JOIN installments i ON i.id=p.installment_id JOIN contracts c ON c.id=i.contract_id JOIN sales s ON s.id=c.sale_id JOIN customers cu ON cu.id=s.customer_id WHERE p.status='ACTIVE' AND p.payment_date BETWEEN ? AND ?
    UNION ALL
    SELECT -r.id id, p.installment_id, r.refund_number receipt_number, -r.amount amount, r.refund_date payment_date, r.payment_method, ('رد فعلي: '||r.reason) notes, r.created_at, 'REFUND' status, NULL reversed_at, NULL reversal_reason, NULL replaced_by_payment_id, r.refund_date movement_date, -r.amount movement_amount, 'REFUND' movement_type, i.installment_number,c.contract_number,cu.name customer_name FROM payment_refunds r JOIN payments p ON p.id=r.payment_id JOIN installments i ON i.id=p.installment_id JOIN contracts c ON c.id=i.contract_id JOIN sales s ON s.id=c.sale_id JOIN customers cu ON cu.id=s.customer_id WHERE r.refund_date BETWEEN ? AND ? ORDER BY payment_date DESC,id DESC`).all(from,to,from,to);
  const expenses=db.prepare(`SELECT * FROM expenses WHERE status='ACTIVE' AND expense_date BETWEEN ? AND ? ORDER BY expense_date DESC,id DESC`).all(from,to);
  const overdue=db.prepare(`SELECT i.*,c.contract_number,cu.name customer_name FROM installments i JOIN contracts c ON c.id=i.contract_id JOIN sales s ON s.id=c.sale_id JOIN customers cu ON cu.id=s.customer_id WHERE s.status='ACTIVE' AND i.status<>'CANCELLED' AND i.paid_amount<i.amount AND i.due_date<? ORDER BY i.due_date`).all(to);
  const body=`<div class="doc-header"><h2>التقرير الشامل</h2><div class="meta"><div><b>من:</b> ${escapeHtml(from)}</div><div><b>إلى:</b> ${escapeHtml(to)}</div></div></div><div class="summary-card"><b>المبيعات:</b> ${sales.length} عملية — ${money(sales.reduce((a,x)=>a+x.sale_price,0))} ريال &nbsp; | &nbsp; <b>التحصيلات:</b> ${money(payments.reduce((a,x)=>a+x.amount,0))} ريال &nbsp; | &nbsp; <b>المصروفات:</b> ${money(expenses.reduce((a,x)=>a+x.amount,0))} ريال &nbsp; | &nbsp; <b>المتأخرات:</b> ${money(overdue.reduce((a,x)=>a+Math.max(0,x.amount-x.paid_amount),0))} ريال</div><h3>المبيعات</h3><table class="doc-table"><tr><th>التاريخ</th><th>البيع</th><th>العميل</th><th>السيارة</th><th>القيمة</th><th>المقدم</th><th>المتبقي</th></tr>${sales.map(x=>`<tr><td>${escapeHtml(x.sale_date)}</td><td>${escapeHtml(x.sale_number)}</td><td>${escapeHtml(x.customer_name)}</td><td>${escapeHtml(x.make+' '+x.model+' — '+x.plate_number)}</td><td>${money(x.sale_price)}</td><td>${money(x.down_payment)}</td><td>${money(x.remaining_amount)}</td></tr>`).join('')}</table><h3>التحصيلات والردود الفعلية</h3><table class="doc-table"><tr><th>التاريخ</th><th>الإيصال / الرد</th><th>العميل</th><th>العقد</th><th>المبلغ</th></tr>${payments.map(x=>`<tr><td>${escapeHtml(x.payment_date)}</td><td>${escapeHtml(x.receipt_number)}</td><td>${escapeHtml(x.customer_name)}</td><td>${escapeHtml(x.contract_number)}</td><td>${money(x.amount)}</td></tr>`).join('')}</table><h3>المصروفات</h3><table class="doc-table"><tr><th>التاريخ</th><th>البند</th><th>المبلغ</th><th>البيان</th></tr>${expenses.map(x=>`<tr><td>${escapeHtml(x.expense_date)}</td><td>${escapeHtml(x.category)}</td><td>${money(x.amount)}</td><td>${escapeHtml(x.description||'')}</td></tr>`).join('')}</table><h3>المتأخرات</h3><table class="doc-table"><tr><th>الاستحقاق</th><th>العميل</th><th>العقد</th><th>القسط</th><th>المتبقي</th></tr>${overdue.map(x=>`<tr><td>${escapeHtml(x.due_date)}</td><td>${escapeHtml(x.customer_name)}</td><td>${escapeHtml(x.contract_number)}</td><td>${escapeHtml(x.installment_number)}</td><td>${money(x.amount-x.paid_amount)}</td></tr>`).join('')}</table>`;
  res.type('html').send(documentPage('التقرير الشامل',body));
});

app.get("/api/documents/schedule/:saleId", (req,res)=>{
  const sale=db.prepare(`SELECT s.*,cu.name customer_name,v.make,v.model,v.plate_number,c.contract_number,c.installment_amount,c.installments_count,c.first_due_date,c.bill_start_serial FROM sales s JOIN customers cu ON cu.id=s.customer_id JOIN vehicles v ON v.id=s.vehicle_id LEFT JOIN contracts c ON c.sale_id=s.id WHERE s.id=?`).get(req.params.saleId);
  if(!sale || !sale.contract_number) return res.status(404).send('كشف الأقساط غير موجود');
  const rows=db.prepare(`SELECT i.*, b.bill_number FROM installments i JOIN contracts c ON c.id=i.contract_id LEFT JOIN bills b ON b.installment_id=i.id WHERE c.sale_id=? AND i.status<>'CANCELLED' ORDER BY i.installment_number`).all(req.params.saleId);
  const totals={amount:rows.reduce((a,x)=>a+Number(x.amount||0),0),paid:rows.reduce((a,x)=>a+Number(x.paid_amount||0),0)};
  totals.remaining=Math.max(0,totals.amount-totals.paid);
  const statusClass=s=>({PAID:'status-paid',PARTIALLY_PAID:'status-partial',OVERDUE:'status-overdue',DUE:'status-due',UPCOMING:'status-open'})[s]||'status-open';
  const dueCount=rows.filter(x=>statusFromInstallment(x,localDateString())==='DUE').length;
  const overdueCount=rows.filter(x=>statusFromInstallment(x,localDateString())==='OVERDUE').length;
  const body=`
    <div class="doc-header">
      <div><h1 class="brand-title">معرض الزبيدي لبيع وشراء السيارات</h1><div class="brand-sub">نظام إدارة المبيعات والأقساط والتحصيلات</div></div>
      <div style="text-align:left"><h2 class="doc-title">كشف الأقساط</h2><div class="doc-subtitle">كشف تفصيلي للعقد وجدول الاستحقاقات</div></div>
    </div>
    <div class="doc-meta">
      <div class="meta-item"><b>رقم البيع:</b><span>${escapeHtml(sale.sale_number)}</span></div>
      <div class="meta-item"><b>رقم العقد:</b><span>${escapeHtml(sale.contract_number)}</span></div>
      <div class="meta-item"><b>العميل:</b><span>${escapeHtml(sale.customer_name)}</span></div>
      <div class="meta-item"><b>السيارة:</b><span>${escapeHtml(`${sale.make||''} ${sale.model||''} — ${sale.plate_number||''}`)}</span></div>
      <div class="meta-item"><b>عدد الأقساط:</b><span>${toArabicDigits(String(rows.length))}</span></div>
      <div class="meta-item"><b>أول استحقاق:</b><span>${formatDateArabic(sale.first_due_date)}</span></div>
    </div>
    <div class="summary-grid">
      <div class="summary-card"><span>إجمالي الأقساط</span><strong>${money(totals.amount)} ريال</strong></div>
      <div class="summary-card"><span>إجمالي المدفوع</span><strong>${money(totals.paid)} ريال</strong></div>
      <div class="summary-card"><span>إجمالي المتبقي</span><strong>${money(totals.remaining)} ريال</strong></div>
      <div class="summary-card"><span>المتأخرات</span><strong>${money(rows.filter(x=>statusFromInstallment(x,localDateString())==='OVERDUE').reduce((a,x)=>a+Math.max(0,Number(x.amount)-Number(x.paid_amount)),0))} ريال</strong></div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
      <span class="status-pill status-open">الأقساط: ${toArabicDigits(String(rows.length))}</span>
      <span class="status-pill status-due">مستحق اليوم: ${toArabicDigits(String(dueCount))}</span>
      <span class="status-pill status-overdue">متأخر: ${toArabicDigits(String(overdueCount))}</span>
    </div>
    <div class="section-title">تفاصيل جدول الأقساط</div>
    <div class="table-wrap"><table class="doc-table"><thead><tr><th>م</th><th>تاريخ الاستحقاق</th><th>قيمة القسط</th><th>المدفوع</th><th>المتبقي</th><th>الكمبيالة</th><th>الحالة</th></tr></thead><tbody>
      ${rows.map(x=>{const st=statusFromInstallment(x,localDateString());return `<tr><td>${toArabicDigits(String(x.installment_number))}</td><td>${formatDateArabic(x.due_date)}</td><td>${money(x.amount)} ريال</td><td>${money(x.paid_amount)} ريال</td><td>${money(Math.max(0,Number(x.amount)-Number(x.paid_amount)))} ريال</td><td>${escapeHtml(toArabicDigits(String(billSerialNumber(x.bill_start_serial, x.installment_number) ?? "-").replace(/^BILL-/i,'')))}</td><td><span class="status-pill ${statusClass(st)}">${escapeHtml(statusLabelArabic(st))}</span></td></tr>`}).join('')}
      <tr class="total-row"><td colspan="2">الإجمالي</td><td>${money(totals.amount)} ريال</td><td>${money(totals.paid)} ريال</td><td>${money(totals.remaining)} ريال</td><td colspan="2"></td></tr>
    </tbody></table></div>
    <div class="grand-total"><span>إجمالي المتبقي حتى تاريخ الكشف</span><span class="value">${money(totals.remaining)} ريال</span></div>
    <div style="display:flex;justify-content:space-between;gap:18px;margin-top:20px;font-size:10px;color:#667085"><span>تاريخ إعداد الكشف: ${formatDateArabic(localDateString())}</span><span>هذا الكشف لأغراض المتابعة المالية ويُرجع إلى سجلات النظام عند الحاجة.</span></div>`;
  res.type('html').send(documentPage('كشف الأقساط',body));
});

app.get("/api/documents/receipt/:receipt", (req,res)=>{
  const p=db.prepare(`SELECT p.*,i.installment_number,i.amount installment_amount,i.paid_amount installment_paid_amount,i.due_date,b.bill_number,c.bill_start_serial,c.contract_number,c.issue_date,s.sale_number,s.sale_price,s.down_payment,s.first_due_date,cu.name customer_name,cu.national_id customer_national_id,g.name guarantor_name,v.make,v.model,v.plate_number FROM payments p JOIN installments i ON i.id=p.installment_id LEFT JOIN bills b ON b.installment_id=i.id JOIN contracts c ON c.id=i.contract_id JOIN sales s ON s.id=c.sale_id JOIN customers cu ON cu.id=s.customer_id LEFT JOIN guarantors g ON g.id=s.guarantor_id LEFT JOIN vehicles v ON v.id=s.vehicle_id WHERE p.receipt_number=?`).get(req.params.receipt);
  if(!p) return res.status(404).send('الإيصال غير موجود');
  const refundTotal = Number(db.prepare("SELECT COALESCE(SUM(amount),0) n FROM payment_refunds WHERE payment_id=?").get(p.id)?.n || 0);
  const receiptStatusBanner = p.status === "REVERSED"
    ? `<div style="border:2px solid #b42318;color:#b42318;background:#fff4f2;padding:10px;border-radius:8px;margin:10px 0;font-weight:700;text-align:center">إيصال معكوس — لا يُعد إثباتًا لتحصيل فعّال. السبب: ${escapeHtml(p.reversal_reason||'غير محدد')}</div>`
    : refundTotal > 0
      ? `<div style="border:2px solid #b54708;color:#93370d;background:#fffaeb;padding:10px;border-radius:8px;margin:10px 0;font-weight:700;text-align:center">سجل تاريخي للتحصيل — تم رد ${money(refundTotal)} ريال فعليًا، والصافي ${money(Math.max(0,Number(p.amount)-refundTotal))} ريال.</div>`
      : "";
  const paymentLabels={CASH:'نقدي',BANK_TRANSFER:'تحويل بنكي',POS:'شبكة / نقاط بيع',BANK:'تحويل بنكي',CHEQUE:'شيك'};
  const billIssue=p.issue_date||p.payment_date;
  const amountWords=tafqeet?tafqeet(Math.floor(Number(p.amount||0)),Math.round((Number(p.amount||0)-Math.floor(Number(p.amount||0)))*100)):'';
  const remaining=Math.max(0,Number(p.installment_amount||0)-Number(p.installment_paid_amount||0));
  const dueDate=formatDateArabic(p.due_date||'');
  const body=`
    <div class="receipt-card">
      ${receiptStatusBanner}
      <div class="receipt-top">
        <div><div class="receipt-brand">معرض الزبيدي لبيع وشراء السيارات</div><small>إيصال تحصيل قسط</small></div>
        <div class="receipt-number">رقم الإيصال: <span>${escapeHtml(p.receipt_number)}</span><br><div style="margin-top:6px;font-size:10px;color:#667085">التاريخ: ${formatDateArabic(p.payment_date)}</div></div>
      </div>
      <div class="receipt-info">
        <div class="cell"><b>اسم المدين:</b> ${escapeHtml(p.customer_name||'-')}</div>
        <div class="cell"><b>رقم الهوية:</b> ${escapeHtml(p.customer_national_id||'-')}</div>
        <div class="cell"><b>اسم الكفيل الغارم:</b> ${escapeHtml(p.guarantor_name||'')}</div>
        <div class="cell"><b>رقم العقد:</b> ${escapeHtml(p.contract_number||'-')}</div>
        <div class="cell"><b>رقم الكمبيالة:</b> ${toArabicDigits(String(billSerialNumber(p.bill_start_serial, p.installment_number) ?? "-").replace(/^BILL-/i,''))}</div>
        <div class="cell"><b>القسط رقم:</b> ${toArabicDigits(String(p.installment_number||'-'))}</div>
        <div class="cell"><b>تاريخ استحقاق القسط:</b> ${dueDate}</div>
        <div class="cell"><b>طريقة الدفع:</b> ${escapeHtml(paymentLabels[p.payment_method]||p.payment_method||'-')}</div>
      </div>
      <div class="amount-highlight"><div class="label">تم استلام مبلغ وقدره</div><div class="amount">${money(p.amount)} ريال</div><div class="words">${escapeHtml(amountWords)}</div></div>
      <div class="receipt-notes">
        <div class="line"><b>وذلك من قيمة:</b> ${escapeHtml(`${p.make||''} ${p.model||''} — ${p.plate_number||''}`)}</div>
        <div class="line"><b>تاريخ استلام الكمبيالة:</b> ${formatDateArabic(billIssue)} &nbsp;&nbsp; <b>المبلغ المتبقي من القسط بعد التحصيل:</b> ${money(remaining)} ريال</div>
        <div class="line"><b>بيان:</b> تم تسجيل التحصيل على القسط رقم ${toArabicDigits(String(p.installment_number||'-'))} من العقد ${escapeHtml(p.contract_number||'-')}.</div>
      </div>
      <div class="signature-grid">
        <div class="signature-box">مستلم الكمبيالة / التحصيل</div>
        <div class="signature-box">توقيع العميل</div>
        <div class="signature-box">الختم</div>
      </div>
      <div class="receipt-footer"><span>معرض الزبيدي لبيع وشراء السيارات</span><span>نسخة أصلية للتحصيل</span></div>
    </div>
    <div style="font-size:9px;color:#667085;margin-top:8px;text-align:center">تمت الطباعة من نظام المعرض بتاريخ ${formatDateArabic(localDateString())}</div>`;
  res.type('html').send(documentPage('إيصال تحصيل',body));
});

}
