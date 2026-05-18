import type { FeatureFlags } from "./schema";

export const MODULE_KEYS = [
  "kiosk",
  "chores",
  "financeDashboard",
  "waitlist",
  "xeroIntegration",
] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];
export type ModuleSettingsValues = Record<ModuleKey, boolean>;

export const DEFAULT_MODULE_SETTINGS: ModuleSettingsValues = {
  kiosk: true,
  chores: true,
  financeDashboard: true,
  waitlist: true,
  xeroIntegration: true,
};

export interface ModuleDefinition {
  key: ModuleKey;
  label: string;
  description: string;
  envVar: string;
  dependencies: string[];
}

export const MODULE_DEFINITIONS: Record<ModuleKey, ModuleDefinition> = {
  kiosk: {
    key: "kiosk",
    label: "Lodge kiosk",
    description: "Guest arrival, departure, and lodge access screens.",
    envVar: "FEATURE_KIOSK",
    dependencies: ["Deploy-time kiosk capability must be enabled."],
  },
  chores: {
    key: "chores",
    label: "Chores and roster",
    description: "Roster generation, chore templates, and guest chore tracking.",
    envVar: "FEATURE_CHORES",
    dependencies: ["Deploy-time chores capability must be enabled."],
  },
  financeDashboard: {
    key: "financeDashboard",
    label: "Finance dashboard",
    description: "Finance reports, sync diagnostics, and finance-only dashboards.",
    envVar: "FEATURE_FINANCE_DASHBOARD",
    dependencies: [
      "Deploy-time finance dashboard capability must be enabled.",
      "Finance access levels and finance data sync are configured separately.",
    ],
  },
  waitlist: {
    key: "waitlist",
    label: "Waitlist",
    description: "Waitlist booking state, admin queue, and offer handling.",
    envVar: "FEATURE_WAITLIST",
    dependencies: ["Deploy-time waitlist capability must be enabled."],
  },
  xeroIntegration: {
    key: "xeroIntegration",
    label: "Xero integration",
    description: "Operational Xero linking, sync actions, and reconciliation tools.",
    envVar: "FEATURE_XERO_INTEGRATION",
    dependencies: [
      "Deploy-time Xero capability must be enabled.",
      "Xero OAuth credentials, tenant tokens, and account mappings are configured outside this table.",
    ],
  },
};

export function getModuleCapabilityFlags(
  flags: FeatureFlags,
): ModuleSettingsValues {
  return {
    kiosk: flags.kiosk,
    chores: flags.chores,
    financeDashboard: flags.financeDashboard,
    waitlist: flags.waitlist,
    xeroIntegration: flags.xeroIntegration,
  };
}

export function getEffectiveModuleFlags(
  flags: FeatureFlags,
  settings: ModuleSettingsValues,
): FeatureFlags {
  return {
    kiosk: flags.kiosk && settings.kiosk,
    chores: flags.chores && settings.chores,
    financeDashboard: flags.financeDashboard && settings.financeDashboard,
    waitlist: flags.waitlist && settings.waitlist,
    xeroIntegration: flags.xeroIntegration && settings.xeroIntegration,
  };
}
