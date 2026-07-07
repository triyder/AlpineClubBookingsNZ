-- AgeTier gains NOT_APPLICABLE for organisation/school members (#1440).
-- Postgres refuses to USE a newly added enum value inside the same
-- transaction that adds it, so the data backfill lives in the next
-- migration (20260707000100_backfill_org_age_tier_not_applicable).
ALTER TYPE "AgeTier" ADD VALUE 'NOT_APPLICABLE';
