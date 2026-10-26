import { describe, expect, it } from "vitest";
import { BookingEventType } from "@prisma/client";

import { resolveBookingNarrative, type NarrativeBooking, type NarrativeEvent } from "@/lib/booking-narrative";
import type { CardShortfallTaskStatuses } from "@/lib/manual-refund-task-settlement-rules";
import { bindClubTime, requireClubTimeZone } from "@/lib/club-time";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { cancelCardRefundEventReason } from "@/lib/cancel-card-refund-event-reason";

/**
 * #4097 (`INV-PAY-129`): the booking page's narrative for a card cancel whose
 * card refund plan carried less than the refund due. The CANCELLED snapshot
 * freezes the card's part and the two parts beside it; the page hands over the
 * tasks' live status, and the sentence follows each part: owed, refunded by
 * bank transfer, or checked and closed.
 *
 * MUTATION PROOF. Drop the `cardShortfall` branch and every case below reads
 * "$100.00 was refunded"; read the bank part's status for the check part (or
 * the other way round) and the mixed case fails.
 */
const CLUB = bindClubTime(requireClubTimeZone("Pacific/Auckland"), CLUB_FORMAT_TEST);

const BOOKING: NarrativeBooking = {
  status: "CANCELLED",
  finalPriceCents: 12000,
  amountOwed: { owedCents: 0, dueCents: 0, appliedCreditCents: 0 },
  checkIn: new Date("2026-08-01T00:00:00.000Z"),
  checkOut: new Date("2026-08-03T00:00:00.000Z"),
  firstName: "Sam",
  adminReviewStatus: null,
  adminReviewNotes: null,
  adminReviewReason: null,
};

function event(type: BookingEventType, occurredAt: string, extra: Partial<NarrativeEvent> = {}): NarrativeEvent {
  return { type, occurredAt: new Date(occurredAt), amountCents: null, reason: null, snapshot: null, ...extra };
}

/** The card part's REFUNDED event, as the close that made it writes it (#4145). */
function cardRefunded(occurredAt: string, cardCents: number): NarrativeEvent {
  return event(BookingEventType.REFUNDED, occurredAt, {
    amountCents: cardCents,
    reason: cancelCardRefundEventReason({ cardRefundCents: cardCents, policy: { refundPercentage: 100, refundAmountCents: 10000 }, shortfall: true, format: CLUB_FORMAT_TEST }),
  });
}

function narrate(
  parts: { cardCents: number; bankCents: number; checkCents: number },
  statuses: CardShortfallTaskStatuses,
  settlements: NarrativeEvent[] = parts.cardCents > 0 ? [cardRefunded("2026-05-05T01:00:00.000Z", parts.cardCents)] : [],
) {
  const events = [
    event(BookingEventType.MEMBER_PAID, "2026-05-02T00:00:00.000Z", { amountCents: 12000 }),
    event(BookingEventType.CANCELLED, "2026-05-05T00:00:00.000Z", {
      amountCents: 12000,
      snapshot: {
        policySummary: "Cancelled 30 day(s) before check-in: 100% card refund under the policy in effect at the time.",
        refundMethod: "card",
        refundPercentage: 100,
        paidAmountCents: 12000,
        settledAmountCents: 10000,
        retainedAmountCents: 2000,
        changeFeeCents: 0,
        cardShortfall: parts,
      },
    }),
    ...settlements,
  ];
  return resolveBookingNarrative({ club: CLUB, booking: BOOKING, events, cardShortfallStatuses: statuses }, CLUB_FORMAT_TEST).message;
}

const LEAD = "You cancelled this booking on 5 May 2026 after paying $120.00 on 2 May 2026. Under the cancellation policy in effect at the time, ";

