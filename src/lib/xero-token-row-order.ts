import type { Prisma } from "@prisma/client";

/**
 * Which `XeroToken` row is "the" connection when there is more than one (#3454).
 *
 * The table has no singleton constraint, and two first connects that finish at
 * the same moment (in either release) can each create a row. An unordered
 * `findFirst` then answers with whichever row PostgreSQL happens to scan first,
 * and that changes when a row is updated — so two readers, or one reader twice,
 * could disagree about which row is current. Every reader that picks "the" row
 * without holding its lock orders by this, so they all agree: the row written
 * most recently. A reader that already holds a row's lock reads that row by id.
 *
 * Since #3806 R2 only the token store reads `XeroToken` (to claim and release
 * the previous release's lease beside its own); every other reader asks
 * `readXeroConnection` instead. The database trigger that keeps `XeroConnection`
 * in step with this table orders the same way (`updatedAt` DESC, then `id`).
 * #3454's order was `updatedAt` alone, so the two releases agree on the row
 * except when two rows share an `updatedAt` to the millisecond; two rows exist
 * only after two simultaneous connects (the known limit in `saveXeroTokens`),
 * and the next connect or disconnect deletes both. Retired with the table in R3.
 */
export const XERO_TOKEN_ROW_ORDER: Prisma.XeroTokenOrderByWithRelationInput[] = [
  { updatedAt: "desc" },
  { id: "desc" },
];
