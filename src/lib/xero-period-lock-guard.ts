/**
 * Xero period lock-date guard (#1695 create, #1697 admin override modify).
 *
 * A booking's PRIMARY Xero invoice is issue-dated at the booking's check-in
 * (getBookingInvoiceIssueDate) — on create, and again when a date edit queues
 * the invoice date/narration update (unpaid bookings) or a zero-dollar
 * recalculate creates the missing invoice. Such a write into a period locked
 * in Xero strands the outbox operation until the period is unlocked, so this
 * module rejects the triggering edit up front with an actionable message.
 * (Supplementary invoices and modification credit notes are dated at the day
 * they are raised, not at check-in, so on already-paid bookings a recalculate
 * writes no check-in-dated document — the guard still fires there, a
 * deliberately conservative choice recorded on #1697.)
 *
 * Semantics (shared by create and modify):
 * - Only PAST check-ins are guarded — the retroactive paths are the ones that
 *   can land documents in a closed period.
 * - Skipped when the Xero module is disabled or Xero is not connected.
 * - Fails closed when the lock dates cannot be read: the caller returns a
 *   retryable 503 rather than silently skipping the guard.
 * - Must be called OUTSIDE any DB transaction (it performs a Xero API call).
 */

import { ApiError } from "@/lib/api-error";
import { formatDateOnly, getTodayDateOnly, parseDateOnly } from "@/lib/date-only";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
// The source domain module, not the @/lib/xero facade (#1208 lint rule).
import { isXeroConnected } from "@/lib/xero-token-store";
import {
  getEffectiveXeroLockDate,
  getXeroLockDates,
} from "@/lib/xero-organisation";

export class XeroPeriodLockedError extends ApiError {
  readonly code = "XERO_PERIOD_LOCKED";
  constructor(readonly lockDate: string) {
    super(
      `The check-in date falls on or before the Xero lock date (${lockDate}). Unlock the period in Xero (Settings → Advanced → Financial settings → Lock dates) or choose a later check-in.`,
      409,
    );
    this.name = "XeroPeriodLockedError";
  }
}

export class XeroLockDateCheckFailedError extends ApiError {
  readonly code = "XERO_LOCK_DATE_CHECK_FAILED";
  constructor() {
    super("Could not verify the Xero lock dates. Please try again.", 503);
    this.name = "XeroLockDateCheckFailedError";
  }
}

/**
 * Response body + status for the two guard errors, or null for anything else.
 */
export function getXeroLockGuardErrorResponse(error: unknown): {
  body: { error: string; code: string; lockDate?: string };
  status: number;
} | null {
  if (error instanceof XeroPeriodLockedError) {
    return {
      body: { error: error.message, code: error.code, lockDate: error.lockDate },
      status: error.status,
    };
  }
  if (error instanceof XeroLockDateCheckFailedError) {
    return {
      body: { error: error.message, code: error.code },
      status: error.status,
    };
  }
  return null;
}

/**
 * Throws XeroPeriodLockedError when a past check-in falls on or before the
 * effective Xero lock date, and XeroLockDateCheckFailedError when the lock
 * dates cannot be read. Resolves silently in every skip case (future or
 * invalid check-in, module off, not connected, no lock date set).
 *
 * Pass options.xeroIntegrationEnabled when the caller has already loaded the
 * module flags, to avoid a second settings read.
 */
export async function assertCheckInClearsXeroLockDate(
  checkIn: Date,
  options?: { xeroIntegrationEnabled?: boolean },
): Promise<void> {
  // An unparseable date is the normal validation path's rejection to make.
  if (Number.isNaN(checkIn.getTime())) return;
  if (checkIn >= getTodayDateOnly()) return;

  const xeroIntegrationEnabled =
    options?.xeroIntegrationEnabled ??
    (await loadEffectiveModuleFlags()).xeroIntegration;
  if (!xeroIntegrationEnabled || !(await isXeroConnected())) return;

  let lockDates;
  try {
    lockDates = await getXeroLockDates();
  } catch {
    throw new XeroLockDateCheckFailedError();
  }
  const effectiveLock = getEffectiveXeroLockDate(lockDates);
  if (effectiveLock && checkIn <= effectiveLock) {
    throw new XeroPeriodLockedError(formatDateOnly(effectiveLock));
  }
}

/**
 * Modify-path variant (#1697): resolves the check-in the booking would END UP
 * with — the requested new check-in when one was sent, otherwise the booking's
 * current check-in (a check-out-only recalculate still re-dates its Xero
 * documents at the unchanged past check-in). Reads the booking OUTSIDE the
 * modification transaction; a missing booking or unparseable date resolves
 * silently and leaves the rejection to the transaction path.
 */
export async function assertProposedCheckInClearsXeroLockDate(
  db: {
    booking: {
      findUnique(args: {
        where: { id: string };
        select: { checkIn: true };
      }): Promise<{ checkIn: Date } | null>;
    };
  },
  bookingId: string,
  requestedCheckIn: string | undefined,
): Promise<void> {
  let proposedCheckIn: Date;
  if (requestedCheckIn !== undefined) {
    proposedCheckIn = parseDateOnly(requestedCheckIn);
  } else {
    const booking = await db.booking.findUnique({
      where: { id: bookingId },
      select: { checkIn: true },
    });
    if (!booking) return;
    proposedCheckIn = booking.checkIn;
  }
  await assertCheckInClearsXeroLockDate(proposedCheckIn);
}
