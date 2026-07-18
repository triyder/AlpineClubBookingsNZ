import "server-only";

import { readFile } from "node:fs/promises";

import type { PrismaClient } from "@prisma/client";

import { createAuditLog } from "@/lib/audit";
import logger from "@/lib/logger";
import { clubConfigSource, type ClubConfigSource } from "@/config/club";
import { sha256Hex } from "./bundle";
import { buildImportPlan } from "./import";
import {
  applyConfigImport,
  type ApplyConfigImportResult,
} from "./apply";
import type { ImportMode, ReadDb } from "./import-types";

/**
 * C9 — Config bundle auto-import on boot (ADR-003, disaster-recovery / clone).
 *
 * When `CONFIG_BUNDLE_IMPORT_PATH` names a readable bundle file AND the database
 * is **empty of non-seed configuration**, this module applies that bundle
 * non-interactively at boot, through the EXACT same validated import pipeline
 * (`import.ts` plan → `apply.ts` apply) the interactive admin route uses. It is
 * the mechanism behind the ADR-003 provisioning flow:
 *
 *   deploy env + bundle file → migrations → base seed → **boot auto-import** →
 *   operational site
 *
 * ## Security posture — fail closed everywhere
 * The bundle file is operator-controlled DEPLOYMENT configuration (equivalent to
 * writing `config/club.json` or setting install-time env — a first-install
 * capability, not a privilege escalation; see ADR-003 "Trust model"), but its
 * BYTES are treated as fully untrusted input: the same `readBundle` structural
 * validation, resource caps, `FORBIDDEN_FIELD_PATTERNS` allowlist, and per-field
 * Prisma-DMMF type-checks that guard the interactive path guard this one. The
 * residual risk ADR-003 identifies is a bundle applied to a NON-empty database;
 * the empty-target guard below is what prevents it, so it is designed to fail
 * CLOSED — any doubt about emptiness, any validation error, any plan step that
 * would need a human answer, and any I/O or apply failure all REFUSE the import
 * and leave the database untouched. Boot always continues (best-effort, like the
 * C2 self-heal): the process must never crash because of a bootstrap bundle.
 *
 * ## "Empty of non-seed configuration" — the precise definition
 * The base seed (`prisma/seed.ts`) is create-if-missing and pre-populates the
 * config singletons and keyed rows this importer touches (club identity, theme,
 * lodge, age tiers, seasons/rates, pages, site content, committee roles,
 * induction template, Xero mappings, displays). So a faithful club bundle
 * applied to a freshly-seeded database necessarily produces UPDATEs against those
 * seed placeholders — "the plan has zero updates" is therefore NOT a usable
 * empty-target signal on this codebase (it would refuse every legitimate
 * bootstrap). Emptiness is instead defined as the absence of any
 * operator/admin footprint beyond the pristine post-seed state, probed
 * positively over signals the seed leaves untouched (see
 * {@link assessBootstrapReadiness}):
 *
 *   1. No config bundle has ever been imported — no `configuration.imported`
 *      (interactive) or `configuration.bootstrap_imported` (this feature) audit
 *      row. This is also what makes a second boot idempotent.
 *   2. No bookings exist.
 *   3. No non-system members exist (any `Member` whose role is not one of the
 *      seeded system-account roles ADMIN / LODGE).
 *   4. The setup wizard was never marked finished (`SetupProgress.completedAt`
 *      is null).
 *
 * ALL four must hold to apply. Any one present refuses — strictly safer than an
 * update-count check, because it also refuses a manually-configured club whose
 * bundle keys happen to collide with seed keys (which an update count could
 * misread as "unchanged"). The refusal distinguishes the calm steady state (a
 * prior bootstrap already ran — INFO) from an unexpected non-empty target
 * (WARN).
 *
 * ## Provenance guard — deliberately NOT applied
 * The C2 self-heal is gated on `clubConfigSource === "primary"` to avoid freezing
 * FALLBACK config values into create-if-absent rows. The bootstrap import is
 * intentionally NOT gated on config provenance: the BUNDLE is the config source
 * in the DR scenario, and `config/club.json` is often absent there (that is the
 * whole reason to restore from a bundle), so provenance is typically
 * `"safe-default"`. Gating on `"primary"` would disable the feature exactly when
 * it is needed. The self-heal's hazard does not transfer, because this importer
 * writes the BUNDLE's values, never the effective fallback config. On a
 * SAFE_DEFAULT boot the self-heal skips (writing nothing) and the bootstrap
 * import then populates the database from the bundle — no double-write, no
 * conflict. Provenance is recorded in logs for observability only.
 *
 * ## Interaction with the C2 self-heal (runs first, in the same boot)
 * The self-heal runs BEFORE this module. Whether it wrote rows or skipped, there
 * is no conflict: the emptiness probe deliberately looks at operational
 * footprint, NOT at config-singleton presence, so self-healed rows never make
 * the target look "non-empty". If the self-heal created identity/age-tier rows
 * (primary-config clone), this importer simply upserts over them with the
 * bundle's authoritative values; if it skipped (safe-default DR), this importer
 * creates them. On the NEXT boot the self-heal sees the rows present (skips) and
 * this importer sees the `configuration.bootstrap_imported` marker (refuses) —
 * exactly one write, pinned.
 */

