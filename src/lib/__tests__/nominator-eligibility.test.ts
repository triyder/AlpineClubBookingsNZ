import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    memberInduction: { count: vi.fn() },
    bookingGuestNight: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

import {
  checkNominatorEligibility,
  evaluateNominatorEligibility,
  monthsBetweenUtc,
  type NominatorEligibilityInput,
} from "@/lib/nominator-eligibility";
import type { MembershipNominationSettings } from "@/lib/membership-nomination-settings";

const baseInput: NominatorEligibilityInput = {
  gateEnabled: true,
  minimumMembershipMonths: 12,
  minimumNights: 6,
  gateEffectiveFrom: null,
  membershipStart: new Date("2024-01-01T00:00:00Z"),
  inducted: true,
  nightsStayed: 10,
  now: new Date("2026-01-01T00:00:00Z"),
};

describe("monthsBetweenUtc", () => {
  it("counts whole months", () => {
    expect(
      monthsBetweenUtc(new Date("2024-01-01Z"), new Date("2026-01-01Z"))
    ).toBe(24);
  });

  it("does not count a partial final month", () => {
    expect(
      monthsBetweenUtc(new Date("2025-01-15Z"), new Date("2026-01-10Z"))
    ).toBe(11);
  });
});

describe("evaluateNominatorEligibility", () => {
  it("is eligible when the gate is disabled", () => {
    const result = evaluateNominatorEligibility({
      ...baseInput,
      gateEnabled: false,
      inducted: false,
      nightsStayed: 0,
    });
    expect(result.eligible).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("grandfathers members who joined before the cutoff", () => {
    const result = evaluateNominatorEligibility({
      ...baseInput,
      gateEffectiveFrom: new Date("2025-06-15T00:00:00Z"),
      membershipStart: new Date("2024-01-01T00:00:00Z"),
      inducted: false,
      nightsStayed: 0,
    });
    expect(result.eligible).toBe(true);
    expect(result.details.grandfathered).toBe(true);
  });

  it("blocks a member whose induction is not signed off", () => {
    const result = evaluateNominatorEligibility({ ...baseInput, inducted: false });
    expect(result.eligible).toBe(false);
    expect(result.reasons.join(" ")).toContain("induction");
  });

  it("blocks a member who has not met the tenure requirement", () => {
    const result = evaluateNominatorEligibility({
      ...baseInput,
      membershipStart: new Date("2025-07-01T00:00:00Z"),
    });
    expect(result.eligible).toBe(false);
    expect(result.details.tenureMet).toBe(false);
  });

  it("blocks a member who has not stayed enough nights", () => {
    const result = evaluateNominatorEligibility({ ...baseInput, nightsStayed: 3 });
    expect(result.eligible).toBe(false);
    expect(result.details.nightsMet).toBe(false);
  });

  it("is eligible when all requirements are met", () => {
    const result = evaluateNominatorEligibility(baseInput);
    expect(result.eligible).toBe(true);
    expect(result.reasons).toEqual([]);
  });
});

describe("checkNominatorEligibility", () => {
  const enabledSettings: MembershipNominationSettings = {
    gateEnabled: true,
    minimumMembershipMonths: 12,
    minimumNights: 6,
    requiredSignOffs: 2,
    gateEffectiveFrom: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips induction/nights lookups when the gate is disabled", async () => {
    const result = await checkNominatorEligibility(
      { id: "m1", joinedDate: null, createdAt: new Date("2026-01-01Z") },
      { ...enabledSettings, gateEnabled: false }
    );
    expect(result.eligible).toBe(true);
    expect(prismaMock.memberInduction.count).not.toHaveBeenCalled();
    expect(prismaMock.bookingGuestNight.findMany).not.toHaveBeenCalled();
  });

  it("blocks when not inducted and short on nights", async () => {
    prismaMock.memberInduction.count.mockResolvedValue(0);
    prismaMock.bookingGuestNight.findMany.mockResolvedValue([]);
    const result = await checkNominatorEligibility(
      { id: "m1", joinedDate: new Date("2020-01-01Z"), createdAt: new Date("2020-01-01Z") },
      enabledSettings
    );
    expect(result.eligible).toBe(false);
    expect(result.details.inductionComplete).toBe(false);
    expect(result.details.nightsMet).toBe(false);
  });

  it("is eligible when inducted, long-tenured, and well-stayed", async () => {
    prismaMock.memberInduction.count.mockResolvedValue(1);
    prismaMock.bookingGuestNight.findMany.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => ({ stayDate: new Date(2025, 0, i + 1) }))
    );
    const result = await checkNominatorEligibility(
      { id: "m1", joinedDate: new Date("2020-01-01Z"), createdAt: new Date("2020-01-01Z") },
      enabledSettings
    );
    expect(result.eligible).toBe(true);
  });
});
