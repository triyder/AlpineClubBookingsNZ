import { describe, expect, it } from "vitest";
import { shouldShowMemberOnboarding, type MemberOnboardingProfile } from "@/lib/member-onboarding";
import {
  MEMBER_LEVEL_ROLE_VALUES,
  NON_MEMBER_ROLE_VALUES,
  OPERATIONAL_ROLE_VALUES,
  isMemberLevelRole,
  isOperationalRole,
} from "@/lib/member-roles";
import { roleNeverRequiresSubscription } from "@/lib/member-subscription-defaults";

function onboardingProfile(role: string): MemberOnboardingProfile {
  const accessRoles = ["USER", "ADMIN", "LODGE"].includes(role)
    ? [{ role }]
    : [];

  return {
    id: `member-${role.toLowerCase()}`,
    active: true,
    canLogin: true,
    role,
    accessRoles,
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
  it("treats USER as the ordinary member-facing access role", () => {
    expect(MEMBER_LEVEL_ROLE_VALUES).toEqual(["USER"]);
    expect(isMemberLevelRole("USER")).toBe(true);
    expect(isMemberLevelRole("MEMBER")).toBe(false);
    expect(isMemberLevelRole("ASSOCIATE")).toBe(false);
    expect(isMemberLevelRole("LIFE")).toBe(false);
    expect(isMemberLevelRole("ADMIN")).toBe(false);
    expect(isMemberLevelRole("LODGE")).toBe(false);
  });

  it("keeps only ADMIN and LODGE as operational roles", () => {
    expect(OPERATIONAL_ROLE_VALUES).toEqual(["ADMIN", "LODGE"]);
    expect(isOperationalRole("ADMIN")).toBe(true);
    expect(isOperationalRole("LODGE")).toBe(true);
    expect(roleNeverRequiresSubscription("ADMIN")).toBe(true);
    expect(roleNeverRequiresSubscription("LODGE")).toBe(true);
    expect(roleNeverRequiresSubscription("USER")).toBe(false);
    expect(roleNeverRequiresSubscription("ASSOCIATE")).toBe(false);
    expect(roleNeverRequiresSubscription("LIFE")).toBe(false);
  });

  it("runs onboarding for users but not membership type category strings", () => {
    expect(shouldShowMemberOnboarding(onboardingProfile("USER"))).toBe(true);
    expect(shouldShowMemberOnboarding(onboardingProfile("ASSOCIATE"))).toBe(false);
    expect(shouldShowMemberOnboarding(onboardingProfile("LIFE"))).toBe(false);
    expect(shouldShowMemberOnboarding(onboardingProfile("ADMIN"))).toBe(false);
    expect(shouldShowMemberOnboarding(onboardingProfile("LODGE"))).toBe(false);
  });
});

describe("non-member booking-request roles", () => {

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
