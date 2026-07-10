import { describe, expect, it, vi } from "vitest";
import { linkModificationToOutstandingChangeRequest } from "@/lib/booking-change-request-linkage";

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

type MockDb = {
  bookingChangeRequest: {
    findMany: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
};

function makeDb(): MockDb {
  return {
    bookingChangeRequest: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

const D = (s: string) => new Date(`${s}T00:00:00.000Z`);

/** requestedChanges as POST /api/bookings/[id]/change-requests persists it. */
function dateOnlyRequest(
  id: string,
  requested: { checkIn?: string | null; checkOut?: string | null },
) {
  return {
    id,
    requestedChanges: {
      original: { checkIn: "2026-09-07", checkOut: "2026-09-09" },
      requested: {
        checkIn: requested.checkIn ?? null,
        checkOut: requested.checkOut ?? null,
        addGuests: [],
        guestStayRanges: [],
        removeGuests: [],
        requestedEffectiveDate: null,
      },
    },
  };
}

const APPLIED = {
  appliedCheckIn: D("2026-09-08"),
  appliedCheckOut: D("2026-09-10"),
};

describe("linkModificationToOutstandingChangeRequest (issue #1668)", () => {
  it("links the newest APPROVED-unlinked request whose dates match the applied move", async () => {
    const db = makeDb();
    db.bookingChangeRequest.findMany.mockResolvedValue([
      dateOnlyRequest("req_new", { checkIn: "2026-09-08", checkOut: "2026-09-10" }),
      dateOnlyRequest("req_old", { checkIn: "2026-09-08", checkOut: "2026-09-10" }),
    ]);

    const result = await linkModificationToOutstandingChangeRequest(db as never, {
      bookingId: "booking_1",
      modificationId: "mod_1",
      ...APPLIED,
    });

    expect(result).toBe("req_new");
    // Only APPROVED + unlinked rows are eligible, newest by reviewedAt.
    expect(db.bookingChangeRequest.findMany).toHaveBeenCalledWith({
      where: {
        bookingId: "booking_1",
        status: "APPROVED",
        linkedModificationId: null,
      },
      orderBy: { reviewedAt: "desc" },
      select: { id: true, requestedChanges: true },
    });
    // Conditional claim: never overwrite a link written concurrently.
    expect(db.bookingChangeRequest.updateMany).toHaveBeenCalledTimes(1);
    expect(db.bookingChangeRequest.updateMany).toHaveBeenCalledWith({
      where: { id: "req_new", linkedModificationId: null },
      data: { linkedModificationId: "mod_1" },
    });
  });

  it("skips a request whose dates do not match and links the older one that does", async () => {
    const db = makeDb();
    db.bookingChangeRequest.findMany.mockResolvedValue([
      dateOnlyRequest("req_other_ask", { checkIn: "2026-12-01", checkOut: "2026-12-03" }),
      dateOnlyRequest("req_match", { checkIn: "2026-09-08", checkOut: "2026-09-10" }),
    ]);

    const result = await linkModificationToOutstandingChangeRequest(db as never, {
      bookingId: "booking_1",
      modificationId: "mod_1",
      ...APPLIED,
    });

    expect(result).toBe("req_match");
    expect(db.bookingChangeRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "req_match", linkedModificationId: null } }),
    );
  });

  it("matches a checkOut-only request when the applied check-out equals it", async () => {
    const db = makeDb();
    db.bookingChangeRequest.findMany.mockResolvedValue([
      dateOnlyRequest("req_out_only", { checkOut: "2026-09-10" }),
    ]);

    const result = await linkModificationToOutstandingChangeRequest(db as never, {
      bookingId: "booking_1",
      modificationId: "mod_1",
      ...APPLIED,
    });

    expect(result).toBe("req_out_only");
  });

  it("never links a request that also asks for guest changes (partially fulfilled)", async () => {
    const db = makeDb();
    const withGuests = dateOnlyRequest("req_guests", {
      checkIn: "2026-09-08",
      checkOut: "2026-09-10",
    });
    (
      withGuests.requestedChanges.requested as { addGuests: unknown[] }
    ).addGuests = [{ firstName: "New", lastName: "Guest" }];
    db.bookingChangeRequest.findMany.mockResolvedValue([withGuests]);

    const result = await linkModificationToOutstandingChangeRequest(db as never, {
      bookingId: "booking_1",
      modificationId: "mod_1",
      ...APPLIED,
    });

    expect(result).toBeNull();
    expect(db.bookingChangeRequest.updateMany).not.toHaveBeenCalled();
  });

  it("never links a request that names no dates (effective-date-only marker)", async () => {
    const db = makeDb();
    db.bookingChangeRequest.findMany.mockResolvedValue([
      dateOnlyRequest("req_marker", {}),
    ]);

    const result = await linkModificationToOutstandingChangeRequest(db as never, {
      bookingId: "booking_1",
      modificationId: "mod_1",
      ...APPLIED,
    });

    expect(result).toBeNull();
    expect(db.bookingChangeRequest.updateMany).not.toHaveBeenCalled();
  });

  it("treats a malformed requestedChanges payload as non-matching, not an error", async () => {
    const db = makeDb();
    db.bookingChangeRequest.findMany.mockResolvedValue([
      { id: "req_legacy", requestedChanges: "not-an-object" },
      { id: "req_null", requestedChanges: null },
    ]);

    const result = await linkModificationToOutstandingChangeRequest(db as never, {
      bookingId: "booking_1",
      modificationId: "mod_1",
      ...APPLIED,
    });

    expect(result).toBeNull();
    expect(db.bookingChangeRequest.updateMany).not.toHaveBeenCalled();
  });

  it("falls through to the next matching candidate when a concurrent writer claims the first", async () => {
    const db = makeDb();
    db.bookingChangeRequest.findMany.mockResolvedValue([
      dateOnlyRequest("req_a", { checkIn: "2026-09-08", checkOut: "2026-09-10" }),
      dateOnlyRequest("req_b", { checkIn: "2026-09-08", checkOut: "2026-09-10" }),
    ]);
    db.bookingChangeRequest.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    const result = await linkModificationToOutstandingChangeRequest(db as never, {
      bookingId: "booking_1",
      modificationId: "mod_1",
      ...APPLIED,
    });

    expect(result).toBe("req_b");
  });

  it("returns null and writes nothing when there is no eligible request", async () => {
    const db = makeDb();

    const result = await linkModificationToOutstandingChangeRequest(db as never, {
      bookingId: "booking_1",
      modificationId: "mod_1",
      ...APPLIED,
    });

    expect(result).toBeNull();
    expect(db.bookingChangeRequest.updateMany).not.toHaveBeenCalled();
  });

  it("swallows errors and returns null (never rolls back a completed move)", async () => {
    const db = makeDb();
    db.bookingChangeRequest.findMany.mockRejectedValue(new Error("db down"));

    const result = await linkModificationToOutstandingChangeRequest(db as never, {
      bookingId: "booking_1",
      modificationId: "mod_1",
      ...APPLIED,
    });

    expect(result).toBeNull();
    expect(db.bookingChangeRequest.updateMany).not.toHaveBeenCalled();
  });
});
