import { describe, expect, it, vi } from "vitest";
import {
  LodgeBookingEligibilityError,
  assertMemberMayBookLodge,
  getStaffLodgeBinding,
  isMemberEligibleToBookLodge,
} from "@/lib/lodge-access";

function dbWithRestrictions(rows: { lodgeId: string }[]) {
  // Minimal delegate mock: these functions only ever call memberLodgeAccess.findMany.
  return {
    memberLodgeAccess: {
      findMany: vi.fn().mockResolvedValue(rows),
    },
  } as unknown as Parameters<typeof assertMemberMayBookLodge>[0];
}

describe("isMemberEligibleToBookLodge", () => {
  it("is default-open when the member has no BOOKING_RESTRICTION rows", async () => {
    const db = dbWithRestrictions([]);
    const eligible = await isMemberEligibleToBookLodge(
      db,
      "member-1",
      "lodge-1",
    );
    expect(eligible).toBe(true);
    expect(db.memberLodgeAccess.findMany).toHaveBeenCalledWith({
      where: { memberId: "member-1", kind: "BOOKING_RESTRICTION" },
      select: { lodgeId: true },
    });
  });

  it("allows a lodge that is on the member's restriction list", async () => {
    const db = dbWithRestrictions([{ lodgeId: "lodge-1" }, { lodgeId: "lodge-2" }]);
    const eligible = await isMemberEligibleToBookLodge(
      db,
      "member-1",
      "lodge-1",
    );
    expect(eligible).toBe(true);
  });

  it("blocks a lodge that is not on the member's restriction list", async () => {
    const db = dbWithRestrictions([{ lodgeId: "lodge-2" }]);
    const eligible = await isMemberEligibleToBookLodge(
      db,
      "member-1",
      "lodge-1",
    );
    expect(eligible).toBe(false);
  });
});

describe("assertMemberMayBookLodge", () => {
  it("throws a 403 LodgeBookingEligibilityError when the member is restricted", async () => {
    const db = dbWithRestrictions([{ lodgeId: "lodge-2" }]);

    let caught: unknown;
    try {
      await assertMemberMayBookLodge(db, {
        memberId: "member-1",
        lodgeId: "lodge-1",
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(LodgeBookingEligibilityError);
    expect((caught as LodgeBookingEligibilityError).status).toBe(403);
  });

  it("does not throw when the member is eligible", async () => {
    const db = dbWithRestrictions([]);
    await expect(
      assertMemberMayBookLodge(db, { memberId: "member-1", lodgeId: "lodge-1" }),
    ).resolves.toBeUndefined();
  });

  it("bypasses the restriction when isOnBehalf is true", async () => {
    const db = dbWithRestrictions([{ lodgeId: "lodge-2" }]);
    await expect(
      assertMemberMayBookLodge(db, {
        memberId: "member-1",
        lodgeId: "lodge-1",
        isOnBehalf: true,
      }),
    ).resolves.toBeUndefined();
    expect(db.memberLodgeAccess.findMany).not.toHaveBeenCalled();
  });
});

describe("getStaffLodgeBinding", () => {
  it("returns the lodge id for exactly one STAFF grant", async () => {
    const db = {
      memberLodgeAccess: {
        findMany: vi.fn().mockResolvedValue([{ lodgeId: "lodge-1" }]),
      },
    };
    const binding = await getStaffLodgeBinding(
      db as unknown as Parameters<typeof getStaffLodgeBinding>[0],
      "member-1",
    );
    expect(binding).toBe("lodge-1");
    expect(db.memberLodgeAccess.findMany).toHaveBeenCalledWith({
      where: { memberId: "member-1", kind: "STAFF" },
      select: { lodgeId: true },
      take: 2,
    });
  });

  it("returns null when there are zero STAFF grants", async () => {
    const db = {
      memberLodgeAccess: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const binding = await getStaffLodgeBinding(
      db as unknown as Parameters<typeof getStaffLodgeBinding>[0],
      "member-1",
    );
    expect(binding).toBeNull();
  });

  it("returns null when there are two or more STAFF grants", async () => {
    const db = {
      memberLodgeAccess: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ lodgeId: "lodge-1" }, { lodgeId: "lodge-2" }]),
      },
    };
    const binding = await getStaffLodgeBinding(
      db as unknown as Parameters<typeof getStaffLodgeBinding>[0],
      "member-1",
    );
    expect(binding).toBeNull();
  });
});
