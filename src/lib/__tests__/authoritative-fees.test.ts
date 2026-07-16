import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  joiningFeeFindFirst: vi.fn(),
  itemMappingFindFirst: vi.fn(),
  accountMappingFindUnique: vi.fn(),
  membershipAnnualFeeFindFirst: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    joiningFee: { findFirst: mocks.joiningFeeFindFirst },
    xeroItemCodeMapping: { findFirst: mocks.itemMappingFindFirst },
    xeroAccountMapping: { findUnique: mocks.accountMappingFindUnique },
    membershipAnnualFee: { findFirst: mocks.membershipAnnualFeeFindFirst },
  },
}));

import {
  FeeScheduleValidationError,
  getEffectiveJoiningFee,
  getEffectiveMembershipAnnualFee,
  scheduleOverlapWhere,
  validateFeeScheduleInput,
} from "@/lib/authoritative-fees";

describe("authoritative fee schedules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.joiningFeeFindFirst.mockResolvedValue(null);
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

  it("resolves the age-tier joining fee row first (no legacy fallback)", async () => {
    mocks.joiningFeeFindFirst.mockResolvedValueOnce({ amountCents: 8800, effectiveFrom: new Date("2026-01-01") });
    await expect(
      getEffectiveJoiningFee({ membershipTypeId: "type-full", ageTier: "ADULT" }, new Date("2026-07-13T00:00:00.000Z")),
    ).resolves.toEqual({ amountCents: 8800, effectiveFrom: "2026-01-01", source: "SCHEDULE" });
    // Age-tier hit means the flat fallback query never runs, and no deprecated
    // mapping/account table is consulted.
    expect(mocks.joiningFeeFindFirst).toHaveBeenCalledTimes(1);
    expect(mocks.itemMappingFindFirst).not.toHaveBeenCalled();
    expect(mocks.accountMappingFindUnique).not.toHaveBeenCalled();
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
      // Components are the invoice lines (#1932, E6), resolved in stable order.
      include: { components: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }] } },
    });
  });

  it("falls back to the flat NULL-tier row (Family type), then to NONE", async () => {
    // No age-tier row, but a flat NULL-tier row exists (the Family flat fee).
    mocks.joiningFeeFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ amountCents: 20000, effectiveFrom: new Date("2026-02-01") });
    await expect(
      getEffectiveJoiningFee({ membershipTypeId: "type-family", ageTier: "ADULT" }),
    ).resolves.toEqual({ amountCents: 20000, effectiveFrom: "2026-02-01", source: "SCHEDULE" });

    // Nothing configured -> NONE (no legacy fallback).
    mocks.joiningFeeFindFirst.mockResolvedValue(null);
    await expect(
      getEffectiveJoiningFee({ membershipTypeId: "type-school", ageTier: "ADULT" }),
    ).resolves.toEqual({ amountCents: null, effectiveFrom: null, source: "NONE" });
  });

  it("exposes the validation error status for API conflict handling", () => {
    expect(new FeeScheduleValidationError("overlap", 409).status).toBe(409);
  });
});
