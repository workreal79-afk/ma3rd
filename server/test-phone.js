import { normalizePhone, prettyPhone } from "./src/modules/messaging/phone.js";

const samples = [
  "551884891",
  "0551884891",
  "+966 55 188 4891",
  "+\u200e\u202a+966 55 188 4891\u202c\u200f",
  "++966551884891",
];
for (const input of samples) {
  const normalized = normalizePhone(input, "966");
  console.log(JSON.stringify({ input, normalized, display: normalized ? prettyPhone(normalized) : null }));
}
