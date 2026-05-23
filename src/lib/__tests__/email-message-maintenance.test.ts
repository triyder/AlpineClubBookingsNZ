import { describe, expect, it, vi } from "vitest";
import {
  deleteStaleEmailMessageAdminRows,
  deleteStaleEmailTemplateOverrides,
  deleteStaleNotificationDeliveryPolicies,
} from "@/lib/email-message-maintenance";
import { EMAIL_TEMPLATE_KEYS } from "@/lib/email-message-registry";

vi.mock("@/lib/prisma", () => ({
  prisma: {},
}));

describe("email message maintenance", () => {
  it("deletes template overrides that are no longer in the registry", async () => {
    const store = {
      emailTemplateOverride: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };

    await expect(deleteStaleEmailTemplateOverrides(store)).resolves.toEqual({
      count: 1,
    });
    expect(store.emailTemplateOverride.deleteMany).toHaveBeenCalledWith({
      where: {
        templateName: { notIn: EMAIL_TEMPLATE_KEYS },
      },
    });
  });

  it("deletes delivery policies that no longer map to admin/system templates", async () => {
    const store = {
      notificationDeliveryPolicy: {
        deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
    };

    await expect(deleteStaleNotificationDeliveryPolicies(store)).resolves.toEqual({
      count: 2,
    });
    expect(store.notificationDeliveryPolicy.deleteMany).toHaveBeenCalledWith({
      where: {
        templateName: {
          notIn: expect.arrayContaining(["admin-daily-digest"]),
        },
      },
    });
  });

  it("returns combined stale-row cleanup counts", async () => {
    const store = {
      emailTemplateOverride: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      notificationDeliveryPolicy: {
        deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
    };

    await expect(deleteStaleEmailMessageAdminRows(store)).resolves.toEqual({
      staleTemplateOverridesDeleted: 1,
      staleDeliveryPoliciesDeleted: 2,
    });
  });
});
