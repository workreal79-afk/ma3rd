import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config, authEnabled } from "../config/env.js";

function bounded(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? Math.trunc(n) : fallback;
}
const MAX_FAILED = bounded(process.env.SHOWROOM_AUTH_MAX_FAILED, 50, 1, 10000);
const WINDOW_MS = bounded(process.env.SHOWROOM_AUTH_WINDOW_MINUTES, 10, 1, 1440) * 60_000;
const failures = new Map();
const sessions = new Map();
const MAX_TRACKED_IPS = 10000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const SHARE_TTL_SECONDS = 7 * 24 * 60 * 60;

// سر توقيع روابط المشاركة: عشوائي لكل عملية تشغيل، ويُستبدل بسر ثابت محفوظ (setShareSecret)
// حتى تبقى الروابط صالحة بعد إعادة التشغيل. لا يوجد نص ثابت في الكود ولا نعتمد على كلمة المرور.
let shareSecretValue = process.env.SHOWROOM_SHARE_SECRET || randomBytes(32).toString("hex");
export function setShareSecret(value) {
  const secret = String(value || "");
  if (secret.length < 32) throw new Error("سر المشاركة يجب ألا يقل عن 32 حرفًا");
  shareSecretValue = secret;
}
function shareSecret() {
  return shareSecretValue;
}

