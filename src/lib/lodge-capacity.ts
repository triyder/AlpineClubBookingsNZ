import { clubConfig } from "@/config/club";
import {
  DEFAULT_MODULE_SETTINGS,
  MODULE_KEYS,
  getEffectiveModuleFlags,
  type ModuleSettingsValues,
} from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";

// Club config bed total, used only when no admin capacity override is set and
// the Bed Allocation module is not providing an active bed count. The club
// config describes the club's original (default) lodge, so this fallback never
// applies to additional lodges (see getLodgeCapacityStatus).
export const CLUB_CONFIG_LODGE_CAPACITY = clubConfig.beds.reduce(
  (total, bed) => total + bed.capacity,
  0,
);

/**
 * @deprecated Prefer the resolved `fallbackCapacity` from getLodgeCapacityStatus,
 * which honours the admin capacity override. Retained for callers that need a
 * static default with no database access.
 */
export const FALLBACK_LODGE_CAPACITY = CLUB_CONFIG_LODGE_CAPACITY;

type ModuleSettingsRecord = Partial<ModuleSettingsValues> | null;

interface LodgeCapacityDb {
  clubModuleSettings?: {
    findUnique: (args: {
      where: { id: string };
    }) => Promise<ModuleSettingsRecord>;
  };
  lodgeSettings?: {
    findUnique: (args: {
      where: { id: string };
    }) => Promise<{ capacity: number | null; lodgeId?: string | null } | null>;
  };
  lodgeBed: {
    count: (args: {
      where: { active: boolean; room?: { lodgeId: string }; bedType?: "DOUBLE" };
    }) => Promise<number>;
  };
  // Optional so existing structural mocks keep working: when absent, the
  // requested lodge is treated as the club's default lodge (single-lodge
  // behaviour, club-config fallback preserved).
  lodge?: {
    findFirst: (args: {
      where: { active: boolean };
      orderBy: Array<Record<string, "asc" | "desc">>;
      select: { id: true };
    }) => Promise<{ id: string } | null>;
  };
}

export interface LodgeCapacityStatus {
  capacity: number;
  source:
    | "configured_beds"
    | "capped_beds"
    | "capacity_override"
    | "club_config"
    | "unconfigured_lodge";
  bedAllocationEnabled: boolean;
  activeBedCount: number;
  fallbackCapacity: number;
}

function normalizeModuleSettings(
  record?: ModuleSettingsRecord,
): ModuleSettingsValues {
  return Object.fromEntries(
    MODULE_KEYS.map((key) => [key, record?.[key] ?? DEFAULT_MODULE_SETTINGS[key]]),
  ) as ModuleSettingsValues;
}

async function resolveLodgeCapacityDb(): Promise<LodgeCapacityDb> {
  const { prisma } = await import("@/lib/prisma");
  return prisma as unknown as LodgeCapacityDb;
}

async function loadCapacityModuleState(
  db: LodgeCapacityDb,
): Promise<FeatureFlags> {
  if (!db.clubModuleSettings?.findUnique) {
    return getEffectiveModuleFlags(DEFAULT_MODULE_SETTINGS);
  }

  try {
    const record = await db.clubModuleSettings.findUnique({
      where: { id: "default" },
    });
    return getEffectiveModuleFlags(normalizeModuleSettings(record));
  } catch {
    return getEffectiveModuleFlags(DEFAULT_MODULE_SETTINGS);
  }
}

