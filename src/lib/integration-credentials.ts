/**
 * Encrypted integration credential store (guided provider setup — #2079).
 *
 * The database is the ONLY source of provider credentials. This module is the
 * shared surface every guided-setup lane (Xero here; Stripe/Google/Backup
 * later) reads and writes through: write-only setters, cache-aware async
 * getters, the canonical per-provider STATE MODEL, and the unified re-entry
 * aggregate.
 *
 * CROSS-PROCESS CACHE (binding contract — issue #2079):
 * production runs three containers (blue/green web slots + cron-leader,
 * docker-compose.yml). A wizard write lands in one web slot; the cron-leader
 * (Xero sync, payment sync, backups) must observe it without a restart. So:
 *   - entries carry a SHORT TTL (CACHE_TTL_MS, 30-60s) — a fresh write is
 *     visible to a cold reader in another process within the TTL;
 *   - the writing process invalidates its own cache immediately;
 *   - NEGATIVE results ("provider not configured") are cached, but only for the
 *     TTL — they expire, they are never remembered indefinitely;
 *   - a DB ERROR is never converted into a remembered negative: the error
 *     propagates and nothing is cached.
 * The derived key + decrypt are synchronous (integration-crypto.ts); only the
 * ciphertext fetch here is async.
 */

import type { IntegrationCredential } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  CredentialDecryptError,
  INTEGRATION_CREDENTIAL_LABEL,
  decryptCredential,
  encryptCredential,
  getAuthSecretWithSource,
  isAuthSecretStrongEnough,
  type AuthSecretSource,
} from "@/lib/integration-crypto";

/** Cross-process cache TTL. Kept inside the binding 30-60s window. */
export const CACHE_TTL_MS = 45_000;

interface CachedProvider {
  fetchedAt: number;
  rows: Map<string, IntegrationCredential>;
}

// Module-scoped, per-process cache. Cleared on write in the writing process;
// other processes re-read once their entry ages past the TTL.
const providerCache = new Map<string, CachedProvider>();

/** test seam — reset the in-process cache between tests. */
export function resetIntegrationCredentialCacheForTests(): void {
  providerCache.clear();
}

/** Drop a provider's cached rows immediately (called after any write). */
export function invalidateProviderCredentialCache(provider: string): void {
  providerCache.delete(provider);
}

/**
 * Load a provider's credential rows, cache-aware. A DB error propagates and is
 * NOT cached (never remembered as a negative). An empty result IS cached (a
 * bounded negative that expires at the TTL).
 */
async function loadProviderRows(
  provider: string,
  now: number = Date.now(),
): Promise<Map<string, IntegrationCredential>> {
  const cached = providerCache.get(provider);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.rows;
  }
  // A throw here (DB unreachable) propagates without touching the cache.
  const rows = await prisma.integrationCredential.findMany({
    where: { provider },
  });
  const map = new Map(rows.map((row) => [row.key, row]));
  providerCache.set(provider, { fetchedAt: now, rows: map });
  return map;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export type CredentialResolution =
  | {
      status: "configured";
      value: string;
      secretSource: AuthSecretSource;
      /** Value unchanged, but the secret env var it was written under flipped. */
      sourceFlipped: boolean;
      labelVersion: string;
    }
  | { status: "not_configured" }
  | { status: "needs_reentry"; reason: string };

/**
 * Resolve one credential. Distinguishes:
 *   - configured (decrypts; may flag a secret-source flip),
 *   - not_configured (no row),
 *   - needs_reentry (row present but GCM fails — the auth secret changed).
 * A DB error propagates to the caller (it is neither "not configured" nor a
 * decrypt failure).
 */
