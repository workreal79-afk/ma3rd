# معرض الزبيدي — Architecture

## الاتجاه المعماري
المشروع الآن Modular Monolith: كل نطاق عمل مستقل داخل `server/src/modules`، مع طبقة Core مشتركة، وقاعدة بيانات SQLite واحدة محليًا. هذا يسهل إضافة وظائف مستقبلية بدون إعادة كتابة التطبيق كله.

## Backend
```text
server/src/
  app.js                     # تركيب Express فقط
  index.js                   # تشغيل وإغلاق السيرفر
  core/
    context.js               # Dependency Injection للسياق
    module-registry.js       # تسجيل وحدات النظام
  config/                    # الإعدادات
  db/                        # schema/migrations/seed/database
  middlewares/               # أخطاء HTTP + المصادقة + رؤوس الأمان
  modules/
    finance/                 # الحسابات المالية + خطة الأقساط
    sales/                   # المبيعات والعقود
    payments/                # التحصيلات وسداد البائعين
    vehicles/                # السيارات
    customers/               # المشترون
    guarantors/              # الكفلاء
    sellers/                 # البائعون
    reports/                 # التقارير
    documents/               # العقود والكمبيالات والسندات
    general/                 # النسخ الاحتياطي والإعدادات العامة
  shared/                    # validation/constants/transaction
  utils/                     # تواريخ وتنسيق ومستندات
```

### قواعد التوسع
1. أي ميزة جديدة تنتمي إلى Module واضح، ولا تضف SQL جديدًا إلى `app.js`.
2. منطق الحسابات المالية يبقى داخل `modules/finance` أو Service النطاق، وليس داخل React.
3. كل عملية متعددة الخطوات تستخدم transaction واحدة.
4. أرقام المستندات تمر عبر sequence service واحد.
5. التاريخ التجاري يستخدم `YYYY-MM-DD` محليًا، ولا يستخدم `toISOString()` لحساب تاريخ تقويمي.
6. لا تحذف سجلات مالية؛ استخدم cancel/reversal مع audit.

## Frontend
```text
client/src/
  app/          # shell/navigation/state/hooks
  components/   # مكونات UI المشتركة
  pages/        # شاشات النظام الحالية
  services/     # API layer
  lib/          # helpers مشتركة (errors.js مستخدم فعليًا في كل معالجات الأخطاء)
  features/     # مكان التوسع القادم حسب النطاق
```

## لماذا Modular Monolith؟
لأن النظام حاليًا نظام داخلي على جهاز واحد. فصل الدومينات يوفر التنظيم والاختبار والتوسع بدون تعقيد microservices أو شبكة داخلية متعددة الخدمات. ويمكن استخراج أي Module مستقبلًا إلى خدمة مستقلة إذا زاد الحجم.


## V45 stability rules
- Calendar dates are date-only values; installment month arithmetic clamps to the last valid day of the target month.
- `bills.bill_number` is the source of truth for the printed installment bill number.
- Input amounts and dates are validated through `server/src/shared/validation.js`.
- Database schema changes are tracked in `schema_migrations` with named, repeatable migrations.
- High-impact payment operations should remain transactional and write to `audit_log`.


## V47 changes
- Customer profile statement now uses the same print design system as the sale installment schedule, with multi-contract summary and detailed installments/collections.
- Bill display numbering no longer shows leading zeroes; stored legacy values are normalized for display, and newly created bill sequence values are generated without padding.

## V49 changes (WhatsApp messaging)
وحدة مراسلة مستقلة تحت `modules/messaging/`، مبنية على نفس نمط باقي الوحدات
(خدمة تُبنى بحقن التبعيات + مسارات تُسجَّل في `module-registry`).

- **طبقة مزوّدين قابلة للاستبدال** (`providers.js`): ‏`LINK` يبني رابط `wa.me` محليًا دون أي
  اتصال خارجي، و`CLOUD` ينادي WhatsApp Business Cloud API. الاثنان يرجعان نفس الشكل
  `{status, link?, error?}` فتغيير المزوّد لا يمسّ أي كود آخر.
