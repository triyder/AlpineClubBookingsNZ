import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const values = {
  requireAdmin: vi.fn(),
  hasAdminAreaAccess: vi.fn(),
  revalidatePath: vi.fn(),
  createAuditLog: vi.fn(),
  membershipTypeFindMany: vi.fn(),
  membershipTypeFindUnique: vi.fn(),
  membershipFeeFindFirst: vi.fn(),
  membershipFeeFindUnique: vi.fn(),
  membershipFeeCreate: vi.fn(),
  membershipFeeUpdate: vi.fn(),
  membershipFeeDelete: vi.fn(),
  entranceFeeFindMany: vi.fn(),
  entranceFeeFindFirst: vi.fn(),
  entranceFeeFindUnique: vi.fn(),
  entranceFeeCreate: vi.fn(),
  entranceFeeUpdate: vi.fn(),
  entranceFeeDelete: vi.fn(),
  familyGroupFindMany: vi.fn(),
  familyGroupFindUnique: vi.fn(),
  familyGroupUpdate: vi.fn(),
  familyGroupMemberFindUnique: vi.fn(),
  itemMappingFindFirst: vi.fn(),
  accountMappingFindUnique: vi.fn(),
  billingSettingsFindUnique: vi.fn(),
    executeRaw: vi.fn(),
  };
  const prisma = {
  membershipType: { findMany: values.membershipTypeFindMany, findUnique: values.membershipTypeFindUnique },
  membershipAnnualFee: {
    findFirst: values.membershipFeeFindFirst, findUnique: values.membershipFeeFindUnique,
    create: values.membershipFeeCreate, update: values.membershipFeeUpdate, delete: values.membershipFeeDelete,
  },
  entranceFee: {
    findMany: values.entranceFeeFindMany, findFirst: values.entranceFeeFindFirst,
    findUnique: values.entranceFeeFindUnique, create: values.entranceFeeCreate,
    update: values.entranceFeeUpdate, delete: values.entranceFeeDelete,
  },
  familyGroup: { findMany: values.familyGroupFindMany, findUnique: values.familyGroupFindUnique, update: values.familyGroupUpdate },
  familyGroupMember: { findUnique: values.familyGroupMemberFindUnique },
  xeroItemCodeMapping: { findFirst: values.itemMappingFindFirst },
  xeroAccountMapping: { findUnique: values.accountMappingFindUnique },
  membershipSubscriptionBillingSettings: { findUnique: values.billingSettingsFindUnique },
  $executeRaw: values.executeRaw,
  $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) => callback(prisma));
  return { ...values, prisma };
});

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/admin-permissions", () => ({ hasAdminAreaAccess: mocks.hasAdminAreaAccess }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.createAuditLog }));

import { GET, POST } from "@/app/api/admin/fee-configuration/route";

