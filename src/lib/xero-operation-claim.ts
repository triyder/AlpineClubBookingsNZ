import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Atomically claim a single PENDING `XeroSyncOperation` row to RUNNING (#1272).
 *
 * This is the shared single-flight primitive behind both background workers:
 * the outbox scan (`processQueuedXeroOutboxOperations`) and the retry/requeue
 * scan (`processQueuedXeroOperationRetries`). The claim is a conditional
 * `updateMany` whose `WHERE` includes `status: "PENDING"`, so exactly one
 * concurrent worker can flip a given row out of PENDING — the loser matches
 * zero rows. Returning `count === 1` is what stops two workers double-running
 * the same operation, which for money-moving Xero calls would double the
 * financial effect. The precondition and the RUNNING transition (with the four
 * error/timestamp resets) MUST stay identical for every caller; only the
 * caller-specific predicate differs and is supplied via `guard`.
 */
export async function claimXeroSyncOperationToRunning(
  operationId: string,
  // `id` and `status` are owned by the helper — they ARE the atomic
  // single-flight precondition — and are intentionally not overridable by
  // callers, so `Omit` compile-blocks a guard that would silently weaken the
  // claim (e.g. `{ status: "RUNNING" }`, which would claim an already-running
  // row and double-process). AND/OR/NOT nesting remains an unused escape hatch,
  // so this stops the realistic accidental foot-gun, not every theoretical one.
  guard: Omit<Prisma.XeroSyncOperationWhereInput, "id" | "status">,
): Promise<boolean> {
  const result = await prisma.xeroSyncOperation.updateMany({
    where: {
      id: operationId,
      status: "PENDING",
      ...guard,
    },
    data: {
      status: "RUNNING",
      startedAt: new Date(),
      completedAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    },
  });

  return result.count === 1;
}
