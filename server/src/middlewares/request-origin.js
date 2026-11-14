import { config } from "../config/env.js";

export function requestOrigin(req) {
  const trusted = req.app.get("trust proxy fn")(req.socket.remoteAddress, 0);
  const forwarded = trusted ? String(req.headers["x-forwarded-host"] || "").split(",")[0].trim() : "";
  const host = forwarded || req.get("host");
  try { return host ? new URL(`${req.protocol === "https" ? "https" : "http"}://${host}`).origin : ""; }
  catch { return ""; }
}

// CORS وحده لا يمنع تنفيذ POST من نموذج في موقع آخر، خاصةً مع Basic Auth.
export function requireTrustedOrigin(req, res, next) {
  if (req.publicDocumentShare || ["GET", "HEAD", "OPTIONS"].includes(req.method) || !req.headers.origin) return next();
  const origin = String(req.headers.origin);
  const expected = requestOrigin(req);
  let localMatch = false;
  try {
    localMatch = ["development", "test"].includes(config.nodeEnv)
      && ["http:", "https:"].includes(new URL(origin).protocol)
      && new URL(origin).host === new URL(expected).host;
  } catch { /* أصل غير صالح يُرفض */ }
  if (origin === expected || localMatch || config.corsOrigins.includes(origin)) return next();
  return res.status(403).json({ error: "مصدر الطلب غير مسموح" });
}
