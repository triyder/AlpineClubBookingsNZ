import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getXeroMemberGroupingSnapshot: vi.fn(),
  runXeroMemberGroupingBulkResyncChunk: vi.fn(),
  getXeroGroupingMode: vi.fn(),
  getXeroContactGroups: vi.fn(),
  getXeroContactGroupCacheLastRefreshedAt: vi.fn(),
  isXeroConnected: vi.fn(),
  logAudit: vi.fn(),
  ruleFindMany: vi.fn(),
  ruleFindFirst: vi.fn(),
  ruleCreate: vi.fn(),
  ruleUpdate: vi.fn(),
  ruleDelete: vi.fn(),
  settingsUpsert: vi.fn(),
  membershipTypeFindMany: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/xero-member-grouping-resync", () => ({
  getXeroMemberGroupingSnapshot: mocks.getXeroMemberGroupingSnapshot,
  runXeroMemberGroupingBulkResyncChunk: mocks.runXeroMemberGroupingBulkResyncChunk,
}));
vi.mock("@/lib/xero-member-grouping", () => ({
  getXeroGroupingMode: mocks.getXeroGroupingMode,
}));
vi.mock("@/lib/xero", () => ({
  getXeroContactGroups: mocks.getXeroContactGroups,
  getXeroContactGroupCacheLastRefreshedAt:
    mocks.getXeroContactGroupCacheLastRefreshedAt,
}));
vi.mock("@/lib/xero-token-store", () => ({
  isXeroConnected: mocks.isXeroConnected,
}));
vi.mock("@/lib/audit", () => ({ logAudit: mocks.logAudit }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroContactGroupRule: {
      findMany: mocks.ruleFindMany,
      findFirst: mocks.ruleFindFirst,
      create: mocks.ruleCreate,
      update: mocks.ruleUpdate,
      delete: mocks.ruleDelete,
    },
    xeroGroupingSettings: { upsert: mocks.settingsUpsert },
    membershipType: { findMany: mocks.membershipTypeFindMany },
  },
}));

import { GET, POST } from "@/app/api/admin/xero/member-grouping/route";

// Real admin-permissions resolution: FINANCE_USER -> finance:view,
// FINANCE_ADMIN -> finance:edit. The route's per-action edit check runs
// against these for real.
const financeViewUser = {
  id: "admin_view",
  role: "USER",
  accessRoles: [{ role: "FINANCE_USER" }],
};
const financeEditUser = {
  id: "admin_edit",
  role: "USER",
  accessRoles: [{ role: "FINANCE_ADMIN" }],
};

function grantSession(user: typeof financeViewUser) {
  mocks.requireAdmin.mockResolvedValue({ ok: true, session: { user } });
}

function postRequest(body: unknown) {
  return new NextRequest("http://localhost/api/admin/xero/member-grouping", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const snapshot = {
  mode: "MEMBERSHIP_TYPE_AND_AGE",
  cacheReady: true,
  lastRefreshedAt: "2026-07-16T00:00:00.000Z",
  activeRuleCount: 2,
  membersConsidered: 5,
  mismatchCount: 1,
  addCount: 1,
  removeCount: 0,
  estimatedXeroCalls: 3,
  skippedNoContact: [],
  mismatches: [],
  informationalCount: 0,
  informational: [],
};

describe("admin Xero member-grouping route (view/edit gating, #1934)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    grantSession(financeEditUser);
    mocks.getXeroGroupingMode.mockResolvedValue("MEMBERSHIP_TYPE_AND_AGE");
    mocks.ruleFindMany.mockResolvedValue([]);
    mocks.ruleFindFirst.mockResolvedValue(null);
    mocks.getXeroContactGroups.mockResolvedValue([]);
    mocks.getXeroContactGroupCacheLastRefreshedAt.mockResolvedValue(null);
    mocks.membershipTypeFindMany.mockResolvedValue([]);
    mocks.getXeroMemberGroupingSnapshot.mockResolvedValue(snapshot);
    mocks.isXeroConnected.mockResolvedValue(true);
    mocks.settingsUpsert.mockResolvedValue({});
    mocks.logAudit.mockResolvedValue(undefined);
  });

  it("guards GET with finance:view", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "finance", level: "view" },
    });
  });

  it("guards POST with finance:view (not the path-inferred finance:edit)", async () => {
    grantSession(financeViewUser);
    const res = await POST(postRequest({ action: "dry-run" }));
    expect(res.status).toBe(200);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "finance", level: "view" },
    });
  });

  it("allows a finance:view admin to run the dry-run (200)", async () => {
    grantSession(financeViewUser);
    const res = await POST(postRequest({ action: "dry-run", limit: 50 }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ snapshot });
    expect(mocks.getXeroMemberGroupingSnapshot).toHaveBeenCalledWith({ limit: 50 });
  });

  it("rejects set-mode for a finance:view admin (403), no write", async () => {
    grantSession(financeViewUser);
    const res = await POST(postRequest({ action: "set-mode", mode: "NONE" }));
    expect(res.status).toBe(403);
    expect(mocks.settingsUpsert).not.toHaveBeenCalled();
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });

  it("rejects bulk-resync for a finance:view admin (403), no run", async () => {
    grantSession(financeViewUser);
    const res = await POST(
      postRequest({ action: "bulk-resync", confirmDryRunReviewed: true }),
    );
    expect(res.status).toBe(403);
    expect(mocks.runXeroMemberGroupingBulkResyncChunk).not.toHaveBeenCalled();
  });

  it("returns a clean 409 for bulk-resync when Xero is not connected", async () => {
    mocks.isXeroConnected.mockResolvedValue(false);
    const res = await POST(
      postRequest({ action: "bulk-resync", confirmDryRunReviewed: true }),
    );
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: "Xero is not connected. Connect Xero before running a bulk re-sync.",
    });
    expect(mocks.runXeroMemberGroupingBulkResyncChunk).not.toHaveBeenCalled();
  });

  it("caps the bulk-resync chunk limit at 100", async () => {
    const res = await POST(
      postRequest({ action: "bulk-resync", confirmDryRunReviewed: true, limit: 500 }),
    );
    expect(res.status).toBe(400);
    expect(mocks.runXeroMemberGroupingBulkResyncChunk).not.toHaveBeenCalled();
  });

  it("runs bulk-resync with the resume cursor and returns the chunk result", async () => {
    const result = {
      mode: "MEMBERSHIP_TYPE_AND_AGE",
      processed: 1,
      added: 1,
      removed: 0,
      noop: 0,
      failed: 0,
      failures: [],
      nextCursorMemberId: "m9",
      done: false,
      haltedByDailyLimit: false,
    };
    mocks.runXeroMemberGroupingBulkResyncChunk.mockResolvedValue(result);
    const res = await POST(
      postRequest({
        action: "bulk-resync",
        confirmDryRunReviewed: true,
        limit: 25,
        afterMemberId: "m5",
      }),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ result });
    expect(mocks.runXeroMemberGroupingBulkResyncChunk).toHaveBeenCalledWith({
      limit: 25,
      afterMemberId: "m5",
      createdByMemberId: "admin_edit",
    });
  });

  it("allows set-mode for a finance:edit admin", async () => {
    const res = await POST(postRequest({ action: "set-mode", mode: "NONE" }));
    expect(res.status).toBe(200);
    expect(mocks.settingsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "default" },
        update: { mode: "NONE", updatedByMemberId: "admin_edit" },
      }),
    );
  });
});
