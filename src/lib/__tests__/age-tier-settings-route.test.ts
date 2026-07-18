import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Route-level tests for PUT /api/admin/age-tier-settings (issue #2009 — the
// age-tier SUBSET relaxation and the fail-closed tier-removal guard). The pure
// validity rule is exercised directly in age-tier-settings.test.ts; here we
// cover the DB-touching behaviour: subset save, tier deletion, and the
// removal-blocked 409.

const mocks = vi.hoisted(() => ({
  ageTierFindMany: vi.fn(),
  ageTierUpsert: vi.fn(),
  ageTierDeleteMany: vi.fn(),
  memberCount: vi.fn(),
  bookingGuestCount: vi.fn(),
  transaction: vi.fn(),
  logAudit: vi.fn(),
  revalidate: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: vi.fn(async () => ({
    ok: true as const,
    session: { user: { id: "admin-1" } },
  })),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    ageTierSetting: {
      findMany: mocks.ageTierFindMany,
      upsert: mocks.ageTierUpsert,
      deleteMany: mocks.ageTierDeleteMany,
    },
    member: { count: mocks.memberCount },
    bookingGuest: { count: mocks.bookingGuestCount },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/audit", () => ({ logAudit: mocks.logAudit }));
vi.mock("@/lib/public-content-revalidation", () => ({
  revalidatePublicPageContent: mocks.revalidate,
}));

import { PUT } from "@/app/api/admin/age-tier-settings/route";

const CHILD = {
  tier: "CHILD",
  minAge: 0,
  maxAge: 17,
  label: "Child (0-17)",
  subscriptionRequiredForBooking: false,
  familyGroupRequestCreateMemberAllowed: true,
  sortOrder: 0,
};
const ADULT = {
  tier: "ADULT",
  minAge: 18,
  maxAge: null,
  label: "Adult (18+)",
  subscriptionRequiredForBooking: true,
  familyGroupRequestCreateMemberAllowed: false,
  sortOrder: 1,
};

function putRequest(settings: unknown[]) {
  return new NextRequest("http://localhost/api/admin/age-tier-settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settings }),
  });
}

describe("PUT /api/admin/age-tier-settings — subset save (#2009)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The route now runs the removal guard + deleteMany + upserts inside ONE
    // interactive transaction (prisma.$transaction(async (tx) => …)). The mock
    // invokes the callback with a tx client backed by the same op mocks, so a
    // guard that throws inside the callback aborts exactly as it would against a
    // real DB (the throw rejects the $transaction promise, and the route's
    // catch turns a TierRemovalBlockedError into the 409).
    mocks.transaction.mockImplementation(
      async (fn: (tx: unknown) => unknown) =>
        fn({
          ageTierSetting: {
            upsert: mocks.ageTierUpsert,
            deleteMany: mocks.ageTierDeleteMany,
          },
          member: { count: mocks.memberCount },
          bookingGuest: { count: mocks.bookingGuestCount },
        }),
    );
    mocks.ageTierUpsert.mockReturnValue({ __op: "upsert" });
    mocks.ageTierDeleteMany.mockReturnValue({ __op: "delete" });
    mocks.memberCount.mockResolvedValue(0);
    mocks.bookingGuestCount.mockResolvedValue(0);
    // 1st findMany = existing tiers (removal guard); 2nd = the reloaded set.
    mocks.ageTierFindMany
      .mockResolvedValueOnce([{ tier: "CHILD" }, { tier: "ADULT" }])
      .mockResolvedValueOnce([CHILD, ADULT]);
  });

  it("saves a valid CHILD + ADULT subset (200) and does not delete anything", async () => {
    const res = await PUT(putRequest([CHILD, ADULT]));
    expect(res.status).toBe(200);
    expect(mocks.ageTierUpsert).toHaveBeenCalledTimes(2);
    expect(mocks.ageTierDeleteMany).not.toHaveBeenCalled();
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });

  it("deletes tiers dropped from the set when no live person classifies into them", async () => {
    // Existing = full four; new set = CHILD + ADULT, so INFANT + YOUTH are dropped.
    mocks.ageTierFindMany.mockReset();
    mocks.ageTierFindMany
      .mockResolvedValueOnce([
        { tier: "INFANT" },
        { tier: "CHILD" },
        { tier: "YOUTH" },
        { tier: "ADULT" },
      ])
      .mockResolvedValueOnce([CHILD, ADULT]);

    const res = await PUT(putRequest([CHILD, ADULT]));
    expect(res.status).toBe(200);
    expect(mocks.ageTierDeleteMany).toHaveBeenCalledWith({
      where: { tier: { in: ["INFANT", "YOUTH"] } },
    });
  });

  it("fails closed (409) when a live member is still classified into a removed tier, aborting the in-tx delete", async () => {
    mocks.ageTierFindMany.mockReset();
    mocks.ageTierFindMany.mockResolvedValueOnce([
      { tier: "INFANT" },
      { tier: "CHILD" },
      { tier: "YOUTH" },
      { tier: "ADULT" },
    ]);
    // active = 3, archived = 0.
    mocks.memberCount.mockResolvedValueOnce(3).mockResolvedValueOnce(0);

    const res = await PUT(putRequest([CHILD, ADULT]));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/Cannot remove age tier/i);
    // The guard runs INSIDE the transaction and throws to abort it, so the
    // delete never lands even though the transaction callback was entered.
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.ageTierDeleteMany).not.toHaveBeenCalled();
    expect(mocks.ageTierUpsert).not.toHaveBeenCalled();
    expect(body.activeMembers).toBe(3);
    expect(body.archivedMembers).toBe(0);
  });

  it("fails closed (409) counting ARCHIVED members in a removed tier (would orphan on un-archive)", async () => {
    mocks.ageTierFindMany.mockReset();
    mocks.ageTierFindMany.mockResolvedValueOnce([
      { tier: "INFANT" },
      { tier: "CHILD" },
      { tier: "YOUTH" },
      { tier: "ADULT" },
    ]);
    // active = 0, archived = 2 — no live member, but archived ones still block.
    mocks.memberCount.mockResolvedValueOnce(0).mockResolvedValueOnce(2);

    const res = await PUT(putRequest([CHILD, ADULT]));
    expect(res.status).toBe(409);
    const body = await res.json();
    // New remediation message: edit the member's tier/DOB, not "widen a tier".
    expect(body.error).toMatch(/including 2 archived/i);
    expect(body.error).toMatch(/age tier or date of birth/i);
    expect(body.error).not.toMatch(/widen/i);
    expect(body.archivedMembers).toBe(2);
    expect(mocks.ageTierDeleteMany).not.toHaveBeenCalled();
  });

  it("fails closed (409) when an upcoming booking guest is classified into a removed tier", async () => {
    mocks.ageTierFindMany.mockReset();
    mocks.ageTierFindMany.mockResolvedValueOnce([
      { tier: "YOUTH" },
      { tier: "ADULT" },
    ]);
    mocks.bookingGuestCount.mockResolvedValue(1);

    const res = await PUT(putRequest([{ ...CHILD }, ADULT]));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.liveGuests).toBe(1);
    expect(mocks.ageTierDeleteMany).not.toHaveBeenCalled();
  });

  it("rejects a set missing ADULT (400)", async () => {
    const res = await PUT(
      putRequest([
        { ...CHILD, maxAge: 9 },
        { tier: "YOUTH", minAge: 10, maxAge: 17, label: "Y", subscriptionRequiredForBooking: true, familyGroupRequestCreateMemberAllowed: false, sortOrder: 1 },
      ]),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/must include the ADULT tier/i);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects a subset whose youngest tier does not start at age 0 (400)", async () => {
    const res = await PUT(
      putRequest([{ ...CHILD, minAge: 5 }, ADULT]),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/must start at age 0/i);
  });
});
