import { NextResponse } from "next/server";

import { createAuditLog } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import {
  applyConfigImport,
  ConfigImportBackupError,
  ConfigImportDriftError,
  ConfigImportValidationError,
} from "@/lib/config-transfer/apply";
import { ConfigTransferBundleError } from "@/lib/config-transfer/bundle";
import {
  readBundleUpload,
  requireFullAdminForConfigTransfer,
} from "@/lib/config-transfer/route-helpers";
import { configTransferErrorResponse } from "@/lib/config-transfer/route-error";

// POST /api/admin/config-transfer/apply — full-admin only.
// Applies a previewed bundle: backup → one transaction { advisory lock →
// re-plan → refuse on validation errors or fingerprint drift → upsert }.
// Multipart: 'bundle' file + 'expectedFingerprint' + mode/categories/resolutions
// from the dry-run. Failed/refused applies are audit-logged too (ADR-002).

export async function POST(request: Request) {
  const guard = await requireFullAdminForConfigTransfer();
  if (!guard.ok) return guard.response;

  const uploaded = await readBundleUpload(request);
  if (!uploaded.ok) return uploaded.response;
  const { bytes, mode, selectedCategories, resolutions, expectedFingerprint } =
    uploaded.upload;
  if (!expectedFingerprint) {
    return NextResponse.json(
      { error: "Missing 'expectedFingerprint' (run the dry-run first)." },
      { status: 400 },
    );
  }

  const auditFailure = async (reason: string, detail?: string) => {
    await createAuditLog({
      action: "configuration.import_refused",
      memberId: guard.memberId,
      category: "admin",
      severity: "important",
      outcome: "failure",
      summary: `Configuration import refused (${reason})`,
      metadata: { reason, ...(detail ? { detail: detail.slice(0, 500) } : {}), mode },
    });
  };

  try {
    const result = await applyConfigImport({
      prisma,
      bundleBytes: bytes,
      actorMemberId: guard.memberId,
      expectedFingerprint,
      mode,
      selectedCategories,
      resolutions,
    });
    return NextResponse.json({ result });
  } catch (error) {
    if (error instanceof ConfigImportDriftError) {
      await auditFailure("fingerprint drift");
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof ConfigImportValidationError) {
      await auditFailure("validation errors", error.errors.join("; "));
      return NextResponse.json(
        { error: error.message, errors: error.errors },
        { status: 422 },
      );
    }
    if (error instanceof ConfigImportBackupError) {
      await auditFailure("backup failed", error.message);
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    if (error instanceof ConfigTransferBundleError) {
      await auditFailure("invalid bundle", error.message);
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    await auditFailure("unexpected error");
    return configTransferErrorResponse("Apply", error);
  }
}
