// Issue #1946 review (FIX-1): the members CSV export must emit the cancellation
// date as an NZ date-only value under the "Cancelled At" header so it round-trips
// back through the member import. A full ISO datetime fails the import's
// date-only parser, and its UTC calendar date can trail the NZ date by a day for
// an early-morning-NZ cancellation. These tests drive the real export route and
// feed its output straight back into the import preview.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findMany: vi.fn() },
  },
}));

const mockRequireAdmin = vi.fn();
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn() }));
vi.mock("@/lib/member-fields-settings", () => ({
  loadMemberFieldsFlags: vi
    .fn()
    .mockResolvedValue({
      showTitle: false,
      showGender: false,
      showOccupation: false,
    }),
}));
vi.mock("@/lib/age-tier", () => ({
  getAgeTierSettings: vi.fn().mockResolvedValue([]),
}));

import { prisma } from "@/lib/prisma";
import { GET as exportMembers } from "@/app/api/admin/members/export/route";
import { formatDateOnlyForTimeZone } from "@/lib/date-only";
import {
  buildMemberImportPreview,
  inferMemberImportColumnMapping,
  parseMemberImportCsv,
} from "@/lib/member-csv-import";

const adminGuard = {
  ok: true,
  session: { user: { id: "actor1", role: "ADMIN", accessRoles: ["ADMIN"] } },
};

function baseMember(overrides: Record<string, unknown> = {}) {
  return {
    title: null,
    firstName: "Cora",
    lastName: "Cancelled",
    gender: null,
    occupation: null,
    email: "cora@example.com",
    phoneCountryCode: null,
    phoneAreaCode: null,
    phoneNumber: null,
    dateOfBirth: null,
    role: "USER",
    financeAccessLevel: "NONE",
    ageTier: "ADULT",
    active: false,
    cancelledAt: new Date("2020-06-30T14:30:00.000Z"),
    archivedAt: null,
    xeroContactId: null,
    createdAt: new Date("2019-01-01T00:00:00.000Z"),
    streetAddressLine1: null,
    streetAddressLine2: null,
    streetCity: null,
    streetRegion: null,
    streetCountry: null,
    streetPostalCode: null,
    lifeMemberDate: null,
    comments: null,
    subscriptions: [],
    seasonalMembershipAssignments: [],
    ...overrides,
  };
}

function exportRequest() {
  return exportMembers(
    new NextRequest("http://localhost/api/admin/members/export"),
  );
}

function cellByHeader(csv: string, header: string) {
  const [headerLine, dataLine] = csv.split("\r\n");
  const headers = headerLine.split(",");
  const index = headers.indexOf(header);
  return { index, value: dataLine.split(",")[index] };
}

describe("issue #1946 — members export cancelled date round-trip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue(adminGuard);
  });

  it("emits the cancelled date as an NZ date-only, not a full ISO datetime", async () => {
    vi.mocked(prisma.member.findMany).mockResolvedValue([baseMember()] as never);

    const res = await exportRequest();
    expect(res.status).toBe(200);
    const csv = await res.text();

    const { value } = cellByHeader(csv, "Cancelled At");
    // Date-only, no time component.
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(value).not.toContain("T");
    // 2020-06-30T14:30Z is 2020-07-01 in NZ winter (+12): the NZ calendar date
    // is one day ahead of the naive UTC slice, which is the bug this fixes.
    expect(value).toBe(
      formatDateOnlyForTimeZone(new Date("2020-06-30T14:30:00.000Z")),
    );
    expect(value).toBe("2020-07-01");
    expect(value).not.toBe("2020-06-30");
  });

  it("emits an empty cell for a member with no cancellation", async () => {
    vi.mocked(prisma.member.findMany).mockResolvedValue([
      baseMember({ active: true, cancelledAt: null }),
    ] as never);

    const res = await exportRequest();
    const csv = await res.text();
    const { value } = cellByHeader(csv, "Cancelled At");
    expect(value).toBe("");
  });

  it("round-trips the exported CSV back through the member import cleanly", async () => {
    vi.mocked(prisma.member.findMany).mockResolvedValue([baseMember()] as never);

    const res = await exportRequest();
    const csv = await res.text();

    // Feed the exact exported CSV straight back into the import.
    const parsed = parseMemberImportCsv(csv);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const mapping = inferMemberImportColumnMapping(parsed.data.headers);
    // The "Cancelled At" header auto-maps to the cancelledDate field.
    expect(mapping.cancelledDate).not.toBeNull();

    const preview = buildMemberImportPreview(parsed.data, mapping);
    expect(preview.hasErrors).toBe(false);
    // Same NZ calendar date survives the round-trip.
    expect(preview.rows[0].normalizedDateValues.cancelledDate).toBe(
      "2020-07-01",
    );
  });
});
