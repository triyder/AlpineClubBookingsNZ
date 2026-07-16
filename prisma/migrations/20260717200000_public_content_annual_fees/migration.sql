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