- **فصل القرار عن التنفيذ**: ‏`compose.js` يقرّر *لمن* و*ماذا*، و`reminders.js` يقرّر *متى*
  و*هل يُسمح*، و`providers.js` ينفّذ. لذلك يمكن معاينة الرسائل دون إرسال.
- **الإعدادات في قاعدة البيانات لا في الكود** (جدول `settings` بمفتاح/قيمة مع قيم افتراضية
  وقواعد تحقق لكل مفتاح)، فتُعدَّل السياسة والنصوص من الواجهة دون إعادة نشر.
- **`message_log` سجل ومصدر قرار معًا**: يُستخدم للعرض ولـ منع التكرار ولحساب السقف
  اليومي والحد الأقصى لكل قسط، مع فهرس `(kind, entity_type, entity_id, recipient_phone)`.
- **قاعدة التوجيه** تعتمد `sales.transaction_mode`: ‏`INTERMEDIARY` → المالك من `sellers`،
  و`DIRECT` → رقم المعرض من الإعدادات. لا يُخزَّن رقم مكرر؛ يُقرأ من مصدره الأصلي.
- **مُجدول بلا مكتبة خارجية** (`scheduler.js`): حلقة فحص كل دقيقة لأن الحاوية قد تُعاد
  في أي لحظة، والمؤقّت `unref` حتى لا يمنع خروج العملية في الاختبارات. عند الفشل ينتظر
  5 دقائق ويحاول 3 مرات ثم يتوقف حتى الغد — لا إغراق للسجل.
- **التوكن لا يُعاد كاملًا أبدًا**: ‏`GET /api/messaging/settings` يقنّعه (آخر 4 أحرف)،
  وحفظ القيمة المقنّعة لا يمسح التوكن الحقيقي.
- **حقن `fetch` في الاختبارات** (`fetchImpl`) فاختُبر Cloud API — النجاح وخطأ ميتا وانقطاع
  الشبكة — دون أي اتصال حقيقي.

## V48 changes (QA hardening)
طبقة أمان وموثوقية أُضيفت بعد جولة الاختبار الشاملة (التفاصيل والأدلة في `QA-REPORT.md`):

- **مصادقة مطلوبة بلا كلمة افتراضية** (`middlewares/auth.js`، `utils/first-run-admin.js`): ‏Basic Auth عبر `SHOWROOM_AUTH_USER`/`SHOWROOM_AUTH_PASS`
  أو رمز وصول عبر `SHOWROOM_API_TOKEN` في الرأس `X-API-Token`. تُحمى كل نقاط `/api/*` ويُستثنى
  `/api/health` لفحص الصحة. الحد الافتراضي 50 محاولة فاشلة لكل عنوان خلال 10 دقائق ثم `429`.
  مطلوبة افتراضيًا للتشغيل الحقيقي؛ غياب الإعدادات يعيد 503. الاختبارات والمعاينة المنفصلة استثناء صريح.
  عند استخدام Basic Auth تُحمى صفحة الواجهة أيضًا لفتح نافذة الدخول قبل تحميل التطبيق.
- **CORS مقصور على نفس النطاق** افتراضيًا (بلا رأس `Access-Control-Allow-Origin`) ويُفتح بـ
  `SHOWROOM_CORS_ORIGIN`. رؤوس `X-Content-Type-Options` و`X-Frame-Options` و`Referrer-Policy`
  تطبق على الـ API والمستندات؛ صفحة الواجهة تسمح بالتأطير للمعاينة.
- **`trust proxy`** غير مفعّل في التشغيل المباشر. `SHOWROOM_TRUST_PROXY` يحدد عدد
  القفزات أو عناوين الوكلاء الموثوقين؛ هذه السياسة تشمل عنوان الزائر وبناء أصل روابط المستندات.
