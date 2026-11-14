import React, { useEffect, useMemo, useState } from "react";
import { api } from "../services/api.js";
import { errorMessage } from "../lib/errors.js";
import { LoadError, Loading, Modal, Stat, Table } from "../components/ui.jsx";

// صفحة إعدادات واتساب: كل خيار يريده صاحب المعرض قابل للتعديل من هنا —
// المزوّد، أنواع الرسائل، سياسة التذكيرات، فترة سماح الكفيل، ونصوص القوالب نفسها.

const TABS = [
  ["sending", "الإرسال", "📤"],
  ["messages", "الرسائل", "✉️"],
  ["reminders", "التذكيرات", "⏰"],
  ["templates", "القوالب", "📝"],
  ["log", "السجل", "📜"],
];

const ROLES = {
  CUSTOMER: "المشتري",
  SELLER: "مالك المركبة",
  SHOWROOM: "صاحب المعرض",
  GUARANTOR: "الكفيل",
};

const KINDS = {
  COLLECTION_INVOICE: "فاتورة تحصيل",
  DUE_REMINDER: "تذكير استحقاق",
  OVERDUE_REMINDER: "تذكير تأخير",
  PAYMENT_RECEIPT: "إيصال سداد",
  GUARANTOR_NOTICE: "إشعار كفيل",
};

const STATUSES = {
  LINK_READY: ["رابط جاهز", "blue"],
  SENT: ["أُرسلت", "green"],
  FAILED: ["فشلت", "red"],
  QUEUED: ["في الانتظار", "gray"],
};

const WEEKDAYS = [["0", "الأحد"], ["1", "الاثنين"], ["2", "الثلاثاء"], ["3", "الأربعاء"], ["4", "الخميس"], ["5", "الجمعة"], ["6", "السبت"]];

// قيم تجريبية لمعاينة القالب في الواجهة دون استدعاء الخادم.
const SAMPLE = {
  showroom: "معرض الزبيدي للسيارات", currency: "ر.س", customer: "أحمد محمد",
  guarantor: "خالد العتيبي", owner: "مؤسسة النخبة", sale: "SALE-000123", mode: "مالك خارجي",
  vehicle: "تويوتا كامري 2023 أ ب ج 1001", installment: "3", installments: "12",
  due: "2026-10-15", amount: "٨٬٠٠٠", paid: "٠", remaining: "٨٬٠٠٠", total_due: "١٦٬٠٠٠",
  seller_due: "٤٥٬٠٠٠", days: "7", status_line: "⚠️ متأخر منذ 7 يوم",
  receipt: "REC-000123", method: "تحويل بنكي", date: "2026-09-29",
  link: "https://showroom.example.com/api/documents/schedule/12",
};

const MSG_LABELS = {
  "msg.collectionInvoice.customer": ["فاتورة التحصيل", "للمشتري"],
  "msg.collectionInvoice.owner": ["فاتورة التحصيل", "نسخة للمالك/صاحب المعرض"],
  "msg.dueReminder.customer": ["تذكير قبل الاستحقاق ويوم الاستحقاق", "للمشتري"],
  "msg.overdueReminder.customer": ["تذكير التأخير", "للمشتري"],
  "msg.overdueReminder.guarantor": ["تذكير التأخير", "للكفيل"],
  "msg.paymentReceipt.customer": ["إيصال السداد", "للمشتري"],
  "msg.paymentReceipt.owner": ["إيصال السداد", "نسخة للمالك/صاحب المعرض"],
};

const TEMPLATE_LABELS = {
  "template.collectionInvoice.customer": "فاتورة التحصيل → المشتري",
  "template.collectionInvoice.owner": "فاتورة التحصيل → المالك/صاحب المعرض",
  "template.dueReminder.customer": "تذكير الاستحقاق → المشتري",
  "template.overdueReminder.customer": "تذكير التأخير → المشتري",
  "template.overdueReminder.guarantor": "تذكير التأخير → الكفيل",
  "template.paymentReceipt.customer": "إيصال السداد → المشتري",
  "template.paymentReceipt.owner": "إيصال السداد → المالك/صاحب المعرض",
};

function renderPreview(template) {
  return String(template || "").replace(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi, (_m, key) =>
    Object.prototype.hasOwnProperty.call(SAMPLE, key) ? SAMPLE[key] : "");
}

