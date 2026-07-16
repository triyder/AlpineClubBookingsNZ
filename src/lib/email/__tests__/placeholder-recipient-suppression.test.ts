import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  emailLogCreate: vi.fn(),
  emailLogUpdate: vi.fn(),
  getActiveEmailSuppression: vi.fn(),
  sendMail: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    emailLog: { create: mocks.emailLogCreate, update: mocks.emailLogUpdate },
  },
}));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));
vi.mock("@/lib/email-sender", () => ({ EMAIL_FROM: "club@club.test" }));
vi.mock("@/lib/email-message-settings", () => ({
  formatEmailFromAddressWithSettings: () => "Club <club@club.test>",
}));
vi.mock("@/lib/email-message-renderer", () => ({
  prepareEmailMessage: async ({ subject, html }: { subject: string; html: string }) => ({
    subject,
    html,
    settings: {},
  }),
}));
vi.mock("@/lib/email-suppression", () => ({
  getActiveEmailSuppression: mocks.getActiveEmailSuppression,
  normalizeEmailAddress: (value: string) => value.trim().toLowerCase(),
}));
vi.mock("@/lib/email/internal", () => ({
  getEmailTransporter: () => ({ sendMail: mocks.sendMail }),
  shouldPersistEmailHtml: () => false,
}));

import { sendEmail } from "@/lib/email/core";
import { buildPlaceholderContactEmail } from "@/lib/placeholder-contact-email";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.emailLogCreate.mockResolvedValue({ id: "log_1" });
  mocks.emailLogUpdate.mockResolvedValue({});
  mocks.getActiveEmailSuppression.mockResolvedValue(null);
  // Dev short-circuit marks SENT without a real transporter — enough to prove
  // a real recipient reaches the EmailLog + suppression path.
  vi.stubEnv("NODE_ENV", "development");
});

describe("sendEmail placeholder recipient suppression (#1935)", () => {
  it("never sends to a walk-in placeholder owner and creates no EmailLog row", async () => {
    const outcome = await sendEmail({
      to: buildPlaceholderContactEmail(),
      subject: "Your booking is on hold",
      html: "<p>hold</p>",
      templateName: "booking-pending",
    });

    expect(outcome.status).toBe("skipped_placeholder_recipient");
    expect(mocks.emailLogCreate).not.toHaveBeenCalled();
    expect(mocks.getActiveEmailSuppression).not.toHaveBeenCalled();
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it("still processes a real recipient normally", async () => {
    const outcome = await sendEmail({
      to: "real.person@example.com",
      subject: "Your booking is on hold",
      html: "<p>hold</p>",
      templateName: "booking-pending",
    });

    expect(outcome.status).not.toBe("skipped_placeholder_recipient");
    // A real recipient reaches the suppression check + EmailLog creation.
    expect(mocks.emailLogCreate).toHaveBeenCalled();
    expect(mocks.getActiveEmailSuppression).toHaveBeenCalled();
  });
});
