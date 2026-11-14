import { config } from "../../config/env.js";
import { autoBackupOptions } from "../../utils/auto-backup.js";
import { asPositiveMoney, asDate, requireText, optionalText, positiveId, safeInteger } from "../../shared/validation.js";
import { InputError } from "../../shared/errors.js";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import path from "node:path";

function cleanupRestoreTempFiles(tempPath) {
  // SQLite may create sidecars while opening a database in WAL mode.
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      fs.rmSync(`${tempPath}${suffix}`, { force: true });
    } catch (error) {
      console.error(`تعذر حذف ملف الاسترجاع المؤقت ${tempPath}${suffix}:`, error);
    }
  }
}
export function registerGeneralRoutes(app, context) {
const { db, dataDir, localDateString, money, statusFromInstallment, syncInstallmentStatus, syncSaleRemaining, syncSellerPaid, audit } = context;
app.get("/api/health", (_, res) => res.json({ok:true,time:localDateString(),demo:config.demoMode}));

app.get("/api/backup/status", (_, res) => {
  const backupDir = path.join(dataDir, "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const files = fs.readdirSync(backupDir)
    .filter(name => /^showroom-auto-.*\.sqlite$/.test(name))
    .map(name => {
      const full = path.join(backupDir, name);
      const stat = fs.statSync(full);
      return { name, size: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  const service = context.autoBackup;
  res.json({
    ...autoBackupOptions(),
    ...service?.status?.(),
    enabled: Boolean(service?.enabled),
    trigger: service?.trigger || "after-action",
    last: files[0] || null,
    count: files.length,
  });
});

app.get("/api/dashboard", (_, res) => {
  const today = localDateString();
  const month = today.slice(0,7);
  const counts = db.prepare(`SELECT
    SUM(CASE WHEN status IN ('IN_STOCK','RESERVED') THEN 1 ELSE 0 END) available_total,
    SUM(CASE WHEN status='IN_STOCK' THEN 1 ELSE 0 END) available,
    SUM(CASE WHEN status='RESERVED' THEN 1 ELSE 0 END) reserved,
    SUM(CASE WHEN status='SOLD' THEN 1 ELSE 0 END) sold,
    COALESCE(SUM(CASE WHEN status IN ('IN_STOCK','RESERVED') THEN price ELSE 0 END),0) inventory_value
    FROM vehicles WHERE archived_at IS NULL`).get();
  const customers = db.prepare("SELECT COUNT(*) c FROM customers WHERE archived_at IS NULL").get().c;
  const installments = db.prepare(`SELECT
    COALESCE(SUM(CASE WHEN paid_amount < amount THEN amount-paid_amount ELSE 0 END),0) outstanding,
    COALESCE(SUM(CASE WHEN due_date < ? AND paid_amount < amount THEN amount-paid_amount ELSE 0 END),0) overdue_amount,
    SUM(CASE WHEN due_date < ? AND paid_amount < amount THEN 1 ELSE 0 END) overdue_count,
    SUM(CASE WHEN due_date=? AND paid_amount < amount THEN 1 ELSE 0 END) due_today
    FROM installments i JOIN contracts c ON c.id=i.contract_id JOIN sales s ON s.id=c.sale_id WHERE s.status='ACTIVE' AND i.status<>'CANCELLED'`).get(today,today,today);
  const collections = db.prepare(`SELECT
    COALESCE(SUM(CASE WHEN p.payment_date=? AND p.status='ACTIVE' THEN p.amount ELSE 0 END),0)-COALESCE((SELECT SUM(r.amount) FROM payment_refunds r WHERE r.refund_date=?),0) today_amount,
    COALESCE(SUM(CASE WHEN substr(p.payment_date,1,7)=? AND p.status='ACTIVE' THEN p.amount ELSE 0 END),0)-COALESCE((SELECT SUM(r.amount) FROM payment_refunds r WHERE substr(r.refund_date,1,7)=?),0) month_amount
    FROM payments p JOIN installments i ON i.id=p.installment_id JOIN contracts c ON c.id=i.contract_id JOIN sales s ON s.id=c.sale_id`).get(today,today,month,month);
  const expenses = db.prepare(`SELECT
    COALESCE(SUM(CASE WHEN expense_date=? THEN amount ELSE 0 END),0) today_amount,
    COALESCE(SUM(CASE WHEN substr(expense_date,1,7)=? THEN amount ELSE 0 END),0) month_amount
    FROM expenses WHERE status='ACTIVE'`).get(today,month);
  const intermediary = db.prepare(`SELECT COUNT(*) count, COALESCE(SUM(sale_price),0) total,
    COALESCE(SUM(CASE WHEN seller_due_amount>seller_paid_amount THEN seller_due_amount-seller_paid_amount ELSE 0 END),0) seller_due
    FROM sales WHERE transaction_mode='INTERMEDIARY' AND status='ACTIVE'`).get();
  const upcoming = db.prepare(`
    SELECT i.*, c.contract_number, s.sale_number, cu.name customer_name
    FROM installments i JOIN contracts c ON c.id=i.contract_id JOIN sales s ON s.id=c.sale_id JOIN customers cu ON cu.id=s.customer_id
    WHERE s.status='ACTIVE' AND i.status<>'CANCELLED' AND i.paid_amount < i.amount ORDER BY i.due_date ASC LIMIT 12
  `).all().map(x => ({...x, status: statusFromInstallment(x), overdue_days: x.due_date < today ? Math.floor((new Date(today)-new Date(x.due_date))/86400000) : 0}));
  res.json({vehicles: counts.available_total||0, customers, inventory_value:counts.inventory_value||0, available:counts.available||0, reserved:counts.reserved||0, sold:counts.sold||0, outstanding:installments.outstanding||0, overdue_amount:installments.overdue_amount||0, overdue_count:installments.overdue_count||0, dueToday:installments.due_today||0, collections_today:collections.today_amount||0, collections_month:collections.month_amount||0, expenses_today:expenses.today_amount||0, expenses_month:expenses.month_amount||0, intermediary_count:intermediary.count||0, intermediary_total:intermediary.total||0, seller_due:intermediary.seller_due||0, upcoming});
});

app.get("/api/search", (req,res) => {
  const q=String(req.query.q||"").trim();
  if(!q) return res.json([]);
  const like=`%${q}%`;
  const results=[];
  db.prepare(`SELECT id,name,national_id,phone FROM customers WHERE archived_at IS NULL AND (name LIKE ? OR national_id LIKE ? OR phone LIKE ?) LIMIT 8`).all(like,like,like).forEach(x=>results.push({type:'customer',id:x.id,title:x.name,subtitle:`مشتري — ${x.national_id||x.phone||''}`}));
  db.prepare(`SELECT id,name,national_id,phone FROM sellers WHERE archived_at IS NULL AND (name LIKE ? OR national_id LIKE ? OR phone LIKE ?) LIMIT 8`).all(like,like,like).forEach(x=>results.push({type:'seller',id:x.id,title:x.name,subtitle:`بائع — ${x.national_id||x.phone||''}`}));
  db.prepare(`SELECT id,plate_number,vin,make,model FROM vehicles WHERE archived_at IS NULL AND (plate_number LIKE ? OR vin LIKE ? OR make LIKE ? OR model LIKE ?) LIMIT 8`).all(like,like,like,like).forEach(x=>results.push({type:'vehicle',id:x.id,title:`${x.make} ${x.model} — ${x.plate_number}`,subtitle:`سيارة — ${x.vin||''}`}));
  db.prepare(`SELECT id,sale_number,customer_id,vehicle_id,sale_price FROM sales WHERE sale_number LIKE ? LIMIT 8`).all(like).forEach(x=>results.push({type:'sale',id:x.id,title:x.sale_number,subtitle:`عملية بيع — ${money(x.sale_price)} ريال`}));
  res.json(results.slice(0,20));
});

app.get("/api/backup", async (req,res,next)=>{
  const temp = path.join(dataDir, `download-${randomUUID()}.sqlite`);
  try {
    await db.backup(temp);
    fs.chmodSync(temp, 0o600);
    const stamp = localDateString() + "-" + Date.now();
    audit("BACKUP", "DATABASE", null, "تنزيل نسخة احتياطية", req.user?.username || "system");
    res.download(temp, `showroom-backup-${stamp}.sqlite`, (error) => {
      cleanupRestoreTempFiles(temp);
      if (error && !res.headersSent) next(error);
    });
  } catch (error) { cleanupRestoreTempFiles(temp); next(error); }
});

app.post("/api/restore", async (req,res)=>{
  // A unique name prevents concurrent requests from sharing a file. Restrictive
  // permissions matter because the temporary database contains customer PII.
  const tempPath = path.join(dataDir, `restore-${process.pid}-${Date.now()}-${randomUUID()}.sqlite`);
  let src = null;
  try {
    if(!Buffer.isBuffer(req.body) || req.body.length < 100 || req.body.subarray(0,16).toString() !== "SQLite format 3\0") return res.status(400).json({error:"ملف النسخة الاحتياطية غير صالح"});
    fs.writeFileSync(tempPath, req.body, { flag: "wx", mode: 0o600 });
    src = new Database(tempPath,{readonly:true});
    if (src.pragma("quick_check", { simple: true }) !== "ok") throw new InputError("ملف النسخة الاحتياطية تالف");
    const required = {
      customers: ["id","name"], vehicles: ["id","plate_number","make","model"],
      sales: ["id","sale_number","customer_id","vehicle_id","sale_type","sale_price","sale_date"],
      contracts: ["id","contract_number","sale_id","issue_date","creditor_name"],
      installments: ["id","contract_id","installment_number","due_date","amount"],
      payments: ["id","installment_id","receipt_number","amount","payment_date","payment_method"],
      sequences: ["name","value"],
    };
    for (const [table, columns] of Object.entries(required)) {
      const definition = src.prepare("SELECT type FROM sqlite_master WHERE name=?").get(table);
      const existing = src.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
      if (definition?.type !== "table" || columns.some((column) => !existing.includes(column))) throw new InputError("هذه ليست نسخة احتياطية متوافقة مع نظام المعرض");
    }
    // Before any replacement, preserve the current live database as a safety checkpoint.
    const backupDir = path.join(dataDir, "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    const safetyPath = path.join(backupDir, `showroom-auto-pre-restore-${localDateString()}-${Date.now()}.sqlite`);
    await db.backup(safetyPath);
    fs.chmodSync(safetyPath, 0o600);
    const tables=["sequences","customers","guarantors","sellers","vehicles","sales","contracts","installments","bills","promissory_notes","payments","seller_payments","expenses","audit_log","settings","message_log","payment_refunds","unallocated_receipts","vehicle_reservations","broker_commission_payments","sale_vehicle_replacements","sale_correction_history","staff_users"];
    db.pragma("foreign_keys = OFF");
    const tx=db.transaction(()=>{
      [...tables].reverse().forEach(t=>db.prepare(`DELETE FROM ${t}`).run());
      for(const t of tables){
        const mainCols=db.prepare(`PRAGMA table_info(${t})`).all().map(x=>x.name);
        const srcCols=src.prepare(`PRAGMA table_info(${t})`).all().map(x=>x.name);
        if(!srcCols.length) continue;
        const cols=mainCols.filter(c=>srcCols.includes(c));
        if(!cols.length) continue;
        const select=src.prepare(`SELECT ${cols.map(c=>'"'+c.replaceAll('"','""')+'"').join(',')} FROM ${t}`);
        const insert=db.prepare(`INSERT INTO ${t} (${cols.map(c=>'"'+c.replaceAll('"','""')+'"').join(',')}) VALUES (${cols.map(()=>'?').join(',')})`);
        for(const row of select.iterate()) insert.run(...cols.map(c=>row[c]));
      }
      if (db.pragma("foreign_key_check").length) throw new InputError("علاقات البيانات في النسخة الاحتياطية غير صالحة");
      for (const row of db.prepare("SELECT id FROM installments").all()) syncInstallmentStatus(row.id);
      for (const row of db.prepare("SELECT id FROM sales WHERE sale_type='INSTALLMENT'").all()) syncSaleRemaining(row.id);
      for (const row of db.prepare("SELECT id FROM sales WHERE transaction_mode='INTERMEDIARY'").all()) syncSellerPaid(row.id);
      audit("RESTORE", "DATABASE", null, "استرجاع نسخة احتياطية");
    });
    tx.immediate();
    db.pragma("foreign_keys = ON");
    res.json({ok:true,message:"تم استرجاع النسخة الاحتياطية بنجاح"});
  } catch(e) {
    try{db.pragma("foreign_keys = ON")}catch(_){}
    res.status(400).json({error:e instanceof InputError ? e.message : "تعذر استرجاع النسخة الاحتياطية: الملف غير صالح أو غير متوافق"});
  } finally {
    db.pragma("foreign_keys = ON");
    // Close SQLite before removing the main file and every possible sidecar.
    if (src) {
      try { src.close(); }
      catch (error) { console.error("تعذر إغلاق قاعدة الاسترجاع المؤقتة:", error); }
    }
    cleanupRestoreTempFiles(tempPath);
  }
});

app.get("/api/audit-log", (req,res)=>{
  const limit=safeInteger(req.query.limit ?? 200,200,1,500);
  res.json(db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").all(limit));
});

app.get("/api/expenses", (_,res)=>res.json(db.prepare(`SELECT * FROM expenses ORDER BY expense_date DESC,id DESC`).all()));
app.post("/api/expenses", (req,res)=>{
  const category = requireText(req.body.category, "بند المصروف"), amount = asPositiveMoney(req.body.amount), expense_date = asDate(req.body.expense_date, "تاريخ المصروف"), description = optionalText(req.body.description, "البيان", 5000);
  const vehicle_id = req.body.vehicle_id ? positiveId(req.body.vehicle_id, "السيارة") : null;
  if(!category || !(Number(amount)>0) || !expense_date) return res.status(400).json({error:'بيانات المصروف غير مكتملة'});
  const r=db.prepare(`INSERT INTO expenses(vehicle_id,category,amount,expense_date,description) VALUES(?,?,?,?,?)`).run(vehicle_id||null,category,Number(amount),expense_date,description||'');
  audit("CREATE","EXPENSE",r.lastInsertRowid,`${category} — ${amount}`);
  res.json(db.prepare('SELECT * FROM expenses WHERE id=?').get(r.lastInsertRowid));
});

app.put("/api/expenses/:id", (req,res)=>{
  const existing=db.prepare("SELECT * FROM expenses WHERE id=?").get(req.params.id);
  if(!existing) return res.status(404).json({error:'المصروف غير موجود'});
  if(existing.status!=='ACTIVE') throw new InputError("لا يمكن تعديل مصروف ملغى؛ احتفظ به وأدخل مصروفًا صحيحًا جديدًا",409);
  const category = requireText(req.body.category, "بند المصروف"), amount = asPositiveMoney(req.body.amount), expense_date = asDate(req.body.expense_date, "تاريخ المصروف"), description = optionalText(req.body.description, "البيان", 5000);
  const vehicle_id = req.body.vehicle_id ? positiveId(req.body.vehicle_id, "السيارة") : null;
  if(!category || !(Number(amount)>0) || !expense_date) return res.status(400).json({error:'بيانات المصروف غير مكتملة'});
  const r=db.prepare(`UPDATE expenses SET vehicle_id=?,category=?,amount=?,expense_date=?,description=? WHERE id=?`).run(vehicle_id||null,category,Number(amount),expense_date,description||'',req.params.id);
  if(!r.changes) return res.status(404).json({error:'المصروف غير موجود'});
  audit("UPDATE","EXPENSE",req.params.id,JSON.stringify({before:{category:existing.category,amount:existing.amount,expense_date:existing.expense_date,description:existing.description},after:{category,amount,expense_date,description}}),req.user?.username||"system");
  res.json(db.prepare('SELECT * FROM expenses WHERE id=?').get(req.params.id));
});

app.delete("/api/expenses/:id", (req,res)=>{
  const expense=db.prepare("SELECT * FROM expenses WHERE id=?").get(req.params.id);
  if(!expense) return res.status(404).json({error:'المصروف غير موجود'});
  if(expense.status!=='ACTIVE') return res.status(409).json({error:'المصروف ملغى بالفعل'});
  const reason=optionalText(req.body?.reason,"سبب إلغاء المصروف",3000);
  if(!reason) return res.status(400).json({error:'سبب إلغاء المصروف مطلوب'});
  db.prepare("UPDATE expenses SET status='VOIDED',voided_at=CURRENT_TIMESTAMP,void_reason=? WHERE id=?").run(reason,expense.id);
  audit("VOID","EXPENSE",expense.id,JSON.stringify({category:expense.category,amount:expense.amount,reason}),req.user?.username||"system");
  res.json({ok:true,status:'VOIDED',message:'تم إلغاء المصروف مع حفظ السجل الأصلي؛ لم يتم تسجيل رد أموال.'});
});

}
