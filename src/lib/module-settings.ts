import type { ClubModuleSettings } from "@prisma/client";
import {
  DEFAULT_MODULE_SETTINGS,
  MODULE_DEFINITIONS,
  MODULE_KEYS,
  getEffectiveModuleFlags,
  type ModuleKey,
  type ModuleSettingsValues,
} from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

export const CLUB_MODULE_SETTINGS_ID = "default";

export type ModuleReadinessStatus = "ready" | "admin_disabled";

export interface ModuleStatus {
  key: ModuleKey;
  label: string;
  description: string;
  adminEnabled: boolean;
  effectiveEnabled: boolean;
  readiness: {
    status: ModuleReadinessStatus;
    message: string;
    dependencies: string[];
  };
}

export interface ClubModuleSettingsPayload {
  settings: ModuleSettingsValues;
  modules: ModuleStatus[];
  updatedAt: string | null;
  updatedByMemberId: string | null;
}

type ClubModuleSettingsRecord = Pick<
  ClubModuleSettings,
  ModuleKey | "updatedAt" | "updatedByMemberId"
>;

export function normalizeClubModuleSettings(
  record?: Partial<ClubModuleSettingsRecord> | null,
): ModuleSettingsValues {
  return Object.fromEntries(
    MODULE_KEYS.map((key) => [key, record?.[key] ?? DEFAULT_MODULE_SETTINGS[key]]),
  ) as ModuleSettingsValues;
}

function readinessMessage(params: {
  label: string;
  adminEnabled: boolean;
}): { status: ModuleReadinessStatus; message: string } {
  if (!params.adminEnabled) {
    return {
      status: "admin_disabled",
      message: `${params.label} is turned off in the admin Modules settings.`,
    };
  }

  return {
    status: "ready",
    message: `${params.label} is enabled.`,
  };
}

export function buildModuleStatusList(
  settings: ModuleSettingsValues,
): ModuleStatus[] {
  return MODULE_KEYS.map((key) => {
    const definition = MODULE_DEFINITIONS[key];
    const adminEnabled = settings[key];
    const readiness = readinessMessage({
      label: definition.label,
      adminEnabled,
    });

    return {
      key,
      label: definition.label,
      description: definition.description,
      adminEnabled,
      effectiveEnabled: adminEnabled,
      readiness: {
        ...readiness,
        dependencies: definition.dependencies,
      },
    };
  });
}

export function buildClubModuleSettingsPayload(
  record?: Partial<ClubModuleSettingsRecord> | null,
): ClubModuleSettingsPayload {
  const settings = normalizeClubModuleSettings(record);

  return {
    settings,
    modules: buildModuleStatusList(settings),
    updatedAt: record?.updatedAt?.toISOString() ?? null,
    updatedByMemberId: record?.updatedByMemberId ?? null,
  };
}

export async function loadClubModuleSettings(): Promise<ClubModuleSettingsPayload> {
  const record = await prisma.clubModuleSettings.findUnique({
    where: { id: CLUB_MODULE_SETTINGS_ID },
  });

  return buildClubModuleSettingsPayload(record);
}

const DISABLED_MODULE_FLAGS: FeatureFlags = Object.fromEntries(
  MODULE_KEYS.map((key) => [key, false]),
) as FeatureFlags;

export async function loadEffectiveModuleFlags(): Promise<FeatureFlags> {
  try {
    const record = await prisma.clubModuleSettings.findUnique({
      where: { id: CLUB_MODULE_SETTINGS_ID },
    });

    return getEffectiveModuleFlags(normalizeClubModuleSettings(record));
  } catch (err) {
    logger.error(
      { err },
      "Failed to load club module settings; disabling optional modules",
    );
    return DISABLED_MODULE_FLAGS;
  }
}
