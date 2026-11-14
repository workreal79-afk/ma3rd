import { isValidDateString } from "./date.js";
import { escapeHtml } from "./format.js";
export function toArabicDigits(str="") { return String(str).replace(/\d/g,d=>"٠١٢٣٤٥٦٧٨٩"[d]); }
export function formatDateArabic(dateString) { if(!dateString) return "-"; if(!isValidDateString(dateString)) return escapeHtml(String(dateString)); const [y,m,d]=String(dateString).split("-").map(Number); if(!y||!m||!d) return String(dateString); return `${toArabicDigits(String(d).padStart(2,"0"))} / ${toArabicDigits(String(m).padStart(2,"0"))} / ${toArabicDigits(String(y))} م`; }
export function hijriFromGregorian(dateString) { try { return new Intl.DateTimeFormat("ar-SA-u-ca-islamic-umalqura",{day:"2-digit",month:"2-digit",year:"numeric"}).format(new Date(`${dateString}T00:00:00`)); } catch(_) { return ""; } }

const AR_ONES = ["", "واحد", "اثنان", "ثلاثة", "أربعة", "خمسة", "ستة", "سبعة", "ثمانية", "تسعة"];
const AR_TEENS = ["عشرة", "أحد عشر", "اثنا عشر", "ثلاثة عشر", "أربعة عشر", "خمسة عشر", "ستة عشر", "سبعة عشر", "ثمانية عشر", "تسعة عشر"];
const AR_TENS = ["", "", "عشرون", "ثلاثون", "أربعون", "خمسون", "ستون", "سبعون", "ثمانون", "تسعون"];

function arabicHundreds(n) {
  if (n < 10) return AR_ONES[n];
  if (n < 20) return AR_TEENS[n - 10];
  if (n < 100) {
    const ones = n % 10, tens = Math.floor(n / 10);
    return ones ? `${AR_ONES[ones]} و${AR_TENS[tens]}` : AR_TENS[tens];
  }
  const hundreds = Math.floor(n / 100), rest = n % 100;
  const names = ["", "مائة", "مائتان", "ثلاثمائة", "أربعمائة", "خمسمائة", "ستمائة", "سبعمائة", "ثمانمائة", "تسعمائة"];
  return rest ? `${names[hundreds]} و${arabicHundreds(rest)}` : names[hundreds];
}

function arabicGroup(n, singular, dual, plural) {
  if (n === 1) return singular;
  if (n === 2) return dual;
  if (n >= 3 && n <= 10) return `${arabicHundreds(n)} ${plural}`;
  return `${arabicHundreds(n)} ${singular}`;
}

export function amountInWordsArabic(value) {
  let n = Math.round(Number(value || 0) * 100) / 100;
  if (!Number.isFinite(n)) n = 0;
  const whole = Math.floor(Math.abs(n));
  const halala = Math.round((Math.abs(n) - whole) * 100);
  if (whole === 0 && halala === 0) return "صفر ريال سعودي";
  const parts = [];
  let remainder = whole;
  const billions = Math.floor(remainder / 1_000_000_000); remainder %= 1_000_000_000;
  const millions = Math.floor(remainder / 1_000_000); remainder %= 1_000_000;
  const thousands = Math.floor(remainder / 1_000); remainder %= 1_000;
  if (billions) parts.push(arabicGroup(billions, "مليار", "ملياران", "مليارات"));
  if (millions) parts.push(arabicGroup(millions, "مليون", "مليونان", "ملايين"));
  if (thousands) {
    if (thousands === 1) parts.push("ألف");
    else if (thousands === 2) parts.push("ألفان");
    else if (thousands >= 3 && thousands <= 10) parts.push(`${arabicHundreds(thousands)} آلاف`);
    else parts.push(`${arabicHundreds(thousands)} ألف`);
  }
  if (remainder) parts.push(arabicHundreds(remainder));
  let text = parts.join(" و");
  if (n < 0) text = `سالب ${text}`;
  text += " ريال سعودي";
  if (halala) text += ` و${arabicHundreds(halala)} هللة`;
  return text;
}

