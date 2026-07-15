-- #1886 (F21): durable belt-and-braces for the "at most one entrance-fee
-- invoice per member" invariant. The primary concurrency guard is the
-- member-scoped Xero mint idempotency key (concurrent mints converge on one
-- invoice) plus the worker-side link/adopt re-checks; this partial unique index
-- is the last line of defence, guaranteeing at the DB level that a member can
-- never carry two ACTIVE ENTRANCE_FEE_INVOICE links even if a code path tried
-- to activate a second, different invoice.
--
-- Prisma cannot express partial indexes and db:check-drift does not surface
-- them, so it is also recorded in prisma/partial-unique-indexes.tsv (enforced by
-- scripts/check-partial-indexes.sh in the migration-drift job). Same raw-partial
-- pattern as XeroSyncOperation_active_correlationKey_unique.
--
-- The existing composite unique (localModel, localId, xeroObjectType,
-- xeroObjectId, role) still permits multiple ACTIVE rows with DIFFERENT
-- xeroObjectId; this index closes exactly that gap for the entrance-fee role.
-- Deactivated (active = false) links are excluded, so a future void-and-reissue
-- flow that first deactivates the old link is unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS "XeroObjectLink_entrance_fee_active_unique"
ON "XeroObjectLink" ("localModel", "localId")
WHERE "active" = true AND "role" = 'ENTRANCE_FEE_INVOICE';
