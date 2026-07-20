import { describe, expect, it } from "vitest";
import {
  getFamilyMemberBookingActionLabel,
  getFamilyMemberBookingBlockMessage,
  shouldShowInviteFamilyGroupMembersLink,
} from "../family-booking";

describe("shouldShowInviteFamilyGroupMembersLink", () => {
  it("returns true when only the member is available for quick add", () => {
    expect(
      shouldShowInviteFamilyGroupMembersLink([
        { relationship: "self" },
      ])
    ).toBe(true);
  });

  it("returns false when another family group member is available", () => {
    expect(
      shouldShowInviteFamilyGroupMembersLink([
        { relationship: "self" },
        { relationship: "partner" },
      ])
    ).toBe(false);
  });
});

describe("family member booking block messages", () => {
  it("returns null for bookable family members", () => {
    expect(
      getFamilyMemberBookingBlockMessage({
        relationship: "self",
        firstName: "Sam",
        canBeBooked: true,
      })
    ).toBeNull();
  });

  it("does not block quick-add when a scoped pending request leaves another group bookable", () => {
    const member = {
      relationship: "dependent" as const,
      firstName: "Sam",
      canBeBooked: true,
      pendingRequestStatus: null,
      pendingRequestFamilyGroupIds: ["fg1"],
      bookableFamilyGroupIds: ["fg2"],
    };

    expect(getFamilyMemberBookingBlockMessage(member)).toBeNull();
    expect(getFamilyMemberBookingActionLabel(member)).toBeNull();
  });

  it("explains a non-login member the current user can fix", () => {
    const member = {
      relationship: "dependent" as const,
      firstName: "Sam",
      canLogin: false,
      canBeBooked: false,
      canCurrentUserConfirmDetails: true,
      action: "complete_details",
    };

    expect(getFamilyMemberBookingBlockMessage(member)).toContain(
      "Complete Sam's details before booking them as a member"
    );
    expect(getFamilyMemberBookingActionLabel(member)).toBe("Complete details");
  });

  it("explains a login-capable member who must self-confirm", () => {
    const member = {
      relationship: "partner" as const,
      firstName: "Jane",
      canLogin: true,
      canBeBooked: false,
      needsOwnLoginConfirmation: true,
      action: "own_login_required",
    };

    expect(getFamilyMemberBookingBlockMessage(member)).toContain(
      "Jane has their own login and needs to sign in"
    );
    expect(getFamilyMemberBookingActionLabel(member)).toBe(
      "Ask them to sign in and confirm"
    );
  });

  it("does not ask confirmation-exempt accounts to sign in and confirm", () => {
    const member = {
      relationship: "partner" as const,
      firstName: "Admin",
      role: "ADMIN",
      confirmationMode: "not_allowed",
      canLogin: true,
      canBeBooked: false,
      needsOwnLoginConfirmation: false,
      action: null,
    };

    expect(getFamilyMemberBookingBlockMessage(member)).toContain(
      "does not need member detail confirmation"
    );
    expect(getFamilyMemberBookingActionLabel(member)).toBeNull();
  });

  it("explains pending admin approval", () => {
    const member = {
      relationship: "dependent" as const,
      firstName: "Sam",
      canBeBooked: false,
      pendingRequestStatus: "PENDING",
      action: "pending_admin_approval",
    };

    expect(getFamilyMemberBookingBlockMessage(member)).toContain(
      "awaiting admin approval"
    );
    expect(getFamilyMemberBookingActionLabel(member)).toBe(
      "Pending admin approval"
    );
  });

  it("appends the provisional-hold consequence only when the hold policy applies (#1942)", () => {
    const member = {
      relationship: "dependent" as const,
      firstName: "Sam",
      canBeBooked: false,
      pendingRequestStatus: "PENDING",
      action: "pending_admin_approval",
    };

    // Default (no options → "none") keeps the original message, unchanged.
    expect(getFamilyMemberBookingBlockMessage(member)).not.toContain(
      "held provisionally"
    );
    expect(getFamilyMemberBookingBlockMessage(member, { holdPolicy: "none" })).not.toContain(
      "held provisionally"
    );

    // When the hold policy applies to the stay, spell out the consequence.
    expect(
      getFamilyMemberBookingBlockMessage(member, { holdPolicy: "applies" })
    ).toContain("held provisionally");
  });

  it("warns conditionally when the party has no non-member yet, so the hold decision is unknown (#1942 FIX 7)", () => {
    const member = {
      relationship: "dependent" as const,
      firstName: "Sam",
      canBeBooked: false,
      canLogin: true,
    };

    const conditional = getFamilyMemberBookingBlockMessage(member, {
      holdPolicy: "conditional",
    });
    expect(conditional).toContain("may be held provisionally");
    expect(conditional).toContain("depending on how far out your booking is");

    // Definite wording when the decision is known true; omitted when known false.
    expect(
      getFamilyMemberBookingBlockMessage(member, { holdPolicy: "applies" })
    ).toContain("they'll be held provisionally");
    expect(
      getFamilyMemberBookingBlockMessage(member, { holdPolicy: "none" })
    ).not.toContain("held provisionally");
  });

  it("does not repeat 'add them as a non-member guest' in the pending-approval message (#1942 FIX 6)", () => {
    const member = {
      relationship: "dependent" as const,
      firstName: "Sam",
      canBeBooked: false,
      pendingRequestStatus: "PENDING",
      action: "pending_admin_approval",
    };

    for (const holdPolicy of ["applies", "conditional"] as const) {
      const message = getFamilyMemberBookingBlockMessage(member, { holdPolicy });
      // The phrase must appear exactly once — the consequence now reads as a
      // continuation ("...until approved — if you do, ...") rather than a second
      // sentence that repeats the whole clause.
      const occurrences = (
        message?.match(/add them as a non-member guest/g) ?? []
      ).length;
      expect(occurrences).toBe(1);
      expect(message).toContain("until approved — if you do,");
    }
  });
});
