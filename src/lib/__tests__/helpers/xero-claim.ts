import type { PrismaClient } from "@prisma/client";
import type { XeroOperationClaim } from "@/lib/xero-operation-outcome-guard";

/** #4373: the instant the claims below were stamped - the frozen test clock. */
export const TEST_XERO_CLAIMED_AT = new Date("2026-07-01T00:00:00.000Z");

/**
 * #4373: the claim a Xero operation outcome is written under (`INV-INT-029`),
 * for a test that hands a handler or writer an operation id.
 */
export function xeroClaim(id: string, startedAt: Date | null = TEST_XERO_CLAIMED_AT): XeroOperationClaim {
  return { id, startedAt };
}

/**
 * #4373: the claim a real-database row holds as it stands (its id and current
 * `startedAt`), for a test that runs a handler on a row directly.
 */
export async function currentXeroClaim(
  db: Pick<PrismaClient, "xeroSyncOperation">,
  id: string,
): Promise<XeroOperationClaim> {
  return db.xeroSyncOperation.findUniqueOrThrow({ where: { id }, select: { id: true, startedAt: true } });
}
