import { beforeEach, describe, expect, it, vi } from "vitest";

// #1967/#1994: once `admin-split-settlement-unpaid` is registered as an admin
// system template, `shouldSendAdminSystemEmail` must resolve its delivery mode
// from the registry + NotificationDeliveryPolicy table instead of defaulting an
// unregistered template to always-send. Proves the new policy control end to end.
const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    notificationDeliveryPolicy: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

import { shouldSendAdminSystemEmail } from "@/lib/notification-delivery-policies";

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.notificationDeliveryPolicy.findUnique.mockResolvedValue(null);
});

describe("admin-split-settlement-unpaid delivery policy (#1967/#1994)", () => {
  it("sends by default when no policy override exists", async () => {
    const result = await shouldSendAdminSystemEmail({
      templateName: "admin-split-settlement-unpaid",
    });

    expect(result).toEqual({ send: true, mode: "always" });
    expect(mockPrisma.notificationDeliveryPolicy.findUnique).toHaveBeenCalledWith(
      { where: { templateName: "admin-split-settlement-unpaid" } },
    );
  });

  it("suppresses the alert when an admin disables its delivery policy", async () => {
    mockPrisma.notificationDeliveryPolicy.findUnique.mockResolvedValue({
      templateName: "admin-split-settlement-unpaid",
      mode: "DISABLED",
    });

    const result = await shouldSendAdminSystemEmail({
      templateName: "admin-split-settlement-unpaid",
    });

    expect(result).toEqual({ send: false, mode: "disabled", reason: "disabled" });
  });

  it("does not treat the member split-guest link as an admin system template", async () => {
    const result = await shouldSendAdminSystemEmail({
      templateName: "split-guest-payment-link",
    });

    // Member-facing template: shouldSendAdminSystemEmail short-circuits to
    // always-send and never consults the admin delivery-policy table.
    expect(result).toEqual({ send: true, mode: "always" });
    expect(
      mockPrisma.notificationDeliveryPolicy.findUnique,
    ).not.toHaveBeenCalled();
  });

  it("resolves the #1993 terminal admin cancelled notice through its own delivery policy", async () => {
    // C1: the dedicated terminal notice is an admin system template, so its
    // delivery mode resolves from its OWN registry+policy row — muting or
    // overriding the recurring alert cannot touch it.
    const sends = await shouldSendAdminSystemEmail({
      templateName: "admin-split-settlement-cancelled",
    });
    expect(sends).toEqual({ send: true, mode: "always" });
    expect(mockPrisma.notificationDeliveryPolicy.findUnique).toHaveBeenCalledWith(
      { where: { templateName: "admin-split-settlement-cancelled" } },
    );

    mockPrisma.notificationDeliveryPolicy.findUnique.mockResolvedValue({
      templateName: "admin-split-settlement-cancelled",
      mode: "DISABLED",
    });
    const disabled = await shouldSendAdminSystemEmail({
      templateName: "admin-split-settlement-cancelled",
    });
    expect(disabled).toEqual({ send: false, mode: "disabled", reason: "disabled" });
  });

  it("resolves the #1992/#2007 duplicate-capture refund alert through its own delivery policy", async () => {
    // The dedicated duplicate-capture alert is an admin system template, so its
    // delivery mode resolves from its own registry + policy row. NOT
    // delivery-locked, so an admin can mute it (the refund already happened or
    // is durably queued, so no money is lost).
    const sends = await shouldSendAdminSystemEmail({
      templateName: "admin-duplicate-capture-refund",
    });
    expect(sends).toEqual({ send: true, mode: "always" });
    expect(mockPrisma.notificationDeliveryPolicy.findUnique).toHaveBeenCalledWith(
      { where: { templateName: "admin-duplicate-capture-refund" } },
    );

    mockPrisma.notificationDeliveryPolicy.findUnique.mockResolvedValue({
      templateName: "admin-duplicate-capture-refund",
      mode: "DISABLED",
    });
    const disabled = await shouldSendAdminSystemEmail({
      templateName: "admin-duplicate-capture-refund",
    });
    expect(disabled).toEqual({ send: false, mode: "disabled", reason: "disabled" });
  });

  it("does not treat the member split-guest-portion-cancelled notice as an admin system template", async () => {
    const result = await shouldSendAdminSystemEmail({
      templateName: "split-guest-portion-cancelled",
    });

    expect(result).toEqual({ send: true, mode: "always" });
    expect(
      mockPrisma.notificationDeliveryPolicy.findUnique,
    ).not.toHaveBeenCalled();
  });
});
