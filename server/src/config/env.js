// لا نثق برؤوس الوكيل إلا عند ضبط عدد القفزات أو عناوين الوكلاء صراحةً.
// أمثلة: SHOWROOM_TRUST_PROXY=1 خلف وكيل واحد، أو loopback للاختبارات المحلية.
const proxySetting = String(process.env.SHOWROOM_TRUST_PROXY || "").trim();
const trustProxy = !proxySetting || proxySetting === "false" || proxySetting === "0"
  ? false
  : /^\d+$/.test(proxySetting)
    ? Number(proxySetting)
    : proxySetting.split(",").map((value) => value.trim()).filter(Boolean);

const nodeEnv = process.env.NODE_ENV || "development";
const demoMode = nodeEnv === "development" && process.env.SHOWROOM_DEMO_MODE === "1";

export const config = {
  nodeEnv,
  demoMode,
  port: Number(process.env.PORT || 4000),
  // Demo always uses a separate database, never a configured live database.
  databaseFile: demoMode ? "showroom-demo.sqlite" : process.env.SHOWROOM_DB || "showroom.sqlite",
  // لا توجد بيانات دخول افتراضية مدمجة في الكود. أول تشغيل بلا إعدادات ينشئ مديرًا بكلمة مرور عشوائية
  // (انظر utils/first-run-admin.js)؛ أو اضبط SHOWROOM_AUTH_USER / SHOWROOM_AUTH_PASS صراحةً.
  authUser: process.env.SHOWROOM_AUTH_USER || "",
  authPassword: process.env.SHOWROOM_AUTH_PASS || "",
  apiToken: process.env.SHOWROOM_API_TOKEN || "",
  corsOrigins: String(process.env.SHOWROOM_CORS_ORIGIN || "").split(",").map((origin) => origin.trim()).filter(Boolean),
  trustProxy,
};

export const authEnabled = Boolean(
  (config.authUser && config.authPassword) || config.apiToken
);
