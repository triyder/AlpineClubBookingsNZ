import { describe, expect, it } from "vitest";
import {
  isOnboardingGateExemptPath,
  shouldShowMemberOnboarding,
  type MemberOnboardingProfile,
} from "@/lib/member-onboarding";

// An incomplete USER profile: nothing filled in, so shouldShowMemberOnboarding
// returns true and the mandatory gate would normally render. This mirrors the
// member who lands on a nomination confirmation link before completing their
// own profile — the trap #1221 fixes.
function incompleteUserProfile(): MemberOnboardingProfile {
  return {
    id: "member-user",
    active: true,
    canLogin: true,
    role: "USER",
    accessRoles: [{ role: "USER" }],
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

// Reproduce the layout's gate expression so the test exercises exactly what
// decides whether the wizard renders.
function layoutShowsOnboardingGate(
  member: MemberOnboardingProfile,
  pathname: string | null,
) {
  return (
    shouldShowMemberOnboarding(member) && !isOnboardingGateExemptPath(pathname)
  );
}

describe("isOnboardingGateExemptPath", () => {
  it("exempts single-action nomination token routes", () => {
    expect(isOnboardingGateExemptPath("/nominations/abc123")).toBe(true);
    // The x-pathname header is `${pathname}${search}`, so a query string must
    // not defeat the prefix match.
    expect(isOnboardingGateExemptPath("/nominations/abc123?from=email")).toBe(
      true,
    );
  });

  it("does not exempt normal authenticated routes", () => {
    expect(isOnboardingGateExemptPath("/dashboard")).toBe(false);
    expect(isOnboardingGateExemptPath("/bookings/booking-1")).toBe(false);
    expect(isOnboardingGateExemptPath("/profile")).toBe(false);
    expect(isOnboardingGateExemptPath("/book")).toBe(false);
  });

  it("stays narrow: no trailing slash and look-alike paths are not exempt", () => {
    expect(isOnboardingGateExemptPath("/nominations")).toBe(false);
    expect(isOnboardingGateExemptPath("/nominationsomething")).toBe(false);
    expect(isOnboardingGateExemptPath(null)).toBe(false);
    expect(isOnboardingGateExemptPath(undefined)).toBe(false);
    expect(isOnboardingGateExemptPath("")).toBe(false);
  });
});

describe("onboarding gate on single-action token routes (#1221)", () => {
  it("suppresses the gate for an incomplete-profile member on /nominations/[token]", () => {
    const member = incompleteUserProfile();

    // Sanity: the member genuinely needs onboarding; the exemption is doing the
    // work, not a member who happened to be complete.
    expect(shouldShowMemberOnboarding(member)).toBe(true);
    expect(layoutShowsOnboardingGate(member, "/nominations/abc123")).toBe(
      false,
    );
  });

  it("still fires the gate for the same member on a normal authenticated route", () => {
    const member = incompleteUserProfile();

    expect(layoutShowsOnboardingGate(member, "/dashboard")).toBe(true);
  });
});
