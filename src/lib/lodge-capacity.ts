import { clubConfig } from "@/config/club";
import { featureFlags } from "@/config/features";
import {
  DEFAULT_MODULE_SETTINGS,
  MODULE_KEYS,
  getEffectiveModuleFlags,
  type ModuleSettingsValues,
} from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";

export const FALLBACK_LODGE_CAPACITY = clubConfig.beds.reduce(
  (total, bed) => total + bed.capacity,
  0,
);

type ModuleSettingsRecord = Partial<ModuleSettingsValues> | null;

interface LodgeCapacityDb {
  clubModuleSettings?: {
    findUnique: (args: {
      where: { id: string };
    }) => Promise<ModuleSettingsRecord>;
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
  flags: FeatureFlags,
): Promise<FeatureFlags> {
  if (!db.clubModuleSettings?.findUnique) {
    return getEffectiveModuleFlags(flags, DEFAULT_MODULE_SETTINGS);
  }

  try {
    const record = await db.clubModuleSettings.findUnique({
      where: { id: "default" },
    });
    return getEffectiveModuleFlags(flags, normalizeModuleSettings(record));
  } catch {
    return getEffectiveModuleFlags(flags, DEFAULT_MODULE_SETTINGS);
  }
}

export async function getLodgeCapacityStatus(
  db?: LodgeCapacityDb,
  flags: FeatureFlags = featureFlags,
): Promise<LodgeCapacityStatus> {
  if (!flags.bedAllocation) {
    return {
      capacity: FALLBACK_LODGE_CAPACITY,
      source: "club_config",
      bedAllocationEnabled: false,
      activeBedCount: 0,
      fallbackCapacity: FALLBACK_LODGE_CAPACITY,
    };
  }

  const client = db ?? (await resolveLodgeCapacityDb());
  const modules = await loadCapacityModuleState(client, flags);

  if (!modules.bedAllocation) {
    return {
      capacity: FALLBACK_LODGE_CAPACITY,
      source: "club_config",
      bedAllocationEnabled: false,
      activeBedCount: 0,
      fallbackCapacity: FALLBACK_LODGE_CAPACITY,
    };
  }

  const activeBedCount = await client.lodgeBed.count({
    where: { active: true },
  });

  return {
    capacity: activeBedCount > 0 ? activeBedCount : FALLBACK_LODGE_CAPACITY,
    source: activeBedCount > 0 ? "configured_beds" : "club_config",
    bedAllocationEnabled: true,
    activeBedCount,
    fallbackCapacity: FALLBACK_LODGE_CAPACITY,
  };
}

export async function getLodgeCapacity(
  db?: LodgeCapacityDb,
): Promise<number> {
  const status = await getLodgeCapacityStatus(db);
  return status.capacity;
}
