import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  getDefaultMembershipNominationSettings,
  normalizeMembershipNominationSettings,
} from "@/lib/membership-nomination-settings";

describe("membership nomination settings", () => {
  it("provides sensible defaults", () => {
    expect(getDefaultMembershipNominationSettings()).toEqual({
      gateEnabled: false,
      minimumMembershipMonths: 12,
      minimumNights: 6,
      requiredSignOffs: 2,
      gateEffectiveFrom: null,
    });
  });

  it("falls back to defaults when nothing is persisted", () => {
    expect(normalizeMembershipNominationSettings(null)).toEqual(
      getDefaultMembershipNominationSettings()
    );
  });

  it("clamps counts to safe minimums", () => {
    const normalized = normalizeMembershipNominationSettings({
      gateEnabled: true,
      minimumMembershipMonths: -5,
      minimumNights: -1,
      requiredSignOffs: 0,
      gateEffectiveFrom: null,
    });
    expect(normalized.gateEnabled).toBe(true);
    expect(normalized.minimumMembershipMonths).toBe(0);
    expect(normalized.minimumNights).toBe(0);
    expect(normalized.requiredSignOffs).toBe(1);
  });

  it("parses the grandfather cutoff date and rejects invalid dates", () => {
    const valid = normalizeMembershipNominationSettings({
      gateEffectiveFrom: "2026-06-15T00:00:00.000Z",
    });
    expect(valid.gateEffectiveFrom).toBeInstanceOf(Date);

    const invalid = normalizeMembershipNominationSettings({
      gateEffectiveFrom: "not-a-date",
    });
    expect(invalid.gateEffectiveFrom).toBeNull();
  });
});
