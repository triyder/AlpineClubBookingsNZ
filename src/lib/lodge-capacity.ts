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
      where: { active: boolean; room?: { lodgeId: string } };
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
  source: "configured_beds" | "capacity_override" | "club_config" | "unconfigured_lodge";
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
 * Resolution order:
 * 1. Active configured beds in the lodge's rooms (Bed Allocation module on).
 * 2. Admin capacity override (LodgeSettings row linked to this lodge).
 * 3. Default lodge only: club-config bed total (legacy single-lodge fallback).
 *    Additional lodges resolve to 0 until beds or an override are configured,
 *    so an unconfigured lodge can never be overbooked.
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

  return {
    capacity: activeBedCount > 0 ? activeBedCount : fallbackCapacity,
    source: activeBedCount > 0 ? "configured_beds" : fallbackSource,
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
