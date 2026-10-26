/**
 * The write guard of a Xero operation outcome (#4356, `INV-INT-029`), used by
 * `completeXeroSyncOperation` and `failXeroSyncOperation` (`xero-sync.ts`).
 */
import type { Prisma } from "@prisma/client";
import logger from "@/lib/logger";
import { XERO_REPAIR_CLAIM_RUNNING_CODES } from "@/lib/xero-stale-operations";

/** #4356: the recorded successes, full or part, that a worse outcome may not replace. */
const XERO_RECORDED_SUCCESS_STATUSES: readonly string[] = ["SUCCEEDED", "PARTIAL"];

/** #4356: a row whose outcome is a recorded success. */
export function holdsRecordedXeroSuccess(status: string): boolean {
  return XERO_RECORDED_SUCCESS_STATUSES.includes(status);
}

/**
 * #4356 (`INV-INT-029`): a row that is not a repair's RUNNING claim
 * (`XERO_REPAIR_CLAIM_RUNNING_CODES`). Spelled with the null case explicit, as
 * the stale reset is: a negated match on a nullable column would also refuse
 * every RUNNING row with no code.
 */
export const NOT_A_XERO_REPAIR_CLAIM = {
  OR: [
    { status: { not: "RUNNING" } },
    { lastErrorCode: null },
    { lastErrorCode: { notIn: [...XERO_REPAIR_CLAIM_RUNNING_CODES] } },
  ],
} satisfies Prisma.XeroSyncOperationWhereInput;

/**
 * #4356 (`INV-INT-029`): the write guard of an outcome (`status`) on an
 * operation row. Two callers can hold one row - a start that loses the insert
 * race is handed the winner's ACTIVE row (#1354) - and each records its own
 * outcome of the same keyed Xero call there. So an outcome never replaces a
 * better one already recorded: only SUCCEEDED lands on SUCCEEDED, only
 * SUCCEEDED or PARTIAL on PARTIAL. Nor does any outcome but SUCCEEDED land on
 * a repair's RUNNING claim (`XERO_REPAIR_CLAIM_RUNNING_CODES`): it would
 * replace the payload the repair reads and make the repair's own give-back
 * lose. A SUCCEEDED write lands on anything; `alsoKeep` keeps one more status
 * out. `onlyIfRunningSince` writes onto that RUNNING claim only, which no
 * recorded outcome is. Null: an unguarded write.
 */
export function outcomeWriteGuard(
  operationId: string,
  status: string,
  options: { onlyIfRunningSince?: Date; alsoKeep?: string },
): Prisma.XeroSyncOperationWhereInput | null {
  // An `updateMany` reads an undefined id as no filter at all: never let one through.
  if (!operationId) throw new Error("A Xero operation outcome needs the operation's id.");
  if (options.onlyIfRunningSince) return { status: "RUNNING", startedAt: options.onlyIfRunningSince };
  if (status === "SUCCEEDED") return null;
  const kept = XERO_RECORDED_SUCCESS_STATUSES.filter((held) => held !== status);
  if (options.alsoKeep) kept.push(options.alsoKeep);
  return {
    status: kept.length === 1 ? { not: kept[0] } : { notIn: kept },
    ...NOT_A_XERO_REPAIR_CLAIM,
  };
}

type OutcomeRowReader = Pick<Prisma.TransactionClient, "xeroSyncOperation">;

/**
 * A guarded outcome write that matched no row: nothing written, nothing
 * alerted; answers null. A row that is not there at all is said so: an outcome
 * its caller did not guard throws, as the unguarded `update` it was before
 * #4356 did, and a guarded one logs it.
 */
export async function refusedOutcomeWrite(
  db: OutcomeRowReader,
  operationId: string,
  status: string,
  caller: { onlyIfRunningSince?: Date; keepCancelled?: boolean },
): Promise<null> {
  const row = await db.xeroSyncOperation.findUnique({ where: { id: operationId }, select: { status: true } });
  if (!row) {
    if (!caller.onlyIfRunningSince && !caller.keepCancelled) {
      throw new Error(`Xero operation ${operationId} was not found, so its ${status} outcome was not recorded.`);
    }
    logger.warn({ operationId, status }, "Xero operation outcome not recorded: the operation row was not found");
    return null;
  }
  // A claim-guarded caller reports its own lost claim.
  if (!caller.onlyIfRunningSince) {
    logger.info(
      { operationId, status, heldStatus: row.status },
      "Xero operation outcome not recorded: the row kept the outcome or claim it holds (INV-INT-029)",
    );
  }
  return null;
}