const session = { user: { id: "admin-1", adminPermissionMatrix: { finance: "edit" } } };
function post(body: unknown) {
  return POST(new Request("http://localhost/api/admin/fee-configuration", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
}

describe("fee configuration route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ ok: true, session });
    mocks.hasAdminAreaAccess.mockReturnValue(true);
    mocks.membershipTypeFindMany.mockResolvedValue([]);
    mocks.membershipTypeFindUnique.mockResolvedValue({ id: "type-1" });
    mocks.membershipFeeFindFirst.mockResolvedValue(null);
    mocks.membershipFeeFindUnique.mockResolvedValue(null);
    mocks.membershipFeeCreate.mockResolvedValue({ id: "fee-1" });
    mocks.membershipFeeUpdate.mockResolvedValue({ id: "fee-1" });
    mocks.membershipFeeDelete.mockResolvedValue({ id: "fee-1" });
    mocks.entranceFeeFindMany.mockResolvedValue([]);
    mocks.entranceFeeFindFirst.mockResolvedValue(null);
    mocks.entranceFeeFindUnique.mockResolvedValue(null);
    mocks.entranceFeeCreate.mockResolvedValue({ id: "entrance-1" });
    mocks.entranceFeeUpdate.mockResolvedValue({ id: "entrance-1" });
    mocks.entranceFeeDelete.mockResolvedValue({ id: "entrance-1" });
    mocks.familyGroupFindMany.mockResolvedValue([]);
    mocks.familyGroupFindUnique.mockResolvedValue({ id: "family-1" });
    mocks.familyGroupMemberFindUnique.mockResolvedValue({ id: "membership-1", member: { active: true, archivedAt: null } });
    mocks.familyGroupUpdate.mockResolvedValue({ id: "family-1" });
    mocks.itemMappingFindFirst.mockResolvedValue(null);
    mocks.accountMappingFindUnique.mockResolvedValue(null);
    // No settings row -> behaviour-preserving default (family billing mode).
    mocks.billingSettingsFindUnique.mockResolvedValue(null);
  });

  it("requires finance view for reads", async () => {
    const response = Response.json({ error: "Forbidden" }, { status: 403 });
    mocks.requireAdmin.mockResolvedValueOnce({ ok: false, response });
    expect((await GET()).status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({ permission: { area: "finance", level: "view" } });
  });

  it("requires finance edit before parsing writes", async () => {
    const forbidden = Response.json({ error: "Forbidden" }, { status: 403 });
    mocks.requireAdmin.mockResolvedValueOnce({ ok: false, response: forbidden });
    expect((await post({ action: "not-even-parsed" })).status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({ permission: { area: "finance", level: "edit" } });
  });

  it("rejects invalid mutation input", async () => {
    expect((await post({ action: "CREATE_ENTRANCE_FEE", category: "ADULT", amountCents: 12.5, effectiveFrom: "bad" })).status).toBe(400);
  });

  it("returns an explicit read-only capability for finance viewers", async () => {
    mocks.hasAdminAreaAccess.mockReturnValue(false);
    await expect((await GET()).json()).resolves.toMatchObject({ canEdit: false });
  });

  it("creates and audits a membership schedule, then invalidates public pages", async () => {
    const response = await post({
      action: "CREATE_MEMBERSHIP_FEE", membershipTypeId: "type-1", amountCents: 12345,
      billingBasis: "PER_MEMBER", prorationRule: "NONE", effectiveFrom: "2026-07-13", effectiveTo: null,
    });
    expect(response.status).toBe(200);
    expect(mocks.membershipFeeCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ membershipTypeId: "type-1", amountCents: 12345 }) });
    expect(mocks.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "fee-configuration.create_membership_fee", targetId: "fee-1" }), mocks.prisma);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("updates and deletes an entrance schedule", async () => {
    mocks.entranceFeeFindUnique.mockResolvedValue({ id: "entrance-1", category: "ADULT" });
    expect((await post({ action: "UPDATE_ENTRANCE_FEE", id: "entrance-1", amountCents: 5000, effectiveFrom: "2026-08-01", effectiveTo: null })).status).toBe(200);
    expect(mocks.entranceFeeUpdate).toHaveBeenCalledWith({ where: { id: "entrance-1" }, data: expect.objectContaining({ amountCents: 5000 }) });
    expect((await post({ action: "DELETE_ENTRANCE_FEE", id: "entrance-1" })).status).toBe(200);
    expect(mocks.entranceFeeDelete).toHaveBeenCalledWith({ where: { id: "entrance-1" } });
  });

  it("updates/deletes membership, creates entrance, clears family, and revalidates every action", async () => {
    mocks.membershipFeeFindUnique.mockResolvedValue({ id: "fee-1", membershipTypeId: "type-1" });
    expect((await post({ action: "UPDATE_MEMBERSHIP_FEE", id: "fee-1", amountCents: 2000, billingBasis: "PER_MEMBER", prorationRule: "NONE", effectiveFrom: "2026-08-01", effectiveTo: null })).status).toBe(200);
    expect((await post({ action: "DELETE_MEMBERSHIP_FEE", id: "fee-1" })).status).toBe(200);
    expect((await post({ action: "CREATE_ENTRANCE_FEE", category: "YOUTH", amountCents: 2500, effectiveFrom: "2026-08-01", effectiveTo: null })).status).toBe(200);
    expect((await post({ action: "SET_FAMILY_BILLING_MEMBER", familyGroupId: "family-1", billingMemberId: null })).status).toBe(200);
    expect(mocks.familyGroupUpdate).toHaveBeenCalledWith({ where: { id: "family-1" }, data: { billingMembershipId: null } });
    expect(mocks.revalidatePath).toHaveBeenCalledTimes(4);
  });

  it("returns not found for stale update and delete targets", async () => {
    expect((await post({ action: "UPDATE_MEMBERSHIP_FEE", id: "missing", amountCents: 2000, billingBasis: "PER_MEMBER", prorationRule: "NONE", effectiveFrom: "2026-08-01", effectiveTo: null })).status).toBe(404);
    expect((await post({ action: "DELETE_ENTRANCE_FEE", id: "missing" })).status).toBe(404);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("rejects an overlapping range without writing", async () => {
    mocks.membershipFeeFindFirst.mockResolvedValueOnce({ id: "existing" });
    const response = await post({
      action: "CREATE_MEMBERSHIP_FEE", membershipTypeId: "type-1", amountCents: 100,
      billingBasis: "PER_MEMBER", prorationRule: "NONE", effectiveFrom: "2026-07-13", effectiveTo: null,
    });
    expect(response.status).toBe(409);
    expect(mocks.membershipFeeCreate).not.toHaveBeenCalled();
  });

  it("rejects a family recipient outside the active family and accepts a valid member", async () => {
    mocks.familyGroupMemberFindUnique.mockResolvedValueOnce(null);
    expect((await post({ action: "SET_FAMILY_BILLING_MEMBER", familyGroupId: "family-1", billingMemberId: "outsider" })).status).toBe(422);
    expect(mocks.familyGroupUpdate).not.toHaveBeenCalled();

    mocks.familyGroupMemberFindUnique.mockResolvedValueOnce({ id: "membership-1", member: { active: true, archivedAt: null } });
    expect((await post({ action: "SET_FAMILY_BILLING_MEMBER", familyGroupId: "family-1", billingMemberId: "member-1" })).status).toBe(200);
    expect(mocks.familyGroupUpdate).toHaveBeenCalledWith({ where: { id: "family-1" }, data: { billingMembershipId: "membership-1" } });
  });

  it("reports the family billing mode and flags billing exceptions in family mode", async () => {
    mocks.familyGroupFindMany.mockResolvedValue([
      { id: "family-1", name: "Alpha", billingMembershipId: null, billingMembership: null, memberships: [] },
    ]);
    const body = await (await GET()).json();
    expect(body.familyBillingMode).toBe("BILL_FAMILY_VIA_BILLING_MEMBER");
    // A membered family with no recipient is an exception in family mode.
    expect(body.familyGroups[0].billingException).toBe(true);
  });

  it("hides exceptions and reports individual mode when the club bills members individually", async () => {
    mocks.billingSettingsFindUnique.mockResolvedValue({ familyBillingMode: "BILL_MEMBERS_INDIVIDUALLY" });
    mocks.familyGroupFindMany.mockResolvedValue([
      { id: "family-1", name: "Alpha", billingMembershipId: null, billingMembership: null, memberships: [] },
    ]);
    const body = await (await GET()).json();
    expect(body.familyBillingMode).toBe("BILL_MEMBERS_INDIVIDUALLY");
    // Same recipient-less family raises no exception under individual billing.
    expect(body.familyGroups[0].billingException).toBe(false);
  });

  it("allows a per-family schedule in family mode", async () => {
    const response = await post({
      action: "CREATE_MEMBERSHIP_FEE", membershipTypeId: "type-1", amountCents: 20000,
      billingBasis: "PER_FAMILY", prorationRule: "NONE", effectiveFrom: "2026-07-13", effectiveTo: null,
    });
    expect(response.status).toBe(200);
    expect(mocks.membershipFeeCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ billingBasis: "PER_FAMILY" }) });
  });

  it("blocks a per-family schedule server-side when the club bills members individually", async () => {
    mocks.billingSettingsFindUnique.mockResolvedValue({ familyBillingMode: "BILL_MEMBERS_INDIVIDUALLY" });
    const response = await post({
      action: "CREATE_MEMBERSHIP_FEE", membershipTypeId: "type-1", amountCents: 20000,
      billingBasis: "PER_FAMILY", prorationRule: "NONE", effectiveFrom: "2026-07-13", effectiveTo: null,
    });
    expect(response.status).toBe(409);
    expect(mocks.membershipFeeCreate).not.toHaveBeenCalled();
    // Per-member schedules are still accepted under individual billing.
    expect((await post({
      action: "CREATE_MEMBERSHIP_FEE", membershipTypeId: "type-1", amountCents: 20000,
      billingBasis: "PER_MEMBER", prorationRule: "NONE", effectiveFrom: "2026-07-13", effectiveTo: null,
    })).status).toBe(200);
  });
});