export async function resolveIntegrationCredential(
  provider: string,
  key: string,
): Promise<CredentialResolution> {
  const rows = await loadProviderRows(provider);
  const row = rows.get(key);
  if (!row) return { status: "not_configured" };

  try {
    const value = decryptCredential({
      provider: row.provider,
      key: row.key,
      ciphertext: row.ciphertext,
      iv: row.iv,
      authTag: row.authTag,
      labelVersion: row.labelVersion,
    });
    const currentSource = getAuthSecretWithSource()?.source;
    return {
      status: "configured",
      value,
      secretSource: row.secretSource as AuthSecretSource,
      sourceFlipped:
        currentSource !== undefined && currentSource !== row.secretSource,
      labelVersion: row.labelVersion,
    };
  } catch (error) {
    if (error instanceof CredentialDecryptError) {
      return { status: "needs_reentry", reason: error.message };
    }
    throw error;
  }
}

/**
 * Convenience: the decrypted value, or null when the credential is missing OR
 * unreadable (needs re-entry). Resolvers that only need the value use this; a
 * DB error still propagates.
 */
export async function getIntegrationCredentialValue(
  provider: string,
  key: string,
): Promise<string | null> {
  const resolution = await resolveIntegrationCredential(provider, key);
  return resolution.status === "configured" ? resolution.value : null;
}

// ---------------------------------------------------------------------------
// Write (Full-Admin only — enforced at the API boundary)
// ---------------------------------------------------------------------------

export interface SetCredentialResult {
  provider: string;
  key: string;
  secretSource: AuthSecretSource;
  labelVersion: string;
  updatedAt: Date;
}

/**
 * Encrypt and persist a credential (upsert on (provider, key)). Runs the
 * capture-time strong-secret gate inside encryptCredential — a weak/placeholder
 * secret throws WeakAuthSecretError and nothing is written. Invalidates the
 * writing process's cache immediately.
 *
 * Note the VERIFY-RESET rule (any credential write clears the provider's
 * verified/connected state) is applied by the caller that knows the provider's
 * verified-state store — e.g. the Xero write path drops stored OAuth tokens so
 * the operator re-connects. This module owns only the encrypted value.
 */
export async function setIntegrationCredential(params: {
  provider: string;
  key: string;
  value: string;
  updatedByUserId?: string | null;
  label?: string;
}): Promise<SetCredentialResult> {
  const label = params.label ?? INTEGRATION_CREDENTIAL_LABEL;
  const encrypted = encryptCredential({
    provider: params.provider,
    key: params.key,
    plaintext: params.value,
    label,
  });

  const row = await prisma.integrationCredential.upsert({
    where: { provider_key: { provider: params.provider, key: params.key } },
    create: {
      provider: params.provider,
      key: params.key,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      secretSource: encrypted.secretSource,
      labelVersion: encrypted.labelVersion,
      updatedByUserId: params.updatedByUserId ?? null,
    },
    update: {
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      secretSource: encrypted.secretSource,
      labelVersion: encrypted.labelVersion,
      updatedByUserId: params.updatedByUserId ?? null,
    },
  });

  invalidateProviderCredentialCache(params.provider);

  return {
    provider: row.provider,
    key: row.key,
    secretSource: encrypted.secretSource,
    labelVersion: encrypted.labelVersion,
    updatedAt: row.updatedAt,
  };
}

/**
 * Ensure a self-generated credential (e.g. the wrapped Xero token key) exists,
 * returning its decrypted value — or `null` when the strength gate blocks
 * generation (NEVER throwing: this can fire from a mere module toggle).
 *
 *   - strong secret + no row      → CREATE-ONLY: `create` + catch P2002, so a
 *                                    concurrent creator's value wins (never an
 *                                    upsert / last-writer-wins across containers);
 *   - strong secret + readable row → return the existing value (never overwrite);
 *   - strong secret + unreadable row (auth secret changed) → the wrapped key is
 *     useless and would block reconnect, so replace the ALREADY-DEAD material
 *     with a fresh one — under a status-guarded `updateMany` claim so a loser
 *     re-reads the winner rather than clobbering it;
 *   - weak/placeholder secret     → no-op, return null.
 *
 * The generate path is genuinely create-only: there is no upsert here, so two
 * cron/web containers generating at once converge on ONE stored value instead of
 * silently overwriting each other (correctness F1 / ops F6 / security F3).
 */
