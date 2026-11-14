import { safeJson, billSerialNumber } from "../../utils/format.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));


function statusLabelArabic(status) {
  return ({PAID:"مدفوع", PARTIALLY_PAID:"مدفوع جزئيًا", OVERDUE:"متأخر", DUE:"مستحق اليوم", UPCOMING:"قادم"})[status] || status || "";
}
export function registerDocumentsRoutes(app, { db, localDateString, money, documentPage, escapeHtml, formatDateArabic, hijriFromGregorian, toArabicDigits, tafqeet, amountInWordsArabic, addMonths, formatAmountDigits, serialNumber }) {
app.get("/api/documents/contract/:saleId", (req,res) => {
  const data = db.prepare(`
    SELECT s.*, cu.name customer_name, cu.national_id customer_national_id, cu.address customer_address,
           v.make,v.model,v.model_year,v.plate_number,v.vin,
           se.name seller_name,se.national_id seller_national_id,se.address seller_address,
           g.name guarantor_name,g.national_id guarantor_national_id,g.address guarantor_address,
           c.contract_number,c.issue_date,c.installment_amount,c.installments_count,c.first_due_date,c.creditor_name,c.promissory_due_mode,c.promissory_due_date
    FROM sales s
    JOIN customers cu ON cu.id=s.customer_id
    JOIN vehicles v ON v.id=s.vehicle_id
    LEFT JOIN sellers se ON se.id=s.seller_id
    LEFT JOIN guarantors g ON g.id=s.guarantor_id
    JOIN contracts c ON c.sale_id=s.id
    WHERE s.id=?
  `).get(req.params.saleId);
  if (!data) return res.status(404).send("غير موجود");

  const templatePath = path.join(__dirname, "..", "..", "..", "templates", "contract.html");
  let html = fs.readFileSync(templatePath, "utf8");
  const serial = String(data.sale_number || data.contract_number || "").match(/(\d+)$/)?.[1] || String(data.id || "1").padStart(4,"0");
  const issueDate = data.issue_date || localDateString();
  // تاريخ بداية الأقساط في العقد يجب أن يكون من أول استحقاق/تحصيل، وليس تاريخ تحرير العقد.
  const firstCollectionDate = data.first_due_date || issueDate;
  const firstCollectionD = new Date(`${firstCollectionDate}T00:00:00`);
  // يظهر بند بداية الأقساط في العقد بصيغة يوم/شهر بالأرقام العربية، بينما تبقى السنة في خانتها المستقلة.
  const firstCollectionMonth = !isNaN(firstCollectionD.getTime())
    ? `${toArabicDigits(String(firstCollectionD.getDate()).padStart(2, '0'))}/${toArabicDigits(String(firstCollectionD.getMonth() + 1).padStart(2, '0'))}`
    : '';
  const firstCollectionYear = !isNaN(firstCollectionD.getTime()) ? toArabicDigits(String(firstCollectionD.getFullYear())) : '';
  const carPrice = Number(data.sale_price || 0);
  const downPayment = Number(data.down_payment || 0);
  const installmentAmount = Number(data.installment_amount || 0);
  const carModel = data.model || "";
  const carYear = data.model_year || "";
  const vehicleVin = String(data.vin || "").replace(/[^A-Za-z0-9]/g, "");
  const payload = {
    serial,
    carPriceNum: String(carPrice),
    downPaymentNum: String(downPayment),
    debtorName: data.customer_name || "",
    creditorName: data.creditor_name || (data.transaction_mode === "INTERMEDIARY" ? data.seller_name : "أحمد متعب علي الزبيدي") || "أحمد متعب علي الزبيدي",
    installmentAmount: String(installmentAmount),
    plateNumber: data.plate_number || "",
    carModel: [data.make, carModel].filter(Boolean).join(" "),
    carYear: String(carYear),
    vehicleVin,
    guarantorName: data.guarantor_name || "",
    sellerName: data.seller_name || data.creditor_name || "أحمد متعب علي الزبيدي",
    issueDate,
    startMonth: firstCollectionMonth,
    startYear: firstCollectionYear,
  };
  const injected = `<style>
    .no-print{display:none!important}.page-container{gap:0!important;display:block!important}
    body{background:#fff!important;margin:0!important;padding:0!important}
  </style>
  <script>
    (() => {
      const data=${safeJson(payload)};
      const set=(id,v)=>{const el=document.getElementById(id); if(el) el.value=v??"";};
      set("serial",data.serial); set("carPriceNum",data.carPriceNum); set("downPaymentNum",data.downPaymentNum);
      set("debtorName",data.debtorName); set("creditorName",data.creditorName); set("sellerName",data.sellerName); set("installmentAmount",data.installmentAmount);
      set("plateNumber",data.plateNumber); set("carModel",data.carModel); set("carYear",data.carYear); set("vehicleVin",data.vehicleVin); set("guarantorName",data.guarantorName); set("issueDate",data.issueDate);
      if (typeof updateHijriField === "function") updateHijriField();
      // في نص العقد: "إبتداء من شهر يوم/شهر ... سنة ..." يعتمد على تاريخ أول تحصيل/استحقاق.
      set("startMonth",data.startMonth); set("startYear",data.startYear);
      if (typeof calculateRemainingAndTafqeet === "function") calculateRemainingAndTafqeet();
      if (typeof generate === "function") generate();
    })();
  </script>`;
  html = html.replace('</body>', `${injected}</body>`);
  res.type("html").send(html);
});

app.get("/api/documents/bills/:saleId", (req,res) => {
  const sale = db.prepare(`
    SELECT s.*, cu.name customer_name,cu.national_id customer_national_id,cu.national_id_date customer_national_id_date,cu.national_id_source customer_national_id_source,cu.address customer_address,
           se.name seller_name,se.national_id seller_national_id,se.address seller_address,
           g.name guarantor_name,g.national_id guarantor_national_id,g.national_id_date guarantor_national_id_date,g.national_id_source guarantor_national_id_source,g.address guarantor_address,
           v.make vehicle_make,v.model vehicle_model,v.model_year vehicle_year,v.vin vehicle_vin,
           c.id contract_id,c.contract_number,c.bill_start_serial,c.issue_date,c.installments_count,c.creditor_name,c.bill_date_calendar
    FROM sales s JOIN customers cu ON cu.id=s.customer_id
    JOIN contracts c ON c.sale_id=s.id
    LEFT JOIN vehicles v ON v.id=s.vehicle_id
    LEFT JOIN sellers se ON se.id=s.seller_id
    LEFT JOIN guarantors g ON g.id=s.guarantor_id
    WHERE s.id=?
  `).get(req.params.saleId);
  if (!sale) return res.status(404).send("غير موجود");
  const bills = db.prepare(`
    SELECT b.*,i.installment_number FROM bills b JOIN installments i ON i.id=b.installment_id
    WHERE b.contract_id=? AND b.status<>'CANCELLED' AND i.status<>'CANCELLED' ORDER BY i.installment_number
  `).all(sale.contract_id);
  const total = bills.length || Number(sale.installments_count || 0);
  const billCalendar = String(sale.bill_date_calendar || "GREGORIAN").toUpperCase();
  const displayBillDate = (dateString) => {
    if (!dateString) return "";
    if (billCalendar === "HIJRI") return hijriFromGregorian(dateString).replace(/\s*هـ$/, "");
    const d = new Date(`${dateString}T00:00:00`);
    if (Number.isNaN(d.getTime())) return "";
    return `${toArabicDigits(String(d.getDate()).padStart(2,"0"))} / ${toArabicDigits(String(d.getMonth()+1).padStart(2,"0"))} / ${toArabicDigits(d.getFullYear())}`;
  };
  const issueBillDate = displayBillDate(sale.issue_date);
  const calendarSuffix = billCalendar === "HIJRI" ? "هـ" : "م";
  const issueWeekday = sale.issue_date
    ? new Intl.DateTimeFormat("ar-SA", { weekday: "long" }).format(new Date(`${sale.issue_date}T00:00:00`))
    : "";
  const safe = escapeHtml;
  const pages=[];
  const makeBill=(b, idx)=>{
      if(!b) return "";
      // رقم الكمبيالة هو رقم القسط ضمن التسلسل المعتمد في العقد.
      const currentNum = String(billSerialNumber(sale.bill_start_serial, b.installment_number) ?? "");
      const amountRiyal=Math.floor(Number(b.amount||0));
      const amountHalala=Math.round((Number(b.amount||0)-amountRiyal)*100);
      const amountText=amountInWordsArabic(Number(b.amount||0));
      const dueDate=displayBillDate(b.due_date);
      const carDescription=[sale.vehicle_make,sale.vehicle_model,sale.vehicle_year]
        .filter(v=>v!==null&&v!==undefined&&String(v).trim()!=="").join(" ");
      const value=(v)=>safe(v===null||v===undefined?"":String(v));
      return `<div class="kombiala-box"><div class="main-content">
      <div class="bill-top-row">
        <div class="bill-number">كمبيالة رقم : <span class="dots">${safe(toArabicDigits(currentNum))} / ${toArabicDigits(total)}</span></div>
        <div class="amount-summary"><span class="amount-title">مبلغ الكمبيالة</span><div class="amount-boxes"><div class="amount-unit"><label>ريــــال</label><div class="shaded-box box-riyal">${toArabicDigits(amountRiyal)}</div></div><div class="amount-unit"><label>هـ</label><div class="shaded-box box-halala">${toArabicDigits(String(amountHalala).padStart(2,"0"))}</div></div></div></div>
        <div class="due-date-top">استحقاق الدفع في <span class="dots">${safe(dueDate)}</span> ${calendarSuffix}</div>
      </div>
      <div class="identity-row">
        <div class="field name-field"><span class="field-label">المدين</span><span class="dots field-value">${value(sale.customer_name)}</span></div>
        <div class="field id-field"><span class="field-label">السجل</span><span class="dots field-value">${value(sale.customer_national_id)}</span></div>
        <div class="field address-field"><span class="field-label">العنوان</span><span class="dots field-value">${value(sale.customer_address)}</span></div>
      </div>
      <div class="identity-row">
        <div class="field name-field"><span class="field-label">الكفيل الغارم</span><span class="dots field-value">${value(sale.guarantor_name)}</span></div>
        <div class="field id-field"><span class="field-label">السجل</span><span class="dots field-value">${value(sale.guarantor_national_id)}</span></div>
        <div class="field address-field"><span class="field-label">العنوان</span><span class="dots field-value">${value(sale.guarantor_address)}</span></div>
      </div>
      <div class="declaration-row">أتعهد أنا المدين الموقع أدناه بأن أدفع لأمر السيد / <span class="dots field-value creditor-value">${value(sale.creditor_name || "أحمد متعب علي الزبيدي")}</span></div>
      <div class="amount-words-row"><span class="nowrap">المبلغ المرقوم أعلاه وقدره</span><div class="box-words">${safe(amountText)}</div><span class="nowrap">وذلك عن القسط</span><span class="installment-no">( ${toArabicDigits(String(b.installment_number))} )</span></div>
      <div class="vehicle-row"><span class="nowrap">وذلك قيمة سيارة</span><span class="dots field-value car-value">${value(carDescription)}</span><span class="nowrap">رقم الهيكل</span><span class="dots field-value vin-value">${value(sale.vehicle_vin)}</span></div>
      <div class="paragraph-line guarantor-pledge">بدون أي تأخير: كما أقر أنا الكفيل الغارم الموقع أدناه وألتزم بدفع قيمة هذه الكمبيالة عن مكفولي بمجرد أول طلب من الساحب، وهذه كفالة غرم وأداء وتسليم في الحياة وفي الممات، وقد كفلت برضائي واختياري ووقّعت هذه الكمبيالة ببصمتي وخط يدي وبدون إكراه أو إجبار.</div>
      <div class="issue-date-row">حررت هذه الكمبيالة في يوم <span class="dots weekday-value">${value(issueWeekday)}</span> بتاريخ <span class="dots issue-date-value">${safe(issueBillDate)}</span> ${calendarSuffix}</div>
      <div class="signatures-row"><div>توقيع المدين</div><div>شاهد</div><div>شاهد</div><div>توقيع الكفيل</div><div class="official-stamp"><span>الختم الرسمي</span></div></div>
      <div class="royal-decree">هذه الكمبيالة واجبة الدفع بدون تعليل بموجب قرار مجلس الوزراء الموقر رقم ٦٩٢ وتاريخ ٢٦ / ٩ / ١٣٨٣هـ<br>والمتوج بالمرسوم الملكي الكريم رقم ٣٧ وتاريخ ١ / ١١ / ١٣٨٣هـ (نظام الأوراق التجارية)</div>
      </div><div class="left-sidebar-box"><div class="left-sidebar-text"><span class="exhibition-name">معرض الزبيدي لبيع وشراء السيارات</span>لصاحبه / أحمد متعب علي الزبيدي<br>تصريح مرور رقم 137 / م / ع<br>س.ت : ( 4603001317 ) - القنفذة - المظيلف<br>المملكة العربية السعودية</div></div></div>`;
    };
  // كل كمبيالة في صفحة مستقلة بتصميم أفقي على ورقة A4 كاملة، مع إتاحة المعاينة العمودية عند الحاجة.
  for (const bill of bills) {
    pages.push(`<div class="a5-page">${makeBill(bill,bill?.installment_number)}</div>`);
  }
  const css=`@import url('https://fonts.googleapis.com/css2?family=Amiri:wght@400;700;800&family=Tajawal:wght@400;700;800&display=swap');
html,body{margin:0;padding:0}
body{font-family:Tajawal,sans-serif;background:#f4f6f9}
.print-controls{position:sticky;top:0;z-index:20;display:flex;align-items:center;justify-content:center;gap:8px;padding:10px;background:#fff;border-bottom:1px solid #ccc;box-shadow:0 2px 6px rgba(0,0,0,.08);font-family:Tajawal,sans-serif}
.print-controls button{border:1px solid #222;background:#fff;border-radius:6px;padding:8px 14px;font-weight:800;cursor:pointer}
.print-controls button.active{background:#111;color:#fff}
.a5-page{background:#fff;margin:0 auto;box-sizing:border-box;page-break-after:always;break-after:page;overflow:hidden;font-family:Amiri,serif;color:#000;padding:5mm;display:flex;align-items:center;justify-content:center}
.a5-page,.a5-page.landscape{width:297mm;height:210mm}
.a5-page.landscape{page:bill-landscape}
.a5-page.portrait{width:210mm;height:297mm;page:bill-portrait}
.kombiala-box{width:286mm;height:200mm;border:1.5px solid #000;border-radius:4px;display:flex;box-sizing:border-box;position:relative;background:#fff;padding:5px;gap:6px;overflow:hidden;transform-origin:center center;flex:0 0 auto}
.a5-page.portrait .kombiala-box{transform:rotate(90deg)}
.a5-page.landscape .kombiala-box{transform:none}
.main-content{flex:1;min-width:0;min-height:0;padding:2px 4px;display:flex;flex-direction:column;justify-content:space-between;align-items:stretch}
.bill-top-row{display:grid;grid-template-columns:minmax(160px,1fr) max-content minmax(300px,1.3fr);align-items:start;gap:20px;direction:ltr;margin:0;font-size:19px;font-weight:800;line-height:1.35}
.bill-number,.amount-summary,.due-date-top{direction:rtl;white-space:nowrap}
.bill-number{align-self:center;justify-self:start;padding-left:8px}
.amount-summary{display:flex;align-items:center;gap:10px;justify-self:center}
.amount-title{white-space:nowrap}
.amount-boxes{display:flex;direction:ltr;gap:5px;text-align:center}
.amount-unit{display:flex;flex-direction:column;align-items:center}
.amount-unit label{font-size:14px;font-weight:bold;line-height:1.05;margin-bottom:1px}
.shaded-box{background:#e2e2e2;border:1.2px solid #555;height:28px;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;padding:0 6px;box-sizing:border-box}
.box-halala{width:48px}
.box-riyal{width:102px}
.due-date-top{justify-self:end;align-self:center;padding-right:3px}
.dots{border-bottom:1.2px dotted #000;display:inline-block;text-align:center;padding:0 3px;color:#0b1a30;min-height:20px;vertical-align:baseline}
.identity-row{direction:rtl;display:flex;align-items:baseline;gap:12px;margin:0;font-size:19px;line-height:1.35;font-weight:800;min-width:0}
.field{display:flex;align-items:baseline;gap:7px;min-width:0}
.name-field{flex:1.35}
.id-field{flex:.9}
.address-field{flex:1.15}
.field-label,.nowrap{white-space:nowrap;flex-shrink:0}
.field-value{flex:1;min-width:15px;white-space:nowrap;overflow:hidden;text-overflow:clip}
.declaration-row{direction:rtl;display:flex;align-items:baseline;gap:6px;font-size:19px;line-height:1.4;font-weight:800;margin:0;white-space:nowrap}
.creditor-value{flex:1;text-align:center}
.amount-words-row{direction:rtl;display:flex;align-items:center;gap:8px;font-size:19px;line-height:1.35;font-weight:800;margin:0;min-width:0}
.box-words{background:#e8e8e8;border:1.2px solid #555;min-height:30px;flex:1;min-width:0;display:flex;align-items:center;padding:1px 9px;font-size:18px;font-weight:800;white-space:nowrap;overflow:hidden}
.installment-no{border-bottom:1px dotted #000;min-width:57px;text-align:center;white-space:nowrap}
.vehicle-row{direction:rtl;display:flex;align-items:baseline;gap:8px;font-size:19px;line-height:1.35;font-weight:800;margin:0;min-width:0}
.car-value{flex:1.05;text-align:center}
.vin-value{flex:1.2;text-align:center}
.paragraph-line{font-size:19px;line-height:1.5;font-weight:800;text-align:justify;margin:0}
.guarantor-pledge{direction:rtl}
.issue-date-row{direction:rtl;display:flex;align-items:baseline;justify-content:flex-start;gap:10px;font-size:19px;line-height:1.4;font-weight:800;margin-top:0;white-space:nowrap}
.weekday-value{min-width:92px}
.issue-date-value{min-width:145px}
.signatures-row{display:flex;justify-content:space-between;align-items:flex-end;font-weight:800;font-size:19px;margin:0;padding:0 8px;gap:6px;position:static}
.signatures-row>div{text-align:center;min-width:72px}
.official-stamp{display:flex!important;flex-direction:column;align-items:center;gap:2px;min-width:82px!important}
.official-stamp .stamp-area{display:block;width:66px;height:18px;border:1.2px dashed #000;border-radius:3px;order:-1}
.royal-decree{font-size:11.5px;line-height:1.4;font-weight:bold;text-align:center;border-top:1px solid #000;padding-top:4px;margin-top:0}
.left-sidebar-box{width:32mm;border:1.8px solid #000;border-radius:8px;position:relative;background:#fff;flex-shrink:0;display:flex;align-items:center;justify-content:center;box-sizing:border-box;padding:0;overflow:hidden}
.left-sidebar-text{transform:rotate(-90deg);transform-origin:center center;white-space:nowrap;text-align:center;font-size:10.5px;line-height:1.25;font-weight:bold;width:112mm;color:#000;margin:0 auto}
.left-sidebar-text .exhibition-name{font-size:14.5px;font-weight:900;font-family:Tajawal,Amiri,serif;display:block;margin-bottom:4px;margin-top:2px;letter-spacing:.2px;-webkit-text-stroke:.2px #000}
.dotted-separator{width:100%;border-top:2px dashed #000;margin:4mm 0;position:relative;text-align:center}
.dotted-separator:after{content:'✂ ---------------------------------------------------------------------------------------------------';position:absolute;top:-10px;left:50%;transform:translateX(-50%);background:#fff;padding:0 10px;font-size:11px;color:#444}
@media screen{body{padding:0 20px 20px}.a5-page{box-shadow:0 0 8px rgba(0,0,0,.12);margin:20px auto}.print-controls{margin:0 -20px}}
@media print{.print-controls{display:none!important}html,body{background:#fff;margin:0;padding:0}.a5-page{margin:0;box-shadow:none;border:0;page-break-after:always;break-after:page}body[data-orientation="portrait"] .a5-page{width:210mm;height:297mm}body[data-orientation="landscape"] .a5-page{width:297mm;height:210mm}}
@page{size:auto;margin:0}
@page bill-landscape{size:A4 landscape;margin:0}
@page bill-portrait{size:A4 portrait;margin:0}`
  const controls=`<div class="print-controls no-print"><span style="font-weight:900;margin-left:8px">اتجاه الكمبيالة:</span><button type="button" data-orientation="portrait">Portrait</button><button type="button" data-orientation="landscape">Landscape</button><button type="button" id="printBtn">طباعة</button></div>`;
  const script=`<script>(()=>{const root=document.body;const setOrientation=(o)=>{root.dataset.orientation=o;document.querySelectorAll('.a5-page').forEach(p=>{p.classList.toggle('portrait',o==='portrait');p.classList.toggle('landscape',o==='landscape')});document.querySelectorAll('.print-controls button[data-orientation]').forEach(b=>b.classList.toggle('active',b.dataset.orientation===o));try{localStorage.setItem('billPrintOrientationV2',o)}catch(_){}};let initial='landscape';try{initial=localStorage.getItem('billPrintOrientationV2')||'landscape'}catch(_){}setOrientation(initial);document.querySelectorAll('.print-controls button[data-orientation]').forEach(b=>b.addEventListener('click',()=>setOrientation(b.dataset.orientation)));document.getElementById('printBtn')?.addEventListener('click',()=>window.print())})()</script>`;
  res.type("html").send(`<html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>كمبيالات معرض الزبيدي</title><style>${css}</style></head><body data-orientation="landscape">${controls}${pages.join("")}${script}</body></html>`);
});

app.get("/api/documents/note/:saleId", (req,res) => {
  const data = db.prepare(`
    SELECT s.*,cu.name customer_name,cu.national_id customer_national_id,cu.national_id_source customer_national_id_source,cu.address customer_address,
           v.make vehicle_make,v.model vehicle_model,v.model_year vehicle_year,v.vin vehicle_vin,
           se.name seller_name,se.national_id seller_national_id,
           g.name guarantor_name,g.national_id guarantor_national_id,g.national_id_source guarantor_national_id_source,
           c.contract_number,c.id contract_id,c.creditor_name,c.promissory_due_mode,c.promissory_due_date,p.note_number,p.party_type
    FROM sales s JOIN customers cu ON cu.id=s.customer_id
    LEFT JOIN vehicles v ON v.id=s.vehicle_id
    LEFT JOIN sellers se ON se.id=s.seller_id
    LEFT JOIN guarantors g ON g.id=s.guarantor_id
    JOIN contracts c ON c.sale_id=s.id
    LEFT JOIN promissory_notes p ON p.contract_id=c.id AND p.party_type='CUSTOMER' AND p.status='OPEN'
    WHERE s.id=?
  `).get(req.params.saleId);
  if (!data) return res.status(404).send("غير موجود");
  if (data.status !== "ACTIVE") return res.status(409).send("البيع ملغى؛ لا يمكن إصدار سند أمر جديد من هذا البيع.");
  if (!data.note_number) return res.status(409).send("لا يوجد سند أمر مفتوح لهذا البيع. راجع سجل السندات ولا تُصدر نسخة جديدة تلقائيًا.");

  const templatePath = path.join(__dirname, "..", "..", "..", "templates", "promissory-note.html");
  let html = fs.readFileSync(templatePath, "utf8");
  const issueDate = data.issue_date || localDateString();
  const d = new Date(`${issueDate}T00:00:00`);
  const gregDate = `${toArabicDigits(String(d.getDate()).padStart(2,"0"))} / ${toArabicDigits(String(d.getMonth()+1).padStart(2,"0"))} / ${toArabicDigits(d.getFullYear())}`;
  const hijri = hijriFromGregorian(issueDate).replace(/ هـ$/," ");
  const amount = Number(data.remaining_amount || 0);
  const amountRiyal = Math.floor(amount);
  const amountHalala = Math.round((amount - amountRiyal) * 100);
  const amountText = amountInWordsArabic(amount);
  const noteSerial = String(data.note_number || data.id || "1").match(/(\d+)$/)?.[1] || String(data.id || "1");
  const finalDue = data.promissory_due_mode === "DATE" && data.promissory_due_date ? data.promissory_due_date : null;
  let dueGreg = "", dueHijri = "";
  if (data.promissory_due_mode === "ON_DEMAND") dueGreg = "لدى الاطلاع";
  else if (data.promissory_due_mode === "DATE" && finalDue) {
    const dueD = new Date(`${finalDue}T00:00:00`);
    dueGreg = `${toArabicDigits(String(dueD.getDate()).padStart(2,"0"))} / ${toArabicDigits(String(dueD.getMonth()+1).padStart(2,"0"))} / ${toArabicDigits(dueD.getFullYear())}`;
    dueHijri = hijriFromGregorian(finalDue).replace(/ هـ$/," ");
  }
  const payload = {
    serial: toArabicDigits(noteSerial),
    issueDate: gregDate,
    issueHijri: hijri,
    debtorName: data.customer_name || "",
    nationalId: toArabicDigits(data.customer_national_id || ""),
    nationalIdSource: data.customer_national_id_source || "",
    dueMode: data.promissory_due_mode || "BLANK",
    creditorName: data.creditor_name || (data.transaction_mode === "INTERMEDIARY" ? data.seller_name : "أحمد متعب علي الزبيدي"),
    sellerName: data.seller_name || data.creditor_name || "أحمد متعب علي الزبيدي",
    guarantorName: data.guarantor_name || "",
    amountWords: amountText,
    against: [data.vehicle_make, data.vehicle_model, data.vehicle_year].filter(v => v !== null && v !== undefined && String(v).trim() !== "").join(" ") + (data.vehicle_vin ? ` رقم الهيكل ${String(data.vehicle_vin).replace(/[^A-Za-z0-9]/g, "")}` : ""),
    dueDate: dueGreg,
    dueHijri,
    paymentAmount: formatAmountDigits(amount),
    paymentAmountLine: formatAmountDigits(amount),
    makerName: data.customer_name || "",
    makerId: toArabicDigits(data.customer_national_id || "")
  };
  const injected = `<script>
  const D=${safeJson(payload)};
  const put=(id,v)=>{const e=document.getElementById(id);if(e)e.textContent=v||""};
  Object.entries(D).forEach(([k,v])=>put(k,v));
  if(D.dueMode==="ON_DEMAND"){const parts=document.querySelectorAll(".due-part");if(parts[0]){const suffix=parts[0].querySelector("span:last-child");if(suffix)suffix.style.display="none";}if(parts[1])parts[1].style.display="none";}
  window.addEventListener('load',()=>setTimeout(()=>window.print(),250));
  </script>`;
  html = html.replace('</body>', `${injected}</body>`);
  res.type("html").send(html);
});

app.get("/api/documents/guarantor-note/:saleId", (req,res) => {
  const data = db.prepare(`
    SELECT s.*,cu.name customer_name,cu.national_id customer_national_id,
           v.make vehicle_make,v.model vehicle_model,v.model_year vehicle_year,v.vin vehicle_vin,
           g.name guarantor_name,g.national_id guarantor_national_id,g.national_id_source guarantor_national_id_source,
           c.contract_number,c.id contract_id,c.creditor_name,c.promissory_due_mode,c.promissory_due_date,p.note_number,p.amount
    FROM sales s
    JOIN customers cu ON cu.id=s.customer_id
    LEFT JOIN vehicles v ON v.id=s.vehicle_id
    LEFT JOIN guarantors g ON g.id=s.guarantor_id
    JOIN contracts c ON c.sale_id=s.id
    LEFT JOIN promissory_notes p ON p.contract_id=c.id AND p.party_type='GUARANTOR' AND p.status='OPEN'
    WHERE s.id=?
  `).get(req.params.saleId);
  if (!data) return res.status(404).send("سند الكفيل غير موجود");
  if (data.status !== "ACTIVE") return res.status(409).send("البيع ملغى؛ لا يمكن إصدار سند كفالة جديد من هذا البيع.");
  if (!data.guarantor_name || !data.note_number) return res.status(404).send("لا يوجد سند كفيل مفتوح لهذا البيع");
  const templatePath = path.join(__dirname, "..", "..", "..", "templates", "promissory-note.html");
  let html = fs.readFileSync(templatePath, "utf8");
  const issueDate = data.issue_date || localDateString();
  const d = new Date(`${issueDate}T00:00:00`);
  const gregDate = `${toArabicDigits(String(d.getDate()).padStart(2,"0"))} / ${toArabicDigits(String(d.getMonth()+1).padStart(2,"0"))} / ${toArabicDigits(d.getFullYear())}`;
  const hijri = hijriFromGregorian(issueDate).replace(/ هـ$/," ");
  const amount = Number(data.amount || data.remaining_amount || 0);
  const amountRiyal = Math.floor(amount);
  const amountHalala = Math.round((amount - amountRiyal) * 100);
  const amountText = amountInWordsArabic(amount);
  const finalDue = data.promissory_due_mode === "DATE" && data.promissory_due_date ? data.promissory_due_date : null;
  let dueGreg = "", dueHijri = "";
  if (data.promissory_due_mode === "ON_DEMAND") dueGreg = "لدى الاطلاع";
  else if (data.promissory_due_mode === "DATE" && finalDue) {
    const dueD = new Date(`${finalDue}T00:00:00`);
    dueGreg = `${toArabicDigits(String(dueD.getDate()).padStart(2,"0"))} / ${toArabicDigits(String(dueD.getMonth()+1).padStart(2,"0"))} / ${toArabicDigits(dueD.getFullYear())}`;
    dueHijri = hijriFromGregorian(finalDue).replace(/ هـ$/," ");
  }
  const noteSerial = String(data.note_number).match(/(\d+)$/)?.[1] || String(data.note_number);
  const payload = {serial:toArabicDigits(noteSerial),issueDate:gregDate,issueHijri:hijri,debtorName:data.guarantor_name,nationalId:toArabicDigits(data.guarantor_national_id||""),nationalIdSource:data.guarantor_national_id_source||"",dueMode:data.promissory_due_mode||"BLANK",creditorName:data.creditor_name||"أحمد متعب علي الزبيدي",amountWords:amountText,against:[data.vehicle_make,data.vehicle_model,data.vehicle_year].filter(v=>v!==null&&v!==undefined&&String(v).trim()!=="").join(" ")+(data.vehicle_vin?` رقم الهيكل ${String(data.vehicle_vin).replace(/[^A-Za-z0-9]/g,"")}`:""),dueDate:dueGreg,dueHijri,paymentAmount:formatAmountDigits(amount),paymentAmountLine:formatAmountDigits(amount),makerName:data.guarantor_name,makerId:toArabicDigits(data.guarantor_national_id||"")};
  const injected = `<script>const D=${safeJson(payload)};const put=(id,v)=>{const e=document.getElementById(id);if(e)e.textContent=v||""};Object.entries(D).forEach(([k,v])=>put(k,v));if(D.dueMode==="ON_DEMAND"){const parts=document.querySelectorAll(".due-part");if(parts[0]){const suffix=parts[0].querySelector("span:last-child");if(suffix)suffix.style.display="none";}if(parts[1])parts[1].style.display="none";}window.addEventListener('load',()=>setTimeout(()=>window.print(),250));</script>`;
  html=html.replace('</body>',`${injected}</body>`);
  res.type("html").send(html);
});

// Serve the built React app in production
}
