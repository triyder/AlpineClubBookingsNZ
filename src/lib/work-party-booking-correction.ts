/**
 * "Add booking to work party" (fork #119): an officer attaches an existing
 * booking to a work party the member was entitled to and missed, so the booking
 * gets the working-bee discount exactly as if the member had ticked "I am
 * attending a working bee" when booking.
 *
 * NOT A SECOND MONEY PATH (`INV-SSOT`). The change is the canonical booking edit,
 * `modifyBookingBatch`, run on this module's own transaction with the work
 * party's internal promo added to the booking's promo list. The repricing, the
 * promo redemption and adjustment rows, the booking ledger, the Xero documents
 * and the account-credit writer are that pipeline's own. What this module adds:
 *
 *  - the officer-only admission of ONE internal code
 *    (`officerWorkPartyCorrection`, a service argument the batch service
 *    receives beside `tx`; no request body can carry it), and the money rule
 *    that comes with it — no change fee, and the reduction returned in full;
 *  - the settlement: account credit (owner decision 6, #118), never a refund.
 *    A joiner's booking its group organiser paid keeps the organiser's
 *    disposition, as #4533's promo correction does
 *    (`defaultCorrectionSettlementMethod`);
 *  - the eligibility rule (`workPartyBookingEligibility`), shared with the UI;
 *  - a dry run for the confirm dialog and a figures check on the save, so the
 *    officer is charged-or-credited exactly what they were shown (#4030 C4).
 *
 * LOCKS (`INV-LOCK-001`/`-002`), the order #4533's executor and every booking
 * money writer use: global `pg_advisory_xact_lock(1)` — this edit moves
 * settlement money and must exclude a concurrent cancel, capture or refund —
 * then the per-lodge capacity key from the booking's immutable `lodgeId`, then
 * the booking row, and only then the mutable re-reads. Two concurrent clicks:
 * the second waits on the global key, then re-reads a booking that already
 * carries the work party and is refused, so the discount applies once.
 */
import { BookingStatus } from "@prisma/client";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import { getDefaultLodgeId } from "@/lib/lodges";
import { lockBookingRowForOwnerRead } from "@/lib/booking-row-lock";
import type { CalendarDate } from "@/lib/club-time";
import type { ClubFormat } from "@/lib/club-format";
import { ApiError } from "@/lib/api-error";
import { paidByOrganiser } from "@/lib/group-organiser-paid";
import { reauthorizeBookingOfficerFromDb } from "@/lib/booking-exception-approval";
import { defaultCorrectionSettlementMethod } from "@/lib/booking-finished-stay-correction";
import { bookingPromoRedemptions } from "@/lib/booking-promo-redemptions";
import {
  modifyBookingBatch,
  type BatchModificationPreTransaction,
} from "@/lib/booking-batch-modification-service";
import { workPartyWindowOverlapsStay } from "@/lib/work-party";

/** Statuses a booking may be added to a work party in: live, not finished. */
export const WORK_PARTY_CORRECTABLE_BOOKING_STATUSES: readonly BookingStatus[] = [
  BookingStatus.PENDING,
  BookingStatus.PAYMENT_PENDING,
  BookingStatus.CONFIRMED,
  BookingStatus.PAID,
  BookingStatus.AWAITING_REVIEW,
];

export type WorkPartyBookingEligibility =
  | { ok: true }
  | { ok: false; reason: string };

export interface WorkPartyEligibilityBooking {
  status: BookingStatus | string;
  checkIn: Date;
  checkOut: Date;
  lodgeId: string | null;
  /** Whether a work party's internal promo is already on the booking. */
  hasWorkParty: boolean;
}

export interface WorkPartyEligibilityEvent {
  name: string;
  active: boolean;
  startDate: Date;
  endDate: Date;
  lodgeId: string | null;
  lodge?: { name: string } | null;
  promoCode: { active: boolean; archivedAt: Date | null };
}

/**
 * Whether this booking may be added to this work party — the ONE rule the route,
 * the service (again, under the locks) and the admin UI's list all use.
 * `bookingLodgeId` is the booking's effective lodge (its own, or the club's
 * default for a pre-multi-lodge row).
 */
