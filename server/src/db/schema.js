import { initializeMessagingSchema } from "./messaging-schema.js";

export function initializeSchema(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  national_id TEXT,
  national_id_date TEXT,
  national_id_source TEXT,
  phone TEXT,
  address TEXT,
  city TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plate_number TEXT NOT NULL,
  vin TEXT,
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  model_year INTEGER,
  color TEXT,
  condition TEXT NOT NULL DEFAULT 'USED' CHECK (condition IN ('NEW','USED')),
  images_json TEXT NOT NULL DEFAULT '[]',
  price REAL NOT NULL DEFAULT 0,
  ownership_type TEXT NOT NULL DEFAULT 'SHOWROOM' CHECK (ownership_type IN ('SHOWROOM','THIRD_PARTY')),
  owner_seller_id INTEGER REFERENCES sellers(id),
  status TEXT NOT NULL DEFAULT 'IN_STOCK',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS guarantors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  national_id TEXT,
  national_id_date TEXT,
  national_id_source TEXT,
  phone TEXT,
  address TEXT,
  city TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sellers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  national_id TEXT,
  national_id_date TEXT,
  national_id_source TEXT,
  phone TEXT,
  address TEXT,
  city TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_number TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  seller_id INTEGER REFERENCES sellers(id),
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  sale_type TEXT NOT NULL CHECK (sale_type IN ('CASH','INSTALLMENT')),
  transaction_mode TEXT NOT NULL DEFAULT 'DIRECT' CHECK (transaction_mode IN ('DIRECT','INTERMEDIARY')),
  sale_price REAL NOT NULL,
  down_payment REAL NOT NULL DEFAULT 0,
  remaining_amount REAL NOT NULL DEFAULT 0,
  installment_count INTEGER NOT NULL DEFAULT 0,
  installment_amount REAL NOT NULL DEFAULT 0,
  installment_interval_months INTEGER NOT NULL DEFAULT 1,
  first_due_date TEXT,
  bill_start_serial INTEGER NOT NULL DEFAULT 1,
  guarantor_id INTEGER REFERENCES guarantors(id),
  sale_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  seller_paid_amount REAL NOT NULL DEFAULT 0,
  seller_due_amount REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_number TEXT NOT NULL UNIQUE,
  sale_id INTEGER NOT NULL UNIQUE REFERENCES sales(id),
  issue_date TEXT NOT NULL,
  issue_date_hijri TEXT,
  creditor_name TEXT NOT NULL,
  installment_amount REAL NOT NULL DEFAULT 0,
  installments_count INTEGER NOT NULL DEFAULT 0,
  installment_interval_months INTEGER NOT NULL DEFAULT 1,
  first_due_date TEXT,
  bill_start_serial INTEGER NOT NULL DEFAULT 1,
  promissory_due_mode TEXT NOT NULL DEFAULT 'BLANK',
  promissory_due_date TEXT,
  bill_date_calendar TEXT NOT NULL DEFAULT 'GREGORIAN',
  guarantor_id INTEGER REFERENCES guarantors(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS installments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES contracts(id),
  installment_number INTEGER NOT NULL,
  due_date TEXT NOT NULL,
  amount REAL NOT NULL,
  paid_amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'UPCOMING'
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  installment_id INTEGER NOT NULL REFERENCES installments(id),
  receipt_number TEXT NOT NULL UNIQUE,
  amount REAL NOT NULL,
  payment_date TEXT NOT NULL,
  payment_method TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES contracts(id),
  installment_id INTEGER NOT NULL REFERENCES installments(id),
  bill_number TEXT NOT NULL UNIQUE,
  amount REAL NOT NULL,
  issue_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN'
);

CREATE TABLE IF NOT EXISTS promissory_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL REFERENCES contracts(id),
  note_number TEXT NOT NULL UNIQUE,
  amount REAL NOT NULL,
  issue_date TEXT NOT NULL,
  due_date TEXT,
  party_type TEXT NOT NULL DEFAULT 'CUSTOMER',
  status TEXT NOT NULL DEFAULT 'OPEN'
);

CREATE TABLE IF NOT EXISTS sequences (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_id INTEGER REFERENCES vehicles(id),
  category TEXT NOT NULL,
  amount REAL NOT NULL,
  expense_date TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS seller_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales(id),
  seller_id INTEGER NOT NULL REFERENCES sellers(id),
  receipt_number TEXT NOT NULL UNIQUE,
  amount REAL NOT NULL,
  payment_date TEXT NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'CASH',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
  `);
  initializeMessagingSchema(db);
}
