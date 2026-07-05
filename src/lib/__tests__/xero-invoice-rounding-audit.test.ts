import { describe, expect, it, vi } from "vitest";

import {
  computeBookingRoundingDrift,
  computeGuestRoundingDrift,
  countStayNights,
  scanXeroInvoiceRoundingDrift,
  type AuditGuest,
  type RoundingAuditBooking,
  type RoundingAuditPrismaClient,
} from "@/lib/xero-invoice-rounding-audit";

// Date-only UTC-midnight helper so formatDate contiguity is stable.
const day = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

function guest(overrides: Partial<AuditGuest> = {}): AuditGuest {
  return {
    firstName: "Test",
    lastName: "Guest",
    ageTier: "ADULT",
    isMember: true,
    priceCents: 0,
    nights: null,
    ...overrides,
  };
}

describe("computeGuestRoundingDrift (pre-#1231 replay)", () => {
  it("flags a mixed-price contiguous run whose round(total/n) drifts (#1163)", () => {
    // [2500, 2500, 3000] over Jun 1-3 => one contiguous run, total 8000, n=3.
    // round(8000/3)=2667, emitted 3*2667=8001, drift +1. Exactly the #1163 bug.
    const result = computeGuestRoundingDrift(
      guest({
        priceCents: 8000,
        nights: [
          { stayDate: day(2026, 6, 1), priceCents: 2500 },
          { stayDate: day(2026, 6, 2), priceCents: 2500 },
          { stayDate: day(2026, 6, 3), priceCents: 3000 },
        ],
      }),
      3
    );

    expect(result.guestDriftCents).toBe(1);
    expect(result.driftedRuns).toHaveLength(1);
    expect(result.driftedRuns[0]).toMatchObject({
      nightCount: 3,
      totalCents: 8000,
      roundedPerNightCents: 2667,
      emittedTotalCents: 8001,
      driftCents: 1,
      mixedPrices: true,
    });
  });

  it("does NOT flag a clean single-price contiguous run", () => {
    const result = computeGuestRoundingDrift(
      guest({
        priceCents: 9000,
        nights: [
          { stayDate: day(2026, 6, 1), priceCents: 3000 },
          { stayDate: day(2026, 6, 2), priceCents: 3000 },
          { stayDate: day(2026, 6, 3), priceCents: 3000 },
        ],
      }),
      3
    );

    expect(result.guestDriftCents).toBe(0);
    expect(result.driftedRuns).toHaveLength(0);
  });

  it("does NOT flag a mixed-price run that divides evenly (keys on drift, not mixed prices)", () => {
    // [2000, 4000] over 2 nights => total 6000, round(3000)*2 = 6000, drift 0.
    const result = computeGuestRoundingDrift(
      guest({
        priceCents: 6000,
        nights: [
          { stayDate: day(2026, 6, 1), priceCents: 2000 },
          { stayDate: day(2026, 6, 2), priceCents: 4000 },
        ],
      }),
      2
    );

    expect(result.guestDriftCents).toBe(0);
    expect(result.driftedRuns).toHaveLength(0);
  });

  it("does NOT flag non-contiguous single-price runs (each run reconciles)", () => {
    const result = computeGuestRoundingDrift(
      guest({
        priceCents: 10000,
        nights: [
          { stayDate: day(2026, 6, 1), priceCents: 2500 },
          { stayDate: day(2026, 6, 2), priceCents: 2500 },
          // gap
          { stayDate: day(2026, 6, 5), priceCents: 2500 },
          { stayDate: day(2026, 6, 6), priceCents: 2500 },
        ],
      }),
      4
    );

    expect(result.guestDriftCents).toBe(0);
    expect(result.driftedRuns).toHaveLength(0);
  });

  it("flags the legacy flat-total path when priceCents is not divisible by nights", () => {
    // No per-night rows: old builder billed nights * round(priceCents/nights).
    // 8000 over 3 nights => 3 * round(2666.67)=3*2667=8001, drift +1.
    const result = computeGuestRoundingDrift(
      guest({ priceCents: 8000, nights: null }),
      3
    );

    expect(result.guestDriftCents).toBe(1);
    expect(result.driftedRuns).toHaveLength(1);
    expect(result.driftedRuns[0]).toMatchObject({
      nightCount: 3,
      totalCents: 8000,
      emittedTotalCents: 8001,
      driftCents: 1,
    });
  });

  it("does NOT flag a degenerate zero-night legacy stay (old and new emit identically)", () => {
    const result = computeGuestRoundingDrift(
      guest({ priceCents: 8000, nights: null }),
      0
    );
    expect(result.driftedRuns).toHaveLength(0);
  });
});

