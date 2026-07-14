import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const values = { requireAdmin: vi.fn(), findUnique: vi.fn(), upsert: vi.fn(), auditCreate: vi.fn(), revalidatePath: vi.fn() };
  const prisma = {
    publicContentSettings: { findUnique: values.findUnique, upsert: values.upsert },
    auditLog: { create: values.auditCreate },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) => callback(prisma));
  return { ...values, prisma };
});
vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/audit", () => ({
  buildStructuredAuditLogCreateArgs: (value: unknown) => value,
  getAuditRequestContext: () => ({}),
}));

import { GET, PUT } from "@/app/api/admin/public-content-settings/route";

const existing = {
  id: "default", membershipTypes: true, entranceFees: false, hutFees: true,
  bookingPolicySummary: false, cancellationPolicy: true,
  updatedByMemberId: "admin-0", createdAt: new Date(), updatedAt: new Date(),
};

describe("public content settings route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "admin-1" } } });
    mocks.findUnique.mockResolvedValue(existing);
    mocks.upsert.mockResolvedValue(existing);
  });

  it("serializes an existing Prisma row without leaking metadata", async () => {
    const response = await GET();
    expect(mocks.requireAdmin).toHaveBeenCalledWith({ permission: { area: "content", level: "view" } });
    expect(await response.json()).toEqual({ settings: {
      membershipTypes: true, entranceFees: false, hutFees: true,
      bookingPolicySummary: false, cancellationPolicy: true,
    } });
  });

  it("audits writes and invalidates public routes", async () => {
    const body = { membershipTypes: true, entranceFees: false, hutFees: true, bookingPolicySummary: false, cancellationPolicy: true };
    const response = await PUT(new Request("http://localhost/api/admin/public-content-settings", { method: "PUT", body: JSON.stringify(body) }));
    expect(response.status).toBe(200);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({ permission: { area: "content", level: "edit" } });
    expect(mocks.auditCreate).toHaveBeenCalledOnce();
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/", "layout");
  });
});
