import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/session-guards";
import { isFullAdmin } from "@/lib/access-roles";
import { prisma } from "@/lib/prisma";
import {
  applyConfigImport,
  ConfigImportDriftError,
  ConfigImportBackupError,
} from "@/lib/config-transfer/apply";
import {
  ConfigTransferBundleError,
  MAX_BUNDLE_BYTES,
} from "@/lib/config-transfer/bundle";

// POST /api/admin/config-transfer/apply — full-admin only.
// Applies a previewed bundle: re-plans, refuses on fingerprint drift, backs up,
// then upserts within one transaction. Multipart: 'bundle' file +
// 'expectedFingerprint' from the dry-run. See ADR-002.

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
  let expectedFingerprint: string;
  try {
    const form = await request.formData();
    const file = form.get("bundle");
    const fingerprint = form.get("expectedFingerprint");
    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "Missing 'bundle' file." },
        { status: 400 },
      );
    }
    if (typeof fingerprint !== "string" || fingerprint.length === 0) {
      return NextResponse.json(
        { error: "Missing 'expectedFingerprint' (run the dry-run first)." },
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
    expectedFingerprint = fingerprint;
  } catch {
    return NextResponse.json(
      { error: "Could not read the uploaded bundle." },
      { status: 400 },
    );
  }

  try {
    const result = await applyConfigImport({
      prisma,
      bundleBytes: bytes,
      actorMemberId: guard.session.user.id,
      expectedFingerprint,
    });
    return NextResponse.json({ result });
  } catch (error) {
    if (error instanceof ConfigImportDriftError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof ConfigTransferBundleError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ConfigImportBackupError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    throw error;
  }
}
