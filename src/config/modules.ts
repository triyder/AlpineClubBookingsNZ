import type { FeatureFlags } from "./schema";

export const MODULE_KEYS = [
  "kiosk",
  "chores",
  "financeDashboard",
  "waitlist",
  "xeroIntegration",
  "bedAllocation",
  "internetBankingPayments",
  "groupBookings",
  "lockers",
  "induction",
  "workParties",
  "promoCodes",
  "hutLeaders",
  "communications",
  "skifieldConditions",
] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];
export type ModuleSettingsValues = Record<ModuleKey, boolean>;

export const DEFAULT_MODULE_SETTINGS: ModuleSettingsValues = {
  kiosk: true,
  chores: true,
  financeDashboard: true,
  waitlist: true,
  xeroIntegration: true,
  bedAllocation: true,
  internetBankingPayments: true,
  groupBookings: true,
  lockers: true,
  induction: true,
  workParties: true,
  promoCodes: true,
  hutLeaders: true,
  communications: true,
  skifieldConditions: true,
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
  bedAllocation: {
    key: "bedAllocation",
    label: "Bed allocation",
    description: "Room and bed setup plus admin guest-to-bed allocation.",
    envVar: "FEATURE_BED_ALLOCATION",
    dependencies: [
      "Deploy-time bed allocation capability must be enabled.",
      "Room and bed inventory is configured separately.",
    ],
  },
  internetBankingPayments: {
    key: "internetBankingPayments",
    label: "Internet Banking payments",
    description: "Member Internet Banking payment option backed by Xero invoices.",
    envVar: "FEATURE_INTERNET_BANKING_PAYMENTS",
    dependencies: [
      "Deploy-time Internet Banking payment capability must be enabled.",
      "Operational Xero must be active before invoices can be issued.",
    ],
  },
  groupBookings: {
    key: "groupBookings",
    label: "Group bookings",
    description:
      "Organisers open a booking as a group and share a join code so members and guests can add themselves.",
    envVar: "FEATURE_GROUP_BOOKINGS",
    dependencies: [
      "Organiser-paid settlement also requires Xero integration and Internet Banking payments.",
    ],
  },
  lockers: {
    key: "lockers",
    label: "Lockers",
    description:
      "Record physical lockers and allocate them to members; allocations show on the member dashboard.",
    envVar: "FEATURE_LOCKERS",
    dependencies: [],
  },
  induction: {
    key: "induction",
    label: "Lodge induction",
    description:
      "New-member lodge induction checklists, self-assessment, and sponsor sign-off.",
    envVar: "FEATURE_INDUCTION",
    dependencies: [
      "When off, inductions are no longer auto-created for newly approved members.",
    ],
  },
  workParties: {
    key: "workParties",
    label: "Work parties",
    description:
      "Organised volunteer working bees and the booking discounts they grant.",
    envVar: "FEATURE_WORK_PARTIES",
    dependencies: [],
  },
  promoCodes: {
    key: "promoCodes",
    label: "Promo codes",
    description:
      "Discount codes members can apply to bookings, plus admin management.",
    envVar: "FEATURE_PROMO_CODES",
    dependencies: [],
  },
  hutLeaders: {
    key: "hutLeaders",
    label: "Hut leaders",
    description:
      "Daily hut-leader assignments, kiosk access, and auto-assignment. Roster generation stays under the Chores module.",
    envVar: "FEATURE_HUT_LEADERS",
    dependencies: [],
  },
  communications: {
    key: "communications",
    label: "Communications",
    description:
      "Admin bulk email to members. Does not affect transactional notifications.",
    envVar: "FEATURE_COMMUNICATIONS",
    dependencies: [],
  },
  skifieldConditions: {
    key: "skifieldConditions",
    label: "Ski-field conditions",
    description:
      "Live mountain/road status panel and widgets, plus the admin conditions cache.",
    envVar: "FEATURE_SKIFIELD_CONDITIONS",
    dependencies: [],
  },
};

export function getModuleCapabilityFlags(
  flags: FeatureFlags,
): ModuleSettingsValues {
  return Object.fromEntries(
    MODULE_KEYS.map((key) => [key, flags[key]]),
  ) as ModuleSettingsValues;
}

export function getEffectiveModuleFlags(
  flags: FeatureFlags,
  settings: ModuleSettingsValues,
): FeatureFlags {
  return Object.fromEntries(
    MODULE_KEYS.map((key) => [key, flags[key] && settings[key]]),
  ) as FeatureFlags;
}
