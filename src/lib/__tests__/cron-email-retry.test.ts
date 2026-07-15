import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  memberFindMany: vi.fn(),
  sendMail: vi.fn(),
  resolveEmailDeliveryConfig: vi.fn(),
  sendEmail: vi.fn(),
  getActiveEmailSuppression: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    emailLog: {
      findMany: mocks.findMany,
      update: mocks.update,
      updateMany: mocks.updateMany,
    },
    member: {
      findMany: mocks.memberFindMany,
    },
  },
}));

vi.mock("@/lib/email-suppression", () => ({
  getActiveEmailSuppression: mocks.getActiveEmailSuppression,
}));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(() => ({ sendMail: mocks.sendMail })),
  },
}));

vi.mock("@/lib/email-sender", () => ({
  EMAIL_FROM: "noreply@example.test",
  formatEmailFromAddress: (from: string) => from,
}));

vi.mock("@/lib/email-text", () => ({
  htmlToPlainText: (html: string) => html,
}));

vi.mock("@/lib/email-delivery", () => ({
  resolveEmailDeliveryConfig: mocks.resolveEmailDeliveryConfig,
}));

vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/email", () => ({
  sendEmail: mocks.sendEmail,
}));

import { retryFailedEmails } from "@/lib/cron-email-retry";

function failedEmail(overrides: Record<string, unknown> = {}) {
  return {
    id: "email_1",
    to: "member@example.test",
    subject: "Booking update",
    htmlBody: "<p>hello</p>",
    templateName: "booking-confirmed",
    attempts: 0,
    ...overrides,
  };
}

describe("retryFailedEmails (issue #820)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveEmailDeliveryConfig.mockReturnValue({
      ok: true,
      transportOptions: { host: "smtp.example.test" },
      issues: [],
    });
    mocks.update.mockResolvedValue({});
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.memberFindMany.mockResolvedValue([]);
    mocks.getActiveEmailSuppression.mockResolvedValue(null);
  });

  it("only queries retryable failures: FAILED, under max attempts, with a retained HTML body", async () => {
    mocks.findMany.mockResolvedValue([]);

    await retryFailedEmails();

    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "FAILED",
          attempts: { lt: 3 },
          htmlBody: { not: null },
        }),
      }),
    );
  });

  it("marks a successfully re-sent email as SENT and increments attempts", async () => {
    mocks.findMany.mockResolvedValue([failedEmail({ attempts: 1 })]);
    mocks.sendMail.mockResolvedValue({ messageId: "msg_1" });

    const result = await retryFailedEmails();

    expect(result).toEqual({ retried: 1, succeeded: 1, failed: 0 });
    // The row is claimed atomically (FAILED -> QUEUED, attempts incremented)
    // before the send so a concurrent/interrupted run cannot double-send (F33).
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "email_1", status: "FAILED" },
      data: expect.objectContaining({ status: "QUEUED", attempts: 2 }),
    });
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "email_1" },
        data: expect.objectContaining({ status: "SENT", messageId: "msg_1" }),
      }),
    );
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("keeps a still-retryable email FAILED and does not alert admins yet", async () => {
    mocks.findMany.mockResolvedValue([failedEmail({ attempts: 0 })]);
    mocks.sendMail.mockRejectedValue(new Error("smtp 421"));

    const result = await retryFailedEmails();

    expect(result).toEqual({ retried: 1, succeeded: 0, failed: 1 });
    // attempts incremented, status restored to FAILED for the next run
    // (the pre-send claim moved it to QUEUED).
    const updateArg = mocks.update.mock.calls[0][0];
    expect(updateArg.data.attempts).toBe(1);
    expect(updateArg.data.status).toBe("FAILED");
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("re-checks suppression and marks the row BOUNCED without sending (F26, #1885)", async () => {
    // Race: the FAILED row was created before an SNS bounce/complaint
    // suppressed the recipient. The retry must re-check and never re-deliver.
    mocks.findMany.mockResolvedValue([failedEmail({ attempts: 1 })]);
    mocks.getActiveEmailSuppression.mockResolvedValue({
      id: "sup-1",
      reason: "BOUNCE",
    });

    const result = await retryFailedEmails();

    expect(mocks.getActiveEmailSuppression).toHaveBeenCalledWith(
      "member@example.test",
    );
    expect(mocks.sendMail).not.toHaveBeenCalled();
    // Never claimed — a suppressed skip is not a retry attempt.
    expect(mocks.updateMany).not.toHaveBeenCalled();
    // Mirrors core.ts's suppressed write: BOUNCED, body dropped, same reason string.
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "email_1" },
      data: {
        status: "BOUNCED",
        htmlBody: null,
        errorMessage: "Email suppressed after SES bounce feedback",
      },
    });
    expect(result).toEqual({ retried: 0, succeeded: 0, failed: 0 });
  });

  it("does not send when the pre-send claim is lost (row already claimed/sent) (F33, #1885)", async () => {
    mocks.findMany.mockResolvedValue([failedEmail()]);
    mocks.updateMany.mockResolvedValue({ count: 0 });

    const result = await retryFailedEmails();

    expect(mocks.sendMail).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(result).toEqual({ retried: 0, succeeded: 0, failed: 0 });
  });

  it("never restores FAILED when the post-send SENT write fails, so an interrupted retry cannot re-send (F33, #1885)", async () => {
    mocks.findMany.mockResolvedValue([failedEmail()]);
    mocks.sendMail.mockResolvedValue({ messageId: "msg_1" });
    // SES accepted the message but the SENT write dies (crash-equivalent).
    mocks.update.mockRejectedValue(new Error("db connection lost"));

    const result = await retryFailedEmails();

    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    // The row must stay QUEUED (claimed) — writing FAILED back would re-send
    // an email SES already accepted on the next cron run.
    for (const call of mocks.update.mock.calls) {
      expect(call[0].data.status).not.toBe("FAILED");
    }
    expect(result).toEqual({ retried: 1, succeeded: 1, failed: 0 });
  });

  it("alerts admins when an email exhausts its retries", async () => {
    mocks.findMany.mockResolvedValue([failedEmail({ attempts: 2 })]);
    mocks.sendMail.mockRejectedValue(new Error("smtp 550"));
    mocks.memberFindMany.mockResolvedValue([{ email: "admin@example.test" }]);

    const result = await retryFailedEmails();

    expect(result).toEqual({ retried: 1, succeeded: 0, failed: 1 });
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "admin@example.test",
        templateName: "admin-email-failure",
      }),
    );
  });

  it("does not re-alert when the failing email is itself the admin failure alert", async () => {
    mocks.findMany.mockResolvedValue([
      failedEmail({ attempts: 2, templateName: "admin-email-failure" }),
    ]);
    mocks.sendMail.mockRejectedValue(new Error("smtp 550"));

    await retryFailedEmails();

    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("throws when email delivery configuration is invalid", async () => {
    mocks.resolveEmailDeliveryConfig.mockReturnValue({
      ok: false,
      transportOptions: null,
      issues: ["missing EMAIL_FROM"],
    });

    await expect(retryFailedEmails()).rejects.toThrow(/delivery config invalid/);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });
});