function Row({ label, hint, children }) {
  return (
    <div className="settingRow">
      <div className="settingLabel"><b>{label}</b>{hint && <small className="muted">{hint}</small>}</div>
      <div className="settingControl">{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange, label }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={Boolean(checked)} onChange={e => onChange(e.target.checked ? "1" : "0")} />
      <span>{label || (checked ? "مفعّل" : "معطّل")}</span>
    </label>
  );
}

export function Messaging({ refresh }) {
  const [tab, setTab] = useState("sending");
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [scheduler, setScheduler] = useState(null);
  const [webStatus, setWebStatus] = useState(null);
  const [plan, setPlan] = useState(null);
  const [log, setLog] = useState({ rows: [], total: 0 });
  const [filters, setFilters] = useState({ kind: "", status: "", search: "" });
  const [testOpen, setTestOpen] = useState(false);
  const [testPhone, setTestPhone] = useState("0551884891");
  const [testResult, setTestResult] = useState(null);

  const set = (key, value) => setDraft(d => ({ ...d, [key]: value }));
  const value = (key) => (key in draft ? draft[key] : data?.settings?.[key] ?? "");
  const bool = (key) => ["1", "true"].includes(String(value(key)).toLowerCase());

  const dirtyKeys = useMemo(() => {
    if (!data) return [];
    return Object.keys(draft).filter(k => String(draft[k]) !== String(data.settings[k] ?? ""));
  }, [draft, data]);

  const load = async () => {
    setError("");
    try {
      const r = await api("/messaging/settings");
      setData(r);
      setDraft({});
    } catch (e) { setError(errorMessage(e)); }
  };

  useEffect(() => { load(); }, [refresh]);

  useEffect(() => {
    if (!data) return;
    api("/messaging/scheduler").then(setScheduler).catch(() => setScheduler(null));
    api("/messaging/whatsapp-web/status").then(setWebStatus).catch(() => setWebStatus(null));
  }, [data]);

  useEffect(() => {
    if (tab !== "log" || !data) return;
    const q = new URLSearchParams({ limit: "100" });
    if (filters.kind) q.set("kind", filters.kind);
    if (filters.status) q.set("status", filters.status);
    if (filters.search) q.set("search", filters.search);
    api(`/messaging/log?${q}`).then(setLog).catch(e => setError(errorMessage(e)));
  }, [tab, filters, data]);

  const save = async () => {
    if (!dirtyKeys.length) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const payload = Object.fromEntries(dirtyKeys.map(k => [k, draft[k]]));
      const r = await api("/messaging/settings", { method: "PUT", body: JSON.stringify(payload) });
      setData(d => ({ ...d, settings: r.settings }));
      setDraft({});
      setNotice(`تم حفظ ${r.saved.length} إعداد`);
    } catch (e) {
      // نعرض سبب كل حقل رفضه الخادم بدل رسالة عامة.
      const details = Array.isArray(e.details) && e.details.length
        ? e.details.map(d => `${d.key}: ${d.error}`).join("  |  ")
        : "";
      setError(details ? `${errorMessage(e)} — ${details}` : errorMessage(e));
    } finally { setBusy(false); }
  };

  const resetTemplates = async () => {
    if (!window.confirm("سيتم استعادة كل القوالب إلى نصها الافتراضي. متابعة؟")) return;
    setBusy(true);
    try {
      const r = await api("/messaging/settings/reset", { method: "POST", body: JSON.stringify({ keys: Object.keys(TEMPLATE_LABELS) }) });
      setData(d => ({ ...d, settings: r.settings }));
      setDraft({});
      setNotice("تمت استعادة القوالب الافتراضية");
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };

  const sendTest = async () => {
    setBusy(true); setTestResult(null);
    try {
      const r = await api("/messaging/test", { method: "POST", body: JSON.stringify({ phone: testPhone }) });
      setTestResult(r);
      // لا نفتح تبويبًا تلقائيًا: المتصفحات تحجبه، والأفضل أن يختار المستخدم الرابط بنفسه.
    } catch (e) { setTestResult({ error: errorMessage(e) }); } finally { setBusy(false); }
  };

  const runReminders = async () => {
    if (!window.confirm("سيتم تجهيز كل تذكيرات اليوم المستحقة. متابعة؟")) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const r = await api("/messaging/reminders/run", { method: "POST", body: JSON.stringify({}) });
      setPlan(r);
      if (r.blocked) setNotice(`لم تُرسل رسائل: ${r.blocks.join("، ")}`);
      else setNotice(`تم تجهيز ${r.sent.length} رسالة (${r.sent.filter(x => x.status === "FAILED").length} فشل)`);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };

  const showPlan = async () => {
    setBusy(true);
    try { setPlan(await api("/messaging/reminders")); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };

  const clearLog = async () => {
    if (!window.confirm("سيتم مسح سجل الرسائل بالكامل. لا يؤثر هذا على البيانات المالية. متابعة؟")) return;
    try { const r = await api("/messaging/log", { method: "DELETE" }); setNotice(`تم مسح ${r.deleted} سجل`); setLog({ rows: [], total: 0 }); }
    catch (e) { setError(errorMessage(e)); }
  };

  if (error && !data) return <LoadError error={error} onRetry={load} />;
  if (!data) return <Loading />;

  const { settings: s, meta, stats } = data;
  const provider = value("whatsapp.provider");

  return (
    <div>
      <div className="toolbar">
        <h2>إعدادات واتساب</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="smallBtn" onClick={() => setTestOpen(true)}>📱 رسالة تجريبية</button>
          <button className="smallBtn" onClick={load}>تحديث</button>
          {dirtyKeys.length > 0 &&
            <button className="primary" onClick={save} disabled={busy}>حفظ ({dirtyKeys.length})</button>}
        </div>
      </div>

      {error && <div className="box error">{error}</div>}
      {notice && <div className="box ok">{notice}</div>}

      <div className="stats">
        <Stat title="إجمالي الرسائل" value={stats.total || 0} />
        <Stat title="اليوم" value={stats.today || 0} />
        <Stat title="روابط جاهزة" value={stats.link_ready || 0} />
        <Stat title="أُرسلت" value={stats.sent || 0} />
        <Stat title="فشلت" value={stats.failed || 0} />
        <Stat title="السقف اليومي" value={value("reminder.dailyCap") || s["reminder.dailyCap"]} />
      </div>

      <div className="tabs">
        {TABS.map(([id, title, icon]) => (
          <button key={id} className={tab === id ? "tab active" : "tab"} onClick={() => setTab(id)}>
            <span>{icon}</span> {title}
          </button>
        ))}
      </div>

      {tab === "sending" && (
        <section className="panel">
          <div className="panelTitle"><h3>طريقة الإرسال وهوية المعرض</h3>
            <span className="muted">WhatsApp Web المحلي مجاني ولا يحتاج API مدفوع. بعد أول ربط بالـQR تصبح الجلسة محفوظة على نفس الجهاز.</span></div>

          <Row label="تفعيل ميزة واتساب" hint="إيقافها يوقف كل الإرسال اليدوي والمجدول">
            <Toggle checked={bool("whatsapp.enabled")} onChange={v => set("whatsapp.enabled", v)} />
          </Row>

          <Row label="طريقة الإرسال" hint="WEB = إرسال تلقائي من WhatsApp Web المحلي، LINK = يدوي، CLOUD = API رسمي">
            <select value={provider} onChange={e => set("whatsapp.provider", e.target.value)}>
              {meta.providers.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </Row>

          <Row label="اسم المعرض" hint="يظهر في أول كل رسالة">
            <input value={value("showroom.name")} onChange={e => set("showroom.name", e.target.value)} />
          </Row>

          <Row label="رقم المعرض" hint="يستقبل نسخة الرسائل في العمليات المباشرة">
            <input value={value("showroom.phone")} onChange={e => set("showroom.phone", e.target.value)} placeholder="05xxxxxxxx" dir="ltr" />
          </Row>

          <Row label="كود الدولة الافتراضي" hint="لأرقام الهاتف المحلية — السعودية +966 هي الافتراضية">
            <select value={value("whatsapp.defaultCountryCode")} onChange={e => set("whatsapp.defaultCountryCode", e.target.value)} dir="ltr" style={{ width: 140 }}>
              <option value="966">+966 — السعودية</option>
              <option value="20">+20 — مصر</option>
              <option value="971">+971 — الإمارات</option>
              <option value="974">+974 — قطر</option>
              <option value="973">+973 — البحرين</option>
              <option value="965">+965 — الكويت</option>
              <option value="968">+968 — عُمان</option>
              <option value="962">+962 — الأردن</option>
            </select>
          </Row>

          <Row label="العملة" hint="تظهر بعد كل مبلغ في الرسائل">
            <input value={value("showroom.currency")} onChange={e => set("showroom.currency", e.target.value)} style={{ width: 90 }} />
          </Row>

          <Row label="الرابط العام للتطبيق" hint="يُستخدم لبناء روابط المستندات داخل الرسائل. اتركه فارغًا ليُشتق من رابط المتصفح">
            <input value={value("whatsapp.baseUrl")} onChange={e => set("whatsapp.baseUrl", e.target.value)} placeholder="https://showroom.example.com" dir="ltr" />
          </Row>

          {provider === "WEB" && (
            <div className="box">
              <b>حالة WhatsApp Web المحلي</b>
              <div style={{ marginTop: 8 }}>
                الحالة: <b>{webStatus?.status || "غير معروف"}</b>
                {webStatus?.account ? <> — الحساب: <b dir="ltr">{webStatus.account}</b></> : ""}
              </div>
              <div className="muted" style={{ marginTop: 6 }}>
                المرة الأولى ستفتح نافذة WhatsApp Web وتظهر فيها شاشة QR. امسحها من واتساب في الهاتف وانتظر «جاهز للإرسال». إذا لم تظهر النافذة فراجع حالة الخطأ أسفلها ونافذة تشغيل السيرفر.
              </div>
              {webStatus?.lastError && <div className="box error" style={{ marginTop: 8 }}>{webStatus.lastError}</div>}
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button className="smallBtn" onClick={async () => {
                  try { const r = await api("/messaging/whatsapp-web/start", { method: "POST" }); setWebStatus(r.status); } catch (e) { setError(errorMessage(e)); }
                }}>▶ تشغيل / ربط</button>
                <button className="smallBtn" onClick={async () => {
                  try { const r = await api("/messaging/whatsapp-web/logout", { method: "POST" }); setWebStatus(r.status); } catch (e) { setError(errorMessage(e)); }
                }}>⎋ قطع الجلسة</button>
              </div>
              <div className="muted" style={{ marginTop: 8 }}>الفاصل بين الرسائل: {webStatus?.minDelaySeconds || value("whatsapp.web.minDelaySeconds")}–{webStatus?.maxDelaySeconds || value("whatsapp.web.maxDelaySeconds")} ثانية.</div>
            </div>
          )}

          {provider === "CLOUD" && (
            <div className="box">
              <b>بيانات WhatsApp Business Cloud API</b>
              <p className="muted">تحتاج حساب Meta Business ورقمًا معتمدًا. رسائل التنبيه التي يبدأها النشاط التجاري تتطلب قالبًا معتمدًا من ميتا.</p>
              <Row label="Phone Number ID">
                <input value={value("whatsapp.cloud.phoneId")} onChange={e => set("whatsapp.cloud.phoneId", e.target.value)} dir="ltr" />
              </Row>
              <Row label="Permanent Token" hint={s["whatsapp.cloud.tokenSet"] ? "محفوظ بالفعل — اتركه كما هو لعدم التغيير" : "غير محفوظ بعد"}>
                <input type="password" value={value("whatsapp.cloud.token")} onChange={e => set("whatsapp.cloud.token", e.target.value)} dir="ltr" />
              </Row>
              <Row label="قالب التذكيرات المعتمد">
                <input value={value("whatsapp.cloud.template.reminder")} onChange={e => set("whatsapp.cloud.template.reminder", e.target.value)} dir="ltr" />
              </Row>
              <Row label="قالب فاتورة التحصيل المعتمد">
                <input value={value("whatsapp.cloud.template.invoice")} onChange={e => set("whatsapp.cloud.template.invoice", e.target.value)} dir="ltr" />
              </Row>
              <Row label="قالب الإيصال المعتمد">
                <input value={value("whatsapp.cloud.template.receipt")} onChange={e => set("whatsapp.cloud.template.receipt", e.target.value)} dir="ltr" />
              </Row>
              <Row label="متغيرات قالب التذكير بالترتيب" hint="اكتب أسماء المتغيرات بنفس ترتيب {{1}}, {{2}}... في قالب Meta">
                <input value={value("whatsapp.cloud.params.reminder")} onChange={e => set("whatsapp.cloud.params.reminder", e.target.value)} dir="ltr" />
              </Row>
              <Row label="متغيرات قالب فاتورة التحصيل" hint="بنفس ترتيب متغيرات قالب Meta">
                <input value={value("whatsapp.cloud.params.invoice")} onChange={e => set("whatsapp.cloud.params.invoice", e.target.value)} dir="ltr" />
              </Row>
              <Row label="متغيرات قالب الإيصال" hint="بنفس ترتيب متغيرات قالب Meta">
                <input value={value("whatsapp.cloud.params.receipt")} onChange={e => set("whatsapp.cloud.params.receipt", e.target.value)} dir="ltr" />
              </Row>
            </div>
          )}

          {scheduler && (
            <div className="box">
              <b>حالة المُجدول:</b>{" "}
              {scheduler.running ? "يعمل" : "متوقف"} —{" "}
              {scheduler.autoRun ? `التشغيل التلقائي مفعّل يوميًا ${scheduler.scheduleTime}` : "التشغيل التلقائي معطّل"}
              {scheduler.lastRunDate ? ` — آخر تشغيل: ${scheduler.lastRunDate}` : " — لم يُشغَّل بعد"}
            </div>
          )}
        </section>
      )}

      {tab === "messages" && (
        <section className="panel">
          <div className="panelTitle"><h3>أي الرسائل تُرسل ولمن</h3>
            <span className="muted">فاتورة التحصيل وإيصال السداد يذهبان للمشتري مع نسخة للمالك أو صاحب المعرض حسب نوع العملية.</span></div>
          {meta.msgKeys.map(key => (
            <Row key={key} label={MSG_LABELS[key]?.[0] || key} hint={MSG_LABELS[key]?.[1] || ""}>
              <Toggle checked={bool(key)} onChange={v => set(key, v)} />
            </Row>
          ))}
          <div className="box">
            <b>قاعدة التوجيه:</b> في العملية <b>سيارة مملوكة للغير</b> تذهب النسخة لمالك السيارة المسجّل في «البائعون». وفي العملية <b>المباشرة</b>
            تذهب لرقم المعرض المحفوظ في تبويب «الإرسال».
          </div>
        </section>
      )}

      {tab === "reminders" && (
        <section className="panel">
          <div className="panelTitle"><h3>سياسة التذكيرات</h3>
            <span className="muted">كل هذه القيم تحمي العميل من الإزعاج وتحمي الرقم من الحظر.</span></div>

          <Row label="التشغيل التلقائي اليومي" hint="يفحص المتأخرات ويرسل تلقائيًا في الموعد المحدد">
            <Toggle checked={bool("reminder.autoRun")} onChange={v => set("reminder.autoRun", v)} />
          </Row>

          <Row label="موعد التشغيل اليومي" hint="بصيغة 24 ساعة">
            <input type="time" value={value("reminder.scheduleTime")} onChange={e => set("reminder.scheduleTime", e.target.value)} dir="ltr" />
          </Row>

          <Row label="التذكير قبل الاستحقاق بكم يوم" hint="0 = لا تذكير مسبق">
            <input type="number" min="0" max="60" value={value("reminder.beforeDays")} onChange={e => set("reminder.beforeDays", e.target.value)} style={{ width: 90 }} />
          </Row>

          <Row label="تذكير في يوم الاستحقاق نفسه">
            <Toggle checked={bool("reminder.onDueDate")} onChange={v => set("reminder.onDueDate", v)} />
          </Row>

          <Row label="بعد كم يوم من التأخير نُرسل" hint="أرقام مفصولة بفواصل — الإرسال في هذه الأيام فقط لا كل يوم">
            <input value={value("reminder.afterOverdueDays")} onChange={e => set("reminder.afterOverdueDays", e.target.value)} dir="ltr" placeholder="1,7,15,30" />
          </Row>

          <Row label="فترة سماح الكفيل" hint="بعد كم يوم تأخير عن المشتري نُرسل للكفيل">
            <input type="number" min="0" max="365" value={value("guarantor.graceDays")} onChange={e => set("guarantor.graceDays", e.target.value)} style={{ width: 90 }} />
          </Row>

          <Row label="أقصى عدد رسائل لنفس القسط" hint="لكل مستلم على حدة">
            <input type="number" min="1" max="100" value={value("reminder.maxPerInstallment")} onChange={e => set("reminder.maxPerInstallment", e.target.value)} style={{ width: 90 }} />
          </Row>

          <Row label="منع التكرار خلال (ساعة)" hint="0 = إلغاء منع التكرار">
            <input type="number" min="0" max="720" value={value("reminder.dedupeHours")} onChange={e => set("reminder.dedupeHours", e.target.value)} style={{ width: 90 }} />
          </Row>

          <Row label="السقف اليومي للرسائل" hint="للتذكيرات التلقائية فقط">
            <input type="number" min="1" value={value("reminder.dailyCap")} onChange={e => set("reminder.dailyCap", e.target.value)} style={{ width: 110 }} />
          </Row>

          {provider === "WEB" && <div className="box">
            <b>معدل WhatsApp Web المحلي</b>
            <Row label="أقل فاصل بين الرسائل (ثانية)">
              <input type="number" min="5" max="3600" value={value("whatsapp.web.minDelaySeconds")} onChange={e => set("whatsapp.web.minDelaySeconds", e.target.value)} style={{ width: 110 }} dir="ltr" />
            </Row>
            <Row label="أعلى فاصل بين الرسائل (ثانية)">
              <input type="number" min="5" max="7200" value={value("whatsapp.web.maxDelaySeconds")} onChange={e => set("whatsapp.web.maxDelaySeconds", e.target.value)} style={{ width: 110 }} dir="ltr" />
            </Row>
          </div>}

          <Row label="ساعات الهدوء (بداية)" hint="لا إرسال تلقائي داخل هذه النافذة — الإرسال اليدوي يتجاوزها">
            <input type="time" value={value("reminder.quietStart")} onChange={e => set("reminder.quietStart", e.target.value)} dir="ltr" />
          </Row>

          <Row label="ساعات الهدوء (نهاية)">
            <input type="time" value={value("reminder.quietEnd")} onChange={e => set("reminder.quietEnd", e.target.value)} dir="ltr" />
          </Row>

          <Row label="أيام ممنوع فيها الإرسال التلقائي" hint="يمكن اختيار أكثر من يوم">
            <div className="chips">
              {WEEKDAYS.map(([v, label]) => {
                const list = String(value("reminder.skipWeekdays") || "").split(",").filter(Boolean);
                const on = list.includes(v);
                return (
                  <button key={v} type="button" className={on ? "chip active" : "chip"}
                    onClick={() => set("reminder.skipWeekdays", (on ? list.filter(x => x !== v) : [...list, v]).join(","))}>
                    {label}
                  </button>
                );
              })}
            </div>
          </Row>

          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button className="smallBtn" onClick={showPlan} disabled={busy}>👁️ عرض خطة اليوم</button>
            <button className="primary" onClick={runReminders} disabled={busy}>⚡ تشغيل التذكيرات الآن</button>
          </div>

          {plan && (
            <div className="box" style={{ marginTop: 12 }}>
              <b>خطة {plan.today}:</b> {plan.blocked
                ? `محجوبة — ${plan.blocks.join("، ")}`
                : `${plan.planned.length} رسالة جاهزة، ${plan.skipped.length} مستبعدة`}
              {!plan.blocked && plan.planned.length > 0 && (
                <Table
                  headers={["النوع", "المستلم", "الدور", "العقد", "القسط", "الاستحقاق", "أيام", ""]}
                  rows={plan.planned.map(p => [
                    KINDS[p.kind] || p.kind, p.name || "—", ROLES[p.role] || p.role, p.sale_number,
                    p.installment_number, p.due_date, p.daysOverdue > 0 ? `متأخر ${p.daysOverdue}` : p.daysOverdue === 0 ? "اليوم" : `باقي ${Math.abs(p.daysOverdue)}`,
                    p.link ? <a key={p.link} href={p.link} target="_blank" rel="noreferrer">فتح واتساب</a> : "—",
                  ])}
                />
              )}
              {plan.skipped?.length > 0 && (
                <details style={{ marginTop: 8 }}>
                  <summary>أسباب الاستبعاد ({plan.skipped.length})</summary>
                  <Table headers={["العقد", "الدور", "الاسم", "السبب"]}
                    rows={plan.skipped.map(x => [x.sale_number || "—", ROLES[x.role] || x.role, x.name || "—", x.reason])} />
                </details>
              )}
            </div>
          )}
        </section>
      )}

      {tab === "templates" && (
        <section className="panel">
          <div className="panelTitle"><h3>نصوص الرسائل</h3>
            <span className="muted">عدّل النص كما تشاء — المعاينة تُحدَّث فورًا. المتغيّرات بين أقواس مزدوجة.</span>
            <button className="smallBtn" onClick={resetTemplates} disabled={busy}>استعادة الافتراضي</button>
          </div>
          {meta.templateKeys.map(key => (
            <div key={key} className="templateEditor">
              <b>{TEMPLATE_LABELS[key] || key}</b>
              <div className="templateCols">
                <textarea rows={10} dir="rtl" value={value(key)} onChange={e => set(key, e.target.value)} />
                <pre className="templatePreview">{renderPreview(value(key))}</pre>
              </div>
              <div className="muted small">
                المتغيّرات المستخدمة: {(value(key).match(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi) || []).map(x => x.replace(/[{}\s]/g, "")).join("، ") || "لا شيء"}
              </div>
            </div>
          ))}
          <details className="box">
            <summary>كل المتغيّرات المتاحة ({meta.variables.length})</summary>
            <Table headers={["المتغيّر", "المعنى"]} rows={meta.variables.map(v => [`{{${v.id}}}`, v.label])} />
          </details>
        </section>
      )}

      {tab === "log" && (
        <section className="panel">
          <div className="panelTitle"><h3>سجل الرسائل ({log.total})</h3>
            <button className="smallBtn" onClick={clearLog}>مسح السجل</button></div>
          <div className="filters">
            <select value={filters.kind} onChange={e => setFilters(f => ({ ...f, kind: e.target.value }))}>
              <option value="">كل الأنواع</option>
              {Object.entries(KINDS).map(([v, t]) => <option key={v} value={v}>{t}</option>)}
            </select>
            <select value={filters.status} onChange={e => setFilters(f => ({ ...f, status: e.target.value }))}>
              <option value="">كل الحالات</option>
              {Object.entries(STATUSES).map(([v, [t]]) => <option key={v} value={v}>{t}</option>)}
            </select>
            <input placeholder="بحث بالاسم أو الرقم أو النص" value={filters.search}
              onChange={e => setFilters(f => ({ ...f, search: e.target.value }))} />
          </div>
          {log.rows.length === 0
            ? <div className="box">لا توجد رسائل بعد.</div>
            : <Table
                headers={["الوقت", "النوع", "الدور", "المستلم", "الرقم", "الحالة", "المزوّد", "الرسالة"]}
                rows={log.rows.map(r => [
                  new Date(r.created_at.replace(" ", "T") + "Z").toLocaleString("ar-SA"),
                  KINDS[r.kind] || r.kind, ROLES[r.recipient_role] || r.recipient_role,
                  r.recipient_name || "—", r.recipient_phone ? `+${r.recipient_phone}` : "—",
                  <span key={r.id} className={`badge ${STATUSES[r.status]?.[1] || "gray"}`}>{STATUSES[r.status]?.[0] || r.status}</span>,
                  r.provider === "CLOUD" ? "Cloud API" : r.provider === "WEB" ? "WhatsApp Web" : "wa.me",
                  r.link
                    ? <a href={r.link} target="_blank" rel="noreferrer" title={r.body}>فتح</a>
                    : <span title={r.body}>{r.error || "—"}</span>,
                ])}
              />}
        </section>
      )}

      {testOpen && (
        <Modal title="رسالة واتساب تجريبية" onClose={() => { setTestOpen(false); setTestResult(null); }}>
          <div className="box">اختبار آمن لرقم واحد فقط. في السعودية اكتب 05xxxxxxxx، والنظام يحوله تلقائيًا إلى +966.</div>
          <label className="field"><span>رقم الهاتف</span>
            <input value={testPhone} onChange={e => setTestPhone(e.target.value)} placeholder="05xxxxxxxx" dir="ltr" />
          </label>
          <button className="primary full" onClick={sendTest} disabled={busy || !testPhone}>إرسال</button>
          {testResult && (
            <div className={testResult.error ? "box error" : "box ok"}>
              {testResult.error
                ? testResult.error
                : <>{testResult.status === "LINK_READY" ? "تم تجهيز الرابط" : "تم الإرسال"} — {`+${testResult.phone}`}
                  {testResult.body && <pre className="templatePreview">{testResult.body}</pre>}
                  {testResult.link && <a className="waBtn" href={testResult.link} target="_blank" rel="noreferrer" style={{ textDecoration: "none", display: "inline-block", marginTop: 8 }}>فتح واتساب</a>}</>}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
