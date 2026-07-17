import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireAdmin, requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";
import { MEMBER_ACCESS_ROLE_SELECT } from "@/lib/access-role-definitions";
import {
  detectImageContentType,
  extractImageDimensions,
} from "@/lib/media-image";
import {
  MAX_MEMBER_PHOTO_BYTES,
  MAX_MEMBER_PHOTO_DIMENSION,
  MAX_MEMBER_PHOTO_REQUEST_BYTES,
  isAllowedMemberPhotoContentType,
} from "@/lib/member-photo";

/**
 * Scoped member-photo serving + upload/remove endpoint (epic #171, MP2).
 *
 * Keyed by member id — never the public `/api/images/[id]` content path
 * (ADR-001, owner decision 3). Authorisation is enforced at the data layer:
 *
 * - GET is publicly (anonymously) servable **iff** the target member has a
 *   published, active `CommitteeAssignment` (their photo is committee-public);
 *   otherwise only the owning member or a membership admin may fetch it, and
 *   everyone else gets 404 (preferred over 403 so the endpoint never confirms
 *   whether a private photo exists).
 * - POST/DELETE are gated to the owning member (self) or a membership-`edit`
 *   admin acting on their behalf. A plain member can only act on their own id
 *   (no IDOR).
 *
 * Resize is the client's job (MP3 crop UI). This route validates content-type
 * (JPEG/PNG/WebP only), enforces a byte cap and a dimension sanity backstop,
 * and stores the bytes verbatim — there is no server-side image library.
 */

// A member's photo is public exactly when the member is shown on the public
// committee page: an active, published assignment to an active role. Kept in
// lockstep with the /api/committee visibility predicate.
const PUBLIC_COMMITTEE_ASSIGNMENT_FILTER = {
  published: true,
  isActive: true,
  committeeRole: { isActive: true },
} as const;

