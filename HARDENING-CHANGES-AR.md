# تعديلات التشديد والتنظيف — 2026-10-10

مبنية على مراجعة قراءة للنسخة المرفوعة (`alzubaidi-showroom-whatsapp-share-v2-updated`). بنية المشروع وقاعدة البيانات
لم تتغير، ولا توجد هجرات جديدة.

## أ. الأمان

| الملف | التغيير |
|---|---|
| `server/src/config/env.js` | إزالة `admin`/`admin123` الافتراضية. |
| `server/src/utils/first-run-admin.js` (جديد) + `server/src/index.js` | أول تشغيل بلا بيانات دخول ولا حسابات نشطة: ينشئ `admin` بكلمة مرور عشوائية (24 حرفًا)، تظهر في النافذة وتُحفظ في `server/data/FIRST-RUN-ADMIN.txt`، وتُسجَّل العملية في سجل الحركات دون كلمة المرور. ويطبع عناوين الشبكة المحلية. |
| `server/src/middlewares/auth.js` + `server/src/app.js` | حد 10 محاولات فاشلة/10 دقائق لنموذج الدخول؛ سر روابط المشاركة عشوائي (لا نص ثابت ولا كلمة مرور المدير)؛ `Secure` على الكوكي عند HTTPS. |
| `server/src/utils/share-secret.js` (جديد) | سر المشاركة محفوظ في `server/data/.share-secret` بصلاحيات خاصة؛ حذفه يبطل كل الروابط الصادرة. أو `SHOWROOM_SHARE_SECRET`. |
| `server/src/middlewares/permissions.js` | `/backup` و`/backup/status` و`/audit-log` للمدير والمحاسب فقط. |
| `client/src/app/App.jsx` | إخفاء أزرار النسخ الاحتياطي والاسترجاع وصفحة سجل الحركات عن الأدوار غير المصرح لها. |
| `server/src/modules/general/general.routes.js` | تسجيل اسم المستخدم في سجل الحركات عند تنزيل نسخة احتياطية (كان `system`). |

## ب. العقود المقفولة

في `server/src/modules/payments/payments.routes.js`: تعديل التحصيل (`PUT /payments/:id`) وعكسه
(`DELETE /payments/:id`) ونقله من قسط في عقد مقفول (`POST /payments/:id/transfer`) يرجع `409` برسالة عربية.
**قرار مفتوح:** لا يوجد مسار «إعادة فتح عقد»؛ فتصحيح خطأ في عقد مقفول يحتاج تدخلًا يدويًا حاليًا.
ولم يُغيَّر `POST /payments/:id/refunds` (رد المبلغ) على عقد مقفول عمدًا.

## ج. التوثيق والتنظيف

- README موحّد (v1.2.0)، وأُزيلت علامات V7/V24/V26/V47 المتضاربة، وصُحّحت أرقام الاختبارات (تاريخية لا حالية).
- تحديث `README-LOCAL.md` و`DEPLOY.md` و`ARCHITECTURE.md` و`SECURITY-REVIEW.md` (قسم تصحيحات 2026-10-10).
- إضافة `.gitignore` (قاعدة البيانات والنسخ والأسرار وملف أول تشغيل).
- `start-showroom.bat`: ترميز UTF-8 لعرض العربية، وتنبيه أول تشغيل.
- حذف `package.json.tmp` (ملف فارغ).

## الاختبارات

- جديدة: `server/test/auth-hardening.test.js` (7) + 3 في `permissions-passwords.test.js`.
- **نُفّذ في بيئة الفحص (بلا مكتبات):** `unit.utils` 35، `date-and-finance` 5، `permissions-passwords` 8، `auth-hardening` 7 — كلها ناجحة؛ إضافة إلى فحص صياغة كل ملفات الخادم والواجهة وحلّ كل الـ imports.
- **لم يُنفّذ:** اختبارات التكامل والواجهة (تحتاج `npm install`). **شغّل `npm run check:all` على جهازك.**
- لم تُضف اختبارات تكامل للعقود المقفولة لأنها كانت ستُكتب دون إمكانية تشغيلها هنا.
