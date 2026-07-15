import { describe, expect, it, vi } from "vitest";
import { strFromU8, strToU8 } from "fflate";

vi.mock("server-only", () => ({}));

import { Prisma } from "@prisma/client";

import { buildConfigExport } from "@/lib/config-transfer/export";
import { buildImportPlan } from "@/lib/config-transfer/import";
import { readBundle } from "@/lib/config-transfer/bundle";
import {
  SINGLETONS,
  clubSettingsImporter,
} from "@/lib/config-transfer/categories/club-settings";
import type { ApplyContext, ReadDb, TxDb } from "@/lib/config-transfer/import-types";
import { CLUB_MODULE_SETTINGS_COLUMN_SELECT } from "@/config/modules";

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
  communications: true, skifieldConditions: true,
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
      clubModuleSettings: { ...MODULES, bedAllocation: false },
    });
    const plan = await buildImportPlan(target, zip, { mode: "merge" });
    const items = plan.categories[0].items;
    const modules = items.find((i) => i.entity === "club-module-settings");
    const email = items.find((i) => i.entity === "email-message-setting");
    expect(modules?.action).toBe("update");
    expect(modules?.changedFields).toContain("bedAllocation");
    expect(email?.action).toBe("create");
  });
});

// Guard against the #153 regression: every ClubModuleSettings read in this
// category (export, plan, apply) must use the shared column select so a
// retired-but-not-yet-dropped column never appears in the generated SQL (see
// CLUB_MODULE_SETTINGS_COLUMN_SELECT in src/config/modules.ts and #150/#139).
describe("club-module-settings singleton reads use the explicit column select", () => {
  it("declares the shared select on the SINGLETONS spec", () => {
    const spec = SINGLETONS.find((s) => s.entity === "club-module-settings");
    expect(spec?.select).toEqual(CLUB_MODULE_SETTINGS_COLUMN_SELECT);
  });

  it("passes the select through on export", async () => {
    const db = stubDb({ clubModuleSettings: MODULES });
    await buildConfigExport({
      db,
      categories: ["club-settings"],
      includeDoorCodes: false,
      appVersion: "0.10.1",
      prismaMigration: null,
      generatedAt: "2026-07-08T00:00:00.000Z",
    });
    const findUnique = (
      db as unknown as { clubModuleSettings: { findUnique: ReturnType<typeof vi.fn> } }
    ).clubModuleSettings.findUnique;
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "default" },
      select: CLUB_MODULE_SETTINGS_COLUMN_SELECT,
    });
  });

  it("passes the select through on plan", async () => {
    const { zip } = await exportBundle(false);
    const target = stubDb({ clubModuleSettings: MODULES });
    await buildImportPlan(target, zip, { mode: "merge" });
    const findUnique = (
      target as unknown as { clubModuleSettings: { findUnique: ReturnType<typeof vi.fn> } }
    ).clubModuleSettings.findUnique;
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "default" },
      select: CLUB_MODULE_SETTINGS_COLUMN_SELECT,
    });
  });

  it("passes the select through on apply (create branch, no existing row)", async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const upsert = vi.fn().mockResolvedValue(null);
    const tx = {
      clubModuleSettings: {
        findUnique,
        upsert,
      },
    } as unknown as TxDb;
    const files = new Map<string, Uint8Array>();
    files.set(
      "club-settings/club-module-settings.json",
      strToU8(JSON.stringify(MODULES)),
    );
    const ctx: ApplyContext = {
      tx,
      files,
      manifest: {} as unknown as ApplyContext["manifest"],
      mode: "merge",
      resolutions: new Map(),
      actorMemberId: "test-actor",
      imageRemap: new Map(),
      notes: { doorCodesWritten: [] },
    };
    await clubSettingsImporter.apply(ctx);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "default" },
      select: CLUB_MODULE_SETTINGS_COLUMN_SELECT,
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "default" },
        select: CLUB_MODULE_SETTINGS_COLUMN_SELECT,
      }),
    );
  });

  it("passes the select through on apply (update branch, existing row changed)", async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValue({ ...MODULES, bedAllocation: false });
    const upsert = vi.fn().mockResolvedValue(null);
    const tx = {
      clubModuleSettings: {
        findUnique,
        upsert,
      },
    } as unknown as TxDb;
    const files = new Map<string, Uint8Array>();
    files.set(
      "club-settings/club-module-settings.json",
      strToU8(JSON.stringify(MODULES)),
    );
    const ctx: ApplyContext = {
      tx,
      files,
      manifest: {} as unknown as ApplyContext["manifest"],
      mode: "merge",
      resolutions: new Map(),
      actorMemberId: "test-actor",
      imageRemap: new Map(),
      notes: { doorCodesWritten: [] },
    };
    await clubSettingsImporter.apply(ctx);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "default" },
        select: CLUB_MODULE_SETTINGS_COLUMN_SELECT,
      }),
    );
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
