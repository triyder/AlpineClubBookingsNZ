import { describe, it, expect } from "vitest";
import { validateMembershipTypeSeasonRates } from "@/lib/season-rate-editor";

// The season rate editor may only write rows for rate-bearing membership types:
// every MEMBER_RATE type plus the built-in NON_MEMBER type (#1930, E4, D2).

const TYPES = [
  { id: "mt-full", key: "FULL", bookingBehavior: "MEMBER_RATE" },
  { id: "mt-life", key: "LIFE", bookingBehavior: "MEMBER_RATE" },
  { id: "mt-nonmember", key: "NON_MEMBER", bookingBehavior: "NON_MEMBER_RATE" },
  { id: "mt-associate", key: "ASSOCIATE", bookingBehavior: "NON_MEMBER_RATE" },
  { id: "mt-block", key: "BLOCKED", bookingBehavior: "BLOCK_BOOKING" },
];

function makeDb() {
  return {
    membershipType: {
      findMany: async (args: { where: { id: { in: string[] } } }) =>
        TYPES.filter((t) => args.where.id.in.includes(t.id)),
    },
  };
}

describe("validateMembershipTypeSeasonRates (#1930, E4)", () => {
  it("accepts MEMBER_RATE types and the built-in NON_MEMBER type", async () => {
    const error = await validateMembershipTypeSeasonRates(makeDb(), [
      { membershipTypeId: "mt-full", ageTier: "ADULT", pricePerNightCents: 1000 },
      { membershipTypeId: "mt-life", ageTier: null, pricePerNightCents: 900 },
      { membershipTypeId: "mt-nonmember", ageTier: "ADULT", pricePerNightCents: 2400 },
    ]);
    expect(error).toBeNull();
  });

  it("rejects a NON_MEMBER_RATE type that is not NON_MEMBER (D2 zero-own-rows)", async () => {
    const error = await validateMembershipTypeSeasonRates(makeDb(), [
      { membershipTypeId: "mt-associate", ageTier: "ADULT", pricePerNightCents: 1000 },
    ]);
    expect(error).toMatch(/does not carry its own hut rates/);
  });

  it("rejects a BLOCK_BOOKING type", async () => {
    const error = await validateMembershipTypeSeasonRates(makeDb(), [
      { membershipTypeId: "mt-block", ageTier: "ADULT", pricePerNightCents: 1000 },
    ]);
    expect(error).toMatch(/does not carry its own hut rates/);
  });

  it("rejects an unknown membership type id", async () => {
    const error = await validateMembershipTypeSeasonRates(makeDb(), [
      { membershipTypeId: "mt-ghost", ageTier: "ADULT", pricePerNightCents: 1000 },
    ]);
    expect(error).toMatch(/Unknown membership type/);
  });

  it("rejects a duplicate (membershipType, ageTier) row", async () => {
    const error = await validateMembershipTypeSeasonRates(makeDb(), [
      { membershipTypeId: "mt-full", ageTier: "ADULT", pricePerNightCents: 1000 },
      { membershipTypeId: "mt-full", ageTier: "ADULT", pricePerNightCents: 1100 },
    ]);
    expect(error).toMatch(/Duplicate rate/);
  });
});
