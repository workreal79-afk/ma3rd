FROM node:22-bookworm-slim
WORKDIR /app
# المنطقة الزمنية مهمة: كل حسابات الاستحقاق/التأخير تستخدم التاريخ المحلي للخادم.
# بدونها تعمل الحاوية على UTC فينحرف "اليوم" ٣ ساعات عن توقيت المعرض.
ENV TZ=Asia/Riyadh
ENV PORT=4000
ENV HOST=0.0.0.0

# ⚠️ لا تضبط NODE_ENV=production قبل التثبيت: npm يحذف devDependencies تلقائيًا
# عندما يكون NODE_ENV=production، وعندها لا يُثبَّت vite ويفشل `npm run build`
# برسالة «vite: not found» ورمز خروج 127. لذلك يُضبط في النهاية بعد البناء.
COPY server/package.json server/package-lock.json ./server/
COPY client/package.json client/package-lock.json ./client/
RUN npm --prefix server ci --omit=dev \
 && npm --prefix client ci --include=dev

COPY server ./server
COPY client ./client
# فحص وجود Vite ثم بناء الواجهة مرة واحدة فقط.
RUN test -x client/node_modules/.bin/vite \
      || { echo "فشل: vite غير مثبّت داخل client/node_modules — تأكد أن NODE_ENV=production لا يُضبط قبل خطوة التثبيت"; exit 1; } \
 && npm --prefix client run build \
 && rm -rf client/node_modules /root/.npm
# بعد البناء تكون client/dist مكتفية بذاتها (React مضمّن داخل الحزمة)، والخادم
# يخدمها كملفات ثابتة — لذلك لا حاجة لـ client/node_modules في الصورة النهائية.

ENV NODE_ENV=production
ENV PORT=4000

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/src/index.js"]
