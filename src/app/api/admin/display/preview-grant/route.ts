import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { resolveOptionalActiveLodgeId } from "@/lib/lodges";
import {
  encodePreviewGrant,
  PREVIEW_GRANT_TTL_SECONDS,
} from "@/lib/lodge-display-auth";

// Preview grant mint (LTV-036, ADR-003 §5). The authoring pages preview an
// AUTHORED template inside a `sandbox="allow-scripts"` iframe (opaque origin, no
// cookies), so the framed /display cannot use the admin's session. This
// admin-only endpoint mints the short-lived, HMAC-signed capability the iframe
// carries as ?previewGrant=<token>: it names exactly one template + lodge (+ an
// optional simulated date) and expires in five minutes.
//
// The grant is issued here, under requireAdmin — the ONLY place an admin's
// authority converts into a sessionless preview capability. It is stateless
// (nothing persisted; the signature is the whole authority) and single-purpose:
// it authorises the state route's preview path and nothing else (§5), so a
// leaked grant can at worst re-render a five-minute, privacy-reduced board.

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const bodyField = z
  .object({
    // Null/omitted → preview the lodge's legacy board (no authored template).
    templateId: z.string().min(1).nullish(),
    // Templates are lodge-agnostic, so the lodge is explicit; omitted → the
    // club default lodge (resolveOptionalActiveLodgeId).
    previewLodge: z.string().min(1).nullish(),
    // Optional simulated window start (LTV-017).
    previewDate: z.string().regex(DATE_ONLY).nullish(),
  })
  .strict();

export async function POST(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  let body: z.infer<typeof bodyField>;
  try {
    body = bodyField.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  // The lodge must exist and be active (or default when omitted); an admin path,
  // so a cross-lodge preview is in-policy, but a bogus/inactive lodge is a 400.
  const lodgeId = await resolveOptionalActiveLodgeId(prisma, body.previewLodge);
  if (!lodgeId) {
    return NextResponse.json({ error: "Unknown or inactive lodge" }, { status: 400 });
  }

  // A named template must actually exist — mint a grant only for something the
  // state route can render (else the preview would silently fall back).
  if (body.templateId) {
    const template = await prisma.displayTemplate.findUnique({
      where: { id: body.templateId },
      select: { id: true },
    });
    if (!template) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }
  }

  const lodge = await prisma.lodge.findUnique({
    where: { id: lodgeId },
    select: { id: true, name: true },
  });
  if (!lodge) {
    return NextResponse.json({ error: "Unknown or inactive lodge" }, { status: 400 });
  }

  const token = encodePreviewGrant({
    templateId: body.templateId ?? null,
    lodgeId,
    ...(body.previewDate ? { windowStart: body.previewDate } : {}),
    exp: Math.floor(Date.now() / 1000) + PREVIEW_GRANT_TTL_SECONDS,
  });

  // The lodge id/name ride back so the authoring UI can label the preview
  // "previewing against <lodge>" without a second round-trip (the old silent
  // default becomes explicit — shrinks #64).
  return NextResponse.json({
    token,
    lodgeId: lodge.id,
    lodgeName: lodge.name,
    expiresInSeconds: PREVIEW_GRANT_TTL_SECONDS,
  });
}
