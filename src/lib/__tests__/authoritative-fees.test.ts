import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  entranceFeeFindFirst: vi.fn(),
  itemMappingFindFirst: vi.fn(),
  accountMappingFindUnique: vi.fn(),
  membershipAnnualFeeFindFirst: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    entranceFee: { findFirst: mocks.entranceFeeFindFirst },
    xeroItemCodeMapping: { findFirst: mocks.itemMappingFindFirst },
    xeroAccountMapping: { findUnique: mocks.accountMappingFindUnique },
    membershipAnnualFee: { findFirst: mocks.membershipAnnualFeeFindFirst },
  },
}));

import {
  FeeScheduleValidationError,
  getEffectiveEntranceFee,
  getEffectiveMembershipAnnualFee,
  scheduleOverlapWhere,
  validateFeeScheduleInput,
} from "@/lib/authoritative-fees";

describe("authoritative fee schedules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.entranceFeeFindFirst.mockResolvedValue(null);
    mocks.itemMappingFindFirst.mockResolvedValue(null);
    mocks.accountMappingFindUnique.mockResolvedValue(null);
    mocks.membershipAnnualFeeFindFirst.mockResolvedValue(null);
  });

  it("accepts inclusive single-day boundaries and preserves integer cents", () => {
    const result = validateFeeScheduleInput({
      amountCents: 12345,
      effectiveFrom: "2026-07-13",
      effectiveTo: "2026-07-13",
    });
    expect(result.amountCents).toBe(12345);
    expect(result.effectiveFrom.toISOString()).toContain("2026-07-13");
    expect(result.effectiveTo?.toISOString()).toContain("2026-07-13");
  });

  it.each([
    [{ amountCents: 12.5, effectiveFrom: "2026-07-13" }, "integer"],
    [{ amountCents: -1, effectiveFrom: "2026-07-13" }, "non-negative"],
    [{ amountCents: 0, effectiveFrom: "2026-02-30" }, "valid YYYY-MM-DD"],
    [{ amountCents: 0, effectiveFrom: "2026-07-14", effectiveTo: "2026-07-13" }, "cannot be before"],
    [{ amountCents: 1, effectiveFrom: "2026-07-13", billingBasis: "NO_INVOICE" as const }, "zero-cent"],
  ])("rejects invalid money and date input", (input, message) => {
    expect(() => validateFeeScheduleInput(input)).toThrow(message);
  });

  it("builds an inclusive overlap predicate and excludes the edited row", () => {
    const from = new Date("2026-07-01T00:00:00.000Z");
    const to = new Date("2026-07-31T00:00:00.000Z");
    expect(scheduleOverlapWhere({ effectiveFrom: from, effectiveTo: to, excludeId: "fee-1" })).toEqual({
      id: { not: "fee-1" },
      effectiveFrom: { lte: to },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: from } }],
    });
  });

  it("uses the current authoritative schedule before deprecated mappings", async () => {
    mocks.entranceFeeFindFirst.mockResolvedValue({ amountCents: 8800 });
    await expect(getEffectiveEntranceFee("ADULT", new Date("2026-07-13T00:00:00.000Z"))).resolves.toEqual({
      amountCents: 8800,
      source: "SCHEDULE",
    });
    expect(mocks.itemMappingFindFirst).not.toHaveBeenCalled();
  });

  it("resolves a membership fee on inclusive effective boundaries", async () => {
    const asOf = new Date("2026-07-13T00:00:00.000Z");
    mocks.membershipAnnualFeeFindFirst.mockResolvedValue({ id: "mf-1", amountCents: 10000 });
    await expect(getEffectiveMembershipAnnualFee("full", asOf)).resolves.toMatchObject({ id: "mf-1" });
    expect(mocks.membershipAnnualFeeFindFirst).toHaveBeenCalledWith({
      where: {
        membershipTypeId: "full",
        effectiveFrom: { lte: asOf },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: asOf } }],
      },
      orderBy: { effectiveFrom: "desc" },
    });
  });

  it("retains granular then flat mapping fallback for one compatibility release", async () => {
    mocks.itemMappingFindFirst.mockResolvedValueOnce({ amountCents: 7500 }).mockResolvedValueOnce(null);
    mocks.accountMappingFindUnique.mockResolvedValue({ code: "6400" });
    await expect(getEffectiveEntranceFee("YOUTH")).resolves.toEqual({ amountCents: 7500, source: "LEGACY_MAPPING" });
    await expect(getEffectiveEntranceFee("CHILD")).resolves.toEqual({ amountCents: 6400, source: "LEGACY_MAPPING" });
  });

  it("exposes the validation error status for API conflict handling", () => {
    expect(new FeeScheduleValidationError("overlap", 409).status).toBe(409);
  });
});
