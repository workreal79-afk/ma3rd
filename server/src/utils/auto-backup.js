import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

function bounded(value, fallback, max) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.min(max, Math.trunc(n)) : fallback;
}
export function autoBackupOptions() {
  return {
    enabled: process.env.SHOWROOM_AUTO_BACKUP !== "0",
    trigger: "after-action",
    retention: bounded(process.env.SHOWROOM_AUTO_BACKUP_RETENTION, 30, 1000),
  };
}

export function createAutoBackup({ db, dataDir, localDateString }) {
  const { enabled, retention } = autoBackupOptions();
  const backupDir = path.join(dataDir, "backups");
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(backupDir, 0o700);
  let stopped = false, running = false, pending = false, pendingReason = "action", activePromise = null;
  let lastAttemptAt = null, lastBackupAt = null, lastError = null, lastReason = null;

  async function createSnapshot(reason) {
    running = true;
    lastAttemptAt = new Date().toISOString();
    lastError = null;
    lastReason = reason;
    const stamp = `${localDateString()}-${Date.now()}-${randomUUID()}`;
    const target = path.join(backupDir, `showroom-auto-${stamp}.sqlite`);
    const staging = target + ".partial";
    try {
      // progress() returns a page count, not a ratio: fractions/zero can stall a backup.
      await db.backup(staging);
      fs.chmodSync(staging, 0o600);
      fs.renameSync(staging, target);
      const files = fs.readdirSync(backupDir)
        .filter((name) => /^showroom-auto-.*\.sqlite$/.test(name))
        .map((name) => ({ full: path.join(backupDir, name), mtime: fs.statSync(path.join(backupDir, name)).mtimeMs }))
        .sort((a,b) => b.mtime - a.mtime);
      for (const file of files.slice(retention)) { try { fs.rmSync(file.full, { force: true }); } catch (error) { console.warn("Backup retention cleanup failed:", error.code); } }
      lastBackupAt = new Date().toISOString();
      console.log(`Auto backup completed (${reason}).`);
      return target;
    } catch (error) {
      lastError = error.code || error.name || "BackupError";
      console.error("Auto backup failed:", error.code || error.name);
      for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.rmSync(staging + suffix, { force: true });
      return null;
    } finally { running = false; }
  }

  function backupNow(reason = "action") {
    if (!enabled || stopped) return Promise.resolve(null);
    pending = true;
    pendingReason = reason;
    if (activePromise) return activePromise;

    const drain = async () => {
      let target = null;
      while (pending && !stopped) {
        pending = false;
        target = await createSnapshot(pendingReason);
      }
      return target;
    };
    activePromise = drain().finally(() => {
      activePromise = null;
      if (pending && !stopped) void backupNow(pendingReason);
    });
    return activePromise;
  }

  return {
    enabled, trigger: "after-action", retention, backupDir, backupNow,
    afterAction() { return backupNow("action"); },
    status() { return { running, pending, lastAttemptAt, lastBackupAt, lastError, lastReason }; },
    stop() { stopped = true; pending = false; },
  };
}