export function createDocumentShareToken(documentPath, now = Math.floor(Date.now() / 1000)) {
  const pathValue = String(documentPath || "");
  const exp = now + SHARE_TTL_SECONDS;
  const nonce = randomBytes(12).toString("base64url");
  const body = Buffer.from(JSON.stringify({ v: 1, exp, nonce, path: pathValue }), "utf8").toString("base64url");
  const sig = createHmac("sha256", shareSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function decodeDocumentShareToken(token, now = Math.floor(Date.now() / 1000)) {
  try {
    const [body, sig] = String(token || "").split(".");
    if (!body || !sig) return null;
    const expected = createHmac("sha256", shareSecret()).update(body).digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (payload?.v !== 1 || !payload.exp || Number(payload.exp) < now || !payload.nonce) return null;
    const pathValue = String(payload.path || "");
    if (!pathValue.startsWith("/api/documents/")) return null;
    return { path: pathValue, exp: Number(payload.exp) };
  } catch { return null; }
}

export function verifyDocumentShareToken(token, documentPath, now = Math.floor(Date.now() / 1000)) {
  const decoded = decodeDocumentShareToken(token, now);
  return Boolean(decoded && decoded.path === String(documentPath || ""));
}

function isBlocked(ip, now = Date.now()) {
  const entry = failures.get(ip);
  if (!entry) return false;
  if (entry.resetAt <= now) { failures.delete(ip); return false; }
  return entry.count >= MAX_FAILED;
}
export function recordFailure(ip, now = Date.now()) {
  const entry = failures.get(ip);
  if (!entry || entry.resetAt <= now) {
    if (failures.size >= MAX_TRACKED_IPS) failures.delete(failures.keys().next().value);
    failures.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  } else entry.count += 1;
}
export function clearFailures(ip) { failures.delete(ip); }
export const authLimits = { MAX_FAILED, WINDOW_MS };

// حد محاولات تسجيل الدخول من الواجهة (/api/auth/login): أشد من حد Basic/Token لأنه الهدف الأول للتخمين.
const LOGIN_MAX_FAILED = bounded(process.env.SHOWROOM_LOGIN_MAX_FAILED, 10, 1, 10000);
const loginFailures = new Map();
export function loginBlocked(ip, now = Date.now()) {
  const entry = loginFailures.get(ip);
  if (!entry) return false;
  if (entry.resetAt <= now) { loginFailures.delete(ip); return false; }
  return entry.count >= LOGIN_MAX_FAILED;
}
export function recordLoginFailure(ip, now = Date.now()) {
  const entry = loginFailures.get(ip);
  if (!entry || entry.resetAt <= now) {
    if (loginFailures.size >= MAX_TRACKED_IPS) loginFailures.delete(loginFailures.keys().next().value);
    loginFailures.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  } else entry.count += 1;
}
export function clearLoginFailures(ip) { loginFailures.delete(ip); }
export const loginLimits = { MAX_FAILED: LOGIN_MAX_FAILED, WINDOW_MS };

function digest(value) { return createHash("sha256").update(String(value ?? "")).digest(); }
export function secureEqual(actual, expected) { return timingSafeEqual(digest(actual), digest(expected)); }

export function basicAuthOk(header, user, pass) {
  const value = String(header || "");
  if (!/^Basic /i.test(value) || value.length > 4096) return false;
  const encoded = value.slice(6);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const index = decoded.indexOf(":");
  if (index < 0) return false;
  return secureEqual(decoded.slice(0, index), user) && secureEqual(decoded.slice(index + 1), pass);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function cleanupSessions(now = Date.now()) {
  for (const [id, session] of sessions) if (session.expiresAt <= now) sessions.delete(id);
}
export function createSession(username, role = "ADMIN") {
  cleanupSessions();
  const id = randomBytes(32).toString("base64url");
  sessions.set(id, { username, role, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS });
  return id;
}
export function destroySessionsForUser(username) {
  for (const [id, session] of sessions) if (session.username.toLowerCase() === String(username).toLowerCase()) sessions.delete(id);
}
export function getSession(req) {
  cleanupSessions();
  const id = parseCookies(req.headers.cookie).showroom_session;
  const session = id ? sessions.get(id) : null;
  if (!session) return null;
  if (session.expiresAt <= Date.now()) { sessions.delete(id); return null; }
  return { id, ...session };
}
export function destroySession(req) {
  const session = getSession(req);
  if (session) sessions.delete(session.id);
}
export function setSessionCookie(res, id) {
  // Secure عند الاتصال عبر HTTPS (أو خلف وكيل موثوق يمرر البروتوكول)؛ على HTTP المحلي لا يمكن وضعه.
  const secure = res.req?.secure ? "; Secure" : "";
  res.set("Set-Cookie", `showroom_session=${encodeURIComponent(id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`);
}
export function clearSessionCookie(res) {
  res.set("Set-Cookie", "showroom_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
}

export function requireAuth(req, res, next, db = null) {
  if (req.baseUrl === "/api" && req.path === "/health" && ["GET", "HEAD"].includes(req.method)) return next();
  if (req.path === "/auth/login" || req.path === "/auth/session") return next();
  if (req.method === "GET" && req.path.startsWith("/documents/") && verifyDocumentShareToken(req.query?.share, `/api${req.path}`)) { req.publicDocumentShare = true; return next(); }
  const session = getSession(req);
  if (session) { req.user = session; return next(); }
  const staffAuthConfigured = Boolean(db?.prepare("SELECT 1 FROM staff_users WHERE status='ACTIVE' LIMIT 1").get());
  const incompleteBasic = Boolean(config.authUser) !== Boolean(config.authPassword);
  const local = config.nodeEnv === "test";
  if ((incompleteBasic && !staffAuthConfigured) || (!local && !authEnabled && !staffAuthConfigured)) {
    return res.status(503).json({ error: "النظام غير مهيأ للمصادقة. اضبط بيانات دخول المدير أو أنشئ حساب موظف نشطًا قبل الاستخدام." });
  }
  if (!authEnabled && !staffAuthConfigured) return next();
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  if (isBlocked(ip)) {
    res.set("Retry-After", String(Math.ceil(WINDOW_MS / 1000)));
    return res.status(429).json({ error: `تم تجاوز عدد محاولات الدخول المسموح. حاول مجددًا بعد ${Math.ceil(WINDOW_MS / 60000)} دقائق.` });
  }
  const deny = () => { recordFailure(ip); return res.status(401).json({ error: "مطلوب تسجيل الدخول أو رمز وصول صحيح" }); };
  if (config.authUser && config.authPassword && basicAuthOk(req.headers.authorization, config.authUser, config.authPassword)) { clearFailures(ip); req.user = { username: config.authUser, role: "ADMIN" }; return next(); }
  const bearer = /^Bearer (.+)$/i.exec(String(req.headers.authorization || ""));
  const token = req.headers["x-api-token"] || bearer?.[1] || "";
  if (typeof token === "string" && token.length <= 4096 && token && secureEqual(token, config.apiToken)) { clearFailures(ip); req.user = { username: "api-token", role: "ADMIN" }; return next(); }
  return deny();
}
