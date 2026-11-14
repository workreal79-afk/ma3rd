import React,{useEffect,useRef} from "react";

export function LoadError({ error, onRetry }) {
  return (
    <div className="loadError">
      <b>تعذر تحميل البيانات</b>
      <div>{error}</div>
      <button className="primary" onClick={onRetry}>إعادة المحاولة</button>
    </div>
  );
}

export function Modal({ title, onClose, children }) {
  const overlayRef = useRef(null);
  const closeRef = useRef(null);
  const onCloseRef = useRef(onClose);
  const hasForm = React.Children.toArray(children).some(child => React.isValidElement(child) && child.type === "form");
  onCloseRef.current = onClose;
  useEffect(() => {
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    const overlay = overlayRef.current;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const handleKeyDown = event => {
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (dialogs[dialogs.length - 1] !== overlay) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !overlay) return;
      const focusable = Array.from(overlay.querySelectorAll(
        'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
      )).filter(element => {
        const style = window.getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden";
      });
      if (!focusable.length) {
        event.preventDefault();
        overlay.querySelector(".modal")?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === overlay)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);
  return (
    <div ref={overlayRef} className="overlay" role="dialog" aria-modal="true" aria-label={title} onClick={event => {
      if (event.target === event.currentTarget) onCloseRef.current();
    }}>
      <div className="modal" tabIndex="-1">
        <div className="modalHead">
          <h3>{title}</h3>
          <button ref={closeRef} className="iconBtn" type="button" onClick={onClose} aria-label="إغلاق">×</button>
        </div>
        {hasForm&&<div className="formIntro">
          <div className="formIntroArt" aria-hidden="true">
            <svg viewBox="0 0 48 48" fill="none">
              <rect x="10" y="7" width="25" height="32" rx="6" fill="currentColor" opacity=".12"/>
              <path d="M17 17h11M17 23h11M17 29h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              <circle cx="34" cy="33" r="8" fill="#fff" stroke="currentColor" strokeWidth="2"/>
              <path d="m31 33 2 2 4-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <div className="formIntroCopy"><b>أدخل التفاصيل خطوة بخطوة</b><span>أكمل البيانات الأساسية ثم راجعها قبل الحفظ</span></div>
          <span className="formIntroBadge">نموذج منظم</span>
        </div>}
        <div className="modalBody">{children}</div>
      </div>
    </div>
  );
}

export function Stat({ title, value }) {
  const label=String(title??"");
  let icon="spark";
  if(label.includes("قيمة المخزون")) icon="money";
  else if(label.includes("سيار")||label.includes("مخزون")) icon="vehicle";
  else if(label.includes("متأخر")||label.includes("فشل")) icon="alert";
  else if(label.includes("رسائل")||label.includes("رابط")||label.includes("أُرسلت")) icon="message";
  else if(label.includes("سقف")) icon="shield";
  else if(label.includes("مصروف")||label.includes("إيصال")) icon="receipt";
  else if(label.includes("حجز")||label.includes("محجوز")) icon="calendar";
  else if(label.includes("مباع")||label.includes("مبيع")||label.includes("بيع")) icon="trend";
  else if(label.includes("قسط")||label.includes("تحصيل")||label.includes("مستحق")||label.includes("متبقي")) icon="money";
  const toneByIcon={vehicle:"blue",receipt:"blue",alert:"amber",calendar:"amber",message:"violet",shield:"violet",spark:"violet",money:"teal",trend:"teal"};
  const tone=toneByIcon[icon];
  const paths={
    vehicle:<><path d="m5 17 1.6-6.1A2.5 2.5 0 0 1 9 9h6a2.5 2.5 0 0 1 2.4 1.9L19 17v2h-2v-2H7v2H5v-2Z"/><path d="M7 13h10M8 16h.01M16 16h.01"/></>,
    money:<><rect x="4" y="7" width="16" height="12" rx="3"/><path d="M4 10V7a2 2 0 0 1 2-2h11M16 13h4v3h-4a1.5 1.5 0 0 1 0-3Z"/></>,
    alert:<><circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/></>,
    message:<><path d="M5 6.5h14A2.5 2.5 0 0 1 21.5 9v7a2.5 2.5 0 0 1-2.5 2.5h-7L7 21v-2.5H5A2.5 2.5 0 0 1 2.5 16V9A2.5 2.5 0 0 1 5 6.5Z"/><path d="M7 11h10M7 14.5h7"/></>,
    shield:<><path d="M12 3 19 6v5c0 4.5-2.8 7.8-7 10-4.2-2.2-7-5.5-7-10V6l7-3Z"/><path d="m9 12 2 2 4-4"/></>,
    receipt:<><path d="M6 4h12v17l-3-2-3 2-3-2-3 2V4Z"/><path d="M9 9h6M9 13h6"/></>,
    calendar:<><rect x="4" y="5" width="16" height="15" rx="3"/><path d="M8 3v4M16 3v4M4 10h16M8 14h3"/></>,
    trend:<><path d="M4 18V6M4 18h16"/><path d="m7 14 4-4 3 2 5-6"/><path d="M15 6h4v4"/></>,
    spark:<><path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z"/><path d="m19 15 .9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15Z"/></>
  };
  return <div className="stat" data-tone={tone}><span className="statIcon" aria-hidden="true"><svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[icon]}</svg></span><div className="statLabel">{title}</div><strong>{value}</strong></div>;
}

