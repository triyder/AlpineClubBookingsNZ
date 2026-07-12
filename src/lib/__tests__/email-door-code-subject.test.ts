import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Live credentials must never reach an email subject: EmailLog persists the
// subject for every template (including sensitive ones whose HTML is not
// retained) and subjects travel in clear mail headers. These tests prove the
// defence-in-depth render path holds even when a malicious or pre-validation
// stored override puts a sensitive placeholder or literal value in a subject.

const LIVE_DOOR_CODE = "97531";
const LIVE_CHORE_LINK = "https://bookings.example.org/chores/live-bearer-token";

const { mockPrisma, mockTransporter, mockLogger } = vi.hoisted(() => {
  const mockTransporter = {
    sendMail: vi.fn().mockResolvedValue({ messageId: "msg-door-code-test" }),
  };
  const mockPrisma = {
    emailLog: {
      create: vi.fn().mockResolvedValue({ id: "log-door-code-test" }),
      update: vi.fn().mockResolvedValue({}),
    },
    emailSuppression: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    emailMessageSetting: {
      findUnique: vi.fn(),
    },
    // Lodge identity (name, travel note, door code) now resolves from the Lodge
    // table — the default lodge when a send carries no explicit lodgeId.
    lodge: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    emailTemplateOverride: {
      findUnique: vi.fn(),
    },
  };
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  return { mockPrisma, mockTransporter, mockLogger };
});

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: () => mockTransporter,
  },
}));

vi.mock("@/lib/logger", () => ({
  default: mockLogger,
}));

import {
  sendBookingConfirmedEmail,
  sendChoreRosterEmail,
  sendPreArrivalReminderEmail,
} from "@/lib/email";

function mockStoredOverride(templateName: string, subject: string) {
  mockPrisma.emailTemplateOverride.findUnique.mockImplementation(
    (args: { where: { templateName: string } }) =>
      Promise.resolve(
        args.where.templateName === templateName
          ? {
              templateName,
              subject,
              bodyText: null,
              updatedAt: new Date("2026-06-01T00:00:00.000Z"),
              updatedByMemberId: "admin-1",
            }
          : null,
      ),
  );
}

function allLoggedOutput(): string {
  return JSON.stringify([
    ...mockLogger.debug.mock.calls,
    ...mockLogger.info.mock.calls,
    ...mockLogger.warn.mock.calls,
    ...mockLogger.error.mock.calls,
  ]);
}

