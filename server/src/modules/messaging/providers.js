// طبقة الإرسال الموحّدة. كل مزوّد يرجع نفس الشكل:
//   { status, link?, error? }
// المزوّد الافتراضي LINK لا يحتاج أي اشتراك أو مفاتيح: يبني رابط wa.me بالرسالة
// جاهزة، والموظف يدوس «إرسال» من هاتفه أو من واتساب ويب. وهذا يعمل بلا إنترنت على
// الخادم تمامًا — الخادم لا يتصل بأي جهة خارجية.
// المزوّد CLOUD هو WhatsApp Business Cloud API الرسمي من ميتا (إرسال أوتوماتيك،
// وله حصة مجانية شهرية)، ويحتاج phoneId + token، ولرسائل التنبيه التي يبدأها النشاط
// التجاري يحتاج قالبًا معتمدًا من ميتا.

import { normalizePhone } from "./phone.js";

const GRAPH_VERSION = process.env.SHOWROOM_WA_GRAPH_VERSION || "v21.0";

export function buildWaMeLink(phone, text) {
  const digits = String(phone ?? "").replace(/[^\d]/g, "");
  return `https://wa.me/${digits}?text=${encodeURIComponent(String(text ?? ""))}`;
}

// رابط المستند داخل التطبيق. لو لم يُضبط رابط عام في الإعدادات يُشتق من طلب المستخدم،
// وإلا يرجع مسارًا نسبيًا (يفتح محليًا فقط).
export function buildDocumentLink({ baseUrl, origin, path }) {
  const root = String(baseUrl || origin || "").trim().replace(/\/+$/, "");
  const cleanPath = String(path || "").startsWith("/") ? path : `/${path}`;
  return root ? `${root}${cleanPath}` : cleanPath;
}

export function providerLabel(provider) {
  if (provider === "CLOUD") return "WhatsApp Cloud API";
  if (provider === "WEB") return "WhatsApp Web محلي (تلقائي)";
  return "رابط wa.me";
}

// إرسال فعلي عبر Meta Cloud API.
// ملاحظة: الرسائل التي يبدأها النشاط التجاري (تذكيرات المتأخرات) تتطلب قالبًا معتمدًا؛
// لو لم يُضبط اسم قالب نُرسِل نصًا حرًا، وينجح فقط داخل نافذة خدمة العميل (24 ساعة).
async function sendViaCloud({ phone, text, phoneId, token, templateName, templateParams, fetchImpl, timeoutMs = 15000 }) {
  if (!phoneId || !token) {
    return { status: "FAILED", error: "مزوّد CLOUD مفعّل لكن whatsapp.cloud.phoneId أو whatsapp.cloud.token غير مضبوط" };
  }
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== "function") {
    return { status: "FAILED", error: "لا تتوفر دالة fetch في هذا التشغيل" };
  }

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(phoneId)}/messages`;
  const payload = templateName
    ? {
        messaging_product: "whatsapp",
        to: phone,
        type: "template",
        template: {
          name: templateName,
          language: { code: process.env.SHOWROOM_WA_LANG || "ar" },
          components: templateParams?.length
            ? [{ type: "body", parameters: templateParams.map((p) => ({ type: "text", text: String(p) })) }]
            : undefined,
        },
      }
    : { messaging_product: "whatsapp", to: phone, type: "text", text: { preview_url: true, body: text } };

  try {
    const response = await doFetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(Math.max(1, Math.min(60000, Math.trunc(Number(timeoutMs) || 15000)))),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    const raw = await response.text();
    if (!response.ok) {
      let detail = raw.slice(0, 300);
      try {
        const parsed = JSON.parse(raw);
        detail = parsed?.error?.message || detail;
      } catch { /* نبقي النص الخام */ }
      return { status: "FAILED", error: `HTTP ${response.status}: ${detail}` };
    }
    let messageId = "";
    try { messageId = JSON.parse(raw)?.messages?.[0]?.id || ""; } catch { /* لا يهم */ }
    return { status: "SENT", messageId };
  } catch (error) {
    return { status: "FAILED", error: `تعذّر الاتصال بميتا: ${error?.message || error}` };
  }
}

// نقطة الدخول الموحّدة.
export async function dispatchMessage({
  provider = "LINK",
  phone,
  text,
  countryCode = "966",
  cloud = {},
  web,
  fetchImpl,
  timeoutMs = 15000,
}) {
  const normalized = normalizePhone(phone, countryCode);
  if (!normalized) {
    return { status: "FAILED", error: `رقم غير صالح: ${phone ?? "(فارغ)"}` };
  }
  if (!String(text ?? "").trim()) {
    return { status: "FAILED", error: "نص الرسالة فارغ" };
  }

  const link = buildWaMeLink(normalized, text);
  const selected = String(provider).toUpperCase();
  if (selected === "WEB") {
    if (!web || typeof web.send !== "function") {
      return { status: "FAILED", error: "محرّك WhatsApp Web المحلي غير مهيأ" };
    }
    try {
      const result = await web.send({ phone: normalized, text });
      return { ...result, link, phone: normalized };
    } catch (error) {
      return { status: "FAILED", error: error?.message || String(error), link, phone: normalized };
    }
  }

  if (selected !== "CLOUD") {
    // المزوّد LINK لا يرسل شيئًا بنفسه: يجهّز الرابط ويسجّله ليضغطه الموظف.
    return { status: "LINK_READY", link, phone: normalized };
  }

  const result = await sendViaCloud({
    phone: normalized,
    text,
    phoneId: cloud.phoneId,
    token: cloud.token,
    templateName: cloud.templateName,
    templateParams: cloud.templateParams,
    fetchImpl,
    timeoutMs,
  });
  return { ...result, link, phone: normalized };
}
