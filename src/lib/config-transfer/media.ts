import {
  MAX_MEDIA_IMAGE_BYTES,
  detectImageContentType,
  extractImageDimensions,
  sanitiseMediaImageFilename,
} from "@/lib/media-image";
import type {
  CategoryPlanResult,
  PlanItem,
  ReadDb,
  TxDb,
} from "./import-types";

// Shared media handling for import: PLAN the bundled MediaImage recreation
// (validating the map + every image against the same caps the image library
// enforces, and disclosing create-vs-reuse per image) and APPLY it once,
// building an old-id → new-id map so every category whose content embeds
// /api/images/<id> (site content, lodge instructions) can remap references
// consistently. See ADR-001/ADR-002.

const MEDIA_MAP_FILE = "media/media-map.json";

/** Categories whose content can reference bundled images. */
const IMAGE_REFERENCING_CATEGORIES = ["site-content", "lodge-config"] as const;

/** True when the selection includes a category that can reference media. */
export function mediaApplies(selectedCategories: readonly string[]): boolean {
  return IMAGE_REFERENCING_CATEGORIES.some((c) =>
    selectedCategories.includes(c),
  );
}

/** Rewrite /api/images/<oldId> references to the remapped new ids. */
export function remapImageRefs(
  html: string,
  oldToNew: Map<string, string>,
): string {
  return html.replace(
    /\/api\/images\/([A-Za-z0-9_-]+)/g,
    (whole, id: string) => {
      const next = oldToNew.get(id);
      return next ? `/api/images/${next}` : whole;
    },
  );
}

type MediaMapEntry = { path: string; filename: string; contentType: string };

type ParsedMediaMap =
  | { ok: true; entries: Array<[string, MediaMapEntry]> }
  | { ok: false; error: string };

/**
 * Parse + shape-validate media-map.json. Used by BOTH plan and apply so a
 * malformed map fails the dry-run (as an error that blocks apply) instead of
 * throwing mid-transaction after the backup ran.
 */
function parseMediaMap(mapBytes: Uint8Array): ParsedMediaMap {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(mapBytes));
  } catch (error) {
    return {
      ok: false,
      error: `media/media-map.json is not valid JSON (${
        error instanceof Error ? error.message : "parse error"
      })`,
    };
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return {
      ok: false,
      error: "media/media-map.json must be an object of id → {path, filename, contentType}",
    };
  }
  const entries: Array<[string, MediaMapEntry]> = [];
  for (const [oldId, value] of Object.entries(json as Record<string, unknown>)) {
    const meta = value as Partial<MediaMapEntry> | null;
    if (
      !meta ||
      typeof meta !== "object" ||
      typeof meta.path !== "string" ||
      typeof meta.filename !== "string" ||
      typeof meta.contentType !== "string"
    ) {
      return {
        ok: false,
        error: `media/media-map.json entry "${oldId}" must have string path/filename/contentType`,
      };
    }
    entries.push([oldId, meta as MediaMapEntry]);
  }
  return { ok: true, entries };
}

/**
 * Validate + classify the bundle's media for the dry-run: map shape, per-image
 * size cap (the same MAX_MEDIA_IMAGE_BYTES every upload path enforces), and
 * image-type sniffing are ERRORS that block apply; each accepted image is
 * disclosed as a create/unchanged plan item (unchanged = an identical image
 * already exists and will be reused).
 */
export async function planBundleMedia(
  db: ReadDb,
  files: Map<string, Uint8Array>,
): Promise<CategoryPlanResult> {
  const items: PlanItem[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const mapBytes = files.get(MEDIA_MAP_FILE);
  if (!mapBytes) return { items, warnings, errors, fingerprintParts: [] };

  const parsed = parseMediaMap(mapBytes);
  if (!parsed.ok) {
    return { items, warnings, errors: [parsed.error], fingerprintParts: [] };
  }

  for (const [oldId, meta] of parsed.entries) {
    const bytes = files.get(meta.path);
    if (!bytes) {
      errors.push(
        `media/media-map.json: entry "${oldId}" references missing file ${meta.path}`,
      );
      continue;
    }
    const buffer = Buffer.from(bytes);
    if (buffer.length > MAX_MEDIA_IMAGE_BYTES) {
      errors.push(
        `${meta.path} is ${buffer.length} bytes — over the ${MAX_MEDIA_IMAGE_BYTES}-byte image limit`,
      );
      continue;
    }
    const detected = detectImageContentType(buffer);
    if (!detected) {
      errors.push(`${meta.path} is not a recognised image format`);
      continue;
    }
    const filename = sanitiseMediaImageFilename(meta.filename);
    const candidates = await db.mediaImage.findMany({
      where: { filename, byteSize: buffer.length },
      select: { id: true, data: true },
    });
    const existing = candidates.find((c) => Buffer.from(c.data).equals(buffer));
    items.push({
      entity: "media-image",
      key: filename,
      action: existing ? "unchanged" : "create",
    });
  }
  return { items, warnings, errors, fingerprintParts: [] };
}

/**
 * Recreate the bundle's images (reusing an identical existing image by
 * filename+bytes for idempotency) and return the old-id → new-id map. The same
 * validations as planBundleMedia apply defensively (rows the plan flagged as
 * errors never reach here — errors block apply — so failures are skips, not
 * throws).
 */
export async function recreateBundleMedia(
  tx: TxDb,
  files: Map<string, Uint8Array>,
  actorMemberId: string,
): Promise<Map<string, string>> {
  const oldToNew = new Map<string, string>();
  const mapBytes = files.get(MEDIA_MAP_FILE);
  if (!mapBytes) return oldToNew;

  const parsed = parseMediaMap(mapBytes);
  if (!parsed.ok) return oldToNew; // plan blocked this; defensive no-op

  for (const [oldId, meta] of parsed.entries) {
    const bytes = files.get(meta.path);
    if (!bytes) continue;
    const buffer = Buffer.from(bytes);
    if (buffer.length > MAX_MEDIA_IMAGE_BYTES) continue; // plan blocked
    const detected = detectImageContentType(buffer);
    if (!detected) continue; // untrusted: skip non-images
    const filename = sanitiseMediaImageFilename(meta.filename);

    const candidates = await tx.mediaImage.findMany({
      where: { filename, byteSize: buffer.length },
      select: { id: true, data: true },
    });
    const existing = candidates.find((c) => Buffer.from(c.data).equals(buffer));
    if (existing) {
      oldToNew.set(oldId, existing.id);
      continue;
    }

    const dims = extractImageDimensions(buffer, detected);
    const created = await tx.mediaImage.create({
      data: {
        filename,
        contentType: detected,
        byteSize: buffer.length,
        data: buffer,
        width: dims?.width ?? null,
        height: dims?.height ?? null,
        uploadedByMemberId: actorMemberId,
      },
      select: { id: true },
    });
    oldToNew.set(oldId, created.id);
  }
  return oldToNew;
}
