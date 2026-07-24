import "server-only";

import { type Prisma } from "@prisma/client";
import {
  MAX_MEDIA_IMAGE_BYTES,
  type AllowedMediaImageContentType,
} from "@/lib/media-image";

/**
 * Shared constants and helpers for member profile photos (epic #171, MP2).
 *
 * Member photos are stored as `MediaImage` rows with `kind = MEMBER_PHOTO`
 * (bytes in Postgres, surviving redeploys) and referenced by
 * `Member.photoImageId`. They are served only through the scoped
 * `/api/members/[id]/photo` endpoint — never the public `/api/images/[id]`
 * content path (ADR-001, owner decision 3).
 *
 * Resize is the client's job (MP3 crop UI exports a downscaled canonical
 * image); the server validates and enforces caps only — there is no
 * server-side image library (owner decision, 2026-07-16).
 */

/**
 * Member photos accept only raster photographic formats. GIF, AVIF and SVG
 * are deliberately excluded from the broader `MediaImage` allowlist: SVG can
 * carry inline script (stored XSS), and GIF/AVIF add nothing for a small,
 * downscaled profile photo. The crop UI (MP3) exports JPEG, PNG or WebP.
 */
export const ALLOWED_MEMBER_PHOTO_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const satisfies readonly AllowedMediaImageContentType[];

export type AllowedMemberPhotoContentType =
  (typeof ALLOWED_MEMBER_PHOTO_CONTENT_TYPES)[number];

export function isAllowedMemberPhotoContentType(
  contentType: AllowedMediaImageContentType,
): contentType is AllowedMemberPhotoContentType {
  return (ALLOWED_MEMBER_PHOTO_CONTENT_TYPES as readonly string[]).includes(
    contentType,
  );
}

/**
 * Hard byte ceiling for a stored member photo, reusing the media-image 2MB
 * cap so the two upload surfaces stay in lockstep. The MP3 client downscales
 * to <=512px, so real uploads are far smaller; this is only the backstop that
 * keeps a hostile or buggy client from parking large blobs in the database.
 */
export const MAX_MEMBER_PHOTO_BYTES = MAX_MEDIA_IMAGE_BYTES;

/**
 * Upper bound on the multipart request body itself (file bytes plus form
 * field/boundary overhead), used to reject oversized uploads from the
 * Content-Length header before the body is fully buffered.
 */
export const MAX_MEMBER_PHOTO_REQUEST_BYTES =
  MAX_MEMBER_PHOTO_BYTES + 64 * 1024;

/**
 * Dimension backstop against decompression bombs and absurd inputs. The
 * client target is <=512px; 4096 is generous headroom. Dimension checks are
 * best effort (the repo deliberately ships no image-processing dependency):
 * JPEG/PNG/GIF/WebP dimensions are parsed from the header, so an oversized
 * canvas is refused; only a genuinely unparseable image reads `null` and is
 * accepted rather than rejected.
 */
export const MAX_MEMBER_PHOTO_DIMENSION = 4096;

/**
 * Delete a member's owned `MEMBER_PHOTO` blobs when they leave the system
 * (merged away as a loser, or hard-deleted), without collateral damage to
 * other members' photos. Shared by the member-merge reconcile step and the
 * account-deletion path so both apply the identical safety predicate.
 *
 * A blob qualifies when it is the member's own current photo (`photoImageId`)
 * or was uploaded by them (`uploadedByMemberId` — note an admin's on-behalf
 * upload carries the *admin* here) — but only if it is **not still referenced
 * by any other surviving member**. That carve-out is essential: an admin can
 * upload photos on behalf of members X/Y/Z, so those blobs carry the admin's
 * `uploadedByMemberId`; deleting the admin must not strip X/Y/Z's photos
 * (`Member.photoImage` is `onDelete: SetNull`). The member's own blob, which
 * only they reference, is still deleted. `keepImageId` spares a specific blob
 * (the master's kept photo during a merge). Runs inside the caller's
 * transaction; row-level locks only.
 */
export async function deleteOwnedMemberPhotoBlobs(
  tx: Prisma.TransactionClient,
  {
    memberId,
    photoImageId,
    keepImageId,
  }: {
    memberId: string;
    photoImageId?: string | null;
    keepImageId?: string | null;
  },
): Promise<{ deleted: number }> {
  const orClauses: Prisma.MediaImageWhereInput[] = [
    { uploadedByMemberId: memberId },
  ];
  if (photoImageId) {
    orClauses.push({ id: photoImageId });
  }

  const where: Prisma.MediaImageWhereInput = {
    kind: "MEMBER_PHOTO",
    OR: orClauses,
    // Never delete a blob still referenced by a member OTHER than this one.
    photoOfMembers: { none: { id: { not: memberId } } },
  };
  if (keepImageId) {
    where.NOT = { id: keepImageId };
  }

  const { count } = await tx.mediaImage.deleteMany({ where });
  return { deleted: count };
}
