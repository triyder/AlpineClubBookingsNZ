import "server-only";
import type { CredentialVersion } from "@/lib/integration-credential-actor";
import { invalidateProviderCredentialCache } from "@/lib/integration-credentials";
import { prisma } from "@/lib/prisma";
import {
  SERVERNZ_PROVIDER,
  readServerNzCredentialVersion,
} from "@/lib/servernz-config";
import {
  SERVERNZ_SETTINGS_ID,
  lockServerNzSettings,
  recordServerVersionCheck,
} from "@/lib/servernz-settings";

/**
 * Which connection a central-server request was sent on (#4366): the stored
 * base URL and the version token of the stored API key, both captured BEFORE
 * the request. Never the plaintext key. A key saved again with the same value
 * (A -> B -> A) still gets a new version, because every credential write
 * re-encrypts under a fresh IV.
 */
export interface ServerNzConnectionIdentity {
  /** `ServerNzSettings.baseUrl` exactly as stored when the request was built. */
  baseUrl: string;
  /** `credentialVersionOf` the API-key row the request's bearer token came from. */
  credentialVersion: CredentialVersion;
}

/**
 * THE ONE WRITE OF THE VERSION COLUMN (#49, #4366): record `version` only if
 * the connection that produced it is STILL the stored one, and say whether it
 * did. Compare and record happen in one short transaction under the settings
 * row lock (`lockServerNzSettings`), re-reading the address and the credential
 * version after the lock is held:
 *
 *   - a new address (`updateServerNzSettings`) and the forget that follows any
 *     key change or removal (`forgetServerConnectionAnswers`) both write the
 *     row, so they queue behind a recorder holding the lock. The address write
 *     does not clear answers; the settings route's subsequent key removal and
 *     separate forget clear any answer recorded for the old connection;
 *   - a recorder that queues behind them re-reads what they committed, sees a
 *     different address or credential version, and records nothing.
 *
 * A refused answer also drops this process's cached ServerNZ credential: the
 * key it was sent with may be a cached copy a write elsewhere has replaced, and
 * the next request should resolve - and check - the stored one rather than
 * repeat the stale key for the rest of the cache window.
 *
 * No HTTP happens here: the caller has already received the answer, and the
 * transaction holds no provider call (`INV-INT-027`). A database failure
 * propagates, so a RECEIVED answer is never mistaken for a failed check.
 */
export async function recordServerVersionIfCurrent(
  identity: ServerNzConnectionIdentity,
  version: string,
): Promise<boolean> {
  const recorded = await prisma.$transaction(
    async (tx) => {
      await lockServerNzSettings(tx);
      const settings = await tx.serverNzSettings.findUnique({
        where: { id: SERVERNZ_SETTINGS_ID },
        select: { baseUrl: true },
      });
      const credentialVersion = await readServerNzCredentialVersion(tx);
      if (
        settings?.baseUrl !== identity.baseUrl ||
        credentialVersion !== identity.credentialVersion
      ) {
        return false;
      }
      await recordServerVersionCheck(version, new Date(), tx);
      return true;
    },
    // Allow a bounded wait behind a lodge merge holding the shared settings row.
    { timeout: 150_000, maxWait: 10_000 },
  );
  if (!recorded) invalidateProviderCredentialCache(SERVERNZ_PROVIDER);
  return recorded;
}
