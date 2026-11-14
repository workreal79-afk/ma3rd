import { asMoney, requireText, optionalText, positiveId, personInput, vehicleImages } from "../../shared/validation.js";
import { InputError } from "../../shared/errors.js";

const statuses = ["IN_STOCK", "RESERVED", "SOLD"];
function vehicleInput(body) {
  if (![body.plate_number, body.make, body.model].every((value) => typeof value === "string" && value.trim())) throw new InputError("اللوحة والماركة والموديل مطلوبة");
  const ownership = body.ownership_type || "SHOWROOM", condition = body.condition || "USED";
  if (!["SHOWROOM", "THIRD_PARTY"].includes(ownership)) throw new InputError("نوع ملكية السيارة غير صحيح");
  if (!["USED", "NEW"].includes(condition)) throw new InputError("حالة جديدة/مستعملة غير صحيحة");
  const year = body.model_year ? Number(body.model_year) : null;
  if (year !== null && (!Number.isInteger(year) || year < 1 || year > 9999)) throw new InputError("سنة الصنع غير صحيحة");
  if (body.status != null && !statuses.includes(body.status)) throw new InputError("حالة السيارة غير صحيحة");
  return {
    plate_number: requireText(body.plate_number, "رقم اللوحة", 100),
    make: requireText(body.make, "الماركة", 100), model: requireText(body.model, "الموديل", 100),
    vin: (optionalText(body.vin, "رقم الهيكل", 100) || "").replace(/[^A-Za-z0-9]/g, "") || null, color: optionalText(body.color, "اللون", 100),
    notes: optionalText(body.notes, "الملاحظات", 5000), model_year: year, condition,
    price: asMoney(body.price ?? 0, "سعر السيارة"), ownership_type: ownership,
    owner_seller_id: ownership === "THIRD_PARTY" && body.owner_seller_id ? positiveId(body.owner_seller_id, "البائع") : null,
    owner_seller: body.owner_seller?.name ? personInput(body.owner_seller, "اسم البائع") : null,
    images: vehicleImages(body.images), status: body.status,
  };
}

