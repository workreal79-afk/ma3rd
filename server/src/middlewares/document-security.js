import { randomBytes } from "node:crypto";

// كل سكربت موثوق داخل المستند يحصل على nonce؛ لا نسمح بـ inline handlers أو eval.
// التهريب في renderer مستقل وضروري أيضًا: CSP طبقة دفاع إضافية وليست بديلًا عنه.
export function secureDocumentResponses(req, res, next) {
  const send = res.send.bind(res);
  res.send = function (body) {
    if (typeof body === "string" && /<(?:!doctype|html)\b/i.test(body)) {
      const expectedScripts = /\/documents\/contract\//i.test(req.path) ? 2 : /\/documents\/(?:note|guarantor-note)\//i.test(req.path) ? 2 : /\/documents\/bills\//i.test(req.path) ? 1 : /\/documents\/vehicle-receipt\//i.test(req.path) ? 1 : 0;
      const scriptCount = (body.match(/<script\b/gi) || []).length;
      // لا نعطي nonce لسكربت إضافي ربما جاء من بيانات غير مهربة.
      if (scriptCount !== expectedScripts || /<script\b[^>]*\bsrc=/i.test(body)) {
        res.status(500).type("json");
        return send(JSON.stringify({ error: "تعذر إنشاء المستند بأمان" }));
      }
      const nonce = randomBytes(18).toString("base64");
      body = body.replace(/\bonclick=(["'])window\.print\(\);?\1/gi, 'data-document-action="print"')
        .replace(/\bonclick=(["'])generate\(\);?\1/gi, 'data-document-action="generate"')
        .replace(/\boninput=(["'])calculateRemainingAndTafqeet\(\);?\1/gi, 'data-document-input="calculate"')
        .replace(/<script\b([^>]*)>/gi, `<script nonce="${nonce}"$1>`);
      const actions = `<script nonce="${nonce}">document.addEventListener('click',e=>{const b=e.target.closest('[data-document-action]');if(!b)return;const a=b.dataset.documentAction;if(a==='print'&&Array.from(document.querySelectorAll('input,textarea')).every(f=>f.reportValidity()))window.print();if(a==='generate'&&typeof generate==='function')generate();});document.addEventListener('input',e=>{if(e.target instanceof HTMLTextAreaElement){e.target.style.height='auto';e.target.style.height=e.target.scrollHeight+'px';}if(e.target.dataset.documentInput==='calculate'&&typeof calculateRemainingAndTafqeet==='function')calculateRemainingAndTafqeet();});</script>`;
      body = /<\/body>/i.test(body) ? body.replace(/<\/body>/i, `${actions}</body>`) : body + actions;
      res.set("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; base-uri 'none'; object-src 'none'; form-action 'self'; frame-ancestors 'none'`);
    }
    return send(body);
  };
  next();
}