export function workPartyBookingEligibility(
  booking: WorkPartyEligibilityBooking,
  bookingLodgeId: string | null,
  event: WorkPartyEligibilityEvent,
): WorkPartyBookingEligibility {
  if (!WORK_PARTY_CORRECTABLE_BOOKING_STATUSES.includes(booking.status as BookingStatus)) {
    return {
      ok: false,
      reason: "Only a current booking can be added to a work party (not cancelled, finished, a draft or on the waitlist).",
    };
  }
  if (!event.active || !event.promoCode.active || event.promoCode.archivedAt) {
    return { ok: false, reason: `"${event.name}" is not active.` };
  }
  if (booking.hasWorkParty) {
    return { ok: false, reason: "This booking already has a work party." };
  }
  if (!workPartyWindowOverlapsStay(event, booking.checkIn, booking.checkOut)) {
    return {
      ok: false,
      reason: `None of this booking's nights fall inside "${event.name}".`,
    };
  }
  if (event.lodgeId && bookingLodgeId && event.lodgeId !== bookingLodgeId) {
    return {
      ok: false,
      reason: `"${event.name}" is held at ${event.lodge?.name ?? "another lodge"}, not this booking's lodge.`,
    };
  }
  return { ok: true };
}

/** What the correction does to the booking's money, shown before and checked on save. */
export interface WorkPartyCorrectionFigures {
  /** The booking's price before (integer cents). */
  previousFinalPriceCents: number;
  /** The booking's price after (integer cents). */
  newFinalPriceCents: number;
  /** The change in price: negative, or zero when no night is discounted. */
  priceDiffCents: number;
  /** Paid money returned as account credit. */
  accountCreditAmountCents: number;
  /** Paid money refunded — zero except on an organiser-paid joiner's booking. */
  refundAmountCents: number;
  settlementMethod: "card" | "credit";
}

export const WORK_PARTY_CORRECTION_FIGURES_CHANGED_MESSAGE =
  "The booking changed since the figures were shown. Check the new figures and confirm again.";

export class WorkPartyCorrectionFiguresChangedError extends Error {
  readonly code = "FIGURES_CHANGED";
  constructor(readonly actual: WorkPartyCorrectionFigures) {
    super(WORK_PARTY_CORRECTION_FIGURES_CHANGED_MESSAGE);
    this.name = "WorkPartyCorrectionFiguresChangedError";
  }
}

/** Thrown to roll a dry run back, carrying what it would have done. */
class WorkPartyCorrectionDryRun extends Error {
  constructor(readonly figures: WorkPartyCorrectionFigures) {
    super("work-party correction dry run");
  }
}

export type WorkPartyCorrectionResult =
  | { outcome: "quoted"; figures: WorkPartyCorrectionFigures }
  | {
      outcome: "applied";
      figures: WorkPartyCorrectionFigures;
      bookingModificationId: string | null;
      followUpFailed?: boolean;
    };

export type WorkPartyCorrectionMode =
  | { dryRun: true }
  | { dryRun: false; expectedFigures: WorkPartyCorrectionFigures };

const FIGURE_KEYS = [
  "newFinalPriceCents",
  "priceDiffCents",
  "accountCreditAmountCents",
  "refundAmountCents",
] as const satisfies ReadonlyArray<keyof WorkPartyCorrectionFigures>;

