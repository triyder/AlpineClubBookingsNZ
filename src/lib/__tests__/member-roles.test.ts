import { describe, expect, it } from "vitest";
import { shouldShowMemberOnboarding, type MemberOnboardingProfile } from "@/lib/member-onboarding";
import {
  MEMBER_LEVEL_ROLE_VALUES,
  NON_MEMBER_ROLE_VALUES,
  OPERATIONAL_ROLE_VALUES,
  isMemberLevelRole,
  isNonMemberRole,
  isOperationalRole,
} from "@/lib/member-roles";
import { roleNeverRequiresSubscription } from "@/lib/member-subscription-defaults";

function onboardingProfile(role: string): MemberOnboardingProfile {
  return {
    id: `member-${role.toLowerCase()}`,
    active: true,
    canLogin: true,
    role,
    forcePasswordChange: false,
    firstName: "Taylor",
    lastName: "Member",
    email: "taylor@example.org",
    phoneCountryCode: "",
    phoneAreaCode: "",
    phoneNumber: "",
    dateOfBirth: null,
    streetAddressLine1: "",
    streetCity: "",
    streetRegion: "",
    streetPostalCode: "",
    streetCountry: "",
    postalAddressLine1: "",
    postalCity: "",
    postalRegion: "",
    postalPostalCode: "",
    postalCountry: "",
    profileCompletedAt: null,
    detailsConfirmedAt: null,
    detailsConfirmedByMemberId: null,
    onboardingConfirmedAt: null,
  };
}

describe("member role categories", () => {
  it("treats MEMBER, ASSOCIATE, and LIFE as ordinary member-level roles", () => {
    expect(MEMBER_LEVEL_ROLE_VALUES).toEqual(["MEMBER", "ASSOCIATE", "LIFE"]);
    expect(isMemberLevelRole("MEMBER")).toBe(true);
    expect(isMemberLevelRole("ASSOCIATE")).toBe(true);
    expect(isMemberLevelRole("LIFE")).toBe(true);
    expect(isMemberLevelRole("ADMIN")).toBe(false);
    expect(isMemberLevelRole("LODGE")).toBe(false);
  });

  it("keeps only ADMIN and LODGE as operational roles", () => {
    expect(OPERATIONAL_ROLE_VALUES).toEqual(["ADMIN", "LODGE"]);
    expect(isOperationalRole("ADMIN")).toBe(true);
    expect(isOperationalRole("LODGE")).toBe(true);
    expect(roleNeverRequiresSubscription("ADMIN")).toBe(true);
    expect(roleNeverRequiresSubscription("LODGE")).toBe(true);
    expect(roleNeverRequiresSubscription("MEMBER")).toBe(false);
    expect(roleNeverRequiresSubscription("ASSOCIATE")).toBe(false);
    expect(roleNeverRequiresSubscription("LIFE")).toBe(false);
  });

  it("runs onboarding for Associate and Life members like ordinary members", () => {
    expect(shouldShowMemberOnboarding(onboardingProfile("MEMBER"))).toBe(true);
    expect(shouldShowMemberOnboarding(onboardingProfile("ASSOCIATE"))).toBe(true);
    expect(shouldShowMemberOnboarding(onboardingProfile("LIFE"))).toBe(true);
    expect(shouldShowMemberOnboarding(onboardingProfile("ADMIN"))).toBe(false);
    expect(shouldShowMemberOnboarding(onboardingProfile("LODGE"))).toBe(false);
  });
});

describe("non-member booking-request roles", () => {
  it("recognizes NON_MEMBER and SCHOOL as non-member categories", () => {
    expect(NON_MEMBER_ROLE_VALUES).toEqual(["NON_MEMBER", "SCHOOL"]);
    expect(isNonMemberRole("NON_MEMBER")).toBe(true);
    expect(isNonMemberRole("SCHOOL")).toBe(true);
    expect(isNonMemberRole("MEMBER")).toBe(false);
    expect(isNonMemberRole("ADMIN")).toBe(false);
    expect(isNonMemberRole(null)).toBe(false);
  });

  it("grants them no member-level or operational access", () => {
    for (const role of NON_MEMBER_ROLE_VALUES) {
      expect(isMemberLevelRole(role)).toBe(false);
      expect(isOperationalRole(role)).toBe(false);
      // Non-login records, so onboarding never applies even before the role check.
      expect(shouldShowMemberOnboarding(onboardingProfile(role))).toBe(false);
    }
  });

  it("exempts them from membership subscriptions", () => {
    expect(roleNeverRequiresSubscription("NON_MEMBER")).toBe(true);
    expect(roleNeverRequiresSubscription("SCHOOL")).toBe(true);
  });
});
