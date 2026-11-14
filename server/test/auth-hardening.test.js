import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { pathToFileURL } from "node:url";

process.env.NODE_ENV = "test";
const auth = await import("../src/middlewares/auth.js");
const { verifyPassword } = await import("../src/utils/passwords.js");
const { needsFirstRunAdmin, createFirstRunAdmin, FIRST_RUN_FILE } = await import("../src/utils/first-run-admin.js");
const { loadOrCreateShareSecret } = await import("../src/utils/share-secret.js");

const DOC = "/api/documents/receipt/REC-000001";

test("share links are signed with a random secret, never a hard-coded or password-derived one", () => {
  const token = auth.createDocumentShareToken(DOC);
  assert.equal(auth.verifyDocumentShareToken(token, DOC), true);
  const body = token.split(".")[0];
  for (const guessed of ["showroom-document-share", "admin123", "admin", ""]) {
    const forged = `${body}.${createHmac("sha256", guessed).update(body).digest("base64url")}`;
    assert.equal(auth.verifyDocumentShareToken(forged, DOC), false, `سر مخمّن: "${guessed}"`);
  }
});

test("share token is bound to one document, expires, and dies when the secret rotates", () => {
  const token = auth.createDocumentShareToken(DOC, 1_000);
  assert.equal(auth.verifyDocumentShareToken(token, DOC, 1_000 + 60), true);
  assert.equal(auth.verifyDocumentShareToken(token, "/api/documents/receipt/REC-000002", 1_000 + 60), false);
  assert.equal(auth.verifyDocumentShareToken(token, DOC, 1_000 + 8 * 24 * 3600), false);
  const fresh = auth.createDocumentShareToken(DOC);
  auth.setShareSecret("r".repeat(48));
  assert.equal(auth.verifyDocumentShareToken(fresh, DOC), false);
  assert.equal(auth.verifyDocumentShareToken(auth.createDocumentShareToken(DOC), DOC), true);
  assert.throws(() => auth.setShareSecret("short"));
});

test("persisted share secret is created once with a private mode and reused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "showroom-secret-"));
  try {
    const first = loadOrCreateShareSecret(dir);
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(loadOrCreateShareSecret(dir), first);
    if (process.platform !== "win32") assert.equal(fs.statSync(path.join(dir, ".share-secret")).mode & 0o077, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("login form attempts are rate limited per IP and reset on success or after the window", () => {
  const ip = "203.0.113.7", t0 = 10_000_000;
  for (let i = 0; i < auth.loginLimits.MAX_FAILED - 1; i += 1) auth.recordLoginFailure(ip, t0);
  assert.equal(auth.loginBlocked(ip, t0), false);
  auth.recordLoginFailure(ip, t0);
  assert.equal(auth.loginBlocked(ip, t0), true);
  assert.equal(auth.loginBlocked("203.0.113.8", t0), false, "IP آخر لا يتأثر");
  assert.equal(auth.loginBlocked(ip, t0 + auth.loginLimits.WINDOW_MS + 1), false, "تنتهي النافذة");
  for (let i = 0; i < auth.loginLimits.MAX_FAILED; i += 1) auth.recordLoginFailure(ip, t0);
  auth.clearLoginFailures(ip);
  assert.equal(auth.loginBlocked(ip, t0), false);
});

test("session cookie gets Secure only on HTTPS requests", () => {
  const cookieFor = (secure) => { let value = ""; auth.setSessionCookie({ req: { secure }, set: (_name, v) => { value = v; } }, "abc"); return value; };
  assert.match(cookieFor(true), /; Secure/);
  assert.doesNotMatch(cookieFor(false), /Secure/);
  assert.match(cookieFor(false), /HttpOnly; SameSite=Lax/);
});

test("no built-in default credentials exist, even in development", () => {
  const env = { ...process.env, NODE_ENV: "development" };
  for (const key of ["SHOWROOM_AUTH_USER", "SHOWROOM_AUTH_PASS", "SHOWROOM_API_TOKEN", "SHOWROOM_DEMO_MODE"]) delete env[key];
  const code = `const m = await import(${JSON.stringify(pathToFileURL(path.resolve("src/config/env.js")).href)}); console.log(JSON.stringify({ u: m.config.authUser, p: m.config.authPassword, on: m.authEnabled }));`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout.trim()), { u: "", p: "", on: false });
});

let DatabaseSync = null;
try { ({ DatabaseSync } = await import("node:sqlite")); } catch { /* Node أقدم من 22.5 */ }

test("first run creates a random-password admin once; configured installs are untouched", { skip: !DatabaseSync && "node:sqlite غير متاح" }, () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE staff_users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE', created_by TEXT NOT NULL DEFAULT 'system', updated_by TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT, entity_type TEXT, entity_id INTEGER, details TEXT, actor TEXT);`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "showroom-first-"));
  try {
    assert.equal(needsFirstRunAdmin({ db, authUser: "u", authPassword: "p" }), false, "بيانات البيئة تكفي");
    assert.equal(needsFirstRunAdmin({ db, authUser: "", authPassword: "" }), true);
    const first = createFirstRunAdmin({ db, dataDir: dir });
    assert.equal(first.username, "admin");
    assert.ok(first.password.length >= 20);
    assert.notEqual(first.password, "admin123");
    const row = db.prepare("SELECT * FROM staff_users WHERE username=?").get("admin");
    assert.equal(row.role, "ADMIN");
    assert.equal(row.status, "ACTIVE");
    assert.equal(verifyPassword(first.password, row.password_salt, row.password_hash), true);
    assert.equal(JSON.stringify(row).includes(first.password), false, "لا تخزن كلمة المرور نصًا");
    const note = fs.readFileSync(path.join(dir, FIRST_RUN_FILE), "utf8");
    assert.ok(note.includes(first.password) && note.includes("admin"));
    assert.equal(db.prepare("SELECT details FROM audit_log").get().details.includes(first.password), false);
    assert.equal(needsFirstRunAdmin({ db, authUser: "", authPassword: "" }), false, "لا يتكرر بعد وجود مدير");
    db.prepare("UPDATE staff_users SET status='DISABLED'").run();
    assert.equal(createFirstRunAdmin({ db, dataDir: dir }).username.startsWith("admin-"), true, "اسم مأخوذ → اسم بديل");
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
