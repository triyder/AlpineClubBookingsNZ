import "server-only";

import { strToU8 } from "fflate";

import { buildBundle, type BundleEntry } from "./bundle";
import type { ConfigTransferCategory } from "./manifest";
import type { CategoryExporter, MediaCollector, ReadDb } from "./export-types";
import { siteContentExporter } from "./categories/site-content";
import { clubSettingsExporter } from "./categories/club-settings";
import { lodgeConfigExporter } from "./categories/lodge-config";
import { lodgeOpsExporter } from "./categories/lodge-ops";
import { displayExporter } from "./categories/display";
import { committeeExporter } from "./categories/committee";
import { inductionExporter } from "./categories/induction";
import { membershipFeesExporter } from "./categories/membership-fees";
import { xeroConfigExporter } from "./categories/xero-config";

// Export orchestrator: runs the selected category exporters, bundles any
// referenced images (bytes + an id→path map so import can remap references),
// and produces the final zip. See docs/config-transfer/decisions/ADR-001.

/** All registered category exporters, in dependency-safe order. */
export const CATEGORY_EXPORTERS: CategoryExporter[] = [
  siteContentExporter,
  clubSettingsExporter,
  lodgeConfigExporter,
  lodgeOpsExporter,
  displayExporter,
  committeeExporter,
  inductionExporter,
  membershipFeesExporter,
  xeroConfigExporter,
];

const CONTENT_TYPE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
};

const MEDIA_MAP_FILE = "media/media-map.json";

class CollectingMedia implements MediaCollector {
  readonly ids = new Set<string>();
  reference(imageId: string): void {
    this.ids.add(imageId);
  }
}

export type BuildExportParams = {
  db: ReadDb;
  categories: ConfigTransferCategory[];
  includeDoorCodes: boolean;
  appVersion: string;
  prismaMigration: string | null;
  /** ISO timestamp; caller stamps it. */
  generatedAt: string;
};

export type BuildExportResult = {
  zip: Uint8Array;
  categories: ConfigTransferCategory[];
  entryCount: number;
  imageCount: number;
};

/** Build a config-transfer bundle for the selected categories. */
export async function buildConfigExport(
  params: BuildExportParams,
): Promise<BuildExportResult> {
  const media = new CollectingMedia();
  const entries: BundleEntry[] = [];
  const included: ConfigTransferCategory[] = [];

  for (const exporter of CATEGORY_EXPORTERS) {
    if (!params.categories.includes(exporter.category)) continue;
    const produced = await exporter.export({
      db: params.db,
      includeDoorCodes: params.includeDoorCodes,
      media,
    });
    if (produced.length > 0) {
      entries.push(...produced);
      included.push(exporter.category);
    }
  }

  const imageCount = await appendReferencedMedia(params.db, media, entries);

  const zip = buildBundle({
    entries,
    appVersion: params.appVersion,
    prismaMigration: params.prismaMigration,
    // A category may be produced by more than one module (e.g. lodge-config);
    // list it once.
    includedCategories: [...new Set(included)],
    doorCodesIncluded: params.includeDoorCodes,
    generatedAt: params.generatedAt,
  });

  return {
    zip,
    categories: [...new Set(included)],
    entryCount: entries.length,
    imageCount,
  };
}

/**
 * Read the referenced MediaImage rows, append their bytes as media/ entries plus
 * an id→path map, so the importer can recreate images and rewrite HTML refs.
 */
async function appendReferencedMedia(
  db: ReadDb,
  media: CollectingMedia,
  entries: BundleEntry[],
): Promise<number> {
  const ids = [...media.ids];
  if (ids.length === 0) return 0;

  const images = await db.mediaImage.findMany({
    where: { id: { in: ids } },
    select: { id: true, filename: true, contentType: true, data: true },
  });

  const map: Record<
    string,
    { path: string; filename: string; contentType: string }
  > = {};
  for (const image of images) {
    const ext = CONTENT_TYPE_EXT[image.contentType] ?? "bin";
    const path = `media/${image.id}.${ext}`;
    map[image.id] = {
      path,
      filename: image.filename,
      contentType: image.contentType,
    };
    entries.push({
      path,
      category: "site-content",
      rowCount: null,
      bytes: new Uint8Array(image.data),
    });
  }

  entries.push({
    path: MEDIA_MAP_FILE,
    category: "site-content",
    rowCount: images.length,
    bytes: strToU8(JSON.stringify(map, null, 2)),
  });

  return images.length;
}