// The club-config bed list and the LodgeSettings capacity override describe
// the club's original lodge only. They apply to the default lodge (oldest
// active) and never to an additional lodge, which would otherwise inherit
// lodge A's bed total and be overbookable before it is configured.
async function isDefaultLodge(
  db: LodgeCapacityDb,
  lodgeId: string,
): Promise<boolean> {
  if (!db.lodge?.findFirst) return true;
  const defaultLodge = await db.lodge.findFirst({
    where: { active: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  return defaultLodge === null || defaultLodge.id === lodgeId;
}

/**
 * Capacity for one lodge on one night. Never sums beds across lodges
 * (docs/multi-lodge/lodge-scoping-contract.md).
 *
 * Resolution order (see docs/CAPACITY_MODEL.md for the full scenario table):
 * 1. Bed Allocation module ON with ≥1 active bed: the physical bed inventory
 *    is the placement set, and the admin capacity value acts as a *maximum
 *    sleeping capacity* ceiling on top of it. Effective capacity is the LOWER
 *    of the two — a lodge may have more beds installed than it is licensed to
 *    sleep (#1653). No capacity set (or set ≥ bed count) → the bed count wins
 *    ("configured_beds"); a capacity below the bed count caps it ("capped_beds").
 * 2. Otherwise (module off, or on with no active beds): the admin capacity
 *    value for this lodge (LodgeSettings row linked to this lodge).
 * 3. Default lodge only: club-config bed total (legacy single-lodge fallback).
 *    Additional lodges resolve to 0 until beds or a capacity are configured,
 *    so an unconfigured lodge can never be overbooked.
 *
 * The club-config fallback (step 3) is never treated as a ceiling — only an
 * explicit per-lodge capacity caps the bed count, so enabling Bed Allocation
 * on the default lodge keeps using the bed count unless a capacity is set.
 */
export async function getLodgeCapacityStatus(
  lodgeId: string,
  db?: LodgeCapacityDb,
): Promise<LodgeCapacityStatus> {
  // Bed allocation availability follows the admin Modules toggle only.
  const client = db ?? (await resolveLodgeCapacityDb());
  const modules = await loadCapacityModuleState(client);

  // The override is the admin-set lodge capacity if present. Imported
  // dynamically so this module's static graph stays free of the Prisma client
  // (config/club-identity imports the constants here at load time, well before
  // any database is available).
  const { loadLodgeCapacityOverride } = await import("@/lib/lodge-settings");
  const override = await loadLodgeCapacityOverride(client, lodgeId);

  const defaultLodge = await isDefaultLodge(client, lodgeId);
  const fallbackCapacity =
    override ?? (defaultLodge ? CLUB_CONFIG_LODGE_CAPACITY : 0);
  const fallbackSource =
    override !== null && override !== undefined
      ? ("capacity_override" as const)
      : defaultLodge
        ? ("club_config" as const)
        : ("unconfigured_lodge" as const);

  if (!modules.bedAllocation) {
    return {
      capacity: fallbackCapacity,
      source: fallbackSource,
      bedAllocationEnabled: false,
      activeBedCount: 0,
      fallbackCapacity,
    };
  }

  const activeBedCount = await client.lodgeBed.count({
    where: { active: true, room: { lodgeId } },
  });

  if (activeBedCount <= 0) {
    // Module on but no beds configured yet: fall back to the capacity value
    // (or the club-config/unconfigured fallback), unchanged.
    return {
      capacity: fallbackCapacity,
      source: fallbackSource,
      bedAllocationEnabled: true,
      activeBedCount,
      fallbackCapacity,
    };
  }

  // Beds are the placement inventory; an explicit per-lodge capacity is the
  // maximum sleeping capacity ceiling. Effective capacity is the lower of the
  // two (#1653). Only an explicit override caps — the club-config fallback does
  // not, so `override` (not `fallbackCapacity`) is the ceiling here.
  const capped =
    override !== null && override !== undefined && override < activeBedCount;

  return {
    capacity: capped ? override : activeBedCount,
    source: capped ? "capped_beds" : "configured_beds",
    bedAllocationEnabled: true,
    activeBedCount,
    fallbackCapacity,
  };
}

export async function getLodgeCapacity(
  lodgeId: string,
  db?: LodgeCapacityDb,
): Promise<number> {
  const status = await getLodgeCapacityStatus(lodgeId, db);
  return status.capacity;
}

export interface LodgePartnerSharedCapacityStatus extends LodgeCapacityStatus {
  activeDoubleBedCount: number;
  partnerSharedHeadroom: number;
}

/**
 * Capacity status plus the partner-shared headroom (#1745): how many guests
 * beyond the base `capacity` may be admitted as second occupants of shared
 * DOUBLE beds. Kept out of getLodgeCapacityStatus so ordinary availability
 * checks — which must never see the extra slots — pay no extra query.
 *
 * Headroom is one slot per active DOUBLE bed, bounded by an explicit admin
 * capacity value when one is set: that value is a maximum *sleeping* capacity
 * (fire/consent/licence, #1653), and a partner-sharer sleeps in the lodge like
 * anyone else. So a `capped_beds` lodge gets no headroom at all, and a lodge
 * whose capacity sits between `beds` and `beds + doubles` gets only the gap.
 * The headroom never raises the base figure the public booking paths read —
 * it is consumed only by the admin-initiated partner-shared admission check
 * (`checkCapacityForPartnerSharedAdmission`, see docs/CAPACITY_MODEL.md).
 */
export async function getLodgePartnerSharedCapacityStatus(
  lodgeId: string,
  db?: LodgeCapacityDb,
): Promise<LodgePartnerSharedCapacityStatus> {
  const client = db ?? (await resolveLodgeCapacityDb());
  const base = await getLodgeCapacityStatus(lodgeId, client);

  // Shared slots exist only where beds are the bookable inventory: with the
  // module off (or no active beds) there are no DOUBLE rows admitting a second
  // occupant, and with a capacity below the bed count the explicit people
  // ceiling already binds.
  if (
    !base.bedAllocationEnabled ||
    base.activeBedCount <= 0 ||
    base.source !== "configured_beds"
  ) {
    return { ...base, activeDoubleBedCount: 0, partnerSharedHeadroom: 0 };
  }

  const activeDoubleBedCount = await client.lodgeBed.count({
    where: { active: true, room: { lodgeId }, bedType: "DOUBLE" },
  });

  const { loadLodgeCapacityOverride } = await import("@/lib/lodge-settings");
  const override = await loadLodgeCapacityOverride(client, lodgeId);
  const peopleCeiling =
    override !== null && override !== undefined
      ? override
      : Number.POSITIVE_INFINITY;

  const partnerSharedHeadroom = Math.max(
    0,
    Math.min(
      activeDoubleBedCount,
      peopleCeiling - base.activeBedCount,
    ),
  );

  return { ...base, activeDoubleBedCount, partnerSharedHeadroom };
}

/**
 * Capacity of the club's default lodge (oldest active). For display surfaces
 * and single-lodge bridging call sites that have no lodge context of their
 * own; booking/capacity mutation paths must pass the booking's real lodgeId
 * to getLodgeCapacity instead.
 */
export async function getDefaultLodgeCapacity(
  db?: LodgeCapacityDb,
): Promise<number> {
  const client = db ?? (await resolveLodgeCapacityDb());

  let lodgeId = "default-lodge";
  if (client.lodge?.findFirst) {
    const { getDefaultLodgeId } = await import("@/lib/lodges");
    lodgeId = await getDefaultLodgeId(
      client as unknown as Parameters<typeof getDefaultLodgeId>[0],
    );
  }
  // Without a lodge delegate (structural test mocks), the sentinel id flows
  // into a db that also has no lodge delegate, so isDefaultLodge treats it as
  // the default lodge and legacy single-lodge behaviour is preserved.
  return getLodgeCapacity(lodgeId, client);
}
