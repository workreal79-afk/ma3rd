import { initializeMessagingSchema } from "./messaging-schema.js";

function safeExec(db, sql) {
  try {
    db.exec(sql);
  } catch (error) {
    // Existing databases may already contain a column/index from an older release.
    const message = String(error?.message || error);
    const ignorable = /duplicate column name|already exists|no such column/i.test(message);
    if (!ignorable) throw error;
  }
}

export function runMigrations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  const migrations = [
    ["001_contract_bill_start_serial", () => safeExec(db, "ALTER TABLE contracts ADD COLUMN bill_start_serial INTEGER NOT NULL DEFAULT 1")],
    ["002_sales_seller_id", () => safeExec(db, "ALTER TABLE sales ADD COLUMN seller_id INTEGER REFERENCES sellers(id)")],
    ["003_vehicle_ownership_type", () => safeExec(db, "ALTER TABLE vehicles ADD COLUMN ownership_type TEXT NOT NULL DEFAULT 'SHOWROOM'")],
    ["004_vehicle_owner_seller_id", () => safeExec(db, "ALTER TABLE vehicles ADD COLUMN owner_seller_id INTEGER REFERENCES sellers(id)")],
    ["005_vehicle_condition", () => safeExec(db, "ALTER TABLE vehicles ADD COLUMN condition TEXT NOT NULL DEFAULT 'USED'")],
    ["006_vehicle_images", () => safeExec(db, "ALTER TABLE vehicles ADD COLUMN images_json TEXT NOT NULL DEFAULT '[]'")],
    ["007_promissory_party_type", () => safeExec(db, "ALTER TABLE promissory_notes ADD COLUMN party_type TEXT NOT NULL DEFAULT 'CUSTOMER'")],
    ["008_seller_paid_amount", () => safeExec(db, "ALTER TABLE sales ADD COLUMN seller_paid_amount REAL NOT NULL DEFAULT 0")],
    ["009_seller_due_amount", () => safeExec(db, "ALTER TABLE sales ADD COLUMN seller_due_amount REAL NOT NULL DEFAULT 0")],
    ["010_sales_transaction_mode", () => safeExec(db, "ALTER TABLE sales ADD COLUMN transaction_mode TEXT NOT NULL DEFAULT 'DIRECT'")],
    ["011_customer_national_id_meta", () => {
      safeExec(db, "ALTER TABLE customers ADD COLUMN national_id_date TEXT");
      safeExec(db, "ALTER TABLE customers ADD COLUMN national_id_source TEXT");
    }],
    ["012_guarantor_national_id_meta", () => {
      safeExec(db, "ALTER TABLE guarantors ADD COLUMN national_id_date TEXT");
      safeExec(db, "ALTER TABLE guarantors ADD COLUMN national_id_source TEXT");
    }],
    ["013_normalize_intermediary_due", () => {
      safeExec(db, "UPDATE sales SET seller_due_amount=sale_price WHERE transaction_mode='INTERMEDIARY' AND seller_due_amount=0");
    }],
    ["014_unique_bill_per_installment", () => safeExec(db, "CREATE UNIQUE INDEX IF NOT EXISTS idx_bills_installment_unique ON bills(installment_id)")],
    ["015_messaging_settings_and_log", () => initializeMessagingSchema(db)],
    ["016_installment_interval_months", () => {
      safeExec(db, "ALTER TABLE sales ADD COLUMN installment_interval_months INTEGER NOT NULL DEFAULT 1");
      safeExec(db, "ALTER TABLE contracts ADD COLUMN installment_interval_months INTEGER NOT NULL DEFAULT 1");
    }],
    ["017_lifecycle_financial_reversals", () => {
      const additions = [
        "ALTER TABLE customers ADD COLUMN archived_at TEXT",
        "ALTER TABLE customers ADD COLUMN archive_reason TEXT",
        "ALTER TABLE customers ADD COLUMN merged_into_id INTEGER REFERENCES customers(id)",
        "ALTER TABLE guarantors ADD COLUMN archived_at TEXT",
        "ALTER TABLE guarantors ADD COLUMN archive_reason TEXT",
        "ALTER TABLE guarantors ADD COLUMN merged_into_id INTEGER REFERENCES guarantors(id)",
        "ALTER TABLE sellers ADD COLUMN archived_at TEXT",
        "ALTER TABLE sellers ADD COLUMN archive_reason TEXT",
        "ALTER TABLE sellers ADD COLUMN merged_into_id INTEGER REFERENCES sellers(id)",
        "ALTER TABLE vehicles ADD COLUMN archived_at TEXT",
        "ALTER TABLE vehicles ADD COLUMN archive_reason TEXT",
        "ALTER TABLE sales ADD COLUMN cancelled_at TEXT",
        "ALTER TABLE sales ADD COLUMN cancel_reason TEXT",
        "ALTER TABLE sales ADD COLUMN broker_seller_id INTEGER REFERENCES sellers(id)",
        "ALTER TABLE sales ADD COLUMN broker_commission_amount REAL NOT NULL DEFAULT 0",
        "ALTER TABLE sales ADD COLUMN broker_commission_paid REAL NOT NULL DEFAULT 0",
        "ALTER TABLE contracts ADD COLUMN closed_at TEXT",
        "ALTER TABLE contracts ADD COLUMN close_reason TEXT",
        "ALTER TABLE payments ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE'",
        "ALTER TABLE payments ADD COLUMN reversed_at TEXT",
        "ALTER TABLE payments ADD COLUMN reversal_reason TEXT",
        "ALTER TABLE payments ADD COLUMN replaced_by_payment_id INTEGER REFERENCES payments(id)",
        "ALTER TABLE seller_payments ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE'",
        "ALTER TABLE seller_payments ADD COLUMN reversed_at TEXT",
        "ALTER TABLE seller_payments ADD COLUMN reversal_reason TEXT",
        "ALTER TABLE expenses ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE'",
        "ALTER TABLE expenses ADD COLUMN voided_at TEXT",
        "ALTER TABLE expenses ADD COLUMN void_reason TEXT",
        "ALTER TABLE promissory_notes ADD COLUMN voided_at TEXT",
        "ALTER TABLE promissory_notes ADD COLUMN void_reason TEXT",
        "ALTER TABLE promissory_notes ADD COLUMN replaced_by_id INTEGER REFERENCES promissory_notes(id)",
        "ALTER TABLE audit_log ADD COLUMN actor TEXT NOT NULL DEFAULT 'system'"
      ];
      for (const sql of additions) safeExec(db, sql);
      db.exec(`
        CREATE TABLE IF NOT EXISTS payment_refunds (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          payment_id INTEGER NOT NULL REFERENCES payments(id),
          refund_number TEXT NOT NULL UNIQUE,
          amount REAL NOT NULL CHECK(amount > 0),
          refund_date TEXT NOT NULL,
          payment_method TEXT NOT NULL DEFAULT 'CASH',
          reason TEXT NOT NULL,
          confirmed INTEGER NOT NULL CHECK(confirmed = 1),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_payment_refunds_payment ON payment_refunds(payment_id);
        CREATE TABLE IF NOT EXISTS unallocated_receipts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          receipt_number TEXT NOT NULL UNIQUE,
          customer_id INTEGER NOT NULL REFERENCES customers(id),
          amount REAL NOT NULL CHECK(amount > 0),
          allocated_amount REAL NOT NULL DEFAULT 0,
          payment_date TEXT NOT NULL,
          payment_method TEXT NOT NULL DEFAULT 'CASH',
          notes TEXT,
          status TEXT NOT NULL DEFAULT 'OPEN',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS vehicle_reservations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
          customer_id INTEGER REFERENCES customers(id),
          reserved_at TEXT NOT NULL,
          expires_at TEXT,
          deposit_amount REAL NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'ACTIVE',
          reason TEXT,
          released_at TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_reservation_per_vehicle ON vehicle_reservations(vehicle_id) WHERE status='ACTIVE';
        CREATE TABLE IF NOT EXISTS broker_commission_payments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sale_id INTEGER NOT NULL REFERENCES sales(id),
          broker_seller_id INTEGER NOT NULL REFERENCES sellers(id),
          receipt_number TEXT NOT NULL UNIQUE,
          amount REAL NOT NULL CHECK(amount > 0),
          payment_date TEXT NOT NULL,
          payment_method TEXT NOT NULL DEFAULT 'CASH',
          notes TEXT,
          status TEXT NOT NULL DEFAULT 'ACTIVE',
          reversed_at TEXT,
          reversal_reason TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_broker_commission_sale ON broker_commission_payments(sale_id);
      `);
      safeExec(db, "UPDATE payments SET status='ACTIVE' WHERE status IS NULL OR status=''");
      safeExec(db, "UPDATE seller_payments SET status='ACTIVE' WHERE status IS NULL OR status=''");
      safeExec(db, "UPDATE expenses SET status='ACTIVE' WHERE status IS NULL OR status=''");
    }],
    ["018_sale_change_history", () => {
      db.exec(`CREATE TABLE IF NOT EXISTS sale_vehicle_replacements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_id INTEGER NOT NULL REFERENCES sales(id),
        old_vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
        new_vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
        reason TEXT NOT NULL,
        actor TEXT NOT NULL DEFAULT 'system',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_sale_vehicle_replacements_sale ON sale_vehicle_replacements(sale_id,id);
      CREATE TABLE IF NOT EXISTS sale_correction_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_id INTEGER NOT NULL REFERENCES sales(id),
        reason TEXT NOT NULL,
        before_json TEXT NOT NULL,
        after_json TEXT NOT NULL,
        actor TEXT NOT NULL DEFAULT 'system',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_sale_correction_history_sale ON sale_correction_history(sale_id,id);`);
    }],
    ["019_user_roles", () => {
      db.exec(`CREATE TABLE IF NOT EXISTS staff_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('ADMIN','ACCOUNTANT','SALES','VIEWER')),
        status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','DISABLED')),
        created_by TEXT NOT NULL DEFAULT 'system',
        updated_by TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_staff_users_status_role ON staff_users(status,role);`);
    }],
    ["020_unallocated_receipt_lifecycle", () => {
      safeExec(db, "ALTER TABLE unallocated_receipts ADD COLUMN cancelled_at TEXT");
      safeExec(db, "ALTER TABLE unallocated_receipts ADD COLUMN cancel_reason TEXT");
    }],
    ["021_promissory_due_date_mode", () => {
      safeExec(db, "ALTER TABLE contracts ADD COLUMN promissory_due_mode TEXT NOT NULL DEFAULT 'BLANK'");
      safeExec(db, "ALTER TABLE contracts ADD COLUMN promissory_due_date TEXT");
    }],
    ["022_bill_date_calendar", () => {
      safeExec(db, "ALTER TABLE contracts ADD COLUMN bill_date_calendar TEXT NOT NULL DEFAULT 'GREGORIAN'");
    }],
  ];

  const has = db.prepare("SELECT 1 FROM schema_migrations WHERE version=?");
  const insert = db.prepare("INSERT INTO schema_migrations(version) VALUES(?)");
  for (const [version, migrate] of migrations) {
    const shouldTrack = Number.parseInt(String(version).slice(0, 3), 10) <= 15;
    if (has.get(version)) continue;
    const tx = db.transaction(() => {
      migrate();
      if (shouldTrack) insert.run(version);
    });
    tx();
  }
}
