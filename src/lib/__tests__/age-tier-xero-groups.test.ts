import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    ageTierSetting: {
      findMany: vi.fn(),
    },
    xeroSyncCursor: {
      findUnique: vi.fn(),
    },
    member: {
      findMany: vi.fn(),
    },
    xeroContactGroupMembershipCache: {
      findMany: vi.fn(),
    },
  },
}));

import { prisma } from "@/lib/prisma";
import { getXeroContactGroupMismatchSnapshot } from "@/lib/age-tier-xero-groups";

describe("age-tier Xero contact group mismatch snapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports cache-not-ready when the contact group cache has never been refreshed", async () => {
    vi.mocked(prisma.ageTierSetting.findMany).mockResolvedValue([]);
    vi.mocked(prisma.xeroSyncCursor.findUnique).mockResolvedValue(null as any);

    const snapshot = await getXeroContactGroupMismatchSnapshot();

    expect(snapshot).toEqual({
      cacheReady: false,
      lastRefreshedAt: null,
      configuredMappings: [],
      count: 0,
      mismatches: [],
    });
  });

  it("flags linked members missing the expected managed group or carrying the wrong managed group", async () => {
    vi.mocked(prisma.ageTierSetting.findMany).mockResolvedValue([
      {
        tier: "CHILD",
        label: "Child",
        sortOrder: 1,
        xeroContactGroupId: "group-child",
        xeroContactGroupName: "Child Members",
        xeroAcceptedContactGroups: [],
      },
      {
        tier: "ADULT",
        label: "Adult",
        sortOrder: 3,
        xeroContactGroupId: "group-adult",
        xeroContactGroupName: "Adult Members",
        xeroAcceptedContactGroups: [
          {
            groupId: "group-admin",
            groupName: "Admin Users",
          },
          {
            groupId: "group-life",
            groupName: "Life Members (Honorary)",
          },
        ],
      },
      {
        tier: "YOUTH",
        label: "Youth",
        sortOrder: 2,
        xeroContactGroupId: "group-youth",
        xeroContactGroupName: "Youth Members",
        xeroAcceptedContactGroups: [],
      },
    ] as any);
    vi.mocked(prisma.xeroSyncCursor.findUnique).mockResolvedValue({
      lastSuccessfulSyncAt: new Date("2026-04-26T00:00:00.000Z"),
    } as any);
    vi.mocked(prisma.member.findMany).mockResolvedValue([
      {
        id: "m-child",
        firstName: "Casey",
        lastName: "Child",
        email: "casey@example.com",
        ageTier: "CHILD",
        xeroContactId: "xc-child",
      },
      {
        id: "m-youth",
        firstName: "Yara",
        lastName: "Youth",
        email: "yara@example.com",
        ageTier: "YOUTH",
        xeroContactId: "xc-youth",
      },
      {
        id: "m-admin",
        firstName: "Alex",
        lastName: "Admin",
        email: "alex@example.com",
        ageTier: "ADULT",
        xeroContactId: "xc-admin",
      },
    ] as any);
    vi.mocked(prisma.xeroContactGroupMembershipCache.findMany).mockResolvedValue([
      {
        contactId: "xc-child",
        contactGroupId: "group-youth",
        group: {
          name: "Youth Members",
        },
      },
      {
        contactId: "xc-youth",
        contactGroupId: "group-youth",
        group: {
          name: "Youth Members",
        },
      },
      {
        contactId: "xc-admin",
        contactGroupId: "group-admin",
        group: {
          name: "Admin Users",
        },
      },
    ] as any);

    const snapshot = await getXeroContactGroupMismatchSnapshot();

    expect(snapshot.cacheReady).toBe(true);
    expect(snapshot.count).toBe(1);
    expect(snapshot.mismatches).toEqual([
      expect.objectContaining({
        memberId: "m-child",
        ageTier: "CHILD",
        defaultGroup: {
          id: "group-child",
          name: "Child Members",
        },
        acceptedGroups: [
          {
            id: "group-child",
            name: "Child Members",
            isDefault: true,
          },
        ],
        missingExpectedGroup: true,
        unexpectedManagedGroups: [
          {
            id: "group-youth",
            name: "Youth Members",
            tier: "YOUTH",
          },
        ],
      }),
    ]);
  });

  it("flags NOT_APPLICABLE members only when they sit in a managed age-tier group (#1440)", async () => {
    vi.mocked(prisma.ageTierSetting.findMany).mockResolvedValue([
      {
        tier: "ADULT",
        label: "Adult",
        sortOrder: 3,
        xeroContactGroupId: "group-adult",
        xeroContactGroupName: "Adult Members",
        xeroAcceptedContactGroups: [],
      },
    ] as any);
    vi.mocked(prisma.xeroSyncCursor.findUnique).mockResolvedValue({
      lastSuccessfulSyncAt: new Date("2026-07-01T00:00:00.000Z"),
    } as any);
    vi.mocked(prisma.member.findMany).mockResolvedValue([
      {
        // Org left in the managed Adults group from before the backfill.
        id: "org-stale",
        firstName: "Springfield",
        lastName: "School",
        email: "office@school.test",
        ageTier: "NOT_APPLICABLE",
        xeroContactId: "xc-org-stale",
      },
      {
        // Org outside every managed group: no expected group, no mismatch.
        id: "org-clean",
        firstName: "Shelbyville",
        lastName: "School",
        email: "office@shelbyville.test",
        ageTier: "NOT_APPLICABLE",
        xeroContactId: "xc-org-clean",
      },
    ] as any);
    vi.mocked(prisma.xeroContactGroupMembershipCache.findMany).mockResolvedValue([
      {
        contactId: "xc-org-stale",
        contactGroupId: "group-adult",
        group: {
          name: "Adult Members",
        },
      },
      {
        contactId: "xc-org-clean",
        contactGroupId: "group-unmanaged",
        group: {
          name: "Newsletter",
        },
      },
    ] as any);

    const snapshot = await getXeroContactGroupMismatchSnapshot();

    expect(snapshot.cacheReady).toBe(true);
    expect(snapshot.count).toBe(1);
    expect(snapshot.mismatches).toEqual([
      expect.objectContaining({
        memberId: "org-stale",
        ageTier: "NOT_APPLICABLE",
        defaultGroup: null,
        acceptedGroups: [],
        missingExpectedGroup: false,
        unexpectedManagedGroups: [
          {
            id: "group-adult",
            name: "Adult Members",
            tier: "ADULT",
          },
        ],
      }),
    ]);
  });
});
