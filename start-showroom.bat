
echo ============================================
echo       معرض الزبيدي - النظام الداخلي
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js غير مثبت على الجهاز.
  echo ثبّت Node.js 22 LTS أو أحدث ثم شغّل الملف مرة أخرى.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [1/3] تثبيت حزم المشروع الرئيسية...
  call npm install
  if errorlevel 1 goto :error
)

if not exist "server\node_modules" (
  echo [2/3] تثبيت حزم السيرفر...
  call npm --prefix server install
  if errorlevel 1 goto :error
)

if not exist "server\node_modules\whatsapp-web.js\package.json" (
  echo [WA] تثبيت محرك WhatsApp Web المحلي...
  call npm --prefix server install whatsapp-web.js@1.34.7 qrcode-terminal@0.12.0
  if errorlevel 1 goto :error
)

if not exist "client\node_modules" (
  echo [3/3] تثبيت حزم الواجهة...
  call npm --prefix client install
  if errorlevel 1 goto :error
)

if not exist "client\dist\index.html" (
  echo [BUILD] تجهيز الواجهة للعمل محلياً...
  call npm --prefix client run build
  if errorlevel 1 goto :error
)

echo.
echo أول تشغيل؟ اسم المدير وكلمة المرور سيظهران في هذه النافذة وفي الملف:
echo server\data\FIRST-RUN-ADMIN.txt
echo غيّر كلمة المرور بعد الدخول ثم احذف الملف.
echo.
echo النظام سيعمل على:
echo http://localhost:4000
start "" "http://localhost:4000"
echo ومن أجهزة المعرض الأخرى: انظر عنوان الشبكة الذي سيطبعه النظام بعد التشغيل.
echo.
echo لإيقاف النظام: اضغط Ctrl+C في هذه النافذة.
echo.
call npm --prefix server start
exit /b %errorlevel%

:error
echo.
echo حدث خطأ أثناء تجهيز النظام.
pause
exit /b 1