describe("#4097: the booking page names each part of a card refund shortfall and where it stands", () => {
  it.each([
    ["owed", "OPEN", "$40.00 is being refunded to you by bank transfer"],
    ["paid back", "COMPLETED", "$40.00 was refunded to you by bank transfer"],
    ["dismissed", "DISMISSED", "the club has recorded the $40.00 as settled"],
  ] as const)("the bank-transfer part, %s", (_label, status, clause) => {
    expect(narrate({ cardCents: 6000, bankCents: 4000, checkCents: 0 }, { bank: status })).toBe(
      `${LEAD}$60.00 was refunded to your card on 5 May 2026, ${clause} and $20.00 was retained. No further payment is required.`,
    );
  });

  it.each([
    ["owed", "OPEN", "the club will be in touch about the remaining $40.00"],
    ["paid back", "COMPLETED", "$40.00 was refunded to you by bank transfer"],
    ["checked", "DISMISSED", "the club checked the remaining $40.00 and closed it"],
  ] as const)("the part to check, %s", (_label, status, clause) => {
    expect(narrate({ cardCents: 6000, bankCents: 0, checkCents: 4000 }, { check: status })).toBe(
      `${LEAD}$60.00 was refunded to your card on 5 May 2026, ${clause} and $20.00 was retained. No further payment is required.`,
    );
  });

  it.each([
    ["still on its way", "on-its-way", "$60.00 is on its way to your original payment method"],
    ["paid back another way", "paid-another-way", "$60.00 could not go back to your card and was paid back to you another way"],
    ["settled", "settled", "$60.00 was refunded to your card on 5 May 2026"],
  ] as const)("MUTATION: the card's part, %s, as its own refund stands", (_label, card, clause) => {
    expect(narrate({ cardCents: 6000, bankCents: 4000, checkCents: 0 }, { bank: "OPEN", card })).toBe(
      `${LEAD}${clause}, $40.00 is being refunded to you by bank transfer and $20.00 was retained. No further payment is required.`,
    );
  });

  // #4125: a card part whose retries have stopped is the club's to follow up, never "on its way".
  it("MUTATION: the card's part, stalled, says the club will be in touch about it", () => {
    const message = narrate({ cardCents: 6000, bankCents: 4000, checkCents: 0 }, { bank: "OPEN", card: "stalled" });
    expect(message).toBe(
      `${LEAD}$60.00 is being refunded to you, $40.00 is being refunded to you by bank transfer and $20.00 was retained; the club will be in touch about the card refund. No further payment is required.`,
    );
    expect(message).not.toContain("on its way");
  });

  it("a stalled card part with no card refund carried names no card refund", () => {
    expect(narrate({ cardCents: 0, bankCents: 10000, checkCents: 0 }, { bank: "OPEN", card: "stalled" })).not.toContain("card refund");
  });

  it("a zero plan's part to check is the whole refund, never 'the remaining'", () => {
    expect(narrate({ cardCents: 0, bankCents: 0, checkCents: 10000 }, { check: "OPEN" })).toBe(
      `${LEAD}the club will be in touch about the $100.00 refund and $20.00 was retained. No further payment is required.`,
    );
  });

  it("both parts follow their own task, and a zero plan names no card refund", () => {
    expect(narrate({ cardCents: 0, bankCents: 3000, checkCents: 7000 }, { bank: "COMPLETED", check: "OPEN" })).toBe(
      `${LEAD}$30.00 was refunded to you by bank transfer, the club will be in touch about the remaining $70.00 and $20.00 was retained. No further payment is required.`,
    );
  });

  // #4145: the card part's REFUNDED event is written by the close that made it -
  // the runner's, when the inline refund failed - so a bank part paid back by
  // hand in the meantime records its own REFUNDED first. The card's date is its
  // own event's, never the hand-back's.
  it("MUTATION: dates the card's part by its own event when a bank part was paid back first", () => {
    const bankPaid = event(BookingEventType.REFUNDED, "2026-05-07T01:00:00.000Z", { amountCents: 4000, reason: "manual_refund_completed" });
    expect(narrate({ cardCents: 6000, bankCents: 4000, checkCents: 0 }, { bank: "COMPLETED", card: "settled" }, [bankPaid, cardRefunded("2026-05-09T01:00:00.000Z", 6000)])).toBe(
      `${LEAD}$60.00 was refunded to your card on 9 May 2026, $40.00 was refunded to you by bank transfer and $20.00 was retained. No further payment is required.`,
    );
  });

  it("a card part still on its way says so beside a bank part already paid back, with no date of the hand-back's", () => {
    const bankPaid = event(BookingEventType.REFUNDED, "2026-05-07T01:00:00.000Z", { amountCents: 4000, reason: "manual_refund_completed" });
    expect(narrate({ cardCents: 6000, bankCents: 4000, checkCents: 0 }, { bank: "COMPLETED", card: "on-its-way" }, [bankPaid])).toBe(
      `${LEAD}$60.00 is on its way to your original payment method, $40.00 was refunded to you by bank transfer and $20.00 was retained. No further payment is required.`,
    );
    // Closed with no event of its own (a row closed before #4145): made, undated.
    expect(narrate({ cardCents: 6000, bankCents: 4000, checkCents: 0 }, { bank: "COMPLETED", card: "settled" }, [bankPaid])).toContain(
      "$60.00 was refunded to your card, $40.00 was refunded",
    );
  });

  it("with no status handed over, each part reads as still owed", () => {
    expect(narrate({ cardCents: 6000, bankCents: 4000, checkCents: 0 }, {})).toContain("$40.00 is being refunded to you by bank transfer");
  });
});
