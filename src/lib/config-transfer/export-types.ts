import type { BundleEntry } from "./bundle";
import type { ReadDb as ImportReadDb } from "./import-types";
import type { ConfigTransferCategory } from "./manifest";

// Contract for a category's export side. Each category module implements this;
// the export orchestrator (export.ts) iterates the selected categories.
//
// Field allowlists live in the entity registry (registry.ts): registerEntity()
// validates them at module load (forbidden-field patterns fail fast), and for
// CSV entities the serialiseCsv header list IS the declared field set, so an
// exporter cannot emit columns outside its registered contract.

/** A read-capable Prisma handle (client or transaction) — same as import-side. */
export type ReadDb = ImportReadDb;

export interface ExportContext {
  db: ReadDb;
  /** Whether the admin opted in to include door codes (ADR-002). */
  includeDoorCodes: boolean;
  /** Collector for media (image) bytes referenced by content; see export.ts. */
  media: MediaCollector;
}

/**
 * Collects MediaImage bytes referenced by exported content so they travel in the
 * bundle's media/ folder, and records the original-id → bundle-path mapping the
 * importer uses to recreate images and rewrite `/api/images/<id>` references.
 */
export interface MediaCollector {
  /** Note that content references this image id; returns immediately. */
  reference(imageId: string): void;
}

export interface CategoryExporter {
  category: ConfigTransferCategory;
  /** Produce this category's bundle entries (may be empty). */
  export(ctx: ExportContext): Promise<BundleEntry[]>;
}
