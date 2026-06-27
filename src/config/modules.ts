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

// Default activation for a club that has not saved its Modules page yet. The
// optional "capability" modules (which require deploy-time setup such as Xero
// credentials, kiosk hardware, or bed inventory) default OFF so a fresh install
// opts into them deliberately. The general-purpose modules default ON so the
// software is fully featured out of the box and each club switches OFF what it
// does not use.
export const DEFAULT_MODULE_SETTINGS: ModuleSettingsValues = {
  kiosk: false,
  chores: false,
  financeDashboard: false,
  waitlist: false,
  xeroIntegration: false,
  bedAllocation: false,
  internetBankingPayments: false,
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
  dependencies: string[];
}

export const MODULE_DEFINITIONS: Record<ModuleKey, ModuleDefinition> = {
  kiosk: {
    key: "kiosk",
    label: "Lodge kiosk",
    description: "Guest arrival, departure, and lodge access screens.",
    dependencies: [],
  },
  chores: {
    key: "chores",
    label: "Chores and roster",
    description: "Roster generation, chore templates, and guest chore tracking.",
    dependencies: [],
  },
  financeDashboard: {
    key: "financeDashboard",
    label: "Finance dashboard",
    description: "Finance reports, sync diagnostics, and finance-only dashboards.",
    dependencies: [
      "Finance access levels and finance data sync are configured separately.",
    ],
  },
  waitlist: {
    key: "waitlist",
    label: "Waitlist",
    description: "Waitlist booking state, admin queue, and offer handling.",
    dependencies: [],
  },
  xeroIntegration: {
    key: "xeroIntegration",
    label: "Xero integration",
    description: "Operational Xero linking, sync actions, and reconciliation tools.",
    dependencies: [
      "Xero OAuth credentials, tenant tokens, and account mappings are configured outside this table.",
    ],
  },
  bedAllocation: {
    key: "bedAllocation",
    label: "Bed allocation",
    description: "Room and bed setup plus admin guest-to-bed allocation.",
    dependencies: [
      "Room and bed inventory is configured separately.",
    ],
  },
  internetBankingPayments: {
    key: "internetBankingPayments",
    label: "Internet Banking payments",
    description: "Member Internet Banking payment option backed by Xero invoices.",
    dependencies: [
      "Operational Xero must be active before invoices can be issued.",
    ],
  },
  groupBookings: {
    key: "groupBookings",
    label: "Group bookings",
    description:
      "Organisers open a booking as a group and share a join code so members and guests can add themselves.",
    dependencies: [
      "Organiser-paid settlement also requires Xero integration and Internet Banking payments.",
    ],
  },
  lockers: {
    key: "lockers",
    label: "Lockers",
    description:
      "Record physical lockers and allocate them to members; allocations show on the member dashboard.",
    dependencies: [],
  },
  induction: {
    key: "induction",
    label: "Lodge induction",
    description:
      "New-member lodge induction checklists, self-assessment, and sponsor sign-off.",
    dependencies: [
      "When off, inductions are no longer auto-created for newly approved members.",
    ],
  },
  workParties: {
    key: "workParties",
    label: "Work parties",
    description:
      "Organised volunteer working bees and the booking discounts they grant.",
    dependencies: [],
  },
  promoCodes: {
    key: "promoCodes",
    label: "Promo codes",
    description:
      "Discount codes members can apply to bookings, plus admin management.",
    dependencies: [],
  },
  hutLeaders: {
    key: "hutLeaders",
    label: "Hut leaders",
    description:
      "Daily hut-leader assignments, kiosk access, and auto-assignment. Roster generation stays under the Chores module.",
    dependencies: [],
  },
  communications: {
    key: "communications",
    label: "Communications",
    description:
      "Admin bulk email to members. Does not affect transactional notifications.",
    dependencies: [],
  },
  skifieldConditions: {
    key: "skifieldConditions",
    label: "Ski-field conditions",
    description:
      "Live mountain/road status panel and widgets, plus the admin conditions cache.",
    dependencies: [],
  },
};

export function getEffectiveModuleFlags(
  settings: ModuleSettingsValues,
): FeatureFlags {
  // Modules are controlled solely by the admin Modules page.
  return Object.fromEntries(
    MODULE_KEYS.map((key) => [key, settings[key]]),
  ) as FeatureFlags;
}
