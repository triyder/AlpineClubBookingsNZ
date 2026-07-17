import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #1967/#1994: the split-guest settlement admin alert must keep the #1422-style
// preference gating (routed to the shared `adminPaymentFailure` category so a
// rare event needs no new NotificationPreference column) and carry the
// registered `admin-split-settlement-unpaid` template name so `sendToAdmins`
// resolves its delivery-mode policy from the registry.
const h = vi.hoisted(() => ({
  sendToAdmins: vi.fn(),
  shouldSendDirectAdminSystemEmail: vi.fn().mockResolvedValue(true),
  unpaidTemplate: vi.fn(() => "<html>split settlement unpaid</html>"),
}));

vi.mock("../admin-alerts-shared", () => ({
  sendToAdmins: h.sendToAdmins,
  shouldSendDirectAdminSystemEmail: h.shouldSendDirectAdminSystemEmail,
}));
vi.mock("@/lib/email-templates", () => ({
  adminMinorsReviewRequiredTemplate: vi.fn(() => "<html></html>"),
  adminOwnerSubstitutionTemplate: vi.fn(() => "<html></html>"),
  adminPartnerShareSweptTemplate: vi.fn(() => "<html></html>"),
  adminNewBookingTemplate: vi.fn(() => "<html></html>"),
  adminPendingDeadlineTemplate: vi.fn(() => "<html></html>"),
  adminBookingBumpedTemplate: vi.fn(() => "<html></html>"),
  adminCapacityWarningTemplate: vi.fn(() => "<html></html>"),
  adminWaitlistOfferTemplate: vi.fn(() => "<html></html>"),
  adminBookingChangeRequestTemplate: vi.fn(() => "<html></html>"),
  adminBookingRequestPendingTemplate: vi.fn(() => "<html></html>"),
  adminSchoolManualInvoiceTemplate: vi.fn(() => "<html></html>"),
  adminBookingRequestHoldExpiredTemplate: vi.fn(() => "<html></html>"),
  adminSplitSettlementUnpaidTemplate: h.unpaidTemplate,
}));

import { sendAdminSplitSettlementUnpaidAlert } from "@/lib/email/admin-alerts-booking";

const ORIGINAL_URL = process.env.NEXTAUTH_URL;

const baseData = {
  memberName: "Alex Member",
  checkIn: new Date("2026-08-10T00:00:00.000Z"),
  checkOut: new Date("2026-08-12T00:00:00.000Z"),
  guestCount: 2,
  totalCents: 12300,
  holdUntil: new Date("2026-08-13T00:00:00.000Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXTAUTH_URL = "https://club.example.test";
});
afterEach(() => {
  process.env.NEXTAUTH_URL = ORIGINAL_URL;
});

describe("sendAdminSplitSettlementUnpaidAlert (#1967/#1994)", () => {
  it.each([false, true])(
    "routes the alert through the adminPaymentFailure preference for parentUnpaid=%s",
    async (parentUnpaid) => {
      await sendAdminSplitSettlementUnpaidAlert({ ...baseData, parentUnpaid });

      // #1422 precedent: gated by the existing payment-failure notification
      // category, not a bespoke new preference column.
      expect(h.sendToAdmins).toHaveBeenCalledWith(
        expect.objectContaining({
          templateName: "admin-split-settlement-unpaid",
          preferenceKey: "adminPaymentFailure",
        }),
      );
    },
  );

  it("selects the wording variant from parentUnpaid without changing the audit template name", async () => {
    await sendAdminSplitSettlementUnpaidAlert({ ...baseData, parentUnpaid: false });
    await sendAdminSplitSettlementUnpaidAlert({ ...baseData, parentUnpaid: true });

    // A single registry entry backs both wording variants: the boolean only
    // switches the rendered paragraph, so both sends share one templateName.
    expect(h.unpaidTemplate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ parentUnpaid: false }),
    );
    expect(h.unpaidTemplate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ parentUnpaid: true }),
    );
    for (const call of h.sendToAdmins.mock.calls) {
      expect(call[0].templateName).toBe("admin-split-settlement-unpaid");
      expect(call[0].preferenceKey).toBe("adminPaymentFailure");
    }
  });
});
