import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { parseJsonRequestBody } from "@/lib/api-json";
import { createAuditLog, getAuditRequestContext } from "@/lib/audit";
import { isFullAdmin } from "@/lib/access-roles";
import { requireAdmin } from "@/lib/session-guards";
import {
  setIntegrationCredential,
  deleteIntegrationCredential,
} from "@/lib/integration-credentials";
import { WeakAuthSecretError } from "@/lib/integration-crypto";
import {
  BACKUP_PROVIDER,
  BACKUP_CREDENTIAL_KEYS,
  isValidS3Bucket,
  isValidS3Region,
  MIN_BACKUP_RETENTION_DAYS,
  MAX_BACKUP_RETENTION_DAYS,
} from "@/lib/backup-config";
import logger from "@/lib/logger";

// POST /api/admin/backups/config — write non-secret backup configuration.
//
// The route is registered under the `support` area, so support:edit reaches it
// (the run-now + operational config gate). BUT the DESTINATION (bucket/region)
// is Full-Admin only regardless of area level (epic decision 4): repointing the
// destination exfiltrates the entire pg_dump, so it is privileged even though
// it is not secret. Operational config (enabled/retention) is support:edit.
//
// Secret credentials (S3 access key/secret + the restore-validation DSN) are
// NOT written here — they go through the shared C1 credentials route
// (/api/admin/integrations/credentials, Full Admin, write-only, redacted).
//
// Values in this route are non-secret (bucket/region/enabled/retention), so the
// audit entry may list which keys changed. No DSN, no secret, ever.

const bodySchema = z
  .object({
    enabled: z.boolean().optional(),
    retentionDays: z
      .number()
      .int()
      .min(MIN_BACKUP_RETENTION_DAYS)
      .max(MAX_BACKUP_RETENTION_DAYS)
      .optional(),
    // A blank string clears the destination (back to local-only).
    bucket: z.string().max(255).optional(),
    region: z.string().max(64).optional(),
  })
  .strict();

/** Destination keys are Full-Admin only even at support:edit. */
function touchesDestination(body: z.infer<typeof bodySchema>): boolean {
  return body.bucket !== undefined || body.region !== undefined;
}

export async function POST(request: Request) {
  // support:edit (path-inferred by requireAdmin) is the floor.
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const json = await parseJsonRequestBody(request);
  if (!json.ok) return json.response;
  const parsed = bodySchema.safeParse(json.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;

  if (Object.keys(body).length === 0) {
    return NextResponse.json(
      { error: "No configuration fields were provided." },
      { status: 400 },
    );
  }

  const actorIsFullAdmin = isFullAdmin({
    accessRoles: guard.session.user.accessRoles,
  });

  if (touchesDestination(body) && !actorIsFullAdmin) {
    return NextResponse.json(
      {
        error:
          "Changing the backup destination (bucket or region) requires Full Admin access.",
      },
      { status: 403 },
    );
  }

  // Validate destination strings before they reach any CLI call.
  if (body.bucket !== undefined && body.bucket.trim() !== "") {
    if (!isValidS3Bucket(body.bucket)) {
      return NextResponse.json(
        { error: "That S3 bucket name is not valid." },
        { status: 400 },
      );
    }
  }
  if (body.region !== undefined && body.region.trim() !== "") {
    if (!isValidS3Region(body.region)) {
      return NextResponse.json(
        { error: "That AWS region is not valid." },
        { status: 400 },
      );
    }
  }

  const changedKeys: string[] = [];
  try {
    if (body.enabled !== undefined) {
      await setIntegrationCredential({
        provider: BACKUP_PROVIDER,
        key: BACKUP_CREDENTIAL_KEYS.enabled,
        value: body.enabled ? "true" : "false",
        updatedByUserId: guard.session.user.id,
      });
      changedKeys.push(BACKUP_CREDENTIAL_KEYS.enabled);
    }
    if (body.retentionDays !== undefined) {
      await setIntegrationCredential({
        provider: BACKUP_PROVIDER,
        key: BACKUP_CREDENTIAL_KEYS.retentionDays,
        value: String(body.retentionDays),
        updatedByUserId: guard.session.user.id,
      });
      changedKeys.push(BACKUP_CREDENTIAL_KEYS.retentionDays);
    }
    if (body.bucket !== undefined) {
      if (body.bucket.trim() === "") {
        await deleteIntegrationCredential(
          BACKUP_PROVIDER,
          BACKUP_CREDENTIAL_KEYS.bucket,
        );
      } else {
        await setIntegrationCredential({
          provider: BACKUP_PROVIDER,
          key: BACKUP_CREDENTIAL_KEYS.bucket,
          value: body.bucket.trim(),
          updatedByUserId: guard.session.user.id,
        });
      }
      changedKeys.push(BACKUP_CREDENTIAL_KEYS.bucket);
    }
    if (body.region !== undefined) {
      if (body.region.trim() === "") {
        await deleteIntegrationCredential(
          BACKUP_PROVIDER,
          BACKUP_CREDENTIAL_KEYS.region,
        );
      } else {
        await setIntegrationCredential({
          provider: BACKUP_PROVIDER,
          key: BACKUP_CREDENTIAL_KEYS.region,
          value: body.region.trim(),
          updatedByUserId: guard.session.user.id,
        });
      }
      changedKeys.push(BACKUP_CREDENTIAL_KEYS.region);
    }
  } catch (error) {
    if (error instanceof WeakAuthSecretError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    logger.error(
      { err: error instanceof Error ? error.name : "unknown", job: "backup" },
      "Failed to store backup configuration",
    );
    return NextResponse.json(
      { error: "Could not store the backup configuration." },
      { status: 500 },
    );
  }

  // Metadata-only audit: which config keys changed (all non-secret).
  await createAuditLog({
    action: "backup.config.set",
    category: "security",
    severity: "important",
    outcome: "success",
    memberId: guard.session.user.id,
    entityType: "IntegrationCredential",
    entityId: `${BACKUP_PROVIDER}:config`,
    summary: `Updated backup configuration (${changedKeys.join(", ")})`,
    metadata: { provider: BACKUP_PROVIDER, changedKeys },
    ...(() => {
      const ctx = getAuditRequestContext(request);
      return {
        requestId: ctx?.id ?? undefined,
        ipAddress: ctx?.ipAddress ?? undefined,
        userAgent: ctx?.userAgent ?? undefined,
      };
    })(),
  });

  return NextResponse.json({ ok: true, changedKeys });
}
