import { db, dataDir } from "../db/index.js";
import { localDateString, addMonths } from "../utils/date.js";
import { money, formatAmountDigits, escapeHtml, serialNumber } from "../utils/format.js";
import { documentPage, formatDateArabic, hijriFromGregorian, toArabicDigits, tafqeet, amountInWordsArabic } from "../utils/documents.js";
import { createFinancialServices } from "../modules/finance/finance.service.js";
import { createMessagingService } from "../modules/messaging/messaging.service.js";
import { createScheduler } from "../modules/messaging/scheduler.js";
import { createWhatsAppWebService } from "../modules/messaging/whatsapp-web.js";

export function createAppContext() {
  const financial = createFinancialServices(db, { localDateString });
  const messaging = createMessagingService({ db, localDateString, money });
  const whatsappWeb = createWhatsAppWebService({ dataDir, settings: messaging.settings });
  const messagingWeb = whatsappWeb;
  messaging.setWhatsAppWeb?.(messagingWeb);
  const messagingScheduler = createScheduler({ messaging });
  return {
    db,
    dataDir,
    localDateString,
    addMonths,
    money,
    formatAmountDigits,
    escapeHtml,
    serialNumber,
    documentPage,
    formatDateArabic,
    hijriFromGregorian,
    toArabicDigits,
    tafqeet,
    amountInWordsArabic,
    ...financial,
    messaging,
    messagingWeb,
    messagingScheduler,
  };
}
