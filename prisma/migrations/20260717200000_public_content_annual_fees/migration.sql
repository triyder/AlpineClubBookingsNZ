-- Public {{annual-fees}} embed visibility gate (#1933, E7).
--
-- Adds a dedicated double-opt-in visibility flag for the new {{annual-fees}}
-- public-page embed. Annual membership fees are more sensitive than the
-- entrance/joining headline (D-R4), so the embed gets its own boolean rather
-- than reusing the existing entranceFees gate. Default false preserves the
-- historical behaviour: nothing new is exposed on the public website until an
-- operator explicitly opts in.
--
-- Expand-safe: an additive nullable-with-default boolean is a PostgreSQL 11+
-- catalog-only change (no table rewrite, brief ACCESS EXCLUSIVE lock) on the
-- cold singleton PublicContentSettings table (one row, id = 'default'). Old
-- colour compatible: the previously deployed Prisma client has no annualFees
-- field and never reads or writes it; the column defaults false so the embed
-- renders its empty state until the new colour's admin toggle is switched on.
ALTER TABLE "PublicContentSettings"
  ADD COLUMN "annualFees" BOOLEAN NOT NULL DEFAULT false;

-- Back-compat backfill F2 (#1933, E7 review, Finding 2). The E7 client re-gates
-- the {{membership-types}} embed (now a deprecated alias of {{annual-fees}})
-- behind this new annualFees flag and drops the legacy membershipTypes admin
-- toggle. Without a backfill an install that had membershipTypes = true would
-- render an EMPTY embed after cutover with no way to re-enable it. Seed the new
-- gate from the legacy one so a previously-visible embed stays visible with no
-- admin action. The orphaned legacy membershipTypes column is RETAINED (no
-- destructive drop). Cold singleton table (one row, id = 'default'); no session
-- clock, no provider call.
UPDATE "PublicContentSettings" SET "annualFees" = "membershipTypes";

-- Back-compat backfill F1 (#1933, E7 review, Finding 1). E6's
-- loadPublicEntranceFees rendered the built-in FULL and FAMILY joining fees
-- unconditionally (it queried key IN ('FULL','FAMILY') with NO publiclyListed
-- filter). E7's loadPublicJoiningFees adds the privacy-correct
-- publiclyListed = true filter, which defaults false and is never otherwise
-- backfilled, so on a standard install the historically-public
-- {{entrance-fees}}/{{joining-fees}} headline would now render EMPTY. The
-- publiclyListed column is read as a query filter ONLY by the entranceFees /
-- annualFees / hutFees gated public embeds (verified: no ungated public surface
-- filters on it; admin surfaces list every type regardless), so marking just the
-- two core built-in types publicly listed restores the old output while the new
-- filter still hides genuinely non-public types. Guarded on = false so it is a
-- no-op for operators who already opted these types in. Cold config table; not
-- in HOT_TABLE_SQL_REGEX; no session clock, no provider call.
UPDATE "MembershipType" SET "publiclyListed" = true
  WHERE "key" IN ('FULL', 'FAMILY') AND "publiclyListed" = false;
