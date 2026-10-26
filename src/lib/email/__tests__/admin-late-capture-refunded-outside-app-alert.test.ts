import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #4170 (`INV-ADDPAY-038`): the alert for a late capture refunded OUTSIDE the
 * app, pinned at the real sender - its unmuteable path, its honest subject, its
 * template name, its tokens and its Finance-editor audience. Routing it back
 * through the muteable "Payment Failed" mail (round 3's first shape) fails here.
 */
const mocks = vi.hoisted(() => ({
  sendToAdmins: vi.fn(),
  sendUnmuteableAdminAlert: vi.fn(),
}));

vi.mock("@/lib/email/admin-alerts-shared", () => ({
  sendToAdmins: mocks.sendToAdmins,
  sendUnmuteableAdminAlert: mocks.sendUnmuteableAdminAlert,
}));

import { sendAdminLateCaptureRefundedOutsideAppAlert } from "@/lib/email/admin-alerts-late-capture";
import { LATE_CAPTURE_REFUNDED_OUTSIDE_APP_NOTE } from "@/lib/late-capture-outside-app-note";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

type CapturedAlert = {
  subject: string;
  html: string;
  templateName: string;
  templateData: Record<string, unknown>;
  requirement: { area: string; level: string };
};

describe("sendAdminLateCaptureRefundedOutsideAppAlert (#4170)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends its own template, unmuteable, to Finance editors, with every token its body needs", async () => {
    await sendAdminLateCaptureRefundedOutsideAppAlert(
      {
        memberName: "Alice Example",
        checkIn: new Date("2026-08-01"),
        checkOut: new Date("2026-08-03"),
        bookingId: "booking-9",
        paymentIntentId: "pi_late_9",
        refundedCents: 2500,
      },
      CLUB_FORMAT_TEST,
    );

    expect(mocks.sendToAdmins).not.toHaveBeenCalled();
    expect(mocks.sendUnmuteableAdminAlert).toHaveBeenCalledTimes(1);
    const [alert] = mocks.sendUnmuteableAdminAlert.mock.calls[0] as [CapturedAlert];
    expect(alert.subject).toBe("Late payment refunded outside the app - check Xero: Alice Example");
    expect(alert.subject).not.toMatch(/failed/i);
    expect(alert.templateName).toBe("admin-late-capture-refunded-outside-app");
    expect(alert.requirement).toEqual({ area: "finance", level: "edit" });
    expect(alert.templateData).toMatchObject({
      memberName: "Alice Example",
      bookingId: "booking-9",
      paymentIntentId: "pi_late_9",
      amount: "$25.00",
      outsideAppRefundNote: LATE_CAPTURE_REFUNDED_OUTSIDE_APP_NOTE,
    });
    expect(alert.html).toContain("Late Payment Refunded Outside the App");
    expect(alert.html).toContain("pi_late_9");
  });
});
