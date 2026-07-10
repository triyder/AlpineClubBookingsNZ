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
    // Connected Xero org, stamped into xero-config/source.json by the exporter.
    xeroToken: { findFirst: vi.fn().mockResolvedValue({ tenantId: "tenant-src" }) },
  } as unknown as ReadDb;
}

function emptyTargetDb(): ReadDb {
  return {
    committeeRole: { findMany: vi.fn().mockResolvedValue([]) },
    xeroAccountMapping: { findMany: vi.fn().mockResolvedValue([]) },
    xeroItemCodeMapping: { findMany: vi.fn().mockResolvedValue([]) },
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
    generatedAt: "2026-07-08T00:00:00.000Z",
  });
}

describe("config-transfer committee + xero-config", () => {
  it("exports committee roles (only) and xero mappings, with source org in a category file", async () => {
    const { zip } = await exportCats();
    const { manifest, files } = readBundle(zip);
    expect(manifest.includedCategories).toEqual(
      expect.arrayContaining(["committee", "xero-config"]),
    );
    // The source Xero org lives in a category-local file, not the manifest.
    expect("sourceXeroTenantId" in manifest).toBe(false);
    const source = JSON.parse(strFromU8(files.get("xero-config/source.json")!)) as {
      tenantId: string | null;
    };
    expect(source.tenantId).toBe("tenant-src");

    const roles = parseCsv(strFromU8(files.get("committee/roles.csv")!));
    expect(roles.rows[0].key).toBe("president");
    // The legacy standalone committee members file is no longer exported.
    expect(files.get("committee/members.csv")).toBeUndefined();

    const accounts = parseCsv(strFromU8(files.get("xero-config/account-mappings.csv")!));
    expect(accounts.rows[0].key).toBe("hutFeesIncome");
  });

  it("plans all-create against an empty target and warns on Xero", async () => {
    const { zip } = await exportCats();
    const plan = await buildImportPlan(emptyTargetDb(), zip, { mode: "merge" });
    const committee = plan.categories.find((c) => c.category === "committee")!;
    const xero = plan.categories.find((c) => c.category === "xero-config")!;
    expect(committee.items.every((i) => i.action === "create")).toBe(true);
    expect(xero.items.every((i) => i.action === "create")).toBe(true);
    expect(xero.warnings.join(" ")).toMatch(/connected Xero org/i);
    // Source org (tenant-src) vs no connected target org → mismatch flagged.
    expect(plan.xero.sourceTenantId).toBe("tenant-src");
    expect(plan.xero.mismatch).toBe(true);
  });
});
