// Money helpers for the AI assistant monthly spend cap. All money is NZD integer
// cents; the editor shows dollars-and-cents. Bounds mirror the settings route's
// zod contract (0..100_000 cents = NZ$0..NZ$1,000). Cap 0 disables all paid
// answers (hard-off).

export const MAX_BUDGET_CENTS = 100_000;

/** Integer cents → a fixed 2dp dollars string for the editor input (e.g. 1000 → "10.00"). */
export function centsToDollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

export type ParseBudgetResult =
  | { ok: true; cents: number }
  | { ok: false; error: string };

/**
 * Parse a dollars-and-cents string into integer cents, enforcing the 0..$1,000
 * bound and at most two decimal places. Rejects blanks, non-numbers, negatives,
 * and over-precise input so a fat-finger cannot silently truncate.
 */
export function parseDollarsToCents(input: string): ParseBudgetResult {
  const trimmed = input.trim();
  if (trimmed === "") {
    return { ok: false, error: "Enter a monthly spend cap." };
  }
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    return {
      ok: false,
      error: "Enter a dollar amount with up to two decimal places (e.g. 10.00).",
    };
  }
  const cents = Math.round(Number.parseFloat(trimmed) * 100);
  if (!Number.isFinite(cents) || cents < 0) {
    return { ok: false, error: "Enter a valid monthly spend cap." };
  }
  if (cents > MAX_BUDGET_CENTS) {
    return {
      ok: false,
      error: `The monthly cap cannot exceed $${centsToDollars(MAX_BUDGET_CENTS)}.`,
    };
  }
  return { ok: true, cents };
}
