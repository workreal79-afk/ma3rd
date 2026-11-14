import React, { useState } from "react";
import { api } from "../services/api.js";
import { errorMessage } from "../lib/errors.js";
import { Modal } from "./ui.jsx";

// زر واتساب مشترك: يرسل الطلب للخادم، ثم يعرض نافذة فيها كل مستلم ورابطه.
// نعرض النتائج في نافذة بدل window.open لأن المتصفحات تحجب فتح عدة تبويبات دفعة واحدة.

const ROLES = {
  CUSTOMER: "المشتري",
  SELLER: "مالك المركبة",
  SHOWROOM: "صاحب المعرض",
  GUARANTOR: "الكفيل",
};

const STATUS_TEXT = {
  LINK_READY: "رابط جاهز — اضغط «فتح واتساب» ثم أرسل",
  SENT: "أُرسلت تلقائيًا",
  FAILED: "فشل الإرسال",
  SKIPPED: "لم تُرسل",
};

export function WhatsAppButton({ kind, saleId, installmentId, receiptNumber, label = "واتساب", className = "waBtn", title }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  const send = async () => {
    setBusy(true);
    setError("");
    try {
      const payload = { kind };
      if (saleId) payload.saleId = saleId;
      if (installmentId) payload.installmentId = installmentId;
      if (receiptNumber) payload.receiptNumber = receiptNumber;
      const r = await api("/messaging/send", { method: "POST", body: JSON.stringify(payload) });
      setResult(r);
      setOpen(true);
    } catch (e) {
      setError(errorMessage(e));
      setOpen(true);
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // لو رفض المتصفح (صفحة غير آمنة) نفتح مربع نسخ يدوي.
      window.prompt("انسخ نص الرسالة:", text);
    }
  };

  const close = () => { setOpen(false); setResult(null); setError(""); };

  return (
    <>
      <button type="button" className={className} onClick={send} disabled={busy} title={title || label}>
        {busy ? "..." : `📲 ${label}`}
      </button>
      {open && (
        <Modal title={`رسائل واتساب — ${label}`} onClose={close}>
          {error
            ? <div className="box error">{error}</div>
            : result && (
              <>
                <div className="box">
                  العقد <b>{result.sale?.sale_number}</b> — العميل <b>{result.sale?.customer}</b>
                  {" "}• الطريقة: <b>{result.provider === "CLOUD" ? "Cloud API" : result.provider === "WEB" ? "WhatsApp Web محلي" : "رابط wa.me"}</b>
                </div>
                {result.results.length === 0 && <div className="box">لا توجد رسائل لهذا البند (قد تكون معطّلة من صفحة الإعدادات).</div>}
                {result.results.map((r, i) => (
                  <div key={`${r.id ?? "new"}-${i}-${r.role}`} className="box">
                    <b>{r.name || "—"}</b>{" "}
                    <span className="muted">({ROLES[r.role] || r.role})</span>{" "}
                    <span dir="ltr">+{r.phone}</span>
                    <div className={r.status === "FAILED" || r.status === "SKIPPED" ? "badge red" : "badge green"} style={{ margin: "6px 0" }}>
                      {STATUS_TEXT[r.status] || r.status}
                    </div>
                    {r.error && <div className="box error">{r.error}</div>}
                    {r.body && <pre className="templatePreview">{r.body}</pre>}
                    <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                      {r.link && <a className="waBtn" href={r.link} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>فتح واتساب</a>}
                      {r.documentLink && <a className="smallBtn" href={r.documentLink} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>المستند</a>}
                      {r.body && <button className="smallBtn" onClick={() => copy(r.body)}>نسخ النص</button>}
                    </div>
                  </div>
                ))}
              </>
            )}
          <button className="primary full" onClick={close} style={{ marginTop: 10 }}>إغلاق</button>
        </Modal>
      )}
    </>
  );
}
