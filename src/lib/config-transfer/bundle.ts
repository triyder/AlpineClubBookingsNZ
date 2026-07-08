import "server-only";

import { createHash } from "node:crypto";
import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";

import {
  CONFIG_TRANSFER_FORMAT_VERSION,
  CONFIG_TRANSFER_MANIFEST_PATH,
  configTransferManifestSchema,
  type ConfigTransferCategory,
  type ConfigTransferManifest,
} from "./manifest";

// Zip read/write for config-transfer bundles, with integrity + safety limits.
// A bundle is untrusted input (hand-editable), so readBundle validates the
// manifest, verifies every declared checksum, and rejects anything unexpected
// or oversized before the engine sees it. See ADR-002 "Security Considerations".

/** Overall bundle upload cap (MVP). Import streams/validates within this. */
export const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;
/** Per-file uncompressed cap (media is separately capped at 2MB by media-image). */
export const MAX_BUNDLE_FILE_BYTES = 8 * 1024 * 1024;
/** Guard against zip-bomb-style entry counts. */
export const MAX_BUNDLE_FILES = 2000;

export class ConfigTransferBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigTransferBundleError";
  }
}

export type BundleEntry = {
  /** Path within the zip, e.g. "site-content/pages.csv". Never "manifest.json". */
  path: string;
  category: ConfigTransferCategory;
  /** Row count for tabular/document files; null for binary media. */
  rowCount: number | null;
  bytes: Uint8Array;
};

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type BuildBundleParams = {
  entries: BundleEntry[];
  appVersion: string;
  prismaMigration: string | null;
  sourceXeroTenantId: string | null;
  includedCategories: ConfigTransferCategory[];
  doorCodesIncluded: boolean;
  /** ISO-8601 timestamp; the app stamps this (kept out of this pure builder). */
  generatedAt: string;
};

/** Build a bundle's zip bytes: manifest (with per-file checksums) + entries. */
export function buildBundle(params: BuildBundleParams): Uint8Array {
  const seen = new Set<string>();
  for (const entry of params.entries) {
    if (entry.path === CONFIG_TRANSFER_MANIFEST_PATH) {
      throw new ConfigTransferBundleError(
        `Entry path collides with the manifest: ${entry.path}`,
      );
    }
    if (seen.has(entry.path)) {
      throw new ConfigTransferBundleError(`Duplicate entry path: ${entry.path}`);
    }
    seen.add(entry.path);
  }

  const manifest: ConfigTransferManifest = {
    formatVersion: CONFIG_TRANSFER_FORMAT_VERSION,
    generatedAt: params.generatedAt,
    app: {
      version: params.appVersion,
      prismaMigration: params.prismaMigration,
    },
    sourceXeroTenantId: params.sourceXeroTenantId,
    includedCategories: params.includedCategories,
    files: params.entries.map((entry) => ({
      path: entry.path,
      category: entry.category,
      rowCount: entry.rowCount,
      sha256: sha256Hex(entry.bytes),
    })),
    doorCodesIncluded: params.doorCodesIncluded,
  };

  const zippable: Record<string, Uint8Array> = {
    [CONFIG_TRANSFER_MANIFEST_PATH]: strToU8(
      JSON.stringify(manifest, null, 2),
    ),
  };
  for (const entry of params.entries) {
    zippable[entry.path] = entry.bytes;
  }

  return zipSync(zippable, { level: 6 });
}

export type ReadBundleResult = {
  manifest: ConfigTransferManifest;
  /** All non-manifest files, keyed by their path in the zip. */
  files: Map<string, Uint8Array>;
};

/**
 * Parse + fully validate a bundle. Throws ConfigTransferBundleError on any
 * problem: oversized, too many files, missing/invalid manifest, unsupported
 * (newer) format version, checksum mismatch, or a declared/actual file-set
 * mismatch. Never trusts the bundle's own claims without verifying bytes.
 */
export function readBundle(zipBytes: Uint8Array): ReadBundleResult {
  if (zipBytes.byteLength > MAX_BUNDLE_BYTES) {
    throw new ConfigTransferBundleError(
      `Bundle exceeds the ${MAX_BUNDLE_BYTES}-byte limit`,
    );
  }

  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(zipBytes);
  } catch {
    throw new ConfigTransferBundleError("Bundle is not a valid zip archive");
  }

  const names = Object.keys(unzipped);
  if (names.length > MAX_BUNDLE_FILES) {
    throw new ConfigTransferBundleError(
      `Bundle has too many files (${names.length} > ${MAX_BUNDLE_FILES})`,
    );
  }
  for (const name of names) {
    if (unzipped[name].byteLength > MAX_BUNDLE_FILE_BYTES) {
      throw new ConfigTransferBundleError(
        `Bundle file exceeds the per-file limit: ${name}`,
      );
    }
  }

  const manifestBytes = unzipped[CONFIG_TRANSFER_MANIFEST_PATH];
  if (!manifestBytes) {
    throw new ConfigTransferBundleError("Bundle is missing manifest.json");
  }

  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(strFromU8(manifestBytes));
  } catch {
    throw new ConfigTransferBundleError("manifest.json is not valid JSON");
  }

  const parsed = configTransferManifestSchema.safeParse(manifestJson);
  if (!parsed.success) {
    throw new ConfigTransferBundleError(
      `manifest.json failed validation: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  const manifest = parsed.data;

  if (manifest.formatVersion > CONFIG_TRANSFER_FORMAT_VERSION) {
    throw new ConfigTransferBundleError(
      `Bundle format version ${manifest.formatVersion} is newer than this ` +
        `app supports (${CONFIG_TRANSFER_FORMAT_VERSION}); upgrade before importing`,
    );
  }

  // Every declared file must exist with a matching checksum, and no extra
  // (undeclared) files may be present besides the manifest itself.
  const declared = new Set<string>();
  const files = new Map<string, Uint8Array>();
  for (const file of manifest.files) {
    const bytes = unzipped[file.path];
    if (!bytes) {
      throw new ConfigTransferBundleError(
        `Manifest declares a missing file: ${file.path}`,
      );
    }
    if (sha256Hex(bytes) !== file.sha256) {
      throw new ConfigTransferBundleError(
        `Checksum mismatch for ${file.path} (bundle tampered or corrupt)`,
      );
    }
    declared.add(file.path);
    files.set(file.path, bytes);
  }
  for (const name of names) {
    if (name === CONFIG_TRANSFER_MANIFEST_PATH) continue;
    if (!declared.has(name)) {
      throw new ConfigTransferBundleError(
        `Bundle contains an undeclared file: ${name}`,
      );
    }
  }

  return { manifest, files };
}
