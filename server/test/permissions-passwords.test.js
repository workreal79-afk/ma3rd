import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword } from "../src/utils/passwords.js";
import { enforceCapabilities } from "../src/middlewares/permissions.js";

test("passwords are salted hashes and verify only the correct password", () => {
  const first = hashPassword("A-secure-test-pass-1");
  const second = hashPassword("A-secure-test-pass-1");
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.hash, second.hash);
  assert.equal(verifyPassword("A-secure-test-pass-1", first.salt, first.hash), true);
  assert.equal(verifyPassword("wrong-pass-value", first.salt, first.hash), false);
});

test("staff passwords shorter than 12 chars are rejected", () => {
  assert.throws(() => hashPassword("short"));
});

function authorize(role, method, path) {
  const req = { user: { username: "unit-test", role }, method, path };
  let status = 200, body = null, calledNext = false;
  const res = { status(code) { status = code; return this; }, json(value) { body = value; return this; } };
  enforceCapabilities(req, res, () => { calledNext = true; });
  return { status, body, calledNext };
}

test("accountant can reverse a payment, sales role cannot", () => {
  assert.equal(authorize("ACCOUNTANT", "DELETE", "/payments/9").calledNext, true);
  assert.equal(authorize("SALES", "DELETE", "/payments/9").status, 403);
});

test("sales can create a sale but cannot cancel one", () => {
  assert.equal(authorize("SALES", "POST", "/sales").calledNext, true);
  assert.equal(authorize("SALES", "PUT", "/sales/42/cancel").status, 403);
});

test("viewer is read-only and admin can perform all actions", () => {
  assert.equal(authorize("VIEWER", "GET", "/sales").calledNext, true);
  assert.equal(authorize("VIEWER", "POST", "/sales").status, 403);
  assert.equal(authorize("ADMIN", "POST", "/sales").calledNext, true);
});

test("backup and audit-log reads are limited to admin and accountant", () => {
  for (const path of ["/backup", "/backup/status", "/audit-log"]) {
    assert.equal(authorize("ADMIN", "GET", path).calledNext, true, `ADMIN ${path}`);
    assert.equal(authorize("ACCOUNTANT", "GET", path).calledNext, true, `ACCOUNTANT ${path}`);
    for (const role of ["SALES", "VIEWER"]) {
      const result = authorize(role, "GET", path);
      assert.equal(result.status, 403, `${role} ${path}`);
      assert.equal(result.calledNext, false, `${role} ${path}`);
    }
  }
});

test("ordinary reads stay open to every role", () => {
  for (const role of ["ADMIN", "ACCOUNTANT", "SALES", "VIEWER"]) {
    for (const path of ["/sales", "/vehicles", "/customers", "/dashboard", "/payments"]) {
      assert.equal(authorize(role, "GET", path).calledNext, true, `${role} ${path}`);
    }
  }
});

test("writes of the sensitive paths are not opened by the read rule", () => {
  assert.equal(authorize("VIEWER", "POST", "/backup").status, 403);
  assert.equal(authorize("SALES", "DELETE", "/audit-log").status, 403);
});