describe("sensitive values never reach email subjects, EmailLog, or app logs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "production");
    mockPrisma.emailMessageSetting.findUnique.mockResolvedValue({
      id: "default",
    });
    // The live door code and travel note come from the default lodge, resolved
    // from the Lodge table (no explicit lodgeId on these sends).
    mockPrisma.lodge.findFirst.mockResolvedValue({
      name: "Test Club Lodge",
      travelNote: "Drive carefully up the mountain road.",
      doorCode: LIVE_DOOR_CODE,
    });
    mockPrisma.emailTemplateOverride.findUnique.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("neutralises {{doorCode}} in a stored booking-confirmed override subject", async () => {
    mockStoredOverride(
      "booking-confirmed",
      "Door code {{doorCode}} - {{CLUB_LODGE_NAME}}",
    );

    await sendBookingConfirmedEmail(
      "member@example.com",
      "Ada",
      new Date("2026-07-10T00:00:00.000Z"),
      new Date("2026-07-12T00:00:00.000Z"),
      2,
      12300,
    );

    expect(mockTransporter.sendMail).toHaveBeenCalledTimes(1);
    const sent = mockTransporter.sendMail.mock.calls[0][0];
    // Subject and headers never carry the live code or the raw placeholder.
    expect(sent.subject).not.toContain(LIVE_DOOR_CODE);
    expect(sent.subject).not.toMatch(/\{\{\s*doorCode\s*\}\}/);
    // The feature still works: the code is delivered in the message body.
    expect(sent.html).toContain(LIVE_DOOR_CODE);

    // EmailLog never receives the code: subject is scrubbed and the HTML body
    // is not retained for this sensitive template.
    expect(mockPrisma.emailLog.create).toHaveBeenCalledTimes(1);
    const logged = mockPrisma.emailLog.create.mock.calls[0][0].data;
    expect(logged.subject).not.toContain(LIVE_DOOR_CODE);
    expect(logged.htmlBody).toBeNull();

    // Application logs never contain the live code.
    expect(allLoggedOutput()).not.toContain(LIVE_DOOR_CODE);
  });

  it("neutralises {{doorCode}} in a stored pre-arrival-reminder override subject", async () => {
    mockStoredOverride(
      "pre-arrival-reminder",
      "{{doorCode}} ready - {{CLUB_LODGE_NAME}}",
    );

    await sendPreArrivalReminderEmail({
      email: "member@example.com",
      firstName: "Ada",
      checkIn: new Date("2026-07-10T00:00:00.000Z"),
      checkOut: new Date("2026-07-12T00:00:00.000Z"),
      guestCount: 2,
      expectedArrivalTime: "16:30",
    });

    expect(mockTransporter.sendMail).toHaveBeenCalledTimes(1);
    const sent = mockTransporter.sendMail.mock.calls[0][0];
    expect(sent.subject).not.toContain(LIVE_DOOR_CODE);
    expect(sent.subject).not.toMatch(/\{\{\s*doorCode\s*\}\}/);
    expect(sent.html).toContain(LIVE_DOOR_CODE);

    expect(mockPrisma.emailLog.create).toHaveBeenCalledTimes(1);
    const logged = mockPrisma.emailLog.create.mock.calls[0][0].data;
    expect(logged.subject).not.toContain(LIVE_DOOR_CODE);
    expect(logged.htmlBody).toBeNull();

    expect(allLoggedOutput()).not.toContain(LIVE_DOOR_CODE);
  });

  it("scrubs a literal live code typed directly into an override subject", async () => {
    mockStoredOverride(
      "booking-confirmed",
      `Use ${LIVE_DOOR_CODE} at the door - {{CLUB_LODGE_NAME}}`,
    );

    await sendBookingConfirmedEmail(
      "member@example.com",
      "Ada",
      new Date("2026-07-10T00:00:00.000Z"),
      new Date("2026-07-12T00:00:00.000Z"),
      2,
      12300,
    );

    expect(mockTransporter.sendMail).toHaveBeenCalledTimes(1);
    const sent = mockTransporter.sendMail.mock.calls[0][0];
    expect(sent.subject).not.toContain(LIVE_DOOR_CODE);

    const logged = mockPrisma.emailLog.create.mock.calls[0][0].data;
    expect(logged.subject).not.toContain(LIVE_DOOR_CODE);
    expect(allLoggedOutput()).not.toContain(LIVE_DOOR_CODE);
  });

  it("neutralises a chore link in a legacy stored chore-roster subject", async () => {
    mockStoredOverride(
      "chore-roster",
      `Complete your chores: {{choreLink}} ${LIVE_CHORE_LINK} - {{CLUB_LODGE_NAME}}`,
    );

    await sendChoreRosterEmail(
      "member@example.com",
      "Ada",
      "2026-07-10",
      [{ name: "Sweep the kitchen", description: null }],
      LIVE_CHORE_LINK,
    );

    expect(mockTransporter.sendMail).toHaveBeenCalledTimes(1);
    const sent = mockTransporter.sendMail.mock.calls[0][0];
    expect(sent.subject).not.toContain(LIVE_CHORE_LINK);
    expect(sent.subject).not.toMatch(/\{\{\s*choreLink\s*\}\}/);
    expect(sent.html).toContain(LIVE_CHORE_LINK);

    expect(mockPrisma.emailLog.create).toHaveBeenCalledTimes(1);
    const logged = mockPrisma.emailLog.create.mock.calls[0][0].data;
    expect(logged.subject).not.toContain(LIVE_CHORE_LINK);
    expect(logged.htmlBody).toBeNull();
    expect(allLoggedOutput()).not.toContain(LIVE_CHORE_LINK);
  });

  it("keeps the default subject clean when no override exists", async () => {
    await sendBookingConfirmedEmail(
      "member@example.com",
      "Ada",
      new Date("2026-07-10T00:00:00.000Z"),
      new Date("2026-07-12T00:00:00.000Z"),
      2,
      12300,
    );

    expect(mockTransporter.sendMail).toHaveBeenCalledTimes(1);
    const sent = mockTransporter.sendMail.mock.calls[0][0];
    expect(sent.subject).toContain("Booking Confirmed");
    expect(sent.subject).not.toContain(LIVE_DOOR_CODE);
    expect(sent.html).toContain(LIVE_DOOR_CODE);

    const logged = mockPrisma.emailLog.create.mock.calls[0][0].data;
    expect(logged.subject).not.toContain(LIVE_DOOR_CODE);
    expect(logged.htmlBody).toBeNull();
    expect(allLoggedOutput()).not.toContain(LIVE_DOOR_CODE);
  });
});