export function documentPage(title, body) {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
  *{box-sizing:border-box} body{font-family:Tahoma,Arial,sans-serif;margin:0;background:#eef2f6;color:#172033;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .page{width:190mm;min-height:277mm;margin:8mm auto;padding:9mm;background:#fff;box-sizing:border-box;border:1px solid #d8dee7;border-radius:6px;box-shadow:0 8px 30px rgba(15,23,42,.08)}
  .doc-header{display:grid;grid-template-columns:1fr auto;gap:18px;align-items:start;padding-bottom:12px;border-bottom:2px solid #243447;margin-bottom:14px}
  .brand-title{font-size:22px;font-weight:800;margin:0 0 3px;color:#152238}.brand-sub{font-size:11px;color:#5b6678;line-height:1.7}.doc-title{font-size:22px;font-weight:800;margin:0 0 4px;color:#172033}.doc-subtitle{font-size:11px;color:#667085}
  .doc-meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 18px;margin-bottom:14px}.meta-item{display:flex;gap:6px;align-items:baseline;font-size:11.5px}.meta-item b{color:#596579;white-space:nowrap}.meta-item span{font-weight:700}
  .summary-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:9px;margin:12px 0 16px}.summary-card{border:1px solid #dfe5ec;background:#f8fafc;border-radius:8px;padding:10px 11px}.summary-card span{display:block;font-size:10px;color:#687386;margin-bottom:4px}.summary-card strong{display:block;font-size:16px;color:#152238}
  .section-title{font-size:13px;font-weight:800;margin:16px 0 8px;padding-right:8px;border-right:4px solid #243447;color:#172033}
  .table-wrap{overflow:visible}.doc-table{width:100%;border-collapse:collapse;font-size:10.5px}.doc-table th{background:#eef2f6;color:#344054;font-weight:800;padding:8px 6px;border:1px solid #d8dee7;text-align:center;white-space:nowrap}.doc-table td{padding:7px 6px;border:1px solid #e1e6ed;text-align:center;vertical-align:middle}.doc-table tbody tr:nth-child(even) td{background:#fbfcfd}
  .num{font-variant-numeric:tabular-nums;direction:rtl}.status-pill{display:inline-block;padding:3px 8px;border-radius:99px;font-size:9px;font-weight:800;border:1px solid #d8dee7}.status-paid{background:#ecfdf3;color:#087443;border-color:#b7ebcc}.status-partial{background:#eff6ff;color:#175cd3;border-color:#c7d7fe}.status-overdue{background:#fff1f3;color:#c01048;border-color:#fecdd6}.status-due{background:#fff7ed;color:#c4320a;border-color:#fed7aa}.status-open{background:#f8fafc;color:#475467}
  .total-row td{font-weight:800;background:#f5f7fa!important}.grand-total{display:flex;justify-content:space-between;gap:15px;align-items:center;border:1px solid #cfd7e3;background:#f8fafc;border-radius:9px;padding:11px 13px;margin-top:12px;font-weight:800}.grand-total .value{font-size:18px}
  .receipt-card{border:1.5px solid #1e293b;border-radius:10px;overflow:hidden}.receipt-top{padding:14px 16px;border-bottom:2px solid #1e293b;display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.receipt-brand{font-size:19px;font-weight:900}.receipt-brand small{display:block;font-size:10px;font-weight:600;color:#667085;margin-top:3px}.receipt-number{font-size:13px;font-weight:800;text-align:left}.receipt-number span{display:inline-block;min-width:100px;margin-right:5px;padding-bottom:2px;border-bottom:1px dotted #334155}.receipt-info{display:grid;grid-template-columns:repeat(2,1fr);gap:0;border-bottom:1px solid #d8dee7}.receipt-info .cell{padding:9px 10px;border-left:1px solid #d8dee7;border-bottom:1px solid #d8dee7;font-size:11px}.receipt-info .cell:nth-child(2n){border-left:0}.receipt-info .cell b{color:#5b6678}.amount-highlight{margin:14px;border:2px solid #1e293b;border-radius:8px;padding:12px 14px;text-align:center}.amount-highlight .label{font-size:11px;color:#596579;font-weight:700}.amount-highlight .amount{font-size:24px;font-weight:900;margin:4px 0}.amount-highlight .words{font-size:12px;font-weight:700;color:#253247;line-height:1.6}.receipt-notes{padding:0 14px 14px}.receipt-notes .line{border:1px solid #dfe5ec;border-radius:7px;padding:9px 10px;margin-top:8px;font-size:11px}.signature-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;padding:12px 14px 16px;margin-top:4px}.signature-box{border-top:1px solid #334155;text-align:center;padding-top:8px;font-size:11px;color:#475467;min-height:42px}.receipt-footer{border-top:1px dashed #aab4c2;padding:8px 14px;font-size:9px;color:#6b7280;display:flex;justify-content:space-between;gap:10px}
  .page-break{page-break-before:always}.print-actions{margin-bottom:10px;text-align:left}.print-actions button{border:1px solid #cbd5e1;background:#fff;border-radius:7px;padding:7px 11px;cursor:pointer}
  @media print{body{background:#fff}.page{border:0;border-radius:0;box-shadow:none;margin:0;width:190mm;min-height:277mm;padding:8mm}.print-actions{display:none}.doc-table{font-size:10px}.summary-grid{gap:7px}.summary-card{padding:8px}.receipt-card{break-inside:avoid}}
  @page{size:A4 portrait;margin:0}
  </style></head><body><div class="page">${body}</div></body></html>`;
}
export function tafqeet(riyalVal, halalaVal) { const n=Number(riyalVal||0), h=Number(halalaVal||0); const r=Math.floor(n); return `${r.toLocaleString("ar-SA")} ريال${h?` و${toArabicDigits(String(h).padStart(2,"0"))} هللة`:""}`; }
