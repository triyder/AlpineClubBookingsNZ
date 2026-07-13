import { describe, expect, it } from "vitest";
import type { AgeTier } from "@prisma/client";
import { canServeMemberPhoneOnLodgeSurface, formatXeroPhone } from "@/lib/phone";

// #125 / #37: the single source of truth for phone visibility on lodge screens.
// The gate is a strict three-way AND with an adults-only floor.
describe("canServeMemberPhoneOnLodgeSurface", () => {
  const base = {
    lodgeShowGuestPhonesOnScreens: true,
    memberOptedIn: true,
    ageTier: "ADULT" as AgeTier,
  };

  it("serves only when config on AND opted in AND adult", () => {
    expect(canServeMemberPhoneOnLodgeSurface(base)).toBe(true);
  });

  it("withholds when the lodge config is off", () => {
    expect(
      canServeMemberPhoneOnLodgeSurface({ ...base, lodgeShowGuestPhonesOnScreens: false })
    ).toBe(false);
  });

  it("withholds when the member has not opted in", () => {
    expect(
      canServeMemberPhoneOnLodgeSurface({ ...base, memberOptedIn: false })
    ).toBe(false);
  });

  it("withholds for every non-adult tier regardless of config and opt-in", () => {
    for (const ageTier of ["INFANT", "CHILD", "YOUTH", "NOT_APPLICABLE"] as AgeTier[]) {
      expect(canServeMemberPhoneOnLodgeSurface({ ...base, ageTier })).toBe(false);
    }
  });
});

describe("formatXeroPhone", () => {
  it("returns null when there is no number", () => {
    expect(formatXeroPhone({ phoneNumber: null })).toBeNull();
  });

  it("joins country/area/number with a leading +", () => {
    expect(
      formatXeroPhone({ phoneCountryCode: "64", phoneAreaCode: "27", phoneNumber: "4224115" })
    ).toBe("+64 27 4224115");
  });
});
