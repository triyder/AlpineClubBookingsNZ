import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  SubscriptionBillingError: class SubscriptionBillingError extends Error {},
  requireAdmin: vi.fn(),
  buildPreview: vi.fn(),
  confirmPreview: vi.fn(),
  enqueue: vi.fn(),
  audit: vi.fn(),
  revalidatePath: vi.fn(),
  charges: { findMany: vi.fn() },
  exceptions: { findMany: vi.fn() },
  settings: { findUnique: vi.fn(), upsert: vi.fn() },
  transaction: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/membership-subscription-billing", () => ({
  buildSubscriptionBillingPreview: mocks.buildPreview,
  confirmSubscriptionBillingPreview: mocks.confirmPreview,
  SubscriptionBillingError: mocks.SubscriptionBillingError,
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn() },
}));
vi.mock("@/lib/xero-subscription-invoices", () => ({ enqueueMembershipSubscriptionChargeOperation: mocks.enqueue }));
vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.audit }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    membershipSubscriptionCharge: mocks.charges,
    membershipBillingException: mocks.exceptions,
    membershipSubscriptionBillingSettings: mocks.settings,
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/utils", () => ({ getSeasonYear: vi.fn().mockReturnValue(2026) }));

import { GET, POST } from "@/app/api/admin/subscription-billing/route";

const preview = {
  seasonYear: 2026,
  decisionDate: "2026-07-13",
  dueDays: 30,
  scopeMemberIds: null,
  entries: [],
  exceptions: [],
  alreadyCoveredMemberIds: [],
  exemptMemberIds: [],
  totalCents: 0,
  confirmationToken: "a".repeat(64),
};

