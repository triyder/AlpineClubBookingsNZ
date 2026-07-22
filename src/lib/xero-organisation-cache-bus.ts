/**
 * Tiny dependency-free invalidation bus for the in-process Xero organisation
 * caches (#2080 review, CORRECTNESS-F1).
 *
 * `xero-organisation.ts` caches the connected org's name + financial year-end
 * month (and lock dates) for hours. After a disconnect → reconnect to a
 * DIFFERENT Xero org, those caches would otherwise keep serving the OLD org's
 * name — exactly the mistake the setup wizard's "is this the right org?" step
 * exists to catch. The token store must therefore reset them whenever the
 * connected identity changes (connect/reconnect save, disconnect delete).
 *
 * It cannot import `xero-organisation.ts` to do so: that would form a cycle
 * (`xero-token-store` → `xero-organisation` → `xero-mock-endpoint` →
 * `xero-token-store`). This bus breaks the cycle — it imports nothing.
 * `xero-organisation.ts` REGISTERS its reset here at module load;
 * `xero-token-store.ts` CALLS {@link invalidateXeroOrganisationCaches} on a
 * connect/disconnect. If the organisation module was never loaded in a given
 * process, there is no cache to reset and the call is a harmless no-op.
 */

type Invalidator = () => void;

const invalidators = new Set<Invalidator>();

/** Register a cache-reset callback (idempotent). Called by xero-organisation. */
export function registerXeroOrganisationCacheInvalidator(
  invalidate: Invalidator,
): void {
  invalidators.add(invalidate);
}

/** Reset every registered Xero organisation cache. Safe to call any time. */
export function invalidateXeroOrganisationCaches(): void {
  for (const invalidate of invalidators) {
    invalidate();
  }
}
