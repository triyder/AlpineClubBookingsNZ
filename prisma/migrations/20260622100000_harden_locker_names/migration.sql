-- Enforce unique locker names so member-facing allocations cannot become
-- indistinguishable in admin and dashboard views.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Locker"
    GROUP BY "name"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot add Locker.name uniqueness while duplicate locker names exist.';
  END IF;
END $$;

DROP INDEX IF EXISTS "Locker_name_idx";

ALTER TABLE "Locker"
ALTER COLUMN "name" TYPE VARCHAR(200);

CREATE UNIQUE INDEX "Locker_name_key" ON "Locker"("name");