export async function ensureGeneratedCredential(params: {
  provider: string;
  key: string;
  label: string;
  generate: () => string;
  updatedByUserId?: string | null;
}): Promise<string | null> {
  if (!isAuthSecretStrongEnough(getAuthSecretWithSource()?.secret)) {
    return null; // blocked readiness check, not an exception
  }

  const existing = await resolveIntegrationCredential(params.provider, params.key);
  // A readable key is authoritative — never overwrite it.
  if (existing.status === "configured") return existing.value;

  if (existing.status === "not_configured") {
    return createGeneratedCredential({
      provider: params.provider,
      key: params.key,
      label: params.label,
      value: params.generate(),
      updatedByUserId: params.updatedByUserId ?? null,
    });
  }

  // needs_reentry: replace the dead row via a claim keyed on its exact stale
  // ciphertext so only one process rewrites a given version.
  const rows = await loadProviderRows(params.provider);
  const staleRow = rows.get(params.key);
  if (!staleRow) {
    // The row vanished between resolve and here — treat as create-only.
    return createGeneratedCredential({
      provider: params.provider,
      key: params.key,
      label: params.label,
      value: params.generate(),
      updatedByUserId: params.updatedByUserId ?? null,
    });
  }
  return replaceUnreadableCredential({
    provider: params.provider,
    key: params.key,
    label: params.label,
    value: params.generate(),
    staleCiphertext: staleRow.ciphertext,
    updatedByUserId: params.updatedByUserId ?? null,
  });
}

/**
 * True for a Prisma unique-constraint conflict (P2002). Detected structurally
 * (by `code`) so a raced insert is tolerated regardless of how the driver
 * surfaces it — same shape as `isUniqueConstraintError` in config-self-heal,
 * inlined here to keep this module free of that boot module's imports.
 */
function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  );
}

/**
 * Encrypt `value` and persist it as a NEW row (create-only). Returns the winner's
 * decrypted value: on a P2002 unique race the concurrent creator won, so we
 * re-resolve and return whatever is now stored (both processes share the same
 * strong auth secret, so the winner's row is readable). Never overwrites.
 */
async function createGeneratedCredential(params: {
  provider: string;
  key: string;
  label: string;
  value: string;
  updatedByUserId?: string | null;
}): Promise<string> {
  const encrypted = encryptCredential({
    provider: params.provider,
    key: params.key,
    plaintext: params.value,
    label: params.label,
  });
  try {
    await prisma.integrationCredential.create({
      data: {
        provider: params.provider,
        key: params.key,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        secretSource: encrypted.secretSource,
        labelVersion: encrypted.labelVersion,
        updatedByUserId: params.updatedByUserId ?? null,
      },
    });
    invalidateProviderCredentialCache(params.provider);
    return params.value;
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    // Lost the create race — return the winner's value, not ours.
    invalidateProviderCredentialCache(params.provider);
    const winner = await resolveIntegrationCredential(params.provider, params.key);
    if (winner.status === "configured") return winner.value;
    // The winner exists but is unreadable (a different secret wrote it). The
    // material is unrecoverable; surface the original conflict rather than
    // silently returning a value nobody can use.
    throw error;
  }
}

/**
 * Replace an UNREADABLE (needs_reentry) row with a fresh value under a
 * create-or-lose discipline: a status-guarded `updateMany` claim keyed on the
 * exact stale ciphertext we read, so only ONE process replaces a given dead row
 * and every loser re-reads the winner's value instead of clobbering it. The
 * stale material is already unrecoverable, so we never risk overwriting a live
 * key here (that case returned above).
 */
