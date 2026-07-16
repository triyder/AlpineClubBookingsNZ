import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemberGroupingResolution } from "@/lib/xero-member-grouping";

const mocks = vi.hoisted(() => ({
  cursorFindUnique: vi.fn(),
  memberFindMany: vi.fn(),
  membershipCacheFindMany: vi.fn(),
  loadXeroGroupingContext: vi.fn(),
  resolveMemberGroupingsForMembers: vi.fn(),
  syncManagedXeroContactGroupForMember: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroSyncCursor: { findUnique: mocks.cursorFindUnique },
    member: { findMany: mocks.memberFindMany },
    xeroContactGroupMembershipCache: { findMany: mocks.membershipCacheFindMany },
  },
}));

vi.mock("@/lib/xero-member-grouping", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/xero-member-grouping")>();
  return {
    ...actual,
    loadXeroGroupingContext: mocks.loadXeroGroupingContext,
    resolveMemberGroupingsForMembers: mocks.resolveMemberGroupingsForMembers,
  };
});

vi.mock("@/lib/xero-contact-groups", () => ({
  syncManagedXeroContactGroupForMember: mocks.syncManagedXeroContactGroupForMember,
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  getXeroMemberGroupingSnapshot,
  runXeroMemberGroupingBulkResyncChunk,
} from "@/lib/xero-member-grouping-resync";
import { XeroDailyLimitError } from "@/lib/xero-api-client";

const adultResolution: MemberGroupingResolution = {
  mode: "MEMBERSHIP_TYPE_AND_AGE",
  managedGroup: { id: "g_adult", name: "Adults" },
  acceptedGroupIds: ["g_adult"],
  managedUniverse: ["g_adult", "g_youth"],
  skippedReason: null,
};

// A parked member: no rule matches (e.g. NOT_APPLICABLE organisation), so the
// sync never writes — but the managed universe is still known.
const parkedResolution: MemberGroupingResolution = {
  mode: "MEMBERSHIP_TYPE_AND_AGE",
  managedGroup: null,
  acceptedGroupIds: [],
  managedUniverse: ["g_adult", "g_youth"],
  skippedReason: "no_matching_rule",
};

function seedTwoMismatchesOneCorrectOneNoContact() {
  mocks.loadXeroGroupingContext.mockResolvedValue({
    mode: "MEMBERSHIP_TYPE_AND_AGE",
    activeRules: [],
  });
  mocks.cursorFindUnique.mockResolvedValue({ lastSuccessfulSyncAt: new Date("2026-07-16T00:00:00Z") });
  mocks.memberFindMany.mockResolvedValue([
    { id: "m1", firstName: "A", lastName: "A", email: "a@x", ageTier: "ADULT", xeroContactId: "c1" },
    { id: "m2", firstName: "B", lastName: "B", email: "b@x", ageTier: "ADULT", xeroContactId: "c2" },
    { id: "m3", firstName: "C", lastName: "C", email: "c@x", ageTier: "ADULT", xeroContactId: "c3" },
    { id: "m4", firstName: "D", lastName: "D", email: "d@x", ageTier: "ADULT", xeroContactId: null },
    // Parked: no matching rule, sitting in a MANAGED group -> information only.
    { id: "m5", firstName: "E", lastName: "E", email: "e@x", ageTier: "NOT_APPLICABLE", xeroContactId: "c5" },
    // Parked: no matching rule, only in an unmanaged group -> invisible.
    { id: "m6", firstName: "F", lastName: "F", email: "f@x", ageTier: "NOT_APPLICABLE", xeroContactId: "c6" },
  ]);
  // c1, c3 are mis-grouped (in youth); c2 is correct (in adult).
  mocks.membershipCacheFindMany.mockResolvedValue([
    { contactId: "c1", contactGroupId: "g_youth" },
    { contactId: "c2", contactGroupId: "g_adult" },
    { contactId: "c3", contactGroupId: "g_youth" },
    { contactId: "c5", contactGroupId: "g_adult" },
    { contactId: "c5", contactGroupId: "g_unrelated" },
    { contactId: "c6", contactGroupId: "g_unrelated" },
  ]);
  mocks.resolveMemberGroupingsForMembers.mockResolvedValue(
    new Map([
      ["m1", adultResolution],
      ["m2", adultResolution],
      ["m3", adultResolution],
      ["m5", parkedResolution],
      ["m6", parkedResolution],
    ]),
  );
}

describe("getXeroMemberGroupingSnapshot", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports cacheReady=false when the cache has never refreshed", async () => {
    mocks.loadXeroGroupingContext.mockResolvedValue({ mode: "MEMBERSHIP_TYPE_AND_AGE", activeRules: [] });
    mocks.cursorFindUnique.mockResolvedValue(null);
    const snap = await getXeroMemberGroupingSnapshot();
    expect(snap.cacheReady).toBe(false);
    expect(snap.mismatchCount).toBe(0);
  });

  it("is an empty diff under NONE mode (never touches Xero)", async () => {
    mocks.loadXeroGroupingContext.mockResolvedValue({ mode: "NONE", activeRules: [] });
    mocks.cursorFindUnique.mockResolvedValue({ lastSuccessfulSyncAt: new Date() });
    const snap = await getXeroMemberGroupingSnapshot();
    expect(snap.mode).toBe("NONE");
    expect(snap.mismatchCount).toBe(0);
    expect(mocks.memberFindMany).not.toHaveBeenCalled();
  });

  it("flags mismatched members, lists no-contact members as skipped, and estimates calls", async () => {
    seedTwoMismatchesOneCorrectOneNoContact();
    const snap = await getXeroMemberGroupingSnapshot();
    expect(snap.mismatchCount).toBe(2);
    expect(snap.addCount).toBe(2);
    expect(snap.removeCount).toBe(2);
    expect(snap.skippedNoContact).toEqual([{ memberId: "m4", memberName: "D D" }]);
    // per mismatch: getContact + add + remove + refresh = 4; x2 = 8.
    // Information-only entries cost zero calls.
    expect(snap.estimatedXeroCalls).toBe(8);
    const ids = snap.mismatches.map((m) => m.memberId).sort();
    expect(ids).toEqual(["m1", "m3"]);
  });

  it("reads staleness from the CONTACT_GROUP_FULL_REFRESH cursor, not the per-contact cache cursor", async () => {
    seedTwoMismatchesOneCorrectOneNoContact();
    const snap = await getXeroMemberGroupingSnapshot();
    expect(snap.lastRefreshedAt).toBe("2026-07-16T00:00:00.000Z");
    expect(mocks.cursorFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          resourceType_scope: {
            resourceType: "CONTACT_GROUP_FULL_REFRESH",
            scope: "default",
          },
        },
      }),
    );
  });

  it("surfaces parked members in managed groups as information-only entries (no add/remove)", async () => {
    seedTwoMismatchesOneCorrectOneNoContact();
    const snap = await getXeroMemberGroupingSnapshot();
    expect(snap.informationalCount).toBe(1);
    expect(snap.informational).toEqual([
      {
        memberId: "m5",
        memberName: "E E",
        memberEmail: "e@x",
        ageTier: "NOT_APPLICABLE",
        xeroContactId: "c5",
        // Only the managed-universe intersection — g_unrelated is not listed.
        unexpectedManagedGroupIds: ["g_adult"],
      },
    ]);
    // Never in the actionable mismatch list...
    expect(snap.mismatches.map((m) => m.memberId)).not.toContain("m5");
    // ...and a parked member outside the managed universe is invisible.
    expect(snap.informational.map((m) => m.memberId)).not.toContain("m6");
  });
});

