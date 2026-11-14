// نموذج ورقي لإقرار استلام السيارة والتصرف فيها، مطابق للنموذج الورقي المرفق.
export function registerVehicleReceiptRoutes(app, { db, documentPage, escapeHtml, hijriFromGregorian, toArabicDigits }) {
  app.get("/api/documents/vehicle-receipt/:saleId", (req, res) => {
    const sale = db.prepare(`SELECT s.id,s.sale_number,s.sale_date,s.status,
      cu.name customer_name,cu.national_id customer_national_id,cu.national_id_source customer_national_id_source,
      v.make,v.model,v.model_year,v.plate_number,v.vin,
      c.contract_number,se.name seller_name
      FROM sales s
      JOIN customers cu ON cu.id=s.customer_id
      JOIN vehicles v ON v.id=s.vehicle_id
      LEFT JOIN contracts c ON c.sale_id=s.id
      LEFT JOIN sellers se ON se.id=s.seller_id
      WHERE s.id=?`).get(req.params.saleId);

    if (!sale) return res.status(404).json({ error: "البيع غير موجود" });
    if (sale.status !== "ACTIVE") return res.status(409).json({ error: "لا يمكن إصدار إقرار استلام لبيع ملغى" });

    const h = (value) => escapeHtml(value ?? "");
    const arabic = (value) => toArabicDigits(String(value ?? ""));
    const contractDate = sale.sale_date || "";
    const hijriDate = contractDate ? hijriFromGregorian(contractDate).replace(/ هـ?$/, "") : "";
    const vehicleType = sale.make || "";
    const vehicleModel = sale.model || "";
    const contractNumber = sale.contract_number || sale.sale_number || "";

    // السطر المنقّط في النموذج الأصلي؛ القيمة تكتب فوق السطر وتبقى المسافات محفوظة للطباعة.
    const line = (label, value = "", width = "230px") => `
      <span class="field-line">
        <span class="field-label">${h(label)}</span>
        <span class="field-value fit-text" style="width:${width};max-width:100%">${h(value)}</span>
      </span>`;

    const dateParts = (() => {
      if (!hijriDate) return { day: "", month: "", year: "" };
      const parts = hijriDate.match(/(\d+)\D+(\d+)\D+(\d+)/);
      if (!parts) return { day: "", month: "", year: "" };
      return { day: arabic(parts[1]), month: arabic(parts[2]), year: arabic(parts[3]) };
    })();

    const body = `
      <style>
        .vehicle-receipt-shell{font-family:Tahoma,Arial,sans-serif;color:#111}
        .paper-actions{margin:0 0 10px;text-align:left;display:flex;align-items:center;justify-content:flex-end;gap:10px;flex-wrap:wrap}
        .paper-actions label{font-size:12px;font-weight:700;display:inline-flex;align-items:center;gap:6px}
        .paper-actions button{border:1px solid #c9ced6;background:#fff;border-radius:7px;padding:7px 12px;cursor:pointer;font-family:inherit;font-weight:700}
        .receipt-input{font:inherit;font-weight:700;border:1px solid #cbd5e1;border-radius:5px;background:#fff;outline:none;text-align:center;padding:5px 7px;min-height:30px}
        .receipt-input.customs{width:190px}
        .receipt-input.gregorian{width:155px;direction:ltr}
        .vehicle-receipt-paper{direction:rtl;font-family:Tahoma,Arial,sans-serif;color:#111;background:#fff;min-height:258mm;padding:5mm 8mm 4mm;box-sizing:border-box}
        .vehicle-receipt-paper *{box-sizing:border-box}
        .paper-head{width:57%;margin-right:0;margin-left:auto;text-align:right;font-weight:700;line-height:1.8;font-size:14px}
        .paper-head .small{font-size:12px;font-weight:700}
        .paper-title{text-align:center;font-size:22px;font-weight:800;text-decoration:underline;text-underline-offset:6px;margin:34px 0 34px}
        .paper-content{font-size:16px;font-weight:600;line-height:2.05}
        .paper-row{display:flex;flex-wrap:nowrap;align-items:flex-end;gap:5px 10px;margin-bottom:10px;width:100%}
        .field-line{display:inline-flex;align-items:flex-end;gap:4px;white-space:nowrap;min-width:0;flex:0 1 auto}
        .field-label{font-weight:700;white-space:nowrap;flex:0 0 auto}
        .field-value{display:inline-block;min-height:24px;border-bottom:2px dotted #111;padding:0 4px 1px;text-align:center;font-weight:600;min-width:0;flex:0 1 auto;overflow:hidden;white-space:nowrap;vertical-align:bottom}
        .field-value.blank{min-width:0}
        .field-value.lg{min-width:0}
        .field-value.md{min-width:0}
        .field-value.sm{min-width:0}
        .fit-text{font-size:inherit;}
        .paper-row > .field-line{flex:0 1 auto}
        .paper-row > .field-line .field-value{flex:1 1 auto}
        .long-line{display:flex;align-items:flex-end;gap:5px;width:100%;margin:0 0 10px}
        .long-line .field-value{flex:1;min-width:0;text-align:right}
        .manual-value{min-width:140px;display:inline-block;border-bottom:2px dotted #111;padding:0 5px 1px;text-align:center;font-weight:700;min-height:24px}
        .manual-value.empty{color:#666}
        .statement{text-align:center;margin:22px 0 0;font-size:16px;font-weight:700;line-height:2.1}
        .witness{text-align:center;margin-top:0;font-size:16px;font-weight:700}
        .ack-title{margin-top:44px;margin-right:13%;font-size:16px;font-weight:800}
        .signature-block{width:58%;margin-right:6%;font-size:16px;font-weight:600;line-height:2.8;position:relative}
        .signature-line{display:flex;align-items:flex-end;gap:8px}
        .signature-line .field-label{white-space:nowrap}
        .signature-line .field-value{flex:1;text-align:right;min-width:0}
        .signature-with-stamp{display:flex;align-items:flex-end;gap:24mm;margin-top:10px}
        .signature-with-stamp .signature-line{flex:1;min-width:0}
        .official-stamp-box{width:18mm;height:18mm;border:0;display:flex;align-items:center;justify-content:center;padding:0;flex:0 0 auto;margin-left:5mm;transform:translateY(11mm)}
        .official-stamp-box .stamp-title{font-size:15px;font-weight:800;white-space:nowrap}
        @media print{
          .paper-actions{display:none}
          .vehicle-receipt-paper{padding:5mm 8mm 4mm;min-height:277mm;width:210mm;max-width:210mm;margin:0 auto}
          .paper-row{break-inside:avoid;page-break-inside:avoid}
          .manual-value{border-bottom:2px dotted #111}
        }
        @page{size:A4 portrait;margin:0}
      </style>

      <div class="vehicle-receipt-shell">
        <div class="paper-actions">
          <label>رقم البطاقة الجمركية:
            <input id="receipt-customs-input" class="receipt-input customs" type="text" placeholder="أدخل الرقم قبل الطباعة" />
          </label>
          <button type="button" data-document-action="print">طباعة / حفظ PDF</button>
        </div>

        <div class="vehicle-receipt-paper">
          <div class="paper-head">
            <div>مؤسسة أحمد متعب علي الزبيدي لبيع وشراء السيارات</div>
            <div class="small">تصريح مرور رقم ١٧٣/ر/ع</div>
            <div class="small">ص. ب ٩٠ &nbsp;&nbsp; الرمز البريدي ٢١٩٦٢</div>
            <div class="small">جوال : ٠٥٤٦١٦٦٧٩</div>
          </div>

          <div class="paper-title">إقرار استلام سيارة والتصرف فيها</div>

          <div class="paper-content">
            <div class="paper-row">
              ${line("أقر أنا :", sale.customer_name, "175px")}
              ${line("بالهوية الوطنية :", arabic(sale.customer_national_id), "125px")}
              ${line("وتاريخ :", `${dateParts.day} / ${dateParts.month} / ${dateParts.year} هـ`, "100px")}
            </div>

            <div class="paper-row">
              ${line("صادرة من :", sale.customer_national_id_source || "", "430px")}
            </div>

            <div class="paper-row">
              ${line("بأنني استلمت السيارة نوع :", vehicleType, "115px")}
              ${line("موديل :", vehicleModel, "95px")}
              ${line("سنة الصنع :", arabic(sale.model_year), "65px")}
              ${line("رقم لوحة :", sale.plate_number, "95px")}
            </div>

            <div class="paper-row">
              ${line("ورقم هيكل :", String(sale.vin || "").replace(/[^A-Za-z0-9]/g, ""), "185px")}
              <span class="field-line"><span class="field-label">رقم بطاقة جمركية :</span><span id="receipt-customs-value" class="manual-value empty">—</span></span>
            </div>

            <div class="long-line">
              <span class="field-label">المباعة علي من السيد :</span>
              <span class="field-value">${h(sale.seller_name || "أحمد متعب علي الزبيدي")}</span>
            </div>

            <div class="paper-row" style="margin-top:2px">
              ${line("بموجب عقد البيع رقم :", contractNumber, "220px")}
              ${line("وتاريخ :", `${dateParts.day} / ${dateParts.month} / ${dateParts.year} هـ`, "160px")}
            </div>

            <div class="statement">وهذا إقرار مني باستلام السيارة المدونة بياناتها أعلاه والتصرف فيها.</div>
            <div class="witness">هذا والله خير الشاهدين</div>
          </div>

          <div class="ack-title">المقر بما فيه</div>
          <div class="signature-block">
            <div class="signature-line"><span class="field-label">الاسم :</span><span class="field-value">${h(sale.customer_name || "")}</span></div>
            <div class="signature-with-stamp">
              <div class="signature-line"><span class="field-label">التوقيع :</span><span class="field-value"></span></div>
              <div class="official-stamp-box"><span class="stamp-title">الختم</span></div>
            </div>
            <div class="signature-line"><span class="field-label">التاريخ الهجري :</span><span id="receipt-sign-date-value" class="manual-value"></span></div>
          </div>
        </div>
      </div>

      <script>
        (() => {
          const customsInput = document.getElementById('receipt-customs-input');
          const customsOut = document.getElementById('receipt-customs-value');
          const signDateOut = document.getElementById('receipt-sign-date-value');
          const fitFields = () => {
            document.querySelectorAll('.vehicle-receipt-paper .fit-text, .vehicle-receipt-paper .field-value').forEach(el => {
              el.style.fontSize = '';
              const base = parseFloat(getComputedStyle(el).fontSize) || 16;
              let size = base;
              const min = Math.max(8, base * 0.58);
              while (size > min && el.scrollWidth > el.clientWidth + 1) {
                size -= 0.25;
                el.style.fontSize = size + 'px';
              }
            });
          };
          const currentHijriDate = () => {
            const now = new Date();
            try {
              const parts = new Intl.DateTimeFormat('en-US-u-ca-islamic-umalqura-nu-latn', {
                day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Riyadh'
              }).formatToParts(now);
              const part = type => parts.find(p => p.type === type)?.value || '';
              const day = part('day');
              const month = part('month');
              const year = part('year');
              return day && month && year ? toArabicDigits(day) + ' / ' + toArabicDigits(month) + ' / ' + toArabicDigits(year) + ' هـ' : '';
            } catch { return ''; }
          };
          const sync = () => {
            const customs = String(customsInput?.value || '').trim();
            customsOut.textContent = customs || '—';
            customsOut.classList.toggle('empty', !customs);
            signDateOut.textContent = currentHijriDate() || '—';
            signDateOut.classList.toggle('empty', !signDateOut.textContent || signDateOut.textContent === '—');
          };
          customsInput?.addEventListener('input', sync);
          sync();
          fitFields();
          window.addEventListener('beforeprint', fitFields);
          window.addEventListener('resize', fitFields);
          requestAnimationFrame(fitFields);
        })();
      </script>
    `;

    res.type("html").send(documentPage("إقرار استلام سيارة والتصرف فيها", body));
  });
}
