import { describe, expect, it, vi } from "vitest";
import { strFromU8 } from "fflate";

vi.mock("server-only", () => ({}));

import { Prisma } from "@prisma/client";

import { buildConfigExport } from "@/lib/config-transfer/export";
import { buildImportPlan } from "@/lib/config-transfer/import";
import { readBundle } from "@/lib/config-transfer/bundle";
import { SINGLETONS } from "@/lib/config-transfer/categories/club-settings";
import type { ReadDb } from "@/lib/config-transfer/import-types";

// Delegate names touched by the club-settings category.
const SINGLETON_DELEGATES = [
  "clubModuleSettings",
  "bookingDefaults",
  "memberFieldsSettings",
  "bedAllocationSettings",
  "bookingRequestSettings",
  "internetBankingPaymentSettings",
  "emailMessageSetting",
  "groupDiscountSetting",
  "membershipNominationSettings",
  "membershipLockoutSettings",
  "membershipCancellationSetting",
];

/** Build a stub DB whose singleton delegates return the given rows (else null). */
function stubDb(rows: Record<string, Record<string, unknown> | null>): ReadDb {
  const db: Record<string, unknown> = {
    xeroToken: { findFirst: vi.fn().mockResolvedValue(null) },
  };
  for (const name of SINGLETON_DELEGATES) {
    db[name] = {
      findUnique: vi.fn().mockResolvedValue(rows[name] ?? null),
    };
  }
  return db as unknown as ReadDb;
}

const MODULES = {
  kiosk: false, chores: false, financeDashboard: false, waitlist: false,
  xeroIntegration: false, bedAllocation: true, internetBankingPayments: false,
  addressAutocomplete: false, groupBookings: true, lockers: true,
  induction: true, workParties: true, promoCodes: true, hutLeaders: true,
  communications: true, skifieldConditions: true, multiLodge: true,
  twoFactor: false, analytics: false,
};
const EMAIL = {
  clubName: "Grads", bookingsName: "Bookings", lodgeName: "Lodge",
  emailFromName: "Grads", supportEmail: "s@x.nz", contactEmail: "c@x.nz",
  publicUrl: "https://x.nz", lodgeTravelNote: "Turn left", doorCode: "1234",
};

async function exportBundle(includeDoorCodes: boolean) {
  return buildConfigExport({
    db: stubDb({ clubModuleSettings: MODULES, emailMessageSetting: EMAIL }),
    categories: ["club-settings"],
    includeDoorCodes,
    appVersion: "0.10.1",
    prismaMigration: null,
    generatedAt: "2026-07-08T00:00:00.000Z",
  });
}

describe("config-transfer club-settings", () => {
  it("exports present singletons as JSON and omits door codes by default", async () => {
    const { zip } = await exportBundle(false);
    const { manifest, files } = readBundle(zip);
    const paths = manifest.files.map((f) => f.path);
    expect(paths).toContain("club-settings/club-module-settings.json");
    expect(paths).toContain("club-settings/email-message-setting.json");
    // Absent singletons are not emitted.
    expect(paths).not.toContain("club-settings/booking-defaults.json");

    const email = JSON.parse(
      strFromU8(files.get("club-settings/email-message-setting.json")!),
    );
    expect(email.clubName).toBe("Grads");
    // doorCode was dropped from EmailMessageSetting (fork #15); it must never be
    // emitted here — the lodge door code travels in lodge.json instead.
    expect("doorCode" in email).toBe(false);
  });

  it("plans singleton create vs update against the target DB", async () => {
    const { zip } = await exportBundle(false);
    // Target: module settings differ (update); email settings absent (create).
    const target = stubDb({
      clubModuleSettings: { ...MODULES, multiLodge: false },
    });
    const plan = await buildImportPlan(target, zip, { mode: "merge" });
    const items = plan.categories[0].items;
    const modules = items.find((i) => i.entity === "club-module-settings");
    const email = items.find((i) => i.entity === "email-message-setting");
    expect(modules?.action).toBe("update");
    expect(modules?.changedFields).toContain("multiLodge");
    expect(email?.action).toBe("create");
  });
});

// Guard against the class of bug where an upstream schema change drops/renames a
// column that a singleton allowlist still names — the club-settings apply uses an
// untyped delegate, so typecheck can't catch it and it only fails at write time
// on the server (as EmailMessageSetting.doorCode did after fork #15). This
// validates every singleton field against the real Prisma model columns.
describe("club-settings allowlists match the Prisma schema", () => {
  it("every singleton field is a real column on its model", () => {
    const columnsByModel = new Map(
      Prisma.dmmf.datamodel.models.map((m) => [m.name, new Set(m.fields.map((f) => f.name))]),
    );
    const problems: string[] = [];
    for (const spec of SINGLETONS) {
      const modelName = spec.delegate[0].toUpperCase() + spec.delegate.slice(1);
      const columns = columnsByModel.get(modelName);
      if (!columns) {
        problems.push(`delegate "${spec.delegate}" → no Prisma model "${modelName}"`);
        continue;
      }
      for (const field of spec.fields) {
        if (!columns.has(field)) problems.push(`${modelName}.${field} is not a column`);
      }
    }
    expect(problems).toEqual([]);
  });
});
