// رؤوس API الأساسية. document-security.js يضيف CSP بالـ nonce للمستندات المولدة.
export function securityHeaders(req, res, next) {
  res.set("Cache-Control", "no-store");
  res.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (req.secure) res.set("Strict-Transport-Security", "max-age=31536000");
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "DENY");
  res.set("Referrer-Policy", "no-referrer");
  next();
}
