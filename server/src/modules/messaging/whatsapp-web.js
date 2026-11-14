// عميل WhatsApp Web محلي عبر whatsapp-web.js.
// الجلسة تُحفظ محليًا باستخدام LocalAuth؛ بعد أول ربط بالـQR لا يحتاج المستخدم لإعادة المسح ما دام مجلد الجلسة موجودًا.
// هذه طبقة اختيارية: المشروع يبقى قابلًا للتشغيل حتى لو لم تُثبّت حزم WhatsApp Web بعد.

import path from "node:path";
import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function createWhatsAppWebService({ dataDir, settings, logger = console }) {
  let client = null;
  let initPromise = null;
  let state = { status: "OFFLINE", qrAt: null, connectedAt: null, lastError: "", account: "" };
  let lastSentAt = 0;
  let queue = Promise.resolve();

  function sessionPath() {
    const p = path.join(dataDir, "whatsapp-web");
    fs.mkdirSync(p, { recursive: true });
    return p;
  }

  function numberToChatId(phone) {
    const digits = String(phone || "").replace(/[^\d]/g, "");
    return `${digits}@c.us`;
  }

  function delayMs() {
    const min = Math.max(5, Number(settings.get("whatsapp.web.minDelaySeconds")) || 45);
    const max = Math.max(min, Number(settings.get("whatsapp.web.maxDelaySeconds")) || 90);
    return Math.round((min + Math.random() * (max - min)) * 1000);
  }

  function loadPackages() {
    try {
      // whatsapp-web.js 1.34.7 is CommonJS. Using createRequire avoids
      // Node's ESM named-export interop returning LocalAuth as a non-constructor.
      const mod = require("whatsapp-web.js");
      const qrMod = require("qrcode-terminal");
      const Client = mod.Client;
      const LocalAuth = mod.LocalAuth;
      const qrcode = qrMod.default || qrMod;
      if (typeof Client !== "function" || typeof LocalAuth !== "function") {
        throw new Error("تعذر تحميل Client/LocalAuth من whatsapp-web.js");
      }
      return { Client, LocalAuth, qrcode };
    } catch (error) {
      if (error?.code === "MODULE_NOT_FOUND" || /whatsapp-web\.js|qrcode-terminal/.test(String(error?.message || ""))) {
        throw new Error("حزم WhatsApp Web غير مثبتة. شغّل: npm --prefix server install");
      }
      throw error;
    }
  }

  async function start() {
    if (initPromise) return initPromise;
    if (state.status === "READY" || state.status === "STARTING" || state.status === "QR" || state.status === "AUTHENTICATING") return state;

    initPromise = (async () => {
      state = { ...state, status: "STARTING", lastError: "" };
      const { Client, LocalAuth, qrcode } = await loadPackages();
      const clientInstance = new Client({
        authStrategy: new LocalAuth({ dataPath: sessionPath() }),
        puppeteer: {
          headless: false,
          dumpio: true,
          timeout: 120000,
          args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--start-maximized"],
          defaultViewport: null,
        },
      });
      client = clientInstance;

      client.on("qr", (qr) => {
        state = { ...state, status: "QR", qrAt: new Date().toISOString(), lastError: "" };
        logger.log?.("[واتساب] ستفتح نافذة WhatsApp Web؛ امسح رمز QR منها لربط الحساب:");
        try { qrcode.generate(qr, { small: true }); } catch { logger.log?.(qr); }
      });
      client.on("authenticated", () => {
        state = { ...state, status: "AUTHENTICATING", lastError: "" };
        logger.log?.("[واتساب] تم توثيق الجلسة.");
      });
      client.on("ready", () => {
        const info = client.info;
        state = {
          ...state,
          status: "READY",
          connectedAt: new Date().toISOString(),
          account: info?.wid?.user ? `+${info.wid.user}` : info?.pushname || "",
          lastError: "",
        };
        logger.log?.(`[واتساب] جاهز للإرسال${state.account ? ` — الحساب ${state.account}` : ""}.`);
      });
      client.on("auth_failure", (message) => {
        state = { ...state, status: "ERROR", lastError: String(message || "فشل توثيق واتساب") };
        logger.error?.(`[واتساب] فشل التوثيق: ${state.lastError}`);
      });
      client.on("disconnected", (reason) => {
        state = { ...state, status: "DISCONNECTED", lastError: String(reason || "تم قطع الاتصال") };
        logger.error?.(`[واتساب] انقطع الاتصال: ${state.lastError}`);
      });
      client.on("error", (error) => {
        state = { ...state, status: "ERROR", lastError: error?.message || String(error) };
        logger.error?.(`[واتساب] ${state.lastError}`);
      });

      logger.log?.("[واتساب] بدأ تشغيل محرك WhatsApp Web. إذا لم تظهر النافذة، راجع رسائل Chromium التالية في هذه النافذة.");
      await client.initialize();
      return state;
    })();

    try {
      return await initPromise;
    } finally {
      initPromise = null;
    }
  }

  async function send({ phone, text }) {
    if (state.status !== "READY" || !client) {
      await start();
    }
    if (state.status !== "READY" || !client) {
      throw new Error("WhatsApp Web غير جاهز. امسح QR أول مرة وانتظر ظهور «جاهز للإرسال».");
    }

    const chatId = numberToChatId(phone);
    const task = async () => {
      if (lastSentAt) {
        await sleep(Math.max(0, lastSentAt + delayMs() - Date.now()));
      }
      if (state.status !== "READY" || !client) throw new Error("تم فقد اتصال WhatsApp Web قبل الإرسال");
      const message = await client.sendMessage(chatId, String(text));
      lastSentAt = Date.now();
      return { status: "SENT", messageId: message?.id?.id || message?.id?._serialized || "" };
    };

    // طابور واحد حتى لا تخرج رسالتان في نفس اللحظة من أزرار مختلفة أو من المجدول.
    const run = queue.catch(() => {}).then(task);
    queue = run.catch(() => {});
    return run;
  }

  async function stop() {
    if (client) {
      try { await client.destroy(); } catch { /* قد يكون الاتصال مفصولًا أصلًا */ }
    }
    client = null;
    state = { status: "OFFLINE", qrAt: null, connectedAt: null, lastError: "", account: "" };
  }

  async function logout() {
    if (client) {
      try { await client.logout(); } catch { /* قد يكون الاتصال مفصولًا أصلًا */ }
      try { await client.destroy(); } catch { /* لا يهم */ }
    }
    client = null;
    state = { status: "OFFLINE", qrAt: null, connectedAt: null, lastError: "", account: "" };
  }

  function status() {
    return {
      ...state,
      configured: true,
      sessionPath: sessionPath(),
      minDelaySeconds: Number(settings.get("whatsapp.web.minDelaySeconds")) || 45,
      maxDelaySeconds: Number(settings.get("whatsapp.web.maxDelaySeconds")) || 90,
    };
  }

  return { start, send, stop, logout, status };
}