/**
 * Synthetic actor id for the boot-time bootstrap import ("system/deploy"). Both
 * `AuditLog.memberId` and `MediaImage.uploadedByMemberId` are FK-free `String?`
 * columns, so this non-member id is safe to persist and never violates a
 * relation.
 */
export const CONFIG_BOOTSTRAP_ACTOR = "system:config-bootstrap";

/** Audit action recorded for a successful boot-time bootstrap import. */
export const CONFIG_BOOTSTRAP_AUDIT_ACTION = "configuration.bootstrap_imported";

/**
 * Write mode for the bootstrap import. `"overwrite"` makes the bundle fully
 * authoritative so a fresh install faithfully reproduces the source club (blank
 * bundle fields clear the corresponding seed placeholder). Merge would instead
 * leave seed placeholders showing through wherever the source blanked a field,
 * producing a hybrid — wrong for a DR/clone whose goal is to reproduce the
 * source. Creates (the common case on an empty target) use the bundle values in
 * either mode.
 */
const BOOTSTRAP_IMPORT_MODE: ImportMode = "overwrite";

/** Roles the base seed assigns to its two system accounts (admin + lodge kiosk). */
const SEED_SYSTEM_ROLES = ["ADMIN", "LODGE"] as const;

/** Prisma surface the bootstrap probe + apply need (full client in production). */
type BootstrapDb = PrismaClient;

export type BootstrapReadiness =
  | { decision: "apply" }
  | {
      decision: "refuse";
      severity: "info" | "warn";
      reason: string;
    };

/**
 * Probe whether the database is empty of non-seed configuration (see the module
 * docblock for the precise definition). Read-only; never writes. Fails closed —
 * any probe error propagates to the caller, which treats it as "do not apply".
 */
export async function assessBootstrapReadiness(
  db: BootstrapDb,
): Promise<BootstrapReadiness> {
  // 1. Has any config bundle already been imported? Either the interactive
  //    action or this feature's marker means configuration has been imported —
  //    the bootstrap marker also makes a second boot the calm steady state.
  const [bootstrapImports, interactiveImports] = await Promise.all([
    db.auditLog.count({
      where: { action: CONFIG_BOOTSTRAP_AUDIT_ACTION, outcome: "success" },
    }),
    db.auditLog.count({ where: { action: "configuration.imported" } }),
  ]);
  if (bootstrapImports > 0) {
    return {
      decision: "refuse",
      severity: "info",
      reason:
        "a config bundle was already auto-imported on a prior boot; the " +
        "target is configured (steady state)",
    };
  }
  if (interactiveImports > 0) {
    return {
      decision: "refuse",
      severity: "warn",
      reason:
        "a config bundle has already been imported through the admin UI; " +
        "refusing to overwrite a configured target",
    };
  }

  // 2/3/4. Operational + setup-completion footprint the base seed never creates.
  const [bookingCount, nonSystemMemberCount, finishedSetup] = await Promise.all([
    db.booking.count(),
    db.member.count({
      where: { role: { notIn: [...SEED_SYSTEM_ROLES] } },
    }),
    db.setupProgress.count({ where: { completedAt: { not: null } } }),
  ]);

  if (bookingCount > 0) {
    return {
      decision: "refuse",
      severity: "warn",
      reason: `target already has ${bookingCount} booking(s); it is in use`,
    };
  }
  if (nonSystemMemberCount > 0) {
    return {
      decision: "refuse",
      severity: "warn",
      reason:
        `target already has ${nonSystemMemberCount} non-system member(s); ` +
        "it is configured/in use",
    };
  }
  if (finishedSetup > 0) {
    return {
      decision: "refuse",
      severity: "warn",
      reason: "the setup wizard was already marked complete on this target",
    };
  }

  return { decision: "apply" };
}

