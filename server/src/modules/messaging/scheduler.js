// المُجدول اليومي للتذكيرات.
//
// لماذا حلقة فحص كل دقيقة بدل مكتبة جدولة؟ التطبيق يعمل على Render/Docker وقد
// يُعاد تشغيله في أي لحظة، والمكتبات الخارجية تزيد حجم الصورة. الحلقة تفحص كل دقيقة
// هل حان وقت reminder.scheduleTime ولم يُنفَّذ اليوم بعد، فتُشغّل مرة واحدة يوميًا.
// المؤقّت unref حتى لا يمنع Node من الخروج في الاختبارات.

import { localDateString } from "../../utils/date.js";

function parseTime(value, fallback) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || "").trim());
  if (!match) return fallback;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

// سياسة إعادة المحاولة: لو فشل التشغيل (عطب دائم مثل خطأ في قاعدة البيانات) فلا نعيد
// المحاولة كل دقيقة وإلا أغرقنا السجل — ننتظر retryDelayMinutes ونحاول maxRetriesPerDay
// مرة، ثم نتوقف حتى اليوم التالي.
const MAX_RETRIES_PER_DAY = 3;
const RETRY_DELAY_MINUTES = 5;

export function createScheduler({ messaging, intervalMs = 60_000, now = () => new Date(), logger = console }) {
  const { settings, reminders } = messaging;
  let timer = null;
  let lastRunDate = "";
  let running = false;
  let failCount = 0;
  let lastAttemptAt = 0;
  // تاريخ آخر محاولة (ناجحة أو فاشلة). منفصل عن lastRunDate لأن الأخير لا يُضبط إلا
  // بعد نجاح التشغيل أو استنفاد المحاولات، فربط التصفير به كان يصفّر العدّاد كل دقيقة.
  let attemptDate = "";

  async function tick(date = now()) {
    if (running) return null;
    if (!settings.getBool("whatsapp.enabled")) return null;
    if (!settings.getBool("reminder.autoRun")) return null;

    const today = localDateString(date);
    // يوم جديد ← نُصفّر عدّاد المحاولات الفاشلة.
    if (attemptDate !== today) {
      attemptDate = today;
      failCount = 0;
      lastAttemptAt = 0;
    }
    if (lastRunDate === today) return null;

    const target = parseTime(settings.get("reminder.scheduleTime"), { hour: 9, minute: 0 });
    const minutes = date.getHours() * 60 + date.getMinutes();
    if (minutes < target.hour * 60 + target.minute) return null;

    // بعد الفشل ننتظر فترة قبل إعادة المحاولة حتى لا يتكرر الخطأ كل دقيقة.
    if (failCount > 0 && date.getTime() - lastAttemptAt < RETRY_DELAY_MINUTES * 60_000) return null;

    lastAttemptAt = date.getTime();
    running = true;
    try {
      const result = await reminders.execute({ now: date, trigger: "SCHEDULE" });
      lastRunDate = today;
      failCount = 0;
      if (result.blocked) {
        logger.log?.(`[واتساب] التذكيرات المجدولة ${today} لم تُرسَل: ${result.blocks.join("، ")}`);
      } else if (result.sent?.length) {
        logger.log?.(`[واتساب] التذكيرات المجدولة ${today}: ${result.sent.length} رسالة (${JSON.stringify(result.results)})`);
      }
      return result;
    } catch (error) {
      failCount += 1;
      if (failCount >= MAX_RETRIES_PER_DAY) {
        // أوقفنا محاولات اليوم: نُعلّم التاريخ حتى لا نعيد المحاولة قبل الغد.
        lastRunDate = today;
        logger.error?.(`[واتساب] فشل تشغيل التذكيرات المجدولة ${failCount} مرات — تم الإيقاف حتى الغد: ${error?.message || error}`);
      } else {
        logger.error?.(`[واتساب] فشل تشغيل التذكيرات المجدولة (محاولة ${failCount}/${MAX_RETRIES_PER_DAY}) — إعادة المحاولة بعد ${RETRY_DELAY_MINUTES} دقائق: ${error?.message || error}`);
      }
      return null;
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { void tick(); }, intervalMs);
    timer.unref?.();
    logger.log?.(`[واتساب] المُجدول يعمل — الفحص كل ${Math.round(intervalMs / 1000)} ثانية`);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  // حالة المُجدول لعرضها في الواجهة.
  function status() {
    return {
      enabled: settings.getBool("whatsapp.enabled"),
      autoRun: settings.getBool("reminder.autoRun"),
      scheduleTime: settings.get("reminder.scheduleTime"),
      lastRunDate,
      failCount,
      maxRetriesPerDay: MAX_RETRIES_PER_DAY,
      retryDelayMinutes: RETRY_DELAY_MINUTES,
      running: Boolean(timer),
      provider: settings.get("whatsapp.provider"),
    };
  }

  return { start, stop, tick, status };
}
