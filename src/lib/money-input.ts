/** Parse a non-negative decimal NZD input exactly, without binary float math. */
export function parseDecimalDollarsToCents(value: string): number | null {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const dollars = Number(match[1]);
  const cents = Number((match[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(dollars)) return null;
  const total = dollars * 100 + cents;
  return Number.isSafeInteger(total) && total <= 2_147_483_647 ? total : null;
}