export type BootstrapImportOutcome =
  | "disabled" // env var not set
  | "unreadable" // path set but file missing/unreadable
  | "refused-configured" // target not empty (steady state / already configured)
  | "refused-invalid" // bundle failed validation / would need human resolution
  | "applied" // bundle applied successfully
  | "failed"; // unexpected error during probe or apply

export interface BootstrapImportResult {
  outcome: BootstrapImportOutcome;
  /** Human-readable detail for logs. */
  detail?: string;
  /** sha256 of the bundle bytes, when a file was read. */
  bundleSha256?: string;
  /** Totals from a successful apply. */
  totals?: ApplyConfigImportResult["totals"];
}

/** Injectable seams so tests exercise the orchestrator without real fs/apply. */
export interface RunConfigBootstrapImportOptions {
  db: BootstrapDb;
  /** Defaults to `process.env.CONFIG_BUNDLE_IMPORT_PATH`. */
  path?: string | undefined;
  /** Defaults to the app logger; tests silence it. */
  log?: Pick<typeof logger, "info" | "warn" | "error">;
  /** Effective config provenance, recorded for observability only. */
  provenance?: ClubConfigSource;
  /** Reads the bundle file (injectable). Defaults to `fs.readFile`. */
  readBundleFile?: (path: string) => Promise<Uint8Array>;
  /** The plan builder (injectable). Defaults to `buildImportPlan`. */
  planImpl?: typeof buildImportPlan;
  /** The apply implementation (injectable). Defaults to `applyConfigImport`. */
  applyImpl?: typeof applyConfigImport;
}

/**
 * Boot-time entrypoint. NEVER throws — every failure path returns a
 * {@link BootstrapImportResult} and logs; the caller in
 * `instrumentation.node.ts` additionally wraps the dynamic import. Applies the
 * env-named bundle iff the file is readable and the target is empty of non-seed
 * configuration; otherwise refuses and leaves the database untouched.
 */
