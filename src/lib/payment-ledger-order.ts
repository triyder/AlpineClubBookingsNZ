import type { Prisma } from "@prisma/client";

/**
 * THE ORDER OF A PAYMENT'S CAPTURE LEDGER (#4132, `INV-PAY-133`).
 *
 * `PaymentTransaction` rows written in one transaction share a `createdAt`
 * (Prisma stamps `@default(now())` once per query, and under the frozen test
 * clock every row ties). PostgreSQL returns tied rows in heap order, which an
 * UPDATE of an indexed column (a `PENDING` row becoming `SUCCEEDED`) quietly
 * changes. So `createdAt` alone is not an order. Every money read orders by
 * `createdAt`, then `insertionSeq`, the column an owned database sequence fills
 * in insertion order. A cuid `id` is not an insertion order: it is monotonic
 * only within one process, and fixture ids are literals (#4129's reverted `id`
 * tiebreak failed the #3954 race proof for that reason).
 *
 * One home for the Prisma orders and the in-memory comparators, so a fold, a
 * refund plan, the in-memory fakes and "the latest row of a kind"
 * (`latestTransactionOfKind`) all agree on which row comes first. Prisma takes
 * a mutable array, so a query spreads the constant:
 * `orderBy: [...LEDGER_ROWS_OLDEST_FIRST]`. Prisma-free at runtime (a type
 * import only), so a pure module may import it.
 *
 * `ledger-row-order-census.test.ts` fails a ledger read that orders by
 * `createdAt` without one of these constants.
 */
export const LEDGER_ROWS_OLDEST_FIRST = [
  { createdAt: "asc" },
  { insertionSeq: "asc" },
] as const satisfies readonly Prisma.PaymentTransactionOrderByWithRelationInput[];

/** {@link LEDGER_ROWS_OLDEST_FIRST} reversed: newest first, and on a tie the row inserted last first. */
export const LEDGER_ROWS_NEWEST_FIRST = [
  { createdAt: "desc" },
  { insertionSeq: "desc" },
] as const satisfies readonly Prisma.PaymentTransactionOrderByWithRelationInput[];

/** What a ledger row needs to be put in order. */
export type LedgerOrderedRow = { createdAt: Date; insertionSeq: number };

/** `Array.prototype.sort` comparator for {@link LEDGER_ROWS_OLDEST_FIRST}. */
export function compareLedgerRowsOldestFirst(a: LedgerOrderedRow, b: LedgerOrderedRow): number {
  return a.createdAt.getTime() - b.createdAt.getTime() || a.insertionSeq - b.insertionSeq;
}

/** `Array.prototype.sort` comparator for {@link LEDGER_ROWS_NEWEST_FIRST}. */
export function compareLedgerRowsNewestFirst(a: LedgerOrderedRow, b: LedgerOrderedRow): number {
  return compareLedgerRowsOldestFirst(b, a);
}
