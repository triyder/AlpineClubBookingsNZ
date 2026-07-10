import "server-only";

import type { PrismaClient } from "@prisma/client";

import { createAuditLog } from "@/lib/audit";
import { runDatabaseBackup } from "@/lib/backup";
import { readBundle, sha256Hex } from "./bundle";
import { buildImportPlanFromParsed, CATEGORY_IMPORTERS } from "./import";
import { mediaApplies, recreateBundleMedia } from "./media";
import {
  resolutionMap,
  type ApplyNotes,
  type CategoryApplyResult,
  type ImportMode,
  type MatchResolution,
  type TxDb,
} from "./import-types";
import type { ConfigTransferCategory } from "./manifest";

// Apply orchestrator. Order (ADR-002): parse once → pre-apply database backup →
// ONE transaction { advisory lock → re-plan against in-lock state → refuse on
// validation errors or ANY fingerprint mismatch (DB drift, substituted bundle,
// switched mode/selection/resolutions) → apply every selected category } →
// audit. Upsert-only, never deletes; any failure rolls back the entire import.

export class ConfigImportDriftError extends Error {
  constructor() {
    super(
      "The database changed since the import was previewed; re-run the dry-run and try again.",
    );
    this.name = "ConfigImportDriftError";
  }
}

export class ConfigImportValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(
      `The bundle has ${errors.length} validation error(s); fix the bundle ` +
        `(and reseal) then re-run the dry-run. First error: ${errors[0]}`,
    );
    this.name = "ConfigImportValidationError";
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
  /** Fingerprint from the dry-run; apply refuses on any mismatch. */
  expectedFingerprint: string;
  /** merge (default) keeps existing values for blank fields; overwrite clears. */
  mode: ImportMode;
  /** Admin-selected categories (defaults to everything the manifest includes). */
  selectedCategories?: ConfigTransferCategory[];
  /** Key-weak match resolutions chosen in the dry-run picker. */
  resolutions?: MatchResolution[];
};

export type ApplyConfigImportResult = {
  perCategory: Array<{ category: string } & CategoryApplyResult>;
  totals: CategoryApplyResult;
  backup: { attempted: boolean; skipped: boolean };
  doorCodesWritten: string[];
};

export async function applyConfigImport(
  params: ApplyConfigImportParams,
): Promise<ApplyConfigImportResult> {
  const { prisma, bundleBytes, actorMemberId, expectedFingerprint, mode } =
    params;
  const resolutions = params.resolutions ?? [];

  // Parse + structural validation ONCE; the same parsed bundle feeds the
  // in-transaction re-plan and the category applies.
  const parsed = readBundle(bundleBytes);
  const bundleSha256 = sha256Hex(bundleBytes);

  // Pre-apply backup FIRST (ADR-002: backup, then verify, then execute). A
  // hard failure aborts; an operator-disabled backup (BACKUP_ENABLED unset)
  // proceeds but is recorded.
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
  const notes: ApplyNotes = { doorCodesWritten: [] };
  let auditDiff: Array<{
    category: string;
    entity: string;
    key: string;
    action: string;
    changedFields?: string[];
  }> = [];
  let selectedCategories: ConfigTransferCategory[] = [];

  await prisma.$transaction(
    async (tx) => {
      // Serialise imports, THEN re-plan against the in-lock state: a second
      // import queued behind the lock re-plans against the winner's committed
      // writes, so a stale preview can never apply (ADR-002).
      await acquireConfigImportLock(tx);

      const replan = await buildImportPlanFromParsed(tx, parsed, bundleSha256, {
        mode,
        selectedCategories: params.selectedCategories,
        resolutions,
      });
      if (replan.errors.length > 0) {
        throw new ConfigImportValidationError(replan.errors);
      }
      if (replan.fingerprint !== expectedFingerprint) {
        throw new ConfigImportDriftError();
      }
      selectedCategories = replan.selectedCategories;

      // Bounded per-item diff for the audit record (what this import changes).
      auditDiff = replan.categories
        .flatMap((cat) =>
          cat.items
            .filter((i) => i.action !== "unchanged")
            .map((i) => ({
              category: cat.category,
              entity: i.entity,
              key: i.key,
              action: i.action,
              ...(i.changedFields?.length
                ? { changedFields: i.changedFields }
                : {}),
            })),
        )
        .slice(0, 200);

      // Recreate bundled images once (only when an image-referencing category
      // is selected — disclosed by the plan's media items); all categories
      // share the remap.
      const imageRemap = mediaApplies(selectedCategories)
        ? await recreateBundleMedia(tx, parsed.files, actorMemberId)
        : new Map<string, string>();

      const applyCtx = {
        tx,
        files: parsed.files,
        manifest: parsed.manifest,
        mode,
        resolutions: resolutionMap(resolutions),
        actorMemberId,
        imageRemap,
        notes,
      };
      for (const importer of CATEGORY_IMPORTERS) {
        if (!selectedCategories.includes(importer.category)) continue;
        const result = await importer.apply(applyCtx);
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
    summary: `Imported configuration bundle (${selectedCategories.join(", ")})`,
    metadata: {
      bundleSha256,
      selectedCategories,
      doorCodesIncluded: parsed.manifest.doorCodesIncluded,
      // The FACT of door-code writes (slugs only, never values) — the manifest
      // flag alone can misstate a hand-edited bundle.
      doorCodesWritten: notes.doorCodesWritten,
      mode,
      resolutions,
      sourceApp: parsed.manifest.app,
      totals,
      perCategory,
      diff: auditDiff,
      backup: { skipped: backup.skipped === true },
    },
  });

  return {
    perCategory,
    totals,
    backup: { attempted: true, skipped: backup.skipped === true },
    doorCodesWritten: notes.doorCodesWritten,
  };
}
