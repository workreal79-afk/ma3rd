// المسار الافتراضي نسبي (/api) حتى تعمل الواجهة من نفس نطاق النشر
// (Render / Docker / المعاينة) بدل الاعتماد على localhost داخل متصفح المستخدم.
// في وضع التطوير يقوم vite.config.js بتمرير /api إلى الخادم المحلي.
// يمكن التجاوز عند الحاجة عبر VITE_API_URL.
export const API = import.meta.env.VITE_API_URL || "/api";

export async function apiRequest(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(options.headers || {}),
    },
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "حدث خطأ في الاتصال بالخادم");
    error.status = response.status;
    if (Array.isArray(data.details)) error.details = data.details;
    throw error;
  }
  return data;
}

// Backward-compatible shorthand used by the feature pages/components.
export const api = apiRequest;

export function money(value) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString("ar-SA", { maximumFractionDigits: 2 });
}

export function today() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function serialNumber(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const m = raw.match(/(\d+)$/);
  if (!m) return raw;
  return String(Number(m[1]));
}
