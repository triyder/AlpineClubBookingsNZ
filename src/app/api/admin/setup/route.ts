import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import {
  buildSetupReadiness,
  computeMembershipTypeRateGaps,
  normalizeSetupProgress,
  type SetupDatabaseSnapshot,
} from "@/lib/setup-readiness";

async function getSetupDatabaseSnapshot(): Promise<SetupDatabaseSnapshot> {
  const now = new Date();
  const [
    adminCount,
    adminModuleSettings,
    ageTierSettingCount,
    seasonCount,
    cancellationPolicyCount,
    bookingDefaults,
    groupDiscount,
    membershipCancellationSettings,
    operationalXeroToken,
    xeroAccountMappingCount,
    xeroHutFeeItemMappingCount,
    xeroEntranceFeeMappingCount,
  ] = await Promise.all([
    prisma.member.count({ where: { role: "ADMIN", active: true } }),
    prisma.clubModuleSettings.findUnique({
      where: { id: "default" },
      select: {
        kiosk: true,
        chores: true,
        financeDashboard: true,
        waitlist: true,
        xeroIntegration: true,
        bedAllocation: true,
        internetBankingPayments: true,
        addressAutocomplete: true,
        groupBookings: true,
        lockers: true,
        induction: true,
        workParties: true,
        promoCodes: true,
        hutLeaders: true,
        communications: true,
        skifieldConditions: true,
        twoFactor: true,
        analytics: true,
        lobbyDisplay: true,
      },
    }),
    prisma.ageTierSetting.count(),
    prisma.season.count({ where: { active: true } }),
    prisma.cancellationPolicy.count(),
    prisma.bookingDefaults.findUnique({ where: { id: "default" } }),
    prisma.groupDiscountSetting.findUnique({ where: { id: "default" } }),
    prisma.membershipCancellationSetting.findUnique({
      where: { id: "default" },
      select: {
        xeroArchiveContactsOnCancellation: true,
        _count: {
          select: { xeroContactGroups: true },
        },
      },
    }),
    prisma.xeroToken.findFirst({
      orderBy: { updatedAt: "desc" },
      select: { expiresAt: true },
    }),
    prisma.xeroAccountMapping.count({
      where: {
        OR: [{ code: { not: null } }, { itemCode: { not: null } }],
      },
    }),
    prisma.xeroItemCodeMapping.count({
      where: {
        category: "HUT_FEE",
        itemCode: { not: null },
      },
    }),
    prisma.xeroItemCodeMapping.count({
      where: {
        category: "JOINING_FEE",
        OR: [{ itemCode: { not: null } }, { amountCents: { not: null } }],
      },
    }),
  ]);

  // Missing-rate readiness (#1930, E4): every ACTIVE MEMBER_RATE membership
  // type must carry tier-complete rate rows (every bookable age tier, or a
  // flat all-ages row) for every active or future season, or bookings for
  // that type × those dates hard-throw at pricing time. Archived types are
  // skipped — they only price history. The tier-aware coverage rule lives in
  // computeMembershipTypeRateGaps (setup-readiness.ts).
  const [memberRateTypes, currentAndFutureSeasons, existingTypeSeasonRates] =
    await Promise.all([
      prisma.membershipType.findMany({
        where: { isActive: true, bookingBehavior: "MEMBER_RATE" },
        select: { id: true, name: true, ageGroupsApply: true },
      }),
      prisma.season.findMany({
        where: { OR: [{ active: true }, { endDate: { gte: now } }] },
        select: { id: true, name: true },
      }),
      prisma.membershipTypeSeasonRate.findMany({
        select: { seasonId: true, membershipTypeId: true, ageTier: true },
      }),
    ]);
  const membershipTypeRateGaps = computeMembershipTypeRateGaps({
    types: memberRateTypes,
    seasons: currentAndFutureSeasons,
    rateRows: existingTypeSeasonRates,
  });

  return {
    adminCount,
    adminModuleSettings,
    ageTierSettingCount,
    seasonCount,
    cancellationPolicyCount,
    bookingDefaultsConfigured: Boolean(bookingDefaults),
    groupDiscountConfigured: Boolean(groupDiscount),
    membershipCancellationSettingsConfigured: Boolean(membershipCancellationSettings),
    membershipCancellationXeroGroupCount:
      membershipCancellationSettings?._count.xeroContactGroups ?? 0,
    membershipCancellationArchiveContacts: Boolean(
      membershipCancellationSettings?.xeroArchiveContactsOnCancellation,
    ),
    operationalXeroConnected: Boolean(
      operationalXeroToken && operationalXeroToken.expiresAt > now,
    ),
    operationalXeroTokenExpiresAt:
      operationalXeroToken?.expiresAt.toISOString() ?? null,
    xeroAccountMappingCount,
    xeroHutFeeItemMappingCount,
    xeroEntranceFeeMappingCount,
    membershipTypeRateGaps,
  };
}

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const [database, progressRecord] = await Promise.all([
    getSetupDatabaseSnapshot(),
    prisma.setupProgress.findUnique({ where: { id: "default" } }),
  ]);
  const progress = normalizeSetupProgress(
    progressRecord
      ? {
          completedStepIds: progressRecord.completedStepIds,
          skippedStepIds: progressRecord.skippedStepIds,
          completedAt: progressRecord.completedAt?.toISOString() ?? null,
          completedByMemberId: progressRecord.completedByMemberId,
        }
      : null,
  );

  return NextResponse.json({
    readiness: buildSetupReadiness({
      database,
      progress,
    }),
    progress,
  });
}