export function Loading() {
  return (
    <div className="empty">
      جاري التحميل...
      <div className="muted">إذا استمر التحميل أكثر من عدة ثوانٍ تأكد أن الخادم يعمل ثم أعد المحاولة.</div>
    </div>
  );
}

export function Table({ headers, rows }) {
  return (
    <div className="tableWrap">
      <table>
        <thead><tr>{headers.map(h => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>
          {rows.length
            ? rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)
            : <tr><td colSpan={headers.length} className="empty">لا توجد بيانات</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export function RecordCards({ title, description, rows, emptyMessage = "لا توجد بيانات مطابقة." }) {
  return (
    <section className="panel recordCardsPanel" aria-label={title}>
      <div className="recordCardsHead">
        <div><h3>{title}</h3><p>{description}</p></div>
        <span className="recordCount">عدد السجلات {rows.length.toLocaleString("ar-SA")}</span>
      </div>
      <div className="recordCardTableWrap">
        <table className="recordCardTable">
          <thead><tr><th scope="col">بيانات السجل</th><th scope="col">الإجراءات</th></tr></thead>
          <tbody>
            {rows.length
              ? rows.map(row => <tr key={row.key}><td>{row.details}</td><td>{row.actions}</td></tr>)
              : <tr><td colSpan={2} className="recordCardsEmpty">{emptyMessage}</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function Status({ s }) {
  const map = {
    PAID: ["مدفوع", "green"],
    OVERDUE: ["متأخر", "red"],
    DUE: ["مستحق", "orange"],
    PARTIALLY_PAID: ["جزئي", "blue"],
    UPCOMING: ["قادم", "gray"]
  };
  const [t, c] = map[s] || [s || "-", "gray"];
  return <span className={`badge ${c}`}>{t}</span>;
}

// حالات مخزون السيارات (متاحة/محجوزة/مباعة) — منفصلة عن حالات الأقساط.
// كانت صفحة السيارات تمرر IN_STOCK/RESERVED/SOLD إلى Status فتظهر «قادم/مستحق/مدفوع».
export function VehicleStatus({ s }) {
  const map = {
    IN_STOCK: ["متاحة", "green"],
    RESERVED: ["محجوزة", "orange"],
    SOLD: ["مباعة", "blue"],
    ARCHIVED: ["مؤرشفة", "gray"]
  };
  const [t, c] = map[String(s ?? "").trim().toUpperCase()] || [s || "-", "gray"];
  return <span className={`badge ${c}`}>{t}</span>;
}

export function BillStatus({ s }) {
  const map = {
    PAID: ["مدفوعة", "green"],
    OVERDUE: ["متأخرة", "red"],
    DUE: ["مستحقة", "orange"],
    PARTIAL: ["جزئية", "blue"],
    OPEN: ["مفتوحة", "gray"]
  };
  const [t, c] = map[s] || [s || "-", "gray"];
  return <span className={`badge ${c}`}>{t}</span>;
}

export function Toolbar({ title, button, onClick }) {
  return <div className="toolbar"><h2>{title}</h2>{button && <button className="primary" onClick={onClick}>{button}</button>}</div>;
}

export function Field({ label, v, set, type = "text", placeholder = "", requiredMark = false }) {
  return <label className={`field${requiredMark ? " fieldRequired" : ""}`}><span>{label}</span><input type={type} value={v ?? ""} placeholder={placeholder} aria-required={requiredMark || undefined} onChange={e => set(e.target.value)} /></label>;
}

export function Select({ label, value, onChange, options }) {
  return <label className="field"><span>{label}</span><select value={value ?? ""} onChange={e => onChange(e.target.value)}><option value="">اختر...</option>{options.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>;
}

export class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) return <div className="loadError"><b>حدث خطأ في الواجهة</b><div>{this.state.error.message}</div><button className="primary" onClick={() => window.location.reload()}>إعادة تحميل الصفحة</button></div>;
    return this.props.children;
  }
}
