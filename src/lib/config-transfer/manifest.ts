import { z } from "zod";

// Configuration Export & Import ("config transfer") bundle manifest.
// See docs/config-transfer/decisions/ADR-001-interchange-format-and-identity-strategy.md.
//
// The bundle is a portable, database-id-free interchange for a club's
// configuration, content, and lodge setup. This module defines only the
// manifest shape + format version; it is pure (no DB, no node APIs) so both the
// server engine and tests can import it freely.

/**
 * Bundle format version. Bump the MAJOR meaning of this when the on-disk shape
 * changes incompatibly; the importer refuses a bundle whose formatVersion is
 * greater than the one it understands (ADR-001 "version tolerance").
 */
export const CONFIG_TRANSFER_FORMAT_VERSION = 1;

/**
 * Top-level categories a bundle can carry. Order is the dependency-safe apply
 * order (lodge config before things that reference it); see ADR-002 §apply.
 */
export const CONFIG_TRANSFER_CATEGORIES = [
  "site-content",
  "club-settings",
  "lodge-config",
  "committee",
  "induction",
  "xero-config",
] as const;

export type ConfigTransferCategory =
  (typeof CONFIG_TRANSFER_CATEGORIES)[number];

export const configTransferCategorySchema = z.enum(CONFIG_TRANSFER_CATEGORIES);

/** One file inside the zip, with an integrity checksum. */
export const manifestFileSchema = z.object({
  /** Path within the zip, e.g. "site-content/pages.csv" or "media/<hash>.png". */
  path: z.string().min(1).max(512),
  category: configTransferCategorySchema,
  /** Row count for tabular/document files; null for binary media. */
  rowCount: z.number().int().nonnegative().nullable(),
  /** Lowercase hex SHA-256 of the file's bytes, for tamper/corruption detection. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export type ManifestFile = z.infer<typeof manifestFileSchema>;

export const configTransferManifestSchema = z.object({
  formatVersion: z.number().int().positive(),
  /** ISO-8601, stamped by the app at export time. */
  generatedAt: z.string().min(1),
  app: z.object({
    /** Exporting app version (package.json version). */
    version: z.string().min(1),
    /** Prisma migration head at export time, for skew diagnostics. Nullable. */
    prismaMigration: z.string().nullable(),
  }),
  /**
   * Xero org (tenant) id connected at export time, or null if not connected.
   * The importer compares this to the target's connected org for the Xero
   * category (ADR-002): same → apply; different/none → warn + user chooses.
   */
  sourceXeroTenantId: z.string().nullable(),
  /** Categories actually present in this bundle. */
  includedCategories: z.array(configTransferCategorySchema),
  /** Every non-manifest file in the zip, for validation + integrity. */
  files: z.array(manifestFileSchema),
  /**
   * Transparency flag: true if the exporting admin opted in to include lodge
   * door codes (physical-access info). Default export carries none. ADR-002.
   */
  doorCodesIncluded: z.boolean(),
});

export type ConfigTransferManifest = z.infer<
  typeof configTransferManifestSchema
>;

/** The manifest's own filename within the zip. */
export const CONFIG_TRANSFER_MANIFEST_PATH = "manifest.json";
