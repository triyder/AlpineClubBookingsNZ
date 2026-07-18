import { prisma } from "@/lib/prisma";
import { getDefaultLodgeCapacity } from "@/lib/lodge-capacity";
import {
  computeMembershipTypeRateGaps,
  type SetupDatabaseSnapshot,
} from "@/lib/setup-readiness";

/**
 * Build the database half of the setup-readiness snapshot (C8 #1987).
 *
 * Extracted from the /admin/setup route so both the admin API and the
 * `setup:check` CLI resolve DB readiness the same way. Under the DB-first
 * configuration model the club-config and age-tier gates read this snapshot
 * (clubIdentityName / configuredCapacity / ageTierSettingCount) rather than
 * `config/club.json`, so an install configured only in the DB reports as
 * complete without any file on disk.
 */
export async function getSetupDatabaseSnapshot(): Promise<SetupDatabaseSnapshot> {
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
    clubIdentity,
    emailSettings,
    lodgeSettings,
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
    prisma.clubIdentitySettings.findUnique({
      where: { id: "default" },
      select: { name: true },
    }),
    prisma.emailMessageSetting.findUnique({
      where: { id: "default" },
      select: { clubName: true },
    }),
    prisma.lodgeSettings.findUnique({
      where: { id: "default" },
      select: { capacity: true },
    }),
  ]);

  // Missing-rate readiness (#1930, E4): every ACTIVE MEMBER_RATE membership
  // type must carry tier-complete rate rows (every bookable age tier, or a
  // flat all-ages row) for every active or future season, or bookings for
  // that type × those dates hard-throw at pricing time. Archived types are
  // skipped — they only price history. The tier-aware coverage rule lives in
  // computeMembershipTypeRateGaps (setup-readiness.ts).
  const [
    memberRateTypes,
    currentAndFutureSeasons,
    existingTypeSeasonRates,
    configuredAgeTiers,
  ] = await Promise.all([
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
    // The club's actual configured age tiers (#2009). A club may run a SUBSET
    // (e.g. CHILD + ADULT only), and only its present tiers are ever priced —
    // so the rate-gap check must demand rate rows for THOSE tiers, not the full
    // built-in four, or a valid subset club is falsely told it is missing
    // INFANT/YOUTH rates. Empty (unconfigured) → let the check use its default.
    prisma.ageTierSetting.findMany({ select: { tier: true } }),
  ]);
  const bookableAgeTiers = configuredAgeTiers.map((row) => row.tier);
  const membershipTypeRateGaps = computeMembershipTypeRateGaps({
    types: memberRateTypes,
    seasons: currentAndFutureSeasons,
    rateRows: existingTypeSeasonRates,
    bookableAgeTiers:
      bookableAgeTiers.length > 0 ? bookableAgeTiers : undefined,
  });

  const clubIdentityName =
    clubIdentity?.name?.trim() || emailSettings?.clubName?.trim() || null;

  // Resolved default-lodge booking capacity (#1982): 0 means the default lodge
  // has no active beds and no capacity override, so it accepts no bookings — the
  // club-config readiness check warns on it. Guarded because a pre-seed DB has
  // no Lodge row (getDefaultLodgeId throws); we then simply omit the signal.
  let defaultLodgeCapacity: number | null = null;
  try {
    defaultLodgeCapacity = await getDefaultLodgeCapacity(prisma);
  } catch {
    defaultLodgeCapacity = null;
  }

  return {
    adminCount,
    adminModuleSettings,
    ageTierSettingCount,
    seasonCount,
    cancellationPolicyCount,
    bookingDefaultsConfigured: Boolean(bookingDefaults),
    groupDiscountConfigured: Boolean(groupDiscount),
    membershipCancellationSettingsConfigured: Boolean(
      membershipCancellationSettings,
    ),
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
    defaultLodgeCapacity,
    clubIdentityName,
    configuredCapacity: lodgeSettings?.capacity ?? null,
  };
}