describe("runXeroMemberGroupingBulkResyncChunk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.syncManagedXeroContactGroupForMember.mockResolvedValue({
      addedGroupIds: ["g_adult"],
      removedGroupIds: ["g_youth"],
    });
  });

  it("is a no-op under NONE mode", async () => {
    mocks.loadXeroGroupingContext.mockResolvedValue({ mode: "NONE", activeRules: [] });
    const res = await runXeroMemberGroupingBulkResyncChunk();
    expect(res.done).toBe(true);
    expect(res.processed).toBe(0);
    expect(mocks.syncManagedXeroContactGroupForMember).not.toHaveBeenCalled();
  });

  it("only touches mismatched members (cache-first pre-filter), never the correct or parked ones", async () => {
    seedTwoMismatchesOneCorrectOneNoContact();
    const res = await runXeroMemberGroupingBulkResyncChunk();
    expect(res.processed).toBe(2);
    expect(res.added).toBe(2);
    expect(res.removed).toBe(2);
    expect(res.done).toBe(true);
    const calledIds = mocks.syncManagedXeroContactGroupForMember.mock.calls.map((c) => c[0]).sort();
    expect(calledIds).toEqual(["m1", "m3"]);
    expect(calledIds).not.toContain("m2");
    // m5 is information-only (parked in a managed group): bulk never writes it.
    expect(calledIds).not.toContain("m5");
  });

  it("chunks and resumes via the member-id cursor", async () => {
    seedTwoMismatchesOneCorrectOneNoContact();
    const first = await runXeroMemberGroupingBulkResyncChunk({ limit: 1 });
    expect(first.processed).toBe(1);
    expect(first.done).toBe(false);
    expect(first.nextCursorMemberId).toBe("m1");

    const second = await runXeroMemberGroupingBulkResyncChunk({
      limit: 1,
      afterMemberId: first.nextCursorMemberId!,
    });
    expect(second.processed).toBe(1);
    expect(second.done).toBe(true);
    expect(second.nextCursorMemberId).toBeNull();
    expect(mocks.syncManagedXeroContactGroupForMember).toHaveBeenLastCalledWith("m3", expect.anything());
  });

  it("records per-member failures and continues (non-fatal)", async () => {
    seedTwoMismatchesOneCorrectOneNoContact();
    mocks.syncManagedXeroContactGroupForMember
      .mockRejectedValueOnce(new Error("xero boom"))
      .mockResolvedValueOnce({ addedGroupIds: ["g_adult"], removedGroupIds: [] });
    const res = await runXeroMemberGroupingBulkResyncChunk();
    expect(res.failed).toBe(1);
    expect(res.failures[0].memberId).toBe("m1");
    expect(res.processed).toBe(1);
    expect(res.done).toBe(true);
  });

  it("halts on a Xero daily limit and leaves a resume cursor", async () => {
    seedTwoMismatchesOneCorrectOneNoContact();
    mocks.syncManagedXeroContactGroupForMember
      .mockResolvedValueOnce({ addedGroupIds: ["g_adult"], removedGroupIds: ["g_youth"] })
      .mockRejectedValueOnce(new XeroDailyLimitError(3600));
    const res = await runXeroMemberGroupingBulkResyncChunk();
    expect(res.haltedByDailyLimit).toBe(true);
    expect(res.done).toBe(false);
    expect(res.nextCursorMemberId).toBe("m1");
    expect(res.processed).toBe(1);
  });
});
