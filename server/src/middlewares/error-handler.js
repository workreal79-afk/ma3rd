export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const sqlite = String(err?.code || "");
  let status = Number(err?.statusCode || err?.status || 500);
  if (sqlite.startsWith("SQLITE_CONSTRAINT_FOREIGNKEY")) status = 400;
  else if (/^SQLITE_CONSTRAINT_(?:UNIQUE|PRIMARYKEY)/.test(sqlite)) status = 409;
  else if (sqlite.startsWith("SQLITE_CONSTRAINT")) status = 400;
  else if (/^SQLITE_(?:BUSY|LOCKED)/.test(sqlite)) status = 409;
  if (!Number.isInteger(status) || status < 400 || status > 599) status = 500;
  let message = err?.message || "حدث خطأ غير متوقع";
  if (sqlite.startsWith("SQLITE_CONSTRAINT_FOREIGNKEY")) message = "السجل المرتبط غير موجود";
  else if (status === 409 && sqlite.startsWith("SQLITE_CONSTRAINT")) message = "يوجد سجل بنفس البيانات بالفعل";
  else if (sqlite.startsWith("SQLITE_CONSTRAINT")) message = "قيمة مدخلة غير صالحة";
  else if (/^SQLITE_(?:BUSY|LOCKED)/.test(sqlite)) message = "النظام مشغول بعملية أخرى، حاول مجددًا";
  else if (err?.type === "entity.parse.failed") message = "جسم JSON غير صالح";
  else if (status === 413) message = "حجم الطلب يتجاوز الحد المسموح";
  if (status >= 500) {
    console.error(`[${req.method} ${req.path}]`, err?.name || "Error", err?.code || "");
    message = "حدث خطأ غير متوقع في الخادم";
  }
  res.status(status).json({ error: message });
}
