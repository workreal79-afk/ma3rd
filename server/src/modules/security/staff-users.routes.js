import { InputError } from "../../shared/errors.js";
import { requireText, positiveId } from "../../shared/validation.js";
import { hashPassword } from "../../utils/passwords.js";
import { destroySessionsForUser } from "../../middlewares/auth.js";

const ROLES = new Set(["ADMIN", "ACCOUNTANT", "SALES", "VIEWER"]);
const ROLE_LABELS = { ADMIN: "مدير النظام", ACCOUNTANT: "محاسب", SALES: "مبيعات", VIEWER: "مشاهدة فقط" };

export function registerStaffUserRoutes(app, { db }) {
  const isAdmin = req => req.user?.role === "ADMIN";
  app.get("/api/users", (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: "إدارة المستخدمين متاحة لمدير النظام فقط" });
    res.json(db.prepare("SELECT id,username,role,status,created_by,updated_by,created_at,updated_at FROM staff_users ORDER BY id DESC").all().map(x => ({ ...x, role_label: ROLE_LABELS[x.role] || x.role })));
  });
  app.post("/api/users", (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: "إنشاء المستخدمين متاح لمدير النظام فقط" });
    const username = requireText(req.body.username, "اسم المستخدم", 80);
    if (!/^[a-zA-Z0-9._-]{3,80}$/.test(username)) throw new InputError("اسم المستخدم: 3 أحرف على الأقل، ويقبل الإنجليزية والأرقام والنقطة والشرطة فقط");
    const role = String(req.body.role || "VIEWER").toUpperCase();
    if (!ROLES.has(role)) throw new InputError("الدور المحدد غير صحيح");
    const credentials = hashPassword(req.body.password);
    try {
      const r = db.prepare("INSERT INTO staff_users(username,password_salt,password_hash,role,status,created_by) VALUES(?,?,?,?, 'ACTIVE',?)")
        .run(username, credentials.salt, credentials.hash, role, req.user?.username || "system");
      db.prepare("INSERT INTO audit_log(action,entity_type,entity_id,details,actor) VALUES('CREATE','STAFF_USER',?,?,?)")
        .run(r.lastInsertRowid, JSON.stringify({ username, role, status: "ACTIVE" }), req.user?.username || "system");
      res.status(201).json({ id: Number(r.lastInsertRowid), username, role, role_label: ROLE_LABELS[role], status: "ACTIVE" });
    } catch (error) {
      if (String(error?.message || "").includes("UNIQUE")) throw new InputError("اسم المستخدم مستخدم بالفعل", 409);
      throw error;
    }
  });
  app.put("/api/users/:id", (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: "تعديل المستخدمين متاح لمدير النظام فقط" });
    const id = positiveId(req.params.id, "المستخدم");
    const user = db.prepare("SELECT * FROM staff_users WHERE id=?").get(id);
    if (!user) return res.status(404).json({ error: "المستخدم غير موجود" });
    const role = String(req.body.role ?? user.role).toUpperCase();
    const status = String(req.body.status ?? user.status).toUpperCase();
    if (!ROLES.has(role) || !["ACTIVE", "DISABLED"].includes(status)) throw new InputError("الدور أو الحالة غير صحيحين");
    const disablingAdmin = user.role === "ADMIN" && user.status === "ACTIVE" && (role !== "ADMIN" || status !== "ACTIVE");
    if (disablingAdmin) {
      const activeAdmins = Number(db.prepare("SELECT COUNT(*) n FROM staff_users WHERE role='ADMIN' AND status='ACTIVE'").get().n || 0);
      const envAdminAvailable = Boolean(process.env.SHOWROOM_AUTH_USER && process.env.SHOWROOM_AUTH_PASS) || (process.env.NODE_ENV !== "production" && !process.env.SHOWROOM_AUTH_USER && !process.env.SHOWROOM_AUTH_PASS);
      if (activeAdmins <= 1 && !envAdminAvailable) throw new InputError("لا يمكن تعطيل آخر مدير نشط قبل إنشاء مدير آخر", 409);
    }
    db.prepare("UPDATE staff_users SET role=?,status=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(role, status, req.user?.username || "system", id);
    db.prepare("INSERT INTO audit_log(action,entity_type,entity_id,details,actor) VALUES('UPDATE','STAFF_USER',?,?,?)")
      .run(id, JSON.stringify({ before: { role: user.role, status: user.status }, after: { role, status } }), req.user?.username || "system");
    if (status !== "ACTIVE" || role !== user.role) destroySessionsForUser(user.username);
    res.json({ ok: true, id, role, role_label: ROLE_LABELS[role], status });
  });
  app.post("/api/users/:id/reset-password", (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: "إعادة تعيين كلمة المرور متاحة لمدير النظام فقط" });
    const id = positiveId(req.params.id, "المستخدم");
    const user = db.prepare("SELECT * FROM staff_users WHERE id=?").get(id);
    if (!user) return res.status(404).json({ error: "المستخدم غير موجود" });
    const credentials = hashPassword(req.body.password);
    db.prepare("UPDATE staff_users SET password_salt=?,password_hash=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(credentials.salt, credentials.hash, req.user?.username || "system", id);
    db.prepare("INSERT INTO audit_log(action,entity_type,entity_id,details,actor) VALUES('RESET_PASSWORD','STAFF_USER',?,?,?)")
      .run(id, JSON.stringify({ username: user.username }), req.user?.username || "system");
    destroySessionsForUser(user.username);
    res.json({ ok: true, message: "تم تحديث كلمة المرور وإنهاء الجلسات الحالية لهذا المستخدم" });
  });
  app.delete("/api/users/:id", (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: "تعطيل المستخدمين متاح لمدير النظام فقط" });
    const id = positiveId(req.params.id, "المستخدم");
    const user = db.prepare("SELECT * FROM staff_users WHERE id=?").get(id);
    if (!user) return res.status(404).json({ error: "المستخدم غير موجود" });
    if (user.status === "DISABLED") return res.json({ ok: true, alreadyDisabled: true });
    if (user.role === "ADMIN" && Number(db.prepare("SELECT COUNT(*) n FROM staff_users WHERE role='ADMIN' AND status='ACTIVE'").get().n || 0) <= 1) {
      const envAdminAvailable = Boolean(process.env.SHOWROOM_AUTH_USER && process.env.SHOWROOM_AUTH_PASS) || (process.env.NODE_ENV !== "production" && !process.env.SHOWROOM_AUTH_USER && !process.env.SHOWROOM_AUTH_PASS);
      if (!envAdminAvailable) throw new InputError("لا يمكن تعطيل آخر مدير نشط", 409);
    }
    db.prepare("UPDATE staff_users SET status='DISABLED',updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(req.user?.username || "system", id);
    db.prepare("INSERT INTO audit_log(action,entity_type,entity_id,details,actor) VALUES('DISABLE','STAFF_USER',?,?,?)")
      .run(id, JSON.stringify({ username: user.username, role: user.role }), req.user?.username || "system");
    destroySessionsForUser(user.username);
    res.json({ ok: true, status: "DISABLED" });
  });
}
