import { describe, expect, it } from "vitest";

import { resolveBookingDetailViewer } from "../_lib/booking-detail-viewer";

/**
 * #3991 (`INV-SSOT`): ONE answer to "may this viewer see the booking owner's
 * account credit?", `canSeeOwnerCredit`, which the narrative's credit wording,
 * the timeline's credit entries, the cancellation outcome's credit lines and
 * badge, the hand-back note and the credit-election notice all read. Before it,
 * two rules disagreed for a read-only admin who is also a guest on the booking:
 * one said linked guest (hide), the other said admin-type viewer (show).
 */
const OWNER_ID = "owner-1";
const booking = {
  memberId: OWNER_ID,
  member: { id: OWNER_ID, firstName: "Ada", lastName: "Owner" },
  organisationId: null,
  organisation: null,
  guests: [
    { memberId: "guest-1", consentStatus: "ACCEPTED" },
    { memberId: "readonly-1", consentStatus: "ACCEPTED" },
  ],
} as never;

const session = (id: string, role: string) =>
  ({ user: { id, role: role === "ADMIN" ? "ADMIN" : "MEMBER", accessRoles: [{ role }] } }) as never;

const canSee = (id: string, role: string) =>
  resolveBookingDetailViewer({ session: session(id, role), booking }).canSeeOwnerCredit;

describe("canSeeOwnerCredit: who may see the booking owner's credit (#3991)", () => {
  it("is true for the owner, an officer and a full admin", () => {
    expect(canSee(OWNER_ID, "USER")).toBe(true);
    expect(canSee("officer-1", "ADMIN_BOOKINGS")).toBe(true);
    expect(canSee("admin-1", "ADMIN")).toBe(true);
  });

  it("is false for a linked guest", () => {
    const viewer = resolveBookingDetailViewer({ session: session("guest-1", "USER"), booking });
    expect(viewer.isLinkedGuestViewer).toBe(true);
    expect(viewer.canSeeOwnerCredit).toBe(false);
  });

  it("is ONE answer for a read-only admin who is also a guest: an admin-type viewer sees it", () => {
    const viewer = resolveBookingDetailViewer({ session: session("readonly-1", "ADMIN_READONLY"), booking });
    // Both of the old rules' inputs are true at once — the case they split on.
    expect(viewer.isLinkedGuestViewer).toBe(true);
    expect(viewer.nonOwnerAdminViewer).toBe(true);
    expect(viewer.canSeeOwnerCredit).toBe(true);
  });
});
