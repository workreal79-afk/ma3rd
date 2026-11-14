import { isValidDateString } from "../utils/date.js";
import { InputError } from "./errors.js";

export function requireText(value, fieldLabel = "الحقل", maxLength = 200) {
  if (typeof value !== "string" || !value.trim()) throw new InputError(`${fieldLabel} مطلوب`);
  const text = value.trim();
  if (text.length > maxLength) throw new InputError(`${fieldLabel} أطول من الحد المسموح (${maxLength})`);
  return text;
}

export function optionalText(value, fieldLabel = "الحقل", maxLength = 2000) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new InputError(`${fieldLabel} يجب أن يكون نصًا`);
  const text = value.trim();
  if (text.length > maxLength) throw new InputError(`${fieldLabel} أطول من الحد المسموح (${maxLength})`);
  return text;
}

export function asMoney(value, fieldLabel = "المبلغ") {
  if (value === null || value === undefined || !["number", "string"].includes(typeof value)) throw new InputError(`${fieldLabel} غير صحيح`);
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw new InputError(`${fieldLabel} غير صحيح`);
  const cents = Math.round((amount + Number.EPSILON * amount) * 100);
  if (!Number.isSafeInteger(cents)) throw new InputError(`${fieldLabel} يتجاوز الحد المسموح`);
  return cents === 0 ? 0 : cents / 100;
}

export function asPositiveMoney(value, fieldLabel = "المبلغ") {
  const amount = asMoney(value, fieldLabel);
  if (amount <= 0) throw new InputError(`${fieldLabel} يجب أن يكون أكبر من صفر`);
  return amount;
}

export function asDate(value, fieldLabel = "التاريخ") {
  if (typeof value !== "string" || !isValidDateString(value.trim())) throw new InputError(`${fieldLabel} غير صحيح`);
  return value.trim();
}

export function optionalDate(value, fieldLabel = "التاريخ") {
  if (value === null || value === undefined || value === "") return null;
  return asDate(value, fieldLabel);
}

export function positiveId(value, fieldLabel = "المعرف") {
  if (!["string", "number"].includes(typeof value) || !/^\d+$/.test(String(value))) throw new InputError(`${fieldLabel} غير صحيح`);
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new InputError(`${fieldLabel} غير صحيح`);
  return id;
}

export function safeInteger(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
}

export function personInput(body, label = "الاسم") {
  return {
    name: requireText(body.name, label),
    national_id: optionalText(body.national_id, "رقم الهوية", 100),
    national_id_date: optionalDate(body.national_id_date, "تاريخ الهوية") || "",
    national_id_source: optionalText(body.national_id_source, "مصدر الهوية", 200),
    phone: optionalText(body.phone, "الجوال", 100),
    address: optionalText(body.address, "العنوان", 1000),
    city: optionalText(body.city, "المدينة", 200),
    notes: optionalText(body.notes, "الملاحظات", 5000),
  };
}

export function vehicleImages(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return [];
  if (value.length > 5) throw new InputError("الحد الأقصى خمس صور لكل سيارة");
  for (const image of value) {
    if (typeof image !== "string" || !/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]*={0,2}$/.test(image)) throw new InputError("صيغة صورة السيارة غير صالحة؛ استخدم PNG أو JPEG أو WebP أو GIF");
    if (Buffer.byteLength(image.split(",")[1], "base64") > 1_200_000) throw new InputError("حجم الصورة يجب ألا يتجاوز 1.2MB");
  }
  return value;
}
