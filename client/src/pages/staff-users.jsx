import React, { useEffect, useState } from "react";
import { api } from "../services/api.js";
import { Field, LoadError, Select, Table, Toolbar } from "../components/ui.jsx";
import { errorMessage } from "../lib/errors.js";

const roles = [["ADMIN", "مدير النظام"], ["ACCOUNTANT", "محاسب"], ["SALES", "مبيعات"], ["VIEWER", "مشاهدة فقط"]];

export function StaffUsers({ refresh }) {
  const [rows, setRows] = useState([]), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [form, setForm] = useState({ username: "", password: "", role: "VIEWER" });
  const [busy, setBusy] = useState(false);
  const load = () => api("/users").then(data => { setRows(Array.isArray(data) ? data : []); setError(""); }).catch(e => setError(errorMessage(e)));
  useEffect(() => { load(); }, [refresh]);
  const save = async e => {
    e.preventDefault(); setNotice("");
    if (form.password.length < 12) return setNotice("كلمة المرور لازم تكون 12 حرفًا على الأقل.");
    setBusy(true);
    try {
      const r = await api("/users", { method: "POST", body: JSON.stringify(form) });
      setForm({ username: "", password: "", role: "VIEWER" });
      setNotice(`تم إنشاء الحساب ${r.username} بدور ${r.role_label}.`); await load();
    } catch (e) { setNotice(errorMessage(e)); } finally { setBusy(false); }
  };
  const changeRole = async user => {
    const role = window.prompt(`الدور الجديد للحساب ${user.username}:\nADMIN / ACCOUNTANT / SALES / VIEWER`, user.role);
    if (role === null) return;
    const normalized = role.trim().toUpperCase();
    if (!roles.some(x => x[0] === normalized)) return alert("الدور غير صحيح.");
    try { await api(`/users/${user.id}`, { method: "PUT", body: JSON.stringify({ role: normalized }) }); await load(); }
    catch (e) { alert(errorMessage(e)); }
  };
  const toggle = async user => {
    const status = user.status === "ACTIVE" ? "DISABLED" : "ACTIVE";
    if (!window.confirm(status === "DISABLED" ? `تعطيل ${user.username} وإنهاء جلساته الحالية؟` : `إعادة تفعيل الحساب ${user.username}؟`)) return;
    try { await api(`/users/${user.id}`, { method: "PUT", body: JSON.stringify({ status }) }); await load(); }
    catch (e) { alert(errorMessage(e)); }
  };
  const reset = async user => {
    const password = window.prompt(`كلمة المرور الجديدة للحساب ${user.username} (12 حرفًا على الأقل):`);
    if (password === null) return;
    if (password.length < 12) return alert("كلمة المرور لازم تكون 12 حرفًا على الأقل.");
    if (!window.confirm(`تأكيد تغيير كلمة مرور ${user.username} وإنهاء جلساته الحالية؟`)) return;
    try { await api(`/users/${user.id}/reset-password`, { method: "POST", body: JSON.stringify({ password }) }); alert("تم تحديث كلمة المرور."); await load(); }
    catch (e) { alert(errorMessage(e)); }
  };
  return <div>
    <Toolbar title="المستخدمون والصلاحيات" />
    <section className="panel">
      <div className="panelTitle"><h3>إضافة موظف</h3><span className="muted">كلمات المرور تُحفظ كاشتقاق آمن ولا تُعرض بعد الحفظ.</span></div>
      <form onSubmit={save} style={{ padding: 16 }}>
        <div className="grid2">
          <Field label="اسم المستخدم (إنجليزي)" v={form.username} set={v => setForm(f => ({ ...f, username: v }))} />
          <Field label="كلمة المرور (12 حرفًا على الأقل)" type="password" v={form.password} set={v => setForm(f => ({ ...f, password: v }))} />
          <Select label="الدور" value={form.role} onChange={v => setForm(f => ({ ...f, role: v }))} options={roles} />
        </div>
        {notice && <div className="box" role="status">{notice}</div>}
        <button className="primary" disabled={busy || !form.username.trim() || form.password.length < 12}>{busy ? "جاري الحفظ..." : "إنشاء الحساب"}</button>
      </form>
    </section>
    <section className="panel">
      <div className="panelTitle"><h3>حسابات النظام</h3><button className="smallBtn" onClick={load}>تحديث</button></div>
      {error ? <LoadError error={error} onRetry={load} /> : <Table headers={["المستخدم","الدور","الحالة","تاريخ الإنشاء","إجراءات"]} rows={rows.map(user => [user.username, user.role_label || user.role, user.status === "ACTIVE" ? "نشط" : "معطل", user.created_at, <div className="actions" key={user.id}><button className="smallBtn" onClick={() => changeRole(user)}>تغيير الدور</button><button className="smallBtn" onClick={() => reset(user)}>تغيير كلمة المرور</button><button className="smallBtn" onClick={() => toggle(user)}>{user.status === "ACTIVE" ? "تعطيل" : "تفعيل"}</button></div>])} />}
    </section>
    <section className="panel">
      <div className="panelTitle"><h3>صلاحيات الأدوار</h3></div>
      <div style={{ padding: 16 }} className="muted">
        <p><b>مدير النظام:</b> جميع الإجراءات، وإدارة الموظفين، والنسخ الاحتياطية، والإلغاء والتصحيح.</p>
        <p><b>محاسب:</b> التحصيلات ورد المبالغ وعكسها ونقلها، وسداد البائع، والمصروفات، والجدولة والتسويات والسندات والتقارير المالية.</p>
        <p><b>مبيعات:</b> تسجيل المبيعات وإدارة بيانات السيارات والأطراف والحجوزات؛ لا يمكنه عكس حركة مالية أو إلغاء بيع أو استعادة نسخة.</p>
        <p><b>مشاهدة فقط:</b> يمكنه الاطلاع على الشاشات والتقارير دون حفظ تغييرات.</p>
        <p>تُطبّق القيود في الخادم، وليس بإخفاء الأزرار في الواجهة فقط.</p>
      </div>
    </section>
  </div>;
}
