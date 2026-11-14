import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { initializeSchema } from "./schema.js";
import { runMigrations } from "./migrations.js";
import { seedDatabase } from "./seed.js";
import { config } from "../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const dataDir = path.join(__dirname, "..", "..", "data");
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const databasePath = path.join(dataDir, config.databaseFile);
const existingDatabase = fs.existsSync(databasePath) && fs.statSync(databasePath).size > 0;
export const db = new Database(databasePath);

// Before applying lifecycle/financial migrations, preserve the old SQLite file as a separate snapshot.
// If the safety snapshot fails, abort startup before schema initialization or migrations can mutate data.
function needsLifecycleMigrationBackup() {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
  if (!table) return true;
  return !db.prepare("SELECT 1 FROM schema_migrations WHERE version='020_unallocated_receipt_lifecycle'").get();
}

if (existingDatabase && !config.demoMode && needsLifecycleMigrationBackup()) {
  const backupDir = path.join(dataDir, "backups");
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(backupDir, 0o700);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `showroom-pre-migration-020-${stamp}.sqlite`);
  const stagingPath = `${backupPath}.partial`;
  try {
    await db.backup(stagingPath);
    fs.chmodSync(stagingPath, 0o600);
    fs.renameSync(stagingPath, backupPath);
    console.log("Created pre-migration safety backup before lifecycle updates.");
  } catch (error) {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try { fs.rmSync(`${stagingPath}${suffix}`, { force: true }); } catch {}
    }
    try { db.close(); } catch {}
    throw new Error(`Unable to create a pre-migration safety backup; database migrations were not run. Cause: ${error?.message || error}`);
  }
}

db.chmod?.(0o600);
try { fs.chmodSync(databasePath, 0o600); } catch {}
db.pragma("foreign_keys = ON");
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
initializeSchema(db);
runMigrations(db);
db.prepare("INSERT OR IGNORE INTO sequences(name,value) VALUES('seller_receipt',0)").run();
seedDatabase(db);
