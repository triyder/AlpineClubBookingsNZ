import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Guard-focused test for the membership-lockout-settings route (#1940). Mirrors
// the fee-configuration-route pattern: mock `requireAdmin` so we can assert the
// exact per-area permission each verb requires and that a denial short-circuits
// with 403 before any write.
const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  findUnique: vi.fn(),
  upsert: vi.fn(),
  auditLogCreate: vi.fn(),
  getFinancialYearResolution: vi.fn(),
  refreshFinancialYearConfig: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    membershipLockoutSettings: {
      findUnique: mocks.findUnique,
      upsert: mocks.upsert,
    },
    auditLog: { create: mocks.auditLogCreate },
  },
}));

vi.mock("@/lib/financial-year-server", () => ({
  getFinancialYearResolution: mocks.getFinancialYearResolution,
  refreshFinancialYearConfig: mocks.refreshFinancialYearConfig,
}));

import {
  GET as getLockoutSettings,
  PUT as putLockoutSettings,
} from "@/app/api/admin/membership-lockout-settings/route";

const session = {
  user: { id: "admin-1", adminPermissionMatrix: { membership: "edit" } },
};

function request(body: unknown) {
  return new NextRequest(
    "http://localhost/api/admin/membership-lockout-settings",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

describe("membership lockout settings route guards (#1940)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ ok: true, session });
    mocks.findUnique.mockResolvedValue(null);
    mocks.upsert.mockResolvedValue({
      id: "default",
      enabled: true,
      financialYearEndMonthOverride: null,
      textFallbackEnabled: true,
    });
    mocks.auditLogCreate.mockResolvedValue({});
    mocks.getFinancialYearResolution.mockResolvedValue({});
    mocks.refreshFinancialYearConfig.mockResolvedValue(3);
  });

  it("requires membership view for reads", async () => {
    const forbidden = NextResponse.json({ error: "Forbidden" }, { status: 403 });
    mocks.requireAdmin.mockResolvedValueOnce({ ok: false, response: forbidden });

    expect((await getLockoutSettings()).status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "membership", level: "view" },
    });
  });

  it("requires membership edit before parsing writes", async () => {
    const forbidden = NextResponse.json({ error: "Forbidden" }, { status: 403 });
    mocks.requireAdmin.mockResolvedValueOnce({ ok: false, response: forbidden });

    // A denied write is rejected before the body is ever parsed/persisted.
    expect((await putLockoutSettings(request({ enabled: false }))).status).toBe(
      403,
    );
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "membership", level: "edit" },
    });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("persists the update for a membership edit admin", async () => {
    const response = await putLockoutSettings(request({ enabled: false }));

    expect(response.status).toBe(200);
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.auditLogCreate).toHaveBeenCalled();
  });
});
