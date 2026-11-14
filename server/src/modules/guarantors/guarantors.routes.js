import { InputError } from "../../shared/errors.js";
import { personInput } from "../../shared/validation.js";
export function registerGuarantorsRoutes(app, { db, audit }) {
app.get("/api/guarantors", (req, res) => {
  const q=String(req.query.search||"").trim(); if(!q) return res.json(db.prepare("SELECT * FROM guarantors WHERE (?=1 OR archived_at IS NULL) ORDER BY id DESC").all(String(req.query.includeArchived||"0")==="1"?1:0));
  const like=`%${q}%`; res.json(db.prepare("SELECT * FROM guarantors WHERE (?=1 OR archived_at IS NULL) AND (name LIKE ? OR national_id LIKE ? OR phone LIKE ? OR city LIKE ?) ORDER BY id DESC").all(String(req.query.includeArchived||"0")==="1"?1:0,like,like,like,like));
});

app.put("/api/guarantors/:id", (req,res) => {
  const existing=db.prepare("SELECT * FROM guarantors WHERE id=?").get(req.params.id);
  if(!existing) return res.status(404).json({error:"الكفيل غير موجود"});
  if(existing.archived_at) throw new InputError("لا يمكن تعديل ملف مؤرشف؛ استعده أولًا", 409);
  const {name,national_id,national_id_date,national_id_source,phone,address,city}= personInput({ ...existing, ...req.body, name: req.body.name }, "اسم الكفيل");
  if(!name?.trim()) return res.status(400).json({error:"اسم الكفيل مطلوب"});
  if (String(national_id||"").trim()) {
    const duplicate=db.prepare("SELECT id,name FROM guarantors WHERE national_id=? AND id<>?").get(String(national_id).trim(), req.params.id);
    if (duplicate) return res.status(409).json({error:`رقم الهوية مسجل بالفعل باسم ${duplicate.name}`});
  }
  const r=db.prepare(`UPDATE guarantors SET name=?,national_id=?,national_id_date=?,national_id_source=?,phone=?,address=?,city=? WHERE id=?`).run(name.trim(),national_id||"",national_id_date||"",national_id_source||"",phone||"",address||"",city||"",req.params.id);
  if(!r.changes) return res.status(404).json({error:"الكفيل غير موجود"}); const after={name,national_id,national_id_date,national_id_source,phone,address,city}; audit("UPDATE","GUARANTOR",req.params.id,JSON.stringify({before:{name:existing.name,national_id:existing.national_id,national_id_date:existing.national_id_date,national_id_source:existing.national_id_source,phone:existing.phone,address:existing.address,city:existing.city},after}),req.user?.username||"system"); res.json(db.prepare("SELECT * FROM guarantors WHERE id=?").get(req.params.id));
});

app.get("/api/guarantors/:id/profile", (req,res) => {
  const guarantor=db.prepare("SELECT * FROM guarantors WHERE id=?").get(req.params.id);
  if(!guarantor) return res.status(404).json({error:"الكفيل غير موجود"});
  const notes=db.prepare(`
    SELECT p.*, s.id sale_id, s.sale_number, s.sale_date, s.sale_price, s.remaining_amount,
           cu.name customer_name, v.make, v.model, v.plate_number, c.contract_number
    FROM promissory_notes p
    JOIN contracts c ON c.id=p.contract_id
    JOIN sales s ON s.id=c.sale_id
    JOIN customers cu ON cu.id=s.customer_id
    LEFT JOIN vehicles v ON v.id=s.vehicle_id
    WHERE p.party_type='GUARANTOR' AND s.guarantor_id=?
    ORDER BY p.issue_date DESC, p.id DESC
  `).all(req.params.id);
  const sales=db.prepare(`
    SELECT s.id,s.sale_number,s.sale_date,s.sale_price,s.remaining_amount,cu.name customer_name,
           v.make,v.model,v.plate_number,c.contract_number
    FROM sales s
    JOIN customers cu ON cu.id=s.customer_id
    LEFT JOIN vehicles v ON v.id=s.vehicle_id
    LEFT JOIN contracts c ON c.sale_id=s.id
    WHERE s.guarantor_id=?
    ORDER BY s.id DESC
  `).all(req.params.id);
  res.json({guarantor,notes,sales});
});

app.post("/api/guarantors", (req,res) => {
  const {name,national_id,national_id_date,national_id_source,phone,address,city} = personInput(req.body, "اسم الكفيل");
  if (!name) return res.status(400).json({error:"اسم الكفيل مطلوب"});
  if (String(national_id||"").trim()) {
    const duplicate=db.prepare("SELECT id,name FROM guarantors WHERE national_id=?").get(String(national_id).trim());
    if (duplicate) return res.status(409).json({error:`رقم الهوية مسجل بالفعل باسم ${duplicate.name}`});
  }
  const r = db.prepare(`
    INSERT INTO guarantors(name,national_id,national_id_date,national_id_source,phone,address,city)
    VALUES(?,?,?,?,?,?,?)
  `).run(name,national_id||"",national_id_date||"",national_id_source||"",phone||"",address||"",city||"");
  audit("CREATE","GUARANTOR",r.lastInsertRowid,name);
  res.json(db.prepare("SELECT * FROM guarantors WHERE id=?").get(r.lastInsertRowid));
});

}
