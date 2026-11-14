const is = (method, path, pattern) => method === pattern.method && pattern.path.test(path);

function accountantCan(method, path) {
  const patterns = [
    { method: "POST", path: /^\/installments\/\d+\/payments$/ },
    { method: "PUT", path: /^\/payments\/\d+$/ },
    { method: "DELETE", path: /^\/payments\/\d+$/ },
    { method: "POST", path: /^\/payments\/\d+\/(transfer|refunds)$/ },
    { method: "POST", path: /^\/sales\/\d+\/seller-payments$/ },
    { method: "PUT", path: /^\/seller-payments\/\d+$/ },
    { method: "DELETE", path: /^\/seller-payments\/\d+$/ },
    { method: "POST", path: /^\/sales\/\d+\/(settle|close-contract|broker-commission-payments)$/ },
    { method: "PUT", path: /^\/sales\/\d+\/installment-schedule$/ },
    { method: "PUT", path: /^\/expenses\/\d+$/ },
    { method: "POST", path: /^\/expenses$/ },
    { method: "DELETE", path: /^\/expenses\/\d+$/ },
    { method: "POST", path: /^\/promissory-notes\/\d+\/(void|replace)$/ },
    { method: "POST", path: /^\/unallocated-receipts$/ },
    { method: "POST", path: /^\/unallocated-receipts\/\d+\/allocate$/ },
    { method: "DELETE", path: /^\/broker-commission-payments\/\d+$/ },
  ];
  return patterns.some(p => is(method,path,p));
}
function salesCan(method, path) {
  if (method === "POST" && /^\/sales$/.test(path)) return true;
  if (method === "POST" && /^\/(vehicles|customers|sellers|guarantors)$/.test(path)) return true;
  if (method === "PUT" && /^\/(vehicles|customers|sellers|guarantors)\/\d+$/.test(path)) return true;
  if (method === "POST" && /^\/vehicles\/\d+\/reservations$/.test(path)) return true;
  if (method === "POST" && /^\/reservations\/\d+\/release$/.test(path)) return true;
  return false;
}

// قراءات حساسة: نسخة قاعدة البيانات كاملة (هويات وعقود العملاء) وسجل الحركات. باقي القراءات مفتوحة لكل الأدوار
// إلى أن تُراجع مصفوفة الصلاحيات تشغيليًا. المستخدمون محميون داخل مسارهم لمدير النظام فقط.
const SENSITIVE_READ_ROLES = new Set(["ADMIN", "ACCOUNTANT"]);
function isSensitiveRead(path) {
  return /^\/backup(\/.*)?$/.test(path) || /^\/audit-log$/.test(path);
}

export function enforceCapabilities(req, res, next) {
  const role = req.user?.role || (process.env.NODE_ENV === "test" ? "ADMIN" : "VIEWER");
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    if (isSensitiveRead(req.path) && !SENSITIVE_READ_ROLES.has(role)) {
      return res.status(403).json({ error: "ليست لديك صلاحية لعرض هذه البيانات. راجع مدير النظام لتغيير الدور أو الصلاحيات." });
    }
    return next();
  }
  if (role === "ADMIN") return next();
  if (role === "ACCOUNTANT" && accountantCan(req.method, req.path)) return next();
  if (role === "SALES" && salesCan(req.method, req.path)) return next();
  return res.status(403).json({ error: "ليست لديك صلاحية لتنفيذ هذا الإجراء. راجع مدير النظام لتغيير الدور أو الصلاحيات." });
}
