import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #1938: the admin-initiated member-delete alert deep-links to the review queue
// (/admin/deletion-requests), not the member record, so a second admin can act
// on it directly.
const h = vi.hoisted(() => ({
  sendToAdmins: vi.fn(),
  shouldSendDirectAdminSystemEmail: vi.fn().mockResolvedValue(true),
  sendEmail: vi.fn().mockResolvedValue({ status: "sent" }),
  deleteRequestedTemplate: vi.fn(
    (_data: { reviewUrl: string }) => "<html>delete requested</html>",
  ),
}));

vi.mock("../admin-alerts-shared", () => ({
  sendToAdmins: h.sendToAdmins,
  shouldSendDirectAdminSystemEmail: h.shouldSendDirectAdminSystemEmail,
}));
vi.mock("../core", () => ({ sendEmail: h.sendEmail }));
vi.mock("@/lib/email-templates", () => ({
  adminMembershipApplicationPendingTemplate: vi.fn(() => "<html></html>"),
  adminFamilyGroupRequestTemplate: vi.fn(() => "<html></html>"),
  adminMembershipCancellationRequestTemplate: vi.fn(() => "<html></html>"),
  adminAccountDeletionRequestedTemplate: vi.fn(() => "<html></html>"),
  adminMemberArchiveRequestedTemplate: vi.fn(() => "<html></html>"),
  adminMemberDeleteRequestedTemplate: h.deleteRequestedTemplate,
  adminMemberDeleteApprovedTemplate: vi.fn(() => "<html></html>"),
  adminMemberDeleteRejectedTemplate: vi.fn(() => "<html></html>"),
}));

import { sendAdminMemberDeleteRequestedAlert } from "@/lib/email/admin-alerts-membership";

const ORIGINAL_URL = process.env.NEXTAUTH_URL;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXTAUTH_URL = "https://club.example.test";
});
afterEach(() => {
  process.env.NEXTAUTH_URL = ORIGINAL_URL;
});

describe("sendAdminMemberDeleteRequestedAlert (#1938)", () => {
  it("deep-links the review email at /admin/deletion-requests, not the member page", async () => {
    await sendAdminMemberDeleteRequestedAlert({
      requesterName: "Admin One",
      memberId: "member-42",
      memberName: "Erroneous Record",
      reason: "Duplicate created in error",
    });

    expect(h.deleteRequestedTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewUrl: "https://club.example.test/admin/deletion-requests",
      }),
    );
    const reviewUrl = h.deleteRequestedTemplate.mock.calls[0]?.[0].reviewUrl;
    expect(reviewUrl).not.toContain("/admin/members/");
  });

  it("sends via the shared member-requests alert category", async () => {
    await sendAdminMemberDeleteRequestedAlert({
      requesterName: "Admin One",
      memberId: "member-42",
      memberName: "Erroneous Record",
      reason: "Duplicate created in error",
    });

    // NOTE: this alert stays on the shared `adminFamilyGroupRequest` ("Member
    // requests") preference. A dedicated toggle would require a new
    // NotificationPreference column (a schema/migration change), which is out of
    // scope for #1938 (no-schema). The category's description already documents
    // safe-delete coverage. Tracked as a follow-up.
    expect(h.sendToAdmins).toHaveBeenCalledWith(
      expect.objectContaining({
        templateName: "admin-member-delete-requested",
        preferenceKey: "adminFamilyGroupRequest",
      }),
    );
  });
});