- **فصل الصور عن قائمة السيارات**: ‏`GET /api/vehicles` يعيد `image_count` بلا `images_json`،
  والصور تُجلب من `GET /api/vehicles/:id`. قاعدة معمارية: **لا تُعاد الحمولات الكبيرة في القوائم**.
- **`req.body` مُهيّأ دائمًا** بـ middleware بعد `express.json()` — في Express 5 يبقى `undefined`
  عندما لا يُعالَج جسم، وكان فكّ التركيب يرمي `TypeError` → ‏`500`.
- **مسارات `/api` غير المعروفة تعيد JSON**، لا صفحة HTML.
### إصلاحات الأمان اللاحقة

تهريب JSON المضمن وHTML الذي يولده العقد، CSP بالـ nonce، رفض التحصيل على بيع ملغى،
التدقيق والتحقق من التواريخ والمدخلات أصبحت مغطاة باختبارات حارسة بلا `todo`.
تراجع `SECURITY-REVIEW.md` للإعدادات والقيود الفعلية.

- **`TZ=Asia/Riyadh`** في `Dockerfile` و`render.yaml` — كل حسابات الاستحقاق/التأخير تعتمد التاريخ المحلي.
- البيانات التجريبية اختيارية بـ `SHOWROOM_SEED_DEMO`؛ التشغيل الحقيقي لا يخلط بيانات وهمية افتراضيًا.

## متابعة دمج 2026-09-30

- السياق يبني `messaging` و`messagingScheduler` ويحقنهما في المسارات المسجلة؛
  `index.js` وحده يبدأ المؤقت ويوقفه عند الإغلاق. إنشاء التطبيق في الاختبارات لا يبدأ إرسالًا دوريًا.
- `db/messaging-schema.js` يعرّف جداول الإعدادات والسجل وفهرس منع التكرار.
  التهيئة والهجرة `015_messaging_settings_and_log` تستخدمان نفس الدالة القابلة للتكرار.
- النسخ الاحتياطي يعتمد على اتصال القاعدة النشط، والاسترجاع يشمل `settings` و`message_log`.
  النسخ السابقة لميزة واتساب تستعيد البيانات الأساسية وتستخدم الإعدادات الافتراضية للرسائل.
- `npm run check` يفحص كل ملفات `.js` في `server/src` و`server/test`، وليس ملفي الدخول فقط؛
  هذا يمنع مرور بقايا Patch أو ملف اختبار ناقص إلى بوابة الجودة.

## إيصال استلام السيارة والأمان

- `modules/documents/vehicle-receipt.routes.js` يقرأ بيانات بيع نشط ويصدر نموذجًا ورقيًا
  دون تسجيل تاريخ تسليم افتراضي أو إنشاء تحصيل. رابط في البيع وفي ملف المشتري.
- `request-origin.js` يمنع طلبات الكتابة ذات Origin غريب، و`document-security.js`
  يسمح فقط بعدد السكربتات المتوقعة ويضيف nonce وCSP وحدث الطباعة الآمن.
- `InputError` يميز أخطاء المدخلات؛ الأخطاء الداخلية لا تسرب SQL/stack في الاستجابة.
- خطة الأقساط تستخدم السنتات وحدًا 600 قسط لمنع أخطاء الأرقام وتعليق الخادم.
- النسخ اليدوي snapshot مستقل، والاسترجاع يتحقق من المخطط والعلاقات قبل اعتماد معاملة ذرية.
- النسخ التلقائي يستخدم ملف staging غير ظاهر كنسخة صالحة، ثم rename ذري، مع حماية
  من توازي الوظائف وأسماء غير متصادمة وصلاحيات ملفات خاصة وحدود للمؤقت والاحتفاظ.
- Demo يختار قاعدة منفصلة مهما كانت قيمة `SHOWROOM_DB`؛ لا يفتح القاعدة الحقيقية بلا اعتماد.
