import { describe, expect, it, vi } from "vitest";
import { strFromU8 } from "fflate";

vi.mock("server-only", () => ({}));

import { buildConfigExport } from "@/lib/config-transfer/export";
import { buildImportPlan } from "@/lib/config-transfer/import";
import { readBundle } from "@/lib/config-transfer/bundle";
import { parseCsv } from "@/lib/config-transfer/csv";
import type { ReadDb } from "@/lib/config-transfer/import-types";

function sourceDb(): ReadDb {
  return {
    committeeRole: {
      findMany: vi.fn().mockResolvedValue([
        { key: "president", name: "President", description: "Runs it", contactEmail: "p@x.nz", isActive: true, sortOrder: 1 },
      ]),
    },
    committeeMember: {
      findMany: vi.fn().mockResolvedValue([
        { role: "President", name: "Pat", phone: "021", email: "p@x.nz", contactKey: null, description: "d", sortOrder: 1, active: true },
      ]),
    },
    xeroAccountMapping: {
      findMany: vi.fn().mockResolvedValue([
        { key: "hutFeesIncome", code: "200", itemCode: null },
      ]),
    },
    xeroItemCodeMapping: {
      findMany: vi.fn().mockResolvedValue([
        { category: "HUT_FEE", ageTier: "ADULT", seasonType: "WINTER", isMember: true, entranceFeeCategory: null, itemCode: "HUT-A", amountCents: null },
      ]),
    },
  } as unknown as ReadDb;
}

function emptyTargetDb(): ReadDb {
  return {
    committeeRole: { findUnique: vi.fn().mockResolvedValue(null) },
    committeeMember: { findFirst: vi.fn().mockResolvedValue(null) },
    xeroAccountMapping: { findUnique: vi.fn().mockResolvedValue(null) },
    xeroItemCodeMapping: { findUnique: vi.fn().mockResolvedValue(null) },
    xeroToken: { findFirst: vi.fn().mockResolvedValue(null) },
  } as unknown as ReadDb;
}

async function exportCats() {
  return buildConfigExport({
    db: sourceDb(),
    categories: ["committee", "xero-config"],
    includeDoorCodes: false,
    appVersion: "0.10.1",
    prismaMigration: null,
    sourceXeroTenantId: "tenant-src",
    generatedAt: "2026-07-08T00:00:00.000Z",
  });
}

describe("config-transfer committee + xero-config", () => {
  it("exports committee roles/members and xero mappings", async () => {
    const { zip } = await exportCats();
    const { manifest, files } = readBundle(zip);
    expect(manifest.includedCategories).toEqual(
      expect.arrayContaining(["committee", "xero-config"]),
    );
    expect(manifest.sourceXeroTenantId).toBe("tenant-src");

    const roles = parseCsv(strFromU8(files.get("committee/roles.csv")!));
    expect(roles.rows[0].key).toBe("president");
    const accounts = parseCsv(strFromU8(files.get("xero-config/account-mappings.csv")!));
    expect(accounts.rows[0].key).toBe("hutFeesIncome");
  });

  it("plans all-create against an empty target and warns on Xero", async () => {
    const { zip } = await exportCats();
    const plan = await buildImportPlan(emptyTargetDb(), zip);
    const committee = plan.categories.find((c) => c.category === "committee")!;
    const xero = plan.categories.find((c) => c.category === "xero-config")!;
    expect(committee.items.every((i) => i.action === "create")).toBe(true);
    expect(xero.items.every((i) => i.action === "create")).toBe(true);
    expect(xero.warnings.join(" ")).toMatch(/connected Xero org/i);
    // Xero tenant mismatch (source tenant vs no connected org) is flagged.
    expect(plan.xero.mismatch).toBe(true);
  });
});
