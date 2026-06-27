import { clubConfig } from "@/config/club";
import {
  DEFAULT_MODULE_SETTINGS,
  MODULE_KEYS,
  getEffectiveModuleFlags,
  type ModuleSettingsValues,
} from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";

// Club config bed total, used only when no admin capacity override is set and
// the Bed Allocation module is not providing an active bed count.
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
    }) => Promise<{ capacity: number | null } | null>;
  };
  lodgeBed: {
    count: (args: { where: { active: boolean } }) => Promise<number>;
  };
}

export interface LodgeCapacityStatus {
  capacity: number;
  source: "configured_beds" | "club_config";
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

export async function getLodgeCapacityStatus(
  db?: LodgeCapacityDb,
): Promise<LodgeCapacityStatus> {
  // Bed allocation availability follows the admin Modules toggle only.
  const client = db ?? (await resolveLodgeCapacityDb());
  const modules = await loadCapacityModuleState(client);

  // The fallback is the admin-set lodge capacity if present, otherwise the
  // club config bed total. Imported dynamically so this module's static graph
  // stays free of the Prisma client (config/club-identity imports the constants
  // here at load time, well before any database is available).
  const { loadLodgeCapacityOverride } = await import("@/lib/lodge-settings");
  const override = await loadLodgeCapacityOverride(client);
  const fallbackCapacity = override ?? CLUB_CONFIG_LODGE_CAPACITY;

  if (!modules.bedAllocation) {
    return {
      capacity: fallbackCapacity,
      source: "club_config",
      bedAllocationEnabled: false,
      activeBedCount: 0,
      fallbackCapacity,
    };
  }

  const activeBedCount = await client.lodgeBed.count({
    where: { active: true },
  });

  return {
    capacity: activeBedCount > 0 ? activeBedCount : fallbackCapacity,
    source: activeBedCount > 0 ? "configured_beds" : "club_config",
    bedAllocationEnabled: true,
    activeBedCount,
    fallbackCapacity,
  };
}

export async function getLodgeCapacity(
  db?: LodgeCapacityDb,
): Promise<number> {
  const status = await getLodgeCapacityStatus(db);
  return status.capacity;
}
