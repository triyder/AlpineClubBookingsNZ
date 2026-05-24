import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  membershipCancellationSettingFindUnique: vi.fn(),
  membershipCancellationSettingUpsert: vi.fn(),
  membershipCancellationSettingFindUniqueOrThrow: vi.fn(),
  membershipCancellationXeroContactGroupDeleteMany: vi.fn(),
  membershipCancellationXeroContactGroupCreateMany: vi.fn(),
  auditLogCreate: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    membershipCancellationSetting: {
      findUnique: mocks.membershipCancellationSettingFindUnique,
    },
    membershipCancellationXeroContactGroup: {},
    auditLog: {
      create: mocks.auditLogCreate,
    },
    $transaction: mocks.transaction,
  },
}));

import {
  DEFAULT_MEMBERSHIP_CANCELLATION_WARNING_TEXT,
  DEFAULT_MEMBERSHIP_REJOIN_PROCESS_TEXT,
  normalizeMembershipCancellationSettings,
  normalizeMembershipCancellationXeroGroups,
} from "@/lib/membership-cancellation-settings";
import {
  GET as getMembershipCancellationSettings,
  PUT as putMembershipCancellationSettings,
} from "@/app/api/admin/membership-cancellation-settings/route";

function request(body: unknown) {
  return new NextRequest(
    "http://localhost/api/admin/membership-cancellation-settings",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

describe("membership cancellation settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.membershipCancellationSettingFindUnique.mockResolvedValue(null);
    mocks.membershipCancellationSettingUpsert.mockResolvedValue({});
    mocks.membershipCancellationSettingFindUniqueOrThrow.mockResolvedValue({
      id: "default",
      warningText: "Saved warning",
      rejoinProcessText: "Saved rejoin",
      xeroArchiveContactsOnCancellation: true,
      updatedByMemberId: "admin-1",
      xeroContactGroups: [
        { groupId: "group-1", groupName: "Cancelled members" },
      ],
    });
    mocks.membershipCancellationXeroContactGroupDeleteMany.mockResolvedValue({
      count: 0,
    });
    mocks.membershipCancellationXeroContactGroupCreateMany.mockResolvedValue({
      count: 1,
    });
    mocks.auditLogCreate.mockResolvedValue({});
    mocks.transaction.mockImplementation(async (callback) =>
      callback({
        membershipCancellationSetting: {
          upsert: mocks.membershipCancellationSettingUpsert,
          findUniqueOrThrow:
            mocks.membershipCancellationSettingFindUniqueOrThrow,
        },
        membershipCancellationXeroContactGroup: {
          deleteMany: mocks.membershipCancellationXeroContactGroupDeleteMany,
          createMany: mocks.membershipCancellationXeroContactGroupCreateMany,
        },
      }),
    );
  });

  it("provides defaults when no settings are saved", () => {
    expect(normalizeMembershipCancellationSettings(null)).toEqual({
      warningText: DEFAULT_MEMBERSHIP_CANCELLATION_WARNING_TEXT,
      rejoinProcessText: DEFAULT_MEMBERSHIP_REJOIN_PROCESS_TEXT,
      xeroArchiveContactsOnCancellation: false,
      xeroContactGroups: [],
    });
  });

  it("normalizes and deduplicates Xero cancellation contact groups", () => {
    expect(
      normalizeMembershipCancellationXeroGroups([
        { groupId: " group-1 ", groupName: " Cancelled members " },
        { groupId: "group-1", groupName: "Duplicate" },
        { groupId: " ", groupName: "Blank" },
      ]),
    ).toEqual([{ groupId: "group-1", groupName: "Cancelled members" }]);
  });

  it("returns default settings from the admin API when no row exists", async () => {
    const response = await getMembershipCancellationSettings();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.settings.warningText).toBe(
      DEFAULT_MEMBERSHIP_CANCELLATION_WARNING_TEXT,
    );
    expect(body.settings.rejoinProcessText).toBe(
      DEFAULT_MEMBERSHIP_REJOIN_PROCESS_TEXT,
    );
  });

  it("persists Xero cancellation settings and audit logs the change", async () => {
    const response = await putMembershipCancellationSettings(
      request({
        warningText: "  Saved warning  ",
        rejoinProcessText: "Saved rejoin",
        xeroArchiveContactsOnCancellation: true,
        xeroContactGroups: [
          { groupId: " group-1 ", groupName: " Cancelled members " },
          { groupId: "group-1", groupName: "Duplicate" },
        ],
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.membershipCancellationSettingUpsert).toHaveBeenCalledWith({
      where: { id: "default" },
      create: expect.objectContaining({
        warningText: "Saved warning",
        rejoinProcessText: "Saved rejoin",
        xeroArchiveContactsOnCancellation: true,
        updatedByMemberId: "admin-1",
      }),
      update: expect.objectContaining({
        warningText: "Saved warning",
        rejoinProcessText: "Saved rejoin",
        xeroArchiveContactsOnCancellation: true,
        updatedByMemberId: "admin-1",
      }),
    });
    expect(
      mocks.membershipCancellationXeroContactGroupCreateMany,
    ).toHaveBeenCalledWith({
      data: [
        {
          settingId: "default",
          groupId: "group-1",
          groupName: "Cancelled members",
        },
      ],
      skipDuplicates: true,
    });
    expect(mocks.auditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "MEMBERSHIP_CANCELLATION_SETTINGS_UPDATED",
          entityType: "MembershipCancellationSetting",
          entityId: "default",
        }),
      }),
    );
    expect(body.settings.xeroContactGroups).toEqual([
      { groupId: "group-1", groupName: "Cancelled members" },
    ]);
  });
});
