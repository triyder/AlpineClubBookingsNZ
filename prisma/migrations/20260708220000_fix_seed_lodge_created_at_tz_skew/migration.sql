-- #1627: the 20260708000000 lodge seed wrote "createdAt"/"updatedAt" with
-- CURRENT_TIMESTAMP — database *session* time. On a non-UTC database (the
-- shipped compose files set PGTZ=Pacific/Auckland) that renders local
-- wall-clock into the naive timestamp(3) column, ~12-13 hours AHEAD of the
-- UTC instants Prisma clients write. Any lodge the app creates inside that
-- window then sorts BEFORE the migration-seeded lodge, and
-- getDefaultLodgeId() / default_lodge_id() (earliest active createdAt)
-- silently resolve the WRONG lodge as the club default.
--
-- Two idempotent, single-row repairs on the migration-seeded lodge (the
-- 20260708000000 seed always writes slug 'lodge'; buildUniqueLodgeSlug never
-- reissues it to app-created lodges):
--
-- 1) Clamp a future-skewed seed timestamp back to true UTC now, so lodges
--    created AFTER this migration on a still-skewed install also sort after
--    the seeded lodge. No-op when the value is already sane (UTC databases).
UPDATE "Lodge"
SET "createdAt" = timezone('UTC', now()),
    "updatedAt" = timezone('UTC', now())
WHERE "slug" = 'lodge'
  AND "createdAt" > timezone('UTC', now());

-- 2) Restore the seeded lodge as the earliest row when any other lodge
--    currently sorts at-or-before it (the observed inversion: a second lodge
--    created within the skew window became the default). One second of
--    headroom keeps the ordering strict. No-op on healthy installs and on
--    single-lodge installs.
UPDATE "Lodge"
SET "createdAt" = earliest."minCreated" - interval '1 second'
FROM (
  SELECT MIN("createdAt") AS "minCreated"
  FROM "Lodge"
  WHERE "slug" <> 'lodge'
) AS earliest
WHERE "Lodge"."slug" = 'lodge'
  AND earliest."minCreated" IS NOT NULL
  AND earliest."minCreated" <= "Lodge"."createdAt";

-- "updatedAt" carries the same skew but nothing orders or branches on it;
-- it is clamped opportunistically in step 1 only. Deliberately NOT touched:
-- lodges without slug 'lodge' (app-created rows carry true UTC values), and
-- installs where the seeded lodge was deleted (no row matches — no-op).