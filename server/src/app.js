import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createAppContext } from "./core/context.js";
import { registerDomainModules } from "./core/module-registry.js";
import { errorHandler } from "./middlewares/error-handler.js";
import { requireAuth, secureEqual, createSession, getSession, destroySession, setSessionCookie, clearSessionCookie, decodeDocumentShareToken, setShareSecret, loginBlocked, recordLoginFailure, clearLoginFailures, loginLimits } from "./middlewares/auth.js";
import { loadOrCreateShareSecret } from "./utils/share-secret.js";
import { securityHeaders } from "./middlewares/security-headers.js";
import { enforceCapabilities } from "./middlewares/permissions.js";
import { verifyPassword } from "./utils/passwords.js";
import { requireTrustedOrigin } from "./middlewares/request-origin.js";
import { secureDocumentResponses } from "./middlewares/document-security.js";
import { config } from "./config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const context = createAppContext();
  // في الاختبارات نكتفي بسر عشوائي داخل الذاكرة حتى لا نكتب ملفات في مجلد البيانات.
  if (config.nodeEnv !== "test") setShareSecret(loadOrCreateShareSecret(context.dataDir));
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);

  // CORS مغلق افتراضيًا؛ الطلبات من نفس نطاق الواجهة لا تحتاج رأس CORS.
  // رؤوس منع التأطير تخص الـ API والمستندات، ولا تمنع معاينة واجهة التطبيق داخل Arena.
  app.use("/api", securityHeaders);
  app.use(cors({ origin: config.corsOrigins.length ? config.corsOrigins : false, credentials: config.corsOrigins.length > 0 }));
  // نرفض الطلب غير المصرّح قبل قراءة جسم الاسترجاع الذي قد يصل إلى 100MB.
  app.use("/api/auth/login", express.json());
  // Public document-share entry point. The token is scoped to one document and expires automatically.
  app.get("/share/:token", (req, res) => {
    const decoded = decodeDocumentShareToken(req.params.token);
    if (!decoded) return res.status(404).send("رابط المستند غير صالح أو منتهي الصلاحية");
    const separator = decoded.path.includes("?") ? "&" : "?";
    return res.redirect(302, `${decoded.path}${separator}share=${encodeURIComponent(req.params.token)}`);
  });

  app.post("/api/auth/login", (req, res) => {
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    if (loginBlocked(ip)) {
      res.set("Retry-After", String(Math.ceil(loginLimits.WINDOW_MS / 1000)));
      return res.status(429).json({ error: `تم تجاوز عدد محاولات الدخول المسموح. حاول مجددًا بعد ${Math.ceil(loginLimits.WINDOW_MS / 60000)} دقائق.` });
    }
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    let principal = null;
    // Environment credentials remain the break-glass administrator account.
    if (config.authUser && config.authPassword && secureEqual(username, config.authUser) && secureEqual(password, config.authPassword)) {
      principal = { username: config.authUser, role: "ADMIN" };
    } else if (username && password) {
      const record = context.db.prepare("SELECT id,username,password_salt,password_hash,role,status FROM staff_users WHERE username=? COLLATE NOCASE").get(username);
      if (record && record.status === "ACTIVE" && verifyPassword(password, record.password_salt, record.password_hash)) {
        principal = { username: record.username, role: record.role };
      }
    }
    if (!principal) { recordLoginFailure(ip); return res.status(401).json({ error: "اسم المستخدم أو كلمة المرور غير صحيحة، أو أن الحساب معطل" }); }
    clearLoginFailures(ip);
    const session = createSession(principal.username, principal.role);
    setSessionCookie(res, session);
    return res.json({ authenticated: true, username: principal.username, role: principal.role });
  });
  app.get("/api/auth/session", (req, res) => {
    const session = getSession(req);
    return res.json({ authenticated: Boolean(session), username: session?.username || null, role: session?.role || null });
  });
  app.post("/api/auth/logout", (req, res) => {
    destroySession(req);
    clearSessionCookie(res);
    return res.json({ authenticated: false });
  });
  app.use("/api", (req,res,next)=>requireAuth(req,res,next,context.db), requireTrustedOrigin, secureDocumentResponses, enforceCapabilities);
  app.use("/api/restore", express.raw({ type: ["application/octet-stream", "application/x-sqlite3", "application/vnd.sqlite3"], limit: "100mb" }));
  app.use(express.json({ limit: "10mb" }));
  app.use((req, _res, next) => {
    // Express 5 يترك req.body غير معرّف عندما لا يوجد جسم قابل للتحليل.
    req.body ??= {};
    if (!Buffer.isBuffer(req.body) && (typeof req.body !== "object" || Array.isArray(req.body))) return _res.status(400).json({ error: "جسم الطلب يجب أن يكون كائنًا من المفاتيح والقيم" });
    next();
  });
  app.use("/api", (req, res, next) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method) || !context.autoBackup?.enabled) return next();
    res.once("finish", () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return;
      void context.autoBackup.afterAction().catch(error => {
        console.error("Auto backup after action failed:", error.code || error.name);
      });
    });
    next();
  });

  registerDomainModules(app, context);
  app.use("/api", (_req, res) => res.status(404).json({ error: "المسار غير موجود" }));

  const clientDist = path.join(__dirname, "..", "..", "client", "dist");
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get(/.*/, (_req, res) => res.sendFile(path.join(clientDist, "index.html")));
  }

  app.use(errorHandler);
  return { app, context };
}
