import type { ClubModuleSettings } from "@prisma/client";
import {
  CLUB_MODULE_SETTINGS_COLUMN_SELECT,
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

type ModuleReadinessStatus =
  | "ready"
  | "admin_disabled"
  | "credentials_missing";

interface ModuleStatus {
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
  key: ModuleKey;
  label: string;
  adminEnabled: boolean;
}): { status: ModuleReadinessStatus; message: string } {
  if (!params.adminEnabled) {
    return {
      status: "admin_disabled",
      message: `${params.label} is turned off in the admin Modules settings.`,
    };
  }

  if (
    params.key === "addressAutocomplete" &&
    (!process.env.ADDY_API_KEY?.trim() || !process.env.ADDY_API_SECRET?.trim())
  ) {
    return {
      status: "credentials_missing",
      message:
        "Address autocomplete is enabled, but ADDY_API_KEY and ADDY_API_SECRET are not both configured.",
    };
  }

  if (
    params.key === "analytics" &&
    !process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID?.trim()
  ) {
    return {
      status: "credentials_missing",
      message:
        "Google Analytics is enabled, but NEXT_PUBLIC_GA_MEASUREMENT_ID is not configured.",
    };
  }

  return {
    status: "ready",
    message: `${params.label} is enabled.`,
  };
}

function buildModuleStatusList(
  settings: ModuleSettingsValues,
): ModuleStatus[] {
  return MODULE_KEYS.map((key) => {
    const definition = MODULE_DEFINITIONS[key];
    const adminEnabled = settings[key];
    const readiness = readinessMessage({
      key,
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
    select: CLUB_MODULE_SETTINGS_COLUMN_SELECT,
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
      select: CLUB_MODULE_SETTINGS_COLUMN_SELECT,
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
