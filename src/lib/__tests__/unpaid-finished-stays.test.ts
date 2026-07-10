import { describe, expect, it } from "vitest";
import {
  addDaysDateOnly,
  formatDateOnly,
  getTodayDateOnly,
} from "@/lib/date-only";
import {
  buildUnpaidFinishedStaysHref,
  buildUnpaidFinishedStaysWhere,
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
