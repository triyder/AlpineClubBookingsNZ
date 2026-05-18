import { featureFlags } from "@/config/features";
import {
  DEFAULT_MODULE_SETTINGS,
  MODULE_KEYS,
  getEffectiveModuleFlags,
  type ModuleKey,
  type ModuleSettingsValues,
} from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";
import {
  CLUB_MODULE_SETTINGS_ID,
  loadEffectiveModuleFlags,
  normalizeClubModuleSettings,
} from "@/lib/module-settings";

export const ADMIN_MODULE_KEYS = MODULE_KEYS;
export type AdminModuleKey = ModuleKey;
export type AdminModuleSettingsSnapshot = ModuleSettingsValues;
export const DEFAULT_ADMIN_MODULE_SETTINGS = DEFAULT_MODULE_SETTINGS;
export const normalizeAdminModuleSettings = normalizeClubModuleSettings;

interface ClubModuleSettingsClient {
  clubModuleSettings?: {
    findUnique: (args: {
      where: { id: string };
    }) => Promise<Parameters<typeof normalizeClubModuleSettings>[0]>;
  };
}

export function getEffectiveModuleState(
  envCapability: FeatureFlags = featureFlags,
  adminActivation: AdminModuleSettingsSnapshot = DEFAULT_ADMIN_MODULE_SETTINGS,
): FeatureFlags {
  return getEffectiveModuleFlags(envCapability, adminActivation);
}

export async function loadAdminModuleSettings(
  client?: ClubModuleSettingsClient,
): Promise<AdminModuleSettingsSnapshot> {
  const db =
    client ??
    ((await import("@/lib/prisma")).prisma as unknown as ClubModuleSettingsClient);

  if (!db.clubModuleSettings?.findUnique) {
    return DEFAULT_ADMIN_MODULE_SETTINGS;
  }

  try {
    const record = await db.clubModuleSettings.findUnique({
      where: { id: CLUB_MODULE_SETTINGS_ID },
    });

    return normalizeClubModuleSettings(record);
  } catch {
    return DEFAULT_ADMIN_MODULE_SETTINGS;
  }
}

export async function loadEffectiveModuleState(
  envCapability: FeatureFlags = featureFlags,
  client?: ClubModuleSettingsClient,
): Promise<FeatureFlags> {
  if (!client) {
    return loadEffectiveModuleFlags(envCapability);
  }

  const adminActivation = await loadAdminModuleSettings(client);
  return getEffectiveModuleState(envCapability, adminActivation);
}

export async function isEffectiveModuleEnabled(
  moduleKey: AdminModuleKey,
  envCapability: FeatureFlags = featureFlags,
  client?: ClubModuleSettingsClient,
): Promise<boolean> {
  const effective = await loadEffectiveModuleState(envCapability, client);
  return effective[moduleKey];
}
