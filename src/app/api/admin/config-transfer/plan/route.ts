import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/session-guards";
import { isFullAdmin } from "@/lib/access-roles";
import { prisma } from "@/lib/prisma";
import { buildImportPlan } from "@/lib/config-transfer/import";
import {
  ConfigTransferBundleError,
  MAX_BUNDLE_BYTES,
} from "@/lib/config-transfer/bundle";

// POST /api/admin/config-transfer/plan — full-admin only.
// Dry-run: accepts an uploaded bundle (multipart 'bundle' file) and returns the
// import plan (create/update/unchanged per entity + fingerprint + warnings).
// Read-only; no mutation. See ADR-002.

export async function POST(request: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  if (!isFullAdmin({ accessRoles: guard.session.user.accessRoles })) {
    return NextResponse.json(
      { error: "Full admin access is required." },
      { status: 403 },
    );
  }

  let bytes: Uint8Array;
  try {
    const form = await request.formData();
    const file = form.get("bundle");
    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "Missing 'bundle' file." },
        { status: 400 },
      );
    }
    if (file.size > MAX_BUNDLE_BYTES) {
      return NextResponse.json(
        { error: "Bundle is too large." },
        { status: 413 },
      );
    }
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return NextResponse.json(
      { error: "Could not read the uploaded bundle." },
      { status: 400 },
    );
  }

  try {
    const plan = await buildImportPlan(prisma, bytes);
    return NextResponse.json({ plan });
  } catch (error) {
    if (error instanceof ConfigTransferBundleError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
