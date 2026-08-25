import { beforeEach, describe, expect, it, vi } from "vitest";

// Fork #38 — the stored `bodyMarkdown` flag on EmailTemplateOverride decides
// which body renderer a SEND uses. The two directions that matter: a row
// saved from the markdown-lite editor renders the vocabulary, and a legacy
// row (flag false or absent from a pre-migration read) renders byte-for-byte
// through the plain path, so an old body containing a literal asterisk is
// never reinterpreted.

const { findUniqueMock, loadLodgeSettingsMock } = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  loadLodgeSettingsMock: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { emailTemplateOverride: { findUnique: findUniqueMock } },
}));

vi.mock("@/lib/email-message-settings", () => ({
  EMAIL_DEFAULT_LODGE_NAME: "Example Club Lodge",
  EMAIL_DEFAULT_FROM_NAME: "Example Club - Online Booking System",
  loadEmailMessageSettingsForLodge: loadLodgeSettingsMock,
  loadEmailMessageSettings: loadLodgeSettingsMock,
  applyEmailMessageSettingsToHtml: vi.fn((html: string) => html),
  applyEmailMessageSettingsToSubject: vi.fn((subject: string) => subject),
  buildEmailTemplateGlobalData: vi.fn(() => ({})),
}));

import { prepareEmailMessage } from "@/lib/email-message-renderer";

const OVERRIDE_BASE = {
  templateName: "booking-confirmed",
  subject: null,
  bodyText: "Booking Confirmed\n\nHi {{firstName}}, **see you soon**.",
  updatedAt: new Date(),
  updatedByMemberId: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  loadLodgeSettingsMock.mockResolvedValue({
    lodgeName: "Example Club Lodge",
    lodgeTravelNote: "Take the Bruce Road.",
    doorCode: null,
  });
});

async function renderWith(override: Record<string, unknown> | null) {
  findUniqueMock.mockResolvedValue(override);
  return prepareEmailMessage({
    templateName: "booking-confirmed",
    subject: "Subject",
    html: "<original-file-template/>",
    templateData: { firstName: "Sam" },
  });
}

describe("prepareEmailMessage and the bodyMarkdown flag", () => {
  it("renders the markdown-lite vocabulary when the stored row says so", async () => {
    const prepared = await renderWith({ ...OVERRIDE_BASE, bodyMarkdown: true });
    expect(prepared.bodyOverrideApplied).toBe(true);
    expect(prepared.html).toContain("Hi Sam, <strong>see you soon</strong>.");
  });

  it("keeps a flag-false row on the plain path — the asterisks stay literal", async () => {
    const prepared = await renderWith({ ...OVERRIDE_BASE, bodyMarkdown: false });
    expect(prepared.html).toContain("Hi Sam, **see you soon**.");
    expect(prepared.html).not.toContain("<strong>");
  });

  it("treats a pre-migration row with NO flag field exactly like flag false", async () => {
    const prepared = await renderWith({ ...OVERRIDE_BASE });
    expect(prepared.html).toContain("Hi Sam, **see you soon**.");
    expect(prepared.html).not.toContain("<strong>");
  });
});
