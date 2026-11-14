import { asMoney, asPositiveMoney } from "../../shared/validation.js";
import { InputError } from "../../shared/errors.js";

export const MAX_INSTALLMENTS = 600;
export function calculateInstallmentPlan({ total, monthlyAmount, combineSmallRemainder = false }) {
  const remaining = asMoney(total, "المبلغ المتبقي");
  if (remaining <= 0) throw new InputError("المبلغ المتبقي غير صحيح");
  let monthly;
  try { monthly = asPositiveMoney(monthlyAmount, "قيمة القسط"); } catch { throw new InputError("قيمة القسط يجب أن تكون أكبر من صفر"); }
  const totalCents = Math.round(remaining * 100), monthlyCents = Math.round(monthly * 100);
  const fullCount = Math.floor(totalCents / monthlyCents);
  const remainderCents = totalCents % monthlyCents;
  const remainder = remainderCents / 100;
  const smallRemainder = remainderCents > 0 && remainderCents < 100_000;
  const useCombined = smallRemainder && fullCount > 0 && Boolean(combineSmallRemainder);
  const count = fullCount + (remainderCents > 0 && !useCombined ? 1 : 0);
  if (count > MAX_INSTALLMENTS) throw new InputError(`عدد الأقساط لا يمكن أن يتجاوز ${MAX_INSTALLMENTS}`);
  const amounts = Array.from({ length: count }, (_, i) => {
    if (useCombined && i === count - 1) return (monthlyCents + remainderCents) / 100;
    if (!useCombined && remainderCents > 0 && i === count - 1) return remainder;
    return monthly;
  });
  return { remaining, monthly, fullCount, remainder, smallRemainder, useCombined, count, amounts };
}
