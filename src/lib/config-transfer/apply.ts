import "server-only";

import type { PrismaClient } from "@prisma/client";

import { createAuditLog } from "@/lib/audit";
import { runDatabaseBackup } from "@/lib/backup";
import { readBundle } from "./bundle";
import { buildImportPlan } from "./import";
import { CATEGORY_IMPORTERS } from "./import";
import { recreateBundleMedia } from "./media";
import type { CategoryApplyResult, TxDb } from "./import-types";

// Apply orchestrator: re-plans against current DB, refuses on fingerprint drift,
// takes a pre-apply database backup, then applies every selected category inside
// one transaction under a single-flight advisory lock, and audits the result.
// Upsert-only, never deletes (ADR-002).

export class ConfigImportDriftError extends Error {
  constructor() {
    super(
      "The database changed since the import was previewed; re-run the dry-run and try again.",
    );
    this.name = "ConfigImportDriftError";
  }
}

export class ConfigImportBackupError extends Error {
  constructor(cause: string) {
    super(`Refusing to import: the pre-apply database backup failed (${cause}).`);
    this.name = "ConfigImportBackupError";
  }
}

/** Single-flight lock so two imports cannot apply concurrently. */
async function acquireConfigImportLock(tx: TxDb): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('config-transfer-import'))`;
}

export type ApplyConfigImportParams = {
  prisma: PrismaClient;
  bundleBytes: Uint8Array;
  actorMemberId: string;
  /** Fingerprint from the dry-run; apply refuses if the DB has since drifted. */
  expectedFingerprint: string;
};

export type ApplyConfigImportResult = {
  perCategory: Array<{ category: string } & CategoryApplyResult>;
  totals: CategoryApplyResult;
  backup: { attempted: boolean; skipped: boolean };
};

export async function applyConfigImport(
  params: ApplyConfigImportParams,
): Promise<ApplyConfigImportResult> {
  const { prisma, bundleBytes, actorMemberId, expectedFingerprint } = params;

  // Validate the bundle up front (throws on any integrity problem).
  const { manifest, files } = readBundle(bundleBytes);

  // Re-plan and refuse if the DB drifted since the preview.
  const replan = await buildImportPlan(prisma, bundleBytes);
  if (replan.fingerprint !== expectedFingerprint) {
    throw new ConfigImportDriftError();
  }

  // Pre-apply backup. A hard failure aborts; an operator-disabled backup
  // (BACKUP_ENABLED unset) proceeds but is recorded.
  const backup = await runDatabaseBackup();
  if (backup.error) {
    throw new ConfigImportBackupError(backup.error);
  }

  const totals: CategoryApplyResult = {
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
  };
  const perCategory: Array<{ category: string } & CategoryApplyResult> = [];

  await prisma.$transaction(
    async (tx) => {
      await acquireConfigImportLock(tx);
      // Recreate bundled images once, up front; every category shares the map.
      const imageRemap = await recreateBundleMedia(tx, files, actorMemberId);
      for (const importer of CATEGORY_IMPORTERS) {
        if (!manifest.includedCategories.includes(importer.category)) continue;
        const result = await importer.apply({
          tx,
          files,
          manifest,
          actorMemberId,
          imageRemap,
        });
        perCategory.push({ category: importer.category, ...result });
        totals.created += result.created;
        totals.updated += result.updated;
        totals.unchanged += result.unchanged;
        totals.skipped += result.skipped;
      }
    },
    { timeout: 60_000 },
  );

  await createAuditLog({
    action: "configuration.imported",
    memberId: actorMemberId,
    category: "admin",
    severity: "important",
    outcome: "success",
    summary: `Imported configuration bundle (${manifest.includedCategories.join(", ")})`,
    metadata: {
      includedCategories: manifest.includedCategories,
      doorCodesIncluded: manifest.doorCodesIncluded,
      sourceApp: manifest.app,
      totals,
      perCategory,
      backup: { skipped: backup.skipped === true },
    },
  });

  return {
    perCategory,
    totals,
    backup: { attempted: true, skipped: backup.skipped === true },
  };
}
