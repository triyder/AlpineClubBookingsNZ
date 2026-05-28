ALTER TABLE "AgeTierSetting"
ADD COLUMN IF NOT EXISTS "familyGroupRequestCreateMemberAllowed" BOOLEAN NOT NULL DEFAULT false;

UPDATE "AgeTierSetting"
SET "familyGroupRequestCreateMemberAllowed" = CASE
  WHEN "tier" IN ('INFANT', 'CHILD') THEN true
  ELSE false
END;
