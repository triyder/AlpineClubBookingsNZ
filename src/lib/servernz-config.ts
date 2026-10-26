/**
 * Alpine Central Server (ServerNZ) connection configuration.
 *
 * The ServerNZ API key is a secret and lives ONLY in the encrypted
 * IntegrationCredential store (same mechanism as Stripe/Xero/Google, #2079).
 * The non-secret connection settings (base URL, per-shared-item enabled flags,
 * last-sync timestamps) live in the `ServerNzSettings` singleton — see
 * `servernz-settings.ts`.
 *
 * Exposure contract: THIS CODE never returns the API key to a client, logs it, or
 * writes it to an audit row. Status surfaces read metadata only
 * (`getServerNzSetupState`), and no `servernz-*` module is imported by any client
 * component, so the value cannot reach the browser.
 *
 * The one path that is not ours to guarantee, stated rather than implied: a
 * central server could echo the bearer token back inside its own error text, and
 * `servernz-sync-response.ts` writes that text into an audit row. Nothing here
 * can stop a remote saying it. What is bounded is the blast radius —
 * `readError()` caps that text at 200 characters and strips control characters
 * before it travels, and `sanitizeAuditDetails` runs over it afterwards. So the
 * claim above is about what this code does, not a promise about the remote.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  readIntegrationCredentialRow,
  resolveIntegrationCredential,
  setIntegrationCredential,
  deleteIntegrationCredential,
} from "@/lib/integration-credentials";
import type {
  CredentialActor,
  CredentialVersion,
} from "@/lib/integration-credential-actor";
import { forgetServerConnectionAnswers } from "@/lib/servernz-settings";

export const SERVERNZ_PROVIDER = "servernz";

export const SERVERNZ_CREDENTIAL_KEYS = {
  apiKey: "api_key",
} as const;

/** The write-capturable ServerNZ credential keys (setup form + API allowlist). */
export const SERVERNZ_WRITABLE_CREDENTIAL_KEYS = [
  SERVERNZ_CREDENTIAL_KEYS.apiKey,
] as const;

/**
 * The operational ServerNZ API key together with the version token of the row
 * it was decrypted from (#4366), or `undefined` when unconfigured or unreadable.
 * Both come from ONE read of the stored row, so the version names exactly the
 * key a request is sent with, even when this process's cached copy is behind a
 * write made elsewhere. The version is the connection's durable identity: every
 * write re-encrypts under a fresh IV, so it moves even when the same key value
 * is saved again (A -> B -> A), and the version recorder compares it under the
 * settings-row lock (`servernz-version-record.ts`).
 */
export async function getOperationalServerNzCredential(): Promise<
  { apiKey: string; version: CredentialVersion } | undefined
> {
  const resolution = await resolveIntegrationCredential(
    SERVERNZ_PROVIDER,
    SERVERNZ_CREDENTIAL_KEYS.apiKey,
  );
  return resolution.status === "configured"
    ? { apiKey: resolution.value, version: resolution.version }
    : undefined;
}

/**
 * The stored API key's version token read through `db`, or `null` when no key
 * is stored. Uncached, so it can run under the caller's
 * lock as the re-read half of a compare-and-record (#4366).
 */
export async function readServerNzCredentialVersion(
  db: Pick<Prisma.TransactionClient, "integrationCredential">,
): Promise<CredentialVersion | null> {
  const resolution = await readIntegrationCredentialRow(
    db,
    SERVERNZ_PROVIDER,
    SERVERNZ_CREDENTIAL_KEYS.apiKey,
  );
  return resolution.status === "not_configured" ? null : resolution.version;
}

/**
 * Store (or replace) the ServerNZ API key. Encrypted at rest.
 *
 * The actor is the caller's to supply and is REQUIRED (#2723) — this used to
 * take an optional `updatedByUserId`, which let an admin action reach the store
 * attributed to nobody.
 */
export async function setServerNzApiKey(
  value: string,
  actor: CredentialActor,
): Promise<void> {
  await setIntegrationCredential({
    provider: SERVERNZ_PROVIDER,
    key: SERVERNZ_CREDENTIAL_KEYS.apiKey,
    value,
    actor,
    // The admin form posts the key it wants stored outright; there is no
    // read-modify-write here to be stale against.
    expect: { expect: "any" },
  });
}

/**
 * Remove the stored ServerNZ API key (disconnect). The owned-lodge list the
 * server issued for that key goes with it (#52): it was THAT connection's
 * answer, and a key issued later — or by a different server, which is the other
 * caller here — may own different lodges. The panel is read-only until the next
 * download records a fresh list. The server's last reported API version goes
 * for the same reason (#49): it was that server's answer. Both in ONE write.
 */
export async function clearServerNzApiKey(
  actor: CredentialActor,
): Promise<void> {
  await deleteIntegrationCredential({
    provider: SERVERNZ_PROVIDER,
    key: SERVERNZ_CREDENTIAL_KEYS.apiKey,
    actor,
    expect: { expect: "any" },
  });
  await forgetServerConnectionAnswers();
}

export interface ServerNzSetupState {
  apiKeySet: boolean;
  apiKeyUpdatedAt: string | null;
}

/**
 * Metadata-only setup state for the setup page and module readiness. NEVER
 * returns the key value. A DB error propagates to the caller.
 */
export async function getServerNzSetupState(): Promise<ServerNzSetupState> {
  const apiKeyUpdatedAt = await readServerNzApiKeyStamp();
  return { apiKeySet: apiKeyUpdatedAt !== null, apiKeyUpdatedAt };
}

/**
 * When the stored API key was last written, or `null` when there is none —
 * metadata only, never the key. A new key, or a new server address (which
 * removes the key), changes it, so it doubles as the CONNECTION's identity: the
 * Other lodges download compares it before and after (#64) so a download that
 * outlived a change of connection records nothing. Read through `db` so it can
 * run under a lock inside the caller's transaction.
 */
export async function readServerNzApiKeyStamp(
  db: Pick<Prisma.TransactionClient, "integrationCredential"> = prisma,
): Promise<string | null> {
  const row = await db.integrationCredential.findFirst({
    where: {
      provider: SERVERNZ_PROVIDER,
      key: SERVERNZ_CREDENTIAL_KEYS.apiKey,
    },
    select: { updatedAt: true },
  });
  return row ? row.updatedAt.toISOString() : null;
}

/** True when a ServerNZ API key is configured (readiness helper, fail-closed). */
export async function isServerNzConfigured(): Promise<boolean> {
  try {
    const state = await getServerNzSetupState();
    return state.apiKeySet;
  } catch {
    return false;
  }
}
