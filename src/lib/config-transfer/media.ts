import {
  detectImageContentType,
  extractImageDimensions,
  sanitiseMediaImageFilename,
} from "@/lib/media-image";
import type { TxDb } from "./import-types";

// Shared media handling for import: recreate the bundled MediaImage bytes once
// (idempotently) and build an old-id → new-id map, so every category whose
// content embeds /api/images/<id> (site content, lodge instructions) can remap
// references consistently. See ADR-001.

const MEDIA_MAP_FILE = "media/media-map.json";

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

/**
 * Recreate the bundle's images (reusing an identical existing image by
 * filename+bytes for idempotency) and return the old-id → new-id map. Untrusted
 * input: non-images are skipped.
 */
export async function recreateBundleMedia(
  tx: TxDb,
  files: Map<string, Uint8Array>,
  actorMemberId: string,
): Promise<Map<string, string>> {
  const oldToNew = new Map<string, string>();
  const mapBytes = files.get(MEDIA_MAP_FILE);
  if (!mapBytes) return oldToNew;

  const map = JSON.parse(new TextDecoder().decode(mapBytes)) as Record<
    string,
    { path: string; filename: string; contentType: string }
  >;

  for (const [oldId, meta] of Object.entries(map)) {
    const bytes = files.get(meta.path);
    if (!bytes) continue;
    const buffer = Buffer.from(bytes);
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