export async function runConfigBootstrapImport(
  options: RunConfigBootstrapImportOptions,
): Promise<BootstrapImportResult> {
  const db = options.db;
  const log = options.log ?? logger;
  const provenance = options.provenance ?? clubConfigSource;
  const path = options.path ?? process.env.CONFIG_BUNDLE_IMPORT_PATH?.trim();
  const readBundleFile = options.readBundleFile ?? defaultReadBundleFile;
  const planImpl = options.planImpl ?? buildImportPlan;
  const applyImpl = options.applyImpl ?? applyConfigImport;
  const scope = "config-bootstrap-import";

  if (!path) {
    // Not configured — the overwhelmingly common case. Silent no-op.
    return { outcome: "disabled" };
  }

  // Read the file. A missing / unreadable path is an operator misconfiguration,
  // not a crash: log and continue boot.
  let bytes: Uint8Array;
  try {
    bytes = await readBundleFile(path);
  } catch (err) {
    log.warn(
      { scope, err, provenance },
      `Config bundle auto-import skipped: cannot read CONFIG_BUNDLE_IMPORT_PATH ` +
        `("${path}"). Fix the path or unset the variable; boot continues.`,
    );
    return { outcome: "unreadable", detail: String(path) };
  }

  const bundleSha256 = sha256Hex(bytes);

  try {
    // Empty-target guard — fail closed. Refuse (leaving the DB untouched) unless
    // the target is empty of non-seed configuration.
    const readiness = await assessBootstrapReadiness(db);
    if (readiness.decision === "refuse") {
      const message =
        `Config bundle auto-import refused: ${readiness.reason}. ` +
        `Nothing was written; boot continues.`;
      if (readiness.severity === "info") {
        log.info({ scope, bundleSha256, provenance }, message);
      } else {
        log.warn({ scope, bundleSha256, provenance }, message);
      }
      return {
        outcome: "refused-configured",
        detail: readiness.reason,
        bundleSha256,
      };
    }

    // Plan first (untrusted-input validation + human-resolution check) BEFORE
    // applying. `buildImportPlan` runs `readBundle` (structural validation +
    // resource caps + safe-path checks) and every category planner
    // (allowlist + DMMF type-checks). A malformed/tampered/oversized bundle
    // surfaces here with no write attempted.
    const plan = await planImpl(db as ReadDb, bytes, {
      mode: BOOTSTRAP_IMPORT_MODE,
    });

    if (plan.errors.length > 0) {
      log.error(
        { scope, bundleSha256, provenance, errors: plan.errors.slice(0, 10) },
        `Config bundle auto-import refused: the bundle has ${plan.errors.length} ` +
          `validation error(s) — first: ${plan.errors[0]}. Nothing was written.`,
      );
      return {
        outcome: "refused-invalid",
        detail: plan.errors[0],
        bundleSha256,
      };
    }

    // ADR-003 non-interactive safety: any plan item that would need a human
    // answer (a key-weak match with candidates) aborts rather than guessing.
    // On a genuinely empty target every row is a create, so this never trips —
    // but fail closed if it ever does.
    const ambiguous = plan.categories
      .flatMap((cat) => cat.items)
      .filter((item) => (item.candidates?.length ?? 0) > 0);
    if (ambiguous.length > 0) {
      log.error(
        {
          scope,
          bundleSha256,
          provenance,
          entities: ambiguous.slice(0, 10).map((i) => `${i.entity}:${i.key}`),
        },
        `Config bundle auto-import refused: ${ambiguous.length} row(s) need an ` +
          `interactive rename decision, which cannot be made non-interactively. ` +
          `Nothing was written.`,
      );
      return {
        outcome: "refused-invalid",
        detail: "plan requires interactive rename resolution",
        bundleSha256,
      };
    }

    // Apply through the shared pipeline. The pre-apply backup is waived ONLY
    // here (empty target has nothing to protect); every other ADR-002 safeguard
    // holds. Any failure inside rolls the single transaction back atomically —
    // no partial apply.
    const result = await applyImpl({
      prisma: db,
      bundleBytes: bytes,
      actorMemberId: CONFIG_BOOTSTRAP_ACTOR,
      expectedFingerprint: plan.fingerprint,
      mode: BOOTSTRAP_IMPORT_MODE,
      preApplyBackup: "skip-empty-bootstrap",
    });

    // Record the bootstrap import as its own audit marker (system/deploy actor,
    // bundle checksum, outcome) — distinct from the pipeline's
    // `configuration.imported` row so the emptiness probe can tell a bootstrap
    // apart from an interactive import, and idempotence keys on it.
    await createAuditLog(
      {
        action: CONFIG_BOOTSTRAP_AUDIT_ACTION,
        memberId: CONFIG_BOOTSTRAP_ACTOR,
        category: "system",
        severity: "critical",
        outcome: "success",
        summary: `Auto-imported configuration bundle on boot (${result.totals.created} created, ${result.totals.updated} updated)`,
        metadata: {
          bundleSha256,
          provenance,
          mode: BOOTSTRAP_IMPORT_MODE,
          selectedCategories: plan.selectedCategories,
          totals: result.totals,
          doorCodesWritten: result.doorCodesWritten,
          backup: result.backup,
        },
      },
      db,
    );

    log.info(
      {
        scope,
        bundleSha256,
        provenance,
        totals: result.totals,
        categories: plan.selectedCategories,
      },
      `Config bundle auto-imported on boot: created ${result.totals.created}, ` +
        `updated ${result.totals.updated}, unchanged ${result.totals.unchanged}.`,
    );

    return {
      outcome: "applied",
      bundleSha256,
      totals: result.totals,
    };
  } catch (err) {
    // Untrusted-input parse errors, drift, apply failures — all land here.
    // The apply transaction is atomic, so a mid-apply throw wrote nothing.
    log.error(
      { scope, bundleSha256, provenance, err },
      `Config bundle auto-import failed (non-fatal): ${err instanceof Error ? err.message : String(err)}. ` +
        `Nothing was written; boot continues.`,
    );
    return { outcome: "failed", detail: String(err), bundleSha256 };
  }
}

async function defaultReadBundleFile(path: string): Promise<Uint8Array> {
  const buf = await readFile(path);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
