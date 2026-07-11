import { describe, expect, it } from "vitest";
import {
  addDaysDateOnly,
  formatDateOnly,
  getTodayDateOnly,
} from "@/lib/date-only";
import {
  buildAdditionalOwedWhere,
  buildUnpaidFinishedStaysHref,
  buildUnpaidFinishedStaysWhere,
  buildUnsettledAdditionalFinishedStaysHref,
  buildUnsettledAdditionalFinishedStaysWhere,
} from "@/lib/unpaid-finished-stays";

// Shared predicate/deep link for the dashboard attention card (#1709) and the
// sidebar Needs Attention badge (#1731). If one of these assertions fails, the
// queue definition changed — update every consuming surface (and its docs)
// together.
describe("unpaid finished stays helpers", () => {
  it("matches non-deleted PAYMENT_PENDING bookings with check-out on or before the given day", () => {
    const today = getTodayDateOnly();

    expect(buildUnpaidFinishedStaysWhere(today)).toEqual({
      deletedAt: null,
      status: "PAYMENT_PENDING",
      checkOut: { lte: today },
    });
  });

  it("keeps the cutoff inclusive of the given day only", () => {
    const today = getTodayDateOnly();
    const where = buildUnpaidFinishedStaysWhere(today);
    const cutoff = (where.checkOut as { lte: Date }).lte;

    // A stay checking out today is finished; tomorrow's is not yet.
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(today.getTime());
    expect(cutoff.getTime()).toBeLessThan(
      addDaysDateOnly(today, 1).getTime(),
    );
  });

  it("builds the bookings-list deep link both surfaces share", () => {
    const todayKey = formatDateOnly(getTodayDateOnly());

    expect(buildUnpaidFinishedStaysHref(todayKey)).toBe(
      `/admin/bookings?status=PAYMENT_PENDING&checkOutTo=${todayKey}`,
    );
  });
});

// Sibling queue (#1723 path 2): settled stays whose upward modification delta
// was never collected on the card additional-payment flow. Same drift rule as
// above — the dashboard card, the sidebar badge, and the bookings-list
// `additionalOwed` filter all share these helpers; if an assertion here fails,
// update every consuming surface (and its docs) together.
describe("unsettled finished-stay additions helpers", () => {
  it("matches settled bookings whose latest additional payment never succeeded", () => {
    // Mirrors the member-facing owed predicate (member dashboard / booking
    // detail): additionalAmountCents > 0 with additionalPaymentStatus not
    // SUCCEEDED — PENDING, FAILED, or null on legacy rows all count as owed.
    // PAYMENT_PENDING is deliberately absent from the status set so this
    // queue stays disjoint from the primary predicate above (the two counts
    // can be summed without double-counting a booking).
    expect(buildAdditionalOwedWhere()).toEqual({
      status: { in: ["CONFIRMED", "PAID", "COMPLETED"] },
      payment: {
        is: {
          additionalAmountCents: { gt: 0 },
          OR: [
            { additionalPaymentStatus: null },
            { additionalPaymentStatus: { not: "SUCCEEDED" } },
          ],
        },
      },
    });
  });

  it("scopes the queue to non-deleted bookings checked out on or before the given day", () => {
    const today = getTodayDateOnly();

    expect(buildUnsettledAdditionalFinishedStaysWhere(today)).toEqual({
      deletedAt: null,
      checkOut: { lte: today },
      ...buildAdditionalOwedWhere(),
    });
  });

  it("stays disjoint from the primary unpaid-finished-stays predicate", () => {
    const additionsStatuses = (
      buildAdditionalOwedWhere().status as { in: string[] }
    ).in;
    const primaryStatus = buildUnpaidFinishedStaysWhere(
      getTodayDateOnly(),
    ).status;

    expect(additionsStatuses).not.toContain(primaryStatus);
  });

  it("builds the bookings-list deep link both surfaces share", () => {
    const todayKey = formatDateOnly(getTodayDateOnly());

    expect(buildUnsettledAdditionalFinishedStaysHref(todayKey)).toBe(
      `/admin/bookings?additionalOwed=owed&checkOutTo=${todayKey}`,
    );
  });
});