describe("computeBookingRoundingDrift", () => {
  it("returns null for a clean booking", () => {
    const result = computeBookingRoundingDrift({
      bookingId: "b-clean",
      xeroInvoiceId: "inv-1",
      xeroInvoiceNumber: "INV-1",
      issuedAtProxy: day(2026, 6, 1),
      bookingNights: 2,
      guests: [
        guest({
          priceCents: 6000,
          nights: [
            { stayDate: day(2026, 6, 1), priceCents: 3000 },
            { stayDate: day(2026, 6, 2), priceCents: 3000 },
          ],
        }),
      ],
    });
    expect(result).toBeNull();
  });

  it("returns the aggregated drift for an affected booking", () => {
    const result = computeBookingRoundingDrift({
      bookingId: "b-drift",
      xeroInvoiceId: "inv-2",
      xeroInvoiceNumber: "INV-2",
      issuedAtProxy: day(2026, 6, 1),
      bookingNights: 3,
      guests: [
        guest({
          firstName: "Mixed",
          lastName: "Rates",
          priceCents: 8000,
          nights: [
            { stayDate: day(2026, 6, 1), priceCents: 2500 },
            { stayDate: day(2026, 6, 2), priceCents: 2500 },
            { stayDate: day(2026, 6, 3), priceCents: 3000 },
          ],
        }),
        guest({ firstName: "Clean", lastName: "Guest", priceCents: 9000, nights: null }),
      ],
    });

    expect(result).not.toBeNull();
    expect(result?.totalDriftCents).toBe(1);
    expect(result?.guests).toHaveLength(1); // only the drifting guest is kept
    expect(result?.guests[0].guestName).toBe("Mixed Rates");
  });
});

describe("countStayNights", () => {
  it("counts whole date-only nights", () => {
    expect(countStayNights(day(2026, 6, 1), day(2026, 6, 4))).toBe(3);
    expect(countStayNights(day(2026, 6, 1), day(2026, 6, 1))).toBe(0);
  });
});

describe("scanXeroInvoiceRoundingDrift (read-only)", () => {
  function bookingRow(
    id: string,
    driftGuest: boolean
  ): RoundingAuditBooking {
    return {
      id,
      checkIn: day(2026, 6, 1),
      checkOut: day(2026, 6, 4),
      payment: {
        xeroInvoiceId: `${id}-inv`,
        xeroInvoiceNumber: `INV-${id}`,
        createdAt: day(2026, 6, 1),
      },
      guests: [
        {
          firstName: "Guest",
          lastName: id,
          ageTier: "ADULT",
          isMember: true,
          // drift: [2500,2500,3000] total 8000 over 3 nights -> 3*round(2666.67)=8001.
          // clean: uniform 3000/night total 9000 -> reconciles exactly.
          priceCents: driftGuest ? 8000 : 9000,
          nights: driftGuest
            ? [
                { stayDate: day(2026, 6, 1), priceCents: 2500 },
                { stayDate: day(2026, 6, 2), priceCents: 2500 },
                { stayDate: day(2026, 6, 3), priceCents: 3000 },
              ]
            : [
                { stayDate: day(2026, 6, 1), priceCents: 3000 },
                { stayDate: day(2026, 6, 2), priceCents: 3000 },
                { stayDate: day(2026, 6, 3), priceCents: 3000 },
              ],
        },
      ],
    };
  }

  it("scans issued invoices and flags only the drifting ones", async () => {
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([bookingRow("a", true), bookingRow("c", false)]);
    const client: RoundingAuditPrismaClient = { booking: { findMany } };

    const result = await scanXeroInvoiceRoundingDrift(client, { batchSize: 200 });

    expect(result.scannedInvoices).toBe(2);
    expect(result.affectedCount).toBe(1);
    expect(result.totalDriftCents).toBe(1);
    expect(result.affected[0].bookingId).toBe("a");
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("passes an issued-before cutoff into the query and never mutates", async () => {
    const findMany = vi.fn().mockResolvedValueOnce([]);
    const client: RoundingAuditPrismaClient = { booking: { findMany } };
    const cutoff = day(2026, 7, 4);

    const result = await scanXeroInvoiceRoundingDrift(client, {
      issuedBefore: cutoff,
    });

    expect(result.affectedCount).toBe(0);
    expect(result.issuedBefore).toBe(cutoff.toISOString());
    const call = findMany.mock.calls[0][0];
    expect(call.where.payment.is.xeroInvoiceId).toEqual({ not: null });
    expect(call.where.payment.is.createdAt).toEqual({ lt: cutoff });
    // read-only: the client exposes only findMany.
    expect(Object.keys(client.booking)).toEqual(["findMany"]);
  });

  it("paginates across batches with a cursor", async () => {
    // Full-length batches keep the loop going; a short/empty batch ends it.
    const batch1 = [bookingRow("p0", false), bookingRow("p1", false)];
    const batch2 = [bookingRow("p2", false), bookingRow("last", true)];
    const findMany = vi
      .fn()
      .mockResolvedValueOnce(batch1)
      .mockResolvedValueOnce(batch2)
      .mockResolvedValueOnce([]);
    const client: RoundingAuditPrismaClient = { booking: { findMany } };

    const result = await scanXeroInvoiceRoundingDrift(client, { batchSize: 2 });

    expect(findMany).toHaveBeenCalledTimes(3);
    expect(result.scannedInvoices).toBe(4);
    expect(result.affectedCount).toBe(1);
    // first call has no cursor; later calls carry the previous batch's last id.
    expect(findMany.mock.calls[0][0].cursor).toBeUndefined();
    expect(findMany.mock.calls[1][0].cursor).toEqual({ id: "p1" });
    expect(findMany.mock.calls[1][0].skip).toBe(1);
    expect(findMany.mock.calls[2][0].cursor).toEqual({ id: "last" });
  });
});