export function registerVehiclesRoutes(app, { db, audit }) {
  const detail = (id) => db.prepare(`SELECT v.*, s.name AS owner_seller_name FROM vehicles v LEFT JOIN sellers s ON s.id=v.owner_seller_id WHERE v.id=?`).get(id);
  const activeSale = (id) => db.prepare("SELECT id FROM sales WHERE vehicle_id=? AND status='ACTIVE' LIMIT 1").get(id);

  app.get("/api/vehicles", (req, res) => {
    const q = String(req.query.search || "").trim(), available = String(req.query.available || "") === "1";
    const base = `SELECT v.id,v.plate_number,v.vin,v.make,v.model,v.model_year,v.color,v.condition,
      v.price,v.ownership_type,v.owner_seller_id,v.status,v.notes,v.archived_at,v.archive_reason,v.created_at,
      CASE WHEN json_valid(v.images_json) THEN COALESCE(json_array_length(v.images_json),0) ELSE 0 END image_count,
      s.name AS owner_seller_name,se.customer_id sold_customer_id,cu.name sold_customer_name
      FROM vehicles v LEFT JOIN sellers s ON s.id=v.owner_seller_id
      LEFT JOIN sales se ON se.id=(SELECT id FROM sales WHERE vehicle_id=v.id AND status='ACTIVE' ORDER BY id DESC LIMIT 1)
      LEFT JOIN customers cu ON cu.id=se.customer_id`;
    const conditions = ["(?=1 OR v.archived_at IS NULL)"], params = [String(req.query.includeArchived||"0")==="1"?1:0];
    if (available) conditions.push("UPPER(TRIM(COALESCE(v.status,'IN_STOCK')))='IN_STOCK' AND NOT EXISTS(SELECT 1 FROM sales WHERE vehicle_id=v.id AND status='ACTIVE')");
    if (q) { conditions.push("(v.plate_number LIKE ? OR v.vin LIKE ? OR v.make LIKE ? OR v.model LIKE ? OR s.name LIKE ?)"); params.push(...Array(5).fill(`%${q}%`)); }
    res.json(db.prepare(base + (conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "") + " ORDER BY v.id DESC").all(...params));
  });

  app.get("/api/vehicles/:id", (req, res) => {
    const vehicle = detail(req.params.id);
    if (!vehicle) return res.status(404).json({ error: "السيارة غير موجودة" });
    res.json(vehicle);
  });

  // اللوحة ورقم الهيكل يمكن أن يتكررا عند إعادة استخدام بيانات سيارة
  // أو تسجيل سيارات متشابهة؛ لكل سجل سيارة رقم داخلي مستقل.
  const assertUniqueIdentifiers = (_v, _ignoreId = 0) => {};

  app.post("/api/vehicles", (req, res) => {
    const v = vehicleInput(req.body);
    assertUniqueIdentifiers(v);
    if (v.ownership_type === "THIRD_PARTY" && !v.owner_seller_id && !v.owner_seller) throw new InputError("للسيارة المملوكة للغير يجب إدخال بيانات البائع");
    const id = db.transaction(() => {
      let sellerId = v.owner_seller_id;
      if (v.ownership_type === "THIRD_PARTY" && v.owner_seller) {
        const s = v.owner_seller;
        if (s.national_id) {
          const duplicate = db.prepare("SELECT name FROM sellers WHERE national_id=?").get(s.national_id);
          if (duplicate) throw new InputError(`رقم هوية البائع مسجل بالفعل باسم ${duplicate.name}`);
        }
        const created = db.prepare("INSERT INTO sellers(name,national_id,national_id_date,national_id_source,phone,address,city,notes) VALUES(?,?,?,?,?,?,?,?)")
          .run(s.name,s.national_id,s.national_id_date,s.national_id_source,s.phone,s.address,s.city,s.notes);
        sellerId = Number(created.lastInsertRowid);
        audit("CREATE", "SELLER", sellerId, s.name);
      }
      if (sellerId && !db.prepare("SELECT id FROM sellers WHERE id=? AND archived_at IS NULL").get(sellerId)) throw new InputError("البائع المحدد غير موجود");
      const created = db.prepare("INSERT INTO vehicles(plate_number,vin,make,model,model_year,color,condition,images_json,price,ownership_type,owner_seller_id,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(v.plate_number,v.vin,v.make,v.model,v.model_year,v.color,v.condition,JSON.stringify(v.images || []),v.price,v.ownership_type,sellerId,v.notes);
      audit("CREATE", "VEHICLE", created.lastInsertRowid, v.plate_number);
      return Number(created.lastInsertRowid);
    }).immediate();
    res.json(detail(id));
  });

  app.put("/api/vehicles/:id", (req, res) => {
    // PUT retains its required identifying fields, while omitted optional metadata is preserved.
    const existing = detail(req.params.id);
    if (!existing) return res.status(404).json({ error: "السيارة غير موجودة" });
    if (existing.archived_at) throw new InputError("لا يمكن تعديل سيارة مؤرشفة؛ استعدها أولًا",409);
    const v = vehicleInput({ ...existing, ...req.body, plate_number: req.body.plate_number, make: req.body.make, model: req.body.model });
    if (req.body.status != null && req.body.status !== existing.status) {
      throw new InputError("لا تغيّر حالة السيارة من شاشة التعديل؛ استخدم الحجز أو البيع أو إجراء إعادة السيارة للمخزون", 409);
    }
    assertUniqueIdentifiers(v, existing.id);
    if (activeSale(existing.id) && existing.status !== "SOLD") throw new InputError("بيانات السيارة عليها بيع نشط بحالة غير متسقة؛ عالج البيع أولًا", 409);
    if (v.owner_seller_id && !db.prepare("SELECT id FROM sellers WHERE id=?").get(v.owner_seller_id)) throw new InputError("البائع المحدد غير موجود");
    db.transaction(() => {
      db.prepare("UPDATE vehicles SET plate_number=?,vin=?,make=?,model=?,model_year=?,color=?,condition=?,price=?,images_json=COALESCE(?,images_json),status=?,notes=?,ownership_type=?,owner_seller_id=? WHERE id=?")
        .run(v.plate_number,v.vin,v.make,v.model,v.model_year,v.color,v.condition,v.price,v.images === undefined ? null : JSON.stringify(v.images),v.status,v.notes,v.ownership_type,v.owner_seller_id,existing.id);
      audit("UPDATE", "VEHICLE", existing.id, v.plate_number);
    }).immediate();
    res.json(detail(existing.id));
  });

  app.put("/api/vehicles/:id/status", (req, res) => {
    if (req.body.status !== "IN_STOCK") throw new InputError("لا تغيّر حالة الحجز أو البيع يدويًا؛ استخدم سجل الحجوزات أو عملية البيع", 409);
    const vehicle = db.prepare("SELECT * FROM vehicles WHERE id=?").get(req.params.id);
    if (!vehicle) return res.status(404).json({ error: "السيارة غير موجودة" });
    if (vehicle.archived_at) throw new InputError("لا يمكن تغيير حالة سيارة مؤرشفة", 409);
    if (activeSale(req.params.id)) throw new InputError("لا يمكن إعادة سيارة عليها بيع نشط إلى المخزون؛ ألغِ البيع أولًا", 409);
    if (db.prepare("SELECT 1 FROM vehicle_reservations WHERE vehicle_id=? AND status='ACTIVE' LIMIT 1").get(req.params.id)) throw new InputError("ألغِ سجل الحجز النشط قبل إعادة السيارة للمخزون", 409);
    const reason = requireText(req.body.reason, "سبب إعادة السيارة للمخزون");
    db.prepare("UPDATE vehicles SET status='IN_STOCK' WHERE id=?").run(req.params.id);
    audit("UPDATE", "VEHICLE", req.params.id, JSON.stringify({ before: vehicle.status, after: "IN_STOCK", reason }), req.user?.username || "system");
    res.json({ ok: true });
  });
}
