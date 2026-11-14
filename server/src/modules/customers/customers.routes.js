import { InputError } from "../../shared/errors.js";
import { billSerialNumber } from "../../utils/format.js";
import { personInput } from "../../shared/validation.js";
export function registerCustomersRoutes(app, { db, audit, statusFromInstallment, localDateString }) {
app.get("/api/customers", (req, res) => {
  const q = String(req.query.search || "").trim();
  if (!q) return res.json(db.prepare("SELECT * FROM customers WHERE (?=1 OR archived_at IS NULL) ORDER BY id DESC").all(String(req.query.includeArchived||"0")==="1"?1:0));
  const like = `%${q}%`;
  res.json(db.prepare("SELECT * FROM customers WHERE (?=1 OR archived_at IS NULL) AND (name LIKE ? OR national_id LIKE ? OR phone LIKE ? OR city LIKE ?) ORDER BY id DESC").all(String(req.query.includeArchived||"0")==="1"?1:0,like,like,like,like));
});

app.put("/api/customers/:id", (req,res) => {
  const existing = db.prepare("SELECT * FROM customers WHERE id=?").get(req.params.id);
  if (!existing) return res.status(404).json({error:"المشتري غير موجود"});
  if (existing.archived_at) throw new InputError("لا يمكن تعديل ملف مؤرشف؛ استعده أولًا", 409);
  const {name,national_id,national_id_date,national_id_source,phone,address,city,notes} = personInput({ ...existing, ...req.body, name: req.body.name }, "اسم المشتري");
  if (!name?.trim()) return res.status(400).json({error:"اسم المشتري مطلوب"});
  if (String(national_id||"").trim()) {
    const duplicate=db.prepare("SELECT id,name FROM customers WHERE national_id=? AND id<>?").get(String(national_id).trim(), req.params.id);
    if (duplicate) return res.status(409).json({error:`رقم الهوية مسجل بالفعل باسم ${duplicate.name}`});
  }
  const r=db.prepare(`UPDATE customers SET name=?,national_id=?,national_id_date=?,national_id_source=?,phone=?,address=?,city=?,notes=? WHERE id=?`).run(name.trim(),national_id||"",national_id_date||"",national_id_source||"",phone||"",address||"",city||"",notes||"",req.params.id);
  if (!r.changes) return res.status(404).json({error:"المشتري غير موجود"});
  const after={name,national_id,national_id_date,national_id_source,phone,address,city,notes};
  audit("UPDATE","CUSTOMER",req.params.id,JSON.stringify({before:{name:existing.name,national_id:existing.national_id,national_id_date:existing.national_id_date,national_id_source:existing.national_id_source,phone:existing.phone,address:existing.address,city:existing.city,notes:existing.notes},after}),req.user?.username||"system"); res.json(db.prepare("SELECT * FROM customers WHERE id=?").get(req.params.id));
});

app.get("/api/customers/:id/profile", (req,res) => {
  const customer=db.prepare("SELECT * FROM customers WHERE id=?").get(req.params.id);
  if(!customer) return res.status(404).json({error:"المشتري غير موجود"});
  const sales=db.prepare(`SELECT s.*,v.make,v.model,v.plate_number,c.contract_number FROM sales s JOIN vehicles v ON v.id=s.vehicle_id LEFT JOIN contracts c ON c.sale_id=s.id WHERE s.customer_id=? AND s.status='ACTIVE' ORDER BY s.id DESC`).all(req.params.id);
  const installments=db.prepare(`SELECT i.*,c.contract_number,c.bill_start_serial,b.bill_number FROM installments i JOIN contracts c ON c.id=i.contract_id JOIN sales s ON s.id=c.sale_id LEFT JOIN bills b ON b.installment_id=i.id WHERE s.customer_id=? AND s.status='ACTIVE' AND i.status<>'CANCELLED' ORDER BY i.due_date,i.installment_number`).all(req.params.id).map(x=>({...x,bill_number:`BILL-${billSerialNumber(x.bill_start_serial,x.installment_number)}`,status:statusFromInstallment(x),bill_status:x.paid_amount>=x.amount?"PAID":(x.paid_amount>0?"PARTIAL":(x.due_date<localDateString()?"OVERDUE":(x.due_date===localDateString()?"DUE":"OPEN")))}));
  const payments=db.prepare(`SELECT p.*,s.status sale_status FROM payments p JOIN installments i ON i.id=p.installment_id JOIN contracts c ON c.id=i.contract_id JOIN sales s ON s.id=c.sale_id WHERE s.customer_id=? ORDER BY p.payment_date DESC,p.id DESC`).all(req.params.id);
  res.json({customer,sales,installments,payments});
});

app.post("/api/customers", (req,res) => {
  const {name,national_id,national_id_date,national_id_source,phone,address,city,notes} = personInput(req.body, "اسم المشتري");
  if (!name) return res.status(400).json({error:"اسم العميل مطلوب"});
  if (String(national_id||"").trim()) {
    const duplicate=db.prepare("SELECT id,name FROM customers WHERE national_id=?").get(String(national_id).trim());
    if (duplicate) return res.status(409).json({error:`رقم الهوية مسجل بالفعل باسم ${duplicate.name}`});
  }
  const r = db.prepare(`
    INSERT INTO customers(name,national_id,national_id_date,national_id_source,phone,address,city,notes)
    VALUES(?,?,?,?,?,?,?,?)
  `).run(name,national_id||"",national_id_date||"",national_id_source||"",phone||"",address||"",city||"",notes||"");
  audit("CREATE","CUSTOMER",r.lastInsertRowid,name);
  res.json(db.prepare("SELECT * FROM customers WHERE id=?").get(r.lastInsertRowid));
});

}
