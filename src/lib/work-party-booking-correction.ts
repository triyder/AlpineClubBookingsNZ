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
 *  - the settlement (#129 decisions 1 and 5, `workPartySettlementOptions`):
 *    account credit by default; on a booking paid by card the officer may
 *    choose a refund to the card instead; a joiner's booking its group
 *    organiser paid goes back to the organiser, as every edit of one does. A
 *    refund is the pipeline's own (`settlementMethod: "card"`): this module
 *    calls no provider and writes no refund row of its own;
 *  - the eligibility rule (`workPartyBookingEligibility`), shared with the UI;
 *  - the owner's rule for the officer's own and family's bookings (#129
 *    decision 6, `workPartyOwnMoneyBackRefusal`): allowed while nothing comes
 *    back, refused when the change would refund or credit money to the officer
 *    or their family, which another officer must then do;
 *  - a dry run for the confirm dialog and a figures check on the save, so the
 *    officer is charged-or-credited exactly what they were shown (#4030 C4);
 *  - a started stay (#127) priced whole (`INV-MOD-062`), so every night in the
 *    window is discounted, slept or not; and Remove (#130), the same edit with
 *    the code taken off, its increase owed on the booking.
 *
 * LOCKS (`INV-LOCK-001`/`-002`), the order #4533's executor and every booking
 * money writer use: global `pg_advisory_xact_lock(1)` — this edit moves
 * settlement money and must exclude a concurrent cancel, capture or refund —
 * then the per-lodge capacity key from the booking's immutable `lodgeId`, then
 * the booking row, and only then the mutable re-reads. Two concurrent clicks:
 * the second waits on the global key, then re-reads a booking that already
 * carries the work party and is refused, so the discount applies once.
 */
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import { getDefaultLodgeId } from "@/lib/lodges";
import { lockBookingRowForOwnerRead } from "@/lib/booking-row-lock";
import { dateOnlyInstantOf, type CalendarDate } from "@/lib/club-time";
import type { ClubFormat } from "@/lib/club-format";
import { ApiError } from "@/lib/api-error";
import { paidByOrganiser } from "@/lib/group-organiser-paid";
import { hasSettledCardPayment } from "@/lib/booking-payment-state";
import { getAllowedGuestMemberIds, type BookingGuestLookupDb } from "@/lib/booking-guests";
import { reauthorizeBookingOfficerFromDb } from "@/lib/booking-exception-approval";
import { defaultCorrectionSettlementMethod } from "@/lib/booking-finished-stay-correction";
import { bookingPromoRedemptions } from "@/lib/booking-promo-redemptions";
import { bookingOwner } from "@/lib/booking-owner";
import { activeLifecycleEditRefusal, isFinishedStay } from "@/lib/booking-edit-policy";
import { isQuotePricedBooking } from "@/lib/booking-modify-validation";
import type { BookingModificationSettlementMethod } from "@/lib/booking-modify";
import { multiPromoCodesEnabled } from "@/lib/promo-redemption-slot";
import { PROMO_WORK_PARTY_EXCLUSION_MESSAGE } from "@/lib/promo-code-list-rules";
import {
  modifyBookingBatch,
  type BatchModificationPreTransaction,
} from "@/lib/booking-batch-modification-service";
import { workPartyEventRefusal } from "@/lib/work-party";
import { editTotalMoneyBackCents } from "@/lib/edit-money-back";

export type WorkPartyBookingEligibility =
  | { ok: true }
  | { ok: false; reason: string };

/** What the rule needs to know about the booking, read by the caller. */
export interface WorkPartyEligibilityBooking {
  status: string;
  checkIn: Date;
  checkOut: Date;
  /** A work party's internal promo is already on the booking. */
  hasWorkParty: boolean;
  /** Another (non-work-party) promo code is on the booking. */
  hasOtherPromoCode: boolean;
  /** A quote-priced booking (school, request quote), priced by its quote. */
  quotePriced: boolean;
  /** A member owns it (`bookingOwner`); an organisation's booking holds no credit. */
  memberOwned: boolean;
}

/** The facts outside the booking the rule reads. */
export interface WorkPartyEligibilityContext {
  /** The booking's effective lodge (its own, or the club default). */
  bookingLodgeId: string | null;
  /** The club's today as a date-only instant (`dateOnlyInstantOf(today)`). */
  today: Date;
  /** The club's several-codes switch (`multiPromoCodesEnabled`). */
  multiPromoCodes: boolean;
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
 * The refusals Add and Remove share: the edit doors' own editable-status answer
 * (`activeLifecycleEditRefusal`, #3245) and a finished stay. A stay that has
 * started is allowed (#127, owner 16 Nov 2026): every night inside the work
 * party's window is repriced, slept or not (`getBookingEditPolicy`'s
 * "work-party-correction" mode).
 */
function workPartyStayRefusal(
  booking: { status: string; checkOut: Date; quotePriced: boolean },
  today: Date,
): string | null {
  if (activeLifecycleEditRefusal(booking.status, "ADMIN") !== null) {
    return "This booking can't be changed in its current status (only a pending, confirmed or paid booking can).";
  }
  if (isFinishedStay(booking, today)) {
    return "This stay has finished, so its work party can't be changed here.";
  }
  if (booking.quotePriced) {
    return "This booking is priced by its quote, so its work party discount can't be changed.";
  }
  return null;
}

/**
 * Whether this booking may be added to this work party — the ONE rule the GET
 * list, the service (again, under the locks) and so the dialog all use. Each
 * refusal is one the canonical edit would make anyway, stated up front in an
 * officer's words rather than discovered at the preview. A started stay is
 * allowed (#127); a finished one is not. An organiser-paid joiner is allowed
 * (#129 decision 5); an officer's own or family's booking is refused only once
 * the figures show money coming back (`workPartyOwnMoneyBackRefusal`). The
 * event answer is `workPartyEventRefusal`; it is not copied.
 */
export function workPartyBookingEligibility(
  booking: WorkPartyEligibilityBooking,
  context: WorkPartyEligibilityContext,
  event: WorkPartyEligibilityEvent,
): WorkPartyBookingEligibility {
  const stayRefusal = workPartyStayRefusal(booking, context.today);
  if (stayRefusal) return { ok: false, reason: stayRefusal };
  if (!booking.memberOwned) {
    return {
      ok: false,
      reason: "This booking belongs to an organisation, which has no account credit to return the discount to.",
    };
  }
  if (booking.hasWorkParty) {
    return { ok: false, reason: "This booking already has a work party." };
  }
  if (booking.hasOtherPromoCode && !context.multiPromoCodes) {
    return { ok: false, reason: PROMO_WORK_PARTY_EXCLUSION_MESSAGE };
  }
  switch (
    workPartyEventRefusal(event, booking.checkIn, booking.checkOut, context.bookingLodgeId)
  ) {
    case "inactive":
      return { ok: false, reason: `"${event.name}" is not active.` };
    case "no-overlap":
      return { ok: false, reason: `None of this booking's nights fall inside "${event.name}".` };
    case "other-lodge":
      return {
        ok: false,
        reason: `"${event.name}" is held at ${event.lodge?.name ?? "another lodge"}, not this booking's lodge.`,
      };
    case null:
      return { ok: true };
  }
}

/** What "Remove from work party" (#130) reads about the booking. */
export interface WorkPartyRemovalEligibilityBooking {
  status: string;
  checkOut: Date;
  quotePriced: boolean;
  /** The work party whose internal promo is on the booking, or null. */
  workPartyEventId: string | null;
}

export const WORK_PARTY_NOT_ON_BOOKING_MESSAGE = "This booking is not on that work party.";

/**
 * Whether this booking may be taken off this work party (#130): the stay
 * rules Add has, and the booking must carry exactly this work party. The
 * event's own state does not matter: an inactive work party can still be
 * removed from a booking it was added to by mistake.
 */
export function workPartyRemovalEligibility(
  booking: WorkPartyRemovalEligibilityBooking,
  context: Pick<WorkPartyEligibilityContext, "today">,
  workPartyEventId: string,
): WorkPartyBookingEligibility {
  const stayRefusal = workPartyStayRefusal(booking, context.today);
  if (stayRefusal) return { ok: false, reason: stayRefusal };
  if (booking.workPartyEventId !== workPartyEventId) {
    return { ok: false, reason: WORK_PARTY_NOT_ON_BOOKING_MESSAGE };
  }
  return { ok: true };
}

/**
 * Whether the acting officer is this member or in their family (#129 decision
 * 6). Family is the one existing definition, the member-guest boundary's
 * (`getAllowedGuestMemberIds`: the member plus every co-member of all their
 * family groups). No member (an organisation) has no family.
 */
export async function actorIsMemberOrFamily(
  db: BookingGuestLookupDb,
  memberId: string | null,
  actorMemberId: string,
): Promise<boolean> {
  if (!memberId) return false;
  return (await getAllowedGuestMemberIds(db, memberId)).has(actorMemberId);
}

export interface WorkPartySettlementOptions {
  /** The methods offered, the default first. Always one for an organiser-paid joiner. */
  methods: readonly BookingModificationSettlementMethod[];
  /** A joiner's booking its group organiser paid: the money goes back to the organiser. */
  paidByOrganiser: boolean;
}

/** What `workPartySettlementOptions` reads: the booking's lifecycle and payment. */
export interface WorkPartySettlementBooking {
  status: string;
  organiserSettled: boolean;
  parentBookingId: string | null;
  payment: {
    status: string;
    amountCents: number;
    creditAppliedCents: number;
    source: string;
  } | null;
}

/**
 * The settlement methods "Add to work party" offers (#129 decisions 1 and 5).
 * Pure; the service asks it under its locks, so the preview and the save agree.
 *
 *  - An organiser-paid joiner (`paidByOrganiser`): one disposition, the
 *    organiser's, as every edit of such a booking settles
 *    (`defaultCorrectionSettlementMethod` with `paidByOrganiser`).
 *  - Paid by card (`hasSettledCardPayment`, the pipeline's own test of money a
 *    reduction can refund to the card): credit, or card.
 *  - Otherwise (Internet Banking, paid wholly with account credit, unpaid):
 *    credit only.
 */
export function workPartySettlementOptions(
  booking: WorkPartySettlementBooking,
): WorkPartySettlementOptions {
  if (paidByOrganiser(booking)) {
    return {
      methods: [
        defaultCorrectionSettlementMethod(booking.payment, {
          changesPromoCodes: true,
          paidByOrganiser: true,
        }),
      ],
      paidByOrganiser: true,
    };
  }
  return {
    methods: hasSettledCardPayment(booking) ? ["credit", "card"] : ["credit"],
    paidByOrganiser: false,
  };
}

export const WORK_PARTY_SETTLEMENT_NOT_OFFERED_MESSAGE =
  "This booking wasn't paid by card, so the discount can only go back as club credit.";

/**
 * The method the change settles by: the officer's, when it is one offered;
 * the default otherwise. A method not offered — `card` on a booking not paid
 * by card — is refused (409), never quietly changed.
 */
export function resolveWorkPartySettlementMethod(
  options: WorkPartySettlementOptions,
  requested: BookingModificationSettlementMethod | undefined,
): BookingModificationSettlementMethod {
  if (requested !== undefined && !options.methods.includes(requested)) {
    throw new ApiError(
      options.paidByOrganiser
        ? "This booking was paid by its group organiser, so the discount goes back to the organiser."
        : WORK_PARTY_SETTLEMENT_NOT_OFFERED_MESSAGE,
      409,
    );
  }
  return requested ?? options.methods[0]!;
}

/** What the correction does to the booking's money, shown before and checked on save. */
export interface WorkPartyCorrectionFigures {
  /** The booking's price before (integer cents). */
  previousFinalPriceCents: number;
  /** The booking's price after (integer cents). */
  newFinalPriceCents: number;
  /** The change in price: negative on an Add, positive on a Remove. */
  priceDiffCents: number;
  /** Paid money returned as account credit. */
  accountCreditAmountCents: number;
  /** A PAID booking's applied credit given back to the member's balance (#3809). */
  appliedCreditGivenBackCents: number;
  /**
   * An UNPAID booking's applied credit above its new total, returned to the
   * owner's balance by the lifecycle's clamp (F20, #1887). Never alongside
   * `appliedCreditGivenBackCents` (`edit-money-back.ts` says why).
   */
  refundedExcessCreditCents: number;
  /** Still to pay after the change (an unpaid ask's remainder), or 0. */
  additionalAmountCents: number;
  /**
   * Paid money refunded: to the member's card when the officer chose `card`,
   * or to the group organiser for an organiser-paid joiner; otherwise 0.
   */
  refundAmountCents: number;
  /**
   * The method the change settles by (`resolveWorkPartySettlementMethod`);
   * null on a Remove, which hands nothing back.
   */
  settlementMethod: BookingModificationSettlementMethod | null;
}

/**
 * Every cent the change hands back (`editTotalMoneyBackCents`, the one sum the
 * linked move also uses, fork #132): the settlement's plus an unpaid booking's
 * applied credit freed by the lower price.
 */
export function workPartyMoneyBackCents(figures: WorkPartyCorrectionFigures): number {
  return editTotalMoneyBackCents(figures);
}

export const WORK_PARTY_OWN_MONEY_BACK_MESSAGE =
  "This change would refund or credit money to you or your family, so another officer must add this booking to the work party.";

/**
 * #129 decision 6 (owner, 16 Nov 2026): an officer may add their own or their
 * family's booking while nothing comes back (an unpaid booking with no account
 * credit applied: its price just drops); once the change would refund or
 * credit any money (`workPartyMoneyBackCents`), another officer
 * must. The money's recipient is the booking's owner, or for an organiser-paid
 * joiner the group organiser (the lane's reading, recorded on the issue).
 */
export function workPartyOwnMoneyBackRefusal(
  figures: WorkPartyCorrectionFigures,
  recipientIsActorOrFamily: boolean,
): string | null {
  return recipientIsActorOrFamily && workPartyMoneyBackCents(figures) > 0
    ? WORK_PARTY_OWN_MONEY_BACK_MESSAGE
    : null;
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
  constructor(
    readonly figures: WorkPartyCorrectionFigures,
    readonly settlementOptions: WorkPartySettlementOptions,
  ) {
    super("work-party correction dry run");
  }
}

export type WorkPartyCorrectionResult =
  | {
      outcome: "quoted";
      figures: WorkPartyCorrectionFigures;
      /** What the officer may choose between, for the confirm dialog. */
      settlementOptions: WorkPartySettlementOptions;
    }
  | {
      outcome: "applied";
      figures: WorkPartyCorrectionFigures;
      settlementOptions: WorkPartySettlementOptions;
      bookingModificationId: string | null;
      followUpFailed?: boolean;
    };

export type WorkPartyCorrectionMode =
  | { dryRun: true; expectedFigures?: never }
  | { dryRun: false; expectedFigures: WorkPartyCorrectionFigures };

/**
 * Every money figure the officer sees, and how it settles; any that moved
 * refuses the save — a changed method too (#129), so a save is never refunded
 * where the officer was shown credit, or the reverse.
 */
const FIGURE_KEYS = [
  "newFinalPriceCents",
  "priceDiffCents",
  "accountCreditAmountCents",
  "appliedCreditGivenBackCents",
  "refundedExcessCreditCents",
  "additionalAmountCents",
  "refundAmountCents",
  "settlementMethod",
] as const satisfies ReadonlyArray<keyof WorkPartyCorrectionFigures>;

/** What both directions take. */
export type WorkPartyCorrectionParams = {
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
} & WorkPartyCorrectionMode;

export function addBookingToWorkParty(
  params: WorkPartyCorrectionParams & {
    /**
     * The officer's choice (#129 decision 1); absent means the default — club
     * credit, or the organiser's disposition. `card` is refused (409) unless
     * `workPartySettlementOptions` offers it.
     */
    settlementMethod?: BookingModificationSettlementMethod;
  },
): Promise<WorkPartyCorrectionResult> {
  return correctWorkParty("add", params);
}

/**
 * #130 (owner, 16 Nov 2026): Add with the work party's code left out. The
 * difference is owed like any price rise (paid: the ordinary additional ask,
 * `INV-ADDPAY`); credit given and refunds paid are left alone.
 */
export function removeBookingFromWorkParty(
  params: WorkPartyCorrectionParams,
): Promise<WorkPartyCorrectionResult> {
  return correctWorkParty("remove", params);
}

export const WORK_PARTY_REMOVAL_MONEY_BACK_MESSAGE =
  "Removing the work party would hand money back, so it can't be done here.";

async function correctWorkParty(
  direction: "add" | "remove",
  params: WorkPartyCorrectionParams & { settlementMethod?: BookingModificationSettlementMethod },
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
          memberId: true,
          finalPriceCents: true,
          organiserSettled: true,
          parentBookingId: true,
          payment: {
            select: { status: true, amountCents: true, creditAppliedCents: true, source: true },
          },
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
      const ownerMemberId = bookingOwner(booking).memberId;
      const quotePriced = await isQuotePricedBooking(tx, params.bookingId);
      const today = dateOnlyInstantOf(params.todayAtClub);
      const eligibility =
        direction === "add"
          ? workPartyBookingEligibility(
              {
                status: booking.status,
                checkIn: booking.checkIn,
                checkOut: booking.checkOut,
                hasWorkParty: redemptions.some((row) => row.promoCode?.workPartyEvent),
                hasOtherPromoCode: redemptions.some((row) => row.promoCode && !row.promoCode.workPartyEvent),
                quotePriced,
                memberOwned: Boolean(ownerMemberId),
              },
              { bookingLodgeId, today, multiPromoCodes: await multiPromoCodesEnabled(tx) },
              event,
            )
          : workPartyRemovalEligibility(
              {
                status: booking.status,
                checkOut: booking.checkOut,
                quotePriced,
                workPartyEventId:
                  redemptions.find((row) => row.promoCode?.workPartyEvent)?.promoCode?.workPartyEvent?.id ?? null,
              },
              { today },
              params.workPartyEventId,
            );
      if (!eligibility.ok) throw new ApiError(eligibility.reason, 409);

      // (4) The canonical edit, on THIS transaction. Add: the booking's codes in
      // their order, then the work party's (the promotion engine applies an
      // internal code first regardless). Remove (#130): the booking's codes
      // without the work party's. Its refusals throw and roll back. An Add's
      // settlement is the officer's choice among those offered (#129); a
      // refund it picks is the pipeline's own ordinary settlement. A Remove
      // hands nothing back, so it carries no settlement method.
      const settlementOptions = workPartySettlementOptions(booking);
      const settlementMethod =
        direction === "add" ? resolveWorkPartySettlementMethod(settlementOptions, params.settlementMethod) : null;
      const keptCodes = redemptions.flatMap((row) =>
        row.promoCode && row.promoCode.code !== event.promoCode.code ? [{ code: row.promoCode.code }] : [],
      );
      const modified = await modifyBookingBatch({
        bookingId: params.bookingId,
        actor: { id: params.actorMemberId, role: "ADMIN" },
        input: {
          promoCodes: direction === "add" ? [...keptCodes, { code: event.promoCode.code }] : keptCodes,
          ...(settlementMethod === null ? {} : { settlementMethod }),
          ...(params.notifyMember === undefined ? {} : { notifyMember: params.notifyMember }),
        },
        ipAddress: params.ipAddress,
        todayAtClub: params.todayAtClub,
        format: params.format,
        tx,
        preTransaction: params.preTransaction,
        officerWorkPartyCorrection: {
          workPartyEventId: params.workPartyEventId,
          promoCodeId: event.promoCode.id,
          direction,
        },
      });

      // (5) The change must actually have happened, in its one direction. A
      // stay that has finished, or any path that ran no promotion, refuses
      // here rather than saving a silent no-op.
      const onBooking = await tx.promoRedemption.findFirst({
        where: { bookingId: params.bookingId, promoCodeId: event.promoCode.id },
        select: { id: true },
      });
      if (modified.promoChangeNotApplied || Boolean(onBooking) !== (direction === "add")) {
        throw new ApiError(
          modified.promoChangeNotApplied?.message ??
            (direction === "add"
              ? "The work party discount could not be applied to this booking."
              : "The work party discount could not be removed from this booking."),
          409,
        );
      }
      if (direction === "add" ? modified.priceDiffCents > 0 : modified.priceDiffCents < 0) {
        throw new ApiError(
          direction === "add"
            ? "Adding the work party would raise this booking's price."
            : "Removing the work party would lower this booking's price.",
          409,
        );
      }

      const figures: WorkPartyCorrectionFigures = {
        previousFinalPriceCents: booking.finalPriceCents,
        newFinalPriceCents: modified.booking.finalPriceCents,
        priceDiffCents: modified.priceDiffCents,
        accountCreditAmountCents: modified.accountCreditAmountCents,
        appliedCreditGivenBackCents: modified.appliedCreditGivenBackCents,
        refundedExcessCreditCents: modified.refundedExcessCreditCents,
        additionalAmountCents: modified.additionalAmountCents,
        refundAmountCents: modified.refundAmountCents,
        settlementMethod,
      };
      if (direction === "remove") {
        // #130: the money goes one way. Anything handed back is a path the
        // plan missed; refuse rather than pay it. So the own/family rule (#129
        // decision 6), which guards money coming back, has nothing to refuse.
        if (workPartyMoneyBackCents(figures) > 0 || figures.refundAmountCents > 0) {
          throw new ApiError(WORK_PARTY_REMOVAL_MONEY_BACK_MESSAGE, 409);
        }
      } else {
        // #129: a refund only where it was meant — the officer chose the card
        // (`resolveWorkPartySettlementMethod` admits `card` only where offered),
        // or the organiser's money goes back to them. Any other refund is a path
        // the options missed; refuse rather than pay it.
        const refundExpected = settlementOptions.paidByOrganiser || settlementMethod === "card";
        if (figures.refundAmountCents > 0 && !refundExpected) {
          throw new ApiError("This booking's change would be refunded, not credited, so it can't be added here.", 409);
        }
        // #129 decision 6, decided on the figures so the preview refuses too:
        // who any money back goes to — the owner, or for an organiser-paid
        // joiner the group organiser — and whether that is the officer or their
        // family, from fresh family rows under the locks.
        const recipientMemberId = settlementOptions.paidByOrganiser && booking.parentBookingId
          ? bookingOwner(
              await tx.booking.findUniqueOrThrow({
                where: { id: booking.parentBookingId },
                select: { memberId: true },
              }),
            ).memberId
          : ownerMemberId;
        const ownMoneyBack = workPartyOwnMoneyBackRefusal(
          figures,
          await actorIsMemberOrFamily(tx, recipientMemberId, params.actorMemberId),
        );
        if (ownMoneyBack) throw new ApiError(ownMoneyBack, 409);
      }
      if (params.dryRun) throw new WorkPartyCorrectionDryRun(figures, settlementOptions);

      // (6) Only what the officer was shown (#4030 C4). A throw rolls it all back.
      const expected = params.expectedFigures;
      if (FIGURE_KEYS.some((key) => expected[key] !== figures[key])) {
        throw new WorkPartyCorrectionFiguresChangedError(figures);
      }

      deferredPostCommit = modified.deferredPostCommit ?? null;
      return {
        outcome: "applied",
        figures,
        settlementOptions,
        bookingModificationId: modified.bookingModificationId ?? null,
      };
    })
    .catch((error: unknown) => {
      if (error instanceof WorkPartyCorrectionDryRun) {
        return {
          outcome: "quoted" as const,
          figures: error.figures,
          settlementOptions: error.settlementOptions,
        };
      }
      throw error;
    });

  // (7) After commit: the edit's own follow-up work (emails, Xero dispatch).
  if (result.outcome === "applied" && deferredPostCommit) {
    try {
      await (deferredPostCommit as () => Promise<void>)();
    } catch (error) {
      logger.error(
        { err: error, bookingId: params.bookingId, direction },
        "Booking work party changed, but post-commit follow-up work failed",
      );
      return { ...result, followUpFailed: true };
    }
  }
  return result;
}
