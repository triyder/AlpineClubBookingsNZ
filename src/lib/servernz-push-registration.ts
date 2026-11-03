import "server-only";

import { getAppBaseUrl } from "@/lib/app-url";
import {
  getIntegrationCredentialValue,
  invalidateProviderCredentialCache,
  setIntegrationCredentialInTransaction,
} from "@/lib/integration-credentials";
import logger from "@/lib/logger";
import {
  ServerNzApiError,
  ServerNzNotConfiguredError,
  ServerNzVersionMismatchError,
  registerPushTarget,
} from "@/lib/servernz-api";
import { SERVER_VERSION_MISMATCH_CODE } from "@/lib/servernz-api-version";
import { SERVERNZ_CREDENTIAL_KEYS, SERVERNZ_PROVIDER } from "@/lib/servernz-config";
import { serverNzAnswerWriter } from "@/lib/servernz-version-record";

/*
 * The shared-post push registration (epic #2992), apart from the mirror pass
 * that calls it first (`runMirrorSync`, `club-post-mirror.ts`), as upstream
 * keeps it (#4470).
 */

/** One registration's outcome. `awaiting-approval`: the server's 403 for a
 * pending or suspended club; it and `failed` are retried by the mirror pass. */
export type PushRegistrationOutcome =
  "registered" | "already-registered" | "not-https" | "no-address" | "awaiting-approval" | "failed";

/**
 * Make sure the central server knows where to push for this install.
 *
 * Idempotent and cheap to call from the sync pass: it does nothing while the
 * stored secret was issued for this site's CURRENT callback address (a key
 * change deletes both, `forgetServerConnection`). The callback URL is derived
 * from this install's own address (`getAppBaseUrl`) so there is no second
 * base-URL setting to drift; when that address moves, the stored one no
 * longer matches and the site registers again, or the server would keep
 * pushing to, and asking free beds of, a host that no longer answers. A
 * secret stored before the address was kept beside it registers once more.
 *
 * Registering again is safe: the server keeps the same secret for a repeat of
 * the same URL and rotates it only when the URL changes, and either way the
 * secret it returns is the one stored.
 */
export async function ensurePushRegistration(): Promise<PushRegistrationOutcome> {
  const base = getAppBaseUrl();
  // Push needs a URL the central server can reach over https; a localhost dev
  // install simply stays poll-only, which loses nothing but latency.
  const callback = base.startsWith("https://")
    ? new URL("/api/webhooks/servernz-posts", base).toString()
    : null;

  const existing = await getIntegrationCredentialValue(
    SERVERNZ_PROVIDER,
    SERVERNZ_CREDENTIAL_KEYS.pushSecret,
  );
  if (existing) {
    // An address that is not https is never registered over a working one.
    if (callback === null) return "already-registered";
    const registeredUrl = await getIntegrationCredentialValue(
      SERVERNZ_PROVIDER,
      SERVERNZ_CREDENTIAL_KEYS.pushRegisteredUrl,
    );
    if (registeredUrl === callback) return "already-registered";
    logger.info(
      { callback, previous: registeredUrl ?? null },
      "This site's push address changed since it registered; registering again",
    );
  }
  if (callback === null) return "not-https";

  try {
    const result = await registerPushTarget(callback);
    // Fenced on the connection it went out on: a key or address replaced
    // meanwhile deleted the old secret, which must not come back (`failed`).
    try {
      // The secret and the address it was issued for, in ONE write, so a
      // stored secret is never paired with another registration's address.
      await serverNzAnswerWriter(result.sentOn)(async (tx) => {
        for (const [key, value] of [
          [SERVERNZ_CREDENTIAL_KEYS.pushSecret, result.secret],
          [SERVERNZ_CREDENTIAL_KEYS.pushRegisteredUrl, callback],
        ] as const) {
          await setIntegrationCredentialInTransaction({
            tx,
            provider: SERVERNZ_PROVIDER,
            key,
            value,
            actor: { kind: "system", actor: "servernz-push-registration" },
            // Last-writer-wins, NOT create-only (#2723): the server keeps the
            // most recent registration (a PUT), so the pair worth storing is
            // the last.
            expect: { expect: "any" },
          });
        }
      });
    } finally {
      invalidateProviderCredentialCache(SERVERNZ_PROVIDER);
    }
    logger.info(
      { callback, secretVersion: result.secretVersion },
      "Registered this install for shared-post pushes",
    );
    return "registered";
  } catch (error) {
    // A version pause is the pass's answer, not registration's: let the pass
    // report it (#49 review item 1).
    if (error instanceof ServerNzVersionMismatchError) throw error;
    // Poll-only works, so a failed registration does not fail the sync pass.
    logger.warn({ err: error }, "Could not register the shared-post push target");
    if (error instanceof ServerNzNotConfiguredError) return "no-address";
    // A pending or suspended club's key is refused with 403 (server #44).
    return error instanceof ServerNzApiError && error.status === 403
      ? "awaiting-approval"
      : "failed";
  }
}

/**
 * Register straight after an API key save, as an outcome for the setup page.
 * Never throws: the key is stored whatever this comes to; the pass retries.
 */
export async function registerAfterKeySave(): Promise<
  PushRegistrationOutcome | typeof SERVER_VERSION_MISMATCH_CODE
> {
  try {
    return await ensurePushRegistration();
  } catch (error) {
    if (error instanceof ServerNzVersionMismatchError) return SERVER_VERSION_MISMATCH_CODE;
    logger.warn({ err: error }, "Push registration after a key save failed");
    return "failed";
  }
}