function request(body: unknown) {
  return new NextRequest("http://localhost/api/admin/subscription-billing", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("admin subscription billing route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "admin-1" } } });
    mocks.buildPreview.mockResolvedValue(preview);
    mocks.confirmPreview.mockResolvedValue({ chargeIds: ["charge-1"], exceptionCount: 0 });
    mocks.enqueue.mockResolvedValue({ queueOperationId: "op-1", message: "queued" });
    mocks.charges.findMany.mockResolvedValue([]);
    mocks.exceptions.findMany.mockResolvedValue([]);
    mocks.settings.findUnique.mockResolvedValue(null);
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback({ membershipSubscriptionBillingSettings: mocks.settings }));
  });

  it("requires finance-view permission for previews", async () => {
    const response = await GET(new NextRequest("http://localhost/api/admin/subscription-billing?seasonYear=2026&decisionDate=2026-07-13"));
    expect(response.status).toBe(200);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({ permission: { area: "finance", level: "view" } });
  });

  it("returns the default 30 due days with preview and visible queues", async () => {
    const response = await GET(new NextRequest("http://localhost/api/admin/subscription-billing?seasonYear=2026&decisionDate=2026-07-13"));
    await expect(response.json()).resolves.toMatchObject({ preview, charges: [], exceptions: [], settings: { invoiceDueDays: 30 } });
  });

  it("preserves typed billing guidance but hides unexpected preview errors", async () => {
    mocks.buildPreview.mockRejectedValueOnce(
      new mocks.SubscriptionBillingError(
        "Decision date must fall within membership year 2026."
      )
    );
    const domainResponse = await GET(
      new NextRequest(
        "http://localhost/api/admin/subscription-billing?seasonYear=2026&decisionDate=2026-07-13"
      )
    );
    expect(domainResponse.status).toBe(409);
    await expect(domainResponse.json()).resolves.toEqual({
      error: "Decision date must fall within membership year 2026.",
    });

    mocks.buildPreview.mockRejectedValueOnce(
      new Error('password authentication failed for user "app_rw"')
    );
    const unexpectedResponse = await GET(
      new NextRequest(
        "http://localhost/api/admin/subscription-billing?seasonYear=2026&decisionDate=2026-07-13"
      )
    );
    expect(unexpectedResponse.status).toBe(500);
    await expect(unexpectedResponse.json()).resolves.toEqual({
      error: "Could not build subscription billing preview.",
    });
  });

  it("deduplicates a persisted exception already present in the current preview", async () => {
    mocks.buildPreview.mockResolvedValue({
      ...preview,
      exceptions: [{ fingerprint: "same", message: "Current exception" }],
    });
    mocks.exceptions.findMany.mockResolvedValue([
      { id: "persisted-same", fingerprint: "same", message: "Current exception" },
      { id: "persisted-other", fingerprint: "other", message: "Earlier exception" },
    ]);
    const response = await GET(new NextRequest("http://localhost/api/admin/subscription-billing?seasonYear=2026&decisionDate=2026-07-13"));
    await expect(response.json()).resolves.toMatchObject({
      exceptions: [{ id: "persisted-other", fingerprint: "other" }],
    });
  });

  it("rejects an annual run without the literal explicit confirmation", async () => {
    const response = await POST(request({
      action: "CONFIRM_ANNUAL_BATCH", seasonYear: 2026, decisionDate: "2026-07-13",
      confirmationToken: "a".repeat(64), confirmed: false,
    }));
    expect(response.status).toBe(400);
    expect(mocks.confirmPreview).not.toHaveBeenCalled();
  });

  it("rejects a stale preview and creates no charge or provider work", async () => {
    const response = await POST(request({
      action: "CONFIRM_ANNUAL_BATCH", seasonYear: 2026, decisionDate: "2026-07-13",
      confirmationToken: "b".repeat(64), confirmed: true,
    }));
    expect(response.status).toBe(409);
    expect(mocks.confirmPreview).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("confirms the unchanged snapshot and reports durable queue feedback", async () => {
    const response = await POST(request({
      action: "CONFIRM_ANNUAL_BATCH", seasonYear: 2026, decisionDate: "2026-07-13",
      confirmationToken: "a".repeat(64), confirmed: true,
    }));
    expect(response.status).toBe(200);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({ permission: { area: "finance", level: "edit" } });
    expect(mocks.confirmPreview).toHaveBeenCalledWith(expect.objectContaining({ source: "ANNUAL_BATCH", confirmedByMemberId: "admin-1" }));
    expect(mocks.enqueue).toHaveBeenCalledWith("charge-1", { createdByMemberId: "admin-1" });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/admin/subscriptions");
  });

  it("updates due days and audits the finance mutation", async () => {
    const response = await POST(request({ action: "UPDATE_SETTINGS", invoiceDueDays: 45 }));
    expect(response.status).toBe(200);
    expect(mocks.settings.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ invoiceDueDays: 45 }) }));
    // A plain due-days save never writes the family billing mode.
    expect(mocks.settings.upsert.mock.calls[0][0].update.familyBillingMode).toBeUndefined();
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "membership-subscription-billing.settings.update" }), expect.anything());
  });

  it("defaults the family billing mode in the preview settings", async () => {
    const response = await GET(new NextRequest("http://localhost/api/admin/subscription-billing?seasonYear=2026&decisionDate=2026-07-13"));
    await expect(response.json()).resolves.toMatchObject({ settings: { familyBillingMode: "BILL_FAMILY_VIA_BILLING_MEMBER" } });
  });

  it("persists and audits the family billing mode when provided", async () => {
    const response = await POST(request({ action: "UPDATE_SETTINGS", invoiceDueDays: 30, familyBillingMode: "BILL_MEMBERS_INDIVIDUALLY" }));
    expect(response.status).toBe(200);
    expect(mocks.settings.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ invoiceDueDays: 30, familyBillingMode: "BILL_MEMBERS_INDIVIDUALLY" }),
      create: expect.objectContaining({ id: "default", familyBillingMode: "BILL_MEMBERS_INDIVIDUALLY" }),
    }));
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ details: JSON.stringify({ invoiceDueDays: 30, familyBillingMode: "BILL_MEMBERS_INDIVIDUALLY" }) }),
      expect.anything(),
    );
  });

  it("rejects an invalid family billing mode", async () => {
    const response = await POST(request({ action: "UPDATE_SETTINGS", invoiceDueDays: 30, familyBillingMode: "NONSENSE" }));
    expect(response.status).toBe(400);
    expect(mocks.settings.upsert).not.toHaveBeenCalled();
  });

  it("queues email/invoice retry without creating provider work inline", async () => {
    const response = await POST(request({ action: "RETRY_CHARGE", chargeId: "charge-1" }));
    expect(response.status).toBe(200);
    expect(mocks.enqueue).toHaveBeenCalledWith("charge-1", { createdByMemberId: "admin-1" });
  });

  it("does not return unexpected provider queue details from a billing action", async () => {
    mocks.enqueue.mockRejectedValueOnce(
      new Error("Xero tenant secret-tenant-id rejected the invoice")
    );
    const response = await POST(
      request({ action: "RETRY_CHARGE", chargeId: "charge-1" })
    );
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Subscription billing action failed.",
    });
  });

  it("returns the guard response before reading any billing data", async () => {
    mocks.requireAdmin.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) });
    const response = await GET(new NextRequest("http://localhost/api/admin/subscription-billing"));
    expect(response.status).toBe(403);
    expect(mocks.buildPreview).not.toHaveBeenCalled();
  });
});
