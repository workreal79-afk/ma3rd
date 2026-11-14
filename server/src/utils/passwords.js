import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;
export function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const value = String(password ?? "");
  if (value.length < 12 || value.length > 256) throw new Error("كلمة المرور يجب أن تكون من 12 إلى 256 حرفًا");
  const hash = scryptSync(value, salt, KEY_LENGTH, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("hex");
  return { salt, hash };
}
export function verifyPassword(password, salt, expectedHex) {
  try {
    if (!salt || !expectedHex || !/^[a-f0-9]{128}$/i.test(String(expectedHex))) return false;
    const actual = scryptSync(String(password ?? ""), String(salt), KEY_LENGTH, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const expected = Buffer.from(expectedHex, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch { return false; }
}
