import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgeTier } from "@prisma/client";

// booking-request.ts creates a PrismaClient at import time; stub it so importing
// the module under test never touches a real database.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { reassignHeldBookingGuests } from "@/lib/booking-request";

function makeTx() {
  return {
    bookingGuest: {
      findMany: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      update: vi.fn().mockResolvedValue({}),
    },
  };
}

const guest = (overrides: Record<string, unknown> = {}) => ({
  firstName: "Tara",
  lastName: "Tester",
  ageTier: AgeTier.ADULT,
  isMember: false,
  memberId: undefined,
  stayStart: new Date("2026-08-01T00:00:00.000Z"),
  stayEnd: new Date("2026-08-03T00:00:00.000Z"),
  priceCents: 5000,
  ...overrides,
});

describe("reassignHeldBookingGuests (issue #1254 bed preservation)", () => {
  let tx: ReturnType<typeof makeTx>;

  beforeEach(() => {
    vi.clearAllMocks();
    tx = makeTx();
  });

  it("updates the existing rows in place (stable ids) when counts match", async () => {
    tx.bookingGuest.findMany.mockResolvedValue([{ id: "g1" }, { id: "g2" }]);

    const result = await reassignHeldBookingGuests(tx as never, "held-1", [
      guest({ priceCents: 3000 }),
      guest({ firstName: "Sam", isMember: true, memberId: "m-1", priceCents: 7000 }),
    ]);

    expect(result).toEqual({ preservedInPlace: true });
    // No destructive delete — that is what preserves BedAllocation / #713 nights /
    // promo targets / chores that cascade off bookingGuest ids.
    expect(tx.bookingGuest.deleteMany).not.toHaveBeenCalled();
    expect(tx.bookingGuest.createMany).not.toHaveBeenCalled();
    expect(tx.bookingGuest.update).toHaveBeenCalledTimes(2);
    expect(tx.bookingGuest.update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { id: "g1" },
        data: expect.objectContaining({ priceCents: 3000, memberId: null }),
      })
    );
    expect(tx.bookingGuest.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { id: "g2" },
        data: expect.objectContaining({ memberId: "m-1", isMember: true }),
      })
    );
  });

  it("falls back to delete+recreate when the row count diverges", async () => {
    tx.bookingGuest.findMany.mockResolvedValue([{ id: "g1" }]);

    const result = await reassignHeldBookingGuests(tx as never, "held-1", [
      guest(),
      guest({ firstName: "Sam" }),
    ]);

    expect(result).toEqual({ preservedInPlace: false });
    expect(tx.bookingGuest.deleteMany).toHaveBeenCalledWith({
      where: { bookingId: "held-1" },
    });
    expect(tx.bookingGuest.createMany).toHaveBeenCalledTimes(1);
    expect(tx.bookingGuest.update).not.toHaveBeenCalled();
  });
});
