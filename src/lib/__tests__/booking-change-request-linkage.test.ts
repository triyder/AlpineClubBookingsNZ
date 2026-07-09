import { describe, expect, it, vi } from "vitest";
import { linkModificationToOutstandingChangeRequest } from "@/lib/booking-change-request-linkage";

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

type MockDb = {
  bookingChangeRequest: {
    findFirst: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
};

function makeDb(overrides?: Partial<MockDb["bookingChangeRequest"]>): MockDb {
  return {
    bookingChangeRequest: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      ...overrides,
    },
  };
}

describe("linkModificationToOutstandingChangeRequest (issue #1668)", () => {
  it("links the most recent APPROVED-unlinked request and returns its id", async () => {
    const db = makeDb();
    db.bookingChangeRequest.findFirst.mockResolvedValue({ id: "req_1" });
    db.bookingChangeRequest.updateMany.mockResolvedValue({ count: 1 });

    const result = await linkModificationToOutstandingChangeRequest(
      db as never,
      "booking_1",
      "mod_1",
    );

    expect(result).toBe("req_1");
    // Only APPROVED + unlinked rows are eligible, newest by reviewedAt.
    expect(db.bookingChangeRequest.findFirst).toHaveBeenCalledWith({
      where: {
        bookingId: "booking_1",
        status: "APPROVED",
        linkedModificationId: null,
      },
      orderBy: { reviewedAt: "desc" },
      select: { id: true },
    });
    // Conditional claim: never overwrite a link written concurrently.
    expect(db.bookingChangeRequest.updateMany).toHaveBeenCalledWith({
      where: { id: "req_1", linkedModificationId: null },
      data: { linkedModificationId: "mod_1" },
    });
  });

  it("returns null and writes nothing when there is no eligible request", async () => {
    const db = makeDb();
    db.bookingChangeRequest.findFirst.mockResolvedValue(null);

    const result = await linkModificationToOutstandingChangeRequest(
      db as never,
      "booking_1",
      "mod_1",
    );

    expect(result).toBeNull();
    expect(db.bookingChangeRequest.updateMany).not.toHaveBeenCalled();
  });

  it("returns null when a concurrent writer linked the request first (0-count claim)", async () => {
    const db = makeDb();
    db.bookingChangeRequest.findFirst.mockResolvedValue({ id: "req_1" });
    db.bookingChangeRequest.updateMany.mockResolvedValue({ count: 0 });

    const result = await linkModificationToOutstandingChangeRequest(
      db as never,
      "booking_1",
      "mod_1",
    );

    expect(result).toBeNull();
  });

  it("swallows errors and returns null (never rolls back a completed move)", async () => {
    const db = makeDb();
    db.bookingChangeRequest.findFirst.mockRejectedValue(new Error("db down"));

    const result = await linkModificationToOutstandingChangeRequest(
      db as never,
      "booking_1",
      "mod_1",
    );

    expect(result).toBeNull();
    expect(db.bookingChangeRequest.updateMany).not.toHaveBeenCalled();
  });
});
