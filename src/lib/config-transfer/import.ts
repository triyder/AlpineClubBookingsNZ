import "server-only";

import { readBundle } from "./bundle";
import {
  computeFingerprint,
  type CategoryImporter,
  type CategoryPlan,
  type ImportPlan,
  type ReadDb,
} from "./import-types";
import { siteContentImporter } from "./categories/site-content";
import { clubSettingsImporter } from "./categories/club-settings";
import { lodgeConfigImporter } from "./categories/lodge-config";
import { lodgeOpsImporter } from "./categories/lodge-ops";
import { committeeImporter } from "./categories/committee";
import { inductionImporter } from "./categories/induction";
import { xeroConfigImporter } from "./categories/xero-config";

// Import plan orchestrator (dry-run). Reads + validates the bundle, runs each
// selected category's planner, and produces a stateless ImportPlan with a
// fingerprint of the touched rows. See ADR-002.

/** All registered category importers, in dependency-safe apply order. */
export const CATEGORY_IMPORTERS: CategoryImporter[] = [
  siteContentImporter,
  clubSettingsImporter,
  lodgeConfigImporter,
  lodgeOpsImporter,
  committeeImporter,
  inductionImporter,
  xeroConfigImporter,
];

export async function buildImportPlan(
  db: ReadDb,
  bundleBytes: Uint8Array,
): Promise<ImportPlan> {
  const { manifest, files } = readBundle(bundleBytes);

  // A category may be served by more than one importer module (e.g.
  // lodge-config); merge their results into one plan section per category.
  const byCategory = new Map<string, CategoryPlan>();
  const fingerprintParts: string[] = [];
  const summary = { create: 0, update: 0, unchanged: 0 };

  for (const importer of CATEGORY_IMPORTERS) {
    if (!manifest.includedCategories.includes(importer.category)) continue;
    const result = await importer.plan({ db, files, manifest });
    const merged = byCategory.get(importer.category) ?? {
      category: importer.category,
      items: [],
      warnings: [],
      fingerprintParts: [],
    };
    merged.items.push(...result.items);
    merged.warnings.push(...result.warnings);
    merged.fingerprintParts.push(...result.fingerprintParts);
    byCategory.set(importer.category, merged);
    fingerprintParts.push(...result.fingerprintParts);
    for (const item of result.items) {
      if (item.action === "create") summary.create += 1;
      else if (item.action === "update") summary.update += 1;
      else summary.unchanged += 1;
    }
  }
  const categories: CategoryPlan[] = [...byCategory.values()];

  // Xero cross-org check only matters when the Xero category is present.
  const xeroInBundle = manifest.includedCategories.includes("xero-config");
  const targetTenantId = xeroInBundle
    ? await getConnectedXeroTenantId(db)
    : null;
  const mismatch =
    xeroInBundle &&
    manifest.sourceXeroTenantId !== null &&
    manifest.sourceXeroTenantId !== targetTenantId;

  return {
    formatVersion: manifest.formatVersion,
    categories,
    fingerprint: computeFingerprint(fingerprintParts),
    doorCodesIncluded: manifest.doorCodesIncluded,
    xero: {
      sourceTenantId: manifest.sourceXeroTenantId,
      targetTenantId,
      mismatch,
    },
    summary,
  };
}

/** The connected Xero org (tenant) id, or null if not connected. */
async function getConnectedXeroTenantId(db: ReadDb): Promise<string | null> {
  const token = await db.xeroToken.findFirst({
    select: { tenantId: true },
    orderBy: { updatedAt: "desc" },
  });
  return token?.tenantId ?? null;
}
