import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { parseJsonRequestBody } from "@/lib/api-json";
import { createAuditLog, getAuditRequestContext } from "@/lib/audit";
import { isFullAdmin } from "@/lib/access-roles";
import { requireAdmin } from "@/lib/session-guards";
import { setIntegrationCredential } from "@/lib/integration-credentials";
import { WeakAuthSecretError } from "@/lib/integration-crypto";
import { deleteXeroTokens } from "@/lib/xero-token-store";
import { XERO_CREDENTIAL_KEYS, XERO_PROVIDER } from "@/lib/xero-config";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";

// POST /api/admin/integrations/credentials — write-only credential setter.
//
// Full Admin only (epic decision 4; precedent requireFullAdminForConfigTransfer)
// plus the repo's standard admin-mutation protections (authenticated
// same-origin session, JSON body). Values are NEVER returned — the response
// confirms metadata only. Audit entries are metadata-only (no value, no body).
//
// Exposure contract (#2079): no plaintext or ciphertext/iv/authTag in the
// response, the log lines, or the audit row.

/**
 * Allowlist of credentials this endpoint may write, per provider. Prevents
 * arbitrary (provider, key) rows and keys the verify-reset behaviour. C4/C5/C6
 * extend this with their providers.
 */
const WRITABLE_CREDENTIALS: Record<string, readonly string[]> = {
  [XERO_PROVIDER]: [
    XERO_CREDENTIAL_KEYS.clientId,
    XERO_CREDENTIAL_KEYS.clientSecret,
    XERO_CREDENTIAL_KEYS.webhookKey,
  ],
};

// GET /api/admin/integrations/credentials?provider=xero — METADATA-ONLY status.
//
// Any admin may read the set/not-set status so area admins keep visibility
// (epic decision 4); only Full Admins can WRITE (POST below). The response
// carries NO value or ciphertext/iv/authTag — only whether each key is set, its
// set-at timestamp, and secretSource. Exposure contract (#2079).
export async function GET(request: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const provider = new URL(request.url).searchParams.get("provider") ?? "";
  const allowedKeys = WRITABLE_CREDENTIALS[provider];
  if (!allowedKeys) {
    return NextResponse.json(
      { error: "Unknown provider." },
      { status: 400 },
    );
  }

  // Select METADATA COLUMNS ONLY — never ciphertext/iv/authTag/value.
  const rows = await prisma.integrationCredential.findMany({
    where: { provider, key: { in: [...allowedKeys] } },
    select: { key: true, secretSource: true, updatedAt: true },
  });

  const credentials: Record<
    string,
    { set: boolean; setAt: string; secretSource: string }
  > = {};
  for (const row of rows) {
    credentials[row.key] = {
      set: true,
      setAt: row.updatedAt.toISOString(),
      secretSource: row.secretSource,
    };
  }

  return NextResponse.json({ provider, credentials });
}

const bodySchema = z.object({
  provider: z.string().min(1).max(64),
  key: z.string().min(1).max(64),
  // A credential value; capped to a sane length. Never logged, never returned.
  value: z.string().min(1).max(4096),
});

async function requireFullAdmin() {
  const guard = await requireAdmin();
  if (!guard.ok) return { ok: false as const, response: guard.response };
  if (!isFullAdmin({ accessRoles: guard.session.user.accessRoles })) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { error: "Full admin access is required." },
        { status: 403 },
      ),
    };
  }
  return { ok: true as const, memberId: guard.session.user.id };
}

/**
 * Verify-reset (epic decision 6): a credential write clears the provider's
 * verified/connected state and re-arms verification. For Xero, changing the
 * client id/secret invalidates the OAuth app the stored tokens belong to, so
 * the tokens are dropped and the operator must reconnect. Changing only the
 * webhook key does NOT drop tokens (that surfaces as a webhook amber badge in a
 * later lane).
 */
async function applyVerifyReset(provider: string, key: string): Promise<void> {
  if (
    provider === XERO_PROVIDER &&
    (key === XERO_CREDENTIAL_KEYS.clientId ||
      key === XERO_CREDENTIAL_KEYS.clientSecret)
  ) {
    await deleteXeroTokens();
  }
}

export async function POST(request: Request) {
  const guard = await requireFullAdmin();
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

  const { provider, key, value } = parsed.data;
  const allowedKeys = WRITABLE_CREDENTIALS[provider];
  if (!allowedKeys || !allowedKeys.includes(key)) {
    return NextResponse.json(
      { error: "Unknown provider or credential key." },
      { status: 400 },
    );
  }

  let result;
  try {
    result = await setIntegrationCredential({
      provider,
      key,
      value,
      updatedByUserId: guard.memberId,
    });
  } catch (error) {
    if (error instanceof WeakAuthSecretError) {
      // Plain-English capture-time gate message; safe to surface (no secret).
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    // Never echo the request body / value in the error.
    logger.error(
      { provider, key, err: error instanceof Error ? error.name : "unknown" },
      "Failed to store integration credential",
    );
    return NextResponse.json(
      { error: "Could not store the credential." },
      { status: 500 },
    );
  }

  await applyVerifyReset(provider, key);

  // Metadata-only audit (no value, no body, no before/after). createAuditLog
  // additionally sanitises metadata as defence in depth.
  await createAuditLog({
    action: "integration.credential.set",
    category: "security",
    severity: "important",
    outcome: "success",
    memberId: guard.memberId,
    entityType: "IntegrationCredential",
    entityId: `${provider}:${key}`,
    summary: `Set ${provider} credential "${key}"`,
    metadata: {
      provider,
      key,
      secretSource: result.secretSource,
      labelVersion: result.labelVersion,
    },
    ...(() => {
      const ctx = getAuditRequestContext(request);
      return {
        requestId: ctx?.id ?? undefined,
        ipAddress: ctx?.ipAddress ?? undefined,
        userAgent: ctx?.userAgent ?? undefined,
      };
    })(),
  });

  // Response confirms metadata only — the value is never returned.
  return NextResponse.json({
    ok: true,
    provider: result.provider,
    key: result.key,
    setAt: result.updatedAt.toISOString(),
  });
}
