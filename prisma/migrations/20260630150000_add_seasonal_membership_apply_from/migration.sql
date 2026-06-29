-- Track the date a seasonal membership type applies from. This is date-only
-- policy metadata for mid-season membership status changes.
ALTER TABLE "SeasonalMembershipAssignment"
  ADD COLUMN IF NOT EXISTS "applyFrom" DATE;
