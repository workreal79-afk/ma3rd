import test from "node:test";
import assert from "node:assert/strict";
import { addMonths, localDateString, isValidDateString } from "../src/utils/date.js";
import { asPositiveMoney, asDate } from "../src/shared/validation.js";
import { calculateInstallmentPlan } from "../src/modules/finance/installment.calculator.js";

test("calendar dates do not shift by timezone", () => {
  assert.equal(addMonths("2026-09-01", 1), "2026-10-01");
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonths("2028-01-31", 1), "2028-02-29");
  assert.equal(addMonths("2026-03-31", 1), "2026-04-30");
  assert.equal(addMonths("2026-03-31", -1), "2026-02-28");
});

test("small remainder can be combined into final installment", () => {
  const plan = calculateInstallmentPlan({ total: 155000, monthlyAmount: 1500, combineSmallRemainder: true });
  assert.equal(plan.remainder, 500);
  assert.equal(plan.count, 103);
  assert.equal(plan.amounts.at(-1), 2000);
});

test("small remainder can be a separate final installment", () => {
  const plan = calculateInstallmentPlan({ total: 155000, monthlyAmount: 1500, combineSmallRemainder: false });
  assert.equal(plan.remainder, 500);
  assert.equal(plan.count, 104);
  assert.equal(plan.amounts.at(-1), 500);
});

test("local date is YYYY-MM-DD", () => {
  assert.match(localDateString(), /^\d{4}-\d{2}-\d{2}$/);
});


test("date and amount validation rejects invalid input", () => {
  assert.equal(isValidDateString("2026-02-28"), true);
  assert.equal(isValidDateString("2026-02-30"), false);
  assert.throws(() => asPositiveMoney(0, "المبلغ"));
  assert.throws(() => asDate("2026-02-30", "التاريخ"));
});