export async function addBookingToWorkParty(
  params: {
    bookingId: string;
    workPartyEventId: string;
    actorMemberId: string;
    /** Absent means notify, as every officer edit does by default. */
    notifyMember?: boolean;
    ipAddress: string;
    /** The club's day, resolved before the transaction (`INV-LOCK-004`). */
    todayAtClub: CalendarDate;
    /** The club's format, resolved before the transaction (#3565). */
    format: ClubFormat;
    /** `prepareBatchModificationForCallerTransaction({ audience: "admin" })`. */
    preTransaction: BatchModificationPreTransaction;
  } & WorkPartyCorrectionMode,
): Promise<WorkPartyCorrectionResult> {
  let deferredPostCommit: (() => Promise<void>) | null = null;

  const result = await prisma
    .$transaction(async (tx): Promise<WorkPartyCorrectionResult> => {
      // (1) Only the immutable keys before the locks (#4845).
      const preRead = await tx.booking.findUnique({
        where: { id: params.bookingId },
        select: { lodgeId: true },
      });
      if (!preRead) throw new ApiError("Booking not found", 404);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      const bookingLodgeId = preRead.lodgeId ?? (await getDefaultLodgeId(tx));
      await acquireLodgeCapacityLock(tx, bookingLodgeId);
      await lockBookingRowForOwnerRead(tx, params.bookingId);

      // (2) Fresh roles under the locks; nothing written yet.
      if (!(await reauthorizeBookingOfficerFromDb(tx, params.actorMemberId))) {
        throw new ApiError("Forbidden", 403);
      }

      // (3) The booking and the work party, fresh.
      const booking = await tx.booking.findUnique({
        where: { id: params.bookingId },
        select: {
          status: true,
          checkIn: true,
          checkOut: true,
          lodgeId: true,
          finalPriceCents: true,
          organiserSettled: true,
          parentBookingId: true,
          payment: { select: { amountCents: true, creditAppliedCents: true, source: true } },
          promoRedemptions: {
            select: {
              id: true,
              applicationOrder: true,
              promoCode: {
                select: { code: true, workPartyEvent: { select: { id: true } } },
              },
            },
          },
        },
      });
      if (!booking) throw new ApiError("Booking not found", 404);
      const event = await tx.workPartyEvent.findUnique({
        where: { id: params.workPartyEventId },
        select: {
          name: true,
          active: true,
          startDate: true,
          endDate: true,
          lodgeId: true,
          lodge: { select: { name: true } },
          promoCode: {
            select: { id: true, code: true, active: true, archivedAt: true },
          },
        },
      });
      if (!event) throw new ApiError("Work party not found", 404);

      const redemptions = bookingPromoRedemptions(booking);
      const eligibility = workPartyBookingEligibility(
        {
          ...booking,
          hasWorkParty: redemptions.some((row) => row.promoCode?.workPartyEvent),
        },
        bookingLodgeId,
        event,
      );
      if (!eligibility.ok) throw new ApiError(eligibility.reason, 409);

      // (4) The canonical edit, on THIS transaction: the booking's codes in
      // their order, then the work party's. Its refusals throw and roll back.
      const settlementMethod = defaultCorrectionSettlementMethod(booking.payment, {
        changesPromoCodes: true,
        paidByOrganiser: paidByOrganiser(booking),
      });
      const modified = await modifyBookingBatch({
        bookingId: params.bookingId,
        actor: { id: params.actorMemberId, role: "ADMIN" },
        input: {
          promoCodes: [
            ...redemptions.flatMap((row) => (row.promoCode ? [{ code: row.promoCode.code }] : [])),
            { code: event.promoCode.code },
          ],
          settlementMethod,
          ...(params.notifyMember === undefined ? {} : { notifyMember: params.notifyMember }),
        },
        ipAddress: params.ipAddress,
        todayAtClub: params.todayAtClub,
        format: params.format,
        tx,
        preTransaction: params.preTransaction,
        officerWorkPartyCorrection: { promoCodeId: event.promoCode.id },
      });

      // (5) The discount must actually have landed, and can only lower the
      // price. An in-progress stay keeps its agreed prices and runs no promo,
      // which is a refusal here rather than a silent no-op.
      const applied = await tx.promoRedemption.findFirst({
        where: { bookingId: params.bookingId, promoCodeId: event.promoCode.id },
        select: { id: true },
      });
      if (!applied || modified.promoChangeNotApplied) {
        throw new ApiError(
          modified.promoChangeNotApplied?.message ??
            "The work party discount could not be applied to this booking.",
          409,
        );
      }
      if (modified.priceDiffCents > 0) {
        throw new ApiError("Adding the work party would raise this booking's price.", 409);
      }

      const figures: WorkPartyCorrectionFigures = {
        previousFinalPriceCents: booking.finalPriceCents,
        newFinalPriceCents: modified.booking.finalPriceCents,
        priceDiffCents: modified.priceDiffCents,
        accountCreditAmountCents: modified.accountCreditAmountCents,
        refundAmountCents: modified.refundAmountCents,
        settlementMethod,
      };
      if (params.dryRun) throw new WorkPartyCorrectionDryRun(figures);

      // (6) Only what the officer was shown (#4030 C4). A throw rolls it all back.
      const expected = params.expectedFigures;
      if (FIGURE_KEYS.some((key) => expected[key] !== figures[key])) {
        throw new WorkPartyCorrectionFiguresChangedError(figures);
      }

      deferredPostCommit = modified.deferredPostCommit ?? null;
      return {
        outcome: "applied",
        figures,
        bookingModificationId: modified.bookingModificationId ?? null,
      };
    })
    .catch((error: unknown) => {
      if (error instanceof WorkPartyCorrectionDryRun) {
        return { outcome: "quoted" as const, figures: error.figures };
      }
      throw error;
    });

  // (7) After commit: the edit's own follow-up work (emails, Xero dispatch).
  if (result.outcome === "applied" && deferredPostCommit) {
    try {
      await (deferredPostCommit as () => Promise<void>)();
    } catch (error) {
      logger.error(
        { err: error, bookingId: params.bookingId },
        "Booking added to a work party, but post-commit follow-up work failed",
      );
      return { ...result, followUpFailed: true };
    }
  }
  return result;
}