async function replaceUnreadableCredential(params: {
  provider: string;
  key: string;
  label: string;
  value: string;
  staleCiphertext: string;
  updatedByUserId?: string | null;
}): Promise<string> {
  const encrypted = encryptCredential({
    provider: params.provider,
    key: params.key,
    plaintext: params.value,
    label: params.label,
  });
  const claimed = await prisma.integrationCredential.updateMany({
    where: {
      provider: params.provider,
      key: params.key,
      // Claim only the exact dead row we observed. Once any process replaces it
      // the ciphertext changes, so a racing writer's claim matches zero rows.
      ciphertext: params.staleCiphertext,
    },
    data: {
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      secretSource: encrypted.secretSource,
      labelVersion: encrypted.labelVersion,
      updatedByUserId: params.updatedByUserId ?? null,
    },
  });
  invalidateProviderCredentialCache(params.provider);
  if (claimed.count === 1) return params.value;

  // Another process already replaced the dead row — adopt the winner's value.
  const winner = await resolveIntegrationCredential(params.provider, params.key);
  if (winner.status === "configured") return winner.value;
  // Still unreadable (the row was deleted, or replaced under a changed secret):
  // fall back to a create-only attempt so a missing row is (re)generated.
  return createGeneratedCredential(params);
}

/** Delete a single credential row (used by disconnect flows). */
export async function deleteIntegrationCredential(
  provider: string,
  key: string,
): Promise<void> {
  await prisma.integrationCredential.deleteMany({
    where: { provider, key },
  });
  invalidateProviderCredentialCache(provider);
}

// ---------------------------------------------------------------------------
// Canonical per-provider state model (shared — consumed by C2..C6)
// ---------------------------------------------------------------------------

/**
 * Canonical states a provider's setup can be in. Every guided-setup lane renders
 * from this one enum so the Integrations hub, readiness, and each wizard agree.
 *
 *   not_configured   → no credentials stored yet
 *   saved_unverified → credentials stored, not yet proven to work
 *   verified         → credentials stored AND verified/connected
 *   webhooks_amber   → connected, but the webhook subscription is unverified
 *   needs_reentry    → a stored credential fails GCM (the auth secret changed)
 *
 * VERIFY-RESET (epic decision 6): any credential write drops the provider out
 * of `verified`/`webhooks_amber` back to `saved_unverified` and re-arms
 * verification. The verified-state store lives with each provider; this enum is
 * the shared vocabulary.
 */
export type ProviderCredentialState =
  | "not_configured"
  | "saved_unverified"
  | "verified"
  | "webhooks_amber"
  | "needs_reentry";

/**
 * Does a provider have any stored credential that fails to decrypt? Drives the
 * unified "N integrations need credentials re-entered (encryption key changed)"
 * aggregate everywhere (readiness + Integrations hub) off ONE detection path.
 *
 * A DB error propagates (the caller decides how to surface an unknown state);
 * a `not_configured` provider is simply not "needing re-entry".
 */
export async function providerNeedsReentry(provider: string): Promise<boolean> {
  const rows = await loadProviderRows(provider);
  if (rows.size === 0) return false;
  const currentSecret = getAuthSecretWithSource();
  if (!currentSecret) return true; // rows exist but nothing can decrypt them
  for (const row of rows.values()) {
    try {
      decryptCredential({
        provider: row.provider,
        key: row.key,
        ciphertext: row.ciphertext,
        iv: row.iv,
        authTag: row.authTag,
        labelVersion: row.labelVersion,
      });
    } catch (error) {
      if (error instanceof CredentialDecryptError) return true;
      throw error;
    }
  }
  return false;
}

/**
 * The subset of the given providers whose stored credentials fail GCM. Powers
 * the shared re-entry aggregate. Providers with no stored credentials never
 * appear. Propagates a DB error.
 */
export async function getIntegrationsNeedingReentry(
  providers: readonly string[],
): Promise<string[]> {
  const needing: string[] = [];
  for (const provider of providers) {
    if (await providerNeedsReentry(provider)) needing.push(provider);
  }
  return needing;
}
