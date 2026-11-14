export function localDateString(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function daysInMonth(year, monthIndex) {
  const date = new Date(0);
  date.setUTCFullYear(year, monthIndex + 1, 0);
  return date.getUTCDate();
}

export function isValidDateString(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return false;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (y < 1 || y > 9999 || m < 1 || m > 12) return false;
  return d >= 1 && d <= daysInMonth(y, m - 1);
}

export function addMonths(dateString, months) {
  if (!isValidDateString(dateString)) return "";
  const [y, m, day] = String(dateString).split("-").map(Number);
  const offset = Number(months ?? 0);
  if (!Number.isSafeInteger(offset)) return "";
  const sourceIndex = m - 1;
  const targetLinear = y * 12 + sourceIndex + offset;
  const targetYear = Math.floor(targetLinear / 12);
  if (targetYear < 1 || targetYear > 9999) return "";
  const targetMonth = ((targetLinear % 12) + 12) % 12;
  const targetDay = Math.min(day, daysInMonth(targetYear, targetMonth));
  return `${String(targetYear).padStart(4,"0")}-${String(targetMonth + 1).padStart(2, "0")}-${String(targetDay).padStart(2, "0")}`;
}