function notFoundResponse() {
  // Prefer 404 over 403 so a private photo's existence is never confirmed.
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

function unauthorisedResponse() {
  return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
}

type MutationSession = Awaited<ReturnType<typeof auth>>;

/**
 * Resolve the acting session for a mutating request against member `targetId`.
 * The owning member acts on their own photo through the active-session guard;
 * anyone else must be a membership-`edit` admin acting on their behalf. The
 * caller passes the already-resolved `auth()` session so each HTTP method body
 * keeps its own visible session boundary (route-boundary test #812).
 */
async function resolveMutationActor(
  targetId: string,
  session: MutationSession,
): Promise<
  | { ok: true; actorId: string; onBehalf: boolean }
  | { ok: false; response: NextResponse }
> {
  const actorId = session?.user?.id;
  if (!actorId) {
    return { ok: false, response: unauthorisedResponse() };
  }

  if (actorId === targetId) {
    const inactive = await requireActiveSessionUser(actorId, {
      sessionUser: session?.user ?? null,
    });
    if (inactive) {
      return { ok: false, response: inactive };
    }
    return { ok: true, actorId, onBehalf: false };
  }

  // Acting on another member's photo requires membership-edit admin access.
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) {
    return { ok: false, response: guard.response };
  }
  return { ok: true, actorId: guard.session.user.id, onBehalf: true };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const member = await prisma.member.findUnique({
    where: { id },
    select: {
      active: true,
      photoImageId: true,
      committeeAssignments: {
        where: PUBLIC_COMMITTEE_ASSIGNMENT_FILTER,
        select: { id: true },
        take: 1,
      },
    },
  });

  if (!member?.photoImageId) {
    return notFoundResponse();
  }

  // Lockstep with /api/committee: the member themselves must be active, not
  // merely holding a published assignment. A deactivated member with a stale
  // published assignment is absent from the committee page, so their photo
  // must not be publicly servable either.
  const isCommitteePublic =
    member.active && member.committeeAssignments.length > 0;

  if (!isCommitteePublic) {
    // Private photo: only the owning member or a membership viewer/admin.
    const session = await auth();
    const viewerId = session?.user?.id ?? null;
    let allowed = viewerId === id;

    if (!allowed && viewerId) {
      const viewer = await prisma.member.findUnique({
        where: { id: viewerId },
        select: {
          active: true,
          accessRoles: { select: MEMBER_ACCESS_ROLE_SELECT },
        },
      });
      allowed = Boolean(
        viewer?.active &&
          hasAdminAreaAccess(viewer, { area: "membership", level: "view" }),
      );
    }

    if (!allowed) {
      return notFoundResponse();
    }
  }

  const image = await prisma.mediaImage.findUnique({
    where: { id: member.photoImageId },
    select: { data: true, contentType: true },
  });

  if (!image) {
    return notFoundResponse();
  }

  // Hardening headers mirror the public content route: member photos are
  // JPEG/PNG/WebP only (never SVG), but nosniff + a locked-down CSP keep a
  // response opened directly as a document from doing anything.
  const baseHeaders: Record<string, string> = {
    "Content-Type": image.contentType,
    "Content-Disposition": "inline",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
  };

  if (isCommitteePublic) {
    // Committee-public: safe to cache in shared/browser caches, but only
    // briefly — committee membership (and therefore public visibility) can be
    // revoked while the stored bytes stay the same, so a long-lived
    // `immutable` cache would leak the photo past un-publication. A short
    // max-age plus an id-derived ETag bounds that window and still allows
    // 304 revalidation.
    const etag = `"${member.photoImageId}"`;
    const headers = {
      ...baseHeaders,
      "Cache-Control": "public, max-age=300, must-revalidate",
      ETag: etag,
    };
    if (request.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(image.data, { status: 200, headers });
  }

  // Private photo: never store in any cache, shared or private, so a photo
  // fetched by an authorised viewer can't be replayed to an unauthorised one.
  return new Response(image.data, {
    status: 200,
    headers: {
      ...baseHeaders,
      "Cache-Control": "private, no-store",
      Vary: "Cookie",
    },
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const session = await auth();
  const actor = await resolveMutationActor(id, session);
  if (!actor.ok) return actor.response;

  // The target member must exist (and, for admins, be a real subject).
  const target = await prisma.member.findUnique({
    where: { id },
    select: { id: true, photoImageId: true },
  });
  if (!target) {
    return notFoundResponse();
  }

  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = Number.parseInt(contentLengthHeader, 10);
    if (
      Number.isFinite(contentLength) &&
      contentLength > MAX_MEMBER_PHOTO_REQUEST_BYTES
    ) {
      return NextResponse.json(
        { error: "Photo exceeds the 2MB upload limit" },
        { status: 413 },
      );
    }
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Invalid multipart/form-data body" },
      { status: 400 },
    );
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "A file field containing the photo is required" },
      { status: 400 },
    );
  }

  if (file.size > MAX_MEMBER_PHOTO_BYTES) {
    return NextResponse.json(
      { error: "Photo exceeds the 2MB upload limit" },
      { status: 413 },
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());

  if (bytes.length > MAX_MEMBER_PHOTO_BYTES) {
    return NextResponse.json(
      { error: "Photo exceeds the 2MB upload limit" },
      { status: 413 },
    );
  }

  // Trust the bytes, not the declared Content-Type or filename extension.
  const detected = detectImageContentType(bytes);
  if (!detected || !isAllowedMemberPhotoContentType(detected)) {
    return NextResponse.json(
      {
        error:
          "Unsupported or invalid image. Allowed photo types: JPEG, PNG, WebP.",
      },
      { status: 400 },
    );
  }

  // Dimension sanity is best effort: WebP dimensions are not parsed (no image
  // library by design), so a null reading is accepted and only a parsed
  // dimension beyond the backstop is rejected as absurd.
  const dimensions = extractImageDimensions(bytes, detected);
  if (
    dimensions &&
    (dimensions.width > MAX_MEMBER_PHOTO_DIMENSION ||
      dimensions.height > MAX_MEMBER_PHOTO_DIMENSION ||
      dimensions.width <= 0 ||
      dimensions.height <= 0)
  ) {
    return NextResponse.json(
      { error: "Photo dimensions are outside the accepted range" },
      { status: 400 },
    );
  }

  const previousImageId = target.photoImageId;
  const now = new Date();

  // Create the new blob, repoint the member, then delete the old blob — all in
  // one transaction so a replaced photo never leaks an orphaned MEMBER_PHOTO
  // row (consistent with MP1's cleanup ethos). No external calls inside the
  // transaction.
  const image = await prisma.$transaction(async (tx) => {
    const created = await tx.mediaImage.create({
      data: {
        filename: "member-photo",
        contentType: detected,
        byteSize: bytes.length,
        data: bytes,
        width: dimensions?.width ?? null,
        height: dimensions?.height ?? null,
        uploadedByMemberId: actor.actorId,
        kind: "MEMBER_PHOTO",
      },
      select: { id: true, contentType: true, byteSize: true },
    });

    await tx.member.update({
      where: { id },
      data: {
        photoImageId: created.id,
        photoUpdatedAt: now,
        photoUpdatedByMemberId: actor.actorId,
      },
    });

    if (previousImageId && previousImageId !== created.id) {
      // Scope the delete to MEMBER_PHOTO so a mispointed FK can never take out
      // a CONTENT image.
      await tx.mediaImage.deleteMany({
        where: { id: previousImageId, kind: "MEMBER_PHOTO" },
      });
    }

    return created;
  });

  logAudit({
    action: "member_photo.upload",
    actorMemberId: actor.actorId,
    subjectMemberId: id,
    memberId: actor.actorId,
    targetId: id,
    entityType: "Member",
    entityId: id,
    category: actor.onBehalf ? "admin" : "account",
    outcome: "success",
    summary: actor.onBehalf
      ? "Uploaded a member photo on behalf of a member"
      : "Uploaded own member photo",
    metadata: {
      imageId: image.id,
      contentType: image.contentType,
      byteSize: image.byteSize,
      onBehalf: actor.onBehalf,
      replacedImageId: previousImageId ?? null,
    },
  });

  return NextResponse.json(
    { photoUrl: `/api/members/${id}/photo`, updatedAt: now.toISOString() },
    { status: 201 },
  );
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const session = await auth();
  const actor = await resolveMutationActor(id, session);
  if (!actor.ok) return actor.response;

  const target = await prisma.member.findUnique({
    where: { id },
    select: { id: true, photoImageId: true },
  });
  if (!target) {
    return notFoundResponse();
  }

  const previousImageId = target.photoImageId;
  const now = new Date();

  // Clear the pointer (with audit columns) and delete the blob in one
  // transaction. Idempotent: removing when there is no photo simply stamps the
  // audit columns and returns success.
  await prisma.$transaction(async (tx) => {
    await tx.member.update({
      where: { id },
      data: {
        photoImageId: null,
        photoUpdatedAt: now,
        photoUpdatedByMemberId: actor.actorId,
      },
    });

    if (previousImageId) {
      await tx.mediaImage.deleteMany({
        where: { id: previousImageId, kind: "MEMBER_PHOTO" },
      });
    }
  });

  logAudit({
    action: "member_photo.remove",
    actorMemberId: actor.actorId,
    subjectMemberId: id,
    memberId: actor.actorId,
    targetId: id,
    entityType: "Member",
    entityId: id,
    category: actor.onBehalf ? "admin" : "account",
    outcome: "success",
    summary: actor.onBehalf
      ? "Removed a member photo on behalf of a member"
      : "Removed own member photo",
    metadata: {
      removedImageId: previousImageId ?? null,
      onBehalf: actor.onBehalf,
    },
  });

  return NextResponse.json({ success: true });
}
