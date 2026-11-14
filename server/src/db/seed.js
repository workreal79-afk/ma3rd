import { config } from "../config/env.js";
export function seedDatabase(db) {
  db.prepare("INSERT OR IGNORE INTO sequences(name,value) VALUES ('sale',0),('contract',0),('bill',0),('note',0),('receipt',0),('seller_receipt',0)").run();
  const demoEnabled = process.env.SHOWROOM_SEED_DEMO === "1" || (process.env.SHOWROOM_SEED_DEMO !== "0" && (config.demoMode || config.nodeEnv === "test"));
  if (!demoEnabled) return;
  const seedCount = db.prepare("SELECT COUNT(*) AS c FROM vehicles").get().c;
  if (seedCount !== 0) return;
  const seed = db.transaction(() => {
    const c1 = db.prepare(`INSERT INTO customers (name,national_id,phone,address,city) VALUES (?,?,?,?,?)`)
      .run("محمد علي الغامدي","1020304050","0500000000","حي المظيلف","القنفذة");
    const c2 = db.prepare(`INSERT INTO customers (name,national_id,phone,address,city) VALUES (?,?,?,?,?)`)
      .run("خالد أحمد الزهراني","1098765432","0551884891","حي العزيزية","جدة");
    db.prepare(`INSERT INTO vehicles (plate_number,vin,make,model,model_year,color,price,status) VALUES (?,?,?,?,?,?,?,?)`)
      .run("أ ب ج 1234","VIN-DEMO-001","تويوتا","كامري","2024","أبيض",95000,"IN_STOCK");
    db.prepare(`INSERT INTO vehicles (plate_number,vin,make,model,model_year,color,price,status) VALUES (?,?,?,?,?,?,?,?)`)
      .run("د هـ و 5678","VIN-DEMO-002","هيونداي","سوناتا","2023","أسود",78000,"IN_STOCK");
    db.prepare(`INSERT INTO vehicles (plate_number,vin,make,model,model_year,color,price,status) VALUES (?,?,?,?,?,?,?,?)`)
      .run("ز ح ط 9012","VIN-DEMO-003","تويوتا","يارس","2024","فضي",62000,"IN_STOCK");
    db.prepare(`INSERT INTO guarantors (name,national_id,phone,address,city) VALUES (?,?,?,?,?)`)
      .run("عبدالله محمد الغامدي","1010101010","0562222222","حي المظيلف","القنفذة");

    void c1; void c2;
  });
  seed();
}
