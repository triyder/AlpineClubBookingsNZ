import type { Prisma } from "@prisma/client";

import logger from "@/lib/logger";

type LinkageDb = Pick<Prisma.TransactionClient, "bookingChangeRequest">;

/**
 * Link an admin-override booking modification to the booking's most recent
 * APPROVED-but-unlinked change request (issue #1668), closing the
 * approve → apply audit trail the change-request panel exposes.
 *
 * Best-effort and post-transaction: an admin can shift a locked/past booking
 * that has no outstanding request at all, so a missing (or already-linked)
 * request is a normal no-op, never a failure. Any error is logged and
 * swallowed so it can never roll back a completed date move.
 *
 * Only APPROVED, `linkedModificationId: null` rows are eligible — a REQUESTED
 * (not-yet-reviewed) request and an already-linked request are both left
 * untouched. The newest by `reviewedAt` wins.
 */
export async function linkModificationToOutstandingChangeRequest(
  db: LinkageDb,
  bookingId: string,
  modificationId: string,
): Promise<string | null> {
  try {
    const request = await db.bookingChangeRequest.findFirst({
      where: {
        bookingId,
        status: "APPROVED",
        linkedModificationId: null,
      },
      orderBy: { reviewedAt: "desc" },
      select: { id: true },
    });
    if (!request) return null;

    // Conditional claim: a concurrent override (or the admin's manual link
    // PATCH) may have linked this request between the find and the write —
    // never overwrite an existing linkedModificationId.
    const claim = await db.bookingChangeRequest.updateMany({
      where: { id: request.id, linkedModificationId: null },
      data: { linkedModificationId: modificationId },
    });
    return claim.count === 1 ? request.id : null;
  } catch (err) {
    logger.error(
      { err, bookingId, modificationId },
      "Failed to link booking modification to approved change request",
    );
    return null;
  }
}
